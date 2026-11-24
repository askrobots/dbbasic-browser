// Downloads: tracked, announced, saved safely, linked to the payment that unlocked them.
// (The e2e runner sets DBB_DOWNLOAD_DIR so nothing blocks on the native Save dialog.)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { sleep } from "./lib.mjs";

export default async function (ctx) {
  const { call: T, check, base } = ctx;
  const dir = ctx.downloadDir;
  const c = await ctx.chrome();
  const list = () => T("downloads.list");
  const finished = async (name, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const d = (await list()).find((x) => x.name === name && x.state !== "progressing");
      if (d || Date.now() > end) return d;
      await sleep(100);
    }
  };

  check((await list()).length === 0, "no downloads at the start");

  // ---- a small attachment ----
  const e0 = (await T("x402.events", { since: 0 })).next;
  T("page.goto", { url: base + "/download", wait: false }).catch(() => {});
  let d = await finished("hello-report.txt");
  check(d?.state === "completed", "a download completes", `${d?.name} ${d?.received} B`);
  check(d && existsSync(d.path) && d.path.startsWith(dir), "…and the file was saved where we said", d?.path?.replace(dir, "<dir>"));
  check(d && readFileSync(d.path, "utf8").startsWith("hello from the demo server"), "…with the right content");
  check(d && statSync(d.path).size === d.received && d.received > 1000, "…and the recorded size matches the file");
  const evs = (await T("x402.events", { since: e0 })).events.filter((e) => e.kind === "download");
  check(evs.length >= 2 && evs[0].state === "progressing" && evs.at(-1).state === "completed", "it was announced: started, then completed", evs.map((e) => e.state).join(" → "));
  check(((await T("tabs.list")).find((t) => t.active).url || "").startsWith(base), "the tab stays on the page it was on (a download doesn't navigate away)");

  // ---- the same file again: never overwrite ----
  T("page.goto", { url: base + "/download", wait: false }).catch(() => {});
  await sleep(1500);
  const names = readdirSync(dir).sort();
  check(names.includes("hello-report.txt") && names.includes("hello-report (1).txt"), "a second download of the same name gets a new name instead of overwriting", names.join(", "));

  // ---- a hostile filename cannot escape the folder ----
  T("page.goto", { url: base + "/download/evil", wait: false }).catch(() => {});
  d = (await (async () => { for (let i = 0; i < 100; i++) { const x = (await list()).find((r) => /pwned/.test(r.name)); if (x && x.state !== "progressing") return x; await sleep(100); } })());
  check(!!d && !/[\\/]/.test(d.name) && d.path.startsWith(dir + "/"), "a '../../../../tmp/…' filename is neutralized and stays inside the folder", d?.name);
  check(!existsSync("/tmp/dbb-pwned.txt"), "nothing was written outside the download folder");

  // ---- progress on a big, slow file ----
  const seen = [];
  let sawStatus = "";
  T("page.goto", { url: base + "/download/big", wait: false }).catch(() => {});
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const r = (await list()).find((x) => x.name === "big.bin");
    if (r) {
      if (!seen.length || seen.at(-1) !== r.received) seen.push(r.received);
      if (r.state === "progressing" && !sawStatus) sawStatus = (await c.ev(`(() => { const s = document.getElementById('status'); return s.classList.contains('show') ? s.innerText.replace(/\\s+/g, ' ').trim() : '' })()`)) || "";
      if (r.state !== "progressing") break;
    }
    await sleep(120);
  }
  const big = (await list()).find((x) => x.name === "big.bin");
  check(big?.state === "completed" && big.received === 3 * 1024 * 1024, "a 3 MB trickling file completes with exactly the right size", `${big?.received} B`);
  check(seen.length >= 3 && seen.every((v, i) => i === 0 || v >= seen[i - 1]), "progress was reported while it ran (byte count grew)", `${seen.length} updates, e.g. ${seen.slice(0, 3).join(" → ")}`);
  check(/Downloading big\.bin/.test(sawStatus), "the status line said what was happening", sawStatus);
  check(statSync(big.path).size === 3 * 1024 * 1024, "the saved file is the full size on disk");

  // ---- a PAID download: linked to the payment ----
  await T("x402.approval", { mode: "auto", maxUsd: 1 });
  T("page.goto", { url: base + "/download/paid", wait: false }).catch(() => {});
  d = await finished("dataset.csv");
  await T("x402.approval", { mode: "ask", maxUsd: 0 });
  check(d?.state === "completed" && readFileSync(d.path, "utf8").startsWith("id,value"), "a paid download completes after the payment", d?.name);
  check(d?.paid === "$0.001", "…and the record carries the amount that unlocked it", d?.paid);

  // ---- the Downloads panel (status bar, File ▸ Downloads, ⌘⇧J) ----
  const panel = () => c.ev(`(() => [...document.querySelectorAll("#dlPanel .dl")].map((r) => ({ name: r.querySelector(".nm").textContent, link: r.querySelector(".nm").tagName === "A", gone: r.classList.contains("gone"), info: r.querySelector(".t2").textContent, buttons: [...r.querySelectorAll("button")].map((b) => b.textContent) })))()`);
  const press = (name, label) => c.ev(`(() => { const r = [...document.querySelectorAll("#dlPanel .dl")].find((r) => r.querySelector(".nm").textContent === ${JSON.stringify(name)}); const b = r && [...r.querySelectorAll("button")].find((b) => b.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
  const waitPanel = async (fn, what) => { for (let i = 0; i < 60; i++) { const p = await panel(); if (fn(p)) return p; await sleep(100); } return panel(); };
  await c.ev(`(onTabCmd("downloads"), true)`);
  let rows = await waitPanel((p) => p.length >= 5, "the panel");
  check(await c.ev(`document.getElementById("dlPanel").classList.contains("open")`), "File ▸ Downloads opens the Downloads panel");
  check(rows.length === 5 && rows[0].name === "dataset.csv" && rows.at(-1).name === "hello-report.txt", "it lists every download, newest first", rows.map((r) => r.name).join(", "));
  const paidRow = rows.find((r) => r.name === "dataset.csv");
  check(/127\.0\.0\.1/.test(paidRow.info) && /paid \$0\.001/.test(paidRow.info) && paidRow.link, "a row says the site, the size and what was paid, and its name opens the file", paidRow.info);
  check(rows.find((r) => r.name === "big.bin").info.includes("3.0 MB"), "and the size", rows.find((r) => r.name === "big.bin").info);
  let since = (await T("x402.events", { since: 0 })).next;
  await c.ev(`(document.querySelector('#dlPanel .dl a.nm').click(), true)`);
  let opened = null;
  for (let i = 0; i < 40 && !opened; i++) { opened = (await T("x402.events", { since })).events.find((e) => e.kind === "download-opened"); await sleep(100); }
  check(!!opened, "clicking a name opens the file (recorded here, not opened)");
  check(await press("big.bin", "Show in Finder"), "each file has Show in Finder");

  // a file moved or deleted outside the browser
  const report = (await list()).find((x) => x.name === "hello-report.txt");
  rmSync(report.path);
  await c.ev(`(setDl(false), setDl(true), true)`);
  rows = await waitPanel((p) => p.some((r) => r.name === "hello-report.txt" && r.gone), "the deleted file");
  const goneRow = rows.find((r) => r.name === "hello-report.txt");
  check(goneRow?.gone && !goneRow.link && /Moved or deleted/.test(goneRow.info) && !goneRow.buttons.includes("Show in Finder"), "a file deleted since is shown as moved or deleted, and can't be opened", goneRow?.info);

  // take one off the list: the file stays
  const one = (await list()).find((x) => x.name === "hello-report (1).txt");
  await press("hello-report (1).txt", "✕");
  rows = await waitPanel((p) => !p.some((r) => r.name === "hello-report (1).txt"), "the row to go");
  check(!rows.some((r) => r.name === "hello-report (1).txt") && existsSync(one.path), "✕ takes a download off the list, and the file stays where it is");

  // cancel a running one from the panel, then retry it
  T("page.goto", { url: base + "/download/big", wait: false }).catch(() => {});
  rows = await waitPanel((p) => p[0]?.name === "big (1).bin" && p[0].buttons.includes("Cancel"), "the running download");
  const btn = await c.ev(`document.getElementById("dlBtn").textContent`);
  check(rows[0]?.buttons.includes("Cancel") && /^⬇ \d+%$/.test(btn), "a running download has Cancel, and the status bar button shows its progress", btn);
  await press("big (1).bin", "Cancel");
  rows = await waitPanel((p) => /Cancelled/.test(p[0]?.info ?? ""), "the cancel");
  check(/Cancelled/.test(rows[0]?.info ?? "") && rows[0].buttons.includes("Retry"), "Cancel stops it, and it can be retried", rows[0]?.info);
  check(!paidRow.buttons.includes("Retry"), "a paid download has no Retry (fetching it again could pay twice)");
  await press("big (1).bin", "Retry");
  let again = null;
  for (let i = 0; i < 200 && !again; i++) { again = (await list()).find((x) => x.id > rows.length && x.name.startsWith("big") && x.state === "completed" && x.received === 3 * 1024 * 1024 && x.startedAt > Date.now() - 30000); await sleep(100); }
  check(!!again, "Retry downloads it again, in full", again?.name);
  check((await c.ev(`document.getElementById("dlBtn").textContent`)) === "Downloads", "and the status bar button goes back to Downloads");

  // kept for the next start
  const saved = JSON.parse(readFileSync(join(ctx.tmp, "profile-downloads", "downloads.json"), "utf8"));
  check(saved.v === 1 && saved.items.some((x) => x.name === "dataset.csv" && x.paid === "$0.001") && !saved.items.some((x) => x.name === "hello-report (1).txt"), "the list is saved in the profile for the next start", `${saved.items.length} items`);

  // ⌘⇧J from the page closes it; Clear list keeps only what is running
  await c.ev(`(() => { active.wv.focus(); const m = ${JSON.stringify(process.platform === "darwin" ? "meta" : "control")}; active.wv.sendInputEvent({ type: "keyDown", keyCode: "J", modifiers: [m, "shift"] }); active.wv.sendInputEvent({ type: "keyUp", keyCode: "J", modifiers: [m, "shift"] }); return true; })()`);
  let closed = false;
  for (let i = 0; i < 30 && !closed; i++) { closed = !(await c.ev(`document.getElementById("dlPanel").classList.contains("open")`)); await sleep(100); }
  check(closed, "⌘⇧J while the page has the keyboard closes it again");
  await c.ev(`(setDl(true), true)`);
  await waitPanel((p) => p.length > 0, "the panel");
  await c.ev(`(() => { [...document.querySelectorAll("#dlPanel h4 button")].find((b) => b.textContent === "Clear list").click(); return true; })()`);
  await waitPanel((p) => p.length === 0, "an empty list");
  check((await list()).length === 0 && /Nothing downloaded yet/.test(await c.ev(`document.getElementById("dlPanel").textContent`)), "Clear list takes the finished ones off, and the panel says there is nothing yet");
  check(existsSync(join(dir, "big.bin")), "and no file was deleted");
  await c.ev(`(setDl(false), true)`);

  // ---- macOS quarantine: a downloaded file must be marked so Gatekeeper vets anything you run ----
  if (process.platform === "darwin" && big) {
    let q = "";
    try { q = execFileSync("xattr", ["-p", "com.apple.quarantine", big.path], { encoding: "utf8" }).trim(); } catch { /* absent */ }
    check(q.length > 0, "the file carries the com.apple.quarantine attribute (Gatekeeper will vet it)", q || "ABSENT");
  }
}
