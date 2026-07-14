/**
 * Pinned asset registry — the root of trust for pricing and signing.
 *
 * The x402 reference client takes the EIP-712 domain (`name`, `version`) and the
 * asset address straight from the resource server's 402 response, then signs against
 * them. That means the party being paid chooses the domain your wallet signs over,
 * and chooses the token whose decimals determine what `amount` actually costs you.
 *
 * We refuse to do that. An asset is payable only if it appears here, and when we sign
 * we use THIS table's domain and decimals, ignoring whatever `extra` claimed. If a
 * server names an asset we don't know, we cannot price it, so we do not pay it.
 */

export interface PinnedAsset {
  symbol: string;
  address: string; // lowercase
  network: string; // CAIP-2
  decimals: number;
  /** EIP-712 domain, pinned. Not read from the 402 response. */
  eip712: { name: string; version: string };
  /** Micro-USD per whole token. USDC == 1_000_000. */
  usdMicroPerToken: bigint;
}

const ASSETS: PinnedAsset[] = [
  {
    symbol: "USDC",
    address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    network: "eip155:8453", // Base mainnet
    decimals: 6,
    eip712: { name: "USD Coin", version: "2" },
    usdMicroPerToken: 1_000_000n,
  },
  {
    symbol: "USDC",
    address: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    network: "eip155:84532", // Base Sepolia
    decimals: 6,
    eip712: { name: "USDC", version: "2" },
    usdMicroPerToken: 1_000_000n,
  },
];

const key = (network: string, address: string) => `${network}|${address.toLowerCase()}`;

const INDEX = new Map(ASSETS.map(a => [key(a.network, a.address), a]));

export function lookupAsset(network: string, address: string): PinnedAsset | undefined {
  return INDEX.get(key(network, address));
}

/**
 * Convert an atomic-unit amount to micro-USD using OUR pinned decimals.
 * This is the only place a price becomes a dollar figure.
 */
export function priceUsdMicro(asset: PinnedAsset, atomicAmount: string): bigint {
  const amount = BigInt(atomicAmount);
  if (amount < 0n) throw new Error("negative amount");
  return (amount * asset.usdMicroPerToken) / 10n ** BigInt(asset.decimals);
}

export function formatUsd(usdMicro: bigint): string {
  const neg = usdMicro < 0n;
  const v = neg ? -usdMicro : usdMicro;
  const dollars = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "") || "0";
  return `${neg ? "-" : ""}$${dollars}.${frac.padEnd(2, "0")}`;
}
