/**
 * Plugins, first kind: the style rule. A style rule is CSS for the sites it names and nothing else: it cannot run code,
 * read the page or send anything. That last promise is kept here, by refusing any CSS that could make a request (url(),
 * @import, image-set(), @font-face…) or hide one behind an escape, so "style only" means what it says.
 *
 * A plugin lives in a repository on gitstable and is installed from a release tag, fetched file by file at the commit
 * that tag points to. Every file is checked against the git blob id the server sends (X-Git-Blob), and its sha256 is
 * kept, so a copy changed on disk afterwards is noticed at the next start and switched off.
 *
 * dbbasic-rule.json, v1:
 *   {"v":1, "id":"x-whole-window", "name":"X uses the whole window", "kind":"style-rule", "version":"2026.11v1",
 *    "sites":["x.com","twitter.com"], "powers":["style"], "style":"x-whole-window.css", "min_api":1,
 *    "tested_on":["2026.11v1"], "license":"MIT", "description":"…"}
 *
 * Pure functions only (no Electron, no fs), so all of it is unit-tested.
 */
import { createHash } from "node:crypto";

export const MANIFEST_FILE = "dbbasic-rule.json";
export const MAX_MANIFEST_BYTES = 16 * 1024;
export const MAX_STYLE_BYTES = 256 * 1024;
/** The powers this browser knows. A plugin asking for any other is refused, never half-installed. */
export const KNOWN_POWERS = ["style"] as const;

export interface RuleManifest {
  v: 1;
  id: string;
  name: string;
  kind: "style-rule";
  version: string;
  sites: string[];
  powers: string[];
  style: string;
  min_api: number;
  tested_on: string[];
  license: string;
  description: string;
}

/** One installed plugin, as kept in plugins/installed.json. */
export interface Installed {
  id: string;
  name: string;
  version: string;
  description: string;
  license: string;
  sites: string[];
  powers: string[];
  testedOn: string[];
  /** Where it came from: the gitstable host, "owner/repo", the tag and the commit it was installed at. */
  source: { host: string; repository: string; tag: string; commit: string };
  files: Array<{ path: string; blob: string; sha256: string; bytes: number }>;
  installedAt: string;
  enabled: boolean;
}

const ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$|^(?:localhost|127\.0\.0\.1)$/;
const HEX40 = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** A path inside the repository: relative, forward slashes, no "..", no hidden tricks. */
export function safeRepoPath(p: unknown, ext: string): p is string {
  return (
    typeof p === "string" && p.length > 0 && p.length <= 200 && p.endsWith(ext) &&
    /^[A-Za-z0-9._/-]+$/.test(p) && !p.startsWith("/") && !p.split("/").some((s) => s === "" || s === "." || s === "..")
  );
}

/** Checks a dbbasic-rule.json. Returns the manifest, or what is wrong with it in words a person can act on. */
export function validateManifest(raw: unknown, apiLevel: number): { ok: true; manifest: RuleManifest } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("dbbasic-rule.json is not a JSON object");
  const m = raw as Record<string, unknown>;
  if (m.v !== 1) return bad(`dbbasic-rule.json is format ${JSON.stringify(m.v)}; this browser reads format 1`);
  if (m.kind !== "style-rule") return bad(`this browser installs style rules only, not "${String(m.kind)}"`);
  if (typeof m.id !== "string" || !ID.test(m.id)) return bad("the plugin's id must be lowercase letters, digits and dashes");
  if (typeof m.name !== "string" || !m.name.trim() || m.name.length > 80) return bad("the plugin needs a name (up to 80 characters)");
  if (typeof m.version !== "string" || !TAG.test(m.version)) return bad("the plugin needs a version, such as 2026.11v1");
  if (!Array.isArray(m.sites) || !m.sites.length || m.sites.length > 50) return bad("the plugin must name the sites it changes (1 to 50)");
  const sites = m.sites.map((s) => String(s).trim().toLowerCase());
  const off = sites.find((s) => !HOST.test(s));
  if (off !== undefined) return bad(`"${off}" is not a site name (write x.com, or *.example.com for its subdomains only)`);
  if (!Array.isArray(m.powers) || !m.powers.length) return bad("the plugin must say what it may do (powers)");
  const unknown = m.powers.find((p) => !(KNOWN_POWERS as readonly string[]).includes(String(p)));
  if (unknown !== undefined) return bad(`the plugin asks for "${String(unknown)}", which this browser does not give plugins`);
  if (!safeRepoPath(m.style, ".css")) return bad("the plugin's style must be a .css file in its repository");
  const minApi = m.min_api ?? 1;
  if (typeof minApi !== "number" || !Number.isInteger(minApi) || minApi < 1) return bad("min_api must be a whole number from 1");
  if (minApi > apiLevel) return bad(`the plugin needs plugin level ${minApi}; this browser has ${apiLevel}. A newer browser will install it`);
  const tested = Array.isArray(m.tested_on) ? m.tested_on.map(String).slice(0, 20) : [];
  return {
    ok: true,
    manifest: {
      v: 1, id: m.id, name: m.name.trim(), kind: "style-rule", version: m.version, sites: [...new Set(sites)],
      powers: [...new Set(m.powers.map(String))], style: m.style, min_api: minApi, tested_on: tested,
      license: typeof m.license === "string" ? m.license.slice(0, 40) : "",
      description: typeof m.description === "string" ? m.description.slice(0, 300) : "",
    },
  };
}

/** The id git gives a file's contents: sha1 of "blob <length>\0" and the bytes. */
export function gitBlobId(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** "x.com" covers x.com and its subdomains; "*.example.com" only the subdomains. */
export function siteMatches(host: string, sites: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return sites.some((s) => (s.startsWith("*.") ? h.endsWith(s.slice(1)) : h === s || h.endsWith("." + s)));
}

/**
 * Why this CSS could make a request or read something, or null when it is look-only. Comments are removed first; any
 * backslash escape is refused outright, since an escape can spell url( without the letters.
 */
export function styleProblem(css: string): string | null {
  if (/\\/.test(css)) return "it uses a backslash escape, which could hide a web address";
  const s = css.replace(/\/\*[\s\S]*?(\*\/|$)/g, " ").toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/url\s*\(/, "it loads something from an address (url(…))"],
    [/@import/, "it loads another style sheet (@import)"],
    [/image-set\s*\(|image\s*\(|element\s*\(|cross-fade\s*\(/, "it loads or copies images (image-set(), image(), element())"],
    [/@font-face/, "it loads a font (@font-face)"],
    [/@namespace/, "it uses @namespace"],
    [/expression\s*\(|behavior\s*:|-moz-binding/, "it tries to run code"],
    [/src\s*\(/, "it loads something from an address (src(…))"],
  ];
  for (const [re, why] of rules) if (re.test(s)) return why;
  return null;
}

/**
 * What the person typed → where to install from. "askrobots/x-whole-window", "askrobots/x-whole-window@2026.11v1", or the
 * repository's address on gitstable (its page, or the .git clone address). Only `origin` (gitstable) is accepted: an
 * address on any other site is refused, so a plugin always comes from the one place that lists and checks plugins.
 */
export function parsePluginSource(text: string, origin: string): { repository: string; tag: string | null } | { error: string } {
  let t = text.trim();
  const m = /^(https?:\/\/[^/]+)(\/.*)?$/i.exec(t);
  if (m) {
    if ((m[1] ?? "").toLowerCase() !== origin.toLowerCase()) return { error: `plugins install from ${origin.replace(/^https?:\/\//, "")} only` };
    t = (m[2] ?? "").replace(/^\/(?:repositories|git)\//, "/").replace(/^\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
  } else {
    t = t.replace(/^(?:www\.)?gitstable\.com\//i, "");
  }
  const [repo = "", tag, ...more] = t.split("@");
  const repository = repo.split("/").slice(0, 2).join("/");
  if (more.length || !REPO.test(repository) || (tag !== undefined && !TAG.test(tag))) return { error: "write it as owner/repository, or owner/repository@version" };
  return { repository, tag: tag ?? null };
}

/**
 * Reads the tags out of git's smart-HTTP ref advertisement (GET <repo>.git/info/refs?service=git-upload-pack).
 * An annotated tag appears twice; its peeled line (^{}) names the commit, which is what we want.
 */
export function parseTagRefs(body: string): Map<string, string> {
  const tags = new Map<string, string>();
  const peeled = new Map<string, string>();
  for (const line of body.split("\n")) {
    const m = /([0-9a-f]{40}) refs\/tags\/([^\s\0^]+)(\^\{\})?/.exec(line);
    if (!m) continue;
    const [, sha = "", name = "", peel] = m;
    (peel ? peeled : tags).set(name, sha);
  }
  for (const [name, sha] of peeled) tags.set(name, sha);
  return tags;
}

export function isCommit(s: unknown): s is string {
  return typeof s === "string" && HEX40.test(s);
}
