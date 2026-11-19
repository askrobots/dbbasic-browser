#!/usr/bin/env node
/**
 * A small caller for the caller-supplied network layer (`net.provider`): it answers every request the browser would make
 * by fetching it with a plain HTTP client, loads one address, and prints the verdict. One file, Node 18+, no dependencies.
 *
 *   node caller-network-client.mjs --url https://example.com/ --user-agent "MyClient/1.0 (+https://me.example/about)"
 *
 * Options
 *   --url <address>          what to load (required)
 *   --user-agent <identity>  the identity this caller presents (required; the desktop browser's own is refused)
 *   --answer-timeout <ms>    how long the browser waits for each answer before giving up on it (default 20000)
 *   --settle-timeout <ms>    deadline for the page to finish loading (default 30000)
 *   --fetch-timeout <ms>     how long this client waits on a server (default 15000)
 *   --control-file <path>    where the browser published its address and token (default $DBB_CONTROL_FILE or ~/.dbbasic/control.json;
 *                            or set DBB_URL and DBB_TOKEN)
 *   --keep                   leave the caller network on when done (default: turn it off again)
 *
 * The browser must be running with its automation interface on (DBB_CONTROL=1). Start it with
 * DBB_CALLER_NETWORK_USER_AGENT=<the same identity> and HOMEPAGE=about:blank to have it make no request of its own, not even
 * for its first page.
 *
 * What this example does not do: it does not pace itself, check what a site allows, or keep cookies. Those are the caller's
 * decisions; the browser stores no state for you. Answers that carry Set-Cookie have it dropped.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: {
    url: { type: "string" },
    "user-agent": { type: "string" },
    "answer-timeout": { type: "string", default: "20000" },
    "settle-timeout": { type: "string", default: "30000" },
    "fetch-timeout": { type: "string", default: "15000" },
    "control-file": { type: "string" },
    keep: { type: "boolean", default: false },
  },
});
if (!o.url || !o["user-agent"]) {
  console.error('usage: caller-network-client.mjs --url <address> --user-agent "<identity>" [options]  (see the top of this file)');
  process.exit(2);
}

// ---- how to reach the browser ----
let url = process.env.DBB_URL;
let token = process.env.DBB_TOKEN;
if (!url || !token) {
  const file = o["control-file"] || process.env.DBB_CONTROL_FILE || join(homedir(), ".dbbasic", "control.json");
  try {
    ({ url, token } = JSON.parse(readFileSync(file, "utf8")));
  } catch {
    console.error(`cannot read ${file}: is the browser running with DBB_CONTROL=1?`);
    process.exit(1);
  }
}
let n = 0;
async function call(method, params = {}) {
  const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ id: ++n, method, params }) });
  const body = await res.json();
  if (!body.ok) throw Object.assign(new Error(`${body.error?.code}: ${body.error?.message}`), { code: body.error?.code });
  return body.result;
}

// ---- answering requests ----
const NOT_FORWARDED = new Set(["host", "content-length", "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "expect", "proxy-connection", "accept-encoding", "cookie"]);

/** A reason from the shared list, from what went wrong while fetching. */
function kindOf(err) {
  const code = err?.cause?.code ?? err?.code ?? "";
  if (err?.name === "TimeoutError" || /TIMEDOUT|TIMEOUT/.test(code)) return "timed-out";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "could-not-find-site";
  if (/^ECONN|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT/.test(code)) return "could-not-connect";
  if (/CERT|SSL|TLS|DEPTH_ZERO|UNABLE_TO_VERIFY/.test(code)) return "certificate";
  return "other";
}

async function answer(r) {
  try {
    const target = new URL(r.url);
    if (!/^https?:$/.test(target.protocol)) throw Object.assign(new Error("not an http(s) address"), { code: "UNSUPPORTED" });
    const headers = Object.fromEntries(Object.entries(r.headers).filter(([k]) => !NOT_FORWARDED.has(k.toLowerCase())));
    headers["user-agent"] = o["user-agent"];
    const res = await fetch(target, {
      method: r.method,
      headers,
      redirect: "manual", // a redirect goes back to the page, which asks again, so every hop comes through here
      signal: AbortSignal.timeout(Number(o["fetch-timeout"])),
      ...(r.bodyBase64 ? { body: Buffer.from(r.bodyBase64, "base64") } : {}),
    });
    const body = Buffer.from(await res.arrayBuffer());
    const outHeaders = {};
    res.headers.forEach((v, k) => (outHeaders[k] = v));
    await call("net.answer", { id: r.id, status: res.status, statusText: res.statusText, headers: outHeaders, bodyBase64: body.toString("base64") });
    log(`${res.status} ${r.method} ${r.url}`);
  } catch (e) {
    if (e.code === "no-request") return; // the browser gave up on it first
    log(`refused ${r.url}: ${e.message}`);
    await call("net.fail", { id: r.id, kind: kindOf(e), detail: String(e.message).slice(0, 200) }).catch(() => {});
  }
}
const log = (s) => console.error(`[caller] ${s}`);

// ---- run ----
let stop = false;
const state = await call("net.provider", { enabled: true, userAgent: o["user-agent"], answerTimeoutMs: Number(o["answer-timeout"]) });
log(`caller network on (identity ${state.userAgent}, bound ${state.answerTimeoutMs} ms)`);

const loop = (async () => {
  let after = 0;
  while (!stop) {
    let requests = [];
    try {
      ({ requests } = await call("net.pending", { afterId: after, waitMs: 1000 }));
    } catch (e) {
      log(`waiting for the browser: ${e.message}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    for (const r of requests) {
      after = Math.max(after, r.id);
      void answer(r);
    }
  }
})();

let code = 0;
try {
  const loaded = await call("page.goto", { url: o.url, settle: { timeoutMs: Number(o["settle-timeout"]) } });
  console.log(JSON.stringify(loaded.settle, null, 2));
  if (!loaded.settle.settled || loaded.settle.outcome !== "ok") code = 3;
} catch (e) {
  console.error(e.message);
  code = 1;
} finally {
  stop = true;
  await loop;
  if (!o.keep) await call("net.provider", { enabled: false }).catch(() => {});
}
process.exit(code);
