import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";

import { X402Engine } from "../src/engine.js";
import { PolicyEngine, DEFAULT_LIMITS } from "../src/policy.js";
import { AUTHORIZATION_TYPES, domainFor } from "../src/schemes/exact-evm.js";
import { lookupAsset } from "../src/assets.js";
import type { PaymentPayload, PaymentRequired } from "../src/types.js";

const NETWORK = "eip155:84532"; // Base Sepolia
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = <T>(s: string): T => JSON.parse(Buffer.from(s, "base64").toString()) as T;

/** Mock resource server. `challenge` lets each test hand back a hostile 402. */
interface MockOpts {
  challenge?: Partial<PaymentRequired>;
  amount?: string;
  asset?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

let server: Server;
let base: string;
let opts: MockOpts = {};
/** Every PAYMENT-SIGNATURE the server received. */
let received: PaymentPayload[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const sig = req.headers["payment-signature"] as string | undefined;

    if (!sig) {
      const challenge: PaymentRequired = {
        x402Version: 2,
        error: "payment required",
        resource: { url: `${base}${req.url}`, mimeType: "text/plain" },
        accepts: [
          {
            scheme: "exact",
            network: NETWORK,
            amount: opts.amount ?? "10000", // 0.01 USDC
            asset: opts.asset ?? USDC,
            payTo: PAY_TO,
            maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 60,
            extra: opts.extra ?? { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
          },
        ],
        ...opts.challenge,
      };
      res.writeHead(402, {
        "PAYMENT-REQUIRED": b64(challenge),
        "content-type": "text/plain",
      });
      res.end("payment required");
      return;
    }

    received.push(unb64<PaymentPayload>(sig));
    res.writeHead(200, {
      "PAYMENT-RESPONSE": b64({
        success: true,
        transaction: "0xdeadbeef",
        network: NETWORK,
        payer: account.address,
      }),
      "content-type": "text/plain",
    });
    res.end("the paid content");
  });

  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

function freshEngine(limits = DEFAULT_LIMITS) {
  received = [];
  opts = {};
  return new X402Engine({
    account,
    policy: new PolicyEngine(limits),
    approve: async () => false, // deny anything needing a prompt unless a test overrides
  });
}

describe("pay-and-retry", () => {
  it("pays a 402 and returns the paid content, with a signature that actually verifies", async () => {
    const engine = freshEngine();
    const { response, receipt } = await engine.fetch(
      new Request(`${base}/article`),
      "https://reader.example",
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("the paid content");
    expect(received).toHaveLength(1);

    const payload = received[0]!;
    const asset = lookupAsset(NETWORK, USDC)!;
    const a = payload.payload.authorization;

    // The signature the server got must verify against the PINNED domain.
    const valid = await verifyTypedData({
      address: account.address,
      domain: domainFor(asset),
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: a.from as `0x${string}`,
        to: a.to as `0x${string}`,
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce,
      },
      signature: payload.payload.signature,
    });
    expect(valid).toBe(true);

    expect(receipt!.status).toBe("delivered");
    expect(receipt!.txHash).toBe("0xdeadbeef");
    expect(receipt!.priceUsdMicro).toBe(10_000n); // $0.01
    expect(engine.spentLabel()).toBe("$0.01");
  });

  it("records the payment before it is sent, so a signature is never off-ledger", async () => {
    const engine = freshEngine();
    await engine.fetch(new Request(`${base}/a`), "https://reader.example");
    expect(engine.ledger.all()).toHaveLength(1);
    expect(engine.ledger.totalUsdMicro()).toBe(10_000n);
  });
});

describe("hostile resource server", () => {
  it("clamps a server that asks for a year-long authorization window", async () => {
    const engine = freshEngine();
    opts.maxTimeoutSeconds = 31_536_000; // one year

    await engine.fetch(new Request(`${base}/greedy`), "https://reader.example");

    const a = received[0]!.payload.authorization;
    const lifetime = Number(a.validBefore) - Math.floor(Date.now() / 1000);
    // Must be bounded by our clamp (120s), not the server's year.
    expect(lifetime).toBeLessThanOrEqual(DEFAULT_LIMITS.maxAuthorizationLifetimeSeconds);
    expect(lifetime).toBeGreaterThan(0);
  });

  it("ignores the server's EIP-712 domain and signs over the pinned one", async () => {
    const engine = freshEngine();
    // Server lies about the domain, hoping we sign something other than what we think.
    opts.extra = { assetTransferMethod: "eip3009", name: "Totally Not USDC", version: "99" };

    await engine.fetch(new Request(`${base}/liar`), "https://reader.example");

    const asset = lookupAsset(NETWORK, USDC)!;
    const a = received[0]!.payload.authorization;
    const valid = await verifyTypedData({
      address: account.address,
      domain: domainFor(asset), // the PINNED domain
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: a.from as `0x${string}`,
        to: a.to as `0x${string}`,
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce,
      },
      signature: received[0]!.payload.signature,
    });
    expect(valid).toBe(true);
  });

  it("refuses to pay in an asset it cannot price", async () => {
    const engine = freshEngine();
    opts.asset = "0x1111111111111111111111111111111111111111"; // scam token

    const { response, receipt, declined } = await engine.fetch(
      new Request(`${base}/scam`),
      "https://reader.example",
    );

    expect(response.status).toBe(402); // we hand back the original 402
    expect(receipt).toBeUndefined();
    expect(received).toHaveLength(0); // nothing was ever signed
    expect(declined).toContain("unknown asset");
  });

  it("survives a drain attempt: 1000 tiny 402s hit the rate cap", async () => {
    const engine = freshEngine({ ...DEFAULT_LIMITS, maxPaymentsPerPairPerWindow: 25 });
    opts.amount = "1"; // 0.000001 USDC — trivially under any amount threshold

    let paid = 0;
    let blocked = 0;
    for (let i = 0; i < 1000; i++) {
      const r = await engine.fetch(new Request(`${base}/drain/${i}`), "https://hostile.example");
      if (r.receipt) paid++;
      else blocked++;
    }

    // An amount-only budget would have let all 1000 through (1000 * $0.000001 = $0.001).
    expect(paid).toBe(25);
    expect(blocked).toBe(975);
  });
});

describe("policy", () => {
  it("prompts above the auto-approve threshold instead of silently paying", async () => {
    const prompts: string[] = [];
    received = [];
    opts = { amount: "1000000" }; // $1.00, well over the $0.05 auto threshold

    const engine = new X402Engine({
      account,
      policy: new PolicyEngine(DEFAULT_LIMITS),
      approve: async req => {
        prompts.push(req.reason);
        return true;
      },
    });

    const { receipt } = await engine.fetch(new Request(`${base}/pricey`), "https://reader.example");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("$1.00");
    expect(receipt!.priceUsdMicro).toBe(1_000_000n);
  });

  it("does not sign when the user declines the prompt", async () => {
    const engine = freshEngine(); // approve => false
    opts.amount = "1000000";

    const { receipt, declined } = await engine.fetch(
      new Request(`${base}/pricey`),
      "https://reader.example",
    );
    expect(receipt).toBeUndefined();
    expect(received).toHaveLength(0);
    expect(declined).toContain("declined by user");
  });
});
