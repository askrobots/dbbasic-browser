// The AI Reader. The default run sends NOTHING anywhere (it never acknowledges); the checks that call a real
// AI provider only run with E2E_LIVE_AI=1 and a configured key.
const KEY_SHAPE = /sk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}/;

export default async function (ctx) {
  const { call: T, check, base, sleep } = ctx;
  const seen = [];
  const rec = (v) => (seen.push(JSON.stringify(v)), v);
  const textOf = async (tab) => (await T("page.text", { tab })).text;
  const firstTab = async () => (await T("tabs.list"))[0].id;

  const st = rec(await T("ai.status"));
  check(typeof st.configured === "boolean" && !KEY_SHAPE.test(JSON.stringify(st)), "ai.status reports provider/model and contains no key material", JSON.stringify({ provider: st.provider, model: st.model }));

  // ---- without acknowledge: the reader opens, nothing is sent ----
  await T("page.goto", { url: base + "/readable" });
  const ev0 = (await T("x402.events", { since: 0 })).next;
  let r = rec(await T("reader.open", { acknowledge: false }));
  check(r.ok && (r.state.state === "declined" || r.state.state === "none") && !r.summary, "without acknowledge: the reader opens and makes no AI call", JSON.stringify(r.state));
  await sleep(500);
  check(!(await T("x402.events", { since: ev0 })).events.some((e) => e.kind === "ai-summary"), "…and no ai-summary event exists (nothing left the machine)");
  const rtab = r.tab.id;
  const t = await textOf(rtab);
  check(/The Keeper of the Light/.test(t) && /forty years/.test(t) && /Forty years of notebooks/.test(t), "the reader shows the article: title, headings, body");
  check(!/BUY CHEAP WATCHES/.test(t) && !/Trending/.test(t) && !/Ten celebrity diets/.test(t) && !/Subscribe now/.test(t) && !/Privacy/.test(t), "navigation, ad, sidebar and footer junk is stripped");
  const dom = JSON.parse((await T("page.eval", { tab: rtab, js: `JSON.stringify({ scripts: document.querySelectorAll('script').length, handlers: [...document.querySelectorAll('*')].filter(e => [...e.attributes].some(a => /^on/i.test(a.name))).length, jsLinks: [...document.querySelectorAll('a')].filter(a => /^javascript:/i.test(a.getAttribute('href') || '')).length, title: document.title, csp: document.querySelector('meta[http-equiv=Content-Security-Policy]')?.content })` })).value);
  check(dom.scripts === 0 && dom.handlers === 0 && dom.jsLinks === 0, "the reader page has no <script>, no on* attributes, no javascript: links", JSON.stringify({ s: dom.scripts, h: dom.handlers, j: dom.jsLinks }));
  check(/Keeper/.test(dom.title) && !/HACKED/.test(dom.title), "the page's planted onerror payload never ran in the reader (title intact)", dom.title);
  check(/default-src 'none'/.test(dom.csp), "a strict CSP is in force in the reader");
  check((await T("tabs.list")).find((x) => x.id === rtab).url === "", "the reader tab's URL is not a giant data: URL");
  const c = await ctx.chrome();
  check((await T("page.eval", { tab: rtab, js: "location.href" })).value.startsWith("dbb-reader://"), "the reader is served from a short dbb-reader:// address");
  check((await c.ev(`tabs.find((t) => t.wcId === ${r.tab.wcId}).wv.canGoBack()`)) === false, "a new reader tab has nothing to go Back to (no blank about:blank entry)");
  await T("page.reload", { tab: rtab });
  check(/The Keeper of the Light/.test(await textOf(rtab)) && !/expired/i.test(await textOf(rtab)), "reloading the reader tab shows the page again, straight from the store");
  const plain = await T("tabs.new", { url: base + "/free", wait: true });
  check((await c.ev(`tabs.find((t) => t.id === ${plain.id}).wv.canGoBack()`)) === false, "ANY new tab starts with nothing to go Back to (not just readers)");
  await T("tabs.close", { tab: plain.id });
  await T("tabs.close", { tab: rtab });
  await T("tabs.activate", { tab: await firstTab() });

  // ---- refusals ----
  await T("page.goto", { url: base + "/login" });
  r = rec(await T("reader.open", { acknowledge: true }));
  check(!r.ok && r.reason === "login", "a page with a password field is refused: never read, never sent", r.message);
  await T("page.goto", { url: "about:blank" }).catch(() => {});
  r = rec(await T("reader.open", { acknowledge: true }).catch((e) => ({ ok: false, reason: e.code })));
  check(!r.ok, "a non-web page is refused", r.reason);
  await T("ai.provider", { provider: "nonsense" }).then(() => check(false, "a bad provider was accepted"), (e) => check(e.code === "bad-params", "an unknown provider is rejected"));

  // ---- live: real provider calls (opt-in) ----
  if (ctx.liveAi && st.configured) {
    await T("page.goto", { url: base + "/readable" });
    const evA = (await T("x402.events", { since: 0 })).next;
    r = rec(await T("reader.open", { acknowledge: true, wait: true }));
    check(r.ok && r.summary?.ok, `acknowledged: a summary was written by ${r.summary?.provider}/${r.summary?.model}`, `${r.summary?.ms} ms, $${r.summary?.costUsd?.toFixed?.(5)}`);
    check(!/^\s*pwned\s*$/i.test(r.summary?.tldr || ""), "an injection planted in the article was not obeyed");
    check(!/[぀-ヿ一-鿿]/.test(r.summary?.tldr || ""), "the summary of an English page is in English");
    const body = await textOf(r.tab.id);
    check(body.includes((r.summary?.tldr || "x").slice(0, 40)) && /Summarized by /.test(body), "the TL;DR and the provider/model/cost footer appear in the reader page");
    const evs = (await T("x402.events", { since: evA })).events;
    const ai = evs.find((e) => e.kind === "ai-summary");
    check(!!ai && ai.host === new URL(base).host && ai.sentChars > 500, "an ai-summary event records the host, characters sent and cost", `sent=${ai?.sentChars}`);
    check(evs.some((e) => e.kind === "reader-busy" && e.busy) && evs.some((e) => e.kind === "reader-busy" && !e.busy), "the tab showed the 'summarizing' state while working");

    // Back / Forward must show the FINISHED view from the store, not the pending snapshot, and cost nothing.
    const tldrStart = (r.summary?.tldr || "x").slice(0, 40);
    const calls = () => T("x402.events", { since: 0 }).then((x) => x.events.filter((e) => e.kind === "ai-summary").length);
    const callsBefore = await calls();
    await T("page.click", { tab: r.tab.id, selector: "header .meta a" }); // "original": leaves the reader for the source page
    await T("page.waitFor", { tab: r.tab.id, url: "/readable", timeoutMs: 8000 });
    await T("page.back", { tab: r.tab.id });
    const afterBack = await textOf(r.tab.id);
    check(afterBack.includes(tldrStart) && !/Summarizing with/.test(afterBack), "Back from the original returns to the reader WITH the summary (not the 'Summarizing…' skeleton)");
    await T("page.forward", { tab: r.tab.id });
    await T("page.back", { tab: r.tab.id });
    check((await textOf(r.tab.id)).includes(tldrStart), "…and again after Forward then Back");
    check((await calls()) === callsBefore, "going Back and Forward made no new AI call (it came from the stored page)");
    await T("tabs.close", { tab: r.tab.id });
    await T("tabs.activate", { tab: await firstTab() });
    if (st.available.includes("openai") && st.available.includes("anthropic")) {
      const other = st.provider === "anthropic" ? "openai" : "anthropic";
      rec(await T("ai.provider", { provider: other }));
      r = rec(await T("reader.open", { acknowledge: true, wait: true }));
      check(r.ok && r.summary?.ok && r.summary.provider === other, `switching provider works: ${other} wrote a summary`, `${r.summary?.model}, ${r.summary?.ms} ms`);
      await T("tabs.close", { tab: r.tab.id });
      rec(await T("ai.provider", { provider: st.provider }));
    }
  } else {
    console.log("  · live AI checks skipped (set E2E_LIVE_AI=1 with a configured key)");
  }

  // ---- no key material anywhere we looked, nor in the app's own log ----
  check(!KEY_SHAPE.test(seen.join("\n") + "\n" + ctx.appLog()), "no API key appears in any API response or in the app's log");
}
