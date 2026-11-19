import { afterEach, describe, expect, it, vi } from "vitest";
import { CallerNetwork, ProviderError, buildResponse, clampAnswerTimeout } from "../src/provider.js";
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
    expect(events.map((e) => e.type)).toEqual(["start", "headers", "end"]);
    expect(events[1]).toMatchObject({ status: 200, contentType: "text/html" });
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
