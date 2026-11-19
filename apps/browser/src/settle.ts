/**
 * "Has this page finished loading?" — decided from what the browser actually observes, not from a guess.
 *
 * Outside tools wait by polling for "loaded", "network quiet for half a second" or a fixed sleep, and when
 * they give up all they know is that time passed. This runs inside the browser, where the network layer
 * can tell a finished page from one that is still receiving, and it answers two separate questions:
 *
 *   rule     — WHAT ENDED THE WAIT: the page settled (and which test proved it), or the deadline hit
 *   outcome  — WHAT HAPPENED: fine, an error status, a blank page, a failed load (and why), a crash,
 *              a bot check, a payment request, a download instead of a page
 *
 * A page counts as settled when ALL of these hold: the load event fired; no request is in flight, other than
 * long-lived streams that never finish by design (server-sent events, held-open responses); nothing has
 * moved on the network for `quietMs`; web fonts are in; the visible images are in; and (unless turned off)
 * two frames a moment apart are identical. A page that animates forever never matches, so after
 * `frameTimeoutMs` it settles as "animating" instead of waiting for the deadline.
 *
 * The decision is a pure function of a snapshot so it can be tested without a browser; src/settle-service.ts
 * gathers the snapshots. Known limit: WebSockets bypass the network layer, so a socket-driven page can look
 * quiet while it is still receiving.
 */

export interface SettleConfig {
  /** Hard limit; at this point the call returns whatever happened, with what was still unmet. */
  timeoutMs: number;
  /** No request activity (outside long-lived streams) for this long. */
  quietMs: number;
  /** Compare two frames `frameGapMs` apart before calling the page settled. */
  frames: boolean;
  frameGapMs: number;
  /** After every other rule holds, how long to wait for two matching frames before calling it "animating". */
  frameTimeoutMs: number;
  /** A response with headers but no Content-Length that is still open after this long counts as a stream. */
  streamAfterMs: number;
  pollMs: number;
}

export const SETTLE_DEFAULTS: SettleConfig = {
  timeoutMs: 30_000,
  quietMs: 500,
  frames: true,
  frameGapMs: 250,
  frameTimeoutMs: 3_000,
  streamAfterMs: 1_000,
  pollMs: 100,
};

/** Clamp caller-supplied options to sane values; unknown or invalid ones fall back to the defaults. */
export function resolveConfig(input: unknown): SettleConfig {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const num = (k: keyof SettleConfig, min: number, max: number) => {
    const v = Number(o[k]);
    return Number.isFinite(v) && o[k] !== undefined ? Math.min(max, Math.max(min, v)) : (SETTLE_DEFAULTS[k] as number);
  };
  return {
    timeoutMs: num("timeoutMs", 500, 300_000),
    quietMs: num("quietMs", 0, 10_000),
    frames: o.frames === undefined ? SETTLE_DEFAULTS.frames : o.frames !== false,
    frameGapMs: num("frameGapMs", 50, 2_000),
    frameTimeoutMs: num("frameTimeoutMs", 0, 30_000),
    streamAfterMs: num("streamAfterMs", 100, 60_000),
    pollMs: num("pollMs", 20, 1_000),
  };
}

export type Rule =
  | "quiet" // every rule held (frames check off)
  | "frames-match" // every rule held and two frames a moment apart were identical
  | "animating" // every rule held but the frames never matched: the page keeps changing on its own
  | "navigation-failed"
  | "crashed"
  | "download"
  | "payment"
  | "deadline";

export type Outcome =
  | "ok"
  | "error-status" // the page loaded, but the server answered 4xx/5xx
  | "blank" // it loaded and settled, but there is nothing on it
  | "failed"
  | "crashed"
  | "bot-check"
  | "payment-required"
  | "not-a-page" // the address was a download, not a page
  | "deadline"; // gave up; `blockedBy` says what was still unmet

export const FAILURE_KINDS = ["could-not-find-site", "could-not-connect", "certificate", "redirect-loop", "offline", "timed-out", "blocked", "other", "caller-silent"] as const;
/** Why a load failed. "caller-silent" = a caller-supplied network layer did not answer within its own bound (not "server too slow"). */
export type FailureKind = (typeof FAILURE_KINDS)[number];
/** Who decided it: the browser saw it happen, or the caller said so. */
export type FailureSource = "observed" | "caller";

/** Map Chromium's error description (e.g. "ERR_CERT_DATE_INVALID") to a reason a person can act on. */
export function classifyFailure(description: string): FailureKind {
  const d = String(description || "").toUpperCase();
  if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|DNS/.test(d)) return "could-not-find-site";
  if (/ERR_CERT|ERR_SSL|CERTIFICATE|ERR_BAD_SSL|ERR_SECURITY/.test(d)) return "certificate";
  if (/TOO_MANY_REDIRECTS|REDIRECT_LOOP/.test(d)) return "redirect-loop";
  if (/INTERNET_DISCONNECTED|NETWORK_CHANGED|ERR_NETWORK_ACCESS|PROXY/.test(d)) return "offline";
  if (/TIMED_OUT|TIMEOUT/.test(d)) return "timed-out";
  if (/BLOCKED|ERR_ACCESS_DENIED|ERR_ABORTED_BY_BLOCKER/.test(d)) return "blocked";
  if (/ERR_CONNECTION|ERR_EMPTY_RESPONSE|ERR_ADDRESS|ERR_SOCKET|ERR_CONNECT|REFUSED|RESET/.test(d)) return "could-not-connect";
  return "other";
}

export interface InFlight {
  url: string;
  /** "caller": a caller-supplied network layer has the request and has not answered yet. */
  phase: "waiting" | "receiving" | "caller";
  ageMs: number;
  /** Headers arrived but the body is open-ended (event stream, or no Content-Length for a long time). */
  longLived: boolean;
}

export interface Snapshot {
  /** Milliseconds since the wait began. */
  nowMs: number;
  lifecycle: {
    crashed: boolean;
    failed: { description: string; code?: number; kind?: FailureKind; source?: FailureSource } | null;
    /** File name of a download that started instead of a page. */
    download: string | null;
    /** HTTP status of the main document, once known. */
    status: number | null;
    /** How many top-level navigations this visit has made so far (the page moving itself adds to it). */
    navigations?: number;
  };
  net: {
    inFlight: InFlight[];
    /** Time since the last request activity that is not a long-lived stream. */
    sinceActivityMs: number;
    /** The tab's own state ("challenge" while a bot check runs, …). */
    state: string | null;
    /** An x402 payment waiting for a decision, or refused. */
    pay: "pending" | "refused" | null;
  };
  /** What the page itself says; null if it could not be asked. */
  page: { readyState: string; fonts: string; imagesPending: number; textLength: number; hasMedia: boolean } | null;
  /** Result of the latest two-frame comparison, if one has been made. */
  frames?: { matched: boolean };
  /** Time spent waiting on a caller-supplied network layer. It does not count toward the deadline: the caller's own bound ends that wait. */
  callerWaitMs?: number;
}

export interface Blocker {
  rule: "load-event" | "caller" | "network" | "network-quiet" | "fonts" | "images" | "page-unreachable";
  detail?: string;
}

export interface Verdict {
  settled: boolean;
  outcome: Outcome;
  rule: Rule;
  waitedMs: number;
  status?: number;
  /** For outcome "error-status": the server asked us to slow down (HTTP 429). */
  slowDown?: boolean;
  failure?: { kind: FailureKind; description: string; source: FailureSource };
  download?: string;
  /** For the deadline: what was still unmet. */
  blockedBy?: Blocker[];
  /** True when frames never matched: the page keeps changing by itself. */
  animating?: boolean;
  /** Long-lived streams that were ignored (a page can be finished while holding one open). */
  streams?: number;
}

export interface Memo {
  /** When every rule except frames first held, continuously. */
  okSince: number | null;
  /** The navigation count last seen: a page that navigates itself restarts the wait. */
  navs: number | null;
}

export type Step = { done: true; verdict: Verdict } | { done: false; action?: "check-frames" };

export const newMemo = (): Memo => ({ okSince: null, navs: null });

/** The unmet rules in a snapshot (empty = everything holds, apart from the frame comparison). */
export function blockers(s: Snapshot, cfg: SettleConfig): Blocker[] {
  const out: Blocker[] = [];
  const withCaller = s.net.inFlight.filter((r) => r.phase === "caller");
  const pending = s.net.inFlight.filter((r) => !r.longLived && r.phase !== "caller");
  if (withCaller.length) out.push({ rule: "caller", detail: `${withCaller.length} request(s) waiting on the caller, e.g. ${withCaller[0]!.url}` });
  if (pending.length) {
    const oldest = pending.reduce((a, b) => (b.ageMs > a.ageMs ? b : a));
    out.push({ rule: "network", detail: `${pending.length} request(s) in flight, e.g. ${oldest.url} (${oldest.phase}, ${Math.round(oldest.ageMs)} ms)` });
  } else if (s.net.sinceActivityMs < cfg.quietMs) out.push({ rule: "network-quiet", detail: `activity ${Math.round(s.net.sinceActivityMs)} ms ago` });
  // While a navigation is stuck pending, the page can't be asked anything; the request that never answered is still
  // the useful answer, so it is reported first and "page-unreachable" after it.
  if (!s.page) {
    out.push({ rule: "page-unreachable" });
    return out;
  }
  if (s.page.readyState !== "complete") out.push({ rule: "load-event", detail: s.page.readyState });
  if (s.page.fonts === "loading") out.push({ rule: "fonts" });
  if (s.page.imagesPending > 0) out.push({ rule: "images", detail: `${s.page.imagesPending} visible image(s) still loading` });
  return out;
}

/** What actually happened, once we know the page settled. */
function settledOutcome(s: Snapshot): Pick<Verdict, "outcome" | "status" | "slowDown"> {
  const status = s.lifecycle.status ?? undefined;
  if (status !== undefined && status >= 400) return { outcome: "error-status", status, ...(status === 429 ? { slowDown: true } : {}) };
  if (s.page && s.page.textLength < 20 && !s.page.hasMedia) return { outcome: "blank", ...(status !== undefined ? { status } : {}) };
  return { outcome: "ok", ...(status !== undefined ? { status } : {}) };
}

const streams = (s: Snapshot) => s.net.inFlight.filter((r) => r.longLived).length;

/** How much waiting on the caller is forgiven: all of it, but never more than twice the deadline (so a call always ends within 3x). */
export const callerAllowance = (callerWaitMs: number | undefined, cfg: SettleConfig): number => Math.min(callerWaitMs ?? 0, 2 * cfg.timeoutMs);

export function step(s: Snapshot, cfg: SettleConfig, memo: Memo): Step {
  const base = { waitedMs: Math.round(s.nowMs) };
  const sc = streams(s);
  const streamField = sc ? { streams: sc } : {};

  // Things that end the wait right away, whatever else is going on.
  if (s.lifecycle.crashed) return { done: true, verdict: { settled: false, outcome: "crashed", rule: "crashed", ...base } };
  if (s.lifecycle.download) return { done: true, verdict: { settled: true, outcome: "not-a-page", rule: "download", download: s.lifecycle.download, ...base } };
  if (s.lifecycle.failed) {
    const f = s.lifecycle.failed;
    return { done: true, verdict: { settled: false, outcome: "failed", rule: "navigation-failed", failure: { kind: f.kind ?? classifyFailure(f.description), description: f.description, source: f.source ?? "observed" }, ...base } };
  }
  if (s.net.pay) return { done: true, verdict: { settled: false, outcome: "payment-required", rule: "payment", ...base } };

  // The page moved itself (a script, a meta refresh, a link): what was true of the page we were on no longer counts.
  const navs = s.lifecycle.navigations ?? null;
  if (navs !== null && memo.navs !== null && navs !== memo.navs) memo.okSince = null;
  memo.navs = navs;

  const unmet = blockers(s, cfg);
  if (unmet.length === 0) {
    memo.okSince ??= s.nowMs;
    if (!cfg.frames) return { done: true, verdict: { settled: true, rule: "quiet", ...settledOutcome(s), ...streamField, ...base } };
    if (s.frames?.matched) return { done: true, verdict: { settled: true, rule: "frames-match", ...settledOutcome(s), ...streamField, ...base } };
    if (s.nowMs - memo.okSince >= cfg.frameTimeoutMs) return { done: true, verdict: { settled: true, rule: "animating", animating: true, ...settledOutcome(s), ...streamField, ...base } };
    return { done: false, action: "check-frames" };
  }
  memo.okSince = null; // something moved again: the "everything holds" clock restarts

  // Time on the caller does not count, up to twice the deadline: a page that always has one request outstanding cannot freeze the clock for ever.
  if (s.nowMs - callerAllowance(s.callerWaitMs, cfg) >= cfg.timeoutMs) {
    const botCheck = s.net.state === "challenge";
    return { done: true, verdict: { settled: false, outcome: botCheck ? "bot-check" : "deadline", rule: "deadline", blockedBy: unmet, ...streamField, ...base } };
  }
  return { done: false };
}
