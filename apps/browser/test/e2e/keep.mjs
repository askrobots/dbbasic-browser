// Keep: one click keeps a copy of the page (what was on screen and its text) and closes the tab; kept copies are searched and
// opened from the browser itself.
export default async function (ctx) {
  const { call: T, check, base, sleep } = ctx;
  const cdp = await ctx.chrome();
  const q = (js) => cdp.ev(`(() => { ${js} })()`);
  async function waitFor(fn, what, tries = 100) {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    throw new Error(`timed out waiting for ${what}`);
  }

  const t = await T("tabs.new", { url: base + "/keep-me" });
  await sleep(300);
  const before = (await T("tabs.list")).length;
  const r = await T("keep.tab", {});
  check(r.ok && r.record.title === "Marmalade notes" && r.record.url === base + "/keep-me" && r.record.imageBytes > 1000 && r.record.textChars > 50, "keeping a page saves a picture of it and its text, with its address and title", JSON.stringify({ ...r.record, id: undefined }));
  check(r.closed && (await T("tabs.list")).length === before - 1 && !(await T("tabs.list")).some((x) => x.id === t.id), "and closes the tab");
  check(r.bookmarked === false, "with no connection it is not saved as a bookmark (and that is fine)");

  const all = await T("keep.list", {});
  check(all.length === 1 && all[0].id === r.record.id, "the kept page is listed");
  const hit = await T("keep.list", { q: "zebra marmalade" });
  check(hit.length === 1 && /zebra keeps a secret recipe/.test(hit[0].snippet), "searching the text of kept pages finds it, with the words around the match", hit[0]?.snippet);
  check((await T("keep.list", { q: "zebra pineapple" })).length === 0, "every word has to match");

  // the copy opens in a tab, served by the browser itself: text and picture, nothing that runs
  await T("tabs.new", { url: r.view });
  await sleep(500);
  const txt = (await T("page.text")).text;
  check(/Kept copy/.test(txt) && /zebra keeps a secret recipe/.test(txt) && /bold words & an ampersand/.test(txt), "the kept copy opens with its text (markup in the page is shown as text, not run)", txt.slice(0, 120));
  check((await T("page.eval", { js: "(() => { const i = document.querySelector('img'); return i && i.complete && i.naturalWidth > 100 })()" })).value === true, "and with the picture of the page");
  check((await T("page.eval", { js: "document.scripts.length" })).value === 0, "the copy has no scripts");

  // a page with a sign-in form is not kept
  await T("page.goto", { url: base + "/login" });
  const login = await T("keep.tab", {});
  check(login.ok === false && login.reason === "login" && (await T("tabs.list")).some((x) => x.url === base + "/login"), "a page with a sign-in form is not kept, and its tab stays open", login.message);

  // the toolbar button and the list in the bookmarks panel
  await T("tabs.new", { url: base + "/keep-me?second=1" });
  await sleep(300);
  await q(`document.getElementById('keepBtn').click()`);
  await waitFor(async () => /Kept “Marmalade notes”/.test(await q(`return document.getElementById('toast').textContent`)), "the kept note");
  check(!(await T("tabs.list")).some((x) => /second=1/.test(x.url)), "📥 keeps the page and closes the tab, with a short note and no dialog");
  await cdp.ev(`setBm(true)`);
  await q(`document.getElementById('bmView-kept').click()`);
  await waitFor(async () => q(`return document.querySelectorAll('#bmPanel .bm').length === 2`), "two kept copies in the list");
  await q(`const i = document.getElementById('keptSearch'); i.value = 'seville'; i.dispatchEvent(new Event('input'));`);
  await waitFor(async () => q(`return document.querySelectorAll('#bmPanel .bm').length === 2 && /Seville/.test(document.querySelector('#bmPanel .bm .s').textContent)`), "search in the kept list");
  check(true, "the bookmarks panel lists kept copies and searches their text");
  await q(`document.querySelector('#bmPanel .bm').click()`);
  await waitFor(async () => /^dbb-kept:\/\//.test((await T("tabs.list")).find((x) => x.active).url), "the kept copy to open");
  check(true, "clicking a kept copy opens it in a new tab");

  // the assistant can keep a tab
  await T("tabs.new", { url: base + "/keep-me?third=1" });
  await T("chat.mode", { mode: "auto" });
  const res = await T("chat.send", { text: "pocket that tab" });
  await T("chat.mode", { mode: "ask" });
  check(res.reply === "Result: kept and closed" && !res.events.some((e) => e.kind === "confirm") && !(await T("tabs.list")).some((x) => /third=1/.test(x.url)), "the assistant keeps a tab and closes it, unasked in Auto mode", JSON.stringify({ reply: res.reply, ended: res.ended, ev: res.events.filter((e) => e.kind !== "usage").map((e) => [e.kind, e.name, e.note || e.reason || e.summary || e.message]).slice(0, 8) }));
  check((await T("keep.list", {}))[0].reason === "recipe for later", "and records why, when it was told");

  // off while the caller network is on
  await T("net.provider", { enabled: true, userAgent: "E2E-Keep/1.0 (+https://example.invalid/about)" });
  const off = await T("keep.tab", {});
  await T("net.provider", { enabled: false });
  check(off.ok === false && off.reason === "caller-network-on", "keeping is switched off while the caller network is on");
}
