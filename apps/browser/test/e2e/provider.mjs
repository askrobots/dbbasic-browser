// A network layer the caller supplies: the browser makes no request of its own; the caller answers each one.
export default async function (ctx) {
  const { call: T, check, base, sleep } = ctx;
  const UA = "ExampleCaller/1.0 (+https://caller.example/about)";
  const hits = async () => (await (await fetch(base + "/hits")).json()).hits;
  const rejects = (p) => p.then(() => null, (e) => e);

  // ---- identity comes from the caller, and only from the caller ----
  check((await rejects(T("net.provider", { enabled: true })))?.code === "bad-params", "turning it on without a userAgent is refused (identity is the caller's to give)");
  check((await rejects(T("net.provider", { enabled: true, userAgent: "dbbasic-browser/1 (+https://dbbasic.com)" })))?.code === "bad-params", "…and the desktop browser's own identity is refused");
  check((await T("net.provider")).enabled === false, "it is off by default");

  // ---- the caller: answers by fetching for real, unless told otherwise ----
  let stop = false;
  const seen = [];
  const rules = []; // [(path) => bool, async (req) => void]
  const answerByFetching = async (r) => {
    const res = await fetch(r.url, { method: r.method, headers: r.headers, redirect: "manual", ...(r.bodyBase64 ? { body: Buffer.from(r.bodyBase64, "base64") } : {}) });
    const body = Buffer.from(await res.arrayBuffer());
    await T("net.answer", { id: r.id, status: res.status, headers: Object.fromEntries(res.headers), bodyBase64: body.toString("base64") });
  };
  const handle = async (r) => {
    try {
      const path = new URL(r.url).pathname;
      const rule = rules.find(([m]) => m(path));
      if (rule) await rule[1](r);
      else await answerByFetching(r);
    } catch (e) {
      if (!/no-request|no request/.test(String(e.message))) console.error("caller error:", e.message);
    }
  };
  const loop = (async () => {
    let after = 0;
    while (!stop) {
      let reqs = [];
      try { reqs = (await T("net.pending", { afterId: after, waitMs: 400 })).requests; } catch { await sleep(200); }
      for (const r of reqs) { after = Math.max(after, r.id); seen.push(r); void handle(r); }
    }
  })();

  const st = await T("net.provider", { enabled: true, userAgent: UA, answerTimeoutMs: 3000 });
  check(st.enabled === true && st.userAgent === UA && st.answerTimeoutMs === 3000, "turned on with the caller's identity and its own bound", JSON.stringify(st));
  const settle = (url, opts = {}) => T("page.goto", { url, settle: { frameTimeoutMs: 1500, ...opts } }).then((r) => r.settle);

  // ---- an ordinary load, answered by the caller ----
  let v = await settle(base + "/free");
  check(v.settled && v.outcome === "ok" && v.status === 200, "a page loads from the caller's answers", `${v.rule} in ${v.waitedMs} ms`);
  const doc = seen.find((r) => new URL(r.url).pathname === "/free" && r.navigate);
  check(!!doc && doc.headers["user-agent"] === UA, "the request was handed over as a navigation, carrying the caller's identity", doc && doc.headers["user-agent"]);
  check((await T("page.eval", { js: "navigator.userAgent" })).value === UA, "…and the page itself sees the caller's identity, not the desktop browser's");
  v = await settle(base + "/headers");
  const sent = JSON.parse((await T("page.text")).text);
  check(sent["user-agent"] === UA && !/dbbasic/i.test(sent["user-agent"]), "the server saw the caller's identity, with nothing of the desktop browser's", sent["user-agent"]);

  // ---- every hop of a redirect is the caller's decision ----
  seen.length = 0;
  v = await settle(base + "/redir/chain");
  const hops = seen.filter((r) => r.navigate).map((r) => new URL(r.url).pathname);
  check(v.settled && v.final.url === base + "/free" && v.redirects.length === 2, "a redirect chain: final address and both hops reported", v.redirects.map((r) => r.status).join(","));
  check(hops.length === 3 && hops[0] === "/redir/chain" && hops[2] === "/free", "…and each hop was a separate request to the caller", hops.join(" → "));

  // ---- a request that follows a page says which page ----
  seen.length = 0;
  v = await settle(base + "/late");
  const sub = seen.find((r) => !r.navigate);
  check(!!sub && sub.follows.startsWith(base + "/late"), "a page's own request says which page it follows", sub && `${new URL(sub.url).pathname} follows ${sub.follows.replace(base, "")}`);

  // ---- a refusal ends the load with the caller's reason ----
  rules.push([(p) => p === "/refuse", (r) => T("net.fail", { id: r.id, kind: "blocked", detail: "the site's rules disallow this" })]);
  let h0 = await hits();
  v = await settle(base + "/refuse");
  check(v.outcome === "failed" && v.failure?.kind === "blocked" && v.failure?.source === "caller", "a refusal: failed, kind 'blocked', source 'caller'", JSON.stringify(v.failure));
  check(v.failure?.description === "the site's rules disallow this", "…with the caller's own words", v.failure?.description);
  check((await hits()) === h0, "…and the refused request never reached the server (the browser makes none of its own)");
  check((await rejects(T("net.fail", { id: 999999, kind: "blocked" })))?.code === "no-request", "refusing an unknown request is 'no-request'");
  check((await rejects(T("net.answer", { id: 999999, status: 200 })))?.code === "no-request", "answering an unknown request is 'no-request'");

  // ---- the caller that never answers: its own bound, its own reason ----
  rules.push([(p) => p === "/silent", () => {}]);
  const t0 = Date.now();
  v = await settle(base + "/silent", { timeoutMs: 30000 });
  check(v.outcome === "failed" && v.failure?.kind === "caller-silent" && v.failure?.source === "observed", "no answer: failed with its own reason 'caller-silent' (not 'timed-out')", JSON.stringify(v.failure));
  check(Date.now() - t0 >= 2800 && Date.now() - t0 < 9000 && v.waitedOnCallerMs >= 2000, "…after the caller's bound (3 s), and the wait is reported apart", `${Date.now() - t0} ms, ${v.waitedOnCallerMs} ms on the caller`);

  // ---- waiting on the caller never trips the settle deadline ----
  await T("net.provider", { answerTimeoutMs: 15000 });
  rules.push([(p) => p === "/deliberate", async (r) => { await sleep(2500); await answerByFetching({ ...r, url: base + "/free" }); }]);
  v = await settle(base + "/deliberate", { timeoutMs: 1000 });
  check(v.settled === true && v.outcome === "ok" && v.rule !== "deadline", "waiting on the caller (2.5 s) does not trip a 1 s deadline", `${v.rule}, waited ${v.waitedMs} ms, ${v.waitedOnCallerMs} ms on the caller`);
  check(v.waitedOnCallerMs >= 2000, "…and says how long it waited on the caller", `${v.waitedOnCallerMs} ms`);

  // ---- a document the caller already fetched ----
  seen.length = 0;
  const html = '<!doctype html><title>Prefetched</title><body style="font:18px system-ui;padding:40px"><h1>Already fetched</h1><a id="l" href="next">next</a> <img src="pic.png" width="8" height="8">';
  v = (await T("page.load", { url: base + "/prefetched/dir/page", status: 200, headers: { "content-type": "text/html; charset=utf-8" }, bodyText: html, redirects: [{ status: 301, to: base + "/prefetched/dir/page" }, { status: 302, to: base + "/prefetched/dir/page" }], settle: { frameTimeoutMs: 1500 } })).settle;
  check(v.settled && v.status === 200 && v.final.url === base + "/prefetched/dir/page", "an already-fetched document loads at its own address with its status", `${v.status} ${v.final.url.replace(base, "")}`);
  check((await T("page.eval", { js: "document.querySelector('#l').href" })).value === base + "/prefetched/dir/next", "…relative links resolve against that address");
  check(v.redirects.length === 2 && v.redirects[0].status === 301, "…and the facts list the redirects that led to it, though the browser never saw them", v.redirects.map((r) => r.status).join(","));
  check(!seen.some((r) => r.navigate && new URL(r.url).pathname === "/prefetched/dir/page"), "…without asking the caller for the document again");
  check(seen.some((r) => new URL(r.url).pathname === "/prefetched/dir/pic.png"), "…while the page's own subresources still go to the caller", seen.map((r) => new URL(r.url).pathname).join(","));
  check((await rejects(T("page.load", { url: base + "/x", status: 7, bodyText: "x" })))?.code === "bad-params", "a bad document is refused up front");

  // ---- turning it off puts everything back ----
  stop = true;
  await T("net.provider", { enabled: false });
  await loop;
  check((await T("net.provider")).enabled === false, "turned off");
  await T("page.goto", { url: base + "/free" });
  check(/dbbasic-browser\/\S+ \(\+https:\/\/dbbasic\.com\)$/.test((await T("page.eval", { js: "navigator.userAgent" })).value), "the desktop browser's own identity is restored, and it fetches for itself again");
}
