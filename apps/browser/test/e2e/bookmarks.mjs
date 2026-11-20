// Bookmarks: the person's saved links on askrobots (a stand-in here), read when the list is opened, saved with one click on ☆,
// and usable by the assistant to save and close tabs.
export default async function (ctx) {
  const { call: T, check, base, sleep } = ctx;
  const cdp = await ctx.chrome();
  const q = (js) => cdp.ev(`(() => { ${js} })()`);
  const server = async () => (await fetch(base + "/o/_links")).json();
  async function waitFor(fn, what, tries = 100) {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    throw new Error(`timed out waiting for ${what}`);
  }
  const star = () => q(`const b = document.getElementById('starBtn'); return b.textContent + (b.classList.contains('saved') ? '|saved' : '') + (b.disabled ? '|disabled' : '')`);

  // before connecting: nothing to show, and the star says to connect instead of failing silently
  const s0 = await T("bookmarks.list");
  check(s0.items.length === 0 && s0.source === "none" && s0.connected === false, "before connecting there are no bookmarks and nothing was asked of the service", JSON.stringify(s0));
  await T("page.goto", { url: base + "/forms" });
  try { await waitFor(async () => (await star()) === "☆", "the empty star on a web page", 30); } catch (e) { throw new Error(e.message + " — star is " + (await star()) + ", url bar " + (await q(`return document.getElementById('url').value`)) + ", errors " + (await q(`return String(window.__lastErr || '')`))); }
  await q(`document.getElementById('starBtn').click()`);
  await waitFor(async () => /Connect askrobots/.test(await q(`return document.getElementById('toast').textContent`)), "the 'connect first' note");
  check((await star()) === "☆", "clicking ☆ before connecting says to connect first, and saves nothing");

  // connect (in a tab of the browser): the bookmarks come in by themselves
  await T("mcp.connect", { id: "askrobots", wait: true });
  const s1 = await waitFor(async () => { const s = await T("bookmarks.list"); return s.items.length === 2 ? s : null; }, "the bookmarks after signing in");
  check(s1.source === "service" && s1.connected && s1.items.map((b) => b.title).join("|") === "Headers echo|Free page", "after signing in, the bookmarks arrive from the service, newest first", JSON.stringify(s1.items.map((b) => b.title)));

  // the list
  await cdp.ev(`setBm(true)`);
  await waitFor(async () => q(`return document.querySelectorAll('#bmPanel .bm').length === 2`), "two rows in the list");
  check(await q(`return /Your links on askrobots.com/.test(document.getElementById('bmPanel').textContent)`), "the list says where the bookmarks come from and when they were updated");
  await q(`const i = document.getElementById('bmSearch'); i.value = 'free'; i.dispatchEvent(new Event('input'));`);
  check(await q(`const r = document.querySelectorAll('#bmPanel .bm'); return r.length === 1 && /Free page/.test(r[0].textContent)`), "searching the list narrows it");
  await q(`document.querySelector('#bmPanel .bm').click()`);
  await waitFor(async () => (await T("tabs.list")).find((t) => t.active).url === base + "/free", "the bookmark to open");
  check(!(await q(`return document.getElementById('bmPanel').classList.contains('open')`)), "clicking a bookmark opens it in the tab and closes the list");
  check((await star()) === "★|saved", "the star is filled on a page that is already a bookmark", await star());

  // one click saves, with no dialog
  await T("page.goto", { url: base + "/forms" });
  await waitFor(async () => (await star()) === "☆", "the empty star");
  await q(`document.getElementById('starBtn').click()`);
  await waitFor(async () => (await star()) === "★|saved", "the star to fill in");
  const saved = (await server())[0];
  check(saved.url === base + "/forms" && saved.title === "forms" && saved.project_id === "P-links" && saved.is_public === false, "one click saves the page with its title, private, in the project the server's entry names", JSON.stringify(saved));
  check(await q(`return !document.querySelector('dialog[open], .modal.show')`) && (await T("bookmarks.has", { url: base + "/forms" })).saved, "there is no dialog after it, and the browser knows the page is saved");
  await q(`document.getElementById('starBtn').click()`); // already saved: shows the list instead of saving twice
  await waitFor(async () => q(`return document.getElementById('bmPanel').classList.contains('open')`), "the list to open");
  check((await server()).filter((l) => l.url === base + "/forms").length === 1, "clicking a filled star never saves the page twice (it opens the list)");
  await cdp.ev(`setBm(false)`);

  // a page that is not saved, on a site that has a saved page: the star says so
  await T("page.goto", { url: base + "/hits" });
  await waitFor(async () => /site/.test(await q(`return document.getElementById('starBtn').className`)), "the same-site hint");
  const hint = await q(`const b = document.getElementById('starBtn'); return b.textContent + '|' + b.title`);
  check(/^☆\|You have \d+ bookmarks on this site/.test(hint), "a page that is not saved, on a site with saved pages, shows that you have bookmarks there (and ☆ still saves this page)", hint);

  // a link saved somewhere else shows up the next time the list is opened
  await fetch(base + "/o/_addlink?url=" + encodeURIComponent(base + "/headers?elsewhere=1") + "&title=" + encodeURIComponent("Saved on the website"));
  await cdp.ev(`setBm(true)`);
  await waitFor(async () => q(`return /Saved on the website/.test(document.getElementById('bmPanel').textContent)`), "the link saved elsewhere");
  check(true, "a link saved on the website shows up when the list is opened");
  await cdp.ev(`setBm(false)`);

  // searching looks through all the links on the service, not just the newest 100 the list holds
  await fetch(base + "/o/_seed");
  await cdp.ev(`setBm(true)`);
  await waitFor(async () => q(`return /Showing your newest 100/.test(document.getElementById('bmPanel').textContent)`), "the full newest-100 list");
  check(!(await T("bookmarks.list")).items.some((b) => /Ancient/.test(b.title)), "an old link is not among the newest 100 the list holds");
  await q(`const i = document.getElementById('bmSearch'); i.value = 'ancient'; i.dispatchEvent(new Event('input'));`);
  await waitFor(async () => q(`return [...document.querySelectorAll('#bmPanel .bm')].some((r) => /Ancient Yahoo archive/.test(r.textContent))`), "the old link found by searching askrobots");
  check(true, "searching the bookmarks finds an old link by asking askrobots, beyond the newest 100");
  const direct = await T("bookmarks.search", { q: "ancient" });
  check(direct.items.length === 1 && direct.items[0].title === "Ancient Yahoo archive", "and scripts can search the same way", JSON.stringify(direct.items.map((b) => b.title)));
  await cdp.ev(`setBm(false)`);
  await T("page.goto", { url: base + "/headers?ancient=1&utm_source=newsletter" });
  await waitFor(async () => (await star()) === "★|saved", "the star on the old bookmark");
  check(true, "an old bookmark found by a search is then known: opening it shows ★ (a tracking parameter on the address does not matter)");

  // an old bookmark nobody searched for: the browser asks about the site when you open the page, and ☆ fills in
  await T("page.goto", { url: base.replace("127.0.0.1", "localhost") + "/free?old=103" });
  try { await waitFor(async () => (await star()) === "★|saved", "the star on an old bookmark found by checking the site", 60); } catch (e) { throw new Error(e.message + " — star " + (await star()) + ", direct check " + JSON.stringify(await T("bookmarks.check", { url: base.replace("127.0.0.1", "localhost") + "/free?old=103" })) + ", state " + JSON.stringify((({ items, known, ...r }) => ({ ...r, items: items.length, known: known.length }))(await T("bookmarks.list")))); }
  check(true, "opening a page saved long ago (beyond the newest 100) fills ☆ after the browser checks the site with askrobots");
  await cdp.ev(`setBm(true)`);
  await waitFor(async () => q(`return !!document.getElementById('bmCheck')`), "the setting in the list");
  check(await q(`return document.getElementById('bmCheck').checked && /sends the site's name/.test(document.getElementById('bmPanel').textContent)`), "the list shows the setting, on, and says what it sends");
  await q(`document.getElementById('bmCheck').click()`);
  await waitFor(async () => (await T("bookmarks.list")).checkPages === false, "the setting to turn off");
  const offCheck = await T("bookmarks.check", { url: base.replace("127.0.0.1", "localhost") + "/free?old=104" });
  check(offCheck.checked === false, "with it off, pages are not checked", JSON.stringify(offCheck));
  await q(`document.getElementById('bmCheck').click()`);
  await cdp.ev(`setBm(false)`);

  // a window that thinks it is not connected learns it is after a load, even when the list did not change
  await cdp.ev(`bmApply(Object.assign({}, bm, { connected: false }))`);
  await T("bookmarks.list", { refresh: true });
  await waitFor(async () => cdp.ev(`bm.connected === true`), "the window to learn it is connected");
  check(true, "after a load the window always hears it is connected, even when the list is the same as its copy");

  // the assistant can save a tab and close it (Auto mode: both are on the safe list, so no questions)
  const tidyTab = await T("tabs.new", { url: base + "/free?tidy=1" });
  const tabsBefore = (await T("tabs.list")).length;
  await T("chat.mode", { mode: "auto" });
  const tidy = await T("chat.send", { text: "tidy up the tidy tab" });
  await T("chat.mode", { mode: "ask" });
  check(tidy.reply === "Result: saved and closed" && !tidy.events.some((e) => e.kind === "confirm"), "the assistant saves a tab as a bookmark and closes it, unasked in Auto mode", tidy.reply);
  check((await server()).some((l) => l.url === base + "/free?tidy=1") && (await T("tabs.list")).length === tabsBefore - 1 && !(await T("tabs.list")).some((t) => t.id === tidyTab.id), "the bookmark is on the service and the tab is gone");
}
