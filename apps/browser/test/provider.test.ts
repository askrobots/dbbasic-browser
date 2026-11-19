import { afterEach, describe, expect, it, vi } from "vitest";
import { CallerNetwork, ProviderError, buildResponse, clampAnswerTimeout, firstParty, parseSetCookie, type CookieJar, type ParsedCookie } from "../src/provider.js";
import type { NetEvent } from "../src/transport.js";

const make = () => {
  const events: NetEvent[] = [];
  let n = 0;
  const net = new CallerNetwork((e) => events.push(e), () => ++n);
  net.enabled = true;
  net.userAgent = "ExampleCaller/1.0 (+https://caller.example/about)";
  return { net, events };
};
const req = (url = "https://a.test/x", init: RequestInit = {}) => new Request(url, init);

afterEach(() => vi.useRealTimers());

describe("buildResponse validates what the caller sends", () => {
  it("builds a response from text and from base64", async () => {
    const t = buildResponse("https://a.test/", { status: 200, headers: { "content-type": "text/html" }, bodyText: "hi" });
    expect(t.bytes).toBe(2);
    expect(await t.response.text()).toBe("hi");
    expect(await buildResponse("https://a.test/", { status: 200, bodyBase64: Buffer.from("héllo").toString("base64") }).response.text()).toBe("héllo");
  });
  it.each([[{ status: 99 }], [{ status: 700 }], [{ status: 200.5 }], [{ status: "200" }], [{ status: 200, bodyText: "a", bodyBase64: "YQ==" }], [{ status: 200, bodyBase64: "not base64!" }], [{ status: 200, headers: [] }], [{ status: 200, headers: { a: 1 } }], [null]])("rejects %j", (a) => {
    expect(() => buildResponse("https://a.test/", a as never)).toThrow(ProviderError);
  });
  it("drops headers that describe transport or set state (the body given is the body to show)", () => {
    const { response } = buildResponse("https://a.test/", { status: 200, headers: { "content-encoding": "gzip", "content-length": "999", "set-cookie": "a=b", "x-keep": "1" }, bodyText: "x" });
    expect([...response.headers.keys()]).toEqual(["x-keep"]);
  });
  it("makes a redirect's Location absolute and gives it no body", () => {
    const { response, bytes } = buildResponse("https://a.test/dir/x", { status: 302, headers: { location: "../y" } });
    expect(response.headers.get("location")).toBe("https://a.test/y");
    expect(response.body).toBeNull();
    expect(bytes).toBe(0);
  });
  it("a 304 or 204 has no body", () => {
    expect(buildResponse("https://a.test/", { status: 204 }).response.body).toBeNull();
  });
});

describe("clampAnswerTimeout", () => {
  it("defaults, and clamps to 1 s … 2 min", () => {
    expect(clampAnswerTimeout(undefined)).toBe(20_000);
    expect(clampAnswerTimeout("abc")).toBe(20_000);
    expect(clampAnswerTimeout(5)).toBe(1_000);
    expect(clampAnswerTimeout(9e9)).toBe(120_000);
    expect(clampAnswerTimeout(15_000)).toBe(15_000);
  });
});

describe("a request is parked for the caller, then answered", () => {
  it("hands over the request, with the caller's identity and which page it follows", async () => {
    const { net, events } = make();
    const p = net.fetch(req("https://a.test/next", { headers: { referer: "https://a.test/prev" } }));
    const [r] = await net.pending(0, 0);
    expect(r).toMatchObject({ id: 1, url: "https://a.test/next", method: "GET", follows: "https://a.test/prev" });
    expect(r!.headers["user-agent"]).toBe("ExampleCaller/1.0 (+https://caller.example/about)");
    expect(net.isParked("https://a.test/next")).toBe(true);
    net.answer(1, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, bodyText: "<p>ok</p>" });
    const res = await p;
    expect(await res.text()).toBe("<p>ok</p>");
    expect(net.isParked("https://a.test/next")).toBe(false);
    expect(events.map((e) => e.type)).toEqual(["start", "caller", "headers", "end"]);
    expect(events[2]).toMatchObject({ status: 200, contentType: "text/html" });
  });
  it("a request body is handed over as base64", async () => {
    const { net } = make();
    void net.fetch(req("https://a.test/post", { method: "POST", body: "a=1" })).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    const [r] = await net.pending(0, 0);
    expect(Buffer.from(r!.bodyBase64!, "base64").toString()).toBe("a=1");
  });
  it("a redirect answer goes back as a redirect (and is announced as one)", async () => {
    const { net, events } = make();
    const p = net.fetch(req("https://a.test/old"));
    await net.pending(0, 0);
    net.answer(1, { status: 301, headers: { location: "/new" } });
    expect((await p).headers.get("location")).toBe("https://a.test/new");
    expect(events.at(-1)).toMatchObject({ type: "redirect", status: 301, location: "https://a.test/new" });
  });
  it("a bad answer is an error to the caller and leaves the request waiting", async () => {
    const { net } = make();
    void net.fetch(req()).catch(() => {});
    await net.pending(0, 0);
    expect(() => net.answer(1, { status: 42 })).toThrow(ProviderError);
    expect(net.isParked("https://a.test/x")).toBe(true);
  });
  it("answering twice, or an unknown request, is 'no-request'", async () => {
    const { net } = make();
    const p = net.fetch(req());
    await net.pending(0, 0);
    net.answer(1, { status: 200 });
    await p;
    expect(() => net.answer(1, { status: 200 })).toThrowError(expect.objectContaining({ code: "no-request" }));
    expect(() => net.fail(77, "blocked")).toThrowError(expect.objectContaining({ code: "no-request" }));
  });
  it("pending(afterId) only returns newer requests, and a long poll wakes when one arrives", async () => {
    const { net } = make();
    void net.fetch(req("https://a.test/1")).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    expect((await net.pending(0, 0)).length).toBe(1);
    const waiting = net.pending(1, 5000);
    void net.fetch(req("https://a.test/2")).catch(() => {});
    expect((await waiting).map((r) => r.url)).toEqual(["https://a.test/2"]);
    expect(await net.pending(2, 30)).toEqual([]);
  });
});

describe("limits on what a page can make the caller hold", () => {
  it("at most 64 requests wait at once; the next fails at once, with a reason", async () => {
    const { net, events } = make();
    for (let i = 0; i < 64; i++) void net.fetch(req(`https://a.test/${i}`)).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(net.parkedCount()).toBe(64);
    await expect(net.fetch(req("https://a.test/one-too-many"))).rejects.toThrow(/too many requests/);
    expect(events.at(-1)).toMatchObject({ type: "error", failureKind: "other", failureSource: "observed" });
    net.failAll("other", "cleanup");
  });
  it("pending hands over at most 50 at a time, oldest first", async () => {
    const { net } = make();
    for (let i = 0; i < 60; i++) void net.fetch(req(`https://a.test/${i}`)).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    const first = await net.pending(0, 0);
    expect(first.length).toBe(50);
    expect(first[0]!.id).toBe(1);
    expect((await net.pending(first.at(-1)!.id, 0)).length).toBe(10);
    net.failAll("other", "cleanup");
  });
  it("a redirect may only go to an http(s) address", () => {
    expect(() => buildResponse("https://a.test/", { status: 302, headers: { location: "file:///etc/passwd" } })).toThrow(ProviderError);
    expect(() => buildResponse("https://a.test/", { status: 302, headers: { location: "javascript:alert(1)" } })).toThrow(ProviderError);
    expect(() => buildResponse("https://a.test/", { status: 302, headers: { location: "https://b.test/x" } })).not.toThrow();
  });
});

describe("per-visit limits", () => {
  const ask = async (net: CallerNetwork, url: string) => {
    const p = net.fetch(req(url)).catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    return p;
  };
  it("past the request limit the next request fails at once, with a reason, as observed", async () => {
    const { net, events } = make();
    net.limits = { requests: 2, bytes: 0 };
    void net.fetch(req("https://a.test/1")).catch(() => {});
    void net.fetch(req("https://a.test/2")).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    const third = await ask(net, "https://a.test/3");
    expect(String(third)).toMatch(/visit limit reached: 2 requests/);
    expect(events.at(-1)).toMatchObject({ type: "error", failureKind: "other", failureSource: "observed" });
    net.failAll("other", "cleanup");
  });
  it("past the byte limit the next request fails; the response under way is not cut off", async () => {
    const { net } = make();
    net.limits = { requests: 0, bytes: 40 };
    const first = net.fetch(req("https://a.test/1"));
    await net.pending(0, 0);
    net.answer(1, { status: 200, bodyText: "x".repeat(100) }); // over the limit, but delivered whole
    expect((await (await first).text()).length).toBe(100);
    expect(String(await ask(net, "https://a.test/2"))).toMatch(/visit limit reached: 40 bytes/);
  });
  it("a new visit starts the counts over, and 0 means no limit", async () => {
    const { net } = make();
    net.limits = { requests: 1, bytes: 0 };
    void net.fetch(req("https://a.test/1")).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    expect(String(await ask(net, "https://a.test/2"))).toMatch(/visit limit/);
    net.newVisit();
    void net.fetch(req("https://a.test/3")).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    expect(net.parkedCount()).toBe(2);
    net.limits = { requests: 0, bytes: 0 };
    void net.fetch(req("https://a.test/4")).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    expect(net.parkedCount()).toBe(3);
    net.failAll("other", "cleanup");
  });
});

describe("a refusal carries the caller's reason", () => {
  it("rejects the request, and announces the kind with source 'caller'", async () => {
    const { net, events } = make();
    const p = net.fetch(req());
    await net.pending(0, 0);
    net.fail(1, "blocked", "the caller's own rules disallow this");
    await expect(p).rejects.toThrow(/caller:blocked/);
    expect(events.at(-1)).toMatchObject({ type: "error", error: "the caller's own rules disallow this", failureKind: "blocked", failureSource: "caller" });
  });
  it("only kinds from the shared list are accepted; 'caller-silent' is the browser's to say", async () => {
    const { net } = make();
    void net.fetch(req()).catch(() => {});
    await net.pending(0, 0);
    expect(() => net.fail(1, "nonsense")).toThrow(ProviderError);
    expect(() => net.fail(1, "caller-silent")).toThrow(ProviderError);
  });
});

describe("waiting on the caller has ONE bound", () => {
  it("past it the request fails as 'caller-silent', observed — not 'timed-out' (server too slow)", async () => {
    vi.useFakeTimers();
    const { net, events } = make();
    net.answerTimeoutMs = 20_000;
    const p = net.fetch(req());
    const caught = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(net.isParked("https://a.test/x")).toBe(true);
    await vi.advanceTimersByTimeAsync(2);
    expect(String(await caught)).toMatch(/caller-silent/);
    expect(events.at(-1)).toMatchObject({ type: "error", failureKind: "caller-silent", failureSource: "observed" });
    expect(net.isParked("https://a.test/x")).toBe(false);
  });
  it("an answer in time clears the bound", async () => {
    vi.useFakeTimers();
    const { net } = make();
    const p = net.fetch(req());
    await vi.advanceTimersByTimeAsync(1);
    net.answer(1, { status: 200, bodyText: "x" });
    await p;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(net.parkedCount()).toBe(0);
  });
  it("turning the mode off refuses everything waiting", async () => {
    const { net } = make();
    const p = net.fetch(req()).catch((e) => e);
    await net.pending(0, 0);
    net.failAll("other", "turned off");
    expect(String(await p)).toMatch(/turned off/);
  });
  it("an aborted request leaves the queue", async () => {
    const { net } = make();
    const ac = new AbortController();
    const p = net.fetch(new Request("https://a.test/x", { signal: ac.signal })).catch((e) => e);
    await net.pending(0, 0);
    ac.abort();
    expect(String(await p)).toMatch(/aborted/i);
    expect(net.parkedCount()).toBe(0);
  });
});

describe("a document the caller already has", () => {
  const doc = { url: "https://a.test/final", status: 200, headers: { "content-type": "text/html" }, bodyText: "<a href=x>x</a>", redirects: [{ status: 301, to: "https://a.test/final" }] };
  it("is served once, as it is, when its address is asked for — without being handed to the caller", async () => {
    const { net, events } = make();
    net.registerDocument(doc);
    expect(net.hasDocumentFor("https://a.test/final")).toBe(true);
    const res = await net.fetch(req("https://a.test/final"));
    expect(await res.text()).toBe("<a href=x>x</a>");
    expect(net.parkedCount()).toBe(0);
    expect(events.map((e) => e.type)).toEqual(["start", "headers", "end"]);
    expect(net.hasDocumentFor("https://a.test/final")).toBe(false); // once
  });
  it("a bad document is refused up front", () => {
    const { net } = make();
    expect(() => net.registerDocument({ ...doc, status: 1 })).toThrow(ProviderError);
    expect(() => net.registerDocument({ ...doc, url: "file:///etc/passwd" })).toThrow(ProviderError);
    expect(() => net.registerDocument({ ...doc, redirects: [{ to: 5 }] as never })).toThrow(ProviderError);
  });
  it("expires if nobody asks for it", () => {
    vi.useFakeTimers();
    const { net } = make();
    net.registerDocument(doc);
    vi.advanceTimersByTime(61_000);
    expect(net.hasDocumentFor("https://a.test/final")).toBe(false);
  });
});

describe("parseSetCookie", () => {
  const p = (line: string, url = "https://a.test/dir/page") => parseSetCookie(line, url, 1_000_000);
  it("reads name, value and the attributes that matter", () => {
    expect(p("k=v; Path=/x; Domain=a.test; Secure; HttpOnly; SameSite=Lax; Max-Age=60")).toEqual({ name: "k", value: "v", domain: ".a.test", path: "/x", secure: true, httpOnly: true, sameSite: "lax", expirationDate: 1_000_060 });
  });
  it("defaults the path to the directory of the request, and has no expiry for a session cookie", () => {
    expect(p("k=v")).toMatchObject({ path: "/dir", sameSite: "unspecified" });
    expect(p("k=v")!.expirationDate).toBeUndefined();
    expect(p("k=v", "https://a.test/")).toMatchObject({ path: "/" });
  });
  it("Max-Age wins over Expires", () => {
    expect(p("k=v; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Max-Age=5")!.expirationDate).toBe(1_000_005);
    expect(p("k=v; Expires=Wed, 21 Oct 2099 07:28:00 GMT")!.expirationDate).toBeGreaterThan(4_000_000_000);
  });
  it("rejects what is unusable", () => {
    for (const bad of ["", "novalue", "=v", "a b=c", "k=v\u0001", "k=" + "x".repeat(5000)]) expect(p(bad)).toBeNull();
  });
});

describe("firstParty", () => {
  it("a navigation is; a request is when the page it follows is on the same site", () => {
    expect(firstParty("https://a.test/", "", true)).toBe(true);
    expect(firstParty("https://a.test/img", "https://a.test/page", false)).toBe(true);
    expect(firstParty("https://cdn.a.test/img", "https://www.a.test/page", false)).toBe(true);
    expect(firstParty("https://tracker.example/px", "https://a.test/page", false)).toBe(false);
    expect(firstParty("https://a.test/img", "", false)).toBe(false); // no page to compare with: not first-party
  });
});

describe("the per-visit cookie jar (off by default)", () => {
  const jarOf = (stored: ParsedCookie[], header = "seen=1") => ({ on: () => true, header: async () => header, store: async (_u: string, c: ParsedCookie) => { await new Promise((r) => setTimeout(r, 10)); stored.push(c); } }) as CookieJar;
  it("with no jar, no cookie is sent and a Set-Cookie is dropped", async () => {
    const { net } = make();
    const p = net.fetch(req("https://a.test/x", { headers: { cookie: "page=sent" } }));
    const [r] = await net.pending(0, 0);
    expect(r!.headers.cookie).toBeUndefined();
    net.answer(1, { status: 200, headers: { "set-cookie": "a=b" }, bodyText: "x" });
    expect([...(await p).headers.keys()]).not.toContain("set-cookie");
  });
  it("a Set-Cookie is stored BEFORE the page sees the response, and the browser's Cookie header is the only one", async () => {
    const { net } = make();
    const stored: ParsedCookie[] = [];
    net.jar = jarOf(stored);
    const p = net.fetch(req("https://a.test/x", { headers: { cookie: "page=sent", "upgrade-insecure-requests": "1" } }));
    const [r] = await net.pending(0, 500); // the jar is asked first, so the request is parked a moment later
    expect(r!.headers.cookie).toBe("seen=1");
    net.answer(1, { status: 302, headers: { location: "/x", "set-cookie": ["seen=1; Path=/"] } });
    await p;
    expect(stored.map((c) => c.name)).toEqual(["seen"]); // already stored when the response resolved
  });
  it("a third-party request gets no cookie, and none is stored from it", async () => {
    const { net } = make();
    const stored: ParsedCookie[] = [];
    net.jar = jarOf(stored);
    const p = net.fetch(req("https://tracker.example/px", { headers: { referer: "https://a.test/page" } }));
    const [r] = await net.pending(0, 0);
    expect(r!.headers.cookie).toBeUndefined();
    net.answer(1, { status: 200, headers: { "set-cookie": "t=1" }, bodyText: "x" });
    await p;
    expect(stored).toEqual([]);
  });
  it("at most 50 cookies per visit; a new visit starts the count over", async () => {
    const { net } = make();
    const stored: ParsedCookie[] = [];
    net.jar = jarOf(stored);
    const p = net.fetch(req("https://a.test/x", { headers: { "upgrade-insecure-requests": "1" } }));
    await net.pending(0, 500);
    net.answer(1, { status: 200, headers: { "set-cookie": Array.from({ length: 60 }, (_, i) => `c${i}=v`) }, bodyText: "x" });
    await p;
    expect(stored.length).toBe(50);
    net.newVisit();
    const p2 = net.fetch(req("https://a.test/y", { headers: { "upgrade-insecure-requests": "1" } }));
    await net.pending(1, 500);
    net.answer(2, { status: 200, headers: { "set-cookie": "again=1" }, bodyText: "x" });
    await p2;
    expect(stored.length).toBe(51);
  });
});
