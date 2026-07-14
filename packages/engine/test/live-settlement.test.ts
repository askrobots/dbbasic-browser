import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { signExactEvm } from "../src/schemes/exact-evm.js";
import type { PaymentRequirements, Quote } from "../src/types.js";

/**
 * LIVE proof that our engine's signature settles through the real x402 facilitator on
 * Base Sepolia — signs a tiny buyer→merchant payment and confirms real USDC moves.
 *
 * Gated behind RUN_LIVE_SETTLE=1 (and a funded .env), so it NEVER runs in normal test
 * runs / CI. It moves 0.001 real testnet USDC per run. To run:
 *   RUN_LIVE_SETTLE=1 npx vitest run live-settlement   (from packages/engine)
 */
const LIVE = process.env.RUN_LIVE_SETTLE === "1";
const FACILITATOR = process.env.X402_FACILITATOR || "https://x402.org/facilitator";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BAL_ABI = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }] as const;

function env(): Record<string, string> {
  const path = fileURLToPath(new URL("../../../.env", import.meta.url)); // repo-root .env
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

describe.runIf(LIVE)("live facilitator settlement (Base Sepolia)", () => {
  it("signs buyer→merchant and settles on-chain, moving real USDC", async () => {
    const e = env();
    const buyer = privateKeyToAccount(e.X402_PRIVATE_KEY as `0x${string}`);
    const merchant = e.X402_MERCHANT_ADDRESS as `0x${string}`;
    const client = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
    const bal = (a: string) => client.readContract({ address: USDC, abi: BAL_ABI, functionName: "balanceOf", args: [a as `0x${string}`] });

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: "eip155:84532",
      amount: "1000", // $0.001
      asset: USDC,
      payTo: merchant,
      maxTimeoutSeconds: 120,
      extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
    };
    const quote: Quote = { requirements, priceUsdMicro: 1000n, assetSymbol: "USDC" };

    const payload = await signExactEvm(buyer, quote, { maxAuthorizationLifetimeSeconds: 120 });
    const body = JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements });

    // 1. verify (no money moves)
    const verify = await (await fetch(`${FACILITATOR}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body })).json();
    expect(verify.isValid).toBe(true);

    const buyerBefore = await bal(buyer.address);
    const merchBefore = await bal(merchant);

    // 2. settle (real transfer; the facilitator pays gas)
    const settle = await (await fetch(`${FACILITATOR}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body })).json();
    expect(settle.success).toBe(true);
    expect(settle.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/);
    console.log("settled: https://sepolia.basescan.org/tx/" + settle.transaction);

    // 3. balances moved by exactly 0.001 USDC (1000 atomic)
    let buyerAfter = buyerBefore, merchAfter = merchBefore;
    for (let i = 0; i < 15 && merchAfter <= merchBefore; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      buyerAfter = await bal(buyer.address);
      merchAfter = await bal(merchant);
    }
    expect(buyerBefore - buyerAfter).toBe(1000n);
    expect(merchAfter - merchBefore).toBe(1000n);
  }, 60000);
});
