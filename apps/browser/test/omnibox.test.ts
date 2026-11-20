import { describe, expect, it } from "vitest";
import { autofillHost, looksLikeAddress, parseSuggestions, remoteAllowed, suggest } from "../src/omnibox";

const tabs = [
  { id: 1, url: "https://askrobots.com/", title: "Home - AskRobots" },
  { id: 2, url: "https://www.youtube.com/watch?v=x", title: "A song - YouTube" },
];
const bookmarks = [
  { url: "https://slashdot.org/", title: "Slashdot" },
  { url: "https://slashdot.org/story/1", title: "Amazon Fights the Delivery Protection Act" },
  { url: "https://slashgear.com/", title: "SlashGear" },
  { url: "https://coolify.io/docs/update", title: "Update Coolify | Coolify Docs" },
  { url: "https://news.example/marmalade", title: "Seville marmalade, the right way" },
];
const kept = [{ id: "0123456789abcdef", url: "https://recipes.example/zebra", title: "Zebra cake", view: "dbb-kept://0123456789abcdef/" }];

describe("the address bar", () => {
  it("tells addresses from searches, as Enter does", () => {
    for (const a of ["slashdot.org", "https://x.example/a b", "localhost:3000", "192.168.1.5/admin", "about:blank"]) expect(looksLikeAddress(a), a).toBe(true);
    for (const q of ["slashdot", "coolify update", "what is x402", ""]) expect(looksLikeAddress(q), q).toBe(false);
  });

  it("asks for search suggestions only for text that is not an address or part of one", () => {
    expect(remoteAllowed("coolify update")).toBe(true);
    expect(remoteAllowed("slash")).toBe(true);
    for (const t of ["slashdot.org", "https://intranet.example/secret", "localhost", "a", "user@host", "intranet/secret", "x".repeat(101)]) expect(remoteAllowed(t), t).toBe(false);
  });

  it("completes a site you use from what you typed, the most used one first", () => {
    const urls = bookmarks.map((b) => b.url);
    expect(autofillHost("slash", urls)).toBe("slashdot.org"); // saved twice
    expect(autofillHost("slashg", urls)).toBe("slashgear.com");
    expect(autofillHost("www.cool", urls)).toBe("coolify.io");
    expect(autofillHost("s", urls)).toBeNull(); // too short
    expect(autofillHost("slash dot", urls)).toBeNull();
    expect(autofillHost("slashdot.org", urls)).toBeNull(); // already complete
    expect(autofillHost("zzz", urls)).toBeNull();
    expect(autofillHost("loc", ["http://localhost:8899/x", "file:///etc/x"])).toBe("localhost:8899");
    expect(suggest({ text: "loc", tabs: [{ id: 3, url: "http://localhost:8899/x", title: "Local" }], bookmarks: [], kept: [] }).rows[0]).toEqual({ kind: "go", url: "http://localhost:8899/", title: "localhost:8899" });
  });

  it("puts what Enter does first, then tabs, saved links and kept copies, and the assistant last", () => {
    const r = suggest({ text: "slash", tabs, activeTab: 1, bookmarks, kept });
    expect(r.autofill).toBe("slashdot.org");
    expect(r.rows[0]).toEqual({ kind: "go", url: "https://slashdot.org/", title: "slashdot.org" });
    expect(r.rows.filter((x) => x.kind === "bookmark").map((x) => (x as { url: string }).url)).toEqual(["https://slashdot.org/", "https://slashdot.org/story/1", "https://slashgear.com/"]);
    expect(r.rows.at(-1)).toEqual({ kind: "ask", text: "slash" });

    const s = suggest({ text: "seville marmalade", tabs, bookmarks, kept });
    expect(s.rows[0]).toEqual({ kind: "search", text: "seville marmalade" });
    expect(s.rows[1]).toMatchObject({ kind: "bookmark", url: "https://news.example/marmalade" });

    const t = suggest({ text: "song", tabs, activeTab: 1, bookmarks, kept });
    expect(t.rows[1]).toEqual({ kind: "tab", id: 2, url: "https://www.youtube.com/watch?v=x", title: "A song - YouTube" });
    expect(suggest({ text: "home", tabs, activeTab: 1, bookmarks, kept }).rows.some((x) => x.kind === "tab")).toBe(false); // not the tab you are on

    const k = suggest({ text: "zebra", tabs, bookmarks, kept });
    expect(k.rows.find((x) => x.kind === "kept")).toEqual({ kind: "kept", url: "dbb-kept://0123456789abcdef/", title: "Zebra cake", original: "https://recipes.example/zebra" });

    const a = suggest({ text: "coolify.io/docs", tabs, bookmarks, kept });
    expect(a.rows[0]).toEqual({ kind: "go", url: "coolify.io/docs", title: "coolify.io/docs" });
    expect(a.rows.some((x) => x.kind === "ask")).toBe(false); // an address is not a question

    expect(suggest({ text: "slash", tabs, bookmarks, kept, autofill: false }).rows[0]).toEqual({ kind: "search", text: "slash" }); // while deleting
    expect(suggest({ text: "  ", tabs, bookmarks, kept }).rows).toEqual([]);
  });

  it("an open tab is not listed again as a saved link", () => {
    const r = suggest({ text: "slashdot", tabs: [{ id: 9, url: "https://slashdot.org", title: "Slashdot" }], bookmarks, kept });
    expect(r.rows.filter((x) => x.kind === "tab")).toHaveLength(1);
    expect(r.rows.filter((x) => x.kind === "bookmark").map((x) => (x as { url: string }).url)).toEqual(["https://slashdot.org/story/1"]);
  });

  it("reads OpenSearch suggestions, without the text itself, duplicates or junk", () => {
    expect(parseSuggestions('["slash", ["slashdot", "slash", "Slashdot", "slashfilm", 3, ""]]', "slash")).toEqual(["slashdot", "slashfilm"]);
    expect(parseSuggestions("not json", "x")).toEqual([]);
    expect(parseSuggestions('{"a":1}', "x")).toEqual([]);
    expect(parseSuggestions(JSON.stringify(["q", Array.from({ length: 20 }, (_, i) => "q" + i)]), "q")).toHaveLength(5);
  });
});
