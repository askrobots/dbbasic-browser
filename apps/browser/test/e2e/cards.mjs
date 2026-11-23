// Card view: a timeline read into dense cards in a tab of the browser's own. Uses the built-in X view rule pointed at
// a stand-in timeline on the demo server (X's older layout: data-testid on every part, more posts as you scroll).
export default async function (ctx) {
  const { call: T, check, base, sleep } = ctx;
  const fails = (p) => p.then(() => null, (e) => e);
  async function waitFor(fn, what, tries = 80) {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(150); }
    throw new Error(`timed out waiting for ${what}`);
  }
  const ev = async (js) => (await T("page.eval", { js })).value;

  const { rules } = await T("cards.rules");
  const x = rules.find((r) => r.id === "x-cards");
  check(!!x && x.sites.includes("x.com"), "the built-in view rule for X is there", JSON.stringify(rules.map((r) => r.id)));
  const rule = { ...x, sites: ["127.0.0.1"] };

  await T("page.goto", { url: base + "/timeline" });
  const src = (await T("tabs.list")).find((t) => t.active);
  const r = await T("cards.open", { rule, want: 30, rounds: 8 });
  check(r.ok && r.posts >= 30 && r.promoted === 1, "reading a timeline scrolls it and gathers more posts than one screen holds, with the promoted one set aside", JSON.stringify(r));
  const tab = await waitFor(async () => { const t = (await T("tabs.list")).find((t) => t.active); return t && /^dbb-cards:\/\//.test(t.url ?? "") ? t : null; }, "the card tab");
  check(tab.id !== src.id, "the cards open in a new tab of their own", tab.url);

  const shown = await ev("document.querySelectorAll('main > .card').length");
  check(shown === r.posts, "every post is a card", `${shown} cards, ${r.posts} posts`);
  check((await ev("document.querySelector('main > .card .who b').textContent")) === "Person 1" && (await ev("document.querySelector('main > .card .who span').textContent")).startsWith("@person1"), "a card shows the author and their handle");
  check((await ev("document.querySelector('main > .card .stats').textContent")) === "1 replies · 2 reposts · 1.5K likes · 99K views", "and the replies, reposts, likes and views, shortened", await ev("document.querySelector('main > .card .stats').textContent"));
  check((await ev("document.querySelector('main > .card .text').textContent")) === "Post number 1 <b>not bold</b>" && (await ev("document.querySelectorAll('.text b, .text script, .text img').length")) === 0, "the page's text is shown as text, never as markup");
  check((await ev("document.querySelectorAll('script').length")) === 0, "the card page has no scripts");
  check(/1 promoted post hidden/.test(await ev("document.querySelector('details summary').textContent")) && (await ev("document.querySelectorAll('details .card').length")) === 1, "the promoted post is hidden, behind a line that says so");
  check(/Person 3/.test(await ev("document.querySelector('details .card').textContent")), "and it is the one marked as an ad");
  const link = await ev("document.querySelector('main > .card a.when').href");
  check(link === base + "/person1/status/1001", "each card links to the post itself", link);

  // More posts: read on from the same tab, now in the background, and land on the first new card.
  const before = shown;
  await T("page.click", { selector: "header a[href$='/more']" });
  const after = await waitFor(async () => { const n = await ev("document.querySelectorAll('main > .card').length").catch(() => 0); return n > before ? n : null; }, "more cards").catch(async (e) => {
    const t = (await T("tabs.list")).find((t) => t.active);
    const st = (await T("page.eval", { tab: src.id, js: "scrollY + ' / ' + document.body.scrollHeight + ' posts ' + document.querySelectorAll('article').length + ' ' + document.visibilityState" }).catch((x) => ({ value: x.message }))).value;
    throw new Error(`${e.message}; active tab ${t?.url}; cards ${await ev("document.querySelectorAll('main > .card').length").catch((x) => x.message)}; source ${st}`);
  });
  check(after > before, "More posts reads further down the same timeline, from a tab in the background", `${before} → ${after}`);
  check((await ev("location.hash")) === "#new" && !!(await ev("document.getElementById('new') && document.getElementById('new').textContent")), "and goes to the first new card");

  // Refusals.
  const bad = await T("cards.open", { tab: src.id, rule: { ...rule, fields: { text: { sel: "div", take: "innerHTML" } } } });
  check(!bad.ok && /refused/.test(bad.message), "a view rule asking for anything but plain text and addresses is refused", bad.message);
  await T("tabs.activate", { tab: src.id });
  await T("page.goto", { url: base + "/free" });
  const none = await T("cards.open", {});
  check(!none.ok && none.reason === "no-rule", "a site with no view rule says so", none.message);
  const gone = await fails(T("cards.open", { tab: 99999 }));
  check(!!gone, "an unknown tab is an error");
}
