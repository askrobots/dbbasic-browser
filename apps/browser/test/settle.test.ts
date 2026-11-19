import { describe, expect, it } from "vitest";
import { SETTLE_DEFAULTS, blockers, classifyFailure, newMemo, resolveConfig, step, type Snapshot } from "../src/settle.js";

const CFG = { ...SETTLE_DEFAULTS, timeoutMs: 10_000, quietMs: 500, frameTimeoutMs: 3_000 };
const snap = (over: Partial<Snapshot> & { nowMs?: number } = {}): Snapshot => ({
  nowMs: 1000,
  lifecycle: { crashed: false, failed: null, download: null, status: 200 },
  net: { inFlight: [], sinceActivityMs: 2000, state: null, pay: null },
  page: { readyState: "complete", fonts: "loaded", imagesPending: 0, textLength: 500, hasMedia: true },
  ...over,
});
const run = (s: Snapshot, cfg = CFG, memo = newMemo()) => step(s, cfg, memo);

describe("settled: what has to hold", () => {
  it("everything holds + matching frames → settled by 'frames-match', outcome ok", () => {
    const r = run(snap({ frames: { matched: true } }));
    expect(r).toMatchObject({ done: true, verdict: { settled: true, rule: "frames-match", outcome: "ok", status: 200 } });
  });
  it("with the frame test off, everything holding settles as 'quiet'", () => {
    expect(run(snap(), { ...CFG, frames: false })).toMatchObject({ done: true, verdict: { settled: true, rule: "quiet" } });
  });
  it("asks for a frame comparison before declaring a page settled", () => {
    expect(run(snap())).toEqual({ done: false, action: "check-frames" });
  });
  it("a page that never stops changing settles as 'animating' after frameTimeoutMs", () => {
    const memo = newMemo();
    expect(step(snap({ nowMs: 1000, frames: { matched: false } }), CFG, memo)).toEqual({ done: false, action: "check-frames" });
    const r = step(snap({ nowMs: 4100, frames: { matched: false } }), CFG, memo);
    expect(r).toMatchObject({ done: true, verdict: { settled: true, rule: "animating", animating: true, outcome: "ok" } });
  });
});

describe("each unmet rule blocks, and is named", () => {
  const cases: Array<[string, Partial<Snapshot>, string]> = [
    ["the load event hasn't fired", { page: { readyState: "interactive", fonts: "loaded", imagesPending: 0, textLength: 500, hasMedia: true } }, "load-event"],
    ["a request is waiting for the server", { net: { inFlight: [{ url: "https://a.test/x", phase: "waiting", ageMs: 900, longLived: false }], sinceActivityMs: 5000, state: null, pay: null } }, "network"],
    ["a response body is still arriving", { net: { inFlight: [{ url: "https://a.test/big", phase: "receiving", ageMs: 900, longLived: false }], sinceActivityMs: 5000, state: null, pay: null } }, "network"],
    ["the network moved a moment ago", { net: { inFlight: [], sinceActivityMs: 100, state: null, pay: null } }, "network-quiet"],
    ["web fonts are still loading", { page: { readyState: "complete", fonts: "loading", imagesPending: 0, textLength: 500, hasMedia: true } }, "fonts"],
    ["visible images are still loading", { page: { readyState: "complete", fonts: "loaded", imagesPending: 2, textLength: 500, hasMedia: true } }, "images"],
    ["the page can't be asked", { page: null }, "page-unreachable"],
  ];
  for (const [name, over, rule] of cases) {
    it(`${name} → blocked by '${rule}'`, () => {
      expect(blockers(snap(over), CFG).map((b) => b.rule)).toContain(rule);
      expect(run(snap(over))).toEqual({ done: false });
    });
  }
  it("resets the 'everything holds' clock when something moves again", () => {
    const memo = newMemo();
    step(snap({ nowMs: 1000, frames: { matched: false } }), CFG, memo);
    expect(memo.okSince).toBe(1000);
    step(snap({ nowMs: 1500, net: { inFlight: [], sinceActivityMs: 50, state: null, pay: null } }), CFG, memo);
    expect(memo.okSince).toBeNull();
  });
});

describe("a stuck navigation: the page can't be asked, but the request that never answered is named", () => {
  it("reports the network blocker first and page-unreachable after it", () => {
    const hang = { url: "https://a.test/hang", phase: "waiting" as const, ageMs: 5000, longLived: false };
    const b = blockers(snap({ page: null, net: { inFlight: [hang], sinceActivityMs: 5000, state: null, pay: null } }), CFG);
    expect(b.map((x) => x.rule)).toEqual(["network", "page-unreachable"]);
    expect(b[0]!.detail).toContain("https://a.test/hang");
  });
});

describe("long-lived streams don't block (a finished page can hold one open)", () => {
  const sse = { url: "https://a.test/events", phase: "receiving" as const, ageMs: 9000, longLived: true };
  it("an open event stream is ignored and reported", () => {
    const r = run(snap({ net: { inFlight: [sse], sinceActivityMs: 3000, state: null, pay: null }, frames: { matched: true } }));
    expect(r).toMatchObject({ done: true, verdict: { settled: true, rule: "frames-match", streams: 1 } });
  });
  it("but a request still WAITING for its headers does block", () => {
    const waiting = { url: "https://a.test/hang", phase: "waiting" as const, ageMs: 9000, longLived: false };
    expect(run(snap({ net: { inFlight: [sse, waiting], sinceActivityMs: 3000, state: null, pay: null } }))).toEqual({ done: false });
  });
});

describe("the deadline says what was still unmet", () => {
  it("returns settled:false, rule 'deadline', and blockedBy with the request that never answered", () => {
    const hang = { url: "https://a.test/hang", phase: "waiting" as const, ageMs: 10_000, longLived: false };
    const r = run(snap({ nowMs: 10_000, net: { inFlight: [hang], sinceActivityMs: 10_000, state: null, pay: null } }));
    expect(r).toMatchObject({ done: true, verdict: { settled: false, outcome: "deadline", rule: "deadline", waitedMs: 10_000 } });
    if (r.done) expect(r.verdict.blockedBy?.[0]).toMatchObject({ rule: "network" });
    if (r.done) expect(r.verdict.blockedBy?.[0]?.detail).toContain("https://a.test/hang");
  });
  it("a deadline during a bot check is reported as 'bot-check', not a generic timeout", () => {
    const r = run(snap({ nowMs: 10_000, net: { inFlight: [{ url: "https://a.test/.within.website/x", phase: "waiting", ageMs: 9000, longLived: false }], sinceActivityMs: 100, state: "challenge", pay: null } }));
    expect(r).toMatchObject({ done: true, verdict: { outcome: "bot-check", rule: "deadline", settled: false } });
  });
});

describe("outcomes: what actually happened", () => {
  const settledWith = (over: Partial<Snapshot>) => run({ ...snap(over), frames: { matched: true } });
  it("an error status is an outcome with the number, even though the page settled", () => {
    expect(settledWith({ lifecycle: { crashed: false, failed: null, download: null, status: 404 } })).toMatchObject({ done: true, verdict: { settled: true, outcome: "error-status", status: 404 } });
  });
  it("HTTP 429 is flagged as 'slow down'", () => {
    const r = settledWith({ lifecycle: { crashed: false, failed: null, download: null, status: 429 } });
    expect(r).toMatchObject({ done: true, verdict: { outcome: "error-status", status: 429, slowDown: true } });
  });
  it("a settled page with nothing on it is 'blank'", () => {
    expect(settledWith({ page: { readyState: "complete", fonts: "loaded", imagesPending: 0, textLength: 3, hasMedia: false } })).toMatchObject({ done: true, verdict: { settled: true, outcome: "blank" } });
  });
  it("but a page that is just an image or canvas is not blank", () => {
    expect(settledWith({ page: { readyState: "complete", fonts: "loaded", imagesPending: 0, textLength: 0, hasMedia: true } })).toMatchObject({ verdict: { outcome: "ok" } });
  });
  it("a download is 'not-a-page' and ends the wait at once", () => {
    expect(run(snap({ lifecycle: { crashed: false, failed: null, download: "report.pdf", status: null } }))).toMatchObject({ done: true, verdict: { outcome: "not-a-page", rule: "download", download: "report.pdf" } });
  });
  it("a crash ends the wait at once, unsettled", () => {
    expect(run(snap({ lifecycle: { crashed: true, failed: null, download: null, status: null } }))).toMatchObject({ done: true, verdict: { settled: false, outcome: "crashed", rule: "crashed" } });
  });
  it("a payment waiting on a decision ends the wait with 'payment-required'", () => {
    expect(run(snap({ net: { inFlight: [], sinceActivityMs: 10, state: null, pay: "pending" } }))).toMatchObject({ done: true, verdict: { outcome: "payment-required", rule: "payment" } });
  });
  it("a failed navigation names why", () => {
    const r = run(snap({ lifecycle: { crashed: false, failed: { description: "ERR_CERT_DATE_INVALID" }, download: null, status: null } }));
    expect(r).toMatchObject({ done: true, verdict: { settled: false, outcome: "failed", rule: "navigation-failed", failure: { kind: "certificate", description: "ERR_CERT_DATE_INVALID" } } });
  });
});

describe("classifyFailure", () => {
  const cases: Array<[string, string]> = [
    ["ERR_NAME_NOT_RESOLVED", "could-not-find-site"],
    ["ERR_CONNECTION_REFUSED", "could-not-connect"],
    ["ERR_CONNECTION_RESET", "could-not-connect"],
    ["ERR_EMPTY_RESPONSE", "could-not-connect"],
    ["ERR_CERT_AUTHORITY_INVALID", "certificate"],
    ["ERR_SSL_PROTOCOL_ERROR", "certificate"],
    ["ERR_TOO_MANY_REDIRECTS", "redirect-loop"],
    ["ERR_INTERNET_DISCONNECTED", "offline"],
    ["ERR_CONNECTION_TIMED_OUT", "timed-out"],
    ["ERR_BLOCKED_BY_CLIENT", "blocked"],
    ["ERR_SOMETHING_NEW", "other"],
    ["", "other"],
  ];
  for (const [desc, kind] of cases) it(`${desc || "(empty)"} → ${kind}`, () => expect(classifyFailure(desc)).toBe(kind));
});

describe("resolveConfig", () => {
  it("fills defaults, clamps ranges, and ignores junk", () => {
    expect(resolveConfig(undefined)).toEqual(SETTLE_DEFAULTS);
    expect(resolveConfig({ timeoutMs: 1 }).timeoutMs).toBe(500);
    expect(resolveConfig({ timeoutMs: 9e9 }).timeoutMs).toBe(300_000);
    expect(resolveConfig({ quietMs: "abc" }).quietMs).toBe(SETTLE_DEFAULTS.quietMs);
    expect(resolveConfig({ frames: false }).frames).toBe(false);
    expect(resolveConfig({ frames: "no" }).frames).toBe(true);
    expect(resolveConfig("nonsense")).toEqual(SETTLE_DEFAULTS);
  });
});
