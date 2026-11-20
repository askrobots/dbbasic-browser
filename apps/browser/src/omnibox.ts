/**
 * The address bar's suggestions: what to show under it as you type, and which site to complete inline.
 *
 * Everything here is local (open tabs, your saved links, your kept copies). Search suggestions from the search site are
 * fetched separately, and only for text that is not an address (see `remoteAllowed`), so a typed address never leaves the
 * machine before you press Enter. Electron-free so it is unit-tested.
 */

export interface OmniItem {
  url: string;
  title: string;
}
export interface OmniTab extends OmniItem {
  id: number;
}

export type OmniRow =
  | { kind: "go"; url: string; title: string }
  | { kind: "search"; text: string }
  | { kind: "tab"; id: number; url: string; title: string }
  | { kind: "bookmark"; url: string; title: string }
  | { kind: "kept"; url: string; title: string; original: string }
  | { kind: "suggest"; text: string }
  | { kind: "ask"; text: string };

const LIMITS = { tab: 3, bookmark: 5, kept: 3 };

const hostOf = (u: string): string => {
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) ? x.hostname.replace(/^www\./, "").toLowerCase() : "";
  } catch {
    return "";
  }
};

/** The site part of an address as it is typed: host and port, without "www." ("localhost:8899", "slashdot.org"). */
const siteOf = (u: string): string => {
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) ? x.host.replace(/^www\./, "").toLowerCase() : "";
  } catch {
    return "";
  }
};

const isLocalHost = (host: string) =>
  host === "localhost" || host.endsWith(".local") || /^127(\.\d+){3}$/.test(host) || /^10(\.\d+){3}$/.test(host) || /^192\.168(\.\d+){2}$/.test(host) || /^172\.(1[6-9]|2\d|3[01])(\.\d+){2}$/.test(host);

/** True when Enter would open this text as an address rather than search for it (the same rule as the address bar's). */
export function looksLikeAddress(raw: string): boolean {
  const u = raw.trim();
  if (!u) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^(about|file|data|view-source):/i.test(u)) return true;
  const host = u.split(/[/?#]/)[0]?.split(":")[0] ?? "";
  return !/\s/.test(u) && (isLocalHost(host) || /^[^\s.]+(\.[^\s.]+)+$/.test(host));
}

/**
 * Whether the text may be sent for search suggestions: never an address or anything that looks like part of one (a path,
 * a port, an @), never very short or very long text.
 */
export function remoteAllowed(raw: string): boolean {
  const t = raw.trim();
  if (t.length < 2 || t.length > 100) return false;
  if (looksLikeAddress(t)) return false;
  if (!/\s/.test(t) && /[/:@\\]/.test(t)) return false;
  return true;
}

/**
 * The site to complete inline as you type: the first site you have saved, kept or open whose name starts with what you typed
 * ("slash" → "slashdot.org"). Only while the text could be the start of a site name; the most used site wins.
 */
export function autofillHost(raw: string, urls: string[]): string | null {
  const t = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
  if (t.length < 2 || /[\s/?#:@]/.test(t)) return null;
  const count = new Map<string, number>();
  for (const u of urls) {
    const h = siteOf(u);
    if (h && h.startsWith(t) && h !== t) count.set(h, (count.get(h) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [h, c] of count) if (c > n || (c === n && best && h.length < best.length)) (best = h), (n = c);
  return best;
}

const norm = (u: string) => u.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "").toLowerCase();

/** Rank: the site name starts with the text, then a word of the title starts with it, then it is anywhere. */
function score(words: string[], it: OmniItem): number {
  const hay = `${it.title}\n${it.url}`.toLowerCase();
  if (!words.every((w) => hay.includes(w))) return -1;
  const first = words[0] as string;
  const host = hostOf(it.url);
  if (host.startsWith(first)) return 3;
  if (new RegExp(`(^|[^a-z0-9])${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(it.title.toLowerCase())) return 2;
  return 1;
}

function pick<T extends OmniItem>(words: string[], items: T[], limit: number, seen: Set<string>): T[] {
  return items
    .map((it, i) => ({ it, s: score(words, it), i }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.it)
    .filter((it) => {
      const k = norm(it.url);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, limit);
}

/**
 * The rows under the address bar. The first row is what Enter does with the text as typed (or completed): open it, or search
 * for it. Then open tabs (switch to them), saved links, kept copies; search suggestions are added by the caller when they
 * arrive; the last row hands the text to the assistant.
 */
export function suggest(p: { text: string; tabs: OmniTab[]; activeTab?: number; bookmarks: OmniItem[]; kept: Array<OmniItem & { id: string; view: string }>; askable?: boolean; autofill?: boolean }): { autofill: string | null; rows: OmniRow[] } {
  const text = p.text.trim();
  if (!text) return { autofill: null, rows: [] };
  const autofill = p.autofill === false ? null : autofillHost(text, [...p.tabs.map((t) => t.url), ...p.bookmarks.map((b) => b.url), ...p.kept.map((k) => k.url)]);
  const rows: OmniRow[] = [];
  if (autofill) {
    // where to go: the scheme of an address you used on that site (a local site is usually plain http)
    const used = [...p.tabs, ...p.bookmarks, ...p.kept].map((x) => x.url).find((u) => siteOf(u) === autofill) ?? "";
    rows.push({ kind: "go", url: `${/^http:/i.test(used) ? "http" : "https"}://${autofill}/`, title: autofill });
  }
  else if (looksLikeAddress(text)) rows.push({ kind: "go", url: text, title: text });
  else rows.push({ kind: "search", text });
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  for (const t of pick(words, p.tabs.filter((t) => t.id !== p.activeTab && /^https?:/i.test(t.url)), LIMITS.tab, seen)) rows.push({ kind: "tab", id: t.id, url: t.url, title: t.title || t.url });
  for (const b of pick(words, p.bookmarks, LIMITS.bookmark, seen)) rows.push({ kind: "bookmark", url: b.url, title: b.title || b.url });
  for (const k of pick(words, p.kept, LIMITS.kept, new Set())) rows.push({ kind: "kept", url: k.view, title: k.title || k.url, original: k.url });
  if (p.askable !== false && !looksLikeAddress(text)) rows.push({ kind: "ask", text });
  return { autofill, rows };
}

/** The search site's suggestions (OpenSearch suggestions JSON: ["text", ["one", "two", …]]), without the text itself. */
export function parseSuggestions(body: string, text: string, max = 5): string[] {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return [];
  }
  const list = Array.isArray(j) && Array.isArray(j[1]) ? (j[1] as unknown[]) : [];
  const t = text.trim().toLowerCase();
  const out: string[] = [];
  for (const s of list) {
    if (typeof s !== "string") continue;
    const v = s.trim().slice(0, 120);
    if (!v || v.toLowerCase() === t || out.some((o) => o.toLowerCase() === v.toLowerCase())) continue;
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}
