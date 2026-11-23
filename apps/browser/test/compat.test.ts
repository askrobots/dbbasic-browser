import { describe, expect, it } from "vitest";
import { brandedUserAgent, chromeMajor, chromiumRequestHeaders, isTrustworthy, refererFor, requestCredentials, secChUa, type Hints } from "../src/compat.js";

const ELECTRON_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) dbbasic-browser/33.4.11 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36";
const PRODUCT = { name: "dbbasic-browser", version: "2026.11v1", url: "https://dbbasic.com" };
const HINTS: Hints = { brands: [{ brand: "Not?A_Brand", version: "99" }, { brand: "Chromium", version: "130" }], platform: "macOS", mobile: false };

describe("brandedUserAgent", () => {
  const ua = brandedUserAgent(ELECTRON_UA, PRODUCT);
  it("drops the Electron token and Electron's version of the app token", () => {
    expect(ua).not.toMatch(/Electron/);
    expect(ua).not.toContain("dbbasic-browser/33.4.11");
  });
  it("stays Chromium-compatible: Mozilla/Chrome/Safari tokens intact, in order", () => {
    expect(ua.startsWith("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Safari/537.36")).toBe(true);
  });
  it("ends with our product token and a link back to dbbasic.com", () => {
    expect(ua.endsWith("dbbasic-browser/2026.11v1 (+https://dbbasic.com)")).toBe(true);
  });
  it("does not claim to be Firefox", () => {
    expect(ua).not.toMatch(/Firefox|Gecko\/\d/);
  });
  it("is idempotent in shape when applied to an already-branded UA", () => {
    expect(brandedUserAgent(ua, PRODUCT)).toBe(ua);
  });
});

describe("chromeMajor / secChUa / isTrustworthy", () => {
  it("parses the Chrome major", () => {
    expect(chromeMajor(ELECTRON_UA)).toBe(130);
    expect(chromeMajor("curl/8")).toBeNull();
  });
  it("formats sec-ch-ua like Chromium", () => {
    expect(secChUa(HINTS)).toBe('"Not?A_Brand";v="99", "Chromium";v="130"');
  });
  it("trusts https and loopback only", () => {
    expect(isTrustworthy(new URL("https://example.com"))).toBe(true);
    expect(isTrustworthy(new URL("http://127.0.0.1:8899/"))).toBe(true);
    expect(isTrustworthy(new URL("http://localhost:3000/"))).toBe(true);
    expect(isTrustworthy(new URL("http://example.com/"))).toBe(false);
  });
});

describe("chromiumRequestHeaders", () => {
  const nav = () =>
    new Headers({
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8",
      "upgrade-insecure-requests": "1",
      "sec-fetch-mode": "no-cors",
      "sec-fetch-dest": "empty",
      "sec-fetch-site": "none",
    });

  it("turns a typed top-level navigation into navigate/document/none/?1 with client hints", () => {
    const h = chromiumRequestHeaders(new URL("https://www.ebay.com/"), nav(), HINTS);
    expect(h.get("sec-fetch-mode")).toBe("navigate");
    expect(h.get("sec-fetch-dest")).toBe("document");
    expect(h.get("sec-fetch-site")).toBe("none");
    expect(h.get("sec-fetch-user")).toBe("?1");
    expect(h.get("sec-ch-ua")).toBe('"Not?A_Brand";v="99", "Chromium";v="130"');
    expect(h.get("sec-ch-ua-mobile")).toBe("?0");
    expect(h.get("sec-ch-ua-platform")).toBe('"macOS"');
  });

  it("computes sec-fetch-site from the referrer for link clicks", () => {
    const same = nav(); same.set("referer", "https://www.ebay.com/a");
    expect(chromiumRequestHeaders(new URL("https://www.ebay.com/b"), same, HINTS).get("sec-fetch-site")).toBe("same-origin");
    const sub = nav(); sub.set("referer", "https://www.ebay.com/a");
    expect(chromiumRequestHeaders(new URL("https://signin.ebay.com/"), sub, HINTS).get("sec-fetch-site")).toBe("same-site");
    const cross = nav(); cross.set("referer", "https://askrobots.com/");
    expect(chromiumRequestHeaders(new URL("https://www.ebay.com/"), cross, HINTS).get("sec-fetch-site")).toBe("cross-site");
  });

  it("classifies subresources and never sends sec-fetch-user on them", () => {
    const img = new Headers({ accept: "image/avif,image/webp,*/*", referer: "https://www.ebay.com/", "sec-fetch-user": "?1" });
    const h = chromiumRequestHeaders(new URL("https://i.ebayimg.com/x.jpg"), img, HINTS);
    expect(h.get("sec-fetch-dest")).toBe("image");
    expect(h.get("sec-fetch-mode")).toBe("no-cors");
    expect(h.get("sec-fetch-site")).toBe("cross-site");
    expect(h.has("sec-fetch-user")).toBe(false);

    const xhr = new Headers({ accept: "*/*", origin: "https://www.ebay.com", referer: "https://www.ebay.com/" });
    const x = chromiumRequestHeaders(new URL("https://www.ebay.com/api"), xhr, HINTS);
    expect(x.get("sec-fetch-mode")).toBe("cors");
    expect(x.get("sec-fetch-dest")).toBe("empty");
    expect(x.get("sec-fetch-site")).toBe("same-origin");
  });

  it("leaves plain-http (untrustworthy) requests alone, like Chrome", () => {
    const h = chromiumRequestHeaders(new URL("http://example.com/"), nav(), HINTS);
    expect(h.has("sec-ch-ua")).toBe(false);
    expect(h.get("sec-fetch-mode")).toBe("no-cors"); // untouched
  });

  it("skips client hints when the engine's brands aren't known, but still fixes fetch metadata", () => {
    const h = chromiumRequestHeaders(new URL("https://www.ebay.com/"), nav(), null);
    expect(h.has("sec-ch-ua")).toBe(false);
    expect(h.get("sec-fetch-mode")).toBe("navigate");
  });

  it("does not overwrite hints the renderer already supplied, and does not mutate its input", () => {
    const input = nav(); input.set("sec-ch-ua", '"Custom";v="1"');
    const h = chromiumRequestHeaders(new URL("https://www.ebay.com/"), input, HINTS);
    expect(h.get("sec-ch-ua")).toBe('"Custom";v="1"');
    expect(input.get("sec-fetch-mode")).toBe("no-cors");
  });
});

describe("refererFor (strict-origin-when-cross-origin by default)", () => {
  const ref = new URL("https://www.ebay.com/itm/123?secret=1#frag");
  it("full URL (minus fragment) same-origin, origin only cross-origin, nothing on downgrade", () => {
    expect(refererFor(new URL("https://www.ebay.com/other"), ref, "")).toBe("https://www.ebay.com/itm/123?secret=1");
    expect(refererFor(new URL("https://i.ebayimg.com/x.jpg"), ref, "")).toBe("https://www.ebay.com/");
    expect(refererFor(new URL("http://example.com/"), ref, "")).toBeNull();
  });
  it("honours explicit policies", () => {
    const t = new URL("https://other.test/");
    expect(refererFor(t, ref, "no-referrer")).toBeNull();
    expect(refererFor(t, ref, "origin")).toBe("https://www.ebay.com/");
    expect(refererFor(t, ref, "same-origin")).toBeNull();
    expect(refererFor(t, ref, "unsafe-url")).toBe("https://www.ebay.com/itm/123?secret=1");
    expect(refererFor(new URL("http://other.test/"), ref, "no-referrer-when-downgrade")).toBeNull();
  });
  it("never leaks credentials in the referrer", () => {
    expect(refererFor(new URL("https://a.test/x"), new URL("https://u:p@a.test/y"), "")).toBe("https://a.test/y");
  });
});

describe("chromiumRequestHeaders + referrer", () => {
  it("adds Referer from the Request's referrer property and uses it for sec-fetch-site", () => {
    const nav = new Headers({ accept: "text/html,*/*", "upgrade-insecure-requests": "1" });
    const h = chromiumRequestHeaders(new URL("https://www.ebay.com/b"), nav, HINTS, { referrer: "https://www.ebay.com/a", referrerPolicy: "" });
    expect(h.get("referer")).toBe("https://www.ebay.com/a");
    expect(h.get("sec-fetch-site")).toBe("same-origin");
  });
  it("ignores about:client / empty referrers (typed navigations send none)", () => {
    const nav = new Headers({ accept: "text/html,*/*", "upgrade-insecure-requests": "1" });
    for (const r of ["", "about:client"]) {
      const h = chromiumRequestHeaders(new URL("https://www.ebay.com/"), nav, HINTS, { referrer: r });
      expect(h.has("referer")).toBe(false);
      expect(h.get("sec-fetch-site")).toBe("none");
    }
  });
});

describe("requestCredentials", () => {
  const h = (o: Record<string, string> = {}) => new Headers(o);
  it('"omit" never carries cookies', () => {
    expect(requestCredentials({ url: "https://cdn.example/x.js", credentials: "omit" }, h())).toBe("omit");
    expect(requestCredentials({ url: "https://page.example/api", credentials: "omit" }, h({ origin: "https://page.example" }))).toBe("omit");
  });
  it('"same-origin" carries cookies only to the page\'s own origin (a <script crossorigin> from a CDN carries none)', () => {
    expect(requestCredentials({ url: "https://cdn.example/x.js", credentials: "same-origin" }, h({ origin: "https://page.example" }))).toBe("omit");
    expect(requestCredentials({ url: "https://cdn.example/x.js", credentials: "same-origin", referrer: "https://page.example/a" }, h())).toBe("omit");
    expect(requestCredentials({ url: "https://cdn.example/x.js", credentials: "same-origin" }, h({ referer: "https://page.example/a" }))).toBe("omit");
    expect(requestCredentials({ url: "https://page.example/api", credentials: "same-origin" }, h({ origin: "https://page.example" }))).toBe("include");
    expect(requestCredentials({ url: "http://127.0.0.1:2/x", credentials: "same-origin" }, h({ origin: "http://127.0.0.1:1" }))).toBe("omit"); // another port is another origin
  });
  it('"include", or no information, carries them, as before', () => {
    expect(requestCredentials({ url: "https://api.example/x", credentials: "include" }, h({ origin: "https://page.example" }))).toBe("include");
    expect(requestCredentials({ url: "https://api.example/x" }, h({ origin: "https://page.example" }))).toBe("include");
    expect(requestCredentials({ url: "https://api.example/x", credentials: "same-origin", referrer: "about:client" }, h())).toBe("include"); // no way to tell whose page this is
    expect(requestCredentials({ url: "not a url", credentials: "same-origin" }, h())).toBe("include");
  });
});
