/**
 * What each process of the browser really costs the machine.
 *
 * "Resident" memory (what Electron reports as workingSetSize, and what `ps` shows) is not that number on macOS: the system
 * squeezes memory a page is not using into compressed memory and counts only what is left in RAM. A tab holding 400 MB can show
 * as 80 MB resident while still taking 400 MB from the machine. Activity Monitor's "Memory" column is the physical footprint,
 * which includes the compressed part, and the `footprint` tool that ships with macOS reports it. So on macOS we ask it (about
 * a tenth of a second for the whole browser); anywhere else, or if it fails, we use what Electron gives us.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The per-process footprints in a `footprint --json` document, in bytes, by pid. */
export function parseFootprint(text: string): Map<number, number> {
  const out = new Map<number, number>();
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return out;
  }
  const procs = (j as { processes?: unknown }).processes;
  if (!Array.isArray(procs)) return out;
  for (const p of procs as Array<Record<string, unknown>>) {
    const aux = p.auxiliary as Record<string, unknown> | undefined;
    const bytes = typeof aux?.phys_footprint === "number" ? aux.phys_footprint : typeof p.footprint === "number" ? p.footprint : null;
    if (typeof p.pid === "number" && bytes !== null && bytes >= 0) out.set(p.pid, bytes);
  }
  return out;
}

export type Run = (file: string, args: string[]) => Promise<void>;
const run: Run = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, windowsHide: true }, (e) => (e ? reject(e) : resolve()));
  });

/** Footprint in bytes for the given pids, on macOS; an empty map anywhere else or when the tool fails. */
export async function macFootprints(pids: number[], platform: string = process.platform, exec: Run = run): Promise<Map<number, number>> {
  if (platform !== "darwin" || pids.length === 0) return new Map();
  const safe = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "dbb-fp-"));
    const file = join(dir, "fp.json");
    await exec("/usr/bin/footprint", [...safe.flatMap((p) => ["-p", String(p)]), "--noCategories", "-j", file]);
    return parseFootprint(await readFile(file, "utf8"));
  } catch {
    return new Map();
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
