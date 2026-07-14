/** The "exact" scheme on EVM: a gasless EIP-3009 transferWithAuthorization signature. */

import { getAddress, toHex, type LocalAccount } from "viem";
import { lookupAsset, priceUsdMicro, type PinnedAsset } from "../assets.js";
import type { Eip3009Authorization, PaymentPayload, PaymentRequired, PaymentRequirements, Quote } from "../types.js";

export const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** CAIP-2 "eip155:8453" -> 8453 */
export function evmChainId(network: string): number {
  const m = /^eip155:(\d+)$/.exec(network);
  if (!m) throw new Error(`not an EVM CAIP-2 network: ${network}`);
  return Number(m[1]);
}

/**
 * Turn the server's `accepts[]` into quotes we can actually price.
 * Anything referencing an asset outside the pinned registry is dropped: if we don't
 * know an asset's decimals we cannot know what `amount` costs, and signing a number
 * you can't price is how you lose money.
 */
export function quoteFrom(paymentRequired: PaymentRequired): { quotes: Quote[]; rejected: string[] } {
  const quotes: Quote[] = [];
  const rejected: string[] = [];

  for (const r of paymentRequired.accepts ?? []) {
    if (r.scheme !== "exact") {
      rejected.push(`${r.scheme}/${r.network}: unsupported scheme`);
      continue;
    }
    const asset = lookupAsset(r.network, r.asset);
    if (!asset) {
      rejected.push(`${r.network} ${r.asset}: unknown asset, cannot price`);
      continue;
    }
    let price: bigint;
    try {
      price = priceUsdMicro(asset, r.amount);
    } catch {
      rejected.push(`${r.network} ${r.asset}: malformed amount "${r.amount}"`);
      continue;
    }
    quotes.push({ requirements: r, priceUsdMicro: price, assetSymbol: asset.symbol });
  }
  return { quotes, rejected };
}

export interface SignOptions {
  /** Clamp on the server's maxTimeoutSeconds. Bounds validBefore. */
  maxAuthorizationLifetimeSeconds: number;
  now?: () => number;
  randomBytes?: (n: number) => Uint8Array;
}

/**
 * Sign an EIP-3009 authorization.
 *
 * Two deliberate departures from the reference client:
 *
 *  1. The EIP-712 domain comes from our pinned registry, never from
 *     `requirements.extra`. The server does not get to choose the domain our key
 *     signs over.
 *  2. `validBefore` is clamped to `maxAuthorizationLifetimeSeconds`. The reference
 *     client uses the server's `maxTimeoutSeconds` unbounded, which lets a server
 *     hold a valid signed authorization and settle it long after you walked away.
 */
export async function signExactEvm(
  account: LocalAccount,
  quote: Quote,
  opts: SignOptions,
): Promise<PaymentPayload> {
  const r: PaymentRequirements = quote.requirements;
  const asset = lookupAsset(r.network, r.asset);
  if (!asset) throw new Error(`refusing to sign for unpinned asset ${r.asset} on ${r.network}`);

  const now = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const rand = opts.randomBytes ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));

  const lifetime = Math.min(
    Math.max(1, r.maxTimeoutSeconds || 0),
    opts.maxAuthorizationLifetimeSeconds,
  );

  const authorization: Eip3009Authorization = {
    from: account.address,
    to: getAddress(r.payTo),
    value: r.amount,
    // Backdated for clock skew between us and the settling facilitator.
    validAfter: (now - 600).toString(),
    validBefore: (now + lifetime).toString(),
    nonce: toHex(rand(32)),
  };

  const signature = await account.signTypedData({
    domain: domainFor(asset),
    types: AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(authorization.from),
      to: getAddress(authorization.to),
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });

  return {
    x402Version: 2,
    accepted: r,
    payload: { signature, authorization },
  };
}

export function domainFor(asset: PinnedAsset) {
  return {
    name: asset.eip712.name,
    version: asset.eip712.version,
    chainId: evmChainId(asset.network),
    verifyingContract: getAddress(asset.address),
  } as const;
}
