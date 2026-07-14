/**
 * A local x402-gated "room" — the two-sided demo.
 *
 * An x402 402 response can carry BOTH a machine-readable header and a human-readable
 * body, and that duality is the whole story:
 *
 *   - A normal browser (Safari, Chrome) can't pay, so it renders the BODY: a checkout
 *     card with Apple Pay, MetaMask, a QR to scan — friction.
 *   - dbbasic-browser reads the PAYMENT-REQUIRED header, pays transparently, and gets
 *     the 200 — the room — never seeing the card at all.
 *
 * Same URL, same server. The only thing faked is settlement: we accept the signature
 * without checking a chain (there is none here). Run:
 *   node apps/browser/demo/x402-demo-server.mjs   → http://127.0.0.1:8899/
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DEMO_PORT) || 8899;
// Bind all interfaces by default so the demo is reachable via a LAN IP (127.0.0.1,
// 192.168.x, a phone on the same wifi). It's a mock server serving example content.
const HOST = process.env.DEMO_HOST || "0.0.0.0";

// $0.05 in USDC on Base Sepolia (6dp -> 50000). At/under the engine's auto-approve
// threshold, and USDC/eip155:84532 is in the pinned registry so it can be priced.
const CHALLENGE = {
  x402Version: 2,
  error: "Design Critique w/ Jordan — 30-minute room access costs $0.05.",
  resource: { url: `http://127.0.0.1:${PORT}/`, mimeType: "text/html" },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "50000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
    },
  ],
};

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const read = (f) => readFileSync(join(__dirname, f), "utf8");

// Build the checkout card once, inlining the QR so the served page is self-contained.
const qrDataUri = "data:image/png;base64," + readFileSync(join(__dirname, "qr.png")).toString("base64");
const CARD = read("checkout-card.html").replace("{{QR}}", qrDataUri);
const ROOM = read("room.html");

createServer((req, res) => {
  const sig = req.headers["payment-signature"] || req.headers["x-payment"];
  if (!sig) {
    // Human fallback body + machine header. Browsers that can't pay see the card.
    res.writeHead(402, { "PAYMENT-REQUIRED": b64(CHALLENGE), "content-type": "text/html" });
    res.end(CARD);
    return;
  }
  // Mock settlement: accept the signed authorization, hand back the room + a receipt.
  res.writeHead(200, {
    "PAYMENT-RESPONSE": b64({
      success: true,
      transaction: "0xDEMO0000000000000000000000000000000000000000000000000000000000",
      network: "eip155:84532",
    }),
    "content-type": "text/html",
  });
  res.end(ROOM);
}).listen(PORT, HOST, () => {
  console.log(`x402 demo (room) on http://127.0.0.1:${PORT}/ (bound ${HOST}) — card as 402 body, mock settlement`);
});
