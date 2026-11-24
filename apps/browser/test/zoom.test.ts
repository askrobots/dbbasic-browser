import { describe, expect, it } from "vitest";
import { MAX_SITES, stepZoom, zoomLabel, zoomSite, ZoomStore, ZOOM_STEPS } from "../src/zoom";

describe("zoom steps", () => {
  it("go up and down Chrome's steps, and back to 100%", () => {
    expect(stepZoom(1, "in")).toBe(1.1);
    expect(stepZoom(1.1, "in")).toBe(1.25);
    expect(stepZoom(1, "out")).toBe(0.9);
    expect(stepZoom(0.9, "out")).toBe(0.8);
    expect(stepZoom(2.5, "reset")).toBe(1);
  });
  it("stop at 25% and 500%", () => {
    expect(stepZoom(5, "in")).toBe(5);
    expect(stepZoom(0.25, "out")).toBe(0.25);
  });
  it("from a size between steps, go to the next step that way (a pinch, an old value)", () => {
    expect(stepZoom(1.17, "in")).toBe(1.25);
    expect(stepZoom(1.17, "out")).toBe(1.1);
    expect(stepZoom(1.1000001, "in")).toBe(1.25); // not stuck on the step it is already at
    expect(stepZoom(Number.NaN, "in")).toBe(1.1);
  });
  it("label as a percent", () => {
    expect(zoomLabel(1.25)).toBe("125%");
    expect(zoomLabel(0.33)).toBe("33%");
    expect(ZOOM_STEPS).toContain(1);
  });
});

describe("which site a page's zoom belongs to", () => {
  it("is the host name of a web page, port and case aside", () => {
    expect(zoomSite("https://X.com/home")).toBe("x.com");
    expect(zoomSite("http://127.0.0.1:8899/a")).toBe("127.0.0.1");
  });
  it("is none for the browser's own pages and anything else", () => {
    expect(zoomSite("dbb-cards://view/1")).toBeNull();
    expect(zoomSite("about:blank")).toBeNull();
    expect(zoomSite("not a url")).toBeNull();
  });
});

describe("the remembered sizes", () => {
  it("are saved, read back after a restart, and 100% is forgotten", () => {
    let file: string | null = null;
    const a = new ZoomStore(null, (t) => (file = t));
    a.set("x.com", 1.25);
    a.set("ebay.com", 0.9);
    expect(a.get("x.com")).toBe(1.25);
    const b = new ZoomStore(file, () => {});
    expect(b.get("x.com")).toBe(1.25);
    expect(b.get("ebay.com")).toBe(0.9);
    expect(b.get("other.com")).toBe(1);
    expect(b.get(null)).toBe(1);
    a.set("x.com", 1);
    expect(JSON.parse(file!).sites).toEqual({ "ebay.com": 0.9 });
  });
  it("ignore a damaged file and values out of range", () => {
    expect(new ZoomStore("{nope", () => {}).size).toBe(0);
    const s = new ZoomStore(JSON.stringify({ v: 1, sites: { "a.com": 99, "b.com": "2", "c.com": 1.5 } }), () => {});
    expect(s.get("a.com")).toBe(1);
    expect(s.get("b.com")).toBe(1);
    expect(s.get("c.com")).toBe(1.5);
  });
  it("keep at most MAX_SITES, dropping the oldest change", () => {
    const s = new ZoomStore(null, () => {});
    for (let i = 0; i <= MAX_SITES; i++) s.set(`s${i}.com`, 1.1);
    expect(s.size).toBe(MAX_SITES);
    expect(s.get("s0.com")).toBe(1);
    expect(s.get(`s${MAX_SITES}.com`)).toBe(1.1);
  });
});
