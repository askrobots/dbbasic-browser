#!/usr/bin/env node
/**
 * End-to-end suites: drive the REAL browser through its own automation API.
 *
 *   npm run e2e -w @dbbasic/browser                  # every suite
 *   npm run e2e -w @dbbasic/browser -- api states    # just those
 *   E2E_LIVE_NET=1  adds suites/checks that touch real sites (askrobots.com's bot check)
 *   E2E_LIVE_AI=1   adds checks that call the AI providers with your real keys (a few cents)
 *
 * Hermetic by construction: it picks free ports, makes a temp profile and a temp vault (seeded with the
 * demo login), runs its own copy of the demo server, and keeps its control token in the temp dir — so it
 * never touches your running browser, your real vault, or ~/.dbbasic/control.json. Each suite gets a freshly
 * launched app, so suites can't contaminate each other.
 *
 * Needs a macOS/desktop session (it opens real windows). Exit code is non-zero if any check fails.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeCtx } from "../test/e2e/lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SUITES = ["api", "ui", "transport", "states", "reader", "downloads", "settle", "provider", "escape", "example", "extensions", "forms", "chat", "mcp", "resources", "bookmarks", "keep", "omnibox", "live-net"];
const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const run = wanted.length ? wanted : SUITES;
for (const s of run) if (!SUITES.includes(s)) { console.error(`unknown suite "${s}" (have: ${SUITES.join(", ")})`); process.exit(2); }

const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); s.on("error", rej); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 40000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

// E2E_PARALLEL=n runs up to n suites at once. Each suite is its own process with its own demo server, ports, profile and vault,
// so nothing is shared; output is printed per suite when it finishes. (Costs memory: one browser per running suite.)
const parallel = Number(process.env.E2E_PARALLEL || 1);
if (parallel > 1 && run.length > 1 && process.env.E2E_CHILD !== "1") {
  const { spawn: sp } = await import("node:child_process");
  const queue = [...run];
  const results = [];
  const runOne = (name) => new Promise((resolve) => {
    if (name === "live-net" && process.env.E2E_LIVE_NET !== "1") return resolve({ name, out: `\n━━ ${name} ━━ (skipped: set E2E_LIVE_NET=1)\n`, pass: 0, fail: 0 });
    const child = sp(process.execPath, [fileURLToPath(import.meta.url), name], { env: { ...process.env, E2E_CHILD: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", () => {
      const m = /(\d+) passed, (\d+) failed/.exec(out);
      resolve({ name, out, pass: m ? Number(m[1]) : 0, fail: m ? Number(m[2]) : 1 });
    });
  });
  const worker = async () => { for (let n = queue.shift(); n; n = queue.shift()) { const r = await runOne(n); results.push(r); console.log(r.out.replace(/\n[✓✗] \d+ passed.*\n?$/, "\n")); } };
  await Promise.all(Array.from({ length: Math.min(parallel, run.length) }, worker));
  const pass = results.reduce((a, r) => a + r.pass, 0), fail = results.reduce((a, r) => a + r.fail, 0);
  console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed (${run.length} suites, ${parallel} at a time)`);
  process.exit(fail ? 1 : 0);
}

const tmp = mkdtempSync(join(tmpdir(), "dbb-e2e-"));
const procs = [];
const cleanup = () => { for (const p of procs) { try { p.kill("SIGTERM"); } catch {} } try { rmSync(tmp, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });

// ---- the demo server (own port, loopback only) ---------------------------------------------------
const demoPort = await freePort();
const demo = spawn(process.execPath, [join(root, "demo", "x402-demo-server.mjs")], { env: { ...process.env, DEMO_PORT: String(demoPort), DEMO_HOST: "127.0.0.1" }, stdio: "ignore" });
procs.push(demo);
const base = `http://127.0.0.1:${demoPort}`;
await waitFor(() => fetch(base + "/free").then((r) => r.ok), "the demo server");

// ---- a vault seeded with the demo login (via the standalone package — which also tests interop) --
const { Vault } = await import(pathToFileURL(join(root, "..", "..", "packages", "vault", "src", "index.ts")).href);
const VAULT_MASTER = "e2e master pw";

async function launchApp(suite) {
  const profile = join(tmp, `profile-${suite}`);
  const vaultPath = join(tmp, `vault-${suite}.json`);
  const v = await Vault.create(vaultPath, VAULT_MASTER);
  await v.add({ origin: base, username: "demo", password: "demo-pass" });
  v.lock();
  const controlPort = await freePort();
  const debugPort = await freePort();
  const token = "e2e-" + Math.random().toString(16).slice(2);
  const log = [];
  const mcpServersFile = join(tmp, `mcp-servers-${suite}.json`);
  if (suite === "bookmarks" || suite === "omnibox") {
    // The built-in askrobots entry, replaced by one that points at the stand-in server: the bookmarks use the "askrobots" entry.
    writeFileSync(mcpServersFile, JSON.stringify([{ id: "askrobots", name: "askrobots (stand-in)", url: `${base}/mcp`, tools: ["list_links", "create_link"], readOnly: ["list_links"], browserOnly: ["upload_file"], fixedArgs: { create_link: { project_id: "P-links", is_public: false }, upload_file: { project_id: "P-links", is_public: false, category: "browser/kept" } } }]));
  }
  if (suite === "mcp") {
    writeFileSync(mcpServersFile, JSON.stringify([{ id: "demo", name: "Demo notes", url: `${base}/mcp`, tools: ["lookup", "save", "person"], readOnly: ["lookup", "person"], fixedArgs: { save: { project_id: "P-1" } }, dropFields: { person: ["notes", "interactions"] } }]));
  }
  const app = spawn(process.execPath, [join(here, "launch.mjs"), `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`], {
    env: {
      ...process.env,
      DBB_CONTROL: "1", DBB_CONTROL_PORT: String(controlPort), DBB_CONTROL_TOKEN: token, DBB_CONTROL_FILE: join(tmp, `control-${suite}.json`),
      ...(suite === "extensions" ? { DBB_EXTENSIONS: join(here, "..", "test", "fixtures", "ext-echo.mjs") } : {}),
      // The chat suite talks to a scripted model on the demo server (never a real provider or the user's own keys).
      ...(suite === "chat" || suite === "mcp" || suite === "bookmarks" || suite === "keep" ? { DBB_AI_BASE_URL: `${base}/v1`, DBB_AI_PROVIDER: "openai", DBB_AI_MODEL: "fake-model", OPENAI_API_KEY: "e2e-fake-key", ANTHROPIC_API_KEY: "", DBB_AI_CONSENT: "1" } : {}),
      // The mcp suite signs in to a stand-in MCP server on the demo server; sign-ins stay in memory, never in the keychain.
      ...(suite === "mcp" || suite === "bookmarks" || suite === "omnibox" ? { DBB_MCP_STORE: "memory", DBB_MCP_SERVERS: mcpServersFile } : {}),
      ...(process.env.E2E_BACKGROUND === "1" ? { DBB_BACKGROUND: "1" } : {}),
      ...(suite === "keep" || suite === "omnibox" ? { DBB_KEEP_DIR: join(tmp, "kept-" + suite) } : {}),
      DBB_SUGGEST_URL: `${base}/suggest?q=%s`, // never the real search site from a test
      DBB_VAULT: vaultPath, HOMEPAGE: `${base}/free`, DBB_DOWNLOAD_DIR: join(tmp, `downloads-${suite}`),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (d) => log.push(String(d)));
  app.stderr.on("data", (d) => log.push(String(d)));
  procs.push(app);
  const url = `http://127.0.0.1:${controlPort}/rpc`;
  await waitFor(async () => {
    const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ method: "status" }) }).then((x) => x.json());
    return r.ok && r.result.tabs.some((t) => t.url.startsWith(base) && t.wcId != null && !t.loading); // up, and the first tab has loaded
  }, "the browser to start");
  return { app, url, token, debugPort, controlPort, log, downloadDir: join(tmp, `downloads-${suite}`), quit: () => { try { app.kill("SIGTERM"); } catch {} } };
}

const totals = { pass: 0, fail: 0, skipped: [] };
for (const name of run) {
  if (name === "live-net" && process.env.E2E_LIVE_NET !== "1") { totals.skipped.push("live-net (set E2E_LIVE_NET=1)"); continue; }
  console.log(`\n━━ ${name} ━━`);
  const inst = await launchApp(name);
  const ctx = makeCtx({ ...inst, base, tmp, vaultMaster: VAULT_MASTER, liveAi: process.env.E2E_LIVE_AI === "1" });
  try {
    const mod = await import(pathToFileURL(join(root, "test", "e2e", `${name}.mjs`)).href);
    await mod.default(ctx);
  } catch (e) {
    ctx.check(false, `suite "${name}" crashed`, String(e?.stack || e).split("\n").slice(0, 3).join(" | "));
  } finally {
    await ctx.close();
    inst.quit();
    await sleep(800);
  }
  totals.pass += ctx.counts.pass;
  totals.fail += ctx.counts.fail;
}

console.log(`\n${totals.fail ? "✗" : "✓"} ${totals.pass} passed, ${totals.fail} failed${totals.skipped.length ? ` · skipped: ${totals.skipped.join(", ")}` : ""}`);
process.exit(totals.fail ? 1 : 0);
