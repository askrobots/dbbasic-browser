// The network layer: redirects reach the page, cookies round-trip, x402 behind a redirect, gzip, headers.
export default async function (ctx) {
  const { call: T, check, base, sleep } = ctx;
  const port = new URL(base).port;
  const loc = async () => (await T("page.eval", { js: "location.href" })).value;
  const tab0 = async () => (await T("tabs.list")).find((t) => t.active);

  // redirect chain (301 → 302 → 200): the page and the tab agree on the FINAL url
  await T("page.goto", { url: base + "/redir/chain" });
  check((await loc()) === base + "/free" && (await tab0()).url === base + "/free", "redirect chain: location.href AND the tab URL are the final URL", await loc());
  check(/free/i.test((await T("page.text")).text), "…and the page shows the destination's content");

  // cross-origin redirect: the page's origin must become the DESTINATION's (the security-critical one)
  await T("page.goto", { url: base + "/redir/cross" });
  const origin = (await T("page.eval", { js: "location.origin" })).value;
  check(origin === `http://localhost:${port}`, "cross-origin redirect: the page's origin is the destination's", origin);

  // POST → 302 with Set-Cookie → the cookie round-trips through our transport
  await T("page.goto", { url: base + "/login" });
  await T("page.type", { selector: "input[name=username]", text: "demo" });
  await T("page.type", { selector: "input[name=password]", text: "demo-pass" });
  await T("page.click", { selector: "button[type=submit]" });
  await T("page.waitFor", { text: "Welcome, demo", timeoutMs: 8000 });
  check(new URL(await loc()).pathname === "/account", "POST /login → 302: the address is /account (it used to stay on /login)", await loc());
  check(/cookie: yes/.test((await T("page.text")).text), "Set-Cookie on the 302 was stored and sent on the next request");

  // a redirect INTO a 402: paid once, at the destination
  const e0 = (await T("x402.events", { since: 0 })).next;
  await T("page.goto", { url: base + "/redir/paid" });
  const paid = (await T("x402.events", { since: e0 })).events.filter((e) => e.kind === "paid");
  check(paid.length === 1 && paid[0].resource.endsWith("/room"), "redirect into a 402: exactly one payment, for the destination", paid.map((p) => p.resource + " " + p.amount).join(","));
  check(new URL(await loc()).pathname === "/room", "…and the address is /room");

  // gzip: decoded exactly once
  await T("page.goto", { url: base + "/gz" });
  check(/gzip body decoded ok/.test((await T("page.text")).text), "a gzip Content-Encoding body renders (decoded once, not twice)");

  // back() after redirects
  await T("page.goto", { url: base + "/free" });
  await T("page.back");
  check(new URL(await loc()).pathname !== "/free", "back() works after redirects", await loc());

  // identity: the UA, client hints and fetch metadata a real Chromium navigation sends
  await T("page.goto", { url: base + "/headers" });
  const h = JSON.parse((await T("page.text")).text);
  check(/dbbasic-browser\/\S+ \(\+https:\/\/dbbasic\.com\)$/.test(h["user-agent"]) && !/Electron/.test(h["user-agent"]), "User-Agent: no Electron token, ends with our product token and dbbasic.com", h["user-agent"].slice(-60));
  check(h["sec-fetch-mode"] === "navigate" && h["sec-fetch-dest"] === "document" && h["sec-fetch-user"] === "?1", "navigation carries navigate / document / ?1");
  check(!!h["sec-ch-ua"] && !!h["sec-ch-ua-platform"] && h["sec-ch-ua-mobile"] === "?0", "client hints are present");
  const jsBrands = (await T("page.eval", { js: "navigator.userAgentData.brands.map(b => b.brand).sort().join('|')" })).value;
  check(jsBrands === [...h["sec-ch-ua"].matchAll(/"([^"]+)";v=/g)].map((m) => m[1]).sort().join("|"), "HTTP client hints match navigator.userAgentData (no contradiction for servers to detect)", jsBrands);
  check(!h["x-raw-sec-lines"].some((l, i, a) => a.findIndex((m) => m.split(":")[0].toLowerCase() === l.split(":")[0].toLowerCase()) !== i), "no duplicated sec-* header lines");
  const sub = (await T("page.eval", { js: "fetch('/headers?x=1').then(r => r.json()).then(d => d['referer'])" })).value;
  check(typeof sub === "string" && sub.startsWith(base + "/headers"), "a same-origin subrequest carries the Referer (it was missing before)", sub);

  // WebSockets bypass our network layer (Chromium opens them itself); a policy can refuse them BEFORE any connection.
  const upgrades = async () => (await (await fetch(base + "/ws-count")).json()).upgrades;
  const wsTitle = async () => { await T("page.waitFor", { text: "WebSocket test", timeoutMs: 5000 }); await new Promise((r) => setTimeout(r, 800)); return (await T("tabs.list")).find((t) => t.active).title; };
  check((await T("net.policy")).blockWebSockets === false, "WebSockets are allowed by default");
  const before = await upgrades();
  await T("page.goto", { url: base + "/ws-page" });
  check((await wsTitle()) === "ws:open" && (await upgrades()) === before + 1, "by default a page's WebSocket opens (the handshake reaches the server)");
  await T("net.policy", { blockWebSockets: true });
  const wsEvents0 = (await T("x402.events", { since: 0 })).next;
  const mid = await upgrades();
  await T("page.goto", { url: base + "/ws-page" });
  check((await wsTitle()) === "ws:error", "with the policy on, the page's WebSocket fails");
  check((await upgrades()) === mid, "…and NO handshake ever reached the server (refused before any connection was opened)");
  check((await T("x402.events", { since: wsEvents0 })).events.some((e) => e.kind === "websocket-refused"), "…and the refusal is announced as an event (never silent)");
  check((await T("page.eval", { js: "fetch('/free').then(r => r.status)" })).value === 200, "ordinary requests are unaffected by the policy");
  await T("net.policy", { blockWebSockets: false });
  await T("page.goto", { url: base + "/ws-page" });
  check((await wsTitle()) === "ws:open", "turning the policy off allows WebSockets again");
  await T("net.policy", { blockWebSockets: "yes" }).then(() => check(false, "a non-boolean policy value was accepted"), (e) => check(e.code === "bad-params", "a non-boolean policy value is rejected"));

  // One goto is ONE request to the site, including when the tab is already on that address (it used to load twice).
  const hits = async () => (await (await fetch(base + "/hits")).json()).hits;
  await T("page.goto", { url: base + "/free" });
  let h0 = await hits();
  await T("page.goto", { url: base + "/free" });
  await sleep(500);
  check((await hits()) - h0 === 1, "going to the address a tab is already on makes ONE request to the server (it used to make two)", `${(await hits()) - h0} request(s)`);
  h0 = await hits();
  await T("page.goto", { url: base + "/free?other=1" });
  await sleep(500);
  check((await hits()) - h0 === 1, "going to a different address makes one request");

  // Scripts, styles and fonts that a page loads from another site in CORS mode (<script crossorigin>, the way CDNs are used), with and
  // without an integrity hash, plus a plain one and one through a redirect. These used to fail (ERR_FAILED): the browser always asked for
  // cookies, and a response that says "any site may read this" is refused when the request carried them.
  const cdn = await T("page.goto", { url: base + "/cdn-page", settle: { timeoutMs: 10000, frames: false } });
  const loaded = (await T("page.eval", { js: "JSON.stringify({ redirected: window.redirected, loaded: [...new Set(window.loaded || [])].sort(), bg: getComputedStyle(document.body).backgroundColor, font: window.fontFetch })" })).value;
  const lj = JSON.parse(loaded);
  check(cdn.settle.resources.failed === 0 && cdn.settle.resources.requested >= 8, "every cross-origin script, style and fetch on a CDN-style page loads (none fail)", JSON.stringify(cdn.settle.resources.failedExamples ?? []));
  check(JSON.stringify(lj.loaded) === JSON.stringify(["cors-script", "integrity-script", "plain-script", "redirected-script"]) && lj.redirected === 5, "the CORS-mode scripts, the one with an integrity hash, the plain one, and all five redirected ones (301, 302, 307, 308, with and without crossorigin) run", loaded);
  check(cdn.settle.console.counts.error === 0, "and the page logs no errors (a redirect that says text/plain with nosniff, as unpkg's does, no longer makes the browser refuse the script it points to)", JSON.stringify(cdn.settle.console.errors.map((e) => e.text.slice(0, 80))));
  check(lj.bg === "rgb(1, 2, 3)" && lj.font === 17, "the cross-origin stylesheet is applied and a cross-origin fetch succeeds", loaded);
}
