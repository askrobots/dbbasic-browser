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
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

// Load the repo .env so the /live route can settle to OUR merchant wallet.
try {
  for (const line of readFileSync(join(__dirname, "../../../.env"), "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  /* no .env — /live will fall back to the example payTo and settlement will no-op */
}
const MERCHANT = process.env.X402_MERCHANT_ADDRESS || PAY_TO;
const FACILITATOR = process.env.X402_FACILITATOR || "https://x402.org/facilitator";
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

// A persistent nav so you can click through the gallery and watch each navigation
// trigger a different payer decision (pay / prompt / refuse / free) in the inspector.
const NAV = `<nav class="nav">
  <a href="/">gallery</a>
  <a href="/live">live · REAL</a>
  <a href="/room">room · $0.05</a>
  <a href="/article">article · $0.001</a>
  <a href="/tip">tip</a>
  <a href="/api/price">api</a>
  <a href="/multi">multi</a>
  <a href="/premium">premium · $0.50</a>
  <a href="/unknown">unknown · ✕</a>
  <a href="/free">free</a>
</nav>`;

const shell = (title, body, bg = "#eceae4") => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>
*{box-sizing:border-box}html,body{margin:0;background:${bg};font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#1a1a1e}
a{color:inherit}.wrap{min-height:calc(100vh - 46px);display:flex;align-items:flex-start;justify-content:center;padding:40px 16px}
.card{width:100%;max-width:520px;background:#fff;border-radius:22px;padding:34px;box-shadow:0 30px 80px rgba(0,0,0,.12)}
.price{text-align:center;font-size:60px;font-weight:800;letter-spacing:-.03em;margin:14px 0 2px}
.sub{text-align:center;color:#6a6a72;margin-bottom:22px}
.rail{display:flex;align-items:center;gap:10px;padding:15px;border:1px solid #e6e4df;border-radius:13px;font-weight:600;margin-top:10px}
.dot{width:10px;height:10px;border-radius:50%}
.tag{display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;margin-bottom:14px}
.foot{text-align:center;color:#9a9aa0;font-size:13px;margin-top:18px}
.nav{display:flex;gap:4px;flex-wrap:wrap;align-items:center;padding:8px 14px;background:rgba(255,255,255,.7);backdrop-filter:blur(8px);border-bottom:1px solid #dedcd6;position:sticky;top:0;font-size:13px}
.nav a{text-decoration:none;color:#4a4a52;padding:5px 10px;border-radius:7px}
.nav a:hover{background:#00000010}
</style></head><body>${NAV}${body}</body></html>`;

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
    <p style="margin:0 0 20px;color:#6a6a72">A set of x402-gated resources, each exercising a different
      payer decision. Open them in dbbasic-browser and watch the toolbar: some pay, one prompts, one is refused, one is free.</p>
    ${[
      ["/live", "Live payment (REAL)", "$0.001", "real on-chain tx", "#b03a2f"],
      ["/room", "Room w/ Jordan", "$0.05", "auto-pays", "#1c7a3a"],
      ["/article", "Paywalled article", "$0.001", "auto-pays", "#1c7a3a"],
      ["/tip", "Tip jar", "you pick", "variable", "#5a5a62"],
      ["/api/price", "Price API (JSON)", "$0.002", "metered · API", "#1c7a3a"],
      ["/multi", "Two ways to pay", "$0.10 / $0.04", "picks cheapest", "#1c7a3a"],
      ["/premium", "Premium report", "$0.50", "prompts", "#b0902f"],
      ["/unknown", "Unknown token", "5 ???", "refused", "#b03a2f"],
      ["/free", "Free page", "—", "no 402", "#5a5a62"],
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

const RECEIPT = b64({ success: true, transaction: "0xDEMO0000000000000000000000000000000000000000000000000000000000", network: "eip155:84532" });

/** Gate any resource: unpaid → 402 (header + card body), paid → the content. */
function gate(req, res, { challenge, card, paid, paidType = "text/html" }) {
  const sig = req.headers["payment-signature"] || req.headers["x-payment"];
  if (!sig) {
    res.writeHead(402, { "PAYMENT-REQUIRED": b64(challenge), "content-type": "text/html" });
    res.end(card);
    return;
  }
  res.writeHead(200, { "PAYMENT-RESPONSE": RECEIPT, "content-type": paidType });
  res.end(paid);
}

createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0];

  // LIVE route: real settlement. Unpaid → 402; paid → POST the signed payload to the
  // facilitator's /settle, which moves real testnet USDC (buyer → our merchant wallet)
  // and returns a real tx. payTo is OUR merchant so funds circulate, not drain.
  if (path === "/live") {
    const requirements = {
      scheme: "exact",
      network: "eip155:84532",
      amount: "1000", // $0.001
      asset: USDC_SEPOLIA,
      payTo: MERCHANT,
      maxTimeoutSeconds: 120,
      extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
    };
    const sig = req.headers["payment-signature"] || req.headers["x-payment"];
    if (!sig) {
      const challenge = { x402Version: 2, error: "Live $0.001 — real on-chain settlement.", resource: { url: `http://127.0.0.1:${PORT}/live`, mimeType: "text/html" }, accepts: [requirements] };
      res.writeHead(402, { "PAYMENT-REQUIRED": b64(challenge), "content-type": "text/html" });
      res.end(genericCard({ title: "Live payment", priceLabel: "$0.001", blurb: "REAL settlement on Base Sepolia — moves testnet USDC to the merchant wallet.", tagText: "live · real tx", tagColor: "#b03a2f" }));
      return;
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.from(sig, "base64").toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad PAYMENT-SIGNATURE");
      return;
    }
    try {
      const sr = await fetch(`${FACILITATOR}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }) });
      const settle = await sr.json();
      console.error("[/live settle]", sr.status, JSON.stringify(settle));
      if (!settle.success) {
        res.writeHead(402, { "PAYMENT-REQUIRED": b64({ x402Version: 2, error: "settlement failed", accepts: [requirements] }), "PAYMENT-RESPONSE": b64(settle), "content-type": "text/html" });
        res.end(genericCard({ title: "Settlement failed", priceLabel: "$0.001", blurb: settle.errorReason || "unknown reason", tagText: "failed", tagColor: "#b03a2f" }));
        return;
      }
      res.writeHead(200, { "PAYMENT-RESPONSE": b64(settle), "content-type": "text/html" });
      res.end(paidPage("Paid for real", `Settled on-chain — tx <code>${(settle.transaction || "").slice(0, 18)}…</code>. This moved $0.001 of real testnet USDC to the merchant wallet. Watch the two balances in the toolbar.`));
    } catch (err) {
      res.writeHead(502, { "content-type": "text/html" });
      res.end(shell("Facilitator error", `<div class="wrap"><div class="card"><h1>Facilitator error</h1><p>${String(err)}</p><p><a href="/">← gallery</a></p></div></div>`));
    }
    return;
  }

  if (path === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(INDEX);
    return;
  }

  if (path === "/free") {
    // A normal 200 — no 402, no payment. Navigate here and the meter doesn't move.
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      shell(
        "Free page",
        `<div class="wrap"><div class="card">
          <span class="tag" style="background:#e9e7e0;color:#6a6a72">free · no 402</span>
          <h1 style="margin:0 0 6px;font-size:24px">This page is free</h1>
          <p style="margin:0;color:#6a6a72">It returns a plain <b>200 OK</b> — no payment required, nothing
            in the inspector, the spend meter stays put. Click a paid page above and watch the difference.</p>
        </div></div>`,
      ),
    );
    return;
  }

  // Tip jar: a chooser page, then a per-amount gated "thank you". Shows variable
  // amounts — the small tip auto-pays, larger ones cross the threshold and prompt.
  if (path === "/tip") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      shell(
        "Tip jar",
        `<div class="wrap"><div class="card">
          <span class="tag" style="background:#e9e7e0;color:#6a6a72">tip · you pick</span>
          <h1 style="margin:0 0 6px;font-size:24px">Leave a tip</h1>
          <p style="margin:0 0 18px;color:#6a6a72">Different amounts trigger different behavior:
            the small one auto-pays, the bigger ones cross the auto-approve threshold and ask first.</p>
          ${[["/tip/2", "$0.02", "auto-pays"], ["/tip/25", "$0.25", "asks first"], ["/tip/100", "$1.00", "asks first"]]
            .map(([h, amt, tag]) => `<a href="${h}" class="rail" style="text-decoration:none"><b style="flex:1">Tip ${amt}</b><span style="color:#6a6a72">${tag}</span></a>`)
            .join("")}
        </div></div>`,
      ),
    );
    return;
  }
  const tipMatch = /^\/tip\/(\d+)$/.exec(path);
  if (tipMatch) {
    const cents = Math.min(100000, parseInt(tipMatch[1], 10) || 0);
    const dollars = (cents / 100).toFixed(2);
    gate(req, res, {
      challenge: challenge({ path, error: `Tip of $${dollars}.`, amount: String(cents * 10000) }),
      card: genericCard({ title: `Tip $${dollars}`, priceLabel: `$${dollars}`, blurb: "A one-time tip in USDC on Base.", tagText: "tip", tagColor: "#1c7a3a" }),
      paid: paidPage(`Thanks for the $${dollars} tip!`, "Your tip settled. No checkout, no account — just a signed authorization and done."),
    });
    return;
  }

  // Multi-accepts: one resource offered several ways. The server lists the expensive
  // option FIRST; a client acting in its own interest ignores that ordering and picks
  // the cheapest. Watch the inspector — it prices every option and pays the cheapest.
  if (path === "/multi") {
    const multi = {
      x402Version: 2,
      error: "Pay any accepted way — cheapest wins.",
      resource: { url: `http://127.0.0.1:${PORT}/multi`, mimeType: "text/html" },
      accepts: [
        { scheme: "exact", network: "eip155:84532", amount: "100000", asset: USDC_SEPOLIA, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" } },
        { scheme: "exact", network: "eip155:8453", amount: "40000", asset: USDC_BASE, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" } },
      ],
    };
    gate(req, res, {
      challenge: multi,
      card: genericCard({ title: "Two ways to pay", priceLabel: "$0.10 / $0.04", blurb: "Offered on two networks. A smart client takes the cheaper one.", tagText: "picks cheapest", tagColor: "#1c7a3a" }),
      paid: paidPage("Paid the cheaper option", "The server listed $0.10 first, but the browser priced both and paid the $0.04 option. The client works for you, not the server's ordering."),
    });
    return;
  }

  // Metered API: x402 for machines. Returns JSON, not a page — the payment path is
  // identical, which is the point (an agent hitting this pays exactly like the browser).
  if (path === "/api/price") {
    gate(req, res, {
      challenge: challenge({ path, error: "This quote costs $0.002 per call.", amount: "2000" }),
      card: genericCard({ title: "Price API", priceLabel: "$0.002", blurb: "A metered JSON endpoint — pays per call.", tagText: "auto-pays · API", tagColor: "#1c7a3a" }),
      paid: JSON.stringify({ pair: "BTC-USD", price: 94213.55, asOf: "2026-07-14T00:00:00Z", note: "you paid $0.002 for this quote via x402" }, null, 2),
      paidType: "application/json",
    });
    return;
  }

  const route = ROUTES[path];
  if (!route) {
    res.writeHead(404, { "content-type": "text/html" });
    res.end(shell("Not found", `<div class="wrap"><div class="card"><h1>404</h1><p><a href="/">← gallery</a></p></div></div>`));
    return;
  }
  gate(req, res, { challenge: route.challenge(), card: route.card, paid: route.paid });
}).listen(PORT, HOST, () => {
  console.log(`x402 example gallery on http://127.0.0.1:${PORT}/ (bound ${HOST}) — mock settlement`);
});
