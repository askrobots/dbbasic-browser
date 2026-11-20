/**
 * MCP connections for the assistant: which servers there are, whether you are signed in to each, and the tools they add.
 *
 * Rules (the point of the design):
 *  - Tokens live here and in the OS-encrypted store, never in a page, the chrome UI or a log. Without OS encryption
 *    they are kept in memory only (you sign in again after a restart) and the state says so.
 *  - A server adds only the tools its entry names, not everything it offers. Tools that only read run when the assistant
 *    asks; every other tool is asked about every time, even in Auto mode.
 *  - Some arguments are fixed by the entry (for example the one project saved links go in, set per person in mcp-servers.json), whatever the model asks for,
 *    and some fields are dropped from results (notes, interactions) before the model sees them.
 *  - What comes back is untrusted data, like page text.
 *  - Off while the caller network is on.
 */

import { readFileSync } from "node:fs";
import type { ToolDef } from "./chat-core.js";
import { McpAuthError, McpClient, type McpTool } from "./mcp-client.js";
import { DONE_PAGE, OAuthError, REDIRECT_PORTS, authorizeUrl, discover, exchangeCode, listenForCode, newPkce, newState, redirectUri, refreshTokens, register, revoke, type Fetch, type ServerMeta, type Tokens } from "./mcp-oauth.js";

export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  /** The only tools the assistant is given. */
  tools: string[];
  /** The ones that only read. Every other enabled tool asks every time. */
  readOnly: string[];
  /** Arguments forced on a tool, whatever the model sends (and hidden from the model). */
  fixedArgs?: Record<string, Record<string, unknown>>;
  /** Result fields removed before the model sees them, per tool. */
  dropFields?: Record<string, string[]>;
}

export const DEFAULT_SERVERS: McpServerConfig[] = [
  {
    id: "askrobots",
    name: "askrobots.com",
    url: "https://askrobots.com/api/mcp/",
    tools: ["global_search", "web_search", "list_contacts", "get_contact", "list_notes", "list_tasks", "get_task", "list_projects", "list_links", "create_link"],
    readOnly: ["global_search", "web_search", "list_contacts", "get_contact", "list_notes", "list_tasks", "get_task", "list_projects", "list_links"],
    // Saved links are private. To keep them in one project, put its id in this entry's fixedArgs in mcp-servers.json.
    fixedArgs: { create_link: { is_public: false } },
    dropFields: { get_contact: ["notes", "interactions"], list_contacts: ["notes", "interactions"] },
  },
];

const ID = /^[a-z0-9-]{1,32}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown, max: number): string[] | null => (Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 80) ? (v as string[]) : null);

/** Extra servers from a file you edit by hand. A bad entry is skipped (and reported), never half-used. */
export function parseServerConfigs(text: string): { servers: McpServerConfig[]; problems: string[] } {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { servers: [], problems: ["the servers file is not valid JSON"] };
  }
  const servers: McpServerConfig[] = [];
  for (const [i, e] of (Array.isArray(raw) ? raw : []).entries()) {
    const where = `entry ${i + 1}`;
    if (!isObj(e) || typeof e.id !== "string" || !ID.test(e.id) || typeof e.name !== "string" || typeof e.url !== "string") {
      problems.push(`${where}: needs an id (lowercase letters, digits, dashes), a name and a url`);
      continue;
    }
    let ok = false;
    try {
      const u = new URL(e.url);
      ok = u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) ;
    } catch {
      /* not a url */
    }
    const tools = strings(e.tools, 40);
    const readOnly = strings(e.readOnly ?? [], 40);
    if (!ok || !tools || !tools.length || !readOnly || !readOnly.every((r) => tools.includes(r))) {
      problems.push(`${where} (${e.id}): url must be https, "tools" must list the tools to allow, and "readOnly" must be among them`);
      continue;
    }
    servers.push({
      id: e.id,
      name: e.name.slice(0, 60),
      url: e.url,
      tools,
      readOnly,
      ...(isObj(e.fixedArgs) ? { fixedArgs: e.fixedArgs as Record<string, Record<string, unknown>> } : {}),
      ...(isObj(e.dropFields) ? { dropFields: e.dropFields as Record<string, string[]> } : {}),
    });
  }
  return { servers, problems };
}

export function loadServerConfigs(file: string | undefined, read: (p: string) => string = (p) => readFileSync(p, "utf8")): { servers: McpServerConfig[]; problems: string[] } {
  let extra: ReturnType<typeof parseServerConfigs> = { servers: [], problems: [] };
  if (file) {
    try {
      extra = parseServerConfigs(read(file));
    } catch {
      /* no file is normal */
    }
  }
  const byId = new Map(DEFAULT_SERVERS.map((s) => [s.id, s]));
  for (const s of extra.servers) byId.set(s.id, s); // a file entry replaces the built-in one with the same id
  return { servers: [...byId.values()], problems: extra.problems };
}

// ---- storage -----------------------------------------------------------------------------------------------------

export interface Store {
  /** False when nothing is written to disk (no OS encryption): sign-ins last until the browser closes. Asking may reach the system keychain, so ask only when it matters. */
  readonly persistent: boolean;
  load(): string | null;
  save(text: string | null): void;
}
export interface Encryption {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}
export interface Files {
  read(p: string): Buffer | null;
  write(p: string, b: Buffer | null): void;
}

/**
 * Tokens go to disk only encrypted with the operating system's keychain; otherwise nowhere.
 * Nothing here touches the keychain until it has to: on macOS even asking whether encryption is available can raise a system
 * password prompt, so a browser that starts and never uses a connection must not ask. Loading looks for the file first and only
 * decrypts when there is one; saving is where a first sign-in reaches the keychain.
 */
export function createStore(path: string, enc: Encryption, files: Files): Store {
  let memory: string | null = null;
  let available: boolean | null = null;
  const canEncrypt = (): boolean => (available ??= enc.isEncryptionAvailable());
  return {
    get persistent() {
      return canEncrypt();
    },
    load() {
      let b: Buffer | null = null;
      try {
        b = files.read(path);
      } catch {
        b = null;
      }
      if (!b) return memory; // no file: nothing to decrypt, so no keychain
      if (!canEncrypt()) return memory;
      try {
        return enc.decryptString(b);
      } catch {
        return null; // unreadable or from another user: start signed out
      }
    },
    save(text) {
      if (!canEncrypt()) {
        memory = text;
        return;
      }
      files.write(path, text == null ? null : enc.encryptString(text));
    },
  };
}

// ---- the service -------------------------------------------------------------------------------------------------

interface Saved {
  servers: Record<string, { clientId?: string; issuer?: string; tokens?: Tokens }>;
}

export interface McpDeps {
  fetch: Fetch;
  store: Store;
  servers: McpServerConfig[];
  /** Open the person's own browser on the consent page (the fallback, and for scripts). */
  openExternal(url: string): void | Promise<void>;
  /** Open the consent page in a tab of this browser and return the tab's id. The redirect back is caught inside the browser (see captureRedirect), so nothing listens on a port. */
  openTab?(url: string): Promise<number | null>;
  closeTab?(id: number): Promise<void>;
  callerNetworkOn(): boolean;
  announce(payload: Record<string, unknown>): void;
  now?(): number;
  /** Shown to the server during registration. */
  appName?: string;
  /** Reaching the server to sign in may be refused on purpose (tests, a stricter policy). */
  timeoutMs?: number;
}

export interface McpServerState {
  id: string;
  name: string;
  host: string;
  signedIn: boolean;
  connecting: boolean;
  tools: string[];
  persistent: boolean;
  error?: string;
}

const TOOL_CACHE_MS = 5 * 60_000;

/** Remove the named keys, at any depth, from JSON text. Text that is not JSON is returned as it is. */
export function dropKeys(text: string, keys: string[]): string {
  if (!keys.length) return text;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return text;
  }
  const strip = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(strip);
    if (isObj(x)) return Object.fromEntries(Object.entries(x).filter(([k]) => !keys.includes(k)).map(([k, val]) => [k, strip(val)]));
    return x;
  };
  return JSON.stringify(strip(v));
}

const compactArgs = (a: Record<string, unknown>): string => {
  const s = JSON.stringify(a);
  return s.length > 160 ? `${s.slice(0, 159)}…` : s;
};

export class McpService {
  private meta = new Map<string, ServerMeta>();
  private flows = new Map<string, { cancel(): void }>();
  private errors = new Map<string, string>();
  private refreshing = new Map<string, Promise<string>>();
  private clients = new Map<string, McpClient>();
  private toolCache = new Map<string, { at: number; tools: McpTool[] }>();
  /** Sign-ins waiting for the redirect to arrive inside this browser, by their secret state. */
  private expecting = new Map<string, { redirect: string; resolve(code: string): void; reject(e: Error): void; timer: NodeJS.Timeout }>();

  private loaded: Saved | null = null;

  /** What is saved, read the first time something needs it (not at start-up: reading may reach the keychain). */
  private get saved(): Saved {
    if (!this.loaded) {
      let s: Saved = { servers: {} };
      try {
        const t = this.d.store.load();
        const j = t ? (JSON.parse(t) as Saved) : null;
        if (j && isObj(j.servers)) s = j;
      } catch {
        /* start signed out */
      }
      this.loaded = s;
    }
    return this.loaded;
  }

  constructor(private d: McpDeps) {}

  private now() {
    return (this.d.now ?? Date.now)();
  }
  private persist() {
    this.d.store.save(JSON.stringify(this.saved));
  }
  private cfg(id: string): McpServerConfig {
    const c = this.d.servers.find((s) => s.id === id);
    if (!c) throw new Error(`no MCP server called ${id}`);
    return c;
  }
  private refuseInCallerMode() {
    if (this.d.callerNetworkOn()) throw new Error("MCP connections are switched off while the caller network is on.");
  }

  state(): McpServerState[] {
    return this.d.servers.map((c) => ({
      id: c.id,
      name: c.name,
      host: new URL(c.url).host,
      signedIn: !!this.saved.servers[c.id]?.tokens,
      connecting: this.flows.has(c.id),
      tools: c.tools,
      persistent: this.saved.servers[c.id]?.tokens ? this.d.store.persistent : true, // only asked when signed in, so a closed panel never reaches the keychain
      ...(this.errors.has(c.id) ? { error: this.errors.get(c.id) as string } : {}),
    }));
  }

  private async metaFor(c: McpServerConfig): Promise<ServerMeta> {
    let m = this.meta.get(c.id);
    if (!m) {
      m = await discover(c.url, this.d.fetch);
      this.meta.set(c.id, m);
    }
    return m;
  }

  /**
   * The redirect back from the consent page, if it belongs to a sign-in waiting for it: the browser's request layer hands every
   * request here first. The code is taken and a short "you are signed in" page is shown; no request is made, so nothing needs to
   * listen on a port. Only the exact redirect address with the right secret state counts; anything else returns null and is
   * treated as the ordinary request it is.
   */
  captureRedirect(rawUrl: string): { status: number; html: string } | null {
    if (this.expecting.size === 0) return null;
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      return null;
    }
    const state = u.searchParams.get("state");
    const e = state ? this.expecting.get(state) : undefined;
    if (!e || `${u.origin}${u.pathname}` !== e.redirect) return null;
    clearTimeout(e.timer);
    this.expecting.delete(state as string);
    const err = u.searchParams.get("error");
    const code = u.searchParams.get("code");
    if (err) e.reject(new OAuthError("denied", err === "access_denied" ? "sign-in was declined" : `the server refused the sign-in (${err.slice(0, 60)})`));
    else if (code) e.resolve(code);
    else e.reject(new OAuthError("denied", "the server sent no code"));
    return { status: err || !code ? 400 : 200, html: DONE_PAGE(!err && !!code) };
  }

  private expectRedirect(state: string, redirect: string, timeoutMs: number): { code: Promise<string>; cancel(): void } {
    let resolve!: (c: string) => void;
    let reject!: (e: Error) => void;
    const code = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    code.catch(() => {});
    const timer = setTimeout(() => {
      this.expecting.delete(state);
      reject(new OAuthError("timeout", "nobody approved the sign-in in time"));
    }, timeoutMs);
    this.expecting.set(state, { redirect, resolve, reject, timer });
    return {
      code,
      cancel: () => {
        clearTimeout(timer);
        this.expecting.delete(state);
        reject(new OAuthError("denied", "sign-in was cancelled"));
      },
    };
  }

  /**
   * Start signing in. Returns the consent address at once; `done` settles when the person has approved (or not).
   * `via`: "tab" (the default when the browser can open one) shows the consent page in a tab of this browser and catches the
   * redirect itself; "system" opens the person's own browser and listens for the redirect on 127.0.0.1; "none" only returns the
   * address and listens, so a script can do what the person's browser would.
   */
  async connect(id: string, opts: { open?: boolean; via?: "tab" | "system" | "none" } = {}): Promise<{ authorizeUrl: string; done: Promise<void> }> {
    this.refuseInCallerMode();
    const c = this.cfg(id);
    const via = opts.via ?? (opts.open === false ? "none" : this.d.openTab ? "tab" : "system");
    this.flows.get(id)?.cancel();
    this.errors.delete(id);
    const meta = await this.metaFor(c);
    let entry = this.saved.servers[id] ?? (this.saved.servers[id] = {});
    if (!entry.clientId || entry.issuer !== meta.issuer) {
      entry = this.saved.servers[id] = { clientId: await register(meta, this.d.fetch, this.d.appName ?? "dbbasic-browser"), issuer: meta.issuer };
      this.persist();
    }
    const clientId = entry.clientId as string;
    const { verifier, challenge } = newPkce();
    const state = newState();
    const timeoutMs = this.d.timeoutMs ?? 300_000;
    let redirect: string;
    let waiter: { code: Promise<string>; cancel(): void };
    if (via === "tab") {
      redirect = redirectUri(REDIRECT_PORTS[0] as number); // a registered address; it is never connected to, only recognised
      waiter = this.expectRedirect(state, redirect, timeoutMs);
    } else {
      const cb = await listenForCode(state, { timeoutMs });
      redirect = cb.redirectUri;
      waiter = { code: cb.code, cancel: cb.cancel };
    }
    const url = authorizeUrl(meta, clientId, redirect, challenge, state);
    let tabId: number | null = null;
    this.flows.set(id, { cancel: waiter.cancel });
    const done = (async () => {
      try {
        const code = await waiter.code;
        const tokens = await exchangeCode(meta, this.d.fetch, { clientId, code, verifier, redirect }, this.now());
        this.saved.servers[id] = { ...entry, clientId, tokens };
        this.persist();
        this.toolCache.delete(id);
        this.d.announce({ kind: "mcp-signed-in", server: c.id, host: new URL(c.url).host });
      } catch (e) {
        this.errors.set(id, e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        this.flows.delete(id);
        if (tabId != null) await this.d.closeTab?.(tabId).catch(() => {});
      }
    })();
    done.catch(() => {}); // the caller decides whether to look; the error is also kept in state()
    try {
      if (via === "tab") tabId = (await this.d.openTab?.(url)) ?? null;
      else if (via === "system") await this.d.openExternal(url);
    } catch (e) {
      waiter.cancel();
      throw e;
    }
    return { authorizeUrl: url, done };
  }

  cancelConnect(id: string): void {
    this.flows.get(id)?.cancel();
  }

  async disconnect(id: string): Promise<{ revoked: boolean }> {
    const c = this.cfg(id);
    this.flows.get(id)?.cancel();
    const e = this.saved.servers[id];
    let revoked = false;
    if (e?.tokens && e.clientId && !this.d.callerNetworkOn()) {
      try {
        const m = await this.metaFor(c);
        revoked = await revoke(m, this.d.fetch, e.clientId, e.tokens.refresh ?? e.tokens.access);
      } catch {
        /* forgetting it here is what matters */
      }
    }
    if (e) delete e.tokens;
    this.clients.delete(id);
    this.toolCache.delete(id);
    this.errors.delete(id);
    this.persist();
    this.d.announce({ kind: "mcp-signed-out", server: c.id, revoked });
    return { revoked };
  }

  /** A valid access token, refreshed shortly before it runs out. Throws McpAuthError when you must sign in again. */
  async token(id: string): Promise<string> {
    const e = this.saved.servers[id];
    const t = e?.tokens;
    if (!t) throw new McpAuthError(`not signed in to ${this.cfg(id).name}`);
    if (t.expiresAt - 60_000 > this.now()) return t.access;
    const running = this.refreshing.get(id);
    if (running) return running;
    const p = (async () => {
      try {
        if (!t.refresh || !e.clientId) throw new OAuthError("refresh", "no refresh token");
        const next = await refreshTokens(await this.metaFor(this.cfg(id)), this.d.fetch, { clientId: e.clientId, refresh: t.refresh }, this.now());
        e.tokens = next;
        this.persist();
        return next.access;
      } catch (err) {
        if (err instanceof OAuthError && err.code === "refresh" && /\b(400|401)\b|no refresh/.test(err.message)) {
          delete e.tokens; // the refresh token is no good: signed out
          this.persist();
          this.errors.set(id, "you were signed out; connect again");
          throw new McpAuthError(`signed out of ${this.cfg(id).name}; connect again`);
        }
        throw err;
      } finally {
        this.refreshing.delete(id);
      }
    })();
    this.refreshing.set(id, p);
    return p;
  }

  /**
   * Refresh the access token now, whatever its age, and say whether the server also issued a NEW refresh token (rotation).
   * Never returns a token. For checking how a server behaves, and for a sign-in that seems stale.
   */
  async refreshNow(id: string): Promise<{ ok: true; rotated: boolean; expiresInSeconds: number } | { ok: false; message: string }> {
    this.refuseInCallerMode();
    const e = this.saved.servers[id];
    const t = e?.tokens;
    if (!t || !t.refresh || !e.clientId) return { ok: false, message: t ? "this sign-in has no refresh token" : `not signed in to ${this.cfg(id).name}` };
    try {
      const next = await refreshTokens(await this.metaFor(this.cfg(id)), this.d.fetch, { clientId: e.clientId, refresh: t.refresh }, this.now());
      const rotated = next.refresh !== t.refresh;
      e.tokens = next;
      this.persist();
      return { ok: true, rotated, expiresInSeconds: Math.round((next.expiresAt - this.now()) / 1000) };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private client(id: string): McpClient {
    let c = this.clients.get(id);
    if (!c) {
      c = new McpClient(this.cfg(id).url, () => this.token(id), this.d.fetch);
      this.clients.set(id, c);
    }
    return c;
  }

  private async listed(id: string): Promise<McpTool[]> {
    const hit = this.toolCache.get(id);
    if (hit && this.now() - hit.at < TOOL_CACHE_MS) return hit.tools;
    const tools = await this.client(id).listTools();
    this.toolCache.set(id, { at: this.now(), tools });
    return tools;
  }

  /** The chat tools from every server you are signed in to. A server that cannot be reached adds none (and the reason is in state()). */
  async toolDefs(): Promise<ToolDef[]> {
    if (this.d.callerNetworkOn()) return [];
    const out: ToolDef[] = [];
    for (const c of this.d.servers) {
      if (!this.saved.servers[c.id]?.tokens) continue;
      let tools: McpTool[];
      try {
        tools = await this.listed(c.id);
      } catch (e) {
        this.errors.set(c.id, e instanceof McpAuthError ? "you were signed out; connect again" : `could not list tools: ${(e as Error).message}`);
        continue;
      }
      for (const t of tools) {
        if (!c.tools.includes(t.name)) continue;
        out.push(this.toToolDef(c, t));
      }
    }
    return out;
  }

  private toToolDef(c: McpServerConfig, t: McpTool): ToolDef {
    const fixed = c.fixedArgs?.[t.name] ?? {};
    const schema = JSON.parse(JSON.stringify(t.inputSchema ?? { type: "object", properties: {} })) as { properties?: Record<string, unknown>; required?: string[] };
    for (const k of Object.keys(fixed)) {
      if (schema.properties) delete schema.properties[k];
      if (schema.required) schema.required = schema.required.filter((r) => r !== k);
    }
    const reads = c.readOnly.includes(t.name);
    const name = `${c.id}__${t.name}`.slice(0, 64);
    const def: ToolDef = {
      name,
      description: `[${c.name}] ${(t.description ?? t.name).slice(0, 500)}`,
      input_schema: schema as Record<string, unknown>,
      risk: reads ? "read" : "act",
      origin: "account",
      private: true, // what a connected account returns is private: after it, typing and opening addresses always ask
      run: async (input) => {
        this.refuseInCallerMode();
        let res;
        try {
          res = await this.client(c.id).callTool(t.name, { ...input, ...fixed });
        } catch (e) {
          if (e instanceof McpAuthError) {
            this.errors.set(c.id, "you were signed out; connect again");
            throw new Error(`${c.name} wants a fresh sign-in. Tell the person to connect again in the chat panel.`);
          }
          throw e;
        }
        const text = dropKeys(res.text, c.dropFields?.[t.name] ?? []);
        if (res.isError) throw new Error(text.slice(0, 500) || `${c.name} reported an error`);
        return text;
      },
    };
    if (!reads) def.plan = async (input) => ({ summary: `Ask ${c.name} to ${t.name} ${compactArgs({ ...input, ...fixed })}`, danger: true });
    return def;
  }
}
