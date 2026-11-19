// Touches the real internet (opt-in: E2E_LIVE_NET=1). askrobots.com runs an Anubis bot check on signed-out
// searches: a browser that mishandles redirects or cookies lands on the home page or gets stuck on the challenge.
export default async function (ctx) {
  const { call: T, check, sleep } = ctx;
  await T("page.goto", { url: "https://askrobots.com/" });
  const href = async () => (await T("page.eval", { js: "location.href" })).value;
  check(!(await href()).includes(".within.website"), "the home page loads and the address is clean", await href());

  // The FIRST click from a brand-new profile (no pass cookie yet) on the sample search.
  await T("page.click", { selector: 'a[href*="q=python+tutorial"]' });
  await T("page.waitFor", { url: "/dashboard/search/", timeoutMs: 30000 }).catch(() => {});
  await sleep(1500);
  const h = await href();
  const tab = (await T("tabs.list"))[0];
  check(h.includes("/dashboard/search/") && h.includes("python"), "the FIRST click lands on the RESULTS, not the home page", h.slice(0, 100));
  check(tab.url === h, "the address bar equals the page's real location", tab.url.slice(0, 100));
  check(!h.includes(".within.website") && !tab.url.includes("pass-challenge"), "no challenge URL is left in the address bar");
  const txt = (await T("page.text")).text || "";
  check(/python/i.test(txt) && txt.length > 500, "the results page has content", `${txt.length} chars`);

  await T("page.goto", { url: "https://askrobots.com/dashboard/search/?q=houston+weather" });
  const h2 = await href();
  check(h2.includes("/dashboard/search/") && h2.includes("houston"), "a second search needs no new challenge (the pass cookie persisted)", h2.slice(0, 90));
}
