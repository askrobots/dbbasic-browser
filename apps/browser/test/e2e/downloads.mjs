// Downloads: tracked, announced, saved safely, linked to the payment that unlocked them.
// (The e2e runner sets DBB_DOWNLOAD_DIR so nothing blocks on the native Save dialog.)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

  // ---- macOS quarantine: a downloaded file must be marked so Gatekeeper vets anything you run ----
  if (process.platform === "darwin" && big) {
    let q = "";
    try { q = execFileSync("xattr", ["-p", "com.apple.quarantine", big.path], { encoding: "utf8" }).trim(); } catch { /* absent */ }
    check(q.length > 0, "the file carries the com.apple.quarantine attribute (Gatekeeper will vet it)", q || "ABSENT");
  }
}
