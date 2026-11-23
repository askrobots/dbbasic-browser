/**
 * Card view: a site's posts shown as dense cards in a page the browser owns. Electron-free so it is unit-tested.
 *
 * The split that keeps it safe:
 *  - A VIEW RULE says where a site keeps its posts: CSS selectors and which attribute to take, nothing else. It is data,
 *    not code, so it can be checked and, later, shared on gitstable like a style rule. `validateViewRule` refuses
 *    anything else.
 *  - The READER below is the browser's own code. It runs in an isolated world of the site's tab (the page's scripts
 *    can't see or change it) and returns plain strings.
 *  - What it returns is UNTRUSTED: the page controls the DOM it reads. `validatePosts` keeps a small plain-data
 *    vocabulary, clamps every size and keeps only https addresses; `buildCardsHtml` writes the page from scratch with
 *    every string escaped, under a CSP with no scripts, forms, frames or connections (images only).
 */

export type Take = "text" | "href" | "src" | "poster" | "datetime" | "aria-label" | "exists";
export interface FieldSpec {
  sel: string;
  take: Take;
  /** Every match (a list), not only the first. */
  all?: boolean;
  /** Only elements whose text matches this (case-sensitive regular expression). */
  match?: string;
}
export const FIELDS = ["link", "author", "handle", "avatar", "time", "timeText", "text", "images", "stats", "context", "promoted"] as const;
export type FieldName = (typeof FIELDS)[number];

export interface ViewRule {
  v: 1;
  id: string;
  name: string;
  sites: string[];
  /** One post. */
  post: string;
  /** Each field: one spec, or alternatives tried in order (the first that finds something wins). */
  fields: Partial<Record<FieldName, FieldSpec | FieldSpec[]>>;
}

const TAKES: readonly Take[] = ["text", "href", "src", "poster", "datetime", "aria-label", "exists"];
const MAX_SEL = 400;

/** The rule if it is only selectors and field names; otherwise why not. */
export function validateViewRule(raw: unknown): { ok: true; rule: ViewRule } | { ok: false; error: string } {
  const r = raw as Partial<ViewRule> | null;
  if (!r || typeof r !== "object" || r.v !== 1) return { ok: false, error: "not a view rule (v: 1)" };
  if (typeof r.id !== "string" || !/^[a-z0-9-]{1,64}$/.test(r.id)) return { ok: false, error: "bad id" };
  if (typeof r.name !== "string" || !r.name.trim() || r.name.length > 80) return { ok: false, error: "bad name" };
  if (!Array.isArray(r.sites) || !r.sites.length || !r.sites.every((s) => typeof s === "string" && /^[a-z0-9.-]{1,253}$/.test(s))) return { ok: false, error: "bad sites" };
  if (typeof r.post !== "string" || !r.post.trim() || r.post.length > MAX_SEL) return { ok: false, error: "bad post selector" };
  if (!r.fields || typeof r.fields !== "object") return { ok: false, error: "no fields" };
  const fields: ViewRule["fields"] = {};
  for (const [k, v] of Object.entries(r.fields)) {
    if (!(FIELDS as readonly string[]).includes(k)) return { ok: false, error: `unknown field ${k}` };
    const specs = Array.isArray(v) ? v : [v];
    if (!specs.length || specs.length > 6) return { ok: false, error: `bad field ${k}` };
    for (const s of specs as FieldSpec[]) {
      if (!s || typeof s.sel !== "string" || !s.sel.trim() || s.sel.length > MAX_SEL || !TAKES.includes(s.take)) return { ok: false, error: `bad field ${k}` };
      if (s.match !== undefined) {
        if (typeof s.match !== "string" || s.match.length > 200) return { ok: false, error: `bad match in ${k}` };
        try {
          new RegExp(s.match);
        } catch {
          return { ok: false, error: `bad match in ${k}` };
        }
      }
      const extra = Object.keys(s).filter((x) => !["sel", "take", "all", "match"].includes(x));
      if (extra.length) return { ok: false, error: `field ${k} has ${extra.join(", ")}` };
    }
    fields[k as FieldName] = specs.map((s) => ({ sel: s.sel, take: s.take, ...(s.all ? { all: true } : {}), ...(s.match !== undefined ? { match: s.match } : {}) }));
  }
  return { ok: true, rule: { v: 1, id: r.id, name: r.name.trim(), sites: r.sites, post: r.post, fields } };
}

/**
 * The reader, as source to run in an isolated world of the tab. It reads at most 200 posts and returns plain strings.
 * (A function serialised with the rule as JSON: the rule is data, so it can't add code.)
 */
export function readerSource(rule: ViewRule): string {
  const reader = (r: ViewRule) => {
    const pick = (root: Element, specs: FieldSpec | FieldSpec[] | undefined): unknown => {
      for (const s of specs ? (Array.isArray(specs) ? specs : [specs]) : []) {
        let els: Element[];
        try {
          els = [...root.querySelectorAll(s.sel)];
        } catch {
          continue;
        }
        if (s.match) {
          const re = new RegExp(s.match);
          els = els.filter((e) => re.test(((e as HTMLElement).innerText ?? e.textContent ?? "").trim()));
        }
        const val = (e: Element): unknown => {
          if (s.take === "exists") return true;
          if (s.take === "text") return ((e as HTMLElement).innerText ?? e.textContent ?? "").trim();
          if (s.take === "href") return (e as HTMLAnchorElement).href || "";
          if (s.take === "src") return (e as HTMLImageElement).currentSrc || (e as HTMLImageElement).src || "";
          if (s.take === "poster") return (e as HTMLVideoElement).poster || "";
          return e.getAttribute(s.take) || "";
        };
        if (s.all) {
          const vals = els.map(val).filter(Boolean);
          if (vals.length) return vals;
        } else {
          for (const e of els) {
            const v = val(e);
            if (v) return v;
          }
        }
      }
      return undefined;
    };
    const posts = [...document.querySelectorAll(r.post)].slice(0, 200).map((el) => {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(r.fields)) o[k] = pick(el, (r.fields as Record<string, FieldSpec | FieldSpec[]>)[k]);
      return o;
    });
    return { url: location.href, title: document.title, posts };
  };
  return `(${reader.toString()})(${JSON.stringify(rule)})`;
}

export interface Post {
  /** The post's address: what identifies it. */
  link: string;
  author: string;
  handle: string;
  avatar: string;
  /** ISO time when the site gives one; else the site's own short text ("2h"). */
  time: string;
  timeText: string;
  text: string;
  images: string[];
  stats: string;
  context: string;
  promoted: boolean;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\u0000/g, "").trim().slice(0, max) : "");
function httpsUrl(v: unknown, sites?: readonly string[]): string {
  if (typeof v !== "string" || v.length > 2000) return "";
  try {
    const u = new URL(v);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if ((u.protocol !== "https:" && !(u.protocol === "http:" && loopback && sites)) || u.username || u.password) return "";
    if (sites) {
      const h = u.hostname.toLowerCase().replace(/^www\./, "");
      if (!sites.some((s) => h === s || h.endsWith("." + s))) return "";
    }
    return u.href;
  } catch {
    return "";
  }
}

/** What the reader returned, as plain posts. Posts without a link on the rule's own sites are dropped. */
export function validatePosts(raw: unknown, rule: ViewRule): Post[] {
  const list = (raw as { posts?: unknown })?.posts;
  if (!Array.isArray(list)) return [];
  const out: Post[] = [];
  for (const p of list.slice(0, 200) as Array<Record<string, unknown>>) {
    if (!p || typeof p !== "object") continue;
    const link = httpsUrl(p.link, rule.sites);
    if (!link) continue;
    const handle = str(p.handle, 40);
    const iso = str(p.time, 40);
    out.push({
      link,
      author: str(p.author, 80).split("\n")[0] ?? "",
      handle: /^@\w{1,30}$/.test(handle) ? handle : "",
      avatar: httpsUrl(p.avatar),
      time: !Number.isNaN(Date.parse(iso)) ? new Date(iso).toISOString() : "",
      timeText: str(p.timeText, 20),
      text: str(p.text, 4000),
      images: (Array.isArray(p.images) ? p.images : []).map((x) => httpsUrl(x)).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).slice(0, 4),
      stats: str(p.stats, 200),
      context: str(p.context, 120),
      promoted: p.promoted === true,
    });
  }
  return out;
}

/** Adds what's new, keyed by the post's address, keeping the order first seen. Returns how many were new. */
export function mergePosts(into: Map<string, Post>, posts: readonly Post[]): number {
  let n = 0;
  for (const p of posts) {
    const key = p.link.replace(/[?#].*$/, "");
    const had = into.get(key);
    if (!had) n++;
    // A later read of the same post may have loaded its images; keep the fuller one.
    if (!had || p.images.length > had.images.length || p.text.length > had.text.length) into.set(key, had ? { ...had, ...p, images: p.images.length >= had.images.length ? p.images : had.images } : p);
  }
  return n;
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** "61 replies, 223 reposts, 1554 likes, 78 bookmarks, 254134 views" → "61 replies · 223 reposts · 1.6K likes · 254K views". */
export function shortStats(s: string): string {
  const parts = [...s.matchAll(/(\d[\d,]*)\s+(repl(?:y|ies)|reposts?|likes?|views?|bookmarks?)/gi)].filter((m) => !/bookmark/i.test(m[2]!));
  const k = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K" : String(n));
  return parts.map((m) => `${k(Number(m[1]!.replace(/,/g, "")))} ${m[2]!.toLowerCase()}`).join(" · ");
}

/** "now", "5m", "3h", "Nov 21": X's own style, from an ISO time. */
export function shortTime(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (now.getTime() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export const CARDS_CSP = "default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/** Masonry without scripts: the page carries one layout per column count, and the window's width picks one. */
export const COLUMN_COUNTS = [1, 2, 3, 4, 5, 6, 7] as const;
const COL_W = 300;
const MASONRY_CSS = COLUMN_COUNTS.map((n) => {
  const min = n === 1 ? 0 : n * COL_W + 24;
  const max = n === COLUMN_COUNTS[COLUMN_COUNTS.length - 1] ? 0 : (n + 1) * COL_W + 23;
  const q = [min ? `(min-width: ${min}px)` : "", max ? `(max-width: ${max}px)` : ""].filter(Boolean).join(" and ");
  return `@media ${q} { .m${n} { display: grid; grid-template-columns: repeat(${n}, minmax(0, 1fr)); } }`;
}).join("\n");

/** About how tall a card will be at 300px wide: enough to pick the shortest column. */
export function estimateHeight(p: Post): number {
  const lines = p.text ? Math.min(10, p.text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 40)), 0)) : 0;
  const media = p.images.length === 0 ? 0 : p.images.length === 1 ? 230 : Math.ceil(p.images.length / 2) * 120;
  return 64 + (p.context ? 16 : 0) + lines * 19 + media + (p.stats ? 22 : 0);
}

/** Cards into `n` columns, each to the shortest so far: newest across the top, no gaps. */
export function masonry<T>(items: readonly T[], n: number, height: (x: T) => number): T[][] {
  const cols: T[][] = Array.from({ length: n }, () => []);
  const h = new Array<number>(n).fill(0);
  for (const it of items) {
    const i = h.indexOf(Math.min(...h));
    cols[i]!.push(it);
    h[i]! += height(it) + 10;
  }
  return cols;
}

const STYLE = `
:root { color-scheme: light dark; --bg:#f3f4f6; --fg:#16181c; --muted:#5b6470; --card:#fff; --rule:#e3e6ea; --accent:#1d6fd8; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d0f12; --fg:#e7e9ea; --muted:#8b949e; --card:#16191e; --rule:#262b33; --accent:#6aa8ff; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.4 -apple-system, system-ui, "Segoe UI", sans-serif; }
header { position: sticky; top: 0; z-index: 1; display: flex; gap: 14px; align-items: baseline; flex-wrap: wrap; padding: 10px 16px; background: var(--bg); border-bottom: 1px solid var(--rule); }
header h1 { font-size: 15px; margin: 0; }
header .meta { color: var(--muted); font-size: 12px; }
header a { color: var(--accent); text-decoration: none; font-size: 13px; }
main { padding: 10px 12px 40px; }
.m { display: none; gap: 10px; align-items: start; margin-bottom: 10px; }
.col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.batch { color: var(--muted); font-size: 12px; margin: 18px 2px 8px; border-top: 1px solid var(--rule); padding-top: 10px; }
${MASONRY_CSS}
.card { margin: 0; background: var(--card); border: 1px solid var(--rule); border-radius: 10px; padding: 9px 11px; }
.card.promoted { opacity: .75; }
.top { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
.top img { width: 28px; height: 28px; border-radius: 50%; flex: none; }
.who { min-width: 0; flex: 1; line-height: 1.2; }
.who b { display: block; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.who span { color: var(--muted); font-size: 12px; }
.when { color: var(--muted); font-size: 12px; text-decoration: none; flex: none; }
.ctx { color: var(--muted); font-size: 11px; margin-bottom: 3px; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13.5px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 10; overflow: hidden; }
.media { display: grid; gap: 3px; margin-top: 7px; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); }
.media a { display: block; }
.media img { width: 100%; max-height: 260px; object-fit: cover; border-radius: 6px; display: block; background: var(--rule); }
.stats { color: var(--muted); font-size: 11.5px; margin-top: 6px; }
.tag { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); border: 1px solid var(--rule); border-radius: 4px; padding: 0 4px; }
details { color: var(--muted); margin-bottom: 10px; }
details summary { cursor: pointer; font-size: 12px; }
details .inner { columns: 290px; column-gap: 10px; margin-top: 8px; }
details .inner .card { break-inside: avoid; margin-bottom: 10px; }
.more { display: block; text-align: center; padding: 14px; margin: 6px 0; border: 1px dashed var(--rule); border-radius: 10px; color: var(--accent); text-decoration: none; }
.empty { padding: 40px 16px; color: var(--muted); }
`;

function card(p: Post, now: Date, anchor: string): string {
  const when = p.time ? shortTime(p.time, now) : p.timeText;
  const media = p.images.length
    ? `<div class="media">${p.images.map((src) => `<a href="${escapeHtml(p.link)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(src)}" alt="" loading="lazy" referrerpolicy="no-referrer"></a>`).join("")}</div>`
    : "";
  return `<article class="card${p.promoted ? " promoted" : ""}"${anchor ? ` id="${anchor}"` : ""}>${p.context ? `<div class="ctx">${escapeHtml(p.context)}</div>` : ""}<div class="top">${p.avatar ? `<img src="${escapeHtml(p.avatar)}" alt="" referrerpolicy="no-referrer">` : ""}<div class="who"><b>${escapeHtml(p.author || p.handle || "?")}</b><span>${escapeHtml(p.handle)}${p.promoted ? ` <span class="tag">promoted</span>` : ""}</span></div><a class="when" href="${escapeHtml(p.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(when || "open")}</a></div>${p.text ? `<div class="text">${escapeHtml(p.text)}</div>` : ""}${media}${p.stats ? `<div class="stats">${escapeHtml(shortStats(p.stats))}</div>` : ""}</article>`;
}

export interface CardsPage {
  rule: ViewRule;
  /** The page the posts were read from. */
  source: string;
  title: string;
  posts: Post[];
  /** dbb-cards://<id>/more: read more posts from the same tab. Empty when that tab is gone. */
  moreUrl: string;
  /** Where each later read ("More posts") starts, as indexes into `posts`; the newest one is the #new anchor. */
  batches?: Array<{ from: number; at: Date }>;
  collectedAt: Date;
}

/** One batch of cards, laid out once per column count. */
function block(posts: Post[], now: Date): string {
  return COLUMN_COUNTS.map((n) => `<div class="m m${n}">${masonry(posts, n, estimateHeight).map((col) => `<div class="col">${col.map((p) => card(p, now, "")).join("")}</div>`).join("")}</div>`).join("");
}

/** The card page, from validated posts only, every string escaped. No scripts. */
export function buildCardsHtml(v: CardsPage): string {
  const shownAll = v.posts.filter((p) => !p.promoted);
  const hidden = v.posts.filter((p) => p.promoted);
  const time = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  let host = "";
  try {
    host = new URL(v.source).host;
  } catch {}
  const starts = [0, ...(v.batches ?? []).map((b) => b.from)];
  const parts = starts.map((from, i) => {
    const to = starts[i + 1] ?? v.posts.length;
    const posts = v.posts.slice(from, to).filter((p) => !p.promoted);
    if (!posts.length) return "";
    const b = i > 0 ? v.batches![i - 1]! : null;
    const head = b ? `<div class="batch"${i === starts.length - 1 ? ' id="new"' : ""}>${posts.length} more · read at ${escapeHtml(time(b.at))}</div>` : "";
    return head + block(posts, v.collectedAt);
  });
  const promo = hidden.length
    ? `<details><summary>${hidden.length} promoted post${hidden.length === 1 ? "" : "s"} hidden · show</summary><div class="inner">${hidden.map((p) => card(p, v.collectedAt, "")).join("")}</div></details>`
    : "";
  const more = v.moreUrl ? `<a class="more" href="${escapeHtml(v.moreUrl)}">More posts</a>` : `<div class="empty">The tab these came from is closed. Open the site again and choose Card view for more.</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CARDS_CSP}"><meta name="referrer" content="no-referrer">
<title>${escapeHtml(`Cards · ${v.title || host}`)}</title><style>${STYLE}</style></head>
<body><header><h1>${escapeHtml(v.title || host)}</h1><span class="meta">${shownAll.length} post${shownAll.length === 1 ? "" : "s"} from ${escapeHtml(host)} · read at ${escapeHtml(time(v.collectedAt))} · ${escapeHtml(v.rule.name)}</span><a href="${escapeHtml(v.source)}" target="_blank" rel="noopener noreferrer">Original</a>${v.moreUrl ? `<a href="${escapeHtml(v.moreUrl)}">More posts</a>` : ""}</header>
<main>${promo}${parts.join("") || `<div class="empty">No posts were found on this page.</div>`}${more}</main></body></html>`;
}
