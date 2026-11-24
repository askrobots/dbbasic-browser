import { describe, expect, it } from "vitest";
import { RequestKinds } from "../src/request-kinds";
import { chromiumRequestHeaders, fetchMetadataFor, requestCredentials } from "../src/compat";

const hints = { brands: [{ brand: "Chromium", version: "156" }], platform: "macOS", mobile: false };

describe("the kind of each request, as webRequest saw it", () => {
  it("is taken once, oldest first, for the same method and address, and forgotten after a few seconds", () => {
    let t = 0;
    const k = new RequestKinds(() => t);
    k.record({ method: "GET", url: "https://a.test/x.js", type: "script", frameUrl: "https://page.test/p" });
    k.record({ method: "GET", url: "https://a.test/x.js", type: "image", frameUrl: "https://other.test/" });
    expect(k.take("GET", "https://a.test/x.js")).toEqual({ type: "script", initiator: "https://page.test" });
    expect(k.take("GET", "https://a.test/x.js")).toEqual({ type: "image", initiator: "https://other.test" });
    expect(k.take("GET", "https://a.test/x.js")).toBeNull();
    k.record({ method: "POST", url: "https://a.test/api", type: "xhr", frameUrl: "https://a.test/" });
    expect(k.take("GET", "https://a.test/api")).toBeNull(); // another method
    t += 11_000;
    expect(k.take("POST", "https://a.test/api")).toBeNull(); // too old
  });

  it("a frame being loaded was started by its parent; a page by where the link was", () => {
    const k = new RequestKinds();
    k.record({ method: "GET", url: "https://challenges.test/f", type: "subFrame", frameUrl: "", parentUrl: "https://form.test/apply", referrer: "https://form.test/" });
    expect(k.take("GET", "https://challenges.test/f")).toEqual({ type: "subFrame", initiator: "https://form.test" });
    k.record({ method: "GET", url: "https://b.test/", type: "mainFrame", frameUrl: "https://a.test/", referrer: "" });
    expect(k.take("GET", "https://b.test/")).toEqual({ type: "mainFrame", initiator: null }); // typed: from nowhere
  });
});

describe("fetch metadata from the real request kind (what Cloudflare's check compares)", () => {
  const H = (init: Record<string, string> = {}) => new Headers({ accept: "*/*", ...init });
  it("a cross-site script, a frame, the frame's own POST, and a same-origin image", () => {
    const s = chromiumRequestHeaders(new URL("https://challenges.test/api.js"), H(), hints, { kind: { type: "script", initiator: "https://form.test" } });
    expect([s.get("sec-fetch-site"), s.get("sec-fetch-mode"), s.get("sec-fetch-dest")]).toEqual(["cross-site", "no-cors", "script"]);
    const f = chromiumRequestHeaders(new URL("https://challenges.test/f"), H({ "upgrade-insecure-requests": "1", accept: "text/html" }), hints, { kind: { type: "subFrame", initiator: "https://form.test" } });
    expect([f.get("sec-fetch-site"), f.get("sec-fetch-mode"), f.get("sec-fetch-dest"), f.has("sec-fetch-user")]).toEqual(["cross-site", "navigate", "iframe", false]);
    const p = chromiumRequestHeaders(new URL("https://challenges.test/fo/1"), H(), hints, { kind: { type: "xhr", initiator: "https://challenges.test" } }, "POST");
    expect([p.get("sec-fetch-site"), p.get("sec-fetch-mode"), p.get("sec-fetch-dest"), p.get("origin")]).toEqual(["same-origin", "cors", "empty", "https://challenges.test"]);
    const i = chromiumRequestHeaders(new URL("https://challenges.test/i.png"), H({ accept: "image/*" }), hints, { kind: { type: "image", initiator: "https://challenges.test" } });
    expect([i.get("sec-fetch-site"), i.get("sec-fetch-mode"), i.get("sec-fetch-dest")]).toEqual(["same-origin", "no-cors", "image"]);
  });

  it("adds no Origin to a cross-origin fetch, so it keeps the page's cookies as before (x.com's calls to api.x.com)", () => {
    const h = chromiumRequestHeaders(new URL("https://api.x.test/1"), H(), hints, { kind: { type: "xhr", initiator: "https://x.test" } }, "POST");
    expect(h.has("origin")).toBe(false);
    expect(h.get("sec-fetch-site")).toBe("same-site");
    expect(h.get("sec-fetch-mode")).toBe("no-cors"); // as before: "cors" with cookies and no Origin is refused by Chromium
    expect(requestCredentials({ url: "https://api.x.test/1", credentials: "same-origin" }, h)).toBe("include");
  });

  it("knows the kinds Chromium names", () => {
    expect(fetchMetadataFor("font", false)).toEqual({ dest: "font", mode: "cors" });
    expect(fetchMetadataFor("stylesheet", true)).toEqual({ dest: "style", mode: "cors" });
    expect(fetchMetadataFor("other", false)).toBeNull(); // unknown: the old guess from Accept
  });
});
