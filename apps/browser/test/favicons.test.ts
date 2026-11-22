import { describe, expect, it } from "vitest";
import { FaviconStore, MAX_HOSTS, REFRESH_MS, hostOf, sniff, type Fetched } from "../src/favicons.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const ICO = new Uint8Array([0, 0, 1, 0, 9, 9]);

function store(over: { fetch?: (u: string) => Promise<Fetched | null>; file?: string | null } = {}) {
  const log = { fetched: [] as string[], saved: [] as (string | null)[] };
  let now = 1_000_000;
  const s = new FaviconStore({
    fetch: async (u) => { log.fetched.push(u); return over.fetch ? over.fetch(u) : { bytes: ICO, type: "text/plain" }; },
    shrink: () => "data:image/png;base64,c21hbGw=",
    load: () => over.file ?? null,
    save: (t) => log.saved.push(t),
    now: () => now,
  });
  return { s, log, tick: (ms: number) => (now += ms) };
}

describe("favicons", () => {
  it("knows the format from the bytes, whatever the server calls it", () => {
    expect(sniff(PNG)).toBe("image/png");
    expect(sniff(ICO)).toBe("image/x-icon");
    expect(sniff(new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="x"></svg>'))).toBe("image/svg+xml");
    expect(sniff(new TextEncoder().encode("<!DOCTYPE html><title>Not found</title>"))).toBe("text/html");
  });

  it("learns a site's icon once, from the page's first web or data: candidate, and keeps it by host", async () => {
    const { s, log } = store();
    const icon = await s.learn("https://www.example.com/a/b?x=1", ["chrome://x", "https://www.example.com/favicon.ico"]);
    expect(log.fetched).toEqual(["https://www.example.com/favicon.ico"]);
    expect(icon).toBe("data:image/x-icon;base64," + Buffer.from(ICO).toString("base64")); // an ICO is kept as it is
    expect(s.get("www.example.com")).toBe(icon);
    expect(await s.learn("https://www.example.com/other", ["https://www.example.com/favicon.ico"])).toBeNull();
    expect(log.fetched.length).toBe(1); // fresh: not fetched again
  });

  it("shrinks PNG and JPEG icons", async () => {
    const { s } = store({ fetch: async () => ({ bytes: PNG, type: "image/png" }) });
    expect(await s.learn("https://a.test/", ["https://a.test/i.png"])).toBe("data:image/png;base64,c21hbGw=");
  });

  it("takes an icon written into the page as data:", async () => {
    const { s, log } = store();
    const svg = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg'/>");
    expect(await s.learn("https://b.test/", [svg])).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(log.fetched).toEqual([]);
  });

  it("refuses what is not an image (a not-found page), and does not try that site again for a day", async () => {
    const { s, log, tick } = store({ fetch: async () => ({ bytes: new TextEncoder().encode("<html>404</html>"), type: "image/x-icon" }) });
    expect(await s.learn("https://c.test/", ["https://c.test/favicon.ico"])).toBeNull();
    expect(s.get("c.test")).toBeNull();
    await s.learn("https://c.test/", ["https://c.test/favicon.ico"]);
    expect(log.fetched.length).toBe(1);
    tick(25 * 3600 * 1000);
    await s.learn("https://c.test/", ["https://c.test/favicon.ico"]);
    expect(log.fetched.length).toBe(2);
  });

  it("refuses a huge icon", async () => {
    const big = new Uint8Array(200 * 1024); big.set(ICO);
    const { s } = store({ fetch: async () => ({ bytes: big, type: "image/x-icon" }) });
    expect(await s.learn("https://d.test/", ["https://d.test/favicon.ico"])).toBeNull();
  });

  it("looks again after a week, and only reports a change", async () => {
    const { s, log, tick } = store();
    await s.learn("https://e.test/", ["https://e.test/favicon.ico"]);
    tick(REFRESH_MS + 1);
    expect(await s.learn("https://e.test/", ["https://e.test/favicon.ico"])).toBeNull(); // same icon
    expect(log.fetched.length).toBe(2);
  });

  it("only web pages have icons", async () => {
    const { s, log } = store();
    expect(await s.learn("dbb-kept://1/", ["https://x.test/favicon.ico"])).toBeNull();
    expect(await s.learn("about:blank", ["https://x.test/favicon.ico"])).toBeNull();
    expect(log.fetched).toEqual([]);
    expect(hostOf("HTTP://Example.COM:8080/x")).toBe("example.com");
  });

  it("forgets one site, or all of them (an empty store deletes its file)", async () => {
    const { s, log } = store();
    await s.learn("https://f.test/", ["https://f.test/favicon.ico"]);
    await s.learn("https://g.test/", ["https://g.test/favicon.ico"]);
    s.forget("F.test");
    expect(s.get("f.test")).toBeNull();
    expect(JSON.parse(log.saved.at(-1)!).icons["g.test"]).toBeTruthy();
    s.forget();
    expect(s.size()).toBe(0);
    expect(log.saved.at(-1)).toBeNull();
  });

  it("survives a restart, ignores a damaged file, and keeps only the sites seen most recently", async () => {
    const a = store();
    await a.s.learn("https://h.test/", ["https://h.test/favicon.ico"]);
    a.s.flush();
    const b = store({ file: a.log.saved.at(-1)! });
    expect(b.s.get("h.test")).toMatch(/^data:image\//);
    expect(store({ file: "{not json" }).s.size()).toBe(0);
    expect(store({ file: JSON.stringify({ v: 1, icons: { "x.test": { icon: "javascript:alert(1)", at: 1 } } }) }).s.size()).toBe(0);
    const c = store();
    for (let i = 0; i < MAX_HOSTS + 5; i++) { c.tick(1); await c.s.learn(`https://s${i}.test/`, [`https://s${i}.test/favicon.ico`]); }
    expect(c.s.size()).toBe(MAX_HOSTS);
    expect(c.s.get("s0.test")).toBeNull();
    expect(c.s.get(`s${MAX_HOSTS + 4}.test`)).not.toBeNull();
  });
});
