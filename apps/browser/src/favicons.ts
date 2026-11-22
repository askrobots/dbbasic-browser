// Site icons (favicons), one per host, for the tabs, the address bar's suggestions and the bookmarks panel.
//
// A page names its icon; the browser fetches it once (through the page's own session, like any of its requests), shrinks
// it when it can, and keeps it here as a data: URL. The chrome UI only ever shows these data: URLs, so it never loads
// anything from a site itself. Icons are learned only from pages you open: typing in the address bar fetches nothing, so a
// page from your history that was never opened on this computer shows the row's usual symbol instead.
// The file is a list of sites you have opened, so it is readable only by you, and forgetting a site forgets its icon.

export const MAX_HOSTS = 1500;
export const MAX_BYTES = 48 * 1024; // an icon bigger than this (after shrinking) is not kept
export const REFRESH_MS = 7 * 24 * 3600 * 1000; // look again for a site's icon after a week
const RETRY_MS = 24 * 3600 * 1000; // a site whose icon could not be fetched is not tried again for a day

export interface Fetched { bytes: Uint8Array; type: string }
export interface FaviconDeps {
  /** Fetch an icon's bytes, or null (network error, not an image, too big). */
  fetch(url: string): Promise<Fetched | null>;
  /** Shrink to a 32×32 PNG data: URL when the format allows it (PNG, JPEG); null to keep the original. */
  shrink(f: Fetched): string | null;
  load(): string | null;
  save(text: string | null): void;
  now(): number;
}
interface Entry { icon: string; at: number; seen: number }

const IMAGE = /^image\/(png|x-icon|vnd\.microsoft\.icon|ico|svg\+xml|jpeg|gif|webp|bmp)$/i;

/** The image type from the first bytes (servers often send icons as text/plain or octet-stream), or null. */
export function sniff(b: Uint8Array): string | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  const head = Buffer.from(b.subarray(0, 512)).toString("utf8").trimStart().toLowerCase();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(head)) return "image/svg+xml";
  if (/^<(!doctype|html)/.test(head)) return "text/html"; // a "not found" page served as the icon
  return null;
}

export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase() : "";
  } catch { return ""; }
}

export class FaviconStore {
  private map = new Map<string, Entry>();
  private failed = new Map<string, number>(); // host -> when it last failed (not saved)
  private busy = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: FaviconDeps) {
    try {
      const raw = deps.load();
      const obj = raw ? JSON.parse(raw) : null;
      if (obj && obj.v === 1 && obj.icons && typeof obj.icons === "object") {
        for (const [h, e] of Object.entries(obj.icons as Record<string, Entry>)) {
          if (e && typeof e.icon === "string" && e.icon.startsWith("data:image/") && typeof e.at === "number") this.map.set(h, { icon: e.icon, at: e.at, seen: Number(e.seen) || e.at });
        }
      }
    } catch { /* a damaged file: start empty */ }
  }

  get(host: string): string | null { return this.map.get(host)?.icon ?? null; }
  all(): Record<string, string> { return Object.fromEntries([...this.map].map(([h, e]) => [h, e.icon])); }
  size(): number { return this.map.size; }

  /**
   * A page on `pageUrl` named these icons (best first). Fetches the first usable one unless the site's icon is fresh.
   * Resolves to the new icon when it changed, else null.
   */
  async learn(pageUrl: string, candidates: string[]): Promise<string | null> {
    const host = hostOf(pageUrl);
    if (!host) return null;
    const now = this.deps.now();
    const had = this.map.get(host);
    if (had) { had.seen = now; this.saveSoon(); }
    if (had && now - had.at < REFRESH_MS) return null;
    if ((this.failed.get(host) ?? -Infinity) > now - RETRY_MS || this.busy.has(host)) return null;
    const url = candidates.find((c) => /^(https?:|data:image\/)/i.test(c));
    if (!url) return null;
    this.busy.add(host);
    try {
      const icon = await this.toDataUrl(url);
      if (!icon) { this.failed.set(host, now); if (had) had.at = now; return null; }
      this.map.set(host, { icon, at: now, seen: now });
      this.trim();
      this.saveSoon();
      return had && had.icon === icon ? null : icon;
    } finally { this.busy.delete(host); }
  }

  /** Forget one site's icon (forgetting the site from history), or every icon. */
  forget(host?: string): void {
    if (host === undefined) { this.map.clear(); this.failed.clear(); this.flush(); return; }
    if (this.map.delete(host.toLowerCase())) this.flush();
  }

  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.deps.save(this.map.size ? JSON.stringify({ v: 1, icons: Object.fromEntries(this.map) }) : null);
  }

  private saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 2000);
    (this.saveTimer as { unref?: () => void }).unref?.();
  }

  private trim(): void {
    if (this.map.size <= MAX_HOSTS) return;
    const oldest = [...this.map].sort((a, b) => a[1].seen - b[1].seen).slice(0, this.map.size - MAX_HOSTS);
    for (const [h] of oldest) this.map.delete(h);
  }

  private async toDataUrl(url: string): Promise<string | null> {
    let f: Fetched | null;
    if (/^data:/i.test(url)) {
      const m = /^data:([^;,]+)(;base64)?,(.*)$/is.exec(url);
      if (!m) return null;
      const [, mime = "", b64, body = ""] = m;
      let bytes: Uint8Array;
      try { bytes = b64 ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body)); } catch { return null; }
      f = { bytes, type: mime };
    } else f = await this.deps.fetch(url);
    if (!f || !f.bytes.length) return null;
    const type = sniff(f.bytes) ?? (f.type.split(";")[0] ?? "").trim().toLowerCase();
    if (!IMAGE.test(type)) return null;
    f = { bytes: f.bytes, type };
    const small = /png|jpeg/.test(type) ? this.deps.shrink(f) : null;
    const out = small ?? `data:${type};base64,${Buffer.from(f.bytes).toString("base64")}`;
    return out.length <= MAX_BYTES * 1.4 ? out : null;
  }
}
