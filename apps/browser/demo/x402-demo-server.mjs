/**
 * A local x402-gated page, so you can watch the whole payment flow in the browser
 * without a funded wallet or a live facilitator.
 *
 * Behaviour is real x402 v2 on the wire: an unpaid request gets a 402 with a genuine
 * PAYMENT-REQUIRED header; a request carrying a PAYMENT-SIGNATURE gets the content
 * plus a PAYMENT-RESPONSE receipt. The ONLY thing faked is settlement — we accept the
 * signature without checking the chain (there's no chain here). That's exactly enough
 * to exercise the engine, the policy auto-approve, the ledger, and the UI end to end.
 *
 * Run:  node apps/browser/demo/x402-demo-server.mjs   (listens on http://127.0.0.1:8899)
 */

import { createServer } from "node:http";

const PORT = Number(process.env.DEMO_PORT) || 8899;

// $0.01 in USDC on Base Sepolia — under the engine's $0.05 auto-approve threshold,
// and USDC/eip155:84532 is in the pinned asset registry, so the engine can price it.
const CHALLENGE = {
  x402Version: 2,
  error: "This article costs $0.01 to read.",
  resource: { url: `http://127.0.0.1:${PORT}/`, mimeType: "text/html" },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
    },
  ],
};

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

const PAID_PAGE = (sig) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Paid — dbbasic-browser demo</title>
<style>
  body{margin:0;font:16px/1.6 -apple-system,system-ui,sans-serif;background:#0d1117;color:#e8e8ea;
       display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{max-width:640px;padding:48px;background:#161b22;border:1px solid #21262d;border-radius:16px;
        box-shadow:0 20px 60px rgba(0,0,0,.5)}
  h1{margin:0 0 4px;font-size:28px}
  .tag{display:inline-block;background:#10240f;color:#7ee787;border:1px solid #1c4a1a;
       padding:4px 10px;border-radius:999px;font-size:13px;margin-bottom:20px}
  p{color:#b8b8c0}
  code{background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:2px 6px;font-size:13px;color:#7ee787}
  .sig{margin-top:24px;word-break:break-all;font-size:11px;color:#6a6a72}
</style></head>
<body><div class="card">
  <div class="tag">✓ Paid $0.01 USDC</div>
  <h1>You're through the paywall.</h1>
  <p>This page returned <code>402 Payment Required</code>. Your browser read the price,
     signed an EIP-3009 authorization, retried with a <code>PAYMENT-SIGNATURE</code> header,
     and got this content — no button, no popup, no API key. The spend meter in the toolbar
     just ticked up.</p>
  <p>Everything here is real x402 v2 except settlement, which is mocked (there is no chain
     behind this demo, and the wallet is a throwaway test key).</p>
  <div class="sig">authorization signature: ${sig.slice(0, 66)}…</div>
</div></body></html>`;

const PROMPT_NOTE = `<!doctype html><meta charset="utf-8"><body style="font:16px sans-serif;padding:40px">
This endpoint requires payment. If you're not seeing it pay automatically, the price may be above
the auto-approve threshold — approve it in the dialog.</body>`;

createServer((req, res) => {
  const sigHeader = req.headers["payment-signature"] || req.headers["x-payment"];
  if (!sigHeader) {
    res.writeHead(402, { "PAYMENT-REQUIRED": b64(CHALLENGE), "content-type": "text/html" });
    res.end(PROMPT_NOTE);
    return;
  }
  // "Settle" (mock): accept the signature, echo a receipt with a fake tx hash.
  let sig = "0x";
  try {
    const payload = JSON.parse(Buffer.from(sigHeader, "base64").toString("utf8"));
    sig = payload?.payload?.signature ?? "0x";
  } catch {}
  res.writeHead(200, {
    "PAYMENT-RESPONSE": b64({
      success: true,
      transaction: "0xDEMO0000000000000000000000000000000000000000000000000000000000",
      network: "eip155:84532",
    }),
    "content-type": "text/html",
  });
  res.end(PAID_PAGE(sig));
}).listen(PORT, "127.0.0.1", () => {
  console.log(`x402 demo server on http://127.0.0.1:${PORT}/  (mock settlement)`);
});
