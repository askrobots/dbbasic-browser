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
 *   --max-bytes <n>          largest response it will hand over (default 8388608); bigger ones are refused
 *   --min-gap-ms <ms>        least time between two page loads from the same host (default 1000); page assets are not paced
 *   --allow-private          also fetch loopback, local-network and link-local addresses (default: refused, since a page can ask for
 *                            any address, including your own machine and your network's metadata service)
 *   --control-file <path>    where the browser published its address and token (default $DBB_CONTROL_FILE or ~/.dbbasic/control.json;
 *                            or set DBB_URL and DBB_TOKEN)
 *   --keep                   leave the caller network on when done (default: turn it off again)
 *
 * The browser must be running with its automation interface on (DBB_CONTROL=1). Start it with
 * DBB_CALLER_NETWORK_USER_AGENT=<the same identity> and HOMEPAGE=about:blank to have it make no request of its own, not even
 * for its first page.
 *
 * What it does not do: check what a site allows, or keep cookies. Those are the caller's decisions; the browser stores no state for
 * you, and Set-Cookie in an answer is dropped. The private-address check is advisory: the name is resolved once to check it and again
 * to connect, so a hostile name server could differ between the two; a firewall rule is the real guarantee.
 */
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
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
    "max-bytes": { type: "string", default: "8388608" },
    "min-gap-ms": { type: "string", default: "1000" },
    "allow-private": { type: "boolean", default: false },
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
  // A call that gets no answer must not hang this script for ever: the browser answers every call, so 90 s means something is wrong.
  const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(90_000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ id: ++n, method, params }) });
  const body = await res.json();
  if (!body.ok) throw Object.assign(new Error(`${body.error?.code}: ${body.error?.message}`), { code: body.error?.code });
  return body.result;
}

// ---- answering requests ----
const NOT_FORWARDED = new Set(["host", "content-length", "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "expect", "proxy-connection", "accept-encoding", "cookie"]);

/** A reason from the shared list, from what went wrong while fetching. */
function kindOf(err) {
  const code = err?.cause?.code ?? err?.code ?? "";
  if (err?.code === "PRIVATE") return "blocked";
  if (err?.name === "TimeoutError" || /TIMEDOUT|TIMEOUT/.test(code)) return "timed-out";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "could-not-find-site";
  if (/^ECONN|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT/.test(code)) return "could-not-connect";
  if (/CERT|SSL|TLS|DEPTH_ZERO|UNABLE_TO_VERIFY/.test(code)) return "certificate";
  return "other";
}

/** Loopback, private, link-local, CGNAT, unspecified and unique-local addresses. */
function isPrivate(ip) {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const x = ip.toLowerCase();
  return x === "::1" || x === "::" || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb") || x.startsWith("fc") || x.startsWith("fd");
}
async function assertPublic(host) {
  if (o["allow-private"]) return;
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addrs.some((a) => isPrivate(a.address))) throw Object.assign(new Error(`${host} is a private or local address (use --allow-private to fetch these)`), { code: "PRIVATE" });
}

// Page loads are spaced per host; a page's own files are not.
const lastLoad = new Map();
async function pace(host) {
  const gap = Number(o["min-gap-ms"]);
  const wait = (lastLoad.get(host) ?? 0) + gap - Date.now();
  lastLoad.set(host, Math.max(Date.now(), (lastLoad.get(host) ?? 0) + gap));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** Read a body, giving up past the size limit. */
async function readCapped(res, limit) {
  const chunks = [];
  let n = 0;
  for await (const c of res.body ?? []) {
    n += c.byteLength;
    if (n > limit) throw Object.assign(new Error(`response is larger than ${limit} bytes`), { code: "TOOBIG" });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function answer(r) {
  try {
    const target = new URL(r.url);
    if (!/^https?:$/.test(target.protocol)) throw Object.assign(new Error("not an http(s) address"), { code: "UNSUPPORTED" });
    await assertPublic(target.hostname.replace(/^\[|\]$/g, ""));
    if (r.navigate) await pace(target.host);
    const headers = Object.fromEntries(Object.entries(r.headers).filter(([k]) => !NOT_FORWARDED.has(k.toLowerCase())));
    headers["user-agent"] = o["user-agent"];
    const res = await fetch(target, {
      method: r.method,
      headers,
      redirect: "manual", // a redirect goes back to the page, which asks again, so every hop comes through here
      signal: AbortSignal.timeout(Number(o["fetch-timeout"])),
      ...(r.bodyBase64 ? { body: Buffer.from(r.bodyBase64, "base64") } : {}),
    });
    const body = await readCapped(res, Number(o["max-bytes"]));
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
