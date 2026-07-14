/** x402 v2 wire types. Mirrors coinbase/x402 specs/x402-specification-v2.md. */

export type Caip2 = string; // e.g. "eip155:8453"

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface PaymentRequirements {
  scheme: string; // "exact"
  network: Caip2;
  amount: string; // atomic units, decimal string
  asset: string; // token contract address (EVM) or mint (SVM)
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource?: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export interface Eip3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}

export interface ExactEvmPayload {
  signature: `0x${string}`;
  authorization: Eip3009Authorization;
}

export interface PaymentPayload {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: ExactEvmPayload;
  extensions?: Record<string, unknown>;
}

export interface SettlementResponse {
  success: boolean;
  transaction?: string;
  network?: Caip2;
  payer?: string;
  amount?: string;
  errorReason?: string;
}

/** A quote is a payment requirement we have validated, priced, and are willing to consider. */
export interface Quote {
  requirements: PaymentRequirements;
  /** Price in micro-USD (6dp), derived from OUR pinned decimals — never the server's. */
  priceUsdMicro: bigint;
  assetSymbol: string;
}
