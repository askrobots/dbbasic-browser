// Card view, as a plugin: a view rule installed from gitstable (the stand-in, DBB_GITSTABLE) adds a button to the
// status bar on its sites; the button reads the timeline into dense cards in a tab of the browser's own. Nothing is
// built in: with no view-rule plugin there is no button and no card view. The stand-in timeline is in X's older
// layout (data-testid on every part) and loads more as its end comes into view; the plugin is X's own rule
// (askrobots/x-cards) pointed at it.
export default async function (ctx) {
  const { call: T, check, base, sleep } = ctx;
  const cdp = await ctx.chrome();
  const q = (js) => cdp.ev(`(() => { ${js} })()`);
  async function waitFor(fn, what, tries = 80) {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(150); }
    throw new Error(`timed out waiting for ${what}`);
  }
  const fails = (p) => p.then(() => null, (e) => e);
  const ev = async (js) => (await T("page.eval", { js })).value;
  // The page carries one masonry layout per column count; the window's width shows one. Cards in the one shown:
  const VIS = "[...document.querySelectorAll('main .m')].filter((m) => getComputedStyle(m).display !== 'none').flatMap((m) => [...m.querySelectorAll('.card')])";
  const viewBtns = () => q(`return [...document.querySelectorAll('#viewBtns .viewBtn')].map((b) => b.dataset.plugin + '|' + b.textContent.trim() + '|' + (b.querySelector('svg') ? 'icon' : 'no-icon'))`);

  // ---- nothing built in ----
  await T("page.goto", { url: base + "/timeline" });
  const src = (await T("tabs.list")).find((t) => t.active);
  check((await viewBtns()).length === 0, "with no view-rule plugin installed there is no card view button");
  const none = await T("cards.open", {});
  check(!none.ok && none.reason === "no-rule", "and no card view: it says to find a plugin", none.message);
  check((await T("cards.for", {})).views.length === 0, "and none is offered for this site");

  // ---- install the plugin ----
  const pv = await T("plugins.preview", { source: "demo/cards" });
  check(/adds a Cards button to the status bar on 127\.0\.0\.1/.test(pv.says) && pv.powers.join() === "read-posts", "looking it up says it adds a button, reads posts and can't run code or send anything", pv.says);
  const sneaky = await fails(T("plugins.preview", { source: "demo/cards-sneaky" }));
  check(sneaky?.code === "not-view-only", "a view rule asking for a page's markup is refused", sneaky?.message);
  await T("plugins.install", { token: pv.token });
  const btn = await waitFor(async () => { const b = await viewBtns(); return b.length ? b : null; }, "the plugin's button");
  check(btn.join() === "cards|Cards|icon", "installed, it puts its button in the status bar on its sites, with the icon it named", btn.join());
  check((await T("cards.for", {})).views.map((v) => v.id).join() === "cards", "and the card view is offered for this site");

  // ---- the button ----
  await q(`document.querySelector('#viewBtns .viewBtn').click()`);
  const tab = await waitFor(async () => { const t = (await T("tabs.list")).find((t) => t.active); return t && /^dbb-cards:\/\//.test(t.url ?? "") ? t : null; }, "the card tab", 200);
  check(tab.id !== src.id, "clicking it reads the timeline and opens the cards in a new tab of their own", tab.url);
  const shown = await ev(`${VIS}.length`);
  check(shown >= 30, "it scrolled the timeline and gathered more posts than one screen holds", `${shown} cards`);
  check((await ev(`${VIS}[0].querySelector('.who b').textContent`)) === "Person 1" && (await ev(`${VIS}[0].querySelector('.who span').textContent`)).startsWith("@person1"), "a card shows the author and their handle");
  check((await ev(`${VIS}[0].querySelector('.stats').textContent`)) === "1 replies · 2 reposts · 1.5K likes · 99K views", "and the replies, reposts, likes and views, shortened", await ev(`${VIS}[0].querySelector('.stats').textContent`));
  check((await ev(`${VIS}[0].querySelector('.text').textContent`)) === "Post number 1 <b>not bold</b>" && (await ev("document.querySelectorAll('.text b, .text script, .text img').length")) === 0, "the page's text is shown as text, never as markup");
  check((await ev("document.querySelectorAll('script').length")) === 0, "the card page has no scripts");
  check(/1 promoted post hidden/.test(await ev("document.querySelector('details summary').textContent")) && /Person 3/.test(await ev("document.querySelector('details .card').textContent")), "the post marked as an ad is set aside, behind a line that says so");
  check((await ev(`${VIS}.some((c) => /Post number 5\\b/.test(c.textContent))`)) === true, "and a video post is not mistaken for an ad");
  const link = await ev(`${VIS}[0].querySelector('a.when').href`);
  check(link === base + "/person1/status/1001", "each card links to the post itself", link);
  check((await viewBtns()).length === 0, "on the card tab itself there is no card view button");

  // ---- More posts: read on from the same tab, shown while it scrolls ----
  await T("page.click", { selector: "header a[href$='/more']" });
  const after = await waitFor(async () => { const n = await ev(`${VIS}.length`).catch(() => 0); return n > shown ? n : null; }, "more cards");
  check(after > shown, "More posts reads further down the same timeline", `${shown} → ${after}`);
  check((await ev("location.hash")) === "#new" && /more · read at/.test(await ev("document.getElementById('new').textContent")), "and goes to the new batch, under a line saying how many more");

  // ---- switched off and removed ----
  await T("tabs.activate", { tab: src.id });
  await T("plugins.enable", { id: "cards", enabled: false });
  check(await waitFor(async () => (await viewBtns()).length === 0, "the button to go").then(() => true, () => false), "switching the plugin off takes its button away");
  await T("plugins.enable", { id: "cards", enabled: true });
  await waitFor(async () => (await viewBtns()).length === 1, "the button back");
  await T("plugins.remove", { id: "cards" });
  check(await waitFor(async () => (await viewBtns()).length === 0, "the button to go").then(() => true, () => false), "removing it takes the button away");
  const gone = await T("cards.open", {});
  check(!gone.ok && gone.reason === "no-rule", "and the card view with it");
  const bad = await T("cards.open", { rule: { v: 1, id: "x", name: "X", sites: ["127.0.0.1"], post: "article", fields: { text: { sel: "div", take: "innerHTML" } } } });
  check(!bad.ok && /refused/.test(bad.message), "a view rule passed directly is checked the same way", bad.message);
}
