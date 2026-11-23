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
  MANIFEST_FILE, MAX_MANIFEST_BYTES, MAX_STYLE_BYTES, MAX_VIEW_BYTES, gitBlobId, isCommit, parsePluginSource, parseTagRefs, safeRepoPath, sha256,
  siteMatches, styleProblem, validateManifest, type Installed, type PluginButton, type PluginKind, type RuleManifest,
} from "./plugins.js";
import { validateViewRule, type ViewRule } from "./cards.js";

export interface Fetched { status: number; header(name: string): string | null; bytes: Uint8Array }

export interface PluginDeps {
  /** GET without cookies, outside the payment handler. Rejects on network failure. */
  /** `fresh`: ask the server whether a cached copy is still current (the plugin list); files at a commit never change. */
  fetch(url: string, fresh?: boolean): Promise<Fetched>;
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
  /**
   * How this release compares with the installed one: "new" (not installed), "newer" (an update), "same" (this exact
   * release and commit is what is installed), "older", or "other" (same plugin, a version that can't be compared).
   */
  relation: "new" | "newer" | "same" | "older" | "other";
  /** The installed copy is switched off because its files changed: installing again repairs it. */
  installedProblem: boolean;
  /** One sentence for the person: what it will do and what it can't. */
  says: string;
}

/** One plugin in gitstable's list (/store/plugins.json), as much as the browser uses. */
export interface Listed {
  id: string;
  kind: PluginKind;
  name: string;
  summary: string;
  repository: string;
  tag: string;
  commit: string;
  sites: string[];
  /** Its page on gitstable, and its repository's page: being on either offers to install it. */
  url: string;
  repositoryUrl: string;
}

/** How long a fetched list is used before it is fetched again (gitstable caches it for 5 minutes too). */
export const LISTING_MS = 5 * 60_000;
/** On a plugin's own page, a list older than this is fetched again (see refreshListingOn). */
export const LISTING_FRESH_ON_PAGE_MS = 60_000;
const MAX_LISTING_BYTES = 1024 * 1024;

/** Reads gitstable's list, keeping only well-formed items whose pages are on gitstable itself. */
export function parseListing(raw: unknown, origin: string): Listed[] {
  const doc = raw as { v?: unknown; items?: unknown };
  if (!doc || doc.v !== 1 || !Array.isArray(doc.items)) return [];
  const onSite = (u: unknown) => {
    try {
      return typeof u === "string" && new URL(u).origin === origin ? u : "";
    } catch {
      return "";
    }
  };
  const out: Listed[] = [];
  for (const it of doc.items.slice(0, 1000) as Array<Record<string, unknown>>) {
    if (!it || typeof it !== "object" || (it.kind !== "style-rule" && it.kind !== "view-rule")) continue;
    const src = parsePluginSource(String(it.repository ?? ""), origin);
    if ("error" in src || typeof it.id !== "string" || typeof it.name !== "string" || typeof it.tag !== "string" || !isCommit(it.commit)) continue;
    out.push({
      id: it.id, kind: it.kind as PluginKind, name: it.name.slice(0, 80), summary: typeof it.summary === "string" ? it.summary.slice(0, 300) : "", repository: src.repository,
      tag: it.tag, commit: it.commit, sites: Array.isArray(it.sites) ? it.sites.map(String).slice(0, 50) : [],
      url: onSite(it.url), repositoryUrl: onSite(it.repository_url),
    });
  }
  return out;
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

export function describePowers(sites: readonly string[], kind: PluginKind = "style-rule", button?: PluginButton): string {
  const list = siteList(sites);
  if (kind === "view-rule") {
    return `It adds a ${button?.label ?? "view"} button to the status bar on ${list}: it reads the posts there and shows them as cards in a tab of the browser's own, scrolling the page to read more. It can't run code, change the page or send anything.`;
  }
  return `It changes how ${list} look${sites.length === 1 ? "s" : ""}. It can't run code, read the page or send anything.`;
}

/** How a looked-up release compares with what is installed (see PreviewView.relation). */
export function relationTo(installed: Installed | undefined, version: string, commit: string): PreviewView["relation"] {
  if (!installed) return "new";
  if (installed.version === version && installed.source.commit === commit) return "same";
  const a = parseVersion(version);
  const b = parseVersion(installed.version);
  if (!a || !b) return "other";
  const c = compareVersions(a, b);
  return c > 0 ? "newer" : c < 0 ? "older" : "other"; // same version name at another commit: a re-tag, shown as "other"
}

export class PluginStore {
  private plugins: Installed[] = [];
  private problems = new Map<string, string>();
  private css = new Map<string, string>();
  private views = new Map<string, ViewRule>();
  private pending = new Map<string, Pending>();
  allOff = false;
  private listing: Listed[] = [];
  private listingAt = 0;
  private listingFetch: Promise<boolean> | null = null;

  constructor(private d: PluginDeps) {}

  /** gitstable's list of plugins, as last fetched (empty until then). */
  listed(): Listed[] {
    return this.listing;
  }

  /**
   * Fetches gitstable's list unless it was fetched in the last 5 minutes (or `force`). The whole list is fetched, never
   * "what's there for this site", so gitstable doesn't learn which page anyone is on. Resolves true when it changed.
   */
  refreshListing(force = false): Promise<boolean> {
    if (!force && this.d.now().getTime() - this.listingAt < LISTING_MS) return Promise.resolve(false);
    this.listingFetch ??= (async () => {
      try {
        const r = await this.get(`${this.d.origin}/store/plugins.json`, MAX_LISTING_BYTES, "the plugin list", true);
        const next = parseListing(JSON.parse(new TextDecoder().decode(r.bytes)), this.d.origin);
        this.listingAt = this.d.now().getTime();
        const changed = JSON.stringify(next) !== JSON.stringify(this.listing);
        this.listing = next;
        return changed;
      } catch {
        this.listingAt = this.d.now().getTime() - LISTING_MS + 60_000; // try again in a minute, not on every page
        return false;
      } finally {
        this.listingFetch = null;
      }
    })();
    return this.listingFetch;
  }

  /**
   * On gitstable: the list as usual (at most every 5 minutes), but on a listed plugin's own page a copy older than a
   * minute is fetched again, so a release made minutes ago is offered there (Update), not the one before it.
   */
  refreshListingOn(url: string): Promise<boolean> {
    const page = (u: string) => {
      try {
        const x = new URL(u);
        return x.origin + x.pathname.replace(/\/+$/, "");
      } catch {
        return "";
      }
    };
    const here = page(url);
    const onPluginPage = !!here && this.listing.some((l) => (l.url && page(l.url) === here) || (l.repositoryUrl && page(l.repositoryUrl) === here));
    const stale = this.d.now().getTime() - this.listingAt >= LISTING_FRESH_ON_PAGE_MS;
    return this.refreshListing(onPluginPage && stale);
  }

  /**
   * A gitstable page opened with ?install=owner/repo@tag (its Install button): the release to look up, but only for a
   * plugin in gitstable's list. Anyone can make a repository there, so a link naming one that isn't listed does nothing.
   * Nothing is installed here: the caller opens Plugins with this looked up, and Install stays the person's click.
   */
  installLinkSource(url: string): string | null {
    let asked: string | null = null;
    try {
      const u = new URL(url);
      if (u.origin !== this.d.origin) return null;
      asked = u.searchParams.get("install");
    } catch {
      return null;
    }
    if (!asked || /:|\/\//.test(asked)) return null;
    const src = parsePluginSource(asked, this.d.origin);
    if ("error" in src || !this.listing.some((l) => l.repository === src.repository)) return null;
    return src.tag ? `${src.repository}@${src.tag}` : src.repository;
  }

  private get indexPath() { return join(this.d.dir, "installed.json"); }

  /** Reads what is installed and checks every file. Safe to call again (the automation API's recheck). */
  load(): void {
    this.plugins = [];
    this.problems.clear();
    this.css.clear();
    this.views.clear();
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
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if ((p.kind ?? "style-rule") === "style-rule" && f.path.endsWith(".css")) this.css.set(p.id, text);
          if (p.kind === "view-rule" && f.path !== MANIFEST_FILE && f.path.endsWith(".json")) {
            const r = validateViewRule(JSON.parse(text));
            if (!r.ok) throw new Error(r.error);
            this.views.set(p.id, r.rule);
          }
        }
        if (p.kind === "view-rule") {
          if (!this.views.has(p.id)) throw new Error("its view file is missing");
        } else {
          const css = this.css.get(p.id);
          const why = css === undefined ? "its style file is missing" : styleProblem(css);
          if (why) throw new Error(why);
        }
      } catch {
        this.css.delete(p.id);
        this.views.delete(p.id);
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

  /** The view rules for `host`: enabled, intact, matching plugins (none when all are off), each with its button. */
  viewsFor(host: string): Array<{ id: string; name: string; button: PluginButton; rule: ViewRule }> {
    if (this.allOff || !host) return [];
    const out: Array<{ id: string; name: string; button: PluginButton; rule: ViewRule }> = [];
    for (const p of this.plugins) {
      const rule = this.views.get(p.id);
      if (p.kind === "view-rule" && p.button && rule && p.enabled && !this.problems.has(p.id) && siteMatches(host, p.sites)) out.push({ id: p.id, name: p.name, button: p.button, rule });
    }
    return out;
  }

  private async get(url: string, limit: number, what: string, fresh = false): Promise<Fetched> {
    let r: Fetched;
    try {
      r = await this.d.fetch(url, fresh);
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

  /**
   * A plugin's name alone ("x-whole-window", "x-whole-window@2026.11v1") → owner/repository: an installed plugin's own
   * source first, then gitstable's list (fetched now if it is older than 5 minutes; a look-up goes to gitstable anyway).
   * Anything with a slash or an address is returned as typed.
   */
  private async resolveName(source: string): Promise<string> {
    const m = /^([A-Za-z0-9._-]+)(@[^@/\s]+)?$/.exec(source.trim());
    if (!m) return source;
    const name = (m[1] ?? "").toLowerCase();
    const at = m[2] ?? "";
    const tail = (repo: string) => repo.split("/")[1]?.toLowerCase();
    const mine = this.plugins.find((p) => p.id === name || tail(p.source.repository) === name);
    if (mine) return mine.source.repository + at;
    await this.refreshListing();
    const listed = this.listing.filter((l) => l.id === name || tail(l.repository) === name);
    if (listed.length === 1) return listed[0]!.repository + at;
    if (listed.length > 1) throw new PluginError("bad-source", `more than one plugin is called ${name}: write it as owner/repository (${listed.map((l) => l.repository).join(", ")})`);
    throw new PluginError("bad-source", `no installed or listed plugin is called ${name}: write it as owner/repository`);
  }

  /** Fetches and checks a plugin; nothing is written. `source`: owner/repo, owner/repo@version, its gitstable address, or a plugin's name. */
  async preview(source: string): Promise<PreviewView> {
    const src = parsePluginSource(await this.resolveName(source), this.d.origin);
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
    const mainPath = m.kind === "view-rule" ? m.view! : m.style;
    const main = await this.fileAt(src.repository, commit, mainPath, m.kind === "view-rule" ? MAX_VIEW_BYTES : MAX_STYLE_BYTES);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(main.bytes);
    } catch {
      throw new PluginError("bad-plugin", `${mainPath} is not text`);
    }
    if (m.kind === "view-rule") {
      let rawRule: unknown;
      try {
        rawRule = JSON.parse(text);
      } catch {
        throw new PluginError("bad-plugin", `${mainPath} is not valid JSON`);
      }
      const r = validateViewRule(rawRule);
      if (!r.ok) throw new PluginError("not-view-only", `${mainPath} is refused: ${r.error}. A view rule may only name where a page keeps its posts`);
      const outside = r.rule.sites.find((site) => !siteMatches(site, m.sites));
      if (outside) throw new PluginError("bad-plugin", `${mainPath} reads ${outside}, which the plugin doesn't name in its sites`);
    } else {
      const why = styleProblem(text);
      if (why) throw new PluginError("not-style-only", `${m.style} is refused: ${why}. A style rule may only change how pages look`);
    }

    for (const [t, p] of this.pending) if (this.d.now().getTime() - p.at > PENDING_MS) this.pending.delete(t);
    const token = randomUUID();
    const view: PreviewView = {
      token, id: m.id, name: m.name, version: m.version, description: m.description, license: m.license, sites: m.sites, powers: m.powers,
      repository: src.repository, tag, commit, testedOn: m.tested_on, testedHere: m.tested_on.includes(this.d.browserVersion),
      replaces: owner ? owner.version : null, relation: relationTo(owner, m.version, commit),
      installedProblem: owner ? this.problems.has(owner.id) : false, says: describePowers(m.sites, m.kind, m.button),
    };
    this.pending.set(token, {
      view, manifest: m, at: this.d.now().getTime(),
      files: [{ path: MANIFEST_FILE, ...mf }, { path: mainPath, ...main }],
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
      testedOn: m.tested_on, kind: m.kind, ...(m.button ? { button: m.button } : {}), source: { host: new URL(this.d.origin).host, repository: p.view.repository, tag: p.view.tag, commit: p.view.commit },
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
    this.views.delete(id);
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
