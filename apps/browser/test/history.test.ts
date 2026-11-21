import { describe, expect, it } from "vitest";
import { HistoryService, MAX_TEXT_BYTES, QUEUE_CAP, cleanHistoryUrl, clipText, onNeverList, skipReason } from "../src/history.js";

describe("history: which address is kept", () => {
  it("drops the fragment, user info and every parameter except the few that say which page it is", () => {
    expect(cleanHistoryUrl("https://example.com/a?utm_source=x&id=5#top")).toBe("https://example.com/a");
    expect(cleanHistoryUrl("https://www.youtube.com/watch?v=abc123&t=42s&utm_campaign=y")).toBe("https://www.youtube.com/watch?v=abc123");
    expect(cleanHistoryUrl("https://m.youtube.com/playlist?list=PL1&si=track")).toBe("https://m.youtube.com/playlist?list=PL1");
    expect(cleanHistoryUrl("https://news.ycombinator.com/item?id=42&p=2")).toBe("https://news.ycombinator.com/item?id=42");
    expect(cleanHistoryUrl("https://www.google.com/search?q=private+thing")).toBe("https://www.google.com/search");
    expect(cleanHistoryUrl("https://user:pw@example.com/x")).toBe("https://example.com/x");
    for (const bad of ["file:///etc/passwd", "about:blank", "dbb-reader://x", "javascript:alert(1)", "not a url"]) expect(cleanHistoryUrl(bad)).toBeNull();
  });
});

describe("history: what is never recorded", () => {
  it("sign-in and payment pages, by address, by title or by a password field", () => {
    expect(skipReason({ url: "https://accounts.google.com/v3/signin" })).toBe("sign-in-or-payment");
    expect(skipReason({ url: "https://login.example.com/" })).toBe("sign-in-or-payment");
    expect(skipReason({ url: "https://shop.example/checkout" })).toBe("sign-in-or-payment");
    expect(skipReason({ url: "https://example.com/account/security/" })).toBe("sign-in-or-payment");
    expect(skipReason({ url: "https://example.com/welcome", title: "Sign in to Example" })).toBe("sign-in-or-payment");
    expect(skipReason({ url: "https://example.com/welcome", hasPassword: true })).toBe("sign-in-or-payment");
    expect(skipReason({ url: "https://www.paypal.com/myaccount" })).toBe("sign-in-or-payment");
    // ordinary pages that only look close
    expect(skipReason({ url: "https://example.com/blog/how-to-pay-less-tax" })).toBeNull();
    expect(skipReason({ url: "https://example.com/paying-guide" })).toBeNull();
    expect(skipReason({ url: "https://news.example/story", title: "Payments startup raises money" })).toBeNull();
  });

  it("this machine and the private network, unless a test says so", () => {
    for (const u of ["http://localhost:3000/", "http://127.0.0.1:8080/x", "http://192.168.1.1/", "http://10.0.0.5/", "http://printer.local/", "http://[::1]/"]) expect(skipReason({ url: u })).toBe("private-network");
    expect(skipReason({ url: "http://127.0.0.1:8080/x" }, [], true)).toBeNull();
  });

  it("never-record sites cover their subdomains, without matching look-alikes", () => {
    expect(onNeverList("www.example.com", ["example.com"])).toBe(true);
    expect(onNeverList("mail.example.com", ["example.com"])).toBe(true);
    expect(onNeverList("notexample.com", ["example.com"])).toBe(false);
    expect(skipReason({ url: "https://m.example.com/x" }, ["www.example.com"])).toBe("never-this-site");
  });

  it("page text is cut at 50,000 bytes on a character boundary, without NULs", () => {
    expect(clipText("a\u0000b")).toBe("ab");
    const long = "é".repeat(40_000); // 2 bytes each
    const c = clipText(long);
    expect(Buffer.byteLength(c, "utf8")).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(c.endsWith("é")).toBe(true);
  });
});

function setup(o: { connected?: boolean; caller?: boolean; reply?: (tool: string, args: Record<string, unknown>) => unknown } = {}) {
  let now = Date.parse("2026-11-21T10:00:00Z");
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const st = { connected: o.connected ?? true, caller: o.caller ?? false, fail: false };
  const svc = new HistoryService({
    call: async (tool, args) => {
      calls.push({ tool, args });
      if (st.fail) throw new Error("offline");
      const r = o.reply?.(tool, args);
      if (r !== undefined) return JSON.stringify(r);
      if (tool === "add_history") return JSON.stringify({ accepted: (args.visits as unknown[]).length, duplicates: 0, dropped: {}, paused: false });
      if (tool === "history_settings") return JSON.stringify({ paused: args.paused ?? false, never_sites: args.never_sites ?? [], forget_count: 0, stored_bytes: 0 });
      if (tool === "forget_history") return JSON.stringify({ forgotten: 3, scope: args.scope });
      return "{}";
    },
    connected: () => st.connected,
    whyOff: () => "not signed in to askrobots",
    callerNetworkOn: () => st.caller,
    now: () => now,
  });
  const tick = (s: number) => (now += s * 1000);
  const visit = (tab: number, url: string, secs: number, extra: { title?: string; text?: string; pw?: boolean } = {}) => {
    svc.shown(tab, url, extra.title ?? "A page");
    if (extra.text !== undefined || extra.pw) svc.text(tab, url, extra.text ?? "", !!extra.pw);
    tick(secs);
    svc.left(tab);
  };
  return { svc, calls, st, tick, visit };
}

describe("history: titles", () => {
  it("a page without a title (shown as its address, parameters and all) is kept with no title", async () => {
    const { svc, calls, tick } = setup();
    svc.shown(1, "http://example.com:8080/headers?utm_source=news#top", "example.com:8080/headers?utm_source=news#top");
    tick(3);
    svc.shown(2, "https://example.com/a", "https://example.com/a");
    svc.shown(3, "https://example.com/b", "Example: the B page");
    tick(3);
    svc.leaveAll();
    await svc.flush();
    const sent = calls[0]!.args.visits as Array<{ url: string; title?: string }>;
    expect(sent.map((v) => v.title)).toEqual([undefined, undefined, "Example: the B page"]);
  });
});

describe("history: recording and sending", () => {
  it("a visit becomes one record with its cleaned address, title, start time, seconds and text", async () => {
    const { svc, calls, visit } = setup();
    visit(1, "https://example.com/story?utm_source=x#c", 12, { title: "Solar batteries", text: "Lithium iron phosphate…" });
    expect(svc.state().queued).toBe(1);
    await svc.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe("add_history");
    expect(calls[0]!.args.visits).toEqual([{ url: "https://example.com/story", title: "Solar batteries", visited_at: "2026-11-21T10:00:00.000Z", seconds_on_page: 12, text: "Lithium iron phosphate…" }]);
    expect(svc.state()).toMatchObject({ queued: 0, sent: 1, on: true });
  });

  it("glances, sign-in pages, password pages and the private network are not visits", async () => {
    const { svc, visit } = setup();
    visit(1, "https://example.com/quick", 1);
    visit(1, "https://example.com/login", 30);
    visit(1, "https://example.com/members", 30, { pw: true });
    visit(1, "http://localhost:8000/admin", 30);
    expect(svc.state().queued).toBe(0);
  });

  it("the same page at a new fragment is one visit; a new YouTube video is a new one", () => {
    const { svc, tick } = setup();
    svc.shown(1, "https://www.youtube.com/watch?v=one");
    tick(5);
    svc.shown(1, "https://www.youtube.com/watch?v=one#t=30"); // same page
    tick(5);
    svc.shown(1, "https://www.youtube.com/watch?v=two"); // the first one ends here, 10 s
    tick(5);
    svc.left(1);
    expect(svc.state().queued).toBe(2);
  });

  it("text for a page the tab has already left is ignored", async () => {
    const { svc, calls, tick } = setup();
    svc.shown(1, "https://example.com/a");
    tick(3);
    svc.shown(1, "https://example.com/b");
    svc.text(1, "https://example.com/a", "late text from a", false);
    tick(3);
    svc.left(1);
    await svc.flush();
    const sent = calls[0]!.args.visits as Array<{ url: string; text?: string }>;
    expect(sent.find((v) => v.url.endsWith("/b"))?.text).toBeUndefined();
  });

  it("nothing is recorded when signed out, while paused, or while the caller network is on", async () => {
    const off = setup({ connected: false });
    off.visit(1, "https://example.com/a", 10);
    expect(off.svc.state()).toMatchObject({ queued: 0, on: false, why: "not signed in to askrobots" });
    const caller = setup({ caller: true });
    caller.visit(1, "https://example.com/a", 10);
    expect(caller.svc.state().queued).toBe(0);
    const p = setup();
    await p.svc.setPaused(true);
    p.visit(1, "https://example.com/a", 10);
    expect(p.svc.state()).toMatchObject({ queued: 0, paused: true });
    expect(p.calls.at(-1)).toEqual({ tool: "history_settings", args: { paused: true } });
  });

  it("offline: visits wait and go on the next try; the queue is capped, oldest first out", async () => {
    const { svc, st, visit } = setup();
    st.fail = true;
    visit(1, "https://example.com/a", 5);
    await svc.flush();
    expect(svc.state()).toMatchObject({ queued: 1, error: "offline" });
    st.fail = false;
    await svc.flush();
    expect(svc.state()).toMatchObject({ queued: 0, sent: 1 });
    expect(svc.state().error).toBeUndefined();
    st.fail = true;
    for (let i = 0; i < QUEUE_CAP + 5; i++) visit(1, `https://example.com/p${i}`, 3);
    expect(svc.state().queued).toBe(QUEUE_CAP);
  });

  it("an error from the account (over storage) keeps the batch here and says so", async () => {
    const { svc, visit } = setup({ reply: (t) => (t === "add_history" ? { error: "over the storage limit" } : undefined) });
    visit(1, "https://example.com/a", 5);
    await svc.flush();
    expect(svc.state()).toMatchObject({ queued: 1, error: "over the storage limit" });
  });

  it("a flush with nothing to send does not block the next one", async () => {
    const { svc, calls, visit } = setup();
    await svc.flush(); // nothing waiting
    visit(1, "https://example.com/a", 5);
    await svc.flush();
    expect(calls.map((c) => c.tool)).toEqual(["add_history"]);
    expect(svc.state().queued).toBe(0);
  });

  it("a page kept open is sent once it has been open 30 seconds, once, with the seconds so far", async () => {
    const { svc, calls, tick } = setup();
    svc.shown(1, "https://www.houstonchronicle.com/news/article/x-22521312.php?taid=1&utm_source=twitter", "A story");
    svc.text(1, "https://www.houstonchronicle.com/news/article/x-22521312.php", "Story text", false);
    tick(10);
    await svc.flush();
    expect(calls).toHaveLength(0); // not yet
    tick(25);
    await svc.flush();
    expect(calls[0]!.args.visits).toEqual([{ url: "https://www.houstonchronicle.com/news/article/x-22521312.php", title: "A story", visited_at: "2026-11-21T10:00:00.000Z", seconds_on_page: 35, text: "Story text" }]);
    tick(100);
    svc.left(1);
    await svc.flush();
    expect(calls).toHaveLength(1); // leaving it later adds nothing
  });

  it("pages already open when history switches on (signing in, resuming) count from that moment", async () => {
    const { svc, calls, tick } = setup();
    svc.shown(1, "https://example.com/open-before");
    tick(60);
    svc.resetAccount(); // signed in
    tick(5);
    svc.left(1);
    await svc.flush();
    expect(calls[0]!.args.visits).toMatchObject([{ url: "https://example.com/open-before", visited_at: "2026-11-21T10:01:00.000Z", seconds_on_page: 5 }]);
    const p = setup();
    p.svc.shown(1, "https://example.com/read");
    await p.svc.setPaused(true);
    p.tick(40);
    await p.svc.flush(); // paused: not sent, however long it is open
    await p.svc.setPaused(false);
    p.tick(4);
    p.svc.left(1);
    await p.svc.flush();
    const adds = p.calls.filter((c) => c.tool === "add_history");
    expect(adds.map((c) => c.args.visits)).toMatchObject([[{ url: "https://example.com/read", seconds_on_page: 4 }]]);
  });

  it("quitting ends every open visit", () => {
    const { svc, tick } = setup();
    svc.shown(1, "https://example.com/a");
    svc.shown(2, "https://example.com/b");
    tick(5);
    svc.leaveAll();
    expect(svc.state().queued).toBe(2);
  });

  it("sends in batches of 100", async () => {
    const { svc, calls, visit } = setup();
    for (let i = 0; i < 250; i++) visit(1, `https://example.com/p${i}`, 3);
    await svc.flush();
    expect(calls.map((c) => (c.args.visits as unknown[]).length)).toEqual([100, 100, 50]);
  });

  it("signing out or in again empties the queue, so nothing reaches another account", () => {
    const { svc, visit } = setup();
    visit(1, "https://example.com/a", 5);
    svc.resetAccount();
    expect(svc.state().queued).toBe(0);
  });

  it("forget takes matching visits out of the queue and asks the account to forget the rest", async () => {
    const { svc, calls, visit, st } = setup();
    st.fail = true; // keep them queued
    visit(1, "https://example.com/a", 5);
    visit(1, "https://sub.other.com/b", 5);
    st.fail = false;
    const r = await svc.forget("site", "https://www.other.com/");
    expect(calls.at(-1)).toEqual({ tool: "forget_history", args: { scope: "site", site: "other.com" } });
    expect(r.forgotten).toBe(4); // one from the queue + three on the account
    expect(svc.state().queued).toBe(1);
    await svc.forget("url", "https://example.com/a#x");
    expect(calls.at(-1)).toEqual({ tool: "forget_history", args: { scope: "url", url: "https://example.com/a" } });
    expect(svc.state().queued).toBe(0);
  });

  it("never-record a site: saved to the account, applied to the queue and to later visits", async () => {
    const { svc, calls, visit } = setup();
    await svc.neverRecord("www.example.com");
    expect(calls.at(-1)).toEqual({ tool: "history_settings", args: { never_sites: ["example.com"] } });
    visit(1, "https://shop.example.com/x", 9);
    expect(svc.state().queued).toBe(0);
  });

  it("settings from the account: pause and the never list", async () => {
    const { svc } = setup({ reply: (t) => (t === "history_settings" ? { paused: true, never_sites: ["bank.example"], forget_count: 0, stored_bytes: 0 } : undefined) });
    await svc.loadSettings();
    expect(svc.state()).toMatchObject({ paused: true, neverSites: ["bank.example"] });
  });
});
