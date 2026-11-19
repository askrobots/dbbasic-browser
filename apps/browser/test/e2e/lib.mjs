// Shared helpers for the end-to-end suites. A suite is `export default async (ctx) => { … }`.
//
//   ctx.call(method, params)   JSON-RPC to the browser's automation API (throws {code} on error)
//   ctx.check(cond, msg, more) record a pass/fail
//   ctx.base                   the demo server origin, e.g. http://127.0.0.1:54321
//   ctx.chrome()               a CDP session on the browser's own UI (for checking what the chrome renders)
//   ctx.sleep(ms)
//   ctx.liveAi                 true when E2E_LIVE_AI=1 (checks that call a real AI provider)

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeCtx({ url, token, debugPort, controlPort, base, tmp, vaultMaster, liveAi, log }) {
  const counts = { pass: 0, fail: 0 };
  const sessions = [];

  async function call(method, params = {}) {
    const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
    const body = await res.json();
    if (!body.ok) throw Object.assign(new Error(`${body.error?.code}: ${body.error?.message}`), { code: body.error?.code });
    return body.result;
  }

  function check(cond, msg, more = "") {
    counts[cond ? "pass" : "fail"]++;
    console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${msg}${more ? `  → ${more}` : ""}`);
    return !!cond;
  }

  /** Chrome DevTools Protocol on the browser's own UI document (not on a page). */
  async function chrome() {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pend = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); pend.get(d.id)?.(d); };
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = (expr) => send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }).then((d) => d.result?.result?.value);
    const s = { send, ev, close: () => ws.close() };
    sessions.push(s);
    return s;
  }

  return {
    call, check, chrome, sleep, base, tmp, vaultMaster, liveAi, counts, controlUrl: url, controlToken: token, controlPort,
    appLog: () => (log || []).join(""),
    close: async () => { for (const s of sessions) { try { s.close(); } catch {} } },
  };
}

/** Navigate without waiting and record every distinct tab state until `ms` elapsed. */
export async function traceStates(ctx, url, ms, tab) {
  const seen = [];
  const t0 = Date.now();
  const nav = ctx.call("page.goto", { url, wait: false, ...(tab ? { tab } : {}) }).catch(() => {});
  while (Date.now() - t0 < ms) {
    const t = (await ctx.call("tabs.list")).find((x) => (tab ? x.id === tab : x.active));
    const s = t?.state ?? "idle";
    if (seen[seen.length - 1] !== s) seen.push(s);
    await sleep(40);
  }
  await nav;
  return seen;
}
