/**
 * Automation API — drive the real browser from scripts, tests and agents.
 *
 * Why this exists instead of "just use Playwright/CDP":
 *   - It is the SAME window a human is looking at: tabs, payment inspector and all.
 *   - Payments are first-class: read every quote/decision/receipt, assert on spend, and
 *     set an approval policy (ask | auto up to $N | deny) — no native dialog to dodge.
 *   - Logins use the vault: `login` fills + submits saved credentials without the script
 *     ever holding the password.
 *   - Input is real (trusted mouse/keyboard/text events), so sites that ignore
 *     synthetic `.click()` behave exactly as they do for a person.
 *
 * Security model (this is remote control of a browser that holds a wallet and a vault):
 *   - OFF unless DBB_CONTROL=1. Binds 127.0.0.1 only.
 *   - Every request needs `Authorization: Bearer <token>`; the token is random per launch
 *     (or DBB_CONTROL_TOKEN) and written 0600 to ~/.dbbasic/control.json.
 *   - Requests carrying an `Origin` header are refused (a web page can't drive it), and
 *     the Host header must be loopback (DNS-rebinding guard).
 *   - The toolbar shows a visible 🤖 chip whenever it is on.
 */

import { FIND_JS, FORMS_JS, elementExpr, pointOf } from "./page-tools";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { webContents, type WebContents } from "electron";
import { safeEqual } from "@dbbasic/vault";
import type { VaultService } from "./vault-service.js";
import type { SettleContext } from "./settle-service.js";
import type { ExtensionRegistry } from "./extensions.js";
import type { ChatService } from "./chat-service.js";
import type { McpService } from "./mcp-service.js";

export interface TabInfo {
  id: number;
  wcId: number | null;
  url: string;
  title: string;
  active: boolean;
  loading: boolean;
  /** What the tab is doing: connecting|waiting|slow|receiving|redirecting|challenge|pay-pending|pay-paying|pay-settled|summarizing|failed|offline, or null when idle. */
  state: string | null;
}

export interface ApprovalPolicy {
  mode: "ask" | "auto" | "deny";
  /** Auto-approve prompts up to this many USD (only used in "auto"). Policy hard caps still apply. */
  maxUsd: number;
}

export interface ControlDeps {
  /** Ask the chrome UI to do a tab operation and wait for its answer. */
  askChrome(op: string, args: Record<string, unknown>): Promise<unknown>;
  /** True in background mode (DBB_BACKGROUND=1): the window is never raised or focused. */
  background: boolean;
  /** Bring the browser window to the front and give it keyboard focus (real input needs it). */
  focusWindow(): void;
  vault: VaultService;
  eventsSince(n: number): { events: unknown[]; next: number };
  getApproval(): ApprovalPolicy;
  setApproval(p: ApprovalPolicy): void;
  spent(): string;
  /** AI Reader: open the reader view for a tab (and, only with `acknowledge`, summarize it). */
  reader(p: Record<string, unknown>): Promise<unknown>;
  aiStatus(): unknown;
  /** The in-browser chat (see chat-service.ts). */
  chat: ChatService;
  /** MCP connections (see mcp-service.ts). */
  mcp: McpService;
  /** What the browser is using: memory and CPU per tab, cache and disk. */
  resources: { state(): Promise<unknown>; clearCache(): Promise<unknown> };
  downloads(): unknown;
  getNetPolicy(): { blockWebSockets: boolean };
  /** Methods added by local extensions (see extensions.ts), reached as ext.<name>. */
  extensions: ExtensionRegistry<WebContents>;
  /** Throws "caller-network-on" while the caller network is on. */
  assertNotCallerNet(what: string): void;
  callerNet: {
    state(): unknown;
    configure(p: { enabled?: unknown; userAgent?: unknown; answerTimeoutMs?: unknown; cookies?: unknown; limits?: unknown }): void;
    pending(afterId: number, waitMs: number): Promise<unknown>;
    answer(id: number, a: Record<string, unknown>): void;
    fail(id: number, kind: unknown, detail?: unknown): void;
    registerDocument(doc: Record<string, unknown>): void;
    freshVisit(wcId: number): Promise<void>;
    noteKnownDocument(wcId: number, url: string, redirects: Array<{ status?: number; to: string }>): void;
  };
  setNetPolicy(p: { websockets?: boolean }): void;
  /** Wait until a page has finished loading and say why (see settle.ts). */
  settle(ctx: SettleContext, opts: unknown): Promise<unknown>;
  setAiProvider(p: unknown): boolean;
  receipts(): unknown;
}

/** Run a caller-network operation, turning its validation errors into API errors. */
function provider<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (e instanceof Error && typeof code === "string") throw new RpcError(code, e.message);
    throw e;
  }
}

class RpcError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

let tabs: TabInfo[] = [];
export const setTabs = (t: TabInfo[]) => void (tabs = t);
export const getTabs = (): TabInfo[] => tabs;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v) throw new RpcError("bad-params", `"${name}" (string) is required`);
  return v;
};

function resolveTab(p: Record<string, unknown>): TabInfo {
  const t = p.tab == null ? tabs.find((x) => x.active) : tabs.find((x) => x.id === Number(p.tab));
  if (!t) throw new RpcError("no-tab", p.tab == null ? "no active tab" : `no tab ${String(p.tab)}`);
  return t;
}
/**
 * A tab can be listed a moment before its page exists (the id is published at dom-ready). Wait briefly for it
 * instead of failing, so a script that starts right after launch or right after opening a tab just works.
 */
async function addressable(t: TabInfo): Promise<number> {
  for (let i = 0; i < 250; i++) {
    const cur = tabs.find((x) => x.id === t.id);
    if (cur?.wcId != null) return cur.wcId;
    await sleep(20);
  }
  throw new RpcError("tab-not-ready", `tab ${t.id} is not ready yet`);
}

function guest(t: TabInfo): WebContents {
  const wc = t.wcId == null ? undefined : webContents.fromId(t.wcId);
  if (!wc || wc.isDestroyed()) throw new RpcError("tab-not-ready", `tab ${t.id} is not ready yet`);
  return wc;
}

async function evalIn(wc: WebContents, js: string): Promise<unknown> {
  try {
    return await wc.executeJavaScript(js, true);
  } catch (e) {
    throw new RpcError("eval-error", e instanceof Error ? e.message : String(e));
  }
}

/**
 * "Has this page finished loading?" Returns a verdict: whether it settled, which rule ended the wait, what
 * actually happened (ok, error status, blank, failed and why, bot check, payment, download…), and facts about
 * the load. The two-frame test needs a visible page, so (like a screenshot) it brings the tab forward.
 */
/** In caller-network mode, a new visit starts with a clean slate (only then; it needs the page to be addressable). */
async function freshVisit(d: ControlDeps, t: TabInfo): Promise<void> {
  if ((d.callerNet.state() as { enabled?: boolean }).enabled) await d.callerNet.freshVisit(await addressable(t));
}

async function settleTab(d: ControlDeps, t: TabInfo, opts: unknown): Promise<unknown> {
  const wcId = await addressable(t);
  const o = (opts && typeof opts === "object" ? opts : {}) as Record<string, unknown>;
  if (o.frames !== false) await front(d, t);
  return d.settle({ tabId: t.id, wcId, askChrome: d.askChrome.bind(d) }, o);
}

/**
 * Real input needs a visible, focused page — bring the tab AND the window to the front first. Without the window
 * part, anything else that grabbed focus (a person clicking elsewhere, another app) makes key events land nowhere.
 */
async function front(d: ControlDeps, t: TabInfo): Promise<WebContents> {
  if (!t.active) {
    await d.askChrome("tab.activate", { id: t.id });
    await sleep(80);
  }
  d.focusWindow();
  const wc = guest(t);
  // Focusing a page focuses (and, on macOS, raises) its window, so background mode never does it.
  if (!d.background) wc.focus();
  return wc;
}

/** Which element a call names: a ref (from page.forms / page.find) or a CSS selector. */
function targetOf(p: Record<string, unknown>): { ref?: string; selector?: string } {
  if (p.ref != null) return { ref: str(typeof p.ref === "number" ? String(p.ref) : p.ref, "ref") };
  return { selector: str(p.selector, "selector") };
}
function noElement(p: Record<string, unknown>): RpcError {
  return p.ref != null
    ? new RpcError("no-element", `ref ${String(p.ref)} is not on the page any more (ask page.forms or page.find again)`)
    : new RpcError("no-element", `nothing matches ${String(p.selector)}`);
}

const KEYS: Record<string, string> = { Enter: "Enter", Tab: "Tab", Escape: "Escape", Backspace: "Backspace", Delete: "Delete", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", " ": "Space" };

export async function handle(d: ControlDeps, method: string, p: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    // ---- meta / tabs --------------------------------------------------------
    case "status":
      return { version: 1, extensions: d.extensions.loadedNames(), tabs, approval: d.getApproval(), spent: d.spent(), vault: await d.vault.state() };
    case "tabs.list":
      return tabs;
    case "tabs.new":
      return d.askChrome("tab.new", { url: p.url ?? null, activate: p.activate !== false, wait: p.wait !== false });
    case "tabs.close":
      return d.askChrome("tab.close", { id: resolveTab(p).id });
    case "tabs.activate":
      return d.askChrome("tab.activate", { id: resolveTab(p).id });

    // ---- navigation ---------------------------------------------------------
    case "page.goto": {
      const t = resolveTab(p);
      await freshVisit(d, t);
      if (!p.settle) return d.askChrome("tab.goto", { id: t.id, url: str(p.url, "url"), wait: p.wait !== false });
      // `settle: true` (or an options object) waits until the page is REALLY finished and says why. It starts once
      // the navigation has begun, so it never judges the page being left; the verdict replaces the plain load wait.
      const loaded = (await d.askChrome("tab.goto", { id: t.id, url: str(p.url, "url"), wait: "start" })) as Record<string, unknown>;
      return { ...loaded, settle: await settleTab(d, t, p.settle === true ? {} : p.settle) };
    }
    case "page.settle":
      return settleTab(d, resolveTab(p), p);
    case "page.back":
    case "page.forward":
    case "page.reload":
      return d.askChrome("tab." + method.slice(5), { id: resolveTab(p).id, wait: p.wait !== false });

    // ---- reading ------------------------------------------------------------
    case "page.eval":
      return { value: await evalIn(guest(resolveTab(p)), str(p.js, "js")) };
    case "page.text": {
      const sel = p.selector == null ? null : str(p.selector, "selector");
      return { text: await evalIn(guest(resolveTab(p)), `(() => { const e = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : "document.body"}; return e ? e.innerText : null; })()`) };
    }
    case "page.html":
      return { html: await evalIn(guest(resolveTab(p)), "document.documentElement.outerHTML") };
    case "page.forms": {
      // The fields and buttons of the page, with refs that click/hover/type accept. Sensitive values are never returned.
      const r = await evalIn(guest(resolveTab(p)), FORMS_JS({ includeHidden: p.includeHidden === true, limit: Number(p.limit) || 200 }));
      return r;
    }
    case "page.find": {
      const text = p.text == null ? undefined : str(p.text, "text");
      const label = p.label == null ? undefined : str(p.label, "label");
      const role = p.role == null ? undefined : str(p.role, "role");
      if (text == null && label == null && role == null) throw new RpcError("bad-params", 'pass at least one of "text", "label", "role"');
      return evalIn(guest(resolveTab(p)), FIND_JS({ text, label, role, includeHidden: p.includeHidden === true, limit: Number(p.limit) || 20 }));
    }
    case "page.screenshot": {
      const t = resolveTab(p);
      const wc = await front(d, t);
      const img = await wc.capturePage();
      return { png: img.toPNG().toString("base64"), width: img.getSize().width, height: img.getSize().height };
    }

    // ---- acting (real, trusted input) ----------------------------------------
    case "page.click": {
      const t = resolveTab(p);
      const wc = await front(d, t);
      let x = Number(p.x), y = Number(p.y);
      if (p.ref != null || p.selector != null) {
        const pt = (await evalIn(wc, pointOf(targetOf(p)))) as { x: number; y: number } | null;
        if (!pt) throw noElement(p);
        ({ x, y } = pt);
        await sleep(50); // let scroll settle
      } else if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RpcError("bad-params", 'pass "ref", "selector" or both "x" and "y"');
      wc.sendInputEvent({ type: "mouseMove", x, y });
      wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
      return { clicked: { x, y } };
    }
    case "page.hover": {
      // Move the real pointer over an element (or to x,y) without clicking: shows hover states and link addresses.
      const t = resolveTab(p);
      const wc = await front(d, t);
      let x = Number(p.x), y = Number(p.y);
      if (p.ref != null || p.selector != null) {
        const pt = (await evalIn(wc, pointOf(targetOf(p)))) as { x: number; y: number } | null;
        if (!pt) throw noElement(p);
        ({ x, y } = pt);
        await sleep(50);
      } else if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RpcError("bad-params", 'pass "ref", "selector" or both "x" and "y"');
      wc.sendInputEvent({ type: "mouseMove", x, y });
      return { hovered: { x, y } };
    }
    case "page.type": {
      const t = resolveTab(p);
      const wc = await front(d, t);
      const text = typeof p.text === "string" ? p.text : str(p.text, "text");
      if (p.ref != null || p.selector != null) {
        const ok = await evalIn(wc, `(() => { const e = ${elementExpr(targetOf(p))}; if (!e) return false; e.scrollIntoView({block:"center"}); e.focus(); ${p.clear !== false ? "if (e.select) e.select();" : ""} return true; })()`);
        if (!ok) throw noElement(p);
      }
      await wc.insertText(text); // replaces the selection when clear (default), else appends
      return { typed: text.length };
    }
    case "page.press": {
      const t = resolveTab(p);
      const wc = await front(d, t);
      const key = str(p.key, "key");
      const keyCode = KEYS[key] ?? key;
      wc.sendInputEvent({ type: "keyDown", keyCode });
      if (key === "Enter") wc.sendInputEvent({ type: "char", keyCode: "\r" });
      else if (key.length === 1) wc.sendInputEvent({ type: "char", keyCode: key });
      wc.sendInputEvent({ type: "keyUp", keyCode });
      return { pressed: key };
    }
    case "page.waitFor": {
      const t = resolveTab(p);
      const timeout = Math.min(Number(p.timeoutMs) || 10_000, 120_000);
      const conds = {
        selector: p.selector == null ? null : str(p.selector, "selector"),
        text: p.text == null ? null : str(p.text, "text"),
        url: p.url == null ? null : str(p.url, "url"),
      };
      if (!conds.selector && !conds.text && !conds.url) throw new RpcError("bad-params", 'pass at least one of "selector", "text", "url"');
      const js = `(() => (${conds.selector ? `!!document.querySelector(${JSON.stringify(conds.selector)})` : "true"}) && (${conds.text ? `(document.body?.innerText||"").includes(${JSON.stringify(conds.text)})` : "true"}) && (${conds.url ? `location.href.includes(${JSON.stringify(conds.url)})` : "true"}))()`;
      const end = Date.now() + timeout;
      for (;;) {
        try {
          if (await guest(t).executeJavaScript(js)) return { matched: true };
        } catch {
          /* page mid-navigation — keep polling */
        }
        if (Date.now() > end) throw new RpcError("timeout", `waitFor timed out after ${timeout}ms`);
        await sleep(100);
      }
    }

    // ---- chat ------------------------------------------------------------------
    case "chat.state":
      return d.chat.state();
    case "chat.send": {
      // Sends one message and waits for the assistant to finish (wait:false returns at once; poll chat.events).
      const text = str(p.text, "text");
      if (p.mode != null) d.chat.setMode(p.mode);
      const run = d.chat.send(text);
      if (p.wait === false) return { started: true };
      return run;
    }
    case "chat.events":
      return d.chat.eventsSince(Number(p.since) || 0);
    case "chat.confirm":
      return { settled: d.chat.confirm(str(p.id, "id"), p.ok === true) };
    case "chat.stop":
      d.chat.stop();
      return { stopped: true };
    case "chat.clear":
      d.chat.clear();
      return { cleared: true };
    case "chat.mode":
      return { mode: d.chat.setMode(p.mode) };

    // ---- resources ------------------------------------------------------------------
    case "resources.state":
      return d.resources.state();
    case "resources.clearCache":
      return d.resources.clearCache();

    // ---- MCP connections ----------------------------------------------------------
    case "mcp.state":
      return d.mcp.state();
    case "mcp.connect": {
      // open:false returns the consent address instead of opening the person's browser, so a script can drive it.
      const r = await d.mcp.connect(str(p.id, "id"), { open: p.open !== false });
      if (p.wait === true) await r.done;
      return { authorizeUrl: r.authorizeUrl };
    }
    case "mcp.cancel":
      d.mcp.cancelConnect(str(p.id, "id"));
      return { cancelled: true };
    case "mcp.disconnect":
      return d.mcp.disconnect(str(p.id, "id"));
    case "mcp.tools":
      return (await d.mcp.toolDefs()).map((t) => ({ name: t.name, risk: t.risk, description: t.description }));

    // ---- vault ---------------------------------------------------------------
    case "vault.state":
      return d.vault.state();
    case "vault.unlock": {
      const r = await d.vault.unlock(str(p.master, "master"));
      if (!r.ok) throw new RpcError(r.code, r.message);
      return r.data;
    }
    case "login": {
      // Fill (and by default submit) the saved login for this tab's exact origin.
      provider(() => d.assertNotCallerNet("login"));
      const t = resolveTab(p);
      await front(d, t);
      const r = await d.vault.fill(guest(t).id, typeof p.id === "string" ? p.id : undefined, p.submit !== false);
      if (!r.ok) throw new RpcError(r.code, r.message);
      if (p.submit !== false && p.wait !== false) await d.askChrome("tab.waitLoad", { id: t.id, ms: 15_000 });
      return r.data; // username + origin only — never the password
    }

    // ---- a network layer the caller supplies ---------------------------------
    case "net.provider": {
      // {enabled?, userAgent?, answerTimeoutMs?, cookies?: "off" | "visit", limits?: {requests?, bytes?}}: while on, the browser makes NO request of its own; each one is handed to the
      // caller (net.pending) to answer (net.answer) or refuse (net.fail). userAgent is required when turning it on.
      if (p.enabled !== undefined || p.answerTimeoutMs !== undefined || p.userAgent !== undefined || p.cookies !== undefined || p.limits !== undefined) provider(() => d.callerNet.configure(p));
      return d.callerNet.state();
    }
    case "net.pending": {
      const after = p.afterId === undefined ? 0 : Number(p.afterId);
      const wait = p.waitMs === undefined ? 0 : Number(p.waitMs);
      if (!Number.isFinite(after) || !Number.isFinite(wait)) throw new RpcError("bad-params", "afterId and waitMs must be numbers");
      return { requests: await d.callerNet.pending(after, wait) };
    }
    case "net.answer": {
      const { id, ...answer } = p;
      provider(() => d.callerNet.answer(Number(id), answer));
      return { answered: Number(id) };
    }
    case "net.fail":
      provider(() => d.callerNet.fail(Number(p.id), p.kind, p.detail));
      return { failed: Number(p.id) };
    case "page.load": {
      // Load a main document the caller ALREADY fetched, as it is: {url (its final address), status, headers, bodyBase64|bodyText,
      // redirects?: [{status,to}], settle?}. Relative links resolve against url; the facts list the redirects.
      const t = resolveTab(p);
      const url = str(p.url, "url");
      const { settle: settleOpt, ...doc } = p;
      const redirects = Array.isArray(p.redirects) ? (p.redirects as Array<{ status?: number; to: string }>) : [];
      provider(() => d.callerNet.registerDocument({ ...doc, url }));
      await freshVisit(d, t);
      d.callerNet.noteKnownDocument(await addressable(t), url, redirects);
      const loaded = (await d.askChrome("tab.goto", { id: t.id, url, wait: settleOpt ? "start" : true })) as Record<string, unknown>;
      return settleOpt ? { ...loaded, settle: await settleTab(d, t, settleOpt === true ? {} : settleOpt) } : loaded;
    }

    // ---- network policy ------------------------------------------------------
    case "net.policy": {
      // {blockWebSockets?: boolean}: refuse WebSockets before any connection is opened (they bypass the network layer).
      if (p.blockWebSockets !== undefined) {
        if (typeof p.blockWebSockets !== "boolean") throw new RpcError("bad-params", "blockWebSockets must be true or false");
        d.setNetPolicy({ websockets: p.blockWebSockets });
      }
      return d.getNetPolicy();
    }

    // ---- downloads -----------------------------------------------------------
    case "downloads.list":
      return d.downloads();

    // ---- AI Reader -----------------------------------------------------------
    case "ai.status":
      return d.aiStatus();
    case "ai.provider": {
      if (!d.setAiProvider(p.provider)) throw new RpcError("bad-params", 'provider must be "anthropic" or "openai" and have a key');
      return d.aiStatus();
    }
    case "reader.open": {
      provider(() => d.assertNotCallerNet("the reader"));
      // Opens the reader view. Page text is sent to an AI provider ONLY when `acknowledge: true` is passed
      // (a human would have been asked); without it the reader opens with no summary.
      const t = resolveTab(p);
      if (t.wcId == null) throw new RpcError("tab-not-ready", `tab ${t.id} is not ready yet`);
      return d.reader({ ...p, wcId: t.wcId });
    }

    // ---- x402 ----------------------------------------------------------------
    case "x402.spent":
      return { spent: d.spent() };
    case "x402.receipts":
      return d.receipts();
    case "x402.events":
      return d.eventsSince(Number(p.since) || 0);
    case "x402.approval": {
      if (p.mode != null) {
        if (p.mode !== "ask" && p.mode !== "auto" && p.mode !== "deny") throw new RpcError("bad-params", 'mode must be "ask", "auto" or "deny"');
        const maxUsd = p.maxUsd == null ? d.getApproval().maxUsd : Number(p.maxUsd);
        if (!Number.isFinite(maxUsd) || maxUsd < 0) throw new RpcError("bad-params", "maxUsd must be a non-negative number");
        d.setApproval({ mode: p.mode, maxUsd });
      }
      return d.getApproval();
    }
    default:
      if (d.extensions.has(method)) {
        try {
          return await d.extensions.call(method, p, {
            // The page of the tab the request names. The tab is made the visible one, but the window is NOT raised or focused.
            webContents: async (params) => {
              const t = resolveTab(params);
              if (!t.active) {
                await d.askChrome("tab.activate", { id: t.id });
                await sleep(80);
              }
              await addressable(t);
              return guest(t);
            },
          });
        } catch (e) {
          if (e instanceof RpcError) throw e;
          throw new RpcError("extension-error", e instanceof Error ? e.message : String(e));
        }
      }
      throw new RpcError("no-method", `unknown method "${method}"`);
  }
}

export interface ControlHandle {
  port: number;
  token: string;
  file: string;
  close(): void;
}

export async function startControl(d: ControlDeps, opts: { port: number; token?: string }): Promise<ControlHandle> {
  const token = opts.token || randomBytes(24).toString("hex");
  const hostOk = (h: string | undefined) => h === `127.0.0.1:${opts.port}` || h === `localhost:${opts.port}`;

  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req: IncomingMessage): Promise<string> => {
    // Collect bytes and decode once: decoding each chunk would corrupt a multi-byte character that spans two of them.
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      n += buf.byteLength;
      if (n > 64 * 1024 * 1024) throw new RpcError("too-large", "request body too large"); // an answer may carry up to 32 MB, as base64
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString("utf8");
  };

  const server = createServer(async (req, res) => {
    if (!hostOk(req.headers.host)) return reply(res, 403, { ok: false, error: { code: "bad-host", message: "loopback only" } });
    if (req.headers.origin) return reply(res, 403, { ok: false, error: { code: "bad-origin", message: "browser-originated requests are refused" } });
    const auth = req.headers.authorization ?? "";
    if (!safeEqual(auth, `Bearer ${token}`)) return reply(res, 401, { ok: false, error: { code: "unauthorized", message: "missing or wrong bearer token" } });
    if (req.method !== "POST" || req.url !== "/rpc") return reply(res, 404, { ok: false, error: { code: "not-found", message: "POST /rpc" } });

    let id: unknown = null;
    try {
      const msg = JSON.parse(await readBody(req)) as { id?: unknown; method?: string; params?: Record<string, unknown> };
      id = msg.id ?? null;
      const result = await handle(d, str(msg.method, "method"), msg.params ?? {});
      reply(res, 200, { id, ok: true, result });
    } catch (e) {
      const err = e instanceof RpcError ? e : new RpcError("error", e instanceof Error ? e.message : String(e));
      reply(res, 200, { id, ok: false, error: { code: err.code, message: err.message } });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", resolve);
  });

  // DBB_CONTROL_FILE lets a test harness keep its own token file instead of clobbering the real one.
  const dir = join(homedir(), ".dbbasic");
  const file = process.env.DBB_CONTROL_FILE || join(dir, "control.json");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${opts.port}/rpc`, token, pid: process.pid }), { mode: 0o600 });
  chmodSync(file, 0o600);
  return { port: opts.port, token, file, close: () => server.close() };
}
