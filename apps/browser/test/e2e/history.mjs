// Browsing history on the askrobots account, end to end against the stand-in on the demo server (see /mcp there):
// nothing before signing in; visits with clean addresses and their text after; glances, password pages and paused time
// left out; forget and never-record; the status bar; and the assistant's history search, which asks first.
export default async function (ctx) {
  const { call: T, check, base, sleep, chrome } = ctx;
  const stored = async () => (await fetch(base + "/o/_history")).json();
  async function waitFor(fn, what, tries = 120) {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    throw new Error(`timed out waiting for ${what}`);
  }
  const ask = (id) => T("mcp.state").then((s) => s.find((x) => x.id === id));
  const c = await chrome();
  const pill = () => c.ev(`(() => { const b = document.getElementById('histBtn'); return b.style.display === 'none' ? '' : b.textContent; })()`);
  // Visit a page for `secs` seconds, then move on (to a blank page, which ends the visit).
  async function visit(url, secs) {
    await T("page.goto", { url });
    await sleep(secs * 1000);
  }

  // ---- before signing in ----------------------------------------------------------------------------------------
  let st = await T("history.state");
  check(st.on === false && /not signed in/.test(st.why), "before signing in to askrobots, history is off and says why", JSON.stringify(st));
  await visit(base + "/free", 2.5);
  await T("page.goto", { url: base + "/tiny" });
  await T("history.flush");
  check((await stored()).visits.length === 0 && (await T("history.state")).queued === 0, "and nothing is recorded or kept waiting");
  check((await pill()) === "", "the status bar shows no history button while signed out");

  // ---- sign in ----------------------------------------------------------------------------------------------------
  const conn = await T("mcp.connect", { id: "askrobots", open: false });
  const back = (await fetch(conn.authorizeUrl, { redirect: "manual" })).headers.get("location");
  await fetch(back);
  await waitFor(async () => (await ask("askrobots"))?.signedIn, "the sign-in");
  st = await waitFor(async () => { const s = await T("history.state"); return s.on ? s : null; }, "history to switch on");
  check(st.on && !st.paused, "signed in (with the history permission), history is on", JSON.stringify(st));
  check(new URL(conn.authorizeUrl).searchParams.get("scope").split(" ").includes("history"), "the sign-in asks for the history permission", new URL(conn.authorizeUrl).searchParams.get("scope"));
  await waitFor(async () => (await pill()) === "History", "the status bar's History button");
  check(true, "the status bar shows History");

  // ---- visits -----------------------------------------------------------------------------------------------------
  await visit(base + "/headers?utm_source=newsletter&x=1#top", 3); // a visit: kept, with the address cleaned
  await visit(base + "/forms", 3); // a password field shows: never recorded
  await visit(base + "/free", 0.5); // a glance: not a visit
  await visit(base + "/readable", 3);
  await T("page.goto", { url: base + "/tiny" });
  const after = await T("history.flush");
  const v = (await stored()).visits;
  const urls = v.map((x) => x.url);
  check(urls.includes(base + "/headers") && urls.includes(base + "/readable"), "pages you stay on are recorded on the account, with tracking parameters and fragments removed", JSON.stringify(urls));
  check(!urls.some((u) => u.includes("/forms")), "a page with a password field is never recorded");
  check(!urls.some((u) => u.endsWith("/free")), "a glance of under two seconds is not a visit");
  const h = v.find((x) => x.url === base + "/headers");
  check(h && h.seconds_on_page >= 2 && /^\d{4}-\d\d-\d\dT/.test(h.visited_at) && h.title && h.text && h.text.length > 20, "a visit has its title, start time, seconds on the page and the page's visible text", JSON.stringify({ ...h, text: h?.text?.slice(0, 60) }));
  check(after.queued === 0 && after.sent >= 2, "nothing is left waiting once sent", JSON.stringify(after));

  // ---- pause ------------------------------------------------------------------------------------------------------
  await T("history.pause", { paused: true });
  check((await stored()).paused === true && (await pill()) === "History paused", "pausing is saved on the account and shown in the status bar");
  const n0 = (await stored()).visits.length;
  await visit(base + "/headers?paused=1", 3);
  await T("page.goto", { url: base + "/tiny" });
  await T("history.flush");
  check((await stored()).visits.length === n0, "while paused, nothing is recorded");
  await T("history.pause", { paused: false });
  check((await stored()).paused === false && (await pill()) === "History", "resuming is saved too");

  // ---- the assistant searches history, and asks first ------------------------------------------------------------
  let since = (await T("chat.events", { since: 0 })).next;
  const run = T("chat.send", { text: "history: where did I see the headers page?", mode: "auto" });
  const q1 = await waitFor(async () => (await T("chat.events", { since })).events.find((e) => e.kind === "confirm"), "the approval for the history search");
  check(/^Search your browsing history/.test(q1.summary) && /AI/.test(q1.summary) && q1.danger === false, "the assistant's history search asks first, even in Auto mode, saying the results go to its AI (not marked risky: it changes nothing)", q1.summary);
  await T("chat.confirm", { id: q1.id, ok: true });
  const r1 = await run;
  check(r1.reply.includes(base + "/headers"), "with a yes, it finds the page in history", r1.reply);
  since = (await T("chat.events", { since: 0 })).next;
  const run2 = T("chat.send", { text: "history again" });
  const q2 = await waitFor(async () => (await T("chat.events", { since })).events.find((e) => e.kind === "confirm"), "the second approval");
  await T("chat.confirm", { id: q2.id, ok: false });
  check((await run2).reply === "Result: declined", "with a no, nothing is searched");
  const tools = await T("mcp.tools");
  check(!JSON.stringify(tools).match(/add_history|forget_history|list_history|history_settings/), "the assistant is never given the tools that record, list or forget history", JSON.stringify(tools.map((t) => t.name ?? t)));

  // ---- forget and never-record -----------------------------------------------------------------------------------
  const f = await T("history.forget", { scope: "url", target: base + "/readable#x" });
  check(f.forgotten >= 1 && !(await stored()).visits.some((x) => x.url === base + "/readable"), "forgetting a page deletes it from the account", JSON.stringify(f));
  await T("history.never", { host: "127.0.0.1" });
  check((await stored()).never.includes("127.0.0.1"), "never-record is saved on the account");
  const n1 = (await stored()).visits.length;
  await visit(base + "/readable", 3);
  await T("page.goto", { url: base + "/tiny" });
  await T("history.flush");
  check((await stored()).visits.length === n1, "and that site is no longer recorded");

  // ---- sign out ---------------------------------------------------------------------------------------------------
  await T("mcp.disconnect", { id: "askrobots" });
  st = await waitFor(async () => { const s = await T("history.state"); return !s.on ? s : null; }, "history to switch off");
  check(st.on === false && st.queued === 0, "signing out switches history off and keeps nothing waiting", JSON.stringify(st));
}
