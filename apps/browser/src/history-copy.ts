/**
 * A copy of your askrobots history on this machine, so the address bar can suggest pages you visited, on any of your
 * computers, without sending what you type anywhere. Electron-free (main.ts gives it the connection and a file), so it is
 * unit-tested.
 *
 *  - Only addresses, titles and times: never the pages' text.
 *  - Kept up to date with the account's list_history: each answer gives a cursor for the next read, the visits added since
 *    and the ids of visits forgotten since (on any computer). "full_copy" means start again from nothing.
 *  - Signing out, or signing in again (perhaps as someone else), deletes it.
 *  - At most MAX_VISITS visits; the oldest go first.
 */

export const MAX_VISITS = 20_000;
const PAGE = 500;
/** Pages read in one go; the rest come on the next read. */
const MAX_PAGES = 40;

export interface CopyVisit {
  id: string;
  url: string;
  title: string;
  /** When it was visited, in ms. */
  at: number;
}

/** A page, all its visits together: what the address bar suggests. */
export interface HistoryPage {
  url: string;
  title: string;
  visits: number;
  last: number;
}

export interface HistoryCopyDeps {
  call(tool: string, args: Record<string, unknown>): Promise<string>;
  /** Signed in, with the history permission. */
  connected(): boolean;
  /** The saved copy, or null. */
  load(): string | null;
  /** Save the copy; null deletes it. */
  save(text: string | null): void;
  now(): number;
}

interface Saved {
  v: 1;
  cursor?: string;
  visits: CopyVisit[];
}

export class HistoryCopy {
  private visits = new Map<string, CopyVisit>();
  private cursor: string | undefined;
  private loaded = false;
  private syncing: Promise<void> | null = null;
  private pagesCache: HistoryPage[] | null = null;
  private pagesAt = 0;
  private lastError: string | undefined;
  private lastSync: number | undefined;

  constructor(private d: HistoryCopyDeps) {}

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = this.d.load();
      if (!raw) return;
      const s = JSON.parse(raw) as Saved;
      if (s.v !== 1 || !Array.isArray(s.visits)) return;
      for (const v of s.visits) if (v && typeof v.id === "string" && typeof v.url === "string" && typeof v.at === "number") this.visits.set(v.id, { id: v.id, url: v.url, title: String(v.title ?? ""), at: v.at });
      this.cursor = typeof s.cursor === "string" ? s.cursor : undefined;
    } catch {
      this.visits.clear();
      this.cursor = undefined;
    }
  }

  private persist(): void {
    const s: Saved = { v: 1, ...(this.cursor ? { cursor: this.cursor } : {}), visits: [...this.visits.values()] };
    this.d.save(JSON.stringify(s));
  }

  state(): { visits: number; pages: number; lastSync?: number; error?: string } {
    this.ensureLoaded();
    return { visits: this.visits.size, pages: this.pages().length, ...(this.lastSync ? { lastSync: this.lastSync } : {}), ...(this.lastError ? { error: this.lastError } : {}) };
  }

  /** Signed out, or signed in again: the copy belongs to the account it came from, so it goes. */
  clear(): void {
    this.loaded = true;
    this.visits.clear();
    this.cursor = undefined;
    this.pagesCache = null;
    this.lastError = undefined;
    this.lastSync = undefined;
    this.d.save(null);
  }

  /** Take visits out here at once (a forget), before the account's list says so too. */
  remove(gone: (v: CopyVisit) => boolean): void {
    this.ensureLoaded();
    let any = false;
    for (const [id, v] of this.visits) if (gone(v)) (this.visits.delete(id), (any = true));
    if (any) {
      this.pagesCache = null;
      this.persist();
    }
  }

  /** Read what changed on the account since the last read. One at a time; a second call waits for the first. */
  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.pull().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async pull(): Promise<void> {
    this.ensureLoaded();
    if (!this.d.connected()) return;
    let restarted = false;
    let changed = false;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = JSON.parse(await this.d.call("list_history", { ...(this.cursor ? { cursor: this.cursor } : {}), limit: PAGE })) as {
          visits?: Array<{ id?: unknown; url?: unknown; title?: unknown; visited_at?: unknown }>;
          forgotten?: unknown[];
          full_copy?: boolean;
          cursor?: unknown;
          has_more?: boolean;
          error?: unknown;
        };
        if (res.error) {
          // a cursor the account no longer knows: start again from nothing, once
          if (this.cursor && !restarted) {
            restarted = true;
            this.visits.clear();
            this.cursor = undefined;
            changed = true;
            page = -1;
            continue;
          }
          throw new Error(String(res.error));
        }
        if (res.full_copy && this.cursor && !restarted) {
          restarted = true;
          this.visits.clear();
          this.cursor = undefined;
          changed = true;
          page = -1;
          continue;
        }
        for (const id of res.forgotten ?? []) if (this.visits.delete(String(id))) changed = true;
        for (const v of res.visits ?? []) {
          if (typeof v.id !== "string" && typeof v.id !== "number") continue;
          if (typeof v.url !== "string") continue;
          const at = Date.parse(String(v.visited_at ?? ""));
          this.visits.set(String(v.id), { id: String(v.id), url: v.url, title: typeof v.title === "string" ? v.title.slice(0, 300) : "", at: Number.isFinite(at) ? at : 0 });
          changed = true;
        }
        if (typeof res.cursor === "string") this.cursor = res.cursor;
        if (!res.has_more) break;
      }
      this.lastError = undefined;
      this.lastSync = this.d.now();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message.slice(0, 200) : String(e);
    }
    if (this.visits.size > MAX_VISITS) {
      const oldest = [...this.visits.values()].sort((a, b) => a.at - b.at).slice(0, this.visits.size - MAX_VISITS);
      for (const v of oldest) this.visits.delete(v.id);
      changed = true;
    }
    if (changed) {
      this.pagesCache = null;
      this.persist();
    } else if (this.cursor) this.persist();
  }

  /**
   * Every page, the ones you visit most and most lately first: how often (up to 20 visits counted), weighted by how long ago
   * the last visit was.
   */
  pages(): HistoryPage[] {
    this.ensureLoaded();
    if (this.pagesCache && this.d.now() - this.pagesAt < 60_000) return this.pagesCache;
    const by = new Map<string, HistoryPage>();
    for (const v of this.visits.values()) {
      const p = by.get(v.url);
      if (!p) by.set(v.url, { url: v.url, title: v.title, visits: 1, last: v.at });
      else {
        p.visits++;
        if (v.at >= p.last) {
          p.last = v.at;
          if (v.title) p.title = v.title;
        } else if (!p.title && v.title) p.title = v.title;
      }
    }
    const now = this.d.now();
    const weight = (p: HistoryPage) => {
      const days = (now - p.last) / 86_400_000;
      return Math.min(p.visits, 20) * (days < 1 ? 4 : days < 7 ? 2 : days < 30 ? 1 : 0.5);
    };
    this.pagesAt = now;
    this.pagesCache = [...by.values()].sort((a, b) => weight(b) - weight(a) || b.last - a.last);
    return this.pagesCache;
  }
}
