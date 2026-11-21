// Connecting to an MCP server with OAuth, end to end: discovery, registration, PKCE through the loopback redirect,
// tools in the chat, refresh, revocation. The server is a stand-in on the demo server (see /mcp and /o/* there).
export default async function (ctx) {
  const { call: T, check, base, sleep } = ctx;
  const rejects = (p) => p.then(() => null, (e) => e);
  const demo = async () => (await T("mcp.state")).find((x) => x.id === "demo");
  const stats = async () => (await fetch(base + "/o/_stats")).json();
  const ev = async (since) => T("chat.events", { since });
  async function waitFor(fn, what) {
    for (let i = 0; i < 200; i++) { const v = await fn(); if (v) return v; await sleep(50); }
    throw new Error(`timed out waiting for ${what}`);
  }

  // before signing in
  let st = await T("mcp.state");
  check(st.some((x) => x.id === "askrobots") && st.find((x) => x.id === "demo")?.signedIn === false, "the built-in askrobots entry and the server from the servers file are listed, and not signed in", JSON.stringify(st.map((x) => x.id)));
  check((await T("mcp.tools")).length === 0, "a server you are not signed in to adds no tools");
  const none = await T("chat.send", { text: "lookup cats" });
  check(none.reply === "Result: no such tool", "so the assistant cannot use it");

  // a sign-in that is cancelled, and one with the wrong state
  const c0 = await T("mcp.connect", { id: "demo", open: false });
  const u0 = new URL(c0.authorizeUrl);
  const redirect0 = u0.searchParams.get("redirect_uri");
  check((await demo()).connecting === true, "starting a sign-in shows it as waiting");
  check((await fetch(`${redirect0}?code=x&state=not-the-state`)).status === 400 && (await demo()).connecting === true, "a redirect with the wrong state is refused and does not end the sign-in");
  await T("mcp.cancel", { id: "demo" });
  await waitFor(async () => (await demo()).connecting === false, "the cancelled sign-in to end");
  check((await demo()).error === "sign-in was cancelled" && !(await demo()).signedIn, "cancelling ends it, says so, and signs nobody in");

  // the real thing: registration, PKCE, the loopback redirect
  const c = await T("mcp.connect", { id: "demo", open: false });
  const u = new URL(c.authorizeUrl);
  check(u.origin + u.pathname === base + "/o/authorize/" && u.searchParams.get("code_challenge_method") === "S256" && u.searchParams.get("response_type") === "code" && u.searchParams.get("scope") === "mcp" && u.searchParams.get("state").length > 20, "the consent address is built from the server's own discovery documents, with PKCE and a state", c.authorizeUrl);
  const redirect = u.searchParams.get("redirect_uri");
  check(/^http:\/\/127\.0\.0\.1:5368\d\/callback$/.test(redirect), "the redirect is a loopback address on a registered port", redirect);
  const reg = (await stats()).lastRegistration;
  check(reg.token_endpoint_auth_method === "none" && reg.redirect_uris.length === 5 && !("client_secret" in reg), "the client registered itself as public, with all five loopback redirects and no secret", JSON.stringify(reg));
  const approve = await fetch(c.authorizeUrl, { redirect: "manual" }); // what the person's browser does after they click Approve
  const back = approve.headers.get("location");
  check(approve.status === 302 && back.startsWith(redirect), "the server sends the browser back to the loopback address", back);
  check((await fetch(back)).status === 200, "the browser's own redirect is accepted");
  await waitFor(async () => (await demo()).signedIn, "the sign-in to finish");
  st = await T("mcp.state");
  check((await demo()).signedIn && !(await demo()).connecting && !JSON.stringify(st).match(/AT-|RT-|code-/), "signed in, and nothing secret is in the state");
  check((await demo()).persistent === false, "and with DBB_MCP_STORE=memory the sign-in is reported as lasting only until the browser closes");
  const s1 = await stats();
  check(s1.registered === 1 && s1.issued === 1, "the code was traded for a token, and the second try reused the first one's registration", JSON.stringify({ registered: s1.registered, issued: s1.issued }));
  check(!JSON.stringify(await T("status")).match(/AT-|RT-/), "tokens do not appear in the browser's status either");

  // the tools
  const tools = await T("mcp.tools");
  check(JSON.stringify(tools.map((t) => [t.name, t.risk])) === JSON.stringify([["demo__lookup", "read"], ["demo__save", "act"], ["demo__person", "read"]]), "only the tools the entry allows are offered, reads as reads and the write as an action (the server's 'wipe' is not offered)", JSON.stringify(tools.map((t) => t.name)));

  // using them from the chat
  const lookup = await T("chat.send", { text: "lookup cats" });
  check(lookup.reply.startsWith("Result: Found 2 notes about cats.") && !lookup.events.some((e) => e.kind === "confirm"), "the assistant can use a read tool, with no question asked");
  const log = await (await fetch(base + "/v1/_log")).json();
  const toolMsg = log.at(-1).messages.at(-1);
  check(toolMsg.role === "tool" && /^\[Content from the person's own account/.test(toolMsg.content) && /<untrusted-[0-9a-f]{12}>/.test(toolMsg.content) && toolMsg.content.includes("IGNORE ALL PREVIOUS INSTRUCTIONS"), "what the server returned reaches the model marked as from the person's account, not from the person, inside the untrusted tags (its text is there, as data)");
  check(!log.at(-1).tools.some((t) => /wipe/.test(t.function.name)) && !/delete everything/i.test(JSON.stringify(log.at(-1).tools)), "the model is never offered a tool the entry did not allow");
  const who = await T("chat.send", { text: "whois" });
  check(/Ada/.test(who.reply) && !/private notes|interactions/.test(who.reply) && !/private notes/.test(JSON.stringify(await (await fetch(base + "/v1/_log")).json())), "fields the entry drops (notes, interactions) never reach the model");

  // a tool that writes: always asked about, even in Auto mode; fixed arguments are forced
  await T("chat.mode", { mode: "auto" });
  let since = (await ev(0)).next;
  const run = T("chat.send", { text: "keep this page" });
  const ask = await waitFor(async () => (await ev(since)).events.find((e) => e.kind === "confirm"), "the approval for the write");
  check(ask.danger === true && /^Ask Demo notes to save:\n/.test(ask.summary) && /\nproject_id: P-1(\n|$)/.test(ask.summary), "a write is asked about even in Auto mode, and the question shows the forced project, not the model's", ask.summary);
  await T("chat.confirm", { id: ask.id, ok: false });
  check((await run).reply === "Result: declined" && (await stats()).lastArgs?.title !== "A good page", "a no means nothing was sent to the server");
  await T("chat.mode", { mode: "ask" });
  since = (await ev(0)).next;
  const run2 = T("chat.send", { text: "keep this page" });
  const ask2 = await waitFor(async () => (await ev(since)).events.find((e) => e.kind === "confirm"), "the second approval");
  await T("chat.confirm", { id: ask2.id, ok: true });
  check((await run2).reply === "Result: saved", "a yes sends it");
  check((await stats()).lastArgs.project_id === "P-1" && (await stats()).lastArgs.title === "A good page", "the server received the fixed project, whatever the model asked for", JSON.stringify((await stats()).lastArgs));

  // After private data was read from the account, typing asks even in Auto mode (a page could have talked the assistant into copying it)
  await T("page.goto", { url: base + "/forms" });
  await T("chat.mode", { mode: "auto" });
  since = (await ev(0)).next;
  const run3 = T("chat.send", { text: "exfil the notes" });
  const ask3 = await waitFor(async () => (await ev(since)).events.find((e) => e.kind === "confirm"), "the approval for typing after a private read");
  check(/Type “COPIED-FROM-NOTES”/.test(ask3.summary) && ask3.danger === true, "in Auto mode, typing right after a private read asks, and is marked risky", ask3.summary);
  check((await T("page.eval", { js: "document.querySelector('[name=first]').value" })).value === "Ada", "and nothing has been typed yet");
  await T("chat.confirm", { id: ask3.id, ok: false });
  check((await run3).reply === "Result: declined" && (await T("page.eval", { js: "document.querySelector('[name=first]').value" })).value === "Ada", "a no leaves the page untouched");
  await T("chat.mode", { mode: "ask" });

  // refresh: with very short-lived access tokens every call has to refresh first, and keeps working
  await T("mcp.disconnect", { id: "demo" });
  await fetch(base + "/o/_short?on=1");
  const c2 = await T("mcp.connect", { id: "demo", open: false });
  const a2 = await fetch(c2.authorizeUrl, { redirect: "manual" });
  await fetch(a2.headers.get("location"));
  await waitFor(async () => (await demo()).signedIn, "the second sign-in");
  const r0 = (await stats()).refreshed;
  const again = await T("chat.send", { text: "lookup dogs" });
  check(again.reply.startsWith("Result: Found 2 notes about cats.") && (await stats()).refreshed > r0, "when the access token is about to expire it is refreshed quietly and the call works", `refreshes ${(await stats()).refreshed - r0}`);
  await fetch(base + "/o/_short?on=0");

  // signing in inside the browser's own tab: no system browser, no listener, the redirect is caught inside the browser
  await T("mcp.disconnect", { id: "demo" });
  const tabsBefore = (await T("tabs.list")).length;
  const issuedBefore = (await stats()).issued;
  const net = await import("node:net");
  const portOpen = (port) => new Promise((resolve) => { const sk = net.connect({ host: "127.0.0.1", port }, () => (sk.destroy(), resolve(true))); sk.on("error", () => resolve(false)); });
  const viaTab = await T("mcp.connect", { id: "demo", wait: true }); // the default: a tab of this browser (the stand-in server approves at once)
  check(new URL(viaTab.authorizeUrl).searchParams.get("redirect_uri") === "http://127.0.0.1:53682/callback", "by default the consent page opens in a tab of this browser, with the first registered loopback address as the redirect", viaTab.authorizeUrl);
  check((await demo()).signedIn && (await stats()).issued === issuedBefore + 1, "the redirect was caught inside the browser and the code traded for a token");
  check(!(await portOpen(53682)) && !(await portOpen(53683)), "and nothing is listening on a port, so there is nothing to be down when you click");
  check((await T("tabs.list")).length === tabsBefore, "the consent tab closes itself afterwards (the number of tabs is what it was)", `${tabsBefore} → ${(await T("tabs.list")).length}`);
  check((await T("chat.send", { text: "lookup cats" })).reply.startsWith("Result: Found 2 notes about cats."), "and the new sign-in works for the assistant");

  // the panel
  const cdp = await ctx.chrome();
  const q = (js) => cdp.ev(`(() => { ${js} })()`);
  const row = `[...document.querySelectorAll('#chatConn .cn')].find((r) => /Demo notes/.test(r.textContent))`;
  await cdp.ev(`setChat(false)`);
  await cdp.ev(`toggleChat()`);
  await waitFor(async () => q(`return /Demo notes/.test(document.getElementById('chatConn').textContent)`), "the panel to list the connection");
  check(await q(`const t = ${row}.textContent; return /connected/.test(t) && /until you close the browser/.test(t) && /Disconnect/.test(t)`), "the panel shows the connection, says it lasts until the browser closes, and offers Disconnect");
  await q(`${row}.querySelector('button').click()`);
  await waitFor(async () => (await demo()).signedIn === false, "the panel's Disconnect");
  const revokedBy = (await stats()).revoked;
  check(revokedBy >= 2, "Disconnect asks the server to revoke the token", String(revokedBy));
  await waitFor(async () => q(`const b = ${row}.querySelector('button').textContent; return b === 'Connect'`), "the panel to offer Connect again");
  check(true, "and then offers Connect again");
  check((await T("mcp.tools")).length === 0 && (await T("chat.send", { text: "lookup cats" })).reply === "Result: no such tool", "after disconnecting the tools are gone");

  // off while the caller network is on
  await T("net.provider", { enabled: true, userAgent: "E2E-Mcp/1.0 (+https://example.invalid/about)" });
  const refused = await rejects(T("mcp.connect", { id: "demo", open: false }));
  await T("net.provider", { enabled: false });
  check(refused && /caller network/.test(refused.message), "signing in is refused while the caller network is on", refused?.message);
}
