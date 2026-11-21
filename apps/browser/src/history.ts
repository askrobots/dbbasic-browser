/**
 * Browsing history: the pages you visit, kept on your askrobots.com account so you can find one later by the words you
 * remember. Electron-free (main.ts tells it what the tabs do and gives it the connection), so it is unit-tested.
 *
 * Rules (the point of the design):
 *  - Only while signed in to askrobots with the "history" permission. Signed out: nothing is recorded, nothing kept.
 *  - Never recorded: anything but http(s); sign-in and payment pages (by address, by title, or a visible password field);
 *    this machine and the private network; sites on the never-record list; anything while paused or while the caller
 *    network is on. Glances shorter than MIN_SECONDS are not visits.
 *  - Addresses lose their fragment, user info and every query parameter except the few that say which page it is
 *    (YouTube's v and list, Hacker News' id). askrobots keeps the same list, as a backstop.
 *  - Text: the page's visible text, at most 50,000 bytes.
 *  - A visit is sent when the tab leaves the page, or once it has been open SEND_OPEN_AFTER seconds (a page you keep
 *    reading is still history; it is then sent with the seconds so far, once). Quitting sends every open page.
 *  - Visits wait in a small in-memory queue (sent in batches, kept while offline). Signing out or in again empties it,
 *    so one person's pages never go to another person's account. Forgetting also takes matching visits out of the queue.
 *    Pages already open when history switches on (signing in, resuming) count from that moment.
 *  - Nothing here goes to the search site: only the askrobots account's own history tools.
 */

export const MIN_SECONDS = 2;
/** A page still open after this long is sent without waiting for the tab to leave it. */
export const SEND_OPEN_AFTER = 30;
export const MAX_TEXT_BYTES = 50_000;
export const QUEUE_CAP = 1000;
export const BATCH = 100;

/** Query parameters that say which page it is, per site (www. and m. removed). Every other parameter is dropped. */
const KEEP_PARAMS: Record<string, string[]> = {
  "youtube.com": ["v", "list"],
  "news.ycombinator.com": ["id"],
};

/** The host without "www." or "m.", lower case. */
export function bareHost(host: string): string {
  return host.toLowerCase().replace(/^(www|m)\./, "");
}

/** The address as history keeps it, or null when it is not a web page. */
export function cleanHistoryUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.username = "";
  u.password = "";
  const keep = KEEP_PARAMS[bareHost(u.hostname)] ?? [];
  const kept = new URLSearchParams();
  for (const [k, v] of u.searchParams) if (keep.includes(k)) kept.append(k, v);
  u.search = kept.toString();
  return u.href;
}

const SIGN_IN_HOSTS = /^(login|signin|sso|auth|accounts|account|checkout|pay|payments|secure|billing)\./i;
const SIGN_IN_SITES = new Set(["accounts.google.com", "paypal.com", "stripe.com", "checkout.stripe.com", "appleid.apple.com", "login.microsoftonline.com", "login.live.com", "id.atlassian.com"]);
const SIGN_IN_PATHS = /\/(log-?in|sign-?in|sign-?up|oauth2?|authorize|sso|checkout|payment|payments|pay|billing|account\/security|password|reset-password|2fa|mfa)(\/|$|\.)/i;
const SIGN_IN_TITLES = /^\s*(sign in|log in|login|sign up|checkout|payment|pay|two-step verification)\b/i;

/** This machine or the private network: never history (development servers, routers, printers). */
function privateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "::1" || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) || /^f[cd][0-9a-f]{2}:/.test(h);
}

/** Does this site (or a parent of it) appear on the never-record list? Entries are bare hosts and cover subdomains. */
export function onNeverList(host: string, never: readonly string[]): boolean {
  const h = bareHost(host);
  return never.some((n) => {
    const b = bareHost(n);
    return b && (h === b || h.endsWith("." + b));
  });
}

export type SkipReason = "not-web" | "private-network" | "sign-in-or-payment" | "never-this-site";

/** Why a page is never recorded, or null when it may be. (Pausing, sign-in and time on page are decided by the service.) */
export function skipReason(p: { url: string; title?: string; hasPassword?: boolean }, never: readonly string[] = [], allowPrivate = false): SkipReason | null {
  let u: URL;
  try {
    u = new URL(p.url);
  } catch {
    return "not-web";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "not-web";
  if (!allowPrivate && privateHost(u.hostname)) return "private-network";
  const host = u.hostname.toLowerCase();
  if (p.hasPassword || SIGN_IN_HOSTS.test(host) || SIGN_IN_SITES.has(bareHost(host)) || SIGN_IN_PATHS.test(u.pathname) || SIGN_IN_TITLES.test(p.title ?? "")) return "sign-in-or-payment";
  if (onNeverList(host, never)) return "never-this-site";
  return null;
}

/** At most `max` bytes of UTF-8, cut on a character boundary, without NUL characters. */
export function clipText(text: string, max = MAX_TEXT_BYTES): string {
  const t = text.replace(/\u0000/g, "");
  if (Buffer.byteLength(t, "utf8") <= max) return t;
  const b = Buffer.from(t, "utf8").subarray(0, max);
  return b.toString("utf8").replace(/�$/, "");
}

export interface Visit {
  url: string;
  title?: string;
  visited_at: string;
  seconds_on_page: number;
  text?: string;
}

export interface HistoryState {
  /** Signed in with the history permission: pages are being recorded (unless paused). */
  on: boolean;
  /** Why it is off, in a few words, when it is. */
  why?: string;
  paused: boolean;
  neverSites: string[];
  queued: number;
  sent: number;
  /** The last time visits reached askrobots, and the last problem, if any. */
  lastSentAt?: number;
  error?: string;
}

/**
 * A page without a title shows its address as the title, parameters and all. That is not a title (and would keep the
 * parameters cleanHistoryUrl drops), so it becomes "".
 */
export function realTitle(title: string, rawUrl: string): string {
  const t = title.trim();
  if (!t) return "";
  const bare = (u: string) => u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/$/, "");
  if (bare(t) === bare(rawUrl) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || bare(rawUrl).startsWith(bare(t)) && /[/:]/.test(t)) return "";
  return t;
}

/** Which visits a forget covers (for the copy kept here: see history-copy.ts). `at` is when the visit was, in ms. */
export function forgetMatch(scope: "url" | "last_hour" | "site" | "all", target: string | undefined, now: number): (v: { url: string; at: number }) => boolean {
  if (scope === "all") return () => true;
  if (scope === "last_hour") return (v) => v.at >= now - 3600_000;
  if (scope === "url") {
    const url = target ? cleanHistoryUrl(target) : null;
    return (v) => !!url && v.url === url;
  }
  let site = "";
  try {
    site = target ? bareHost(target.includes("://") ? new URL(target).hostname : target) : "";
  } catch {
    site = "";
  }
  return (v) => {
    try {
      return !!site && onNeverList(new URL(v.url).hostname, [site]);
    } catch {
      return false;
    }
  };
}

export interface HistoryDeps {
  /** Call one of the account's history tools; resolves to the tool's text. */
  call(tool: string, args: Record<string, unknown>): Promise<string>;
  /** Signed in, with the history permission granted. */
  connected(): boolean;
  /** A short reason when not connected ("not signed in", "connect again to allow history"). */
  whyOff(): string;
  callerNetworkOn(): boolean;
  now(): number;
  changed?(state: HistoryState): void;
  /** Tests only: record pages on this machine (the stand-in server runs on 127.0.0.1). */
  allowPrivateHosts?: boolean;
}

interface Open {
  url: string;
  /** The address as the tab had it (only to tell a missing title, which shows as the address, from a real one). */
  raw: string;
  title: string;
  startedAt: number;
  text?: string;
  hasPassword?: boolean;
  /** Already queued while still open (see SEND_OPEN_AFTER); leaving it adds nothing more. */
  queued?: boolean;
}

export class HistoryService {
  private open = new Map<number, Open>();
  private queue: Visit[] = [];
  private paused = false;
  private never: string[] = [];
  private sent = 0;
  private lastSentAt: number | undefined;
  private error: string | undefined;
  private flushing: Promise<void> | null = null;

  constructor(private d: HistoryDeps) {}

  state(): HistoryState {
    const on = this.d.connected() && !this.d.callerNetworkOn();
    return {
      on,
      ...(on ? {} : { why: this.d.callerNetworkOn() ? "off while the caller network is on" : this.d.whyOff() }),
      paused: this.paused,
      neverSites: [...this.never],
      queued: this.queue.length,
      sent: this.sent,
      ...(this.lastSentAt ? { lastSentAt: this.lastSentAt } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  private emit(): void {
    this.d.changed?.(this.state());
  }

  /** A tab's main frame now shows this address (a new page, or the same page at a new address). */
  shown(tab: number, url: string, title = ""): void {
    const clean = cleanHistoryUrl(url);
    const cur = this.open.get(tab);
    if (cur && clean && cur.url === clean) return; // the same page (a fragment change, a dropped parameter)
    this.left(tab);
    if (clean) this.open.set(tab, { url: clean, title: realTitle(title, url), startedAt: this.d.now(), raw: url });
  }

  title(tab: number, title: string): void {
    const cur = this.open.get(tab);
    if (cur) cur.title = realTitle(title, cur.raw);
  }

  /** What the page says (its visible text), and whether a password field is showing. */
  text(tab: number, url: string, text: string, hasPassword: boolean): void {
    const cur = this.open.get(tab);
    if (!cur || cur.url !== cleanHistoryUrl(url)) return; // the tab has moved on
    cur.text = clipText(text);
    cur.hasPassword = cur.hasPassword || hasPassword;
  }

  /** The tab moved away from its page or closed: the visit is complete. */
  left(tab: number): void {
    const cur = this.open.get(tab);
    if (!cur) return;
    this.open.delete(tab);
    if (this.enqueue(cur)) this.emit();
  }

  /** Every tab leaves its page (the browser is quitting). */
  leaveAll(): void {
    for (const tab of [...this.open.keys()]) this.left(tab);
  }

  /** Queue pages that have been open SEND_OPEN_AFTER seconds or more, once each. */
  private queueLongOpen(): void {
    if (!this.d.connected() || this.d.callerNetworkOn() || this.paused) return;
    let any = false;
    for (const cur of this.open.values()) {
      if (cur.queued || this.d.now() - cur.startedAt < SEND_OPEN_AFTER * 1000) continue;
      if (this.enqueue(cur)) any = true;
      cur.queued = true; // (also when skipped: the answer will not change while it stays open)
    }
    if (any) this.emit();
  }

  /** Pages open right now start counting again from this moment (history has just switched on). */
  private restartOpen(): void {
    const now = this.d.now();
    for (const cur of this.open.values()) {
      cur.startedAt = now;
      cur.queued = false;
    }
  }

  /** Add one visit to the queue if it is one we record. True when it was added. */
  private enqueue(cur: Open): boolean {
    if (cur.queued) return false;
    const seconds = Math.round((this.d.now() - cur.startedAt) / 1000);
    if (seconds < MIN_SECONDS) return false;
    if (!this.d.connected() || this.d.callerNetworkOn() || this.paused) return false;
    if (skipReason({ url: cur.url, title: cur.title, hasPassword: !!cur.hasPassword }, this.never, this.d.allowPrivateHosts)) return false;
    this.queue.push({
      url: cur.url,
      ...(cur.title ? { title: cur.title.slice(0, 500) } : {}),
      visited_at: new Date(cur.startedAt).toISOString(),
      seconds_on_page: seconds,
      ...(cur.text ? { text: cur.text } : {}),
    });
    if (this.queue.length > QUEUE_CAP) this.queue.splice(0, this.queue.length - QUEUE_CAP); // the oldest go first
    return true;
  }

  /** Send what is waiting, in batches. Failures leave the visits queued for the next try. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.queueLongOpen();
    // (The lock is cleared in .finally, which always runs after this assignment, even when there is nothing to send.)
    this.flushing = this.sendQueued().finally(() => {
      this.flushing = null;
      this.emit();
    });
    return this.flushing;
  }

  private async sendQueued(): Promise<void> {
    while (this.queue.length && this.d.connected() && !this.d.callerNetworkOn()) {
      const batch = this.queue.slice(0, BATCH);
      let res: { accepted?: number; duplicates?: number; paused?: boolean; error?: string };
      try {
        res = JSON.parse(await this.d.call("add_history", { visits: batch })) as typeof res;
      } catch (e) {
        this.error = e instanceof Error ? e.message.slice(0, 200) : String(e);
        return;
      }
      if (res.error) {
        // e.g. over the plan's storage: nothing in the batch was kept; keep it here and say so
        this.error = String(res.error).slice(0, 200);
        return;
      }
      // (A batch only leaves the queue once the account has it; anything added meanwhile stays behind it.)
      this.queue.splice(0, batch.length);
      this.sent += res.accepted ?? 0;
      this.lastSentAt = this.d.now();
      this.error = undefined;
      if (res.paused) this.paused = true;
    }
  }

  /** Signed out, or signed in again (perhaps as someone else): nothing waiting may go to the new account. */
  resetAccount(): void {
    this.queue = [];
    this.restartOpen(); // what the tabs show now is not lost, but nothing from before counts
    this.sent = 0;
    this.lastSentAt = undefined;
    this.error = undefined;
    this.emit();
  }

  /** Read pause and the never-record list from the account. */
  async loadSettings(): Promise<void> {
    if (!this.d.connected()) return;
    try {
      this.applySettings(JSON.parse(await this.d.call("history_settings", {})));
    } catch (e) {
      this.error = e instanceof Error ? e.message.slice(0, 200) : String(e);
      this.emit();
    }
  }

  private applySettings(s: { paused?: unknown; never_sites?: unknown; error?: unknown }): void {
    if (typeof s.error === "string") throw new Error(s.error);
    if (typeof s.paused === "boolean") this.paused = s.paused;
    if (Array.isArray(s.never_sites)) this.never = s.never_sites.filter((x): x is string => typeof x === "string");
    this.emit();
  }

  /** Pause or resume, here and on the account. Pausing also drops the time spent so far on the pages open now. */
  async setPaused(paused: boolean): Promise<HistoryState> {
    this.paused = paused;
    this.restartOpen(); // paused: what is open now is not recorded; resumed: it counts from now
    this.emit();
    if (this.d.connected()) this.applySettings(JSON.parse(await this.d.call("history_settings", { paused })));
    return this.state();
  }

  /** Never record this site again (it and its subdomains). Past visits stay until forgotten. */
  async neverRecord(host: string): Promise<HistoryState> {
    const h = bareHost(host);
    if (!h) return this.state();
    const list = [...new Set([...this.never, h])];
    this.never = list;
    this.queue = this.queue.filter((v) => !onNeverList(new URL(v.url).hostname, [h]));
    this.emit();
    if (this.d.connected()) this.applySettings(JSON.parse(await this.d.call("history_settings", { never_sites: list })));
    return this.state();
  }

  /** Forget: one page, the last hour, a site, or everything. Takes matching visits out of the queue too. */
  async forget(scope: "url" | "last_hour" | "site" | "all", target?: string): Promise<{ forgotten: number }> {
    const hourAgo = this.d.now() - 3600_000;
    const url = scope === "url" && target ? cleanHistoryUrl(target) : null;
    const site = scope === "site" && target ? bareHost(target.includes("://") ? new URL(target).hostname : target) : null;
    const gone = (v: Visit) =>
      scope === "all" ||
      (scope === "last_hour" && Date.parse(v.visited_at) >= hourAgo) ||
      (scope === "url" && v.url === url) ||
      (scope === "site" && !!site && onNeverList(new URL(v.url).hostname, [site]));
    const before = this.queue.length;
    this.queue = this.queue.filter((v) => !gone(v));
    if (scope === "all" || scope === "last_hour") this.open.clear();
    else for (const [tab, o] of this.open) if (gone({ url: o.url, visited_at: new Date(o.startedAt).toISOString(), seconds_on_page: 0 })) this.open.delete(tab);
    let forgotten = before - this.queue.length;
    if (this.d.connected()) {
      const res = JSON.parse(await this.d.call("forget_history", { scope, ...(url ? { url } : {}), ...(site ? { site } : {}) })) as { forgotten?: number; error?: string };
      if (res.error) throw new Error(res.error);
      forgotten += res.forgotten ?? 0;
    }
    this.emit();
    return { forgotten };
  }
}
