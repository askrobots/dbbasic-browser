/**
 * Where reader views live. Each reader tab is served from `dbb-reader://<id>/` by the main process, from this
 * in-memory store — not from a one-shot `data:` URL. That matters for history: a `data:` URL IS the page, so
 * Back/Forward re-loaded the snapshot taken BEFORE the AI answered (a forever-"Summarizing…" skeleton). Here the
 * stored page is updated when the summary arrives, so any later load — Back, Forward, reload — shows the finished
 * view instantly, with no new provider call.
 *
 * Electron-free so it can be unit-tested.
 */

import { randomBytes } from "node:crypto";

export const READER_SCHEME = "dbb-reader";
const ID_RE = /^[0-9a-f]{18}$/;

export const readerUrl = (id: string) => `${READER_SCHEME}://${id}/`;

/** The page id in a reader URL, or null for anything that isn't one of ours. */
export function readerIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === `${READER_SCHEME}:` && ID_RE.test(u.hostname) ? u.hostname : null;
  } catch {
    return null;
  }
}

export const EXPIRED_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Reader view expired</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>body{font:17px/1.6 -apple-system,system-ui,sans-serif;max-width:560px;margin:90px auto;padding:0 22px;color:#444}h1{font-size:22px}</style></head>
<body><h1>This reader view has expired</h1><p>Reader views are kept in memory for this session only, and the oldest are dropped. Open the original page and press <b>⌘⇧R</b> to read it again.</p></body></html>`;

export class ReaderPages {
  private pages = new Map<string, string>();
  private readonly max: number;

  constructor(max = 30) {
    this.max = max;
  }

  /** Store a new page; returns its id. The oldest page is dropped when the store is full. */
  put(html: string): string {
    const id = randomBytes(9).toString("hex");
    this.pages.set(id, html);
    while (this.pages.size > this.max) {
      const oldest = this.pages.keys().next().value as string;
      this.pages.delete(oldest);
    }
    return id;
  }

  /** Replace a page's content (the summary arrived). A no-op if it was already evicted. */
  update(id: string, html: string): boolean {
    if (!this.pages.has(id)) return false;
    this.pages.set(id, html);
    return true;
  }

  get(id: string): string | undefined {
    return this.pages.get(id);
  }

  get size(): number {
    return this.pages.size;
  }
}
