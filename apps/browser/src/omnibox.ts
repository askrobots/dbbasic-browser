/**
 * The address bar's suggestions: what to show under it as you type, and which site to complete inline.
 *
 * Everything here is local (open tabs, your saved links, your kept copies). Search suggestions from the search site are
 * fetched separately, and only for text that is not an address (see `remoteAllowed`), so a typed address never leaves the
 * machine before you press Enter. Electron-free so it is unit-tested.
 */

export interface OmniItem {
  url: string;
  title: string;
}
export interface OmniTab extends OmniItem {
  id: number;
}

export type OmniRow =
  | { kind: "go"; url: string; title: string }
  | { kind: "search"; text: string }
  | { kind: "tab"; id: number; url: string; title: string }
  | { kind: "bookmark"; url: string; title: string }
  | { kind: "kept"; url: string; title: string; original: string }
  | { kind: "suggest"; text: string }
  | { kind: "ask"; text: string }
  | { kind: "cmd"; name: string; line: string; description: string; arg?: string; preview?: string; ready: boolean; problem?: string; readOnly: boolean; destructive: boolean }
  | { kind: "notice"; text: string; connect?: boolean };

const LIMITS = { tab: 3, bookmark: 5, kept: 3 };

const hostOf = (u: string): string => {
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) ? x.hostname.replace(/^www\./, "").toLowerCase() : "";
  } catch {
    return "";
  }
};

/** The site part of an address as it is typed: host and port, without "www." ("localhost:8899", "slashdot.org"). */
const siteOf = (u: string): string => {
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) ? x.host.replace(/^www\./, "").toLowerCase() : "";
  } catch {
    return "";
  }
};

const isLocalHost = (host: string) =>
  host === "localhost" || host.endsWith(".local") || /^127(\.\d+){3}$/.test(host) || /^10(\.\d+){3}$/.test(host) || /^192\.168(\.\d+){2}$/.test(host) || /^172\.(1[6-9]|2\d|3[01])(\.\d+){2}$/.test(host);

/** True when Enter would open this text as an address rather than search for it (the same rule as the address bar's). */
export function looksLikeAddress(raw: string): boolean {
  const u = raw.trim();
  if (!u) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^(about|file|data|view-source):/i.test(u)) return true;
  const host = u.split(/[/?#]/)[0]?.split(":")[0] ?? "";
  return !/\s/.test(u) && (isLocalHost(host) || /^[^\s.]+(\.[^\s.]+)+$/.test(host));
}

/**
 * Whether the text may be sent for search suggestions: never an address or anything that looks like part of one (a path,
 * a port, an @), never very short or very long text.
 */
export function remoteAllowed(raw: string): boolean {
  const t = raw.trim();
  if (t.length < 2 || t.length > 100) return false;
  if (t.startsWith("/")) return false; // a command, never a search
  if (looksLikeAddress(t)) return false;
  if (!/\s/.test(t) && /[/:@\\]/.test(t)) return false;
  return true;
}

/**
 * The site to complete inline as you type: the first site you have saved, kept or open whose name starts with what you typed
 * ("slash" → "slashdot.org"). Only while the text could be the start of a site name; the most used site wins.
 */
export function autofillHost(raw: string, urls: string[]): string | null {
  const t = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
  if (t.length < 2 || /[\s/?#:@]/.test(t)) return null;
  const count = new Map<string, number>();
  for (const u of urls) {
    const h = siteOf(u);
    if (h && h.startsWith(t) && h !== t) count.set(h, (count.get(h) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [h, c] of count) if (c > n || (c === n && best && h.length < best.length)) (best = h), (n = c);
  return best;
}

const norm = (u: string) => u.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "").toLowerCase();

/** Rank: the site name starts with the text, then a word of the title starts with it, then it is anywhere. */
function score(words: string[], it: OmniItem): number {
  const hay = `${it.title}\n${it.url}`.toLowerCase();
  if (!words.every((w) => hay.includes(w))) return -1;
  const first = words[0] as string;
  const host = hostOf(it.url);
  if (host.startsWith(first)) return 3;
  if (new RegExp(`(^|[^a-z0-9])${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(it.title.toLowerCase())) return 2;
  return 1;
}

function pick<T extends OmniItem>(words: string[], items: T[], limit: number, seen: Set<string>): T[] {
  return items
    .map((it, i) => ({ it, s: score(words, it), i }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.it)
    .filter((it) => {
      const k = norm(it.url);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, limit);
}

/**
 * The rows under the address bar. The first row is what Enter does with the text as typed (or completed): open it, or search
 * for it. Then open tabs (switch to them), saved links, kept copies; search suggestions are added by the caller when they
 * arrive; the last row hands the text to the assistant.
 */
export function suggest(p: { text: string; tabs: OmniTab[]; activeTab?: number; bookmarks: OmniItem[]; kept: Array<OmniItem & { id: string; view: string }>; askable?: boolean; autofill?: boolean }): { autofill: string | null; rows: OmniRow[] } {
  const text = p.text.trim();
  if (!text) return { autofill: null, rows: [] };
  const autofill = p.autofill === false ? null : autofillHost(text, [...p.tabs.map((t) => t.url), ...p.bookmarks.map((b) => b.url), ...p.kept.map((k) => k.url)]);
  const rows: OmniRow[] = [];
  if (autofill) {
    // where to go: the scheme of an address you used on that site (a local site is usually plain http)
    const used = [...p.tabs, ...p.bookmarks, ...p.kept].map((x) => x.url).find((u) => siteOf(u) === autofill) ?? "";
    rows.push({ kind: "go", url: `${/^http:/i.test(used) ? "http" : "https"}://${autofill}/`, title: autofill });
  }
  else if (looksLikeAddress(text)) rows.push({ kind: "go", url: text, title: text });
  else rows.push({ kind: "search", text });
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  for (const t of pick(words, p.tabs.filter((t) => t.id !== p.activeTab && /^https?:/i.test(t.url)), LIMITS.tab, seen)) rows.push({ kind: "tab", id: t.id, url: t.url, title: t.title || t.url });
  for (const b of pick(words, p.bookmarks, LIMITS.bookmark, seen)) rows.push({ kind: "bookmark", url: b.url, title: b.title || b.url });
  for (const k of pick(words, p.kept, LIMITS.kept, new Set())) rows.push({ kind: "kept", url: k.view, title: k.title || k.url, original: k.url });
  if (p.askable !== false && !looksLikeAddress(text)) rows.push({ kind: "ask", text });
  return { autofill, rows };
}

/** The search site's suggestions (OpenSearch suggestions JSON: ["text", ["one", "two", …]]), without the text itself. */
export function parseSuggestions(body: string, text: string, max = 5): string[] {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return [];
  }
  const list = Array.isArray(j) && Array.isArray(j[1]) ? (j[1] as unknown[]) : [];
  const t = text.trim().toLowerCase();
  const out: string[] = [];
  for (const s of list) {
    if (typeof s !== "string") continue;
    const v = s.trim().slice(0, 120);
    if (!v || v.toLowerCase() === t || out.some((o) => o.toLowerCase() === v.toLowerCase())) continue;
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

// ---- "/" commands: the tools of a connected service, typed ----------------------------------------------------------

/** A tool as a command you can type: its argument is the rest of the line. */
export interface CommandInfo {
  name: string;
  description: string;
  /** The argument the rest of the line fills (the first required one, else the first), and its type. */
  arg?: string;
  argType?: string;
  /** Whether that argument must be given. */
  argRequired: boolean;
  /** Other required arguments, which a single line cannot give. */
  needs: string[];
  readOnly: boolean;
  /** Asks before it runs (the MCP default for a tool that changes things, unless the server says it does not destroy anything). */
  destructive: boolean;
}

/** Short names the service's own box uses, for the same tools. */
export const COMMAND_ALIASES: Record<string, string> = { note: "create_note", task: "create_task", search: "global_search", websearch: "web_search" };

/** `fixed`: arguments the browser always sets itself (the entry's fixed arguments), so they are never asked for. */
export function toCommand(t: { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }, fixed: string[] = []): CommandInfo {
  const all = t.inputSchema && typeof t.inputSchema.properties === "object" && t.inputSchema.properties ? (t.inputSchema.properties as Record<string, { type?: unknown }>) : {};
  const props = Object.fromEntries(Object.entries(all).filter(([k]) => !fixed.includes(k)));
  const required = (Array.isArray(t.inputSchema?.required) ? (t.inputSchema?.required as unknown[]).filter((x): x is string => typeof x === "string") : []).filter((r) => !fixed.includes(r));
  const arg = required[0] ?? Object.keys(props)[0];
  const type = arg ? props[arg]?.type : undefined;
  const readOnly = t.annotations?.readOnlyHint === true;
  return {
    name: t.name,
    description: (t.description ?? "").split(/\n/)[0]?.slice(0, 160) ?? "",
    ...(arg ? { arg } : {}),
    ...(typeof type === "string" ? { argType: type } : {}),
    argRequired: !!arg && required.includes(arg),
    needs: required.filter((r) => r !== arg),
    readOnly,
    destructive: !readOnly && t.annotations?.destructiveHint !== false,
  };
}

/** "/create_task buy milk" → { name: "create_task", rest: "buy milk" }; aliases resolved. Null for anything else. */
export function parseCommand(text: string): { name: string; typed: string; rest: string } | null {
  const m = /^\/([A-Za-z_][\w-]*)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const typed = (m[1] ?? "").toLowerCase();
  return { name: COMMAND_ALIASES[typed] ?? typed, typed, rest: (m[2] ?? "").trim() };
}

/** The arguments for a command line, or what is missing. */
export function commandArgs(c: CommandInfo, rest: string): { args: Record<string, unknown> } | { problem: string } {
  if (c.needs.length) return { problem: `needs ${c.needs.join(", ")} too, which a single line cannot give` };
  if (!c.arg) return rest ? { problem: "takes nothing after its name" } : { args: {} };
  if (!rest) return c.argRequired ? { problem: `type the ${c.arg.replace(/_/g, " ")}` } : { args: {} };
  let v: unknown = rest;
  if (c.argType === "integer" || c.argType === "number") {
    v = Number(rest);
    if (!Number.isFinite(v as number) || (c.argType === "integer" && !Number.isInteger(v))) return { problem: `${c.arg} must be a number` };
  } else if (c.argType === "boolean") {
    if (!/^(true|false|yes|no)$/i.test(rest)) return { problem: `${c.arg} must be yes or no` };
    v = /^(true|yes)$/i.test(rest);
  } else if (c.argType === "array") v = rest.split(",").map((x) => x.trim()).filter(Boolean);
  return { args: { [c.arg]: v } };
}

/**
 * The rows for a "/" line. While the name is being typed: the commands that start with it (then those that contain it). Once
 * there is a space: that one command, with what will be sent.
 */
export function commandRows(text: string, cmds: CommandInfo[], max = 8): OmniRow[] {
  const p = parseCommand(text);
  if (!p) return [];
  const row = (c: CommandInfo, line: string, rest: string | null): OmniRow => {
    const a = rest === null ? null : commandArgs(c, rest);
    const ready = !!a && "args" in a;
    return {
      kind: "cmd",
      name: c.name,
      line,
      description: c.description,
      ...(c.arg ? { arg: c.arg } : {}),
      ...(a && "args" in a && c.arg && rest ? { preview: `${c.arg}: ${rest}` } : {}),
      ready,
      ...(a && "problem" in a ? { problem: a.problem } : {}),
      readOnly: c.readOnly,
      destructive: c.destructive,
    };
  };
  const hasRest = /\s/.test(text.trim()) || text.endsWith(" ");
  if (hasRest) {
    const c = cmds.find((x) => x.name === p.name);
    return c ? [row(c, text.trim(), p.rest)] : [];
  }
  const t = p.typed;
  const aliasHits = Object.entries(COMMAND_ALIASES).filter(([a]) => t && a.startsWith(t)).map(([, n]) => n);
  const starts = cmds.filter((c) => c.name.startsWith(t) || aliasHits.includes(c.name));
  const contains = t ? cmds.filter((c) => !starts.includes(c) && c.name.includes(t)) : [];
  return [...starts, ...contains].slice(0, max).map((c) => row(c, `/${c.name}`, c.argRequired ? null : ""));
}

/** What a command's answer means, in words: the browser writes the sentence (the server answers in data, in no language). */
export interface CommandResult {
  sentence: string;
  /** The page of the thing made, on the service's own site (only an address on the service's own origin is kept). */
  page?: string;
  /** For lists and searches: the things found, with their pages when the service gives them. */
  items?: Array<{ title: string; page?: string; group?: string }>;
  /** The answer as data, laid out to read (or the text as it came). */
  details: string;
}

const VERBS: Record<string, string> = { note: "Saved note", link: "Saved link", contact: "Added contact", organization: "Added organization", file: "Uploaded file" };
const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const titleOf = (o: Record<string, unknown>): string => {
  for (const k of ["title", "name", "filename", "original_file_name", "subject", "content", "content_preview", "text", "url"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim().replace(/\s+/g, " ");
  }
  const fn = [o.first_name, o.last_name].filter((x) => typeof x === "string" && x).join(" ");
  return fn;
};

/**
 * Describe the answer to "/tool args". `origin` is the service's own origin: a "page" elsewhere is not shown as a link.
 * Writes: "Saved note: buy milk (private)". Lists and searches: how many were found, and each one's title and page.
 * Anything else: "Done" (or the answer itself, when it is short plain text).
 */
export function describeResult(tool: string, args: Record<string, unknown>, text: string, origin: string, readOnly: boolean): CommandResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  const details = data === undefined ? text : JSON.stringify(data, null, 2);
  const pageOf = (o: unknown): string | undefined => {
    if (!o || typeof o !== "object") return undefined;
    const p = (o as Record<string, unknown>).page;
    if (typeof p !== "string") return undefined;
    try {
      const u = new URL(p);
      return u.origin === origin && /^https?:$/.test(u.protocol) ? u.href : undefined;
    } catch {
      return undefined;
    }
  };
  const obj = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  // a list: the answer itself, or every list of things in it, each named by its group (a search answers in groups:
  // projects, tasks, notes…)
  const isList = (v: unknown): v is unknown[] => Array.isArray(v) && (v.length === 0 || v.some((x) => x && typeof x === "object"));
  const groups: Array<[string | undefined, unknown[]]> = Array.isArray(data) ? [[undefined, data]] : obj ? Object.entries(obj).filter((e): e is [string, unknown[]] => isList(e[1])) : [];
  // a single thing with an empty list in it (tags: []) is not a list; a search whose groups are all empty is
  const listy = Array.isArray(data) || groups.some(([, l]) => l.length) || (!!obj && Object.values(obj).every((v) => Array.isArray(v) || typeof v === "number"));
  if (readOnly && groups.length && listy) {
    const named = groups.length > 1;
    const rows = groups.flatMap(([g, list]) =>
      list
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => {
          const page = pageOf(x);
          return { title: clip(titleOf(x) || "(untitled)", 120), ...(page ? { page } : {}), ...(named && g ? { group: g.replace(/_/g, " ") } : {}) };
        }),
    );
    const items = rows.slice(0, 50);
    const what = typeof args.query === "string" ? ` for “${clip(args.query, 60)}”` : "";
    const n = rows.length;
    return { sentence: `/${tool}: ${n === 0 ? "nothing found" : n === 1 ? "1 found" : `${n} found`}${what}`, items, details };
  }
  const typed = Object.values(args).find((v): v is string => typeof v === "string" && !!v.trim());
  const m = /^(create|add|upload|save)_(.+)$/.exec(tool);
  if (!readOnly && m && obj) {
    const noun = (m[2] as string).replace(/_/g, " ");
    const verb = VERBS[m[2] as string] ?? `${m[1] === "upload" ? "Uploaded" : "Created"} ${noun}`;
    const what = clip(typed?.replace(/\s+/g, " ") || titleOf(obj));
    const page = pageOf(obj);
    return { sentence: `${verb}${what ? `: ${what}` : ""}${obj.is_public === false ? " (private)" : ""}`, ...(page ? { page } : {}), details };
  }
  if (readOnly) return { sentence: `/${tool}: the answer is below`, details };
  if (data === undefined && text.trim() && text.length <= 120) return { sentence: `/${tool}: ${text.trim().replace(/\s+/g, " ")}`, details };
  const page = pageOf(obj);
  return { sentence: `Done: /${tool}`, ...(page ? { page } : {}), details };
}
