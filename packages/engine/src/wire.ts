/** HTTP binding for x402. v2 uses headers; v1 put requirements in the body. */

import type { PaymentPayload, PaymentRequired, SettlementResponse } from "./types.js";

const b64encode = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
const b64decode = <T>(s: string): T => JSON.parse(Buffer.from(s, "base64").toString("utf8")) as T;

export type HeaderGetter = (name: string) => string | null | undefined;

/**
 * Parse a 402 into PaymentRequired. Prefers v2's PAYMENT-REQUIRED header,
 * falls back to a v1 JSON body. Returns null if this 402 isn't x402 at all
 * (plenty of servers return a bare 402 that means nothing).
 */
export function parsePaymentRequired(getHeader: HeaderGetter, body?: unknown): PaymentRequired | null {
  const h = getHeader("payment-required");
  if (h) {
    const pr = b64decode<PaymentRequired>(h);
    if (!Array.isArray(pr.accepts)) throw new Error("PAYMENT-REQUIRED missing accepts[]");
    return pr;
  }
  if (body && typeof body === "object" && "x402Version" in body && "accepts" in body) {
    return body as PaymentRequired;
  }
  return null;
}

/** Encode the signed payload into the right header for the negotiated version. */
export function encodePaymentSignature(payload: PaymentPayload): Record<string, string> {
  const encoded = b64encode(payload);
  return payload.x402Version >= 2
    ? { "PAYMENT-SIGNATURE": encoded }
    : { "X-PAYMENT": encoded, "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE" };
}

/** Settlement receipt, if the server sent one. Absence is not an error. */
export function parseSettlement(getHeader: HeaderGetter): SettlementResponse | null {
  const h = getHeader("payment-response") ?? getHeader("x-payment-response");
  if (!h) return null;
  try {
    return b64decode<SettlementResponse>(h);
  } catch {
    return null;
  }
}

export const encodePaymentRequired = b64encode;
export const encodeSettlement = b64encode;
