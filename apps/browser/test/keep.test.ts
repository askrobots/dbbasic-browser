import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KeepStore, keptFilename, keptPageHtml, keptUrl, parseKeptUrl } from "../src/keep-store";

const store = () => new KeepStore(join(mkdtempSync(join(tmpdir(), "keep-")), "kept"));

describe("kept copies", () => {
  it("keeps the text, the picture and a record, and lists newest first", async () => {
    const s = store();
    const a = await s.add({ url: "https://a.example/x", title: "A page", text: "alpha words here", png: Buffer.from([1, 2, 3]), now: 1000 });
    const b = await s.add({ url: "https://b.example/y", title: "B page", text: "beta words", png: null, reason: "read later", tags: [" news ", ""], now: 2000 });
    expect(a).toMatchObject({ title: "A page", textChars: 16, imageBytes: 3, tags: [] });
    expect(b).toMatchObject({ reason: "read later", tags: ["news"], imageBytes: 0 });
    expect((await s.list()).map((r) => r.id)).toEqual([b.id, a.id]);
    expect((await s.get(a.id))?.text).toBe("alpha words here");
    expect(await s.image(a.id)).toEqual(Buffer.from([1, 2, 3]));
    expect(await s.image(b.id)).toBeNull();
  });

  it("finds pages by every word of a search, in title, address, reason, tags or text, with the words around the match", async () => {
    const s = store();
    await s.add({ url: "https://r.example/marmalade", title: "Recipes", text: "First line.\nThe quick brown zebra keeps a secret recipe for marmalade.", png: null });
    await s.add({ url: "https://n.example/", title: "News", text: "nothing here", png: null, tags: ["zebra"] });
    const hit = await s.list("zebra marmalade");
    expect(hit.map((r) => r.title)).toEqual(["Recipes"]);
    expect(hit[0]?.snippet).toMatch(/quick brown zebra keeps/);
    expect((await s.list("zebra")).length).toBe(2); // the tag counts too
    expect(await s.list("pineapple")).toEqual([]);
  });

  it("removes a copy, and never reaches outside its folder", async () => {
    const s = store();
    const a = await s.add({ url: "https://a.example/", title: "A", text: "x", png: null });
    expect(await s.remove(a.id)).toBe(true);
    expect(await s.get(a.id)).toBeNull();
    expect(await s.get("../../etc")).toBeNull();
    expect(await s.remove("../x")).toBe(false);
  });

  it("only its own addresses are served, and the page shown has nothing that runs and escapes what the page said", () => {
    expect(parseKeptUrl(keptUrl("0123456789abcdef"))).toEqual({ id: "0123456789abcdef", file: "" });
    expect(parseKeptUrl(keptUrl("0123456789abcdef", "page.png"))).toEqual({ id: "0123456789abcdef", file: "page.png" });
    expect(parseKeptUrl("dbb-kept://0123456789abcdef/../../secret")).toBeNull();
    expect(parseKeptUrl("dbb-kept://short/")).toBeNull();
    expect(parseKeptUrl("https://0123456789abcdef/")).toBeNull();
    const html = keptPageHtml({ id: "0123456789abcdef", url: "https://x.example/\"><script>", title: "<b>T</b>", keptAt: 0, tags: [], textChars: 5, imageBytes: 0 }, "a <script>alert(1)</script> b");
    expect(html).not.toMatch(/<script>/);
    expect(html).toMatch(/default-src 'none'/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("names files readably: title, site and date, without characters file systems dislike", () => {
    const at = Date.UTC(2026, 10, 20, 12);
    expect(keptFilename({ title: "Amazon Fights the Delivery Protection Act", url: "https://slashdot.org/story/1", keptAt: at }, "png")).toBe("Amazon Fights the Delivery Protection Act (slashdot.org, 2026-11-20).png");
    expect(keptFilename({ title: "a/b: c? <d> | e", url: "https://www.x.example/", keptAt: at }, "txt")).toBe("a b c d e (x.example, 2026-11-20).txt");
    expect(keptFilename({ title: "slashdot.org", url: "https://slashdot.org/", keptAt: at }, "png")).toBe("slashdot.org (2026-11-20).png"); // the site is not said twice
    expect(keptFilename({ title: "", url: "https://y.example/", keptAt: at }, "png")).toBe("y.example (2026-11-20).png");
    expect(keptFilename({ title: "x".repeat(200), url: "https://z.example/", keptAt: at }, "png").length).toBeLessThan(130);
  });

  it("updates a record (what was saved to the account)", async () => {
    const s = store();
    const a = await s.add({ url: "https://a.example/", title: "A", text: "x", png: null });
    const u = await s.update(a.id, { remote: { files: [{ kind: "text", filename: "A (a.example, 2026-11-20).txt", id: "f1" }] } });
    expect(u?.remote?.files[0]?.id).toBe("f1");
    expect((await s.get(a.id))?.record.remote?.files).toHaveLength(1);
    expect(await s.update("0000000000000000", { title: "x" })).toBeNull();
  });
});

