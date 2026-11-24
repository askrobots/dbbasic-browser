/**
 * Page zoom (⌘+ ⌘− ⌘0), remembered per site as other browsers do: zoom one page of a site and its other pages, now
 * and after a restart, open at that size. The steps are Chrome's. Only sites are remembered (http and https, by host
 * name); the browser's own pages (cards, reader, kept copies) zoom for as long as the tab shows them.
 *
 * Electron-free so it is unit-tested; main.ts applies the factors to pages and saves the file.
 */

export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const;
const MIN = 0.25;
const MAX = 5;
/** Sites remembered at most; the oldest change goes first. */
export const MAX_SITES = 2000;

export type ZoomMove = "in" | "out" | "reset";

/** The next step up or down from a factor, which need not be a step itself (a pinch, an old saved value). */
export function stepZoom(factor: number, move: ZoomMove): number {
  if (move === "reset") return 1;
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const eps = 0.005;
  if (move === "in") return ZOOM_STEPS.find((s) => s > f + eps) ?? MAX;
  return [...ZOOM_STEPS].reverse().find((s) => s < f - eps) ?? MIN;
}

/** What a page's zoom is remembered under: its host name for a web page, null for anything else. */
export function zoomSite(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.hostname.toLowerCase() || null : null;
  } catch {
    return null;
  }
}

/** "125%" */
export const zoomLabel = (factor: number): string => `${Math.round(factor * 100)}%`;

const clean = (f: unknown): number | null => (typeof f === "number" && Number.isFinite(f) && f >= MIN && f <= MAX ? f : null);

/** The remembered sizes. Only sites not at 100% are kept. */
export class ZoomStore {
  private sites = new Map<string, number>();

  /** `saved` is the file's text, or null when there is none; a damaged file is treated as empty. */
  constructor(saved: string | null, private save: (text: string) => void) {
    if (!saved) return;
    try {
      const j = JSON.parse(saved) as { v?: number; sites?: Record<string, unknown> };
      if (j && j.v === 1 && j.sites && typeof j.sites === "object") {
        for (const [host, f] of Object.entries(j.sites)) {
          const c = clean(f);
          if (c !== null && c !== 1 && host) this.sites.set(host, c);
        }
      }
    } catch {
      /* start empty */
    }
  }

  get(site: string | null): number {
    return (site && this.sites.get(site)) || 1;
  }

  set(site: string | null, factor: number): void {
    if (!site) return;
    const c = clean(factor);
    if (c === null) return;
    this.sites.delete(site); // re-inserted last: newest change
    if (Math.abs(c - 1) > 0.001) this.sites.set(site, c);
    while (this.sites.size > MAX_SITES) this.sites.delete(this.sites.keys().next().value as string);
    this.save(JSON.stringify({ v: 1, sites: Object.fromEntries(this.sites) }));
  }

  get size(): number {
    return this.sites.size;
  }
}
