import { describe, expect, it } from "vitest";
import { EXPIRED_HTML, READER_SCHEME, ReaderPages, readerIdFromUrl, readerUrl } from "../src/reader-pages.js";

describe("ReaderPages", () => {
  it("stores a page under a short opaque id and serves it back", () => {
    const pages = new ReaderPages();
    const id = pages.put("<p>hi</p>");
    expect(id).toMatch(/^[0-9a-f]{18}$/);
    expect(pages.get(id)).toBe("<p>hi</p>");
    expect(readerUrl(id)).toBe(`${READER_SCHEME}://${id}/`);
  });
  it("update() replaces the content (the summary arrived), so a later load shows the finished page", () => {
    const pages = new ReaderPages();
    const id = pages.put("pending skeleton");
    expect(pages.update(id, "finished page with TL;DR")).toBe(true);
    expect(pages.get(id)).toBe("finished page with TL;DR");
  });
  it("update() on an evicted page is a harmless no-op", () => {
    const pages = new ReaderPages(2);
    const first = pages.put("a");
    pages.put("b");
    pages.put("c"); // evicts the oldest
    expect(pages.get(first)).toBeUndefined();
    expect(pages.update(first, "late")).toBe(false);
    expect(pages.get(first)).toBeUndefined();
  });
  it("is bounded: only the newest `max` pages are kept", () => {
    const pages = new ReaderPages(3);
    const ids = ["1", "2", "3", "4", "5"].map((x) => pages.put(x));
    expect(pages.size).toBe(3);
    expect(ids.map((i) => pages.get(i))).toEqual([undefined, undefined, "3", "4", "5"]);
  });
  it("ids are unique and unguessable-looking", () => {
    const pages = new ReaderPages(1000);
    expect(new Set(Array.from({ length: 500 }, () => pages.put("x"))).size).toBe(500);
  });
});

describe("readerIdFromUrl — only our own URLs resolve", () => {
  it("accepts a well-formed reader URL", () => {
    const id = "0123456789abcdef01";
    expect(readerIdFromUrl(readerUrl(id))).toBe(id);
    expect(readerIdFromUrl(`${readerUrl(id)}?x=1#frag`)).toBe(id);
  });
  it("rejects other schemes, odd hosts and garbage", () => {
    for (const bad of ["https://0123456789abcdef01/", "dbb-reader://evil/", "dbb-reader://0123456789abcdef0123/", "dbb-reader://../../etc/passwd", "dbb-reader://", "not a url", ""]) {
      expect(readerIdFromUrl(bad)).toBeNull();
    }
  });
  it("the expired notice is a script-free page", () => {
    expect(EXPIRED_HTML).not.toMatch(/<script/i);
    expect(EXPIRED_HTML).toMatch(/default-src 'none'/);
  });
});
