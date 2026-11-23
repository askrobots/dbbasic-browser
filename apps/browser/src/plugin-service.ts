/**
 * Installed plugins on this computer: fetching one from gitstable, checking it, keeping it, and saying which style rules
 * a page gets. No Electron here (the fetch and the folder are passed in), so it is tested without a browser.
 *
 * Install is two steps. preview() fetches and checks everything and keeps it in memory under a token; install(token)
 * writes exactly what was previewed. What the person agreed to is what lands on disk, never a second download.
 *
 * On disk, in <dir> (the browser's userData/plugins, only you can read it):
 *   installed.json            {v:1, allOff, plugins: Installed[]}
 *   <id>/<path>               each file, as fetched
 * load() checks each file's sha256 against installed.json; a plugin whose files changed is reported and not applied.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compareVersions, parseVersion } from "./version.js";
import {
  MANIFEST_FILE, MAX_MANIFEST_BYTES, MAX_STYLE_BYTES, gitBlobId, isCommit, parsePluginSource, parseTagRefs, safeRepoPath, sha256,
  siteMatches, styleProblem, validateManifest, type Installed, type RuleManifest,
} from "./plugins.js";

export interface Fetched { status: number; header(name: string): string | null; bytes: Uint8Array }

export interface PluginDeps {
  /** GET without cookies, outside the payment handler. Rejects on network failure. */
  fetch(url: string): Promise<Fetched>;
  /** The folder plugins are kept in. */
  dir: string;
  /** gitstable, e.g. https://gitstable.com. */
  origin: string;
  apiLevel: number;
  /** The browser's version as shown (2026.11v1), to say whether a plugin was tested on it. */
  browserVersion: string;
  now(): Date;
}

export interface PluginView extends Installed {
  /** Why it is not applied (its files changed on disk), or "" when it is fine. */
  problem: string;
  testedHere: boolean;
}

export interface PreviewView {
  token: string;
  id: string;
  name: string;
  version: string;
  description: string;
  license: string;
  sites: string[];
  powers: string[];
  repository: string;
  tag: string;
  commit: string;
  testedOn: string[];
  testedHere: boolean;
  /** The version this would replace, when the same plugin is installed already. */
  replaces: string | null;
  /** One sentence for the person: what it will do and what it can't. */
  says: string;
}

export class PluginError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

interface Pending { view: PreviewView; manifest: RuleManifest; files: Array<{ path: string; bytes: Uint8Array; blob: string }>; at: number }

const PENDING_MS = 10 * 60_000;

/** "x.com", "x.com and twitter.com", "a, b and c", "a, b, c and 2 more". */
export function siteList(sites: readonly string[]): string {
  if (sites.length > 3) return `${sites.slice(0, 3).join(", ")} and ${sites.length - 3} more`;
  return sites.length <= 1 ? sites.join("") : `${sites.slice(0, -1).join(", ")} and ${sites[sites.length - 1]}`;
}

export function describePowers(sites: readonly string[]): string {
  const list = siteList(sites);
  return `It changes how ${list} look${sites.length === 1 ? "s" : ""}. It can't run code, read the page or send anything.`;
}

export class PluginStore {
  private plugins: Installed[] = [];
  private problems = new Map<string, string>();
  private css = new Map<string, string>();
  private pending = new Map<string, Pending>();
  allOff = false;

  constructor(private d: PluginDeps) {}

  private get indexPath() { return join(this.d.dir, "installed.json"); }

  /** Reads what is installed and checks every file. Safe to call again (the automation API's recheck). */
  load(): void {
    this.plugins = [];
    this.problems.clear();
    this.css.clear();
    let raw: { allOff?: unknown; plugins?: unknown } = {};
    try {
      raw = JSON.parse(readFileSync(this.indexPath, "utf8"));
    } catch {
      raw = {};
    }
    this.allOff = raw.allOff === true;
    this.plugins = Array.isArray(raw.plugins) ? (raw.plugins as Installed[]).filter((p) => p && typeof p.id === "string") : [];
    for (const p of this.plugins) {
      try {
        for (const f of p.files) {
          if (!safeRepoPath(f.path, f.path.endsWith(".json") ? ".json" : ".css")) throw new Error("bad path");
          const bytes = readFileSync(join(this.d.dir, p.id, f.path));
          if (sha256(bytes) !== f.sha256) throw new Error("changed");
          if (f.path.endsWith(".css")) this.css.set(p.id, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        }
        const css = this.css.get(p.id);
        const why = css === undefined ? "its style file is missing" : styleProblem(css);
        if (why) throw new Error(why);
      } catch {
        this.css.delete(p.id);
        this.problems.set(p.id, "Its files changed on this computer since it was installed, so it is switched off. Remove it and install it again.");
      }
    }
  }

  list(): PluginView[] {
    return this.plugins.map((p) => ({ ...p, problem: this.problems.get(p.id) ?? "", testedHere: p.testedOn.includes(this.d.browserVersion) }));
  }

  /** The style sheets a page on `host` gets: enabled, intact, matching plugins (none when all are off). */
  stylesFor(host: string): Array<{ id: string; css: string }> {
    if (this.allOff || !host) return [];
    const out: Array<{ id: string; css: string }> = [];
    for (const p of this.plugins) {
      const css = this.css.get(p.id);
      if (p.enabled && css !== undefined && !this.problems.has(p.id) && siteMatches(host, p.sites)) out.push({ id: p.id, css });
    }
    return out;
  }

  private async get(url: string, limit: number, what: string): Promise<Fetched> {
    let r: Fetched;
    try {
      r = await this.d.fetch(url);
    } catch (e) {
      throw new PluginError("network", `Could not reach ${new URL(url).host} (${(e as Error).message})`);
    }
    if (r.status === 404) throw new PluginError("not-found", `${what} was not found on ${new URL(url).host}`);
    if (r.status !== 200) throw new PluginError("server", `${new URL(url).host} answered ${r.status} for ${what}`);
    if (r.bytes.length > limit) throw new PluginError("too-big", `${what} is larger than ${Math.round(limit / 1024)} KB`);
    return r;
  }

  /** A file at a commit, checked against the git blob id the server sends with it. */
  private async fileAt(repository: string, commit: string, path: string, limit: number): Promise<{ bytes: Uint8Array; blob: string }> {
    const url = `${this.d.origin}/repositories/${repository}/raw/${path}?at=${commit}`;
    const r = await this.get(url, limit, path);
    const said = (r.header("x-git-blob") || "").toLowerCase();
    const sentCommit = (r.header("x-git-commit") || "").toLowerCase();
    if (sentCommit && sentCommit !== commit) throw new PluginError("mismatch", `${path} came from commit ${sentCommit.slice(0, 7)}, not ${commit.slice(0, 7)}`);
    const blob = gitBlobId(r.bytes);
    if (!isCommit(said)) throw new PluginError("unchecked", `${path} came without its git blob id (X-Git-Blob), so it can't be checked`);
    if (said !== blob) throw new PluginError("mismatch", `${path} doesn't match its git blob id: it changed on the way`);
    return { bytes: r.bytes, blob };
  }

  /** Fetches and checks a plugin; nothing is written. `source`: owner/repo, owner/repo@version, or its gitstable address. */
  async preview(source: string): Promise<PreviewView> {
    const src = parsePluginSource(source, this.d.origin);
    if ("error" in src) throw new PluginError("bad-source", src.error);
    const refsUrl = `${this.d.origin}/git/${src.repository}.git/info/refs?service=git-upload-pack`;
    const refs = parseTagRefs(new TextDecoder().decode((await this.get(refsUrl, 2 * 1024 * 1024, `the repository ${src.repository}`)).bytes));
    let tag = src.tag;
    if (!tag) {
      const releases = [...refs.keys()].map((t) => ({ t, v: parseVersion(t) })).filter((x) => x.v && !x.v.pre);
      releases.sort((a, b) => compareVersions(b.v!, a.v!));
      tag = releases[0]?.t ?? null;
      if (!tag) throw new PluginError("no-release", `${src.repository} has no release yet (a tag such as 2026.11v1)`);
    }
    const commit = refs.get(tag);
    if (!commit) throw new PluginError("not-found", `${src.repository} has no release ${tag}`);

    const mf = await this.fileAt(src.repository, commit, MANIFEST_FILE, MAX_MANIFEST_BYTES);
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(mf.bytes));
    } catch {
      throw new PluginError("bad-plugin", `${MANIFEST_FILE} is not valid JSON`);
    }
    const v = validateManifest(raw, this.d.apiLevel);
    if (!v.ok) throw new PluginError("bad-plugin", v.error);
    const m = v.manifest;
    if (m.version !== tag) throw new PluginError("bad-plugin", `the release is tagged ${tag} but ${MANIFEST_FILE} says ${m.version}`);
    const owner = this.plugins.find((p) => p.id === m.id);
    if (owner && owner.source.repository.toLowerCase() !== src.repository.toLowerCase()) {
      throw new PluginError("taken", `a different plugin called "${m.id}" is installed already (from ${owner.source.repository})`);
    }
    const style = await this.fileAt(src.repository, commit, m.style, MAX_STYLE_BYTES);
    let css: string;
    try {
      css = new TextDecoder("utf-8", { fatal: true }).decode(style.bytes);
    } catch {
      throw new PluginError("bad-plugin", `${m.style} is not text`);
    }
    const why = styleProblem(css);
    if (why) throw new PluginError("not-style-only", `${m.style} is refused: ${why}. A style rule may only change how pages look`);

    for (const [t, p] of this.pending) if (this.d.now().getTime() - p.at > PENDING_MS) this.pending.delete(t);
    const token = randomUUID();
    const view: PreviewView = {
      token, id: m.id, name: m.name, version: m.version, description: m.description, license: m.license, sites: m.sites, powers: m.powers,
      repository: src.repository, tag, commit, testedOn: m.tested_on, testedHere: m.tested_on.includes(this.d.browserVersion),
      replaces: owner ? owner.version : null, says: describePowers(m.sites),
    };
    this.pending.set(token, {
      view, manifest: m, at: this.d.now().getTime(),
      files: [{ path: MANIFEST_FILE, ...mf }, { path: m.style, ...style }],
    });
    return view;
  }

  /** Writes what preview() checked. The token is used once. */
  install(token: string): PluginView {
    const p = this.pending.get(token);
    if (!p || this.d.now().getTime() - p.at > PENDING_MS) throw new PluginError("expired", "That preview has expired; look the plugin up again");
    this.pending.delete(token);
    const m = p.manifest;
    const home = join(this.d.dir, m.id);
    rmSync(home, { recursive: true, force: true });
    for (const f of p.files) {
      const to = join(home, f.path);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      writeFileSync(to, f.bytes, { mode: 0o600 });
    }
    const was = this.plugins.find((x) => x.id === m.id);
    const rec: Installed = {
      id: m.id, name: m.name, version: m.version, description: m.description, license: m.license, sites: m.sites, powers: m.powers,
      testedOn: m.tested_on, source: { host: new URL(this.d.origin).host, repository: p.view.repository, tag: p.view.tag, commit: p.view.commit },
      files: p.files.map((f) => ({ path: f.path, blob: f.blob, sha256: sha256(f.bytes), bytes: f.bytes.length })),
      installedAt: this.d.now().toISOString(), enabled: was ? was.enabled : true,
    };
    this.plugins = this.plugins.filter((x) => x.id !== m.id).concat(rec);
    this.save();
    this.load();
    return this.list().find((x) => x.id === m.id)!;
  }

  setEnabled(id: string, enabled: boolean): void {
    const p = this.plugins.find((x) => x.id === id);
    if (!p) throw new PluginError("not-found", `no plugin "${id}" is installed`);
    p.enabled = enabled;
    this.save();
  }

  setAllOff(off: boolean): void {
    this.allOff = off;
    this.save();
  }

  remove(id: string): void {
    if (!this.plugins.some((x) => x.id === id)) throw new PluginError("not-found", `no plugin "${id}" is installed`);
    this.plugins = this.plugins.filter((x) => x.id !== id);
    this.save();
    rmSync(join(this.d.dir, id), { recursive: true, force: true });
    this.problems.delete(id);
    this.css.delete(id);
  }

  private save(): void {
    mkdirSync(this.d.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.indexPath, JSON.stringify({ v: 1, allOff: this.allOff, plugins: this.plugins }, null, 2) + "\n", { mode: 0o600 });
    try {
      chmodSync(this.indexPath, 0o600);
    } catch {}
  }

  /** For tests: whether anything is kept on disk at all. */
  hasIndex(): boolean {
    return existsSync(this.indexPath);
  }
}
