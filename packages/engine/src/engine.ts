/**
 * The pay-and-retry orchestrator.
 *
 * Deliberately depends on nothing but `fetch`. The Electron `protocol.handle()` hook
 * and the local proxy are both thin adapters over this, which means the payment path
 * a user's browser takes is byte-for-byte the one the agent runtime takes, and both
 * are testable headlessly with no browser at all.
 */

import type { LocalAccount } from "viem";
import { formatUsd } from "./assets.js";
import { Ledger, type Receipt } from "./ledger.js";
import { PolicyEngine, type PolicyContext, type Verdict } from "./policy.js";
import { quoteFrom, signExactEvm } from "./schemes/exact-evm.js";
import type { Quote } from "./types.js";
import { encodePaymentSignature, parsePaymentRequired, parseSettlement } from "./wire.js";

export interface PromptRequest {
  quote: Quote;
  ctx: PolicyContext;
  resourceUrl: string;
  reason: string;
}

/** Ask the human. Return true to pay once. The browser wires this to the URL-bar prompt. */
export type Approver = (req: PromptRequest) => Promise<boolean>;

export interface EngineOptions {
  account: LocalAccount;
  policy?: PolicyEngine;
  ledger?: Ledger;
  approve?: Approver;
  fetchImpl?: typeof fetch;
  onEvent?: (e: EngineEvent) => void;
}

export type EngineEvent =
  | { type: "quoted"; resourceUrl: string; quotes: Quote[]; rejected: string[] }
  | { type: "decided"; resourceUrl: string; verdict: Verdict; quote: Quote }
  | { type: "paid"; receipt: Receipt }
  | { type: "skipped"; resourceUrl: string; reason: string };

export interface PayResult {
  response: Response;
  receipt?: Receipt;
  /** Set when we saw an x402 challenge but chose not to (or could not) pay it. */
  declined?: string;
}

export class X402Engine {
  readonly policy: PolicyEngine;
  readonly ledger: Ledger;
  private readonly account: LocalAccount;
  private readonly approve: Approver;
  private readonly fetchImpl: typeof fetch;
  private readonly onEvent: (e: EngineEvent) => void;

  constructor(opts: EngineOptions) {
    this.account = opts.account;
    this.policy = opts.policy ?? new PolicyEngine();
    this.ledger = opts.ledger ?? new Ledger();
    this.approve = opts.approve ?? (async () => false);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onEvent = opts.onEvent ?? (() => {});
  }

  /**
   * Issue a request; if it comes back 402 with an x402 challenge, pay and retry once.
   * Never retries more than once — a server that 402s the paid request is either
   * broken or trying to bill twice, and neither deserves a second signature.
   */
  async fetch(request: Request, topOrigin = ""): Promise<PayResult> {
    const first = await this.fetchImpl(request.clone());
    if (first.status !== 402) return { response: first };

    // A 402 body may be a v1 challenge, so we have to read it — but only if it's JSON,
    // and we must not consume a body we might need to hand back to the caller.
    const probe = first.clone();
    let body: unknown;
    if (probe.headers.get("content-type")?.includes("json")) {
      body = await probe.json().catch(() => undefined);
    }

    const challenge = parsePaymentRequired(n => first.headers.get(n), body);
    if (!challenge) return { response: first, declined: "402 without an x402 challenge" };

    const resourceUrl = challenge.resource?.url ?? request.url;
    const destOrigin = new URL(request.url).origin;
    const ctx: PolicyContext = { topOrigin, destOrigin };

    const { quotes, rejected } = quoteFrom(challenge);
    this.onEvent({ type: "quoted", resourceUrl, quotes, rejected });

    if (quotes.length === 0) {
      const why = `no payable option (${rejected.join("; ") || "empty accepts[]"})`;
      this.onEvent({ type: "skipped", resourceUrl, reason: why });
      return { response: first, declined: why };
    }

    // Cheapest wins. The server orders `accepts` in its own interest, not ours.
    const quote = quotes.reduce((a, b) => (b.priceUsdMicro < a.priceUsdMicro ? b : a));

    const verdict = this.policy.evaluate(quote, ctx);
    this.onEvent({ type: "decided", resourceUrl, verdict, quote });

    if (verdict.action === "deny") {
      this.onEvent({ type: "skipped", resourceUrl, reason: verdict.reason });
      return { response: first, declined: verdict.reason };
    }
    if (verdict.action === "prompt") {
      const ok = await this.approve({ quote, ctx, resourceUrl, reason: verdict.reason });
      if (!ok) {
        const why = `declined by user (${verdict.reason})`;
        this.onEvent({ type: "skipped", resourceUrl, reason: why });
        return { response: first, declined: why };
      }
    }

    const payload = await signExactEvm(this.account, quote, {
      maxAuthorizationLifetimeSeconds: this.policy.limits.maxAuthorizationLifetimeSeconds,
    });

    // Record before sending: once the signature leaves us, the money is exposed
    // regardless of what comes back.
    const receipt = this.ledger.open({
      quote,
      topOrigin,
      destOrigin,
      resourceUrl,
      requestedUrl: request.url,
      authorization: payload.payload.authorization,
      signature: payload.payload.signature,
    });
    this.policy.record(quote, ctx);

    const retry = new Request(request.clone(), {
      headers: mergeHeaders(request.headers, encodePaymentSignature(payload)),
    });

    let paid: Response;
    try {
      paid = await this.fetchImpl(retry);
    } catch (e) {
      this.ledger.fail(receipt.id, `retry failed: ${String(e)}`);
      throw e;
    }

    const settlement = parseSettlement(n => paid.headers.get(n));
    this.ledger.settle(receipt.id, settlement, paid.ok);
    this.onEvent({ type: "paid", receipt });

    return { response: paid, receipt };
  }

  /** What the URL bar shows: total spent in the current window. */
  spentLabel(): string {
    return formatUsd(this.policy.spentUsdMicro());
  }
}

function mergeHeaders(base: Headers, extra: Record<string, string>): Headers {
  const h = new Headers(base);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}
