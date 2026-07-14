/**
 * Receipt ledger.
 *
 * Every signed authorization is recorded BEFORE it goes out, because the moment we
 * hand over a signature the money is potentially gone — whether or not the server
 * ever gives us the resource. Settlement (and delivery) is reconciled afterwards, so
 * a payment that was signed but never settled, or settled but never delivered, stays
 * visible instead of vanishing.
 */

import type { Quote, SettlementResponse } from "./types.js";

export type ReceiptStatus = "signed" | "settled" | "delivered" | "failed";

export interface Receipt {
  id: string;
  at: number;
  topOrigin: string;
  destOrigin: string;
  resourceUrl: string;
  priceUsdMicro: bigint;
  assetSymbol: string;
  network: string;
  payTo: string;
  nonce: string;
  validBefore: number;
  status: ReceiptStatus;
  txHash?: string;
  error?: string;
}

export class Ledger {
  private receipts: Receipt[] = [];
  private seq = 0;

  constructor(private now: () => number = Date.now) {}

  open(args: {
    quote: Quote;
    topOrigin: string;
    destOrigin: string;
    resourceUrl: string;
    nonce: string;
    validBefore: string;
  }): Receipt {
    const r: Receipt = {
      id: `rcpt_${++this.seq}`,
      at: this.now(),
      topOrigin: args.topOrigin,
      destOrigin: args.destOrigin,
      resourceUrl: args.resourceUrl,
      priceUsdMicro: args.quote.priceUsdMicro,
      assetSymbol: args.quote.assetSymbol,
      network: args.quote.requirements.network,
      payTo: args.quote.requirements.payTo,
      nonce: args.nonce,
      validBefore: Number(args.validBefore),
      status: "signed",
    };
    this.receipts.push(r);
    return r;
  }

  settle(id: string, s: SettlementResponse | null, delivered: boolean): void {
    const r = this.receipts.find(x => x.id === id);
    if (!r) return;
    if (s && !s.success) {
      r.status = "failed";
      r.error = s.errorReason ?? "settlement failed";
      return;
    }
    if (s?.transaction) r.txHash = s.transaction;
    r.status = delivered ? "delivered" : s ? "settled" : "signed";
  }

  fail(id: string, error: string): void {
    const r = this.receipts.find(x => x.id === id);
    if (r) {
      r.status = "failed";
      r.error = error;
    }
  }

  all(): readonly Receipt[] {
    return this.receipts;
  }

  /** Signed but never confirmed settled or delivered, and still settleable. Money at risk. */
  outstanding(): Receipt[] {
    const nowSec = Math.floor(this.now() / 1000);
    return this.receipts.filter(r => r.status === "signed" && r.validBefore > nowSec);
  }

  totalUsdMicro(): bigint {
    return this.receipts
      .filter(r => r.status !== "failed")
      .reduce((a, r) => a + r.priceUsdMicro, 0n);
  }
}
