// Plugins: a style rule installed from gitstable (a stand-in on the demo server, DBB_GITSTABLE), applied to its site only,
// live to open pages; all off, one off, update and remove; and refusals for CSS that could send, a lying server and more
// powers. Driven both through the automation API and through the Plugins panel.
export default async function (ctx) {
  const { call: T, check, base, sleep } = ctx;
  const port = new URL(base).port;
  const cdp = await ctx.chrome();
  const q = (js) => cdp.ev(`(() => { ${js} })()`);
  async function waitFor(fn, what, tries = 60) {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    throw new Error(`timed out waiting for ${what}`);
  }
  const width = async () => (await T("page.eval", { js: `getComputedStyle(document.getElementById('col')).maxWidth` })).value;
  const widthIs = (w, what) => waitFor(async () => (await width()) === w, what).then(() => true, () => false);
  const fails = (p) => p.then(() => null, (e) => e);

  let st = await T("plugins.state");
  check(st.plugins.length === 0 && st.origin === base && st.apiLevel === 1, "no plugins at first; installs come from the configured gitstable", JSON.stringify({ n: st.plugins.length, origin: st.origin }));
  await T("page.goto", { url: base + "/plugin-page" });
  check((await width()) === "300px", "the demo page's column is 300px wide on its own");

  // ---- look up, then install exactly what was shown ----
  const pv = await T("plugins.preview", { source: "demo/wide" });
  check(pv.tag === "2026.11v1" && /^[0-9a-f]{40}$/.test(pv.commit) && pv.testedHere, "looking up owner/repository finds its newest release and the commit it points to", JSON.stringify({ tag: pv.tag, commit: pv.commit }));
  check(/can't run code, read the page or send anything/.test(pv.says) && pv.sites.join() === "127.0.0.1", "and says which sites it changes and that it can't run code, read or send", pv.says);
  check((await width()) === "300px", "looking up installs nothing");
  await T("plugins.install", { token: pv.token });
  check(await widthIs("none", "the plugin on the open page"), "installing applies it to the open page at once", await width());
  const pill = () => q(`const b = document.getElementById('plugBtn'); return b.style.display === 'none' ? '' : b.textContent + (b.classList.contains('applied') ? '|on' : '|off') + (getComputedStyle(b).backgroundColor === getComputedStyle(document.getElementById('histBtn')).backgroundColor ? '' : '|looks-pressed')`);
  check((await waitFor(pill, "the status bar's plugin item")) === "Plugin: Wide page|on", "the status bar names the plugin changing this page", await pill());
  await T("page.goto", { url: `http://localhost:${port}/plugin-page` });
  check((await width()) === "300px", "another site (localhost) is left alone");
  check((await pill()) === "Plugins|off", "and the status bar just says Plugins there", await pill());
  await T("page.goto", { url: base + "/plugin-page" });
  check(await widthIs("none", "the plugin after loading the page again"), "a page loaded later gets it too");
  const again = await fails(T("plugins.install", { token: pv.token }));
  check(again?.code === "expired", "a look-up installs once", again?.code);

  // ---- switches ----
  await T("plugins.allOff", { off: true });
  check(await widthIs("300px", "all off"), "Turn all plugins off shows the site as it is, at once");
  check((await waitFor(async () => /off/.test(await pill()) && pill(), "the status bar to say off")) === "Plugin off|off", "and the status bar says the site's plugin is off", await pill());
  await T("plugins.allOff", { off: false });
  check(await widthIs("none", "back on"), "and on again");
  await T("plugins.enable", { id: "wide", enabled: false });
  check(await widthIs("300px", "one off"), "one plugin can be switched off");
  await T("plugins.enable", { id: "wide", enabled: true });
  check(await widthIs("none", "one on"), "and on");

  // ---- refused ----
  const sneaky = await fails(T("plugins.preview", { source: "demo/sneaky" }));
  check(sneaky?.code === "not-style-only" && /url/.test(sneaky.message), "CSS that could send something (url()) is refused", sneaky?.message);
  const esc = await fails(T("plugins.preview", { source: "demo/escaped" }));
  check(esc?.code === "not-style-only", "and so is CSS that hides one behind an escape", esc?.message);
  const lie = await fails(T("plugins.preview", { source: "demo/tampered" }));
  check(lie?.code === "mismatch", "a file that doesn't match its git blob id is refused", lie?.message);
  const more = await fails(T("plugins.preview", { source: "demo/scripty" }));
  check(more?.code === "bad-plugin" && /page-script/.test(more.message), "a plugin asking for powers this browser doesn't give is refused", more?.message);
  const elsewhere = await fails(T("plugins.preview", { source: "https://evil.test/demo/wide" }));
  check(elsewhere?.code === "bad-source", "an address on another site is refused: plugins come from gitstable only", elsewhere?.message);
  check((await T("plugins.state")).plugins.length === 1, "and nothing refused was installed");

  // ---- the Plugins panel ----
  await q(`document.getElementById('plugBtn').click()`);
  await waitFor(() => q(`return document.getElementById('plugPanel').classList.contains('open') && !!document.querySelector('#plugPanel .pl[data-id="wide"]')`), "the panel with the plugin");
  const row = await q(`return document.querySelector('#plugPanel .pl[data-id="wide"]').textContent`);
  check(/Wide page 2026\.11v1/.test(row) && /release 2026\.11v1 · commit [0-9a-f]{7}/.test(row), "clicking it opens Plugins, which lists it with its release and commit", row);
  const type = (text) => q(`const i = document.getElementById('plugSource'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); document.getElementById('plugLook').click(); return true;`);
  await type("demo/wide");
  const same = await waitFor(() => q(`const a = document.getElementById('plugAsk'); return a ? a.textContent : ''`), "the look-up of the installed release");
  const sameBtn = await q(`const b = document.getElementById('plugInstall'); return b ? getComputedStyle(b).display : 'none'`);
  check(/installed already/.test(same) && sameBtn === "none", "looking up the release that is installed says so, and offers nothing to install", same);
  await type("demo/sneaky");
  const err = await waitFor(() => q(`const e = document.querySelector('#plugPanel .err'); return e ? e.textContent : ''`), "the refusal in the panel");
  check(/refused/.test(err), "the panel says why a plugin is refused", err);
  await type("demo/wide@2026.10v1");
  const ask = await waitFor(() => q(`const a = document.getElementById('plugAsk'); return a ? a.textContent : ''`), "the look-up in the panel");
  check(/Older than the installed 2026\.11v1/.test(ask) && /can't run code/.test(ask) && /Go back to 2026\.10v1/.test(ask), "looking up an older release says it is older and offers to go back to it", ask);
  await q(`document.getElementById('plugInstall').click()`);
  check(await widthIs("700px", "the older release"), "going back installs that release (its CSS is in force)", await width());
  check((await T("plugins.state")).plugins[0].version === "2026.10v1", "and the list shows its version");
  await q(`const b = [...document.querySelectorAll('#plugPanel .pl[data-id="wide"] button')].find((x) => /Remove/.test(x.textContent)); b.click(); b.click();`);
  check(await widthIs("300px", "removed"), "Remove (asked twice) takes it off the open page");
  check((await T("plugins.state")).plugins.length === 0, "and off the list");
  check((await waitFor(async () => (await pill()) === "Plugins|off" || null, "the status bar to say Plugins").catch(() => false)) !== false, "and the status bar goes back to Plugins", await pill());
  await q(`setPlug(false)`);
  await q(`setPlug(true)`);
  await waitFor(() => q(`return !!document.getElementById('plugBrowse')`), "the Browse all plugins link");
  const nTabs = (await T("tabs.list")).length;
  await q(`document.getElementById('plugBrowse').click()`);
  const browsed = await waitFor(async () => { const t = await T("tabs.list"); return t.length === nTabs + 1 ? t.find((x) => x.active) : null; }, "the store tab");
  check(browsed.url === base + "/store/#plugins", "Browse all plugins opens gitstable's list of plugins in a new tab", browsed.url);
  await T("tabs.close", { tab: browsed.id });

  // ---- one click from the plugin's own page on gitstable (the list is fetched only on gitstable, at most every 5 minutes) ----
  const listHits = async () => (await (await fetch(base + "/o/_plugin-list-hits")).json()).hits;
  await T("page.goto", { url: base + "/store/wide/" });
  const offer = await waitFor(async () => { const p = await pill(); return /^Install: /.test(p) ? p : null; }, "the install offer");
  check(/^Install: Wide page/.test(offer), "on a plugin's page on gitstable, the status bar offers to install it", offer);
  const h0 = await listHits();
  await T("page.goto", { url: `http://localhost:${port}/plugin-page` });
  await T("page.goto", { url: base + "/repositories/demo/wide/" });
  await sleep(500);
  check((await listHits()) === h0 && h0 >= 1, "the list was fetched on gitstable only, and not again within five minutes", `${h0} → ${await listHits()}`);
  check(/^Install: Wide page/.test(await pill()), "the repository's page offers it too");
  await q(`document.getElementById('plugBtn').click()`);
  const ask2 = await waitFor(() => q(`const a = document.getElementById('plugAsk'); return a ? a.textContent : ''`), "the look-up the offer started");
  check(/Wide page 2026\.11v1/.test(ask2) && /can't run code/.test(ask2) && (await T("plugins.state")).plugins.length === 0, "one click opens Plugins with it looked up, and installs nothing yet", ask2);
  await q(`document.getElementById('plugInstall').click()`);
  await waitFor(async () => (await T("plugins.state")).plugins.length === 1, "the install");
  // (Here the stand-in gitstable is on 127.0.0.1, a site this demo plugin changes, so the status bar now names it.)
  check(!/^(Install|Update)/.test(await waitFor(async () => { const p = await pill(); return /^Install/.test(p) ? null : p; }, "the offer to go")), "once installed, the page stops offering it", await pill());
  await T("plugins.remove", { id: "wide" });
  await q(`setPlug(false)`);
}
