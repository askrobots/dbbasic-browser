/**
 * Bookmarks are the person's saved links on a connected service (askrobots), read and saved over its MCP connection.
 *
 * - The list is kept in a local copy, so it shows at once and when offline, and is fetched from the service once when the
 *   browser opens (if a sign-in is saved), when the person opens the list, right after saving, and right after signing in.
 * - Whether the page you are on is saved is decided from that copy, in the browser: the addresses you visit are never sent
 *   to the service to ask.
 * - Reading never reaches the keychain on its own: until the connection has been used in this session, only the local copy
 *   is shown (on macOS, unlocking a saved sign-in can raise a system password prompt).
 * - Saving the page you are on is one click with no dialog after it (the star fills in); it goes where the server's entry says
 *   saved links go (fixed arguments in mcp-servers.json, such as a project), and is private.
 */

export interface Bookmark {
  id: string;
  url: string;
  title: string;
  tags: string[];
  createdAt: string | null;
}

export interface BookmarksState {
  items: Bookmark[];
  /** When the list last came from the service (epoch ms), or null if it never has. */
  updatedAt: number | null;
  /** Where `items` came from right now. */
  source: "service" | "copy" | "none";
  connected: boolean;
  /** The service returns at most this many, newest first. */
  limit: number;
  error?: string;
}

export interface BookmarksDeps {
  /** Call a tool on the bookmark service. `fixed`: apply the server entry's fixed arguments (for saving). */
  call(tool: string, args: Record<string, unknown>, opts: { fixed: boolean }): Promise<string>;
  /** Signed in to the service. May read the saved sign-in (and so the keychain): only call it when that is fine. */
  connected(): boolean;
  /** True once the saved sign-in has been read this session (so checking costs nothing). */
  ready(): boolean;
  loadCopy(): string | null;
  saveCopy(text: string): void;
  changed(state: BookmarksState): void;
  now?(): number;
}

export const LIMIT = 100;

/** One address in a comparable form: no fragment, lower-case host, no trailing slash on the path. */
export function normalizeUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    x.hostname = x.hostname.toLowerCase();
    let s = x.href;
    if (x.pathname !== "/" && s.endsWith("/") && !x.search) s = s.slice(0, -1);
    if (x.pathname === "/" && !x.search) s = `${x.protocol}//${x.host}`;
    return s;
  } catch {
    return u.trim();
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The service's answer, as bookmarks. Accepts a list, or an object holding one; drops anything that is not a web address. */
export function parseLinks(text: string): Bookmark[] {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(j) ? j : j && typeof j === "object" ? ((j as Record<string, unknown>).links ?? (j as Record<string, unknown>).results ?? []) : [];
  if (!Array.isArray(list)) return [];
  const out: Bookmark[] = [];
  for (const raw of list as Array<Record<string, unknown>>) {
    const url = str(raw?.url);
    if (!/^https?:\/\//i.test(url)) continue;
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      /* keep the address */
    }
    const tags = Array.isArray(raw.tags) ? raw.tags.map(str).filter(Boolean) : str(raw.tags).split(",").map((t) => t.trim()).filter(Boolean);
    out.push({ id: str(raw.id) || url, url, title: str(raw.title).trim().slice(0, 300) || host, tags, createdAt: str(raw.created_at) || null });
  }
  return out;
}

export class BookmarksService {
  private items: Bookmark[] = [];
  private updatedAt: number | null = null;
  private source: BookmarksState["source"] = "none";
  private error: string | undefined;
  private inFlight: Promise<BookmarksState> | null = null;
  private keys = new Set<string>();

  constructor(private d: BookmarksDeps) {
    try {
      const t = d.loadCopy();
      const j = t ? (JSON.parse(t) as { items?: unknown; updatedAt?: unknown }) : null;
      if (j && Array.isArray(j.items)) {
        this.items = parseLinks(JSON.stringify((j.items as Array<Record<string, unknown>>).map((b) => ({ ...b, created_at: b.createdAt, tags: b.tags }))));
        this.updatedAt = typeof j.updatedAt === "number" ? j.updatedAt : null;
        this.source = this.items.length || this.updatedAt ? "copy" : "none";
      }
    } catch {
      /* no copy */
    }
    this.reindex();
  }

  private now() {
    return (this.d.now ?? Date.now)();
  }
  private reindex() {
    this.keys = new Set(this.items.map((b) => normalizeUrl(b.url)));
  }

  /** What to show now. Never reaches the service (or the keychain). */
  state(): BookmarksState {
    return { items: this.items, updatedAt: this.updatedAt, source: this.source, connected: this.d.ready() ? this.d.connected() : this.source === "service", limit: LIMIT, ...(this.error ? { error: this.error } : {}) };
  }

  has(url: string): boolean {
    return this.keys.has(normalizeUrl(url));
  }

  /** Fetch the list from the service. One at a time; a second call while one is running gets the same answer. */
  refresh(): Promise<BookmarksState> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        if (!this.d.connected()) {
          this.error = undefined;
          return this.state();
        }
        const text = await this.d.call("list_links", { limit: LIMIT }, { fixed: false });
        const next = parseLinks(text);
        const before = JSON.stringify(this.items.map((b) => [b.id, b.url, b.title, b.tags]));
        this.items = next;
        this.updatedAt = this.now();
        this.source = "service";
        this.error = undefined;
        this.reindex();
        this.d.saveCopy(JSON.stringify({ updatedAt: this.updatedAt, items: this.items }));
        if (JSON.stringify(next.map((b) => [b.id, b.url, b.title, b.tags])) !== before) this.d.changed(this.state());
        return this.state();
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        return this.state();
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /**
   * Search all of the person's links on the service (the local list holds only the newest ones). Only what the person typed
   * into the bookmarks search is sent. Results are not added to the local list.
   */
  async search(query: string): Promise<{ items: Bookmark[]; error?: string }> {
    const q = query.trim().slice(0, 200);
    if (q.length < 2) return { items: [] };
    if (!this.d.connected()) return { items: [], error: "Connect askrobots.com to search all your bookmarks." };
    try {
      return { items: parseLinks(await this.d.call("list_links", { search: q, limit: LIMIT }, { fixed: false })) };
    } catch (e) {
      return { items: [], error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Save an address as a bookmark (the person's own click), then refresh. */
  async add(url: string, title: string): Promise<{ ok: boolean; already?: boolean; message?: string }> {
    if (!/^https?:\/\//i.test(url)) return { ok: false, message: "only web pages can be saved" };
    if (!this.d.connected()) return { ok: false, message: "Connect askrobots.com in the assistant panel first." };
    if (this.source !== "service") await this.refresh(); // never save twice because the list had not been loaded yet
    if (this.has(url)) return { ok: true, already: true };
    try {
      await this.d.call("create_link", { url, title: title.slice(0, 255) || url }, { fixed: true });
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    await this.refresh();
    return { ok: true };
  }
}
