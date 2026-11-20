import { describe, expect, it } from "vitest";
import { BookmarksService, LIMIT, normalizeUrl, parseLinks, type BookmarksDeps, type BookmarksState } from "../src/bookmarks-service";

const LINKS = JSON.stringify([
  { id: "a", url: "https://www.djangotricks.com/", title: "www.djangotricks.com", tags: "", is_public: false, project_id: null, created_at: "2026-11-19T04:24:52Z" },
  { id: "b", url: "https://facebook.com", title: "Facebook", tags: "social, people", is_public: false, project_id: null, created_at: "2026-11-17T16:42:31Z" },
  { id: "c", url: "javascript:alert(1)", title: "bad" },
  { id: "d", url: "https://untitled.example/page", title: "" },
]);

function make(over: Partial<BookmarksDeps> & { signedIn?: boolean; loaded?: boolean; reply?: string; copy?: string | null } = {}) {
  const calls: Array<[string, Record<string, unknown>, { fixed: boolean }]> = [];
  const changed: BookmarksState[] = [];
  let saved: string | null = over.copy ?? null;
  let reply = over.reply ?? LINKS;
  const deps: BookmarksDeps = {
    call: async (tool, args, opts) => {
      calls.push([tool, args, opts]);
      if (tool === "create_link") {
        const list = JSON.parse(reply) as unknown[];
        reply = JSON.stringify([{ id: "new", url: args.url, title: args.title }, ...list]);
        return JSON.stringify({ id: "new" });
      }
      return reply;
    },
    connected: () => over.signedIn ?? true,
    ready: () => over.loaded ?? true,
    loadCopy: () => saved,
    saveCopy: (t) => void (saved = t),
    changed: (s) => void changed.push(s),
    now: () => 1_000_000,
    ...over,
  };
  return { svc: new BookmarksService(deps), calls, changed, saved: () => saved };
}

describe("reading the service's links", () => {
  it("keeps web addresses only, falls back to the host for a missing title, and splits tags", () => {
    const b = parseLinks(LINKS);
    expect(b.map((x) => x.id)).toEqual(["a", "b", "d"]);
    expect(b[1]).toMatchObject({ title: "Facebook", tags: ["social", "people"], createdAt: "2026-11-17T16:42:31Z" });
    expect(b[2]?.title).toBe("untitled.example");
    expect(parseLinks(JSON.stringify({ links: [{ url: "https://x.example", title: "X" }] }))[0]?.url).toBe("https://x.example");
    expect(parseLinks("not json")).toEqual([]);
  });

  it("compares addresses the way people mean them", () => {
    expect(normalizeUrl("https://Facebook.com/")).toBe(normalizeUrl("https://facebook.com"));
    expect(normalizeUrl("https://x.example/a/#top")).toBe(normalizeUrl("https://x.example/a"));
    expect(normalizeUrl("https://x.example/a?q=1")).not.toBe(normalizeUrl("https://x.example/a"));
    expect(normalizeUrl("https://x.example/a?utm_source=news&fbclid=1&guccounter=2")).toBe(normalizeUrl("https://x.example/a")); // tracking only
    expect(normalizeUrl("https://www.youtube.com/watch?v=abc")).not.toBe(normalizeUrl("https://www.youtube.com/watch?v=xyz")); // a real query is the page
  });
});

describe("the bookmarks list", () => {
  it("loads from the service when asked, keeps a local copy, and says when the list changed", async () => {
    const { svc, calls, changed, saved } = make();
    expect(svc.state()).toMatchObject({ items: [], source: "none" });
    const s = await svc.refresh();
    expect(calls).toEqual([["list_links", { limit: LIMIT }, { fixed: false }]]); // reading never applies the entry's fixed project
    expect(s).toMatchObject({ source: "service", connected: true, updatedAt: 1_000_000 });
    expect(s.items).toHaveLength(3);
    expect(changed).toHaveLength(1);
    expect(JSON.parse(saved() as string).items).toHaveLength(3);
    await svc.refresh();
    expect(changed).toHaveLength(2); // the same list again is still announced: the window may not know it is connected yet
    expect(svc.has("https://facebook.com/")).toBe(true);
    expect(svc.has("https://elsewhere.example")).toBe(false);
  });

  it("shows the local copy at start-up without reaching the service (or the keychain)", async () => {
    const first = make();
    await first.svc.refresh();
    const again = make({ copy: first.saved(), loaded: false, connected: () => { throw new Error("must not read the sign-in at start-up"); } });
    expect(again.svc.state()).toMatchObject({ source: "copy", updatedAt: 1_000_000, connected: false });
    expect(again.svc.state().items).toHaveLength(3);
    expect(again.svc.has("https://facebook.com")).toBe(true);
    expect(again.calls).toEqual([]);
  });

  it("asks nothing of the service when not signed in, and reports errors instead of throwing", async () => {
    const out = make({ signedIn: false });
    expect(await out.svc.refresh()).toMatchObject({ connected: false, items: [] });
    expect(out.calls).toEqual([]);
    const bad = make({ call: async () => { throw new Error("askrobots.com wants a fresh sign-in"); } });
    expect((await bad.svc.refresh()).error).toMatch(/fresh sign-in/);
  });

  it("two refreshes at once make one request", async () => {
    const { svc, calls } = make();
    await Promise.all([svc.refresh(), svc.refresh()]);
    expect(calls).toHaveLength(1);
  });
});

describe("saving with one click", () => {
  it("saves with the page's title, applies the entry's fixed arguments, and refreshes the list", async () => {
    const { svc, calls } = make();
    await svc.refresh();
    const r = await svc.add("https://new.example/page", "A new page");
    expect(r).toEqual({ ok: true });
    expect(calls[1]).toEqual(["create_link", { url: "https://new.example/page", title: "A new page" }, { fixed: true }]);
    expect(svc.has("https://new.example/page")).toBe(true);
  });

  it("loads the list before saving when it has not been loaded yet, so a page is never saved twice", async () => {
    const { svc, calls } = make();
    expect(await svc.add("https://facebook.com/", "Facebook")).toEqual({ ok: true, already: true });
    expect(calls.map(([t]) => t)).toEqual(["list_links"]);
  });

  it("does not save twice, refuses what is not a web page, and says to connect when not signed in", async () => {
    const { svc, calls } = make();
    await svc.refresh();
    expect(await svc.add("https://facebook.com", "Facebook")).toEqual({ ok: true, already: true });
    expect(calls.filter(([t]) => t === "create_link")).toHaveLength(0);
    expect((await svc.add("file:///etc/passwd", "x")).ok).toBe(false);
    expect(await make({ signedIn: false }).svc.add("https://x.example", "X")).toMatchObject({ ok: false, message: expect.stringMatching(/Connect askrobots/) });
  });
});

describe("searching all the links", () => {
  it("sends only what was typed, to the service's own search, and leaves the local list alone", async () => {
    const { svc, calls } = make();
    await svc.refresh();
    const r = await svc.search("  face ");
    expect(calls.at(-1)).toEqual(["list_links", { search: "face", limit: LIMIT }, { fixed: false }]);
    expect(r.items.length).toBeGreaterThan(0);
    expect(svc.state().items).toHaveLength(3);
    expect(await svc.search("f")).toEqual({ items: [] }); // too short: nothing sent
    expect(await make({ signedIn: false }).svc.search("face")).toMatchObject({ items: [], error: expect.stringMatching(/Connect/) });
  });

  it("remembers older bookmarks a search turned up, so ☆ knows those pages are saved, and keeps them in the local copy", async () => {
    const old = JSON.stringify([{ id: "z", url: "https://finance.yahoo.com/news/old-story", title: "Old story" }]);
    const changed: BookmarksState[] = [];
    let copy: string | null = null;
    let calls = 0;
    const svc = new BookmarksService({
      call: async (_t, args) => (calls++, args.search ? old : LINKS), connected: () => true, ready: () => true,
      loadCopy: () => copy, saveCopy: (t) => void (copy = t), changed: (s) => void changed.push(s),
    });
    await svc.refresh();
    expect(svc.has("https://finance.yahoo.com/news/old-story")).toBe(false);
    await svc.search("yahoo");
    expect(svc.has("https://finance.yahoo.com/news/old-story?guccounter=1")).toBe(true);
    expect(svc.state().known.map((b) => b.title)).toEqual(["Old story"]);
    expect(changed.at(-1)?.known).toHaveLength(1);
    const again = new BookmarksService({ call: async () => "[]", connected: () => true, ready: () => false, loadCopy: () => copy, saveCopy: () => {}, changed: () => {} });
    expect(again.has("https://finance.yahoo.com/news/old-story")).toBe(true); // remembered across a restart
    expect(calls).toBe(2);
  });

  it("checks the site of a page that is not known locally, once per site, and remembers what it finds", async () => {
    const siteLinks = JSON.stringify([{ id: "s1", url: "https://finance.yahoo.com/news/old-story", title: "Old story" }, { id: "s2", url: "https://elsewhere.example/x", title: "Not this site" }]);
    const calls: Array<Record<string, unknown>> = [];
    let copy: string | null = null;
    const svc = new BookmarksService({
      call: async (_t, args) => (calls.push(args), args.search ? siteLinks : "[]"), connected: () => true, ready: () => true,
      loadCopy: () => copy, saveCopy: (t) => void (copy = t), changed: () => {},
    });
    expect(await svc.checkPage("https://finance.yahoo.com/news/old-story?guccounter=1")).toEqual({ checked: true, saved: true });
    expect(calls).toEqual([{ search: "finance.yahoo.com", limit: LIMIT }]); // only the site's name was sent
    expect(svc.has("https://elsewhere.example/x")).toBe(false); // results for other sites are not taken
    await svc.checkPage("https://finance.yahoo.com/news/other");
    expect(calls).toHaveLength(1); // once per site: the first answer held every saved page there
  });

  it("asks about the page itself when the site has more saved pages than one answer holds", async () => {
    const many = JSON.stringify(Array.from({ length: LIMIT }, (_, i) => ({ id: "m" + i, url: `https://big.example/p${i}`, title: "p" + i })));
    const calls: Array<Record<string, unknown>> = [];
    const svc = new BookmarksService({
      call: async (_t, args) => (calls.push(args), String(args.search).startsWith("big.example/old") ? JSON.stringify([{ id: "o", url: "https://big.example/old", title: "old" }]) : many),
      connected: () => true, ready: () => true, loadCopy: () => null, saveCopy: () => {}, changed: () => {},
    });
    expect(await svc.checkPage("https://big.example/old")).toEqual({ checked: true, saved: true });
    expect(calls.map((c) => c.search)).toEqual(["big.example", "big.example/old"]);
  });

  it("asks nothing when the setting is off, or before the connection has been opened this session", async () => {
    const calls: unknown[] = [];
    const deps = { call: async () => (calls.push(1), "[]"), connected: () => true, loadCopy: () => null, saveCopy: () => {}, changed: () => {} };
    const off = new BookmarksService({ ...deps, ready: () => true });
    off.setCheckPages(false);
    expect(await off.checkPage("https://x.example/a")).toEqual({ checked: false, saved: false });
    const notYet = new BookmarksService({ ...deps, ready: () => false });
    expect(await notYet.checkPage("https://x.example/a")).toEqual({ checked: false, saved: false });
    expect(calls).toHaveLength(0);
    expect(off.state().checkPages).toBe(false);
  });

  it("tells the window after every load, so a window that started from the local copy learns it is connected", async () => {
    const first = make();
    await first.svc.refresh();
    const again = make({ copy: first.saved() });
    expect(again.svc.state().source).toBe("copy");
    await again.svc.refresh(); // the same list as the copy
    expect(again.changed.at(-1)).toMatchObject({ source: "service", connected: true });
  });

  it("a check that fails is not remembered as done, and says why", async () => {
    let fail = true;
    const svc = new BookmarksService({
      call: async () => { if (fail) throw new Error("network down"); return JSON.stringify([{ id: "s", url: "https://slashdot.org/", title: "slashdot" }]); },
      connected: () => true, ready: () => true, loadCopy: () => null, saveCopy: () => {}, changed: () => {},
    });
    expect(await svc.checkPage("https://slashdot.org/")).toEqual({ checked: false, saved: false });
    expect(svc.state().error).toMatch(/could not check slashdot.org: network down/);
    fail = false;
    expect(await svc.checkPage("https://slashdot.org/")).toEqual({ checked: true, saved: true }); // tried again
  });
});

