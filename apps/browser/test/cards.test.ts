import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildCardsHtml, mergePosts, readerSource, shortStats, shortTime, validatePosts, validateViewRule, type Post, type ViewRule } from "../src/cards";

// X's view rule, as published in the askrobots/x-cards plugin (no card view is built into the browser).
const X_VIEW_RULE = JSON.parse(readFileSync(new URL("./fixtures/x-cards.json", import.meta.url), "utf8")) as ViewRule;

const post = (over: Partial<Post> = {}): Post => ({
  link: "https://x.com/a/status/1", author: "A", handle: "@a", avatar: "", time: "", timeText: "2h", text: "hi", images: [], stats: "", context: "", promoted: false, ...over,
});

describe("view rules are data", () => {
  it("accepts X's rule", () => {
    expect(validateViewRule(X_VIEW_RULE).ok).toBe(true);
  });

  it("refuses anything but selectors, known fields and plain takes", () => {
    const bad = (fields: unknown) => validateViewRule({ ...X_VIEW_RULE, fields }) as { ok: boolean; error?: string };
    expect(bad({ text: { sel: "div", take: "innerHTML" } }).ok).toBe(false);
    expect(bad({ script: { sel: "div", take: "text" } }).error).toMatch(/unknown field script/);
    expect(bad({ text: { sel: "div", take: "text", code: "alert(1)" } }).error).toMatch(/has code/);
    expect(bad({ text: { sel: "div", take: "text", match: "(" } }).error).toMatch(/bad match/);
    expect(validateViewRule({ ...X_VIEW_RULE, post: "" }).ok).toBe(false);
    expect(validateViewRule({ ...X_VIEW_RULE, sites: ["evil site"] }).ok).toBe(false);
  });

  it("the reader carries the rule as JSON only", () => {
    const src = readerSource(X_VIEW_RULE);
    expect(src).toContain(JSON.stringify(X_VIEW_RULE));
    expect(() => new Function(`return ${src.replace(/\)\(\{[\s\S]*\}\)$/, ")")}`)).not.toThrow();
  });
});

describe("what the page returns is untrusted", () => {
  it("keeps only posts linking to the rule's own sites over https, and plain https images", () => {
    const got = validatePosts({ posts: [
      { link: "https://x.com/a/status/1", text: "ok", images: ["https://pbs.twimg.com/media/a.jpg", "javascript:alert(1)", "http://pbs.twimg.com/b.jpg"] },
      { link: "https://evil.test/a/status/2", text: "elsewhere" },
      { link: "javascript:alert(1)", text: "script" },
      { link: "http://x.com/a/status/3", text: "plain http" },
      "not an object",
    ] }, X_VIEW_RULE);
    expect(got.map((p) => p.text)).toEqual(["ok"]);
    expect(got[0]!.images).toEqual(["https://pbs.twimg.com/media/a.jpg"]);
  });

  it("clamps sizes and keeps a handle only when it looks like one", () => {
    const [p] = validatePosts({ posts: [{ link: "https://x.com/a/status/1", text: "x".repeat(9000), handle: "@a <b>", author: "Name\n@a\n·", time: "2026-11-23T12:00:00.000Z" }] }, X_VIEW_RULE);
    expect(p!.text.length).toBe(4000);
    expect(p!.handle).toBe("");
    expect(p!.author).toBe("Name");
    expect(p!.time).toBe("2026-11-23T12:00:00.000Z");
  });

  it("merges by the post's address, keeping order and the fuller copy", () => {
    const m = new Map<string, Post>();
    expect(mergePosts(m, [post(), post({ link: "https://x.com/b/status/2" })])).toBe(2);
    expect(mergePosts(m, [post({ link: "https://x.com/a/status/1?s=20", images: ["https://pbs.twimg.com/media/a.jpg"] })])).toBe(0);
    expect([...m.values()].map((p) => p.images.length)).toEqual([1, 0]);
  });
});

describe("the card page", () => {
  const page = (posts: Post[]) => buildCardsHtml({ rule: X_VIEW_RULE, source: "https://x.com/home", title: "Home / X", posts, moreUrl: "dbb-cards://0123456789abcdef01/more", collectedAt: new Date("2026-11-23T15:00:00Z") });

  it("escapes everything and has no scripts", () => {
    const html = page([post({ text: `<script>alert(1)</script><img src=x onerror=alert(1)>`, author: `"><svg onload=alert(1)>` })]);
    expect(html).not.toMatch(/<script|<svg|<img src=x/i); // (the words survive as escaped text, never as markup)
    expect(html).toContain("&lt;script&gt;");
    expect(html).toMatch(/Content-Security-Policy" content="default-src 'none'; img-src https:/);
  });

  it("hides promoted posts behind a line that says how many", () => {
    const html = page([post(), post({ link: "https://x.com/ad/status/9", promoted: true })]);
    expect(html).toMatch(/1 post from x\.com/);
    expect(html).toMatch(/<details><summary>1 promoted post hidden/);
  });

  it("offers More posts only while the tab they came from is open", () => {
    expect(page([post()])).toMatch(/class="more" href="dbb-cards:\/\/0123456789abcdef01\/more"/);
    const closed = buildCardsHtml({ rule: X_VIEW_RULE, source: "https://x.com/home", title: "", posts: [post()], moreUrl: "", collectedAt: new Date() });
    expect(closed).not.toMatch(/\/more"/);
    expect(closed).toMatch(/tab these came from is closed/);
  });

  it("lays cards out as masonry: each to the shortest column, one layout per column count", async () => {
    const { masonry, estimateHeight, COLUMN_COUNTS } = await import("../src/cards");
    const cols = masonry([100, 300, 100, 100], 2, (x) => x);
    expect(cols).toEqual([[100, 100, 100], [300]]);
    expect(estimateHeight(post({ text: "x".repeat(2000) }))).toBeLessThan(estimateHeight(post({ text: "short", images: ["https://pbs.twimg.com/media/a.jpg"] })) + 200); // long text is cut to ten lines
    const html = page([post(), post({ link: "https://x.com/b/status/2" })]);
    for (const n of COLUMN_COUNTS) expect(html).toContain(`class="m m${n}"`);
  });

  it("puts each More posts read under its own line, the newest one the #new anchor", () => {
    const html = buildCardsHtml({ rule: X_VIEW_RULE, source: "https://x.com/home", title: "", posts: [post(), post({ link: "https://x.com/b/status/2" }), post({ link: "https://x.com/c/status/3" })], moreUrl: "", batches: [{ from: 1, at: new Date() }, { from: 2, at: new Date() }], collectedAt: new Date() });
    expect(html.match(/class="batch"/g)?.length).toBe(2);
    expect(html.match(/id="new"/g)?.length).toBe(1);
    expect(html.indexOf('id="new"')).toBeGreaterThan(html.lastIndexOf('class="batch"') - 1);
  });

  it("says what a More posts read found when nothing new came, at the #new anchor", () => {
    const html = buildCardsHtml({ rule: X_VIEW_RULE, source: "https://x.com/home", title: "", posts: [post(), post({ link: "https://x.com/b/status/2" })], moreUrl: "", batches: [{ from: 1, at: new Date() }], note: "More posts scrolled 12 screens and read 30 posts, all already here <b>", collectedAt: new Date() });
    expect(html).toMatch(/<p class="note" id="new">More posts scrolled 12 screens and read 30 posts, all already here &lt;b&gt;<\/p>/);
    expect(html.match(/id="new"/g)?.length).toBe(1);
  });

  it("shortens counts and times the way X does", () => {
    expect(shortStats("61 replies, 223 reposts, 1554 likes, 78 bookmarks, 254134 views")).toBe("61 replies · 223 reposts · 1.6K likes · 254K views");
    const now = new Date("2026-11-23T15:00:00Z");
    expect(shortTime("2026-11-23T14:59:30Z", now)).toBe("now");
    expect(shortTime("2026-11-23T14:30:00Z", now)).toBe("30m");
    expect(shortTime("2026-11-23T10:00:00Z", now)).toBe("5h");
    expect(shortTime("2026-11-20T10:00:00Z", now)).toBe("Nov 20");
  });
});
