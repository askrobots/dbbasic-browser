/**
 * How much disk a folder uses, and which parts of it. Used to show what the browser's own data folder is made of (cache,
 * site storage, service workers…), so growth has a name. Bounded: it stops after MAX_FILES files so a huge folder cannot
 * make the status itself the thing that hogs the machine, and says so.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

export interface DiskUsage {
  bytes: number;
  files: number;
  /** True when the walk stopped early: the numbers are a floor. */
  truncated: boolean;
  /** The folder's direct children, biggest first. */
  top: Array<{ name: string; bytes: number }>;
}

const MAX_FILES = 60_000;

export async function diskUsage(dir: string, opts: { maxFiles?: number; topN?: number } = {}): Promise<DiskUsage> {
  const max = opts.maxFiles ?? MAX_FILES;
  let files = 0;
  let truncated = false;
  const sizeOf = async (p: string): Promise<number> => {
    if (files >= max) {
      truncated = true;
      return 0;
    }
    let st;
    try {
      st = await fs.lstat(p); // lstat: never follow a link out of the folder
    } catch {
      return 0;
    }
    if (st.isSymbolicLink()) return 0;
    if (!st.isDirectory()) {
      files++;
      return st.blocks ? st.blocks * 512 : st.size; // what it takes on disk, not what it claims
    }
    let names: string[];
    try {
      names = await fs.readdir(p);
    } catch {
      return 0;
    }
    let sum = 0;
    for (const n of names) sum += await sizeOf(join(p, n));
    return sum;
  };
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { bytes: 0, files: 0, truncated: false, top: [] };
  }
  const top: Array<{ name: string; bytes: number }> = [];
  for (const n of names) top.push({ name: n, bytes: await sizeOf(join(dir, n)) });
  top.sort((a, b) => b.bytes - a.bytes);
  return { bytes: top.reduce((s, t) => s + t.bytes, 0), files, truncated, top: top.slice(0, opts.topN ?? 8) };
}
