// What the browser is using: memory and CPU per tab, cache and disk, and which requests failed.
export default async function (ctx) {
  const { call: T, check, base, sleep } = ctx;
  const cdp = await ctx.chrome();
  const q = (js) => cdp.ev(`(() => { ${js} })()`);

  await T("page.goto", { url: base + "/free" });
  const r = await T("resources.state");
  check(r.totalMemoryMB > 50 && r.byType.browser?.memoryMB > 10 && r.byType.pages?.memoryMB > 5 && r.byType.graphics, "the status reports memory in total and by kind (pages, browser, graphics)", JSON.stringify(r.byType));
  const mine = r.tabs.find((t) => t.active);
  check(mine && mine.pid > 0 && mine.memoryMB > 10 && typeof mine.cpu === "number", "each tab has its own page process with memory and CPU", JSON.stringify(mine));
  check(typeof r.cacheBytes === "number" && r.disk.bytes > 0 && Array.isArray(r.disk.top) && r.disk.top.length > 0 && r.disk.files > 0, "it reports the cache size and what the data folder is made of", JSON.stringify({ cache: r.cacheBytes, disk: r.disk.bytes, top: r.disk.top.slice(0, 3).map((d) => d.name) }));

  // a tab that holds a lot of memory shows up as using a lot
  const before = (await T("resources.state")).tabs.find((t) => t.active).memoryMB;
  const hog = await T("tabs.new", { url: base + "/hog" });
  await sleep(1500);
  let after = 0;
  for (let i = 0; i < 20 && after < before + 200; i++) { after = ((await T("resources.state")).tabs.find((t) => t.id === (hog.id ?? hog.tab?.id)) ?? {}).memoryMB ?? 0; await sleep(300); }
  const state2 = await T("resources.state");
  const hogTab = state2.tabs.find((t) => /hog/.test(t.url));
  check(hogTab && hogTab.memoryMB > 300, "a tab that holds about 400 MB is shown holding that much", `${hogTab?.memoryMB} MB`);
  check(state2.totalMemoryMB > r.totalMemoryMB + 250, "and the total goes up with it", `${r.totalMemoryMB} → ${state2.totalMemoryMB} MB`);

  // the window shows it
  await cdp.ev(`setRes(false)`);
  await sleep(2500);
  check(await q(`return /^◔ [\\d.]+ (MB|GB)$/.test(document.getElementById('resBtn').textContent.trim())`), "the toolbar shows the total memory in use", await q(`return document.getElementById('resBtn').textContent`));
  await cdp.ev(`setRes(true)`);
  for (let i = 0; i < 40 && !(await q(`return document.querySelectorAll('#resPanel .trow').length >= 3`)); i++) await sleep(100);
  const panel = await q(`return document.getElementById('resPanel').innerText`);
  check(/what the browser is using/i.test(panel) && /tabs/i.test(panel) && /hog/i.test(panel) && /cache/i.test(panel) && /clear cache/i.test(panel) && /data folder/i.test(panel), "the panel lists every tab with its memory, the cache and the data folder", panel.replace(/\s+/g, " ").slice(0, 700));
  check(await q(`const rows = [...document.querySelectorAll('#resPanel .trow')].slice(0, 2); return /hog/i.test(rows[0].textContent)`), "the biggest tab is listed first");
  await q(`document.querySelector('#resPanel .trow .sbtn').click()`); // Close the biggest
  for (let i = 0; i < 40 && (await T("tabs.list")).some((t) => /hog/.test(t.url)); i++) await sleep(100);
  check(!(await T("tabs.list")).some((t) => /hog/.test(t.url)), "Close in the panel closes that tab");
  await cdp.ev(`setRes(false)`);

  // clearing the cache
  const cleared = await T("resources.clearCache");
  check(typeof cleared.freedBytes === "number", "the cache can be cleared and says how much it held", JSON.stringify(cleared));

  // which requests failed, named without their query
  await T("tabs.activate", {});
  const v = await T("page.goto", { url: base + "/resources?secret=abc", settle: { timeoutMs: 8000 } });
  const res = v.settle.resources;
  check(res.failedExamples?.some((f) => /127\.0\.0\.1:1\/x\.png$/.test(f.url)) && res.errorStatusExamples?.some((f) => /\/status\/404$/.test(f.url) && f.status === 404), "the load report names which requests failed and which got an error status", JSON.stringify({ failed: res.failedExamples, status: res.errorStatusExamples }));
  check(!JSON.stringify(res).includes("secret=abc"), "and leaves out their query strings");
}
