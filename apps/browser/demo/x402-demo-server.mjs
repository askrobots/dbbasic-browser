/**
 * A gallery of local x402-gated pages — a demo AND a test rig.
 *
 * Each route returns a real x402 v2 402 (machine-readable PAYMENT-REQUIRED header +
 * a human-readable card body) and is designed to exercise a DIFFERENT decision in the
 * payer:
 *
 *   /room     $0.05   auto-pays        (under the auto-approve threshold)
 *   /article  $0.001  auto-pays        (micro-payment)
 *   /premium  $0.50   prompts          (over the threshold → approval dialog)
 *   /unknown  —       refuses          (asset not in the pinned registry → unpriceable)
 *
 * So clicking through the gallery in dbbasic-browser is a live functional test of the
 * engine: you should see three of them pay/prompt and one get refused, with the spend
 * meter moving only for the ones that actually settle. A normal browser just renders
 * the card bodies. Settlement is mocked (there is no chain here).
 *
 * Run:  node apps/browser/demo/x402-demo-server.mjs   → http://127.0.0.1:8899/
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DEMO_PORT) || 8899;
const HOST = process.env.DEMO_HOST || "0.0.0.0"; // reachable via LAN IP; mock content only

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const read = (f) => readFileSync(join(__dirname, f), "utf8");

const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const qrDataUri = "data:image/png;base64," + readFileSync(join(__dirname, "qr.png")).toString("base64");

/** Build a v2 PaymentRequired challenge for a route. */
function challenge({ path, error, amount, asset = USDC_SEPOLIA }) {
  return {
    x402Version: 2,
    error,
    resource: { url: `http://127.0.0.1:${PORT}${path}`, mimeType: "text/html" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        amount,
        asset,
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
      },
    ],
  };
}

// ---- shared HTML shells ----------------------------------------------------

const shell = (title, body, bg = "#eceae4") => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>
*{box-sizing:border-box}html,body{margin:0;background:${bg};font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#1a1a1e}
a{color:inherit}.wrap{min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px}
.card{width:100%;max-width:520px;background:#fff;border-radius:22px;padding:34px;box-shadow:0 30px 80px rgba(0,0,0,.12)}
.price{text-align:center;font-size:60px;font-weight:800;letter-spacing:-.03em;margin:14px 0 2px}
.sub{text-align:center;color:#6a6a72;margin-bottom:22px}
.rail{display:flex;align-items:center;gap:10px;padding:15px;border:1px solid #e6e4df;border-radius:13px;font-weight:600;margin-top:10px}
.dot{width:10px;height:10px;border-radius:50%}
.tag{display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;margin-bottom:14px}
.foot{text-align:center;color:#9a9aa0;font-size:13px;margin-top:18px}
</style></head><body>${body}</body></html>`;

/** Generic human-facing 402 card for the non-flagship examples. */
function genericCard({ title, priceLabel, blurb, tagText, tagColor }) {
  return shell(
    `${title} — payment required`,
    `<div class="wrap"><div class="card">
      <span class="tag" style="background:${tagColor}22;color:${tagColor}">${tagText}</span>
      <h1 style="margin:0 0 4px;font-size:24px;letter-spacing:-.01em">${title}</h1>
      <p style="margin:0;color:#6a6a72">${blurb}</p>
      <div class="price">${priceLabel}</div>
      <div class="sub">one-time · settles in USDC on Base · nothing recurring</div>
      <div class="rail"><span class="dot" style="background:#000"></span>&#63743; Pay</div>
      <div class="rail"><span class="dot" style="background:#f6851b"></span>MetaMask</div>
      <div class="rail"><span class="dot" style="background:#1652f0"></span>Coinbase Wallet</div>
      <p class="foot">You're seeing this because your browser can't pay. In dbbasic-browser
        this screen never appears — it reads the price and pays. Prototype; nothing is charged.</p>
    </div></div>`,
  );
}

const paidPage = (title, note) =>
  shell(
    title,
    `<div class="wrap"><div class="card" style="background:#0d1117;color:#e8e8ea;border:1px solid #21262d">
      <span class="tag" style="background:#10240f;color:#7ee787">&#10003; paid · you're through</span>
      <h1 style="margin:0 0 8px;font-size:26px">${title}</h1>
      <p style="color:#b8b8c0">${note}</p>
      <p class="foot" style="color:#6a6a72">Demo: real x402 v2 on the wire, mock settlement.</p>
    </div></div>`,
    "#0d1117",
  );

// ---- routes ----------------------------------------------------------------

const JORDAN_CARD = read("checkout-card.html").replace("{{QR}}", qrDataUri);
const JORDAN_ROOM = read("room.html");

const ROUTES = {
  "/room": {
    challenge: () => challenge({ path: "/room", error: "Room access costs $0.05.", amount: "50000" }),
    card: JORDAN_CARD,
    paid: JORDAN_ROOM,
  },
  "/article": {
    challenge: () => challenge({ path: "/article", error: "This article costs $0.001.", amount: "1000" }),
    card: genericCard({
      title: "The forgotten status code",
      priceLabel: "$0.001",
      blurb: "A 2,000-word essay on HTTP 402. Pay a tenth of a cent to read it.",
      tagText: "auto-pays",
      tagColor: "#1c7a3a",
    }),
    paid: paidPage("The forgotten status code", "The full essay would render here. It cost you a tenth of a cent, paid transparently."),
  },
  "/premium": {
    challenge: () => challenge({ path: "/premium", error: "This report costs $0.50.", amount: "500000" }),
    card: genericCard({
      title: "Q3 Market Report (premium)",
      priceLabel: "$0.50",
      blurb: "Above the auto-approve threshold — dbbasic-browser will ask you first.",
      tagText: "prompts for approval",
      tagColor: "#b0902f",
    }),
    paid: paidPage("Q3 Market Report", "The report would render here. Because it was over the auto-approve threshold, the browser asked before paying."),
  },
  "/unknown": {
    challenge: () =>
      challenge({
        path: "/unknown",
        error: "Pay 5 SCAM tokens to continue.",
        amount: "5000000",
        asset: "0x1111111111111111111111111111111111111111", // not in the pinned registry
      }),
    card: genericCard({
      title: "Pay in an unknown token",
      priceLabel: "5 ???",
      blurb: "The asset isn't in the pinned registry, so its value is unknowable.",
      tagText: "refused by the browser",
      tagColor: "#b03a2f",
    }),
    // No `paid` — the browser should never send a signature for an unpriceable asset,
    // so this content is unreachable through dbbasic-browser. That IS the test.
    paid: paidPage("You shouldn't see this in dbbasic-browser", "If you're reading this in dbbasic-browser, the refuse-unpriceable-assets guard failed."),
  },
};

const INDEX = shell(
  "x402 example gallery",
  `<div class="wrap"><div class="card" style="max-width:600px">
    <h1 style="margin:0 0 4px;font-size:26px;letter-spacing:-.01em">x402 example gallery</h1>
    <p style="margin:0 0 20px;color:#6a6a72">Four x402-gated pages, each exercising a different
      payer decision. Open them in dbbasic-browser: three should pay/prompt, one should be refused.</p>
    ${[
      ["/room", "Room w/ Jordan", "$0.05", "auto-pays", "#1c7a3a"],
      ["/article", "Paywalled article", "$0.001", "auto-pays", "#1c7a3a"],
      ["/premium", "Premium report", "$0.50", "prompts", "#b0902f"],
      ["/unknown", "Unknown token", "5 ???", "refused", "#b03a2f"],
    ]
      .map(
        ([href, name, price, tag, color]) =>
          `<a href="${href}" style="display:flex;align-items:center;gap:12px;text-decoration:none;padding:15px;border:1px solid #e6e4df;border-radius:13px;margin-bottom:10px">
            <b style="flex:1">${name}</b>
            <span style="font-variant-numeric:tabular-nums;color:#6a6a72">${price}</span>
            <span class="tag" style="margin:0;background:${color}22;color:${color}">${tag}</span>
          </a>`,
      )
      .join("")}
    <p class="foot">Same server, same protocol. A normal browser renders each card; dbbasic-browser
      acts on the header. Mock settlement — nothing is charged.</p>
  </div></div>`,
);

// ---- server ----------------------------------------------------------------

createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];

  if (path === "/" ) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(INDEX);
    return;
  }

  const route = ROUTES[path];
  if (!route) {
    res.writeHead(404, { "content-type": "text/html" });
    res.end(shell("Not found", `<div class="wrap"><div class="card"><h1>404</h1><p><a href="/">← gallery</a></p></div></div>`));
    return;
  }

  const sig = req.headers["payment-signature"] || req.headers["x-payment"];
  if (!sig) {
    res.writeHead(402, { "PAYMENT-REQUIRED": b64(route.challenge()), "content-type": "text/html" });
    res.end(route.card);
    return;
  }
  // Mock settlement: accept the signed authorization, return the content + a receipt.
  res.writeHead(200, {
    "PAYMENT-RESPONSE": b64({
      success: true,
      transaction: "0xDEMO0000000000000000000000000000000000000000000000000000000000",
      network: "eip155:84532",
    }),
    "content-type": "text/html",
  });
  res.end(route.paid);
}).listen(PORT, HOST, () => {
  console.log(`x402 example gallery on http://127.0.0.1:${PORT}/ (bound ${HOST}) — mock settlement`);
});
