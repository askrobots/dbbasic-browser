/**
 * The policy engine.
 *
 * x402's whole value is that payment happens at machine speed. A wallet modal per
 * $0.001 request destroys that. But auto-approval is also the entire attack surface:
 * a hostile page can fire ten thousand 402 subresources in a loop, and because
 * EIP-3009 is signature-based, our exposure is exactly what we agree to sign.
 *
 * So the signing policy IS the security boundary. Budgets are scoped by the pair
 * (top-level origin the user is actually looking at) x (origin being paid), because
 * a global cap alone lets one hostile tab spend the whole day's allowance, and a
 * per-destination cap alone lets a hostile page fan out across a thousand domains
 * it controls. We also cap payment *rate*, not just amount: draining $20 in 200
 * separate $0.10 payments is still a drain.
 */

import { formatUsd } from "./assets.js";
import type { Quote } from "./types.js";

export interface PolicyLimits {
  /** Anything at or below this is paid without asking. */
  autoApproveUnderUsdMicro: bigint;
  /** Hard ceiling per (topOrigin, destOrigin) pair per window. */
  perPairPerWindowUsdMicro: bigint;
  /** Hard ceiling across everything per window. Last line of defence. */
  globalPerWindowUsdMicro: bigint;
  windowMs: number;
  /** Max payments per (topOrigin, destOrigin) per window, regardless of size. */
  maxPaymentsPerPairPerWindow: number;
  /** Clamp on server-chosen maxTimeoutSeconds. Bounds how long a signed
   *  authorization stays settleable, so a server can't bank it and settle later. */
  maxAuthorizationLifetimeSeconds: number;
  /** Networks we're willing to sign on. */
  allowedNetworks: string[];
  /** Schemes we implement. */
  allowedSchemes: string[];
}

export const DEFAULT_LIMITS: PolicyLimits = {
  autoApproveUnderUsdMicro: 50_000n, // $0.05
  perPairPerWindowUsdMicro: 5_000_000n, // $5.00
  globalPerWindowUsdMicro: 20_000_000n, // $20.00
  windowMs: 24 * 60 * 60 * 1000,
  maxPaymentsPerPairPerWindow: 500,
  maxAuthorizationLifetimeSeconds: 120,
  allowedNetworks: ["eip155:8453", "eip155:84532"],
  allowedSchemes: ["exact"],
};

export type Verdict =
  | { action: "allow"; reason: string }
  | { action: "prompt"; reason: string }
  | { action: "deny"; reason: string };

interface Counter {
  spentUsdMicro: bigint;
  count: number;
  windowStart: number;
}

export interface PolicyContext {
  /** The page the user is actually looking at. Empty string for agent/CLI traffic. */
  topOrigin: string;
  /** The origin we'd be paying. */
  destOrigin: string;
}

export class PolicyEngine {
  private pairs = new Map<string, Counter>();
  private global: Counter = { spentUsdMicro: 0n, count: 0, windowStart: 0 };
  /** Origins the user has explicitly blessed, with a standing allowance. */
  private grants = new Map<string, bigint>();

  constructor(
    public limits: PolicyLimits = DEFAULT_LIMITS,
    private now: () => number = Date.now,
  ) {}

  private roll(c: Counter): Counter {
    const t = this.now();
    if (t - c.windowStart >= this.limits.windowMs) {
      c.spentUsdMicro = 0n;
      c.count = 0;
      c.windowStart = t;
    }
    return c;
  }

  private pairCounter(ctx: PolicyContext): Counter {
    const k = `${ctx.topOrigin}>${ctx.destOrigin}`;
    let c = this.pairs.get(k);
    if (!c) {
      c = { spentUsdMicro: 0n, count: 0, windowStart: this.now() };
      this.pairs.set(k, c);
    }
    return this.roll(c);
  }

  /** User explicitly authorises an origin up to `usdMicro` for this session. */
  grant(destOrigin: string, usdMicro: bigint): void {
    this.grants.set(destOrigin, (this.grants.get(destOrigin) ?? 0n) + usdMicro);
  }

  evaluate(quote: Quote, ctx: PolicyContext): Verdict {
    const { requirements: r } = quote;
    const L = this.limits;

    if (!L.allowedSchemes.includes(r.scheme)) {
      return { action: "deny", reason: `unsupported scheme "${r.scheme}"` };
    }
    if (!L.allowedNetworks.includes(r.network)) {
      return { action: "deny", reason: `network "${r.network}" not allowed` };
    }
    if (quote.priceUsdMicro <= 0n) {
      return { action: "deny", reason: "non-positive price" };
    }

    const pair = this.pairCounter(ctx);
    const global = this.roll(this.global);

    if (pair.count >= L.maxPaymentsPerPairPerWindow) {
      return {
        action: "deny",
        reason: `payment rate cap hit for ${ctx.destOrigin} (${L.maxPaymentsPerPairPerWindow}/window)`,
      };
    }
    if (global.spentUsdMicro + quote.priceUsdMicro > L.globalPerWindowUsdMicro) {
      return {
        action: "deny",
        reason: `global budget exhausted (${formatUsd(global.spentUsdMicro)} of ${formatUsd(L.globalPerWindowUsdMicro)})`,
      };
    }
    if (pair.spentUsdMicro + quote.priceUsdMicro > L.perPairPerWindowUsdMicro) {
      return {
        action: "prompt",
        reason: `${ctx.destOrigin} would exceed its ${formatUsd(L.perPairPerWindowUsdMicro)} budget`,
      };
    }

    const granted = this.grants.get(ctx.destOrigin) ?? 0n;
    if (granted >= quote.priceUsdMicro) {
      return { action: "allow", reason: `within standing grant for ${ctx.destOrigin}` };
    }
    if (quote.priceUsdMicro <= L.autoApproveUnderUsdMicro) {
      return { action: "allow", reason: `${formatUsd(quote.priceUsdMicro)} under auto-approve threshold` };
    }
    return {
      action: "prompt",
      reason: `${formatUsd(quote.priceUsdMicro)} exceeds auto-approve threshold`,
    };
  }

  /** Call only after a payment is actually signed and sent. */
  record(quote: Quote, ctx: PolicyContext): void {
    const pair = this.pairCounter(ctx);
    const global = this.roll(this.global);
    pair.spentUsdMicro += quote.priceUsdMicro;
    pair.count += 1;
    global.spentUsdMicro += quote.priceUsdMicro;
    global.count += 1;
    const g = this.grants.get(ctx.destOrigin);
    if (g !== undefined) {
      this.grants.set(ctx.destOrigin, g > quote.priceUsdMicro ? g - quote.priceUsdMicro : 0n);
    }
  }

  spentUsdMicro(): bigint {
    return this.roll(this.global).spentUsdMicro;
  }
}
