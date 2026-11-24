/**
 * The list of downloads (and pages saved as PDF), kept in the profile so it is still there after a restart, as in
 * other browsers. It holds what the Downloads panel shows: name, the site, where the file went, its size, how it
 * ended, and what was paid for it. Never the file's contents.
 *
 * A download that was still running when the browser closed is listed as interrupted. The newest MAX_KEPT are kept.
 *
 * Electron-free so it is unit-tested; main.ts feeds it from Electron's download items and writes the file.
 */

export type DownloadState = "progressing" | "paused" | "completed" | "cancelled" | "interrupted";

export interface DownloadRecord {
  id: number;
  name: string;
  host: string;
  /** Where it was downloaded from, for Retry ("" for data: and blob: addresses, and for saved PDFs). */
  url: string;
  total: number;
  received: number;
  state: DownloadState;
  path: string;
  /** The x402 amount paid for this URL just before the download started, e.g. "$0.001". */
  paid?: string;
  /** macOS: whether the file was marked as downloaded from the internet (so Gatekeeper vets it). */
  quarantined?: boolean;
  /** "pdf" for a page the browser saved as a PDF. */
  kind?: "pdf";
  startedAt: number;
  endedAt?: number;
}

export const MAX_KEPT = 500;
const STATES = new Set<DownloadState>(["progressing", "paused", "completed", "cancelled", "interrupted"]);
const running = (s: DownloadState) => s === "progressing" || s === "paused";

/** Only what a record may hold, from a file that could be damaged or old. */
function clean(x: unknown): DownloadRecord | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  if (!Number.isInteger(r.id) || (r.id as number) <= 0 || !str(r.name)) return null;
  const state = STATES.has(r.state as DownloadState) ? (r.state as DownloadState) : "interrupted";
  const out: DownloadRecord = {
    id: r.id as number,
    name: str(r.name),
    host: str(r.host),
    url: /^https?:\/\//i.test(str(r.url)) ? str(r.url) : "",
    total: num(r.total),
    received: num(r.received),
    state,
    path: str(r.path),
    startedAt: num(r.startedAt),
  };
  if (typeof r.paid === "string" && r.paid) out.paid = r.paid;
  if (typeof r.quarantined === "boolean") out.quarantined = r.quarantined;
  if (r.kind === "pdf") out.kind = "pdf";
  if (num(r.endedAt)) out.endedAt = num(r.endedAt);
  return out;
}

export class DownloadList {
  private items = new Map<number, DownloadRecord>();
  private seq = 0;

  /** `saved` is the file's text, or null when there is none; a damaged file is treated as empty. */
  constructor(saved: string | null, private save: (text: string) => void, private now: () => number = Date.now) {
    if (!saved) return;
    let list: unknown[] = [];
    try {
      const j = JSON.parse(saved) as { v?: number; items?: unknown[] };
      if (j && j.v === 1 && Array.isArray(j.items)) list = j.items;
    } catch {
      /* start empty */
    }
    for (const x of list) {
      const r = clean(x);
      if (!r || this.items.has(r.id)) continue;
      // Still running when the browser closed: it did not finish.
      if (running(r.state)) r.state = "interrupted";
      this.items.set(r.id, r);
      this.seq = Math.max(this.seq, r.id);
    }
    this.trim();
  }

  /** A new record (its id is given here), saved at once. */
  add(r: Omit<DownloadRecord, "id">): DownloadRecord {
    const rec = { ...r, id: ++this.seq } as DownloadRecord;
    this.items.set(rec.id, rec);
    this.trim();
    this.flush();
    return rec;
  }

  get(id: number): DownloadRecord | undefined {
    return this.items.get(id);
  }

  /** Changes to a record. Saved when it starts or ends; progress alone is saved by the caller now and then (flush). */
  update(id: number, change: Partial<Omit<DownloadRecord, "id">>): DownloadRecord | undefined {
    const r = this.items.get(id);
    if (!r) return undefined;
    const was = r.state;
    Object.assign(r, change);
    if (running(was) && !running(r.state) && !r.endedAt) r.endedAt = this.now();
    if (was !== r.state) this.flush();
    return r;
  }

  /** Oldest first, as they were started. */
  list(): DownloadRecord[] {
    return [...this.items.values()];
  }

  /** Take one off the list (the file stays where it is). A running download can't be removed; cancel it first. */
  remove(id: number): boolean {
    const r = this.items.get(id);
    if (!r || running(r.state)) return false;
    this.items.delete(id);
    this.flush();
    return true;
  }

  /** Take every finished one off the list (files stay); running ones stay. Returns how many went. */
  clear(): number {
    let n = 0;
    for (const [id, r] of this.items) if (!running(r.state)) (this.items.delete(id), n++);
    if (n) this.flush();
    return n;
  }

  flush(): void {
    this.save(JSON.stringify({ v: 1, items: this.list() }));
  }

  private trim(): void {
    for (const [id, r] of this.items) {
      if (this.items.size <= MAX_KEPT) break;
      if (!running(r.state)) this.items.delete(id);
    }
  }
}
