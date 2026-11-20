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
    expect(changed).toHaveLength(1); // the same list again: no change event
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

  it("does not save twice, refuses what is not a web page, and says to connect when not signed in", async () => {
    const { svc, calls } = make();
    await svc.refresh();
    expect(await svc.add("https://facebook.com", "Facebook")).toEqual({ ok: true, already: true });
    expect(calls.filter(([t]) => t === "create_link")).toHaveLength(0);
    expect((await svc.add("file:///etc/passwd", "x")).ok).toBe(false);
    expect(await make({ signedIn: false }).svc.add("https://x.example", "X")).toMatchObject({ ok: false, message: expect.stringMatching(/Connect askrobots/) });
  });
});
