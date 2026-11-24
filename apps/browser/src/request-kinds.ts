/**
 * What kind of request a page made, for our network layer.
 *
 * The Request our protocol handler gets has lost what Chromium's loader knows: it says mode "cors" and no destination for
 * everything, and carries no Origin. Built from guesses, our fetch-metadata headers told a site that a frame was a page,
 * a script was a fetch, and everything came from nowhere (Sec-Fetch-Site: none). Bot checks such as Cloudflare's
 * Turnstile compare those headers with what a real browser sends, and never passed.
 *
 * Electron's webRequest.onBeforeRequest still sees the page's own request first, with its real type ("script",
 * "subFrame", "xhr", …) and the frame that made it. main.ts records that here; the transport takes the record for the
 * same method and address a moment later. Records are kept a few seconds and used once.
 *
 * Electron-free so it is unit-tested.
 */

/** Electron's resourceType names. */
export type ResourceType =
  | "mainFrame" | "subFrame" | "stylesheet" | "script" | "image" | "font" | "object" | "xhr" | "ping" | "cspReport" | "media" | "webSocket" | "other";

export interface RequestKind {
  type: ResourceType;
  /** The origin of the document that made the request (for a frame being loaded, its parent's), or null when unknown. */
  initiator: string | null;
}

const KEEP_MS = 10_000;
const MAX = 2000;

const originOf = (u: string | null | undefined): string | null => {
  if (!u) return null;
  try {
    const o = new URL(u).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
};

export class RequestKinds {
  private q = new Map<string, Array<RequestKind & { at: number }>>();
  private n = 0;

  constructor(private now: () => number = Date.now) {}

  /**
   * One request as webRequest saw it. `frameUrl` is the frame making the request (for a frame being loaded, that new frame,
   * which has no document yet); `parentUrl` its parent.
   */
  record(d: { method: string; url: string; type: string; frameUrl?: string | null; parentUrl?: string | null; referrer?: string | null }): void {
    const type = (d.type || "other") as ResourceType;
    const initiator =
      type === "mainFrame" ? originOf(d.referrer) : type === "subFrame" ? (originOf(d.parentUrl) ?? originOf(d.referrer)) : (originOf(d.frameUrl) ?? originOf(d.referrer));
    const key = `${d.method.toUpperCase()} ${d.url}`;
    const list = this.q.get(key) ?? [];
    list.push({ type, initiator, at: this.now() });
    this.q.set(key, list);
    if (++this.n % 200 === 0) this.prune();
  }

  /** The kind of the oldest waiting request for this method and address, used once; null when none was seen. */
  take(method: string, url: string): RequestKind | null {
    const key = `${method.toUpperCase()} ${url}`;
    const list = this.q.get(key);
    if (!list) return null;
    const t = this.now();
    while (list.length && t - list[0]!.at > KEEP_MS) list.shift();
    const k = list.shift();
    if (!list.length) this.q.delete(key);
    return k ? { type: k.type, initiator: k.initiator } : null;
  }

  private prune(): void {
    const t = this.now();
    for (const [key, list] of this.q) {
      const kept = list.filter((x) => t - x.at <= KEEP_MS);
      if (kept.length) this.q.set(key, kept);
      else this.q.delete(key);
    }
    while (this.q.size > MAX) this.q.delete(this.q.keys().next().value as string);
  }
}
