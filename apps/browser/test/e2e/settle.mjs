// "Has the page finished loading?" — the verdict says whether it settled, which rule ended the wait, and what
// actually happened. Every case here is a page that fools a timeout or a "network quiet" guess.
export default async function (ctx) {
  const { call: T, check, base } = ctx;
  const settle = (url, opts = {}) => T("page.goto", { url, settle: opts }).then((r) => r.settle);
  const quick = { frameTimeoutMs: 1500 };

  // ---- the plain case, and the shape of the answer ----
  let v = await settle(base + "/free");
  check(v.settled === true && v.outcome === "ok" && v.status === 200, "an ordinary page settles: outcome ok, status 200", `${v.rule} in ${v.waitedMs} ms`);
  check(v.rule === "frames-match", "…and it says WHICH rule ended the wait (two identical frames)", v.rule);
  check(v.final.url === base + "/free" && v.requests >= 1 && v.bytes > 0 && v.hosts.includes(new URL(base).host), "…and returns facts about the load: final URL, requests, bytes, hosts", `${v.requests} req, ${v.bytes} B`);
  check(v.waitedMs < 3000, "…without waiting longer than it needs to", `${v.waitedMs} ms`);
  v = await settle(base + "/free", { frames: false });
  check(v.settled && v.rule === "quiet", "with the frame test off, it settles by 'quiet'", v.rule);

  // ---- redirects are part of the facts ----
  v = await settle(base + "/redir/chain");
  check(v.settled && v.status === 200 && v.final.url === base + "/free" && v.redirects.length === 2, "a redirect chain: the final URL, its status (200, not the first hop's 302) and each hop are reported", v.redirects.map((r) => `${r.status}→${r.to.replace(base, "")}`).join(", "));

  // ---- console and cookie facts ----
  v = await settle(base + "/console", quick);
  check(v.console?.counts?.error === 25 && v.console.counts.warning === 1 && v.console.counts.info === 1, "console messages are counted by level", JSON.stringify(v.console?.counts));
  check(v.console?.errors?.length === 20 && v.console.errors[0].text.startsWith("error 0 ") && v.console.errors.every((e) => e.text.length <= 200), "…the first 20 errors are kept, each cut to 200 characters", `${v.console?.errors?.length} kept, longest ${Math.max(...(v.console?.errors ?? []).map((e) => e.text.length))}`);
  const named = (n) => v.cookies?.find((c) => c.name === n);
  check(named("visitor")?.httpOnly === true && named("visitor")?.session === true && named("js")?.httpOnly === false, "cookies at the verdict are listed with name, domain, path and flags", JSON.stringify(v.cookies));
  check(!JSON.stringify(v).includes("SECRET-VALUE-123"), "…and no cookie value appears anywhere in the verdict");
  v = await settle(base + "/free", quick);
  check(v.console.counts.error === 0 && v.console.errors.length === 0, "the next visit starts with an empty console record");

  // ---- the blank test ----
  v = await settle(base + "/tiny", quick);
  check(v.settled && v.outcome === "blank", "a tiny page (under 20 characters of text) is 'blank' by default", v.outcome);
  v = await settle(base + "/tiny", { ...quick, minText: 0 });
  check(v.settled && v.outcome === "ok", "…with minText 0 the same page is ok", v.outcome);
  v = await settle(base + "/late-text", quick);
  check(v.settled && v.outcome === "blank" && v.waitedMs < 2500, "a page that draws late settles as blank before it draws, by default", `${v.outcome} at ${v.waitedMs} ms`);
  v = await settle(base + "/late-text", { ...quick, blankWaitMs: 6000 });
  check(v.settled && v.outcome === "ok" && v.waitedMs >= 2400, "with blankWaitMs it keeps waiting while blank, and settles ok once the text is drawn", `${v.outcome} at ${v.waitedMs} ms`);
  v = await settle(base + "/blank", { ...quick, blankWaitMs: 1500 });
  check(v.settled && v.outcome === "blank" && v.waitedMs >= 1400, "a page that stays blank is still reported blank, and the wait is in waitedMs", `${v.outcome} at ${v.waitedMs} ms`);

  // ---- a page that moves itself after loading ----
  v = await settle(base + "/free");
  check(Array.isArray(v.moves) && v.moves.length === 0, "an ordinary page reports no client-side moves");
  const slowQuiet = { quietMs: 1500 };
  v = await settle(base + "/moves-js", slowQuiet);
  check(v.settled && v.final.url === base + "/free", "a page that moves itself (script): the wait restarts and settles on the page it ended up on", v.final.url.replace(base, ""));
  check(v.moves.length === 1 && v.moves[0].to === base + "/redir/chain", "…the PAGE's own move is reported, separately from…", JSON.stringify(v.moves.map((m) => [m.to.replace(base, ""), m.afterMs])));
  check(v.redirects.length === 2 && v.redirects.every((r) => r.status === 301 || r.status === 302), "…the server redirects it then went through (two hops)", v.redirects.map((r) => r.status).join(","));
  v = await settle(base + "/moves-meta", slowQuiet);
  check(v.settled && v.final.url === base + "/free" && v.moves.length === 1, "a real <meta refresh>: also a client-side move, and the wait settles on the final page", `${v.moves.length} move(s), final ${v.final.url.replace(base, "")}`);

  // ---- pages that fool a guess ----
  const t0 = Date.now();
  v = await settle(base + "/slow?ms=1500");
  check(v.settled && v.outcome === "ok" && Date.now() - t0 >= 1500 && v.bytes > 5000, "a page whose body trickles in is not called finished early", `${v.waitedMs} ms, ${v.bytes} B`);

  v = await settle(base + "/stream-open");
  check(v.settled && v.outcome === "ok" && v.streams >= 1, "a finished page holding an event stream open still settles (the stream is ignored and reported)", `streams=${v.streams}, ${v.rule}`);

  v = await settle(base + "/late");
  const decoded = (await T("page.eval", { js: "[...document.images].every((i) => i.complete && i.naturalWidth > 0) && document.images.length" })).value;
  check(v.settled && v.waitedMs >= 1700 && decoded >= 1, "content added AFTER the load event: it waits for the late image to arrive and decode", `${v.waitedMs} ms, ${decoded} image(s) decoded`);

  v = await settle(base + "/animated", quick);
  check(v.settled === true && v.rule === "animating" && v.animating === true && v.outcome === "ok", "a page that never stops moving settles as 'animating' instead of waiting for the deadline", `${v.rule} in ${v.waitedMs} ms`);

  // ---- what actually happened ----
  v = await settle(base + "/blank", quick);
  check(v.settled && v.outcome === "blank", "a loaded page with nothing on it is reported as 'blank'", v.outcome);
  v = await settle(base + "/status/404", quick);
  check(v.settled && v.outcome === "error-status" && v.status === 404, "an error status is an outcome, with the number", `${v.outcome} ${v.status}`);
  v = await settle(base + "/status/429", quick);
  check(v.outcome === "error-status" && v.status === 429 && v.slowDown === true, "HTTP 429 is flagged: the site says slow down", `slowDown=${v.slowDown}`);
  v = await settle(base + "/status/500", quick);
  check(v.outcome === "error-status" && v.status === 500, "HTTP 500 is reported with its number", `${v.status}`);

  v = await settle(base + "/download");
  check(v.outcome === "not-a-page" && v.rule === "download" && v.download === "hello-report.txt", "an address that is a download is 'not-a-page', and names the file", `${v.outcome} (${v.download})`);

  await T("x402.approval", { mode: "deny" });
  v = await settle(base + "/premium");
  await T("x402.approval", { mode: "ask", maxUsd: 0 });
  check(v.outcome === "payment-required" && v.rule === "payment", "a payment request that was refused ends the wait as 'payment-required'", `${v.outcome}/${v.rule}`);

  // ---- failures say why ----
  v = await settle(base + "/fail", quick);
  check(v.settled === false && v.outcome === "failed" && v.failure.kind === "could-not-connect", "a dropped connection: failed, 'could-not-connect'", `${v.failure?.kind} (${v.failure?.description})`);
  v = await settle("http://nonexistent-host.invalid/", quick);
  check(v.outcome === "failed" && v.failure.kind === "could-not-find-site", "an unknown host: failed, 'could-not-find-site'", `${v.failure?.kind} (${v.failure?.description})`);
  v = await settle(base + "/redir/loop", quick);
  check(v.outcome === "failed" && v.failure.kind === "redirect-loop", "a redirect loop: failed, 'redirect-loop'", `${v.failure?.kind} (${v.failure?.description})`);

  // ---- the deadline: always returns, and says what was still unmet ----
  const d0 = Date.now();
  v = await settle(base + "/hang", { timeoutMs: 2500, ...quick });
  const took = Date.now() - d0;
  check(v.settled === false && v.outcome === "deadline" && v.rule === "deadline", "a request that never answers: the deadline ends the wait", `${v.outcome}/${v.rule}`);
  check(v.blockedBy?.[0]?.rule === "network" && /\/hang/.test(v.blockedBy[0].detail), "…and names what was still unmet: the request that never answered", v.blockedBy?.[0]?.detail?.slice(0, 80));
  check(took < 2500 + 4000, "…and the call returns promptly after the deadline (it cannot hang)", `${took} ms`);
  await T("page.goto", { url: base + "/free" });

  // ---- page.settle on an already-loaded page ----
  v = await T("page.settle", {});
  check(v.settled && v.outcome === "ok", "page.settle works on its own on a loaded page", v.rule);
}
