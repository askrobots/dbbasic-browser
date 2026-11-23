/**
 * Card view, main-process side: read a tab's posts with its site's view rule, scrolling it at a reading pace to gather
 * more, and show them in a tab of the browser's own (dbb-cards://<id>/). "More posts" reads more from the same tab.
 *
 * What it never does: click, like, follow, post or type on the site. It only scrolls the tab it was asked to read,
 * reads in an isolated world the page's scripts can't reach, and sends nothing anywhere (the cards load the post's
 * images from the site's own image host, as the site itself does).
 */

import { randomBytes } from "node:crypto";
import { webContents, type WebContents } from "electron";
import { buildCardsHtml, mergePosts, readerSource, ruleFor, validatePosts, validateViewRule, type Post, type ViewRule } from "./cards.js";

export const CARDS_SCHEME = "dbb-cards";
const ID_RE = /^[0-9a-f]{18}$/;
export const cardsUrl = (id: string, path = "") => `${CARDS_SCHEME}://${id}/${path}`;

export function parseCardsUrl(url: string): { id: string; path: string } | null {
  try {
    const u = new URL(url);
    return u.protocol === `${CARDS_SCHEME}:` && ID_RE.test(u.hostname) ? { id: u.hostname, path: u.pathname.replace(/^\/+/, "") } : null;
  } catch {
    return null;
  }
}

const WORLD = 1011;
/** A screen at a time, with a pause like a person reading, so the site loads the next posts. */
const STEP_MS = 700;
/** How far each step scrolls, in screens. Sites keep a few screens of posts rendered around the view, so nothing is skipped. */
const STEP_SCREENS = 1.5;

export interface CardsDeps {
  askChrome(op: string, args: Record<string, unknown>): Promise<unknown>;
  emit(payload: Record<string, unknown>): void;
  isOurTab(wc: WebContents | undefined): wc is WebContents;
}

interface View {
  rule: ViewRule;
  srcWcId: number;
  source: string;
  title: string;
  posts: Map<string, Post>;
  html: string;
  at: number;
  busy: boolean;
  batches: Array<{ from: number; at: Date }>;
}

export interface CardsResult {
  ok: boolean;
  reason?: "no-tab" | "no-rule" | "busy" | "none-found" | "error";
  message?: string;
  tab?: { id: number; wcId: number };
  posts?: number;
  promoted?: number;
}

export function createCards(deps: CardsDeps, opts: { stepMs?: number; max?: number } = {}) {
  const views = new Map<string, View>();
  const stepMs = opts.stepMs ?? STEP_MS;
  const maxViews = opts.max ?? 20;

  async function read(wc: WebContents, rule: ViewRule): Promise<{ posts: Post[]; title: string; url: string }> {
    const raw = (await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: readerSource(rule) }])) as { title?: unknown; url?: unknown } | null;
    return { posts: validatePosts(raw, rule), title: typeof raw?.title === "string" ? raw.title.slice(0, 200) : "", url: typeof raw?.url === "string" ? raw.url : wc.getURL() };
  }

  /**
   * Reads, scrolls a screen, waits, reads again, until `want` new posts or `rounds` screens. It gives up early only at
   * the end: 3 reads in a row with nothing new while scrolling no longer moves the page (the site has nothing more).
   */
  async function gather(wc: WebContents, v: View, want: number, rounds: number): Promise<number> {
    let added = 0;
    let stuck = 0;
    let moved = true;
    for (let i = 0; i < rounds && !wc.isDestroyed(); i++) {
      const r = await read(wc, v.rule);
      if (!v.title && r.title) v.title = r.title;
      const n = mergePosts(v.posts, r.posts);
      added += n;
      stuck = n || moved ? 0 : stuck + 1;
      if (added >= want || stuck >= 3) break;
      deps.emit({ kind: "cards-progress", wcId: wc.id, posts: v.posts.size });
      const y = (await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(() => { const y = scrollY; window.scrollBy(0, Math.round(innerHeight * ${STEP_SCREENS})); return [y, scrollY]; })()` }]).catch(() => null)) as [number, number] | null;
      moved = !!y && y[1] !== y[0];
      await new Promise((res) => setTimeout(res, stepMs));
    }
    return added;
  }

  function render(id: string, v: View): string {
    const src = webContents.fromId(v.srcWcId);
    const alive = !!src && !src.isDestroyed();
    v.html = buildCardsHtml({ rule: v.rule, source: v.source, title: v.title, posts: [...v.posts.values()], moreUrl: alive ? cardsUrl(id, "more") : "", collectedAt: new Date(), batches: v.batches });
    return v.html;
  }

  /** `rule`: a view rule to use instead of the built-in one for the site (the automation API; later, installed view-rule plugins). */
  async function open(o: { wcId: number; want?: number; rounds?: number; rule?: unknown }): Promise<CardsResult> {
    const wc = webContents.fromId(o.wcId);
    if (!deps.isOurTab(wc)) return { ok: false, reason: "no-tab", message: "No such tab." };
    let rule: ViewRule | null = null;
    if (o.rule !== undefined) {
      const r = validateViewRule(o.rule);
      if (!r.ok) return { ok: false, reason: "no-rule", message: `That view rule was refused: ${r.error}` };
      rule = r.rule;
    } else {
      try {
        const u = new URL(wc.getURL());
        if (u.protocol === "https:") rule = ruleFor(u.hostname);
      } catch {}
    }
    if (!rule) return { ok: false, reason: "no-rule", message: "Card view works on X for now. Other sites need their own view rule." };
    const v: View = { rule, srcWcId: wc.id, source: wc.getURL(), title: "", posts: new Map(), html: "", at: Date.now(), busy: true, batches: [] };
    try {
      deps.emit({ kind: "cards-progress", wcId: wc.id, posts: 0, start: true });
      await gather(wc, v, o.want ?? 80, o.rounds ?? 24);
    } catch (e) {
      return { ok: false, reason: "error", message: `Couldn't read this page: ${(e as Error).message}` };
    } finally {
      v.busy = false;
      deps.emit({ kind: "cards-progress", wcId: wc.id, done: true, posts: v.posts.size });
    }
    if (!v.posts.size) return { ok: false, reason: "none-found", message: "No posts were found on this page." };
    const id = randomBytes(9).toString("hex");
    views.set(id, v);
    while (views.size > maxViews) views.delete(views.keys().next().value as string);
    render(id, v);
    let tab: { id: number; wcId: number };
    try {
      tab = (await deps.askChrome("tab.new", { url: cardsUrl(id), activate: true, wait: true })) as { id: number; wcId: number };
    } catch (e) {
      return { ok: false, reason: "error", message: `Couldn't open the card tab: ${(e as Error).message}` };
    }
    const all = [...v.posts.values()];
    return { ok: true, tab, posts: all.filter((p) => !p.promoted).length, promoted: all.filter((p) => p.promoted).length };
  }

  /** What dbb-cards://<id>/<path> serves. "more" reads more posts first, then sends the tab to the first new one. */
  async function serve(url: string): Promise<{ status: number; html: string }> {
    const p = parseCardsUrl(url);
    const v = p ? views.get(p.id) : undefined;
    if (!p || !v) return { status: 410, html: EXPIRED_CARDS_HTML };
    if (p.path === "more") {
      const src = webContents.fromId(v.srcWcId);
      if (src && !src.isDestroyed() && !v.busy) {
        v.busy = true;
        const before = v.posts.size;
        // A tab in the background isn't rendered, so the site wouldn't load more as it scrolls: show it while it is
        // read (a few seconds), then go back to the cards.
        await deps.askChrome("tab.peek", { wcId: src.id, on: true }).catch(() => {});
        try {
          await new Promise((res) => setTimeout(res, 300));
          await gather(src, v, 60, 18);
        } catch {
          // the tab navigated away or closed: show what there is
        } finally {
          v.busy = false;
          await deps.askChrome("tab.peek", { wcId: src.id, on: false }).catch(() => {});
        }
        if (v.posts.size > before) v.batches.push({ from: before, at: new Date() });
        render(p.id, v);
        return { status: 200, html: `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${cardsUrl(p.id)}#new">` };
      }
      render(p.id, v);
      return { status: 200, html: `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${cardsUrl(p.id)}">` };
    }
    return { status: 200, html: v.html || render(p.id, v) };
  }

  return { open, serve };
}

export const EXPIRED_CARDS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Card view expired</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>body{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:560px;margin:90px auto;padding:0 22px;color:#555}h1{font-size:21px}</style></head>
<body><h1>This card view has expired</h1><p>Card views are kept in memory for this session only. Open the site again and choose View ▸ Card View.</p></body></html>`;

export type CardsService = ReturnType<typeof createCards>;
