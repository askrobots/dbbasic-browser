import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExtensionRegistry, loadExtensions, parseExtensionPaths } from "../src/extensions.js";

const dir = mkdtempSync(join(tmpdir(), "dbb-ext-"));
const file = (name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};

describe("parseExtensionPaths", () => {
  it("nothing set means no extensions", () => {
    expect(parseExtensionPaths(undefined)).toEqual([]);
    expect(parseExtensionPaths("  ")).toEqual([]);
  });
  it("accepts absolute paths to local .mjs/.js files, separated by colons", () => {
    const a = file("a.mjs", "export function register() {}");
    const b = file("b.js", "export function register() {}");
    expect(parseExtensionPaths(`${a}:${b}`)).toEqual([a, b]);
  });
  it.each([["relative/path.mjs"], ["./x.mjs"], ["/no/such/file.mjs"], ["/tmp"]])("refuses %s", (p) => {
    expect(() => parseExtensionPaths(p)).toThrow(/DBB_EXTENSIONS/);
  });
  it("refuses a file other users can write to, or one in a folder they can write to", () => {
    const f = file("open.mjs", "export function register() {}");
    chmodSync(f, 0o666);
    expect(() => parseExtensionPaths(f)).toThrow(/can be written by other users/);
    const shared = join(dir, "shared");
    mkdirSync(shared);
    const g = join(shared, "g.mjs");
    writeFileSync(g, "export function register() {}");
    chmodSync(shared, 0o777);
    expect(() => parseExtensionPaths(g)).toThrow(/can be written by other users/);
    chmodSync(shared, 0o755);
    expect(parseExtensionPaths(g)).toEqual([g]);
  });
  it("refuses a file that is not .mjs or .js", () => {
    expect(() => parseExtensionPaths(file("x.txt", "hi"))).toThrow(/not a \.mjs or \.js/);
  });
});

describe("loading and calling", () => {
  it("registers methods under ext. and calls them with the parameters and tools", async () => {
    const f = file("ok.mjs", 'export function register(api) { api.method("hello", (p, t) => ({ got: p.x, hasTools: typeof t.webContents })); }');
    const reg = new ExtensionRegistry<string>();
    const announced: string[] = [];
    await loadExtensions([f], reg, (x) => announced.push(x));
    expect(reg.names()).toEqual(["ext.hello"]);
    expect(reg.loaded).toEqual([f]);
    expect(reg.loadedNames()).toEqual(["ok.mjs"]); // the status report shows names only
    expect(announced).toEqual([f]);
    expect(await reg.call("ext.hello", { x: 5 }, { webContents: async () => "page" })).toEqual({ got: 5, hasTools: "function" });
    expect(reg.has("page.goto")).toBe(false); // a built-in name is never reachable this way
  });
  it("a handler that throws rejects", async () => {
    const f = file("throws.mjs", 'export function register(api) { api.method("boom", () => { throw new Error("no"); }); }');
    const reg = new ExtensionRegistry<string>();
    await loadExtensions([f], reg);
    await expect(reg.call("ext.boom", {}, { webContents: async () => "" })).rejects.toThrow("no");
  });
  it("refuses a module with no register function", async () => {
    await expect(loadExtensions([file("none.mjs", "export const x = 1;")], new ExtensionRegistry())).rejects.toThrow(/register/);
  });
  it.each([["Bad Name"], ["../x"], ["ext.double"], ["UPPER"], [""], ["a.b.c"]])("refuses the method name %j", async (name) => {
    const f = file("name.mjs", `export function register(api) { api.method(${JSON.stringify(name)}, () => 1); }`);
    await expect(loadExtensions([f], new ExtensionRegistry())).rejects.toThrow(/not a valid method name|already/);
  });
  it("refuses a duplicate method", async () => {
    const f = file("dup.mjs", 'export function register(api) { api.method("same", () => 1); api.method("same", () => 2); }');
    await expect(loadExtensions([f], new ExtensionRegistry())).rejects.toThrow(/already registered/);
  });
});
