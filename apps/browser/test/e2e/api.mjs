// The automation API: transport guards, vault login, real input, tabs, screenshots, x402 policy.
import http from "node:http";

export default async function (ctx) {
  const { call: T, check, base, sleep } = ctx;
  const port = new URL(base).port;
  const url = ctx.controlUrl;
  const token = ctx.controlToken;

  // ---- transport guards ----
  const raw = (headers, body = '{"method":"status"}') => fetch(url, { method: "POST", headers, body }).then((r) => r.status);
  check((await raw({})) === 401, "no token → 401");
  check((await raw({ authorization: "Bearer wrong" })) === 401, "wrong token → 401");
  check((await raw({ authorization: "Bearer " + token, origin: "https://evil.test" })) === 403, "request carrying an Origin header → 403 (a web page can't drive it)");
  const u = new URL(url);
  const hostCode = await new Promise((res) => {
    const r = http.request({ host: u.hostname, port: u.port, path: "/rpc", method: "POST", headers: { host: `evil.test:${u.port}`, authorization: "Bearer " + token } }, (x) => { x.resume(); res(x.statusCode); });
    r.end('{"method":"status"}');
  });
  check(hostCode === 403, "non-loopback Host header → 403 (DNS-rebinding guard)");
  check((await raw({ authorization: "Bearer " + token })) === 200, "valid token → 200");

  // ---- vault login ----
  await T("page.goto", { url: base + "/login" });
  await T("login").then(() => check(false, "login while locked should fail"), (e) => check(e.code === "locked", "login while the vault is locked is refused", e.code));
  await T("vault.unlock", { master: "wrong master" }).then(() => check(false, "wrong master accepted"), (e) => check(e.code === "wrong-password", "wrong master password rejected"));
  const st = await T("vault.unlock", { master: ctx.vaultMaster });
  check(st.unlocked && st.count === 1, "unlock → one saved login");
  const r = await T("login");
  check(r.username === "demo" && !JSON.stringify(r).includes("demo-pass"), "login() returns the username only, never the password");
  check(/Welcome, demo/.test((await T("page.text", { selector: "#who" })).text), "signed in with the vault");
  check(new URL((await T("tabs.list"))[0].url).pathname === "/account", "after the login redirect the tab URL is /account");

  // origin binding: a different origin (same machine, other host name) must not get the credential
  await T("page.goto", { url: `http://localhost:${port}/login` });
  await T("login").then(() => check(false, "cross-origin fill should fail"), (e) => check(e.code === "not-found" || e.code === "bad-origin", "localhost ≠ 127.0.0.1: the credential is refused", e.code));

  // ---- real, trusted input ----
  await T("page.goto", { url: base + "/login" });
  await T("page.type", { selector: "input[name=username]", text: "demo" });
  await T("page.type", { selector: "input[name=password]", text: "nope" });
  await T("page.press", { key: "Enter" });
  await T("page.waitFor", { text: "Wrong username or password", timeoutMs: 5000 });
  check(true, "typed a wrong password + Enter → rejected by the server");
  await T("page.goto", { url: base + "/login" });
  await T("page.type", { selector: "input[name=username]", text: "demo" });
  await T("page.type", { selector: "input[name=password]", text: "demo-pass" });
  await T("page.click", { selector: "button[type=submit]" });
  await T("page.waitFor", { url: "/account", text: "Welcome, demo", timeoutMs: 5000 });
  check(true, "typed credentials + a real click → signed in at /account");

  // ---- tabs ----
  await T("page.goto", { url: base + "/login" });
  const before = (await T("tabs.list")).length;
  await T("page.click", { selector: "a[target=_blank]" });
  await sleep(1500);
  const tabs = await T("tabs.list");
  check(tabs.length === before + 1 && tabs.some((t) => t.url.endsWith("/free")), `target=_blank opens a tab (${before} → ${tabs.length})`);
  // The keyboard goes to the new page (space scrolls or pauses it), not the address bar.
  const focused = await (await ctx.chrome()).ev(`(() => { const a = document.activeElement; return a ? (a.tagName === "WEBVIEW" ? (a.classList.contains("hidden") ? "a hidden page" : "the page") : a.id || a.tagName) : "nothing"; })()`);
  check(focused === "the page", "a link that opens a new tab gives that tab's page the keyboard", focused);
  // Site icons: the tab shows the site's icon (a data: URL the browser fetched once per site, never loaded by the window itself).
  const tabIcons = await (await ctx.chrome()).ev(`[...document.querySelectorAll("#tabs .tab .th img.fav")].map((i) => i.src.slice(0, 22))`);
  check(tabIcons.length >= 1 && tabIcons.every((s) => s.startsWith("data:image/")), "tabs show the site's icon", JSON.stringify(tabIcons));
  const iconHits = (await (await fetch(base + "/o/_icon-hits")).json()).hits;
  check(iconHits === 2, "and each site's icon is fetched once, however many of its pages are opened (127.0.0.1 and localhost here)", `${iconHits} fetch(es)`);
  await T("tabs.close", { tab: tabs.find((t) => t.url.endsWith("/free")).id });
  check((await T("tabs.list")).length === before, "tabs.close works");

  const shot = await T("page.screenshot");
  check(shot.png.length > 2000 && shot.width > 300, `screenshot ${shot.width}×${shot.height}`);

  // ---- x402 approval policy ----
  check((await T("x402.approval")).mode === "ask", "default payment approval is 'ask'");
  const e0 = (await T("x402.events", { since: 0 })).next;
  await T("x402.approval", { mode: "auto", maxUsd: 1 });
  await T("page.goto", { url: base + "/premium" }); // $0.50: above the auto-approve threshold, so it would prompt
  const kinds = (await T("x402.events", { since: e0 })).events.map((e) => e.kind);
  check(kinds.includes("auto-decision") && kinds.includes("paid"), "auto mode under the cap: approved, paid, and logged", kinds.join(" → "));
  await T("x402.approval", { mode: "deny" });
  const e1 = (await T("x402.events", { since: 0 })).next;
  await T("page.goto", { url: base + "/premium" });
  const ev2 = (await T("x402.events", { since: e1 })).events;
  check(ev2.some((e) => e.kind === "auto-decision" && e.approved === false) && !ev2.some((e) => e.kind === "paid"), "deny mode refuses the same page; no payment");
  await T("x402.approval", { mode: "ask", maxUsd: 0 });
}
