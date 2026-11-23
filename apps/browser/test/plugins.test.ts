import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitBlobId, parsePluginSource, parseTagRefs, siteMatches, styleProblem, validateManifest } from "../src/plugins.ts";
import { PluginStore, describePowers, type Fetched } from "../src/plugin-service.ts";
// @ts-expect-error: a plain .mjs test helper, shared with the demo server
import { fakeGitstable } from "../demo/fake-gitstable.mjs";

const good = { v: 1, id: "x-whole-window", name: "X uses the whole window", kind: "style-rule", version: "2026.11v1", sites: ["x.com", "twitter.com"], powers: ["style"], style: "x-whole-window.css", min_api: 1, tested_on: ["2026.11v1"], license: "MIT" };

describe("plugin manifest (dbbasic-rule.json)", () => {
  it("accepts a style rule", () => {
    const r = validateManifest(good, 1);
    expect(r.ok && r.manifest.sites).toEqual(["x.com", "twitter.com"]);
  });
  it("refuses what this browser can't honour, saying why", () => {
    const err = (m: object, api = 1) => { const r = validateManifest({ ...good, ...m }, api); return r.ok ? "" : r.error; };
    expect(err({ v: 2 })).toMatch(/format/);
    expect(err({ kind: "userscript" })).toMatch(/style rules only/);
    expect(err({ powers: ["style", "page-script"] })).toMatch(/page-script/);
    expect(err({ sites: [] })).toMatch(/sites/);
    expect(err({ sites: ["https://x.com/"] })).toMatch(/not a site name/);
    expect(err({ sites: ["*"] })).toMatch(/not a site name/);
    expect(err({ style: "../../evil.css" })).toMatch(/\.css file/);
    expect(err({ style: "a.js" })).toMatch(/\.css file/);
    expect(err({ id: "Bad Id" })).toMatch(/id/);
    expect(err({ min_api: 2 })).toMatch(/plugin level 2/);
    expect(err({ min_api: 2 }, 2)).toBe("");
  });
});

describe("style rules stay look-only", () => {
  it("lets ordinary CSS through", () => {
    expect(styleProblem('[data-testid="primaryColumn"] { max-width: none !important; } @media (min-width: 900px) { a { color: red } }')).toBeNull();
    expect(styleProblem("a { background: linear-gradient(red, blue); content: 'x' }")).toBeNull();
  });
  it("refuses anything that could fetch or hide a fetch", () => {
    for (const css of [
      "a { background: url(https://evil.test/x) }",
      "a { background: URL ( 'x' ) }",
      "@import 'https://evil.test/a.css';",
      "a { background-image: image-set('a.png' 1x) }",
      "@font-face { font-family: x; src: local(x) }",
      "a { background: \\75rl(x) }",
      "a { -moz-binding: x }",
    ]) expect(styleProblem(css), css).not.toBeNull();
  });
  it("sees through comments", () => {
    expect(styleProblem("/* harmless */ a { background: url(x) }")).not.toBeNull();
    expect(styleProblem("/* url(x) is only mentioned */ a { color: red }")).toBeNull();
  });
});

describe("sites, sources and tags", () => {
  it("names the sites in plain words", () => {
    expect(describePowers(["x.com"])).toMatch(/^It changes how x\.com looks\./);
    expect(describePowers(["x.com", "twitter.com"])).toMatch(/^It changes how x\.com and twitter\.com look\./);
    expect(describePowers(["a.com", "b.com", "c.com", "d.com", "e.com"])).toMatch(/a\.com, b\.com, c\.com and 2 more look\./);
  });
  it("x.com covers its subdomains; *.example.com only those", () => {
    expect(siteMatches("x.com", ["x.com"])).toBe(true);
    expect(siteMatches("mobile.x.com", ["x.com"])).toBe(true);
    expect(siteMatches("notx.com", ["x.com"])).toBe(false);
    expect(siteMatches("example.com", ["*.example.com"])).toBe(false);
    expect(siteMatches("a.example.com", ["*.example.com"])).toBe(true);
  });
  it("reads owner/repo, a version, or the gitstable address, and refuses other sites", () => {
    const o = "https://gitstable.com";
    expect(parsePluginSource("askrobots/x-whole-window", o)).toEqual({ repository: "askrobots/x-whole-window", tag: null });
    expect(parsePluginSource("askrobots/x-whole-window@2026.11v1", o)).toEqual({ repository: "askrobots/x-whole-window", tag: "2026.11v1" });
    expect(parsePluginSource("https://gitstable.com/repositories/askrobots/x-whole-window/", o)).toEqual({ repository: "askrobots/x-whole-window", tag: null });
    expect(parsePluginSource("https://gitstable.com/git/askrobots/x-whole-window.git", o)).toEqual({ repository: "askrobots/x-whole-window", tag: null });
    expect(parsePluginSource("gitstable.com/askrobots/x-whole-window", o)).toEqual({ repository: "askrobots/x-whole-window", tag: null });
    expect(parsePluginSource("https://evil.test/askrobots/x-whole-window", o)).toEqual({ error: "plugins install from gitstable.com only" });
    expect("error" in parsePluginSource("just-a-name", o)).toBe(true);
  });
  it("takes an annotated tag's commit from its peeled line", () => {
    const a = "a".repeat(40), b = "b".repeat(40), c = "c".repeat(40);
    const refs = parseTagRefs(`003f${a} refs/tags/2026.11v1\n0042${b} refs/tags/2026.11v1^{}\n003f${c} refs/tags/2026.10v1\n`);
    expect(refs.get("2026.11v1")).toBe(b);
    expect(refs.get("2026.10v1")).toBe(c);
  });
  it("computes git's blob id", () => {
    expect(gitBlobId(new TextEncoder().encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a"); // git hash-object
  });
});

describe("installing from gitstable (the stand-in)", () => {
  let server: http.Server;
  let origin = "";
  let dir = "";
  const fetchVia = async (url: string): Promise<Fetched> => {
    const r = await fetch(url);
    return { status: r.status, header: (n) => r.headers.get(n), bytes: new Uint8Array(await r.arrayBuffer()) };
  };
  const store = () => new PluginStore({ fetch: fetchVia, dir, origin, apiLevel: 1, browserVersion: "2026.11v1", now: () => new Date() });
  beforeAll(async () => {
    server = http.createServer((req, res) => { if (!fakeGitstable(req, res)) res.writeHead(404).end(); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    dir = mkdtempSync(join(tmpdir(), "dbb-plugins-"));
  });
  afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  it("previews the newest release, installs exactly that, and applies it to its sites only", async () => {
    const s = store();
    s.load();
    const p = await s.preview("demo/wide");
    expect(p.tag).toBe("2026.11v1");
    expect(p.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(p.says).toMatch(/can't run code, read the page or send anything/);
    expect(p.testedHere).toBe(true);
    const inst = s.install(p.token);
    expect(inst.problem).toBe("");
    expect(inst.source.commit).toBe(p.commit);
    expect(s.stylesFor("127.0.0.1").map((x) => x.id)).toEqual(["wide"]);
    expect(s.stylesFor("localhost")).toEqual([]);
    expect(() => s.install(p.token)).toThrow(/expired/); // a preview is used once
    const again = await s.preview("demo/wide");
    expect(again.relation).toBe("same"); // looking up what is installed offers no update
    expect(again.installedProblem).toBe(false);
    expect(statSync(join(dir, "installed.json")).mode & 0o777).toBe(0o600);
  });

  it("installs an older release when asked, as an update of the same plugin", async () => {
    const s = store();
    s.load();
    const p = await s.preview("demo/wide@2026.10v1");
    expect(p.replaces).toBe("2026.11v1");
    expect(p.relation).toBe("older");
    s.install(p.token);
    expect(s.list().find((x) => x.id === "wide")?.version).toBe("2026.10v1");
  });

  it("refuses CSS that could send, escapes, more powers, a lying server, a mislabelled release, and a newer interface", async () => {
    const s = store();
    s.load();
    await expect(s.preview("demo/sneaky")).rejects.toThrow(/url/);
    await expect(s.preview("demo/escaped")).rejects.toThrow(/backslash/);
    await expect(s.preview("demo/scripty")).rejects.toThrow(/page-script/);
    await expect(s.preview("demo/tampered")).rejects.toThrow(/doesn't match its git blob id/);
    await expect(s.preview("demo/mislabelled")).rejects.toThrow(/tagged 2026.11v1/);
    await expect(s.preview("demo/future")).rejects.toThrow(/plugin level 99/);
    await expect(s.preview("demo/nothing-here")).rejects.toThrow(/not found/);
    await expect(s.preview("demo/wide@2027.01v1")).rejects.toThrow(/no release 2027.01v1/);
  });

  it("switches off a plugin whose files changed on this computer", async () => {
    const s = store();
    s.load();
    s.install((await s.preview("demo/wide")).token);
    writeFileSync(join(dir, "wide", "wide.css"), "#col { color: red }\n");
    const again = store();
    again.load();
    expect(again.list().find((x) => x.id === "wide")?.problem).toMatch(/changed on this computer/);
    expect(again.stylesFor("127.0.0.1")).toEqual([]);
  });

  it("all off, one off, and remove", async () => {
    const s = store();
    s.load();
    s.install((await s.preview("demo/wide")).token);
    s.setAllOff(true);
    expect(s.stylesFor("127.0.0.1")).toEqual([]);
    s.setAllOff(false);
    s.setEnabled("wide", false);
    expect(s.stylesFor("127.0.0.1")).toEqual([]);
    const kept = JSON.parse(readFileSync(join(dir, "installed.json"), "utf8"));
    expect(kept.plugins[0].enabled).toBe(false);
    s.remove("wide");
    expect(s.list()).toEqual([]);
  });
});
