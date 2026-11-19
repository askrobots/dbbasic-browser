/**
 * Electron side of "has this page finished loading?" (the decision itself is src/settle.ts).
 *
 * Gathers a snapshot from three places and loops until the pure decision says done:
 *   - lifecycle events for the tab's page: did it crash, fail to load, turn into a download, what status did
 *     the main document get (tracked per webContents from the moment the tab exists);
 *   - the network layer's view, via the chrome UI (which already follows every request of every tab);
 *   - the page itself: load state, fonts, visible images, how much text there is.
 * When everything else holds it compares two frames a moment apart.
 *
 * The call always returns: a hard guard ends it shortly after the deadline even if a probe hangs.
 */

import { createHash } from "node:crypto";
import { webContents, type WebContents } from "electron";
import { newMemo, resolveConfig, step, type FailureKind, type FailureSource, type SettleConfig, type Snapshot, type Verdict } from "./settle.js";
import { netEvents, type NetEvent } from "./transport.js";

export interface Lifecycle {
  /** Top-level navigations in the current visit (a visit starts when the BROWSER navigates, e.g. a goto). */
  navigations: number;
  /** Times the PAGE moved itself after it began (a script, a meta refresh, a link click) — not server redirects. */
  moves: Array<{ to: string; afterMs: number }>;
  visitStart: number;
  crashed: boolean;
  failed: { description: string; code?: number; kind?: FailureKind; source?: FailureSource } | null;
  /** A document the caller handed over already fetched: the redirects that led to it, for the facts. */
  known: { url: string; redirects: Array<{ status?: number; to: string }> } | null;
  download: string | null;
  status: number | null;
}

const lifecycles = new Map<number, Lifecycle>();

/**
 * Chromium reports any failure inside our network layer as a generic error (ERR_FAILED / ERR_UNEXPECTED), but the
 * layer itself knows the real one (ERR_NAME_NOT_RESOLVED, ERR_CONNECTION_RESET…). Remember it by URL, so that
 * when did-fail-load names the failing URL we can say why — with no dependence on which event arrives first.
 */
const recentErrors = new Map<string, { description: string; kind?: FailureKind; source?: FailureSource }>();
const normUrl = (u: string) => {
  try {
    return new URL(u).href;
  } catch {
    return u;
  }
};
/** The status of the latest real (non-redirect) response for each address, as seen by the network layer. */
const statusSeen = new Map<string, number>();
netEvents.on("event", (e: NetEvent) => {
  if (e.type === "start") statusSeen.delete(normUrl(e.url)); // a new request for this address: whatever we knew is stale
  else if (e.type === "headers" && e.status !== undefined) {
    statusSeen.set(normUrl(e.url), e.status);
    while (statusSeen.size > 200) statusSeen.delete(statusSeen.keys().next().value as string);
  }
  if (e.type !== "error" || !e.error) return;
  recentErrors.set(normUrl(e.url), { description: e.error.replace(/^net::/, ""), ...(e.failureKind ? { kind: e.failureKind as FailureKind } : {}), ...(e.failureSource ? { source: e.failureSource } : {}) });
  while (recentErrors.size > 200) recentErrors.delete(recentErrors.keys().next().value as string);
});

export function lifecycleOf(wcId: number): Lifecycle {
  let l = lifecycles.get(wcId);
  if (!l) {
    l = { navigations: 0, moves: [], visitStart: Date.now(), crashed: false, failed: null, known: null, download: null, status: null };
    lifecycles.set(wcId, l);
  }
  return l;
}

/** Start following a page's lifecycle. Call once per webview, when it is created. */
export function trackLifecycle(wc: WebContents): void {
  const l = lifecycleOf(wc.id);
  const isErrorPage = (url: string) => url.startsWith("chrome-error://");
  wc.on("did-start-navigation", (details) => {
    // A new top-level navigation starts a fresh outcome; same-document changes (#hash, pushState) don't. When a load
    // fails, Chromium then navigates to its own error page: that must not erase the failure that caused it.
    if (details.isMainFrame && !details.isSameDocument && !isErrorPage(details.url)) {
      const now = Date.now();
      // A navigation has an initiator frame when the PAGE started it, and none when the browser did. Server
      // redirects are not navigations here at all (they continue the same one), so they never count as moves.
      if (!details.initiator) {
        if (l.known && normUrl(l.known.url) !== normUrl(details.url)) l.known = null; // a different address: not that document
        l.navigations = 0;
        l.moves = [];
        l.visitStart = now; // the browser (or a caller) began a new visit
      } else {
        l.moves.push({ to: details.url, afterMs: now - l.visitStart });
      }
      l.navigations++;
      l.failed = null;
      l.download = null;
      l.status = null;
      l.crashed = false;
    }
  });
  wc.on("did-navigate", (_e, url, httpResponseCode) => {
    if (isErrorPage(url)) return;
    l.status = httpResponseCode > 0 ? httpResponseCode : null; // -1 for non-HTTP navigations
  });
  wc.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = aborted by a newer navigation
    const seen = recentErrors.get(normUrl(url));
    l.failed = { description: seen?.description ?? String(description).replace(/^net::/, ""), code, ...(seen?.kind ? { kind: seen.kind } : {}), ...(seen?.source ? { source: seen.source } : {}) };
  });
  wc.on("render-process-gone", () => {
    l.crashed = true;
  });
  wc.once("destroyed", () => lifecycles.delete(wc.id));
}

/** A document the caller handed over already fetched: remember the redirects that led to it, for the facts. */
export function noteKnownDocument(wcId: number, url: string, redirects: Array<{ status?: number; to: string }>): void {
  lifecycleOf(wcId).known = { url, redirects };
}

/** A download started in this page instead of a navigation completing. */
export function noteDownload(wcId: number, name: string): void {
  lifecycleOf(wcId).download = name;
}

// ---- probes -----------------------------------------------------------------------------------------

/** Runs in the page. Visible images are decoded (briefly awaited); everything is capped so it cannot hang. */
const PROBE_JS = `(async () => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth &&
      getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none";
  };
  const imgs = [...document.images].filter(visible);
  const pending = imgs.filter((i) => !i.complete).length;
  const decodable = imgs.filter((i) => i.complete && i.naturalWidth > 0);
  await Promise.race([Promise.all(decodable.map((i) => i.decode().catch(() => {}))), new Promise((r) => setTimeout(r, 800))]);
  const text = ((document.body && document.body.innerText) || "").trim();
  return {
    readyState: document.readyState,
    fonts: document.fonts ? document.fonts.status : "loaded",
    imagesPending: pending,
    textLength: text.length,
    hasMedia: !!document.querySelector("canvas, video, picture, svg, img"),
  };
})()`;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<null>((r) => (t = setTimeout(() => r(null), ms)))]);
  } finally {
    clearTimeout(t);
  }
}

async function probePage(wc: WebContents): Promise<Snapshot["page"]> {
  try {
    const v = (await withTimeout(wc.executeJavaScript(PROBE_JS, false), 1500)) as Snapshot["page"] | null;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null; // the page is mid-navigation or has a hostile CSP
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A small, stable signature of what is on screen right now. */
async function frameSignature(wc: WebContents): Promise<string | null> {
  try {
    const img = await withTimeout(wc.capturePage(), 3000);
    if (!img || img.isEmpty()) return null;
    return createHash("sha1").update(img.resize({ width: 96 }).toBitmap()).digest("hex");
  } catch {
    return null;
  }
}

async function framesMatch(wc: WebContents, gapMs: number): Promise<boolean> {
  const a = await frameSignature(wc);
  await sleep(gapMs);
  const b = await frameSignature(wc);
  return a !== null && a === b;
}

// ---- the wait ---------------------------------------------------------------------------------------

/** What the chrome UI (which follows every request of every tab) reports for a tab. */
export interface NetState {
  url: string;
  title: string;
  state: string | null;
  pay: "pending" | "refused" | null;
  inFlight: Snapshot["net"]["inFlight"];
  sinceActivityMs: number;
  stats: { requests: number; bytes: number; hosts: string[]; redirects: Array<{ status?: number; to: string }> };
}

export interface SettleContext {
  tabId: number;
  wcId: number;
  askChrome(op: string, args: Record<string, unknown>): Promise<unknown>;
  /** Is a request for this address waiting on a caller-supplied network layer? */
  isWithCaller?(url: string): boolean;
}

export interface SettleResult extends Verdict {
  final: { url: string; title: string };
  requests: number;
  bytes: number;
  hosts: string[];
  redirects: Array<{ status?: number; to: string }>;
  /** Times the PAGE moved itself after loading (script, meta refresh, link), apart from the server redirects above. */
  moves: Array<{ to: string; afterMs: number }>;
  /** Time spent waiting on a caller-supplied network layer (not counted toward the deadline). */
  waitedOnCallerMs: number;
}

export async function runSettle(ctx: SettleContext, input: unknown): Promise<SettleResult> {
  const cfg: SettleConfig = resolveConfig(input);
  const t0 = Date.now();
  const memo = newMemo();
  let last: NetState | null = null;
  let callerWaitMs = 0;
  let lastTick = t0;
  let prevWithCaller = false;

  const known = lifecycleOf(ctx.wcId).known;
  const finish = (v: Verdict): SettleResult => ({
    ...v,
    final: { url: last?.url ?? "", title: last?.title ?? "" },
    requests: last?.stats.requests ?? 0,
    bytes: last?.stats.bytes ?? 0,
    hosts: last?.stats.hosts ?? [],
    redirects: [...(known && last && normUrl(last.url) === normUrl(known.url) ? known.redirects : []), ...(last?.stats.redirects ?? [])],
    waitedOnCallerMs: Math.round(callerWaitMs),
    moves: [...lifecycleOf(ctx.wcId).moves],
  });

  const loop = async (): Promise<SettleResult> => {
    for (;;) {
      const wc = webContents.fromId(ctx.wcId);
      const l = lifecycleOf(ctx.wcId);
      if (!wc || wc.isDestroyed()) return finish({ settled: false, outcome: "crashed", rule: "crashed", waitedMs: Date.now() - t0 });
      let net: NetState;
      try {
        net = (await ctx.askChrome("tab.netState", { id: ctx.tabId })) as NetState;
      } catch {
        return finish({ settled: false, outcome: "deadline", rule: "deadline", waitedMs: Date.now() - t0, blockedBy: [{ rule: "page-unreachable", detail: "the tab is gone" }] });
      }
      last = net;
      // A request the caller has not answered yet is its own state, apart from "the server is slow".
      const inFlight = net.inFlight.map((r) => (ctx.isWithCaller?.(r.url) ? { ...r, phase: "caller" as const } : r));
      const page = await probePage(wc);
      // (after the probe: a slow probe is time the caller was holding the request, and the deadline check below must see it)
      const nowTick = Date.now();
      const withCallerNow = inFlight.some((r) => r.phase === "caller");
      // The interval counts if the caller had a request at either end of it (a slow probe in between must not hide the wait).
      if (withCallerNow || prevWithCaller) callerWaitMs += nowTick - lastTick;
      prevWithCaller = withCallerNow;
      lastTick = nowTick;
      const snap: Snapshot = {
        nowMs: Date.now() - t0,
        // The status of the page we ended on. Neither the navigation event nor the page's own timing entry can be used:
        // after a redirect chain both still say 302. The network layer saw every real response, so ask it.
        lifecycle: { ...l, status: statusSeen.get(normUrl(net.url)) ?? l.status },
        net: { inFlight, sinceActivityMs: net.sinceActivityMs, state: net.state, pay: net.pay },
        page,
        callerWaitMs,
      };
      let r = step(snap, cfg, memo);
      if (!r.done && r.action === "check-frames") {
        const matched = await framesMatch(wc, cfg.frameGapMs);
        r = step({ ...snap, nowMs: Date.now() - t0, frames: { matched }, callerWaitMs }, cfg, memo);
      }
      // If the page moved itself while we were deciding, the verdict is about a page we have already left.
      if (r.done && r.verdict.settled && ["quiet", "frames-match", "animating"].includes(r.verdict.rule) && lifecycleOf(ctx.wcId).navigations !== snap.lifecycle.navigations) {
        memo.okSince = null;
        await sleep(cfg.pollMs);
        continue;
      }
      if (r.done) return finish(r.verdict);
      await sleep(cfg.pollMs);
    }
  };

  // A probe can hang on a broken page; whatever happens, the call returns shortly after the deadline.
  // The hard guard does not count time spent waiting on the caller either; that wait has its own bound.
  const guardWait = async () => { while (!over && Date.now() - t0 - callerWaitMs < cfg.timeoutMs + 5000) await sleep(250); };
  let over = false;
  const guard = guardWait().then((): SettleResult => finish({ settled: false, outcome: "deadline", rule: "deadline", waitedMs: Date.now() - t0, blockedBy: [{ rule: "page-unreachable", detail: "the page stopped answering" }] }));
  return Promise.race([loop(), guard]).finally(() => { over = true; });
}
