/**
 * Electron main process for dbbasic-browser.
 *
 * This is the thin shell around the engine. All payment logic lives in
 * @dbbasic/x402-engine; here we only:
 *   - own the https network stack via protocol.handle (the primitive an extension lacks),
 *   - feed the engine a network fetch that won't recurse into our own handler,
 *   - surface the approve prompt as a native dialog that shows the price BEFORE paying,
 *   - stream payment events to the chrome UI for the live spend meter.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { basename, dirname, extname, join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, protocol, safeStorage, session, shell, webContents, type MenuItemConstructorOptions, type WebContents } from "electron";
import { createPublicClient, http as viemHttp } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { PolicyEngine, Ledger, X402Engine, formatUsd, signExactEvm } from "@dbbasic/x402-engine";
import { createPaymentHandler, type RawFetch } from "./intercept.js";
import { brandedUserAgent } from "./compat.js";
import { emitNet, netEvents, netRequestFetch, nextNetId, setClientHints, type NetEvent } from "./transport.js";
import { ExtensionRegistry, loadExtensions, parseExtensionPaths } from "./extensions.js";
import { CallerNetwork, ProviderError, clampAnswerTimeout, type Answer, type CookieJar, type Document } from "./provider.js";
import { safeExternalUrl } from "./urls.js";
import { describeAi, loadAiEnv, resolveAi, type AiConfig, type Provider } from "./ai-config.js";
import { createReader } from "./reader-service.js";
import { noteDownload, runSettle, trackLifecycle, noteKnownDocument } from "./settle-service.js";
import { EXPIRED_HTML, READER_SCHEME, ReaderPages, readerIdFromUrl } from "./reader-pages.js";
import { READER_CSP } from "./reader.js";
import { registerVault } from "./vault-service.js";
import { handle as handleControl, getTabs, setTabs, startControl, type ApprovalPolicy, type ControlDeps, type ControlHandle, type TabInfo } from "./control.js";
import { ChatService } from "./chat-service.js";
import { McpService, createStore, loadServerConfigs } from "./mcp-service.js";
import { BookmarksService } from "./bookmarks-service.js";
import { KEPT_SCHEME, KeepStore, keptFilename, keptPageHtml, keptUrl, parseKeptUrl, type KeptRecord } from "./keep-store.js";
import { diskUsage, type DiskUsage } from "./disk-usage.js";
import { reservedShortcut } from "./shortcuts.js";
import { contextMenuItems, type MenuItem } from "./context-menu.js";
import { commandArgs, commandRows, describeResult, parseCommand, parseSuggestions, remoteAllowed, suggest, toCommand, type OmniTab } from "./omnibox.js";
import { macFootprints } from "./process-memory.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Branding. (On macOS the Dock label/icon come from the .app bundle — scripts/launch.mjs
// brands the dev bundle; these cover the in-app name, the Dock icon at runtime, and
// the Windows/Linux window + taskbar icon.)
// NOTE: the app name also decides the userData folder (cookies, the default vault.json).
app.setName("dbbasic-browser");
const ICON_PATH = join(__dirname, "icon.png");

// Reader views are served from dbb-reader://<id>/ (see reader-pages.ts). The scheme must be registered before ready.
protocol.registerSchemesAsPrivileged([
  { scheme: READER_SCHEME, privileges: { standard: true, secure: true } },
  { scheme: KEPT_SCHEME, privileges: { standard: true, secure: true } },
]);
const readerPages = new ReaderPages();

// Who we say we are to web servers: a Chromium-compatible UA with our own product token and a
// link back to dbbasic.com (see compat.ts for why, and why not "Firefox"). DBB_USER_AGENT
// overrides it entirely — handy for debugging a site that misbehaves.
const PRODUCT_VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();
const USER_AGENT =
  process.env.DBB_USER_AGENT || brandedUserAgent(app.userAgentFallback, { name: "dbbasic-browser", version: PRODUCT_VERSION, url: "https://dbbasic.com" });
app.userAgentFallback = USER_AGENT; // must be set before the app is ready


// Load .env (the local hot-wallet key) so the browser signs with — and shows the
// balance of — the funded wallet, not the placeholder. Never overrides an existing env.
for (const p of [join(__dirname, "..", "..", "..", ".env"), join(process.cwd(), ".env")]) {
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      // Only the wallet's own settings. A .env in whatever folder the browser was started from must never be able to switch on
      // the automation API, name an extension to load, or set anything else that changes what the browser does.
      if (m && m[1] && /^X402_/.test(m[1]) && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
    break;
  } catch {
    /* no .env here — fine */
  }
}

// Falls back to the well-known public Anvil key (never fund THAT one) when no .env.
const TEST_KEY = (process.env.X402_PRIVATE_KEY ??
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d") as `0x${string}`;

// Base Sepolia USDC — read the wallet's on-chain balance (a free query, no gas, no key).
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BALANCE_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: viemHttp(process.env.X402_RPC_URL || "https://sepolia.base.org"),
});

let mainWindow: BrowserWindow | null = null;
const account = privateKeyToAccount(TEST_KEY); // the wallet: signs payments AND is what we show the balance of

const MERCHANT_ADDRESS = process.env.X402_MERCHANT_ADDRESS as `0x${string}` | undefined;
const MERCHANT_KEY = process.env.X402_MERCHANT_KEY as `0x${string}` | undefined;
const FACILITATOR = process.env.X402_FACILITATOR || "https://x402.org/facilitator";

/**
 * Refund: the merchant wallet signs an EIP-3009 transfer of its whole balance back to
 * the buyer and settles it through the facilitator. This closes the loop so testnet
 * funds circulate instead of draining — pay, watch the merchant balance rise, refund,
 * back to start. Uses global fetch (main-process; does NOT go through protocol.handle).
 */
async function refundMerchant(): Promise<{ tx?: string; error?: string }> {
  if (callerNet.enabled) return { error: "switched off while the caller network is on" };
  if (!MERCHANT_KEY) return { error: "no merchant wallet configured" };
  const merchant = privateKeyToAccount(MERCHANT_KEY);
  const balAtomic = (await publicClient.readContract({ address: USDC_SEPOLIA, abi: BALANCE_ABI, functionName: "balanceOf", args: [merchant.address] })) as bigint;
  if (balAtomic <= 0n) return { error: "merchant balance is 0" };

  const requirements = {
    scheme: "exact",
    network: "eip155:84532",
    amount: balAtomic.toString(),
    asset: USDC_SEPOLIA,
    payTo: account.address, // back to the buyer
    maxTimeoutSeconds: 120,
    extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
  };
  const payload = await signExactEvm(merchant, { requirements, priceUsdMicro: balAtomic, assetSymbol: "USDC" }, { maxAuthorizationLifetimeSeconds: 120 });
  const res = await fetch(`${FACILITATOR}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
  });
  const settle = (await res.json()) as { success?: boolean; transaction?: string; errorReason?: string };
  if (!settle.success) return { error: settle.errorReason || "settlement failed" };
  bumpBalance();
  return { tx: settle.transaction };
}

/** Format atomic USDC (6dp) showing at least 2 and up to 6 decimals — so $0.001
 *  payments are visible instead of rounding to $0.00. */
function fmtUsdc(atomic: bigint): string {
  return (Number(atomic) / 1e6).toFixed(6).replace(/(\.\d{2}\d*?)0+$/, "$1");
}

async function usdcBalance(addr: `0x${string}`): Promise<string> {
  const bal = (await publicClient.readContract({ address: USDC_SEPOLIA, abi: BALANCE_ABI, functionName: "balanceOf", args: [addr] })) as bigint;
  return fmtUsdc(bal);
}

/** Refresh now and again shortly after — on-chain balances settle a few seconds after
 *  a payment/refund, so a single immediate read often misses the change. */
function bumpBalance(): void {
  void refreshBalance();
  setTimeout(() => void refreshBalance(), 2500);
  setTimeout(() => void refreshBalance(), 5500);
}

/** Push both wallet balances (buyer + merchant) to the toolbar. A free RPC query. */
async function refreshBalance(): Promise<void> {
  // In caller-network mode the browser makes no request of its own, and this is one (an RPC query), so it is skipped.
  if (callerNet.enabled) {
    mainWindow?.webContents.send("x402:balance", { usdc: null, address: account.address, merchantUsdc: null, merchantAddress: MERCHANT_ADDRESS ?? null });
    return;
  }
  try {
    const usdc = await usdcBalance(account.address);
    const merchantUsdc = MERCHANT_ADDRESS ? await usdcBalance(MERCHANT_ADDRESS) : null;
    mainWindow?.webContents.send("x402:balance", { usdc, address: account.address, merchantUsdc, merchantAddress: MERCHANT_ADDRESS ?? null });
  } catch {
    mainWindow?.webContents.send("x402:balance", { usdc: null, address: account.address, merchantUsdc: null, merchantAddress: MERCHANT_ADDRESS ?? null });
  }
}

/**
 * Every x402 event goes to the UI AND into a ring buffer the automation API can read, so
 * a test can assert on exactly what the human-visible inspector shows.
 */
const eventLog: Array<Record<string, unknown>> = [];
let eventSeq = 0;
function emit(payload: Record<string, unknown>): void {
  mainWindow?.webContents.send("x402:event", payload);
  eventLog.push({ seq: ++eventSeq, at: Date.now(), ...payload });
  if (eventLog.length > 1000) eventLog.shift();
}

/** Who answers payment prompts. Default "ask" (native dialog); automation may relax it. */
let approval: ApprovalPolicy = { mode: "ask", maxUsd: 0 };

// Main → chrome UI requests (tab operations only the UI can do), answered over IPC.
const chromeReqs = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
let chromeReqSeq = 0;
function askChrome(op: string, args: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!mainWindow) return reject(new Error("no window"));
    const id = String(++chromeReqSeq);
    const timer = setTimeout(() => {
      chromeReqs.delete(id);
      reject(new Error(`browser UI did not answer "${op}" in time`));
    }, 45_000);
    chromeReqs.set(id, { resolve, reject, timer });
    mainWindow.webContents.send("ctl:req", { id, op, args });
  });
}

let control: ControlHandle | null = null;
/** Set once the MCP service exists: answers the redirect of a sign-in that is waiting for it inside this browser. */
let mcpCapture: (url: string) => { status: number; html: string } | null = () => null;

/**
 * Network policy that is not about a single request. WebSockets bypass our network layer (Chromium opens them
 * itself), so the only way to keep a session to "no connection but the ones we decided on" is to refuse them
 * before any connection is made. Off by default; DBB_BLOCK_WEBSOCKETS=1 or the automation API turns it on.
 */
const netPolicy = { blockWebSockets: process.env.DBB_BLOCK_WEBSOCKETS === "1" };
/** A network layer the caller supplies (see provider.ts). Off until an automation caller turns it on. */
const callerNet = new CallerNetwork(emitNet, nextNetId);
let desktopUserAgent = "";
/**
 * This mode clears stored data at every visit, so it must only ever run on a profile of its own: starting the app with an
 * explicit --user-data-dir. Never the normal one, whose logins it would wipe.
 */
export const dedicatedProfile = (argv: readonly string[] = process.argv): boolean => argv.some((a) => a === "--user-data-dir" || a.startsWith("--user-data-dir="));
/** Things the browser would do on its own that this mode must not: refuse them with a reason. */
const refuseWhileCallerNet = (what: string): void => {
  if (callerNet.enabled) throw new ProviderError("caller-network-on", `${what} is switched off while the caller network is on (the browser makes no request of its own and signs nothing)`);
};
/** The per-visit cookie jar, kept in Chromium's own cookie store (see provider.ts). Off unless asked for. */
let cookiesPerVisit = false;
const visitJar: CookieJar = {
  on: () => cookiesPerVisit,
  header: async (url) => (await session.defaultSession.cookies.get({ url })).map((c) => `${c.name}=${c.value}`).join("; "),
  store: async (url, c) => {
    try {
      await session.defaultSession.cookies.set({ url, name: c.name, value: c.value, ...(c.domain ? { domain: c.domain } : {}), path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, ...(c.expirationDate !== undefined ? { expirationDate: c.expirationDate } : {}) });
    } catch (e) {
      console.error(`[cookies] refused ${c.name}: ${(e as Error).message}`); // a refusal by the cookie store (prefix, Secure on http, bad domain…)
      throw e;
    }
  },
};
function configureCallerNet(p: { enabled?: unknown; userAgent?: unknown; answerTimeoutMs?: unknown; cookies?: unknown; limits?: unknown }): void {
  if (p.limits !== undefined) {
    const l = p.limits as { requests?: unknown; bytes?: unknown } | null;
    const whole = (v: unknown, max: number, what: string) => {
      if (v === undefined) return 0;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > max) throw new ProviderError("bad-params", `limits.${what} must be a whole number from 0 (no limit) to ${max}`);
      return n;
    };
    if (!l || typeof l !== "object") throw new ProviderError("bad-params", "limits must be an object: {requests?, bytes?}");
    callerNet.limits = { requests: whole(l.requests, 100_000, "requests"), bytes: whole(l.bytes, 2 ** 31, "bytes") };
  }
  if (p.cookies !== undefined) {
    if (p.cookies !== "off" && p.cookies !== "visit") throw new ProviderError("bad-params", 'cookies must be "off" (the default: none stored, none sent) or "visit" (kept for one visit only)');
    cookiesPerVisit = p.cookies === "visit";
    callerNet.jar = cookiesPerVisit ? visitJar : null;
  }
  if (p.answerTimeoutMs !== undefined) callerNet.answerTimeoutMs = clampAnswerTimeout(p.answerTimeoutMs);
  if (p.enabled === true) {
    // The caller's identity, always spelled out by the caller. The desktop browser's own identity is never lent to it.
    const ua = String(p.userAgent ?? callerNet.userAgent).trim();
    if (!ua) throw new ProviderError("bad-params", "userAgent is required: this mode takes its identity from the caller");
    if (!dedicatedProfile()) throw new ProviderError("needs-dedicated-profile", "start the browser with --user-data-dir=<a folder of its own>: this mode clears stored data at every visit and must never run on your normal profile");
    if (process.env.DBB_NATIVE_NETWORK === "1") throw new ProviderError("native-network", "DBB_NATIVE_NETWORK=1 turns request interception off, so the caller would not see the requests; unset it");
    if (ua.length > 300 || !/^[ -~]+$/.test(ua)) throw new ProviderError("bad-params", "userAgent must be printable ASCII, at most 300 characters");
    if (/dbbasic-browser/i.test(ua)) throw new ProviderError("bad-params", "userAgent must be the caller's own, not the desktop browser's");
    if (!callerNet.enabled) desktopUserAgent = session.defaultSession.getUserAgent();
    callerNet.userAgent = ua;
    callerNet.enabled = true;
    session.defaultSession.setUserAgent(ua);
    for (const wc of webContents.getAllWebContents()) {
      if (wc.getType() !== "webview") continue;
      wc.setUserAgent(ua); // pages that already exist keep the old one otherwise
      wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp"); // WebRTC opens UDP connections the caller would never see
    }
  } else if (p.enabled === false && callerNet.enabled) {
    callerNet.enabled = false;
    callerNet.failAll("other", "the caller network was turned off");
    callerNet.limits = { requests: 0, bytes: 0 };
    cookiesPerVisit = false;
    callerNet.jar = null;
    void session.defaultSession.clearStorageData(); // leave nothing a caller-supplied page stored (the profile is a dedicated one)
    if (desktopUserAgent) {
      session.defaultSession.setUserAgent(desktopUserAgent);
      for (const wc of webContents.getAllWebContents()) if (wc.getType() === "webview") { wc.setUserAgent(desktopUserAgent); wc.setWebRTCIPHandlingPolicy("default"); }
    }
  } else if (p.enabled !== undefined && typeof p.enabled !== "boolean") throw new ProviderError("bad-params", "enabled must be true or false");
  emit({ kind: "net-provider-changed", enabled: callerNet.enabled, answerTimeoutMs: callerNet.answerTimeoutMs });
}

function setupNetPolicy(): void {
  // Permission prompts (camera, location, notifications, …): refused while the caller network is on; otherwise unchanged (granted, as before).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (callerNet.enabled) emit({ kind: "permission-refused", permission });
    callback(!callerNet.enabled);
  });
  session.defaultSession.setPermissionCheckHandler(() => !callerNet.enabled);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["ws://*/*", "wss://*/*"] }, (details, callback) => {
    // Always refused while the caller network is on: a WebSocket is a connection the caller never sees.
    const refuse = netPolicy.blockWebSockets || callerNet.enabled;
    if (refuse) emit({ kind: "websocket-refused", url: details.url });
    callback({ cancel: refuse }); // cancelled before any connection is opened
  });
}

// ---- downloads -----------------------------------------------------------------------------------
// Chromium already neutralizes hostile filenames and shows the native Save dialog; what was missing was
// any sign of progress, completion or failure. This tracks each download, announces it to the UI and the
// automation event log, and links paid downloads to the x402 payment that unlocked them.
// DBB_DOWNLOAD_DIR skips the dialog and saves there (scripted runs and tests, so nothing blocks).
interface DownloadRecord {
  id: number;
  name: string;
  host: string;
  total: number;
  received: number;
  state: "progressing" | "paused" | "completed" | "cancelled" | "interrupted";
  path: string;
  /** The x402 amount paid for this URL just before the download started, e.g. "$0.001". */
  paid?: string;
  /** macOS: whether the file was marked as downloaded from the internet (so Gatekeeper vets it). */
  quarantined?: boolean;
  startedAt: number;
}
const downloads = new Map<number, DownloadRecord>();
let downloadSeq = 0;

/** A file name that is safe to create: no directories, no control or reserved characters, no leading dots. */
export function cleanFileName(name: string): string {
  const n = basename(String(name).replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
    .replace(/^\.+/, "_")
    .trim()
    .slice(0, 180);
  return n || "download";
}

function uniquePath(dir: string, name: string): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = join(dir, name);
  for (let i = 1; existsSync(candidate) && i < 1000; i++) candidate = join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

/**
 * Mark a downloaded file as coming from the internet. Electron does not do this for us, and without
 * `com.apple.quarantine` macOS Gatekeeper never vets a downloaded app, installer or script — every mainstream
 * browser sets it. Format: flags;timestamp-hex;agent;event-uuid (0083 = a web download, like Chrome's).
 */
function quarantine(path: string): Promise<boolean> {
  if (process.platform !== "darwin") return Promise.resolve(false);
  const value = `0083;${Math.floor(Date.now() / 1000).toString(16)};dbbasic-browser;${randomUUID().toUpperCase()}`;
  return new Promise((resolve) => execFile("/usr/bin/xattr", ["-w", "com.apple.quarantine", value, path], (err) => resolve(!err)));
}

function paidFor(url: string): string | undefined {
  const bare = url.split("#")[0];
  for (let i = eventLog.length - 1; i >= 0 && i > eventLog.length - 300; i--) {
    const e = eventLog[i]!;
    if (e.kind === "paid" && Date.now() - (e.at as number) < 120_000 && (e.resource === bare || e.requested === bare)) return String(e.amount);
  }
  return undefined;
}

// ---- the right-click menu (which items: context-menu.ts) ----------------------------------------------
/** The menu shown last, so the automation API can read it and pick an item (in background mode it is not shown at all). */
let lastMenu: { wcId: number; items: MenuItem[]; run: (id: string) => boolean } | null = null;

function showContextMenu(wc: WebContents, p: Electron.ContextMenuParams, page: boolean): void {
  const items = contextMenuItems(p, {
    page,
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    newTabs: !callerNet.enabled,
  });
  if (!items.length) return;
  const offered = new Set(items.flatMap((it) => ("id" in it && it.enabled !== false ? [it.id] : [])));
  const run = (id: string) => {
    if (!offered.has(id)) return false;
    runMenuItem(wc, p, id);
    return true;
  };
  lastMenu = { wcId: wc.id, items, run };
  // A scripted run in the background must not put a menu on someone's screen: it is recorded instead (as it is for the
  // end-to-end suite, DBB_RECORD_MENUS=1, which picks items through the automation API).
  if (background || process.env.DBB_RECORD_MENUS === "1") {
    emit({ kind: "context-menu", wcId: wc.id, items: [...offered] });
    return;
  }
  Menu.buildFromTemplate(items.map((it): MenuItemConstructorOptions => ("id" in it ? { label: it.label, enabled: it.enabled !== false, click: () => run(it.id) } : { type: "separator" })))
    .popup({ window: mainWindow ?? undefined });
}

function runMenuItem(wc: WebContents, p: Electron.ContextMenuParams, id: string): void {
  if (wc.isDestroyed()) return;
  const web = (u: string) => /^https?:\/\//i.test(u);
  const newTab = (url: string) => { if (web(url) && !callerNet.enabled) mainWindow?.webContents.send("tab:open", url, { background: true }); };
  const text = (p.selectionText || "").trim();
  if (id.startsWith("spell:")) {
    const w = p.dictionarySuggestions?.[Number(id.slice(6))];
    if (w) wc.replaceMisspelling(w);
    return;
  }
  switch (id) {
    case "open-link-tab": return newTab(p.linkURL);
    case "copy-link": return void clipboard.writeText(p.linkURL);
    case "open-image-tab": return newTab(p.srcURL);
    case "copy-image": return wc.copyImageAt(p.x, p.y);
    case "copy-image-address": return void clipboard.writeText(p.srcURL);
    case "save-image": return web(p.srcURL) ? wc.downloadURL(p.srcURL) : undefined;
    case "undo": return wc.undo();
    case "redo": return wc.redo();
    case "cut": return wc.cut();
    case "copy": return wc.copy();
    case "paste": return wc.paste();
    case "select-all": return wc.selectAll();
    // The chrome knows the search address and owns the chat: it does these two.
    case "search-selection":
    case "ask-selection": return void mainWindow?.webContents.send("ctx:action", { id, text });
    case "back": return wc.navigationHistory.goBack();
    case "forward": return wc.navigationHistory.goForward();
    case "reload": return wc.reload();
    case "inspect": return wc.inspectElement(p.x, p.y);
  }
}

function setupDownloads(): void {
  session.defaultSession.on("will-download", (_event, item, sourceContents) => {
    if (sourceContents) noteDownload(sourceContents.id, item.getFilename());
    // In caller-network mode nothing is written to disk: a download is refused, and the verdict still says the address was a download.
    if (callerNet.enabled) {
      item.cancel();
      emit({ kind: "download-refused", name: cleanFileName(item.getFilename()) });
      return;
    }
    const id = ++downloadSeq;
    let host = "";
    try {
      host = new URL(item.getURL()).host;
    } catch {
      /* data: or blob: URL */
    }
    const rec: DownloadRecord = { id, name: cleanFileName(item.getFilename()), host, total: item.getTotalBytes(), received: 0, state: "progressing", path: "", startedAt: Date.now() };
    const paid = paidFor(item.getURL());
    if (paid) rec.paid = paid;
    const dir = process.env.DBB_DOWNLOAD_DIR;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      rec.path = uniquePath(dir, rec.name);
      item.setSavePath(rec.path);
    }
    downloads.set(id, rec);
    const announce = () => emit({ kind: "download", ...rec });
    announce();
    let last = 0;
    item.on("updated", (_e, state) => {
      rec.received = item.getReceivedBytes();
      rec.total = item.getTotalBytes();
      rec.state = state === "interrupted" ? "interrupted" : item.isPaused() ? "paused" : "progressing";
      const now = Date.now();
      if (now - last > 150 || state === "interrupted") {
        last = now;
        announce();
      }
    });
    item.once("done", (_e, state) => {
      rec.received = item.getReceivedBytes();
      rec.total = item.getTotalBytes() || rec.received;
      rec.path = item.getSavePath() || rec.path; // the path the user chose in the Save dialog
      if (state === "completed" && rec.path) {
        // The download only counts as completed once it is quarantined, and the state and the announcement change
        // together — so nothing (UI, automation, a person) is told "done" before the file is marked.
        void quarantine(rec.path).then((ok) => {
          rec.quarantined = ok;
          rec.state = "completed";
          announce();
        });
      } else {
        rec.state = state === "interrupted" ? "interrupted" : "cancelled";
        announce();
      }
    });
  });
}

function showLastDownload(): void {
  const done = [...downloads.values()].filter((d) => d.state === "completed" && d.path).pop();
  if (done) shell.showItemInFolder(done.path);
  else void shell.openPath(app.getPath("downloads"));
}

function buildEngine(): X402Engine {
  const policy = new PolicyEngine();
  const ledger = new Ledger();

  // The engine's network calls go through netRequestFetch (see transport.ts): it never follows
  // redirects itself — it returns 3xx to the renderer so URL/origin stay truthful — and, being
  // net.request, it is not routed back into our own protocol.handle handler.
  const nativeFetch = netRequestFetch();
  // In "caller network" mode (provider.ts) the browser makes no request of its own: the caller answers each one.
  const rawFetch: RawFetch = (req) => (callerNet.enabled || callerNet.hasDocumentFor(req.url) ? callerNet.fetch(req) : nativeFetch(req));

  return new X402Engine({
    account,
    policy,
    ledger,
    fetchImpl: rawFetch as typeof fetch,
    approve: async ({ quote, resourceUrl, reason }) => {
      // A payment is a signature from the wallet; in caller-network mode the only party that asked is a caller's answer.
      if (callerNet.enabled) {
        emit({ kind: "auto-decision", resource: resourceUrl, approved: false, price: formatUsd(quote.priceUsdMicro), mode: "caller-network", cap: 0 });
        return false;
      }
      // Automation may pre-decide — but never silently: every such decision is an event
      // (toast + inspector + the API's event log), and policy hard caps still apply
      // because we are only ever asked about payments the policy already allowed to prompt.
      if (approval.mode !== "ask") {
        const usd = Number(quote.priceUsdMicro) / 1e6;
        const yes = approval.mode === "auto" && usd <= approval.maxUsd;
        emit({ kind: "auto-decision", resource: resourceUrl, approved: yes, price: formatUsd(quote.priceUsdMicro), mode: approval.mode, cap: approval.maxUsd });
        return yes;
      }
      // Native modal — the price is shown to the user before a signature is produced.
      const { response } = await dialog.showMessageBox(mainWindow ?? undefined!, {
        type: "question",
        buttons: ["Pay", "Cancel"],
        defaultId: 0,
        cancelId: 1,
        title: "Payment required",
        message: `Pay ${formatUsd(quote.priceUsdMicro)} ${quote.assetSymbol}?`,
        detail: `${resourceUrl}\n\n${reason}`,
      });
      return response === 0;
    },
    onEvent: (e) => {
      // One structured event stream drives both the toolbar (meter/toasts) and the
      // per-tab inspector. All bigints are pre-formatted so IPC stays plain JSON.
      const send = emit;

      if (e.type === "quoted") {
        // Price-before-paying: the 402 is free, so we can report cost before paying.
        send({
          kind: "quoted",
          resource: e.resourceUrl,
          quotes: e.quotes.map((q) => ({
            scheme: q.requirements.scheme,
            network: q.requirements.network,
            asset: q.assetSymbol,
            assetAddress: q.requirements.asset,
            amountAtomic: q.requirements.amount,
            price: formatUsd(q.priceUsdMicro),
            payTo: q.requirements.payTo,
            maxTimeoutSeconds: q.requirements.maxTimeoutSeconds,
          })),
          rejected: e.rejected,
        });
      } else if (e.type === "decided") {
        send({
          kind: "decided",
          resource: e.resourceUrl,
          action: e.verdict.action, // allow | prompt | deny
          reason: e.verdict.reason,
          price: formatUsd(e.quote.priceUsdMicro),
          asset: e.quote.assetSymbol,
        });
      } else if (e.type === "paid") {
        const r = e.receipt;
        send({
          kind: "paid",
          resource: r.resourceUrl,
          requested: r.requestedUrl,
          amount: formatUsd(r.priceUsdMicro),
          asset: r.assetSymbol,
          dest: r.destOrigin,
          network: r.network,
          payTo: r.payTo,
          nonce: r.nonce,
          validBefore: r.validBefore,
          auth: r.authorization
            ? {
                from: r.authorization.from,
                to: r.authorization.to,
                value: r.authorization.value,
                validAfter: r.authorization.validAfter,
                validBefore: r.authorization.validBefore,
              }
            : null,
          signature: r.signature ?? null,
          status: r.status,
          tx: r.txHash ?? null,
          totalSpent: formatUsd(policy.spentUsdMicro()),
        });
        bumpBalance(); // a real (live-route) payment changes the on-chain balances
      } else if (e.type === "skipped") {
        send({ kind: "skipped", resource: e.resourceUrl, reason: e.reason });
      }
    },
  });
}

/** Open the built-in help page (optionally at an anchor) in a new tab. */
function openHelp(anchor: string): void {
  const url = pathToFileURL(join(__dirname, "help.html")).href + (anchor ? `#${anchor}` : "");
  mainWindow?.webContents.send("tab:open", url);
}

/** Loading-animation preference. The chrome UI owns it (localStorage); we only mirror it for the menu's radio check. */
let motionPref: "always" | "system" | "never" = "system";

/**
 * AI Reader provider/model. Keys come from the environment or a private file outside the repo
 * (see ai-config.ts); they never leave this process. Anthropic is the default provider.
 */
const aiLoaded = loadAiEnv();
let aiCfg: AiConfig | null = resolveAi(aiLoaded);
function setAiProvider(p: Provider): boolean {
  if (!aiCfg?.available.includes(p)) return false;
  aiCfg = resolveAi({ ...aiLoaded, values: { ...aiLoaded.values, DBB_AI_PROVIDER: p } });
  buildMenu();
  emit({ kind: "ai-provider", provider: aiCfg?.provider, model: aiCfg?.model });
  return true;
}

/** Tell the chrome UI to do a tab action (new/close/focus-url/next/prev/reload). */
const tabCmd = (cmd: string) => () => mainWindow?.webContents.send("tab:cmd", cmd);

/**
 * App menu. Tab shortcuts live here as accelerators rather than keydown handlers in the
 * chrome document: once a page has focus, its <webview> swallows key events, but menu
 * accelerators still fire. Reload targets the active TAB — Electron's default View►Reload
 * would reload the chrome itself and wipe every open tab.
 */
function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
    {
      label: "File",
      submenu: [
        { label: "New Tab", accelerator: "CmdOrCtrl+T", click: tabCmd("new") },
        // There is one window, so ⌘N opens a tab, as people expect from it (a separate window is a task of its own).
        { label: "New Tab (⌘N)", accelerator: "CmdOrCtrl+N", click: tabCmd("new"), visible: false },
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: tabCmd("close") },
        { label: "Open Location", accelerator: "CmdOrCtrl+L", click: tabCmd("focus-url") },
        // Escape hatch for sites that refuse embedded-Chromium browsers (see Help ▸ How we identify ourselves).
        { label: "Open Page in Default Browser", accelerator: "CmdOrCtrl+Shift+O", click: tabCmd("open-external") },
        { type: "separator" },
        { label: "Show Last Download in Finder", click: () => showLastDownload() },
        { label: "Show Downloads Folder", click: () => void shell.openPath(app.getPath("downloads")) },
        { label: "Next Tab (alt)", accelerator: "CmdOrCtrl+Alt+Right", click: tabCmd("next"), visible: false },
        { label: "Previous Tab (alt)", accelerator: "CmdOrCtrl+Alt+Left", click: tabCmd("prev"), visible: false },
        // ⌘⇧] and ⌘⇧[, as in Safari and Chrome. Some keyboard layouts report the shifted key as } and {, so both are listened for.
        { label: "Next Tab (⌘⇧])", accelerator: "CmdOrCtrl+Shift+]", click: tabCmd("next"), visible: false },
        { label: "Previous Tab (⌘⇧[)", accelerator: "CmdOrCtrl+Shift+[", click: tabCmd("prev"), visible: false },
        { label: "Next Tab (⌘})", accelerator: "CmdOrCtrl+}", click: tabCmd("next"), visible: false },
        { label: "Previous Tab (⌘{)", accelerator: "CmdOrCtrl+{", click: tabCmd("prev"), visible: false },
        // ⌘1 to ⌘8 go to that tab, ⌘9 to the last one.
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ label: n === 9 ? "Last Tab" : `Tab ${n}`, accelerator: `CmdOrCtrl+${n}`, click: tabCmd(`tab:${n}`), visible: false })),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
        { type: "separator" },
        // Find uses the page's own find: nothing leaves the machine. ⌘F goes to the page first, so a site with its own
        // find (an editor, a document) keeps it; the menu item always opens the browser's.
        { label: "Find…", accelerator: "CmdOrCtrl+F", click: tabCmd("find") },
        { label: "Find Next", accelerator: "CmdOrCtrl+G", click: tabCmd("find-next") },
        { label: "Find Previous", accelerator: "CmdOrCtrl+Shift+G", click: tabCmd("find-prev") },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Reload Page", accelerator: "CmdOrCtrl+R", click: tabCmd("reload") },
        {
          label: "Loading Animations",
          submenu: [
            { label: "Always", type: "radio", checked: motionPref === "always", click: tabCmd("motion:always") },
            { label: "Follow System “Reduce Motion”", type: "radio", checked: motionPref === "system", click: tabCmd("motion:system") },
            { label: "Never", type: "radio", checked: motionPref === "never", click: tabCmd("motion:never") },
          ],
        },
        { type: "separator" },
        { label: "AI Reader", accelerator: "CmdOrCtrl+Shift+R", click: tabCmd("reader") },
        { label: "Assistant chat", accelerator: "CmdOrCtrl+J", click: tabCmd("chat") },
        { label: "x402 Inspector", click: tabCmd("click:inspectBtn") },
        { label: "What the Browser Is Using (Memory, CPU, Data)", click: tabCmd("click:resBtn") },
        {
          label: "AI Provider",
          enabled: !!aiCfg,
          submenu: aiCfg
            ? [
                ...(["anthropic", "openai"] as const).map((p) => ({
                  label: p === "anthropic" ? "Anthropic" : "OpenAI",
                  type: "radio" as const,
                  enabled: aiCfg!.available.includes(p),
                  checked: aiCfg!.provider === p,
                  click: () => void setAiProvider(p),
                })),
                { type: "separator" as const },
                { label: `Model: ${aiCfg.model}`, enabled: false },
              ]
            : [{ label: "No API key found — see Help ▸ AI Reader", enabled: false }],
        },
        { type: "separator" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Go",
      submenu: [
        { label: "Back", accelerator: "CmdOrCtrl+[", click: tabCmd("back") },
        { label: "Forward", accelerator: "CmdOrCtrl+]", click: tabCmd("forward") },
        { type: "separator" },
        { label: "Next Tab", accelerator: "Ctrl+Tab", click: tabCmd("next") },
        { label: "Previous Tab", accelerator: "Ctrl+Shift+Tab", click: tabCmd("prev") },
      ],
    },
    {
      label: "Bookmarks",
      submenu: [
        { label: "Save This Page to askrobots", accelerator: "CmdOrCtrl+D", click: tabCmd("click:starBtn") },
        { label: "Show Bookmarks", accelerator: "CmdOrCtrl+Shift+B", click: tabCmd("click:bmBtn") },
        { type: "separator" },
        { label: "Keep This Page and Close It", click: tabCmd("click:keepBtn") },
        { label: "Show Kept Copies", click: tabCmd("kept") },
      ],
    },
    {
      label: "Tools",
      submenu: [
        { label: "Passwords…", click: tabCmd("click:keyBtn") },
        { label: "Connections (askrobots and other services)…", click: tabCmd("connections") },
        { type: "separator" },
        { label: "Wallet: Copy Address and Get Test Funds", click: tabCmd("click:fundBtn") },
        { type: "separator" },
        { label: "x402 Test Gallery (local)", click: tabCmd("click:galleryBtn") },
        { label: "Tour of the Test Gallery", click: tabCmd("click:tourBtn") },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "dbbasic-browser Help", accelerator: "F1", click: () => openHelp("") },
        { label: "Keyboard Shortcuts", click: () => openHelp("shortcuts") },
        { label: "x402 Payments", click: () => openHelp("x402") },
        { label: "x402 Demo Gallery (local)", click: () => mainWindow?.webContents.send("tab:open", "http://127.0.0.1:8899/") },
        { label: "Password Manager", click: () => openHelp("passwords") },
        { label: "Automation API", click: () => openHelp("automation") },
        { type: "separator" },
        {
          label: control ? `Automation API: on (127.0.0.1:${control.port})` : "Automation API: off — launch with DBB_CONTROL=1",
          enabled: false,
        },
        { type: "separator" },
        { label: "Report an Issue…", click: () => void shell.openExternal("https://github.com/askrobots/dbbasic-browser/issues/new") },
        { label: "Project on GitHub", click: () => void shell.openExternal("https://github.com/askrobots/dbbasic-browser") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * DBB_BACKGROUND=1: automation that never takes the screen. The window is created off-screen and shown WITHOUT taking focus
 * (an off-screen window is still drawn, unlike a hidden or minimized one, so pages, captures and input keep working), the app
 * stays out of the Dock, and nothing raises or focuses it afterwards. Meant for scripted runs on a machine someone is using.
 */
const background = process.env.DBB_BACKGROUND === "1";

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    ...(background ? { show: false } : {}),
    title: "dbbasic-browser",
    icon: ICON_PATH,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      webviewTag: true, // the page renders in a <webview>; chrome is the host document
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        `--homepage=${process.env.HOMEPAGE ?? "https://askrobots.com/"}`,
        `--webview-preload=${pathToFileURL(join(__dirname, "webview-preload.cjs")).href}`,
      ],
    },
  });
  mainWindow.loadFile(join(__dirname, "chrome.html"));
  // The browser's own fields (the address bar, the chat box) get the text items of the right-click menu.
  mainWindow.webContents.on("context-menu", (_e, p) => { if (mainWindow) showContextMenu(mainWindow.webContents, p, false); });
  if (background) {
    if (process.platform === "darwin") app.dock?.hide();
    // Shown first and moved afterwards: macOS clamps a window back onto the screen when it is created or first shown there,
    // but lets a window that is already shown be moved off it. (An off-screen window is still drawn; a hidden one is not.)
    mainWindow.once("ready-to-show", () => {
      mainWindow?.showInactive();
      mainWindow?.setPosition(-20000, -20000);
      // macOS keeps a sliver of the window on screen. Make that invisible and untouchable too; the page is still drawn.
      mainWindow?.setOpacity(0);
      mainWindow?.setIgnoreMouseEvents(true);
    });
  }
  mainWindow.on("closed", () => (mainWindow = null));
}

app.whenReady().then(async () => {
  // Chrome's Accept-Language shape ("en-US,en;q=0.9"), not the bare locale the session defaults to.
  const locale = app.getLocale() || "en-US";
  // DBB_CALLER_NETWORK_USER_AGENT=<identity> starts with the caller-supplied network layer already ON, before any page is
  // created, so not even the first tab is fetched by the browser itself. (Same rules as net.provider: the identity is the caller's.)
  const startWithCaller = process.env.DBB_CALLER_NETWORK_USER_AGENT;
  session.defaultSession.setUserAgent(USER_AGENT, locale.includes("-") ? `${locale},${locale.split("-")[0]}` : locale); // Chromium adds the q-values itself
  if (startWithCaller) {
    try {
      configureCallerNet({ enabled: true, userAgent: startWithCaller });
    } catch (e) {
      console.error(`[net] DBB_CALLER_NETWORK_USER_AGENT refused: ${(e as Error).message}`);
      app.exit(2);
      return;
    }
  }
  if (process.platform === "darwin") {
    const img = nativeImage.createFromPath(ICON_PATH);
    if (!img.isEmpty()) app.dock?.setIcon(img);
  }
  const engine = buildEngine();

  // Take over https AND http. From here, every request the browser makes is
  // paid-aware. x402 works over plain http too (the spec is transport-agnostic), and
  // it's what lets a local http demo exercise the same path as a real https site.
  const payHandler = createPaymentHandler(engine);
  // DBB_NATIVE_NETWORK=1 turns interception OFF so Chromium's own loader makes every request —
  // no x402 payments, but handy for telling "our transport" apart from "the site" when debugging.
  if (process.env.DBB_NATIVE_NETWORK === "1") {
    console.error("[net] DBB_NATIVE_NETWORK=1 — request interception (and x402 payments) disabled");
  } else {
    // A sign-in that is waiting for its redirect inside this browser (see mcp-service.ts) is answered here, without any request.
    const withSignInRedirect = (h: (r: Request) => Promise<Response>) => async (request: Request): Promise<Response> => {
      const caught = request.method === "GET" ? mcpCapture(request.url) : null;
      return caught ? new Response(caught.html, { status: caught.status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }) : h(request);
    };
    protocol.handle("https", withSignInRedirect(payHandler));
    protocol.handle("http", withSignInRedirect(payHandler));
  }

  ipcMain.handle("x402:receipts", () => engine.ledger.all());
  ipcMain.handle("x402:spent", () => formatUsd(engine.policy.spentUsdMicro()));
  ipcMain.handle("x402:wallet", () => ({ address: account.address }));
  ipcMain.handle("x402:copy", (_e, text: string) => clipboard.writeText(String(text)));
  // Open the funding faucet in the OS browser with the address already on the clipboard.
  ipcMain.handle("x402:fund", () => {
    if (callerNet.enabled) return;
    clipboard.writeText(account.address);
    return shell.openExternal("https://faucet.circle.com");
  });
  ipcMain.handle("x402:refund", () => refundMerchant());
  ipcMain.handle("x402:open-external", (_e, url: unknown) => {
    const safe = safeExternalUrl(url);
    return safe ? shell.openExternal(safe).then(() => true) : false;
  });

  // Pages that ask for a new window (target=_blank, window.open) get a tab instead of a
  // stray native window. Only web URLs — never let a page spawn file:/custom schemes.
  app.on("web-contents-created", (_e, wc) => {
    if (wc.getType() !== "webview") return;
    trackLifecycle(wc);
    // Tab keys belong to the browser: caught before the page, which could otherwise swallow them (see shortcuts.ts).
    wc.on("before-input-event", (event, input) => {
      const cmd = reservedShortcut(input, process.platform === "darwin");
      if (!cmd) return;
      event.preventDefault(); // the page never sees it, and the menu does not run it a second time
      mainWindow?.webContents.send("tab:cmd", cmd);
    });
    wc.on("context-menu", (_e, p) => showContextMenu(wc, p, true));
    if (callerNet.enabled) wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp"); // no UDP for ICE/STUN: it would bypass the caller
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (callerNet.enabled) {
        emit({ kind: "popup-refused", url }); // no new window or tab in this mode
        return { action: "deny" };
      }
      // ⌘-click and middle-click ask for a background tab: it opens behind the page you are on, as in other browsers.
      if (/^https?:\/\//i.test(url)) mainWindow?.webContents.send("tab:open", url, { background: disposition === "background-tab" });
      return { action: "deny" };
    });
    // A tab is created blank and then navigated, which leaves a hidden about:blank "back" entry: Back walked into
    // an empty page. Drop it as soon as the tab's first real page commits, so a new tab has nothing to go back to.
    let pruned = false;
    wc.on("did-navigate", () => {
      if (pruned || wc.isDestroyed()) return;
      const h = wc.navigationHistory;
      if (h.length() === 2 && h.getEntryAtIndex(0).url === "about:blank") {
        h.removeEntryAtIndex(0);
        pruned = true;
      } else if (wc.getURL() !== "about:blank") pruned = true;
    });
  });
  buildMenu();
  setupDownloads();
  setupNetPolicy();
  // Serve reader views from the store. When the summary arrives the stored page is updated, so Back/Forward/reload
  // show the finished view instead of the pending snapshot. An evicted page gets a polite "expired" notice.
  protocol.handle(READER_SCHEME, (request) => {
    const id = readerIdFromUrl(request.url);
    const html = id ? readerPages.get(id) : undefined;
    return new Response(html ?? EXPIRED_HTML, {
      status: html ? 200 : 410,
      headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": READER_CSP, "referrer-policy": "no-referrer", "cache-control": "no-store" },
    });
  });
  const reader = createReader({ getWindow: () => mainWindow, askChrome, emit, getAi: () => aiCfg, pages: readerPages });
  // From the chrome UI (a human clicked Reader): ask before anything is sent.
  ipcMain.handle("reader:open", async (_e, a: { wcId?: number }) => {
    if (callerNet.enabled) return { ok: false, reason: "caller-network-on", message: "The reader is switched off while the caller network is on." };
    const r = await reader.open({ wcId: Number(a?.wcId), interactive: true });
    return { ok: r.ok, reason: r.reason, message: r.message, ai: r.ai };
  });
  ipcMain.handle("reader:ai", () => describeAi(aiCfg));
  ipcMain.handle("reader:provider", (_e, p: unknown) => (p === "anthropic" || p === "openai" ? setAiProvider(p) : false));
  const vaultSvc = registerVault({ path: process.env.DBB_VAULT || join(app.getPath("userData"), "vault.json"), getWindow: () => mainWindow });

  // Tab list mirror (for the automation API) and the chrome UI's answers to askChrome().
  ipcMain.on("tabs:sync", (_e, list: TabInfo[]) => setTabs(Array.isArray(list) ? list : []));
  ipcMain.on("ctl:res", (_e, r: { id: string; result?: unknown; error?: string }) => {
    const p = chromeReqs.get(r.id);
    if (!p) return;
    clearTimeout(p.timer);
    chromeReqs.delete(r.id);
    if (r.error) p.reject(new Error(r.error));
    else p.resolve(r.result);
  });

  // Local extensions (extra automation methods from code on this machine): only from DBB_EXTENSIONS, announced, and all-or-nothing.
  const extensions = new ExtensionRegistry<WebContents>();
  try {
    await loadExtensions(parseExtensionPaths(process.env.DBB_EXTENSIONS), extensions, (file) => console.error(`[extensions] loaded ${basename(file)}`));
  } catch (e) {
    console.error(`[extensions] refused to start: ${(e as Error).message}`);
    app.exit(3);
    return;
  }

  createWindow();
  // Automation API: off unless asked for (see control.ts for the security model).
  // MCP connections (sign in with OAuth, add tools to the chat). Sign-ins are kept only encrypted by the operating system;
  // without that, or with DBB_MCP_STORE=memory, they last until the browser closes.
  const mcpAuthPath = join(app.getPath("userData"), "mcp-auth.bin");
  const mcpEncryption = process.env.DBB_MCP_STORE === "memory" ? { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => "" } : safeStorage;
  const mcpConfig = loadServerConfigs(process.env.DBB_MCP_SERVERS || join(app.getPath("userData"), "mcp-servers.json"));
  for (const problem of mcpConfig.problems) console.error(`[mcp] servers file: ${problem}`);
  const mcp = new McpService({
    fetch: (url, init) => fetch(url, init as RequestInit),
    store: createStore(mcpAuthPath, mcpEncryption, {
      read: (p) => (existsSync(p) ? readFileSync(p) : null),
      write: (p, b) => (b ? (writeFileSync(p, b, { mode: 0o600 }), chmodSync(p, 0o600)) : rmSync(p, { force: true })),
    }),
    servers: mcpConfig.servers,
    openExternal: (url) => {
      const safe = safeExternalUrl(url);
      if (safe) void shell.openExternal(safe);
    },
    openTab: async (url) => {
      const r = (await askChrome("tab.new", { url, activate: true, wait: false })) as { id?: number } | undefined;
      return typeof r?.id === "number" ? r.id : null;
    },
    closeTab: async (id) => {
      await askChrome("tab.close", { id }).catch(() => {});
    },
    callerNetworkOn: () => callerNet.enabled,
    announce: (e) => {
      emit(e);
      // A new sign-in brings the bookmarks in at once; signing out shows the local copy again.
      if (e.kind === "mcp-signed-in" && e.server === BOOKMARK_SERVER) void bookmarks.refresh();
      if (e.kind === "mcp-signed-out" && e.server === BOOKMARK_SERVER) mainWindow?.webContents.send("bookmarks:changed", bookmarks.state());
    },
  });
  mcpCapture = (url) => mcp.captureRedirect(url);

  // Bookmarks: the person's saved links on askrobots, over the same connection, with a local copy (see bookmarks-service.ts).
  const BOOKMARK_SERVER = "askrobots";
  const bookmarksPath = join(app.getPath("userData"), "bookmarks.json");
  const bookmarks = new BookmarksService({
    call: (tool, args, opts) => mcp.callDirect(BOOKMARK_SERVER, tool, args, opts),
    connected: () => mcp.isSignedIn(BOOKMARK_SERVER),
    ready: () => mcp.isLoaded(),
    loadCopy: () => (existsSync(bookmarksPath) ? readFileSync(bookmarksPath, "utf8") : null),
    saveCopy: (text) => {
      writeFileSync(bookmarksPath, text, { mode: 0o600 });
      chmodSync(bookmarksPath, 0o600);
    },
    changed: (state) => mainWindow?.webContents.send("bookmarks:changed", state),
  });
  // Loaded once when the browser opens (so ☆ knows which pages are saved from the start), when the person opens the list, and
  // right after saving or signing in. Only for a person at the window with a saved sign-in: reading it can raise the system
  // keychain prompt, which a scripted or background run must never wait behind.
  if (!background && process.env.DBB_CONTROL !== "1" && existsSync(mcpAuthPath)) {
    const loadOnce = () => setTimeout(() => { if (!callerNet.enabled) void bookmarks.refresh(); }, 1200);
    if (mainWindow?.webContents.isLoading()) mainWindow.webContents.once("did-finish-load", loadOnce);
    else loadOnce();
  }
  ipcMain.handle("bookmarks:state", () => bookmarks.state());
  ipcMain.handle("bookmarks:refresh", () => (callerNet.enabled ? bookmarks.state() : bookmarks.refresh()));
  ipcMain.handle("bookmarks:search", (_e, q: unknown) => (callerNet.enabled ? { items: [], error: "switched off while the caller network is on" } : bookmarks.search(String(q ?? ""))));
  ipcMain.handle("bookmarks:check", (_e, url: unknown) => (callerNet.enabled ? { checked: false, saved: false } : bookmarks.checkPage(String(url ?? ""))));
  ipcMain.handle("bookmarks:set-check", (_e, on: unknown) => bookmarks.setCheckPages(on === true));
  ipcMain.handle("bookmarks:add", (_e, url: unknown, title: unknown) => bookmarks.add(String(url ?? ""), String(title ?? "")));
  ipcMain.handle("mcp:state", () => mcp.state());
  ipcMain.handle("mcp:connect", async (_e, id: unknown) => {
    try {
      const r = await mcp.connect(String(id));
      await r.done;
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle("mcp:cancel", (_e, id: unknown) => (mcp.cancelConnect(String(id)), true));
  ipcMain.handle("mcp:disconnect", (_e, id: unknown) => mcp.disconnect(String(id)).then(() => ({ ok: true }), (e) => ({ ok: false, message: String(e?.message ?? e) })));

  // What the browser is using, so something that hogs the machine has a name: memory and CPU per tab (from the operating system's
  // numbers for each page's own process), the data folder's size and what it is made of, and the cache.
  let diskCache: { at: number; usage: DiskUsage } | null = null;
  let footprintCache: { at: number; bytes: Map<number, number> } | null = null;
  const resources = {
    async state() {
      const metrics = app.getAppMetrics();
      const byPid = new Map(metrics.map((x) => [x.pid, x]));
      const mb = (kb: number) => Math.round((kb / 1024) * 10) / 10;
      // What a process really costs the machine: on macOS the physical footprint (it counts memory the system has compressed,
      // which resident size hides); elsewhere the figure Electron gives (private bytes on Windows, resident size on Linux).
      if (!footprintCache || Date.now() - footprintCache.at > 2000) footprintCache = { at: Date.now(), bytes: await macFootprints(metrics.map((x) => x.pid)) };
      const costKB = (x: Electron.ProcessMetric): number => {
        const f = footprintCache?.bytes.get(x.pid);
        if (f != null) return f / 1024;
        return process.platform === "win32" && x.memory.privateBytes != null ? x.memory.privateBytes : x.memory.workingSetSize;
      };
      const tabsNow = getTabs().map((t) => {
        const wc = t.wcId != null ? webContents.fromId(t.wcId) : undefined;
        const pid = wc && !wc.isDestroyed() ? wc.getOSProcessId() : null;
        const x = pid != null ? byPid.get(pid) : undefined;
        return { id: t.id, title: t.title, url: t.url, active: t.active, pid, memoryMB: x ? mb(costKB(x)) : null, residentMB: x ? mb(x.memory.workingSetSize) : null, cpu: x ? Math.round(x.cpu.percentCPUUsage * 10) / 10 : null };
      });
      // Tabs on the same site can share one process: say so, so the same number is not counted twice.
      const pidCount = new Map<number, number>();
      for (const t of tabsNow) if (t.pid != null) pidCount.set(t.pid, (pidCount.get(t.pid) ?? 0) + 1);
      const byType: Record<string, { processes: number; memoryMB: number; cpu: number }> = {};
      for (const x of metrics) {
        const k = x.type === "Tab" ? "pages" : x.type === "Browser" ? "browser" : x.type === "GPU" ? "graphics" : "other";
        const e = (byType[k] ??= { processes: 0, memoryMB: 0, cpu: 0 });
        e.processes++;
        e.memoryMB = Math.round((e.memoryMB + mb(costKB(x))) * 10) / 10;
        e.cpu = Math.round((e.cpu + x.cpu.percentCPUUsage) * 10) / 10;
      }
      const cacheBytes = await session.defaultSession.getCacheSize().catch(() => null);
      if (!diskCache || Date.now() - diskCache.at > 30_000) diskCache = { at: Date.now(), usage: await diskUsage(app.getPath("userData")) };
      return {
        totalMemoryMB: Math.round(Object.values(byType).reduce((s, e) => s + e.memoryMB, 0) * 10) / 10,
        totalCpu: Math.round(Object.values(byType).reduce((s, e) => s + e.cpu, 0) * 10) / 10,
        byType,
        tabs: tabsNow.map((t) => ({ ...t, sharedProcess: t.pid != null && (pidCount.get(t.pid) ?? 0) > 1 })),
        cacheBytes,
        disk: diskCache.usage,
      };
    },
    async clearCache() {
      const before = await session.defaultSession.getCacheSize().catch(() => 0);
      await session.defaultSession.clearCache();
      diskCache = null;
      return { freedBytes: before };
    },
  };
  ipcMain.handle("resources:state", () => resources.state());
  ipcMain.handle("resources:clear-cache", () => resources.clearCache());

  // Keep: a copy of a page (what was on screen, and its text) so its tab can be closed without losing it (see keep-store.ts).
  const keep = new KeepStore(process.env.DBB_KEEP_DIR || join(app.getPath("userData"), "kept"));
  protocol.handle(KEPT_SCHEME, async (request) => {
    const p = parseKeptUrl(request.url);
    if (!p) return new Response("not found", { status: 404 });
    if (p.file === "page.png") {
      const img = await keep.image(p.id);
      return img ? new Response(new Uint8Array(img), { headers: { "content-type": "image/png", "cache-control": "no-store" } }) : new Response("not found", { status: 404 });
    }
    const g = await keep.get(p.id);
    return g ? new Response(keptPageHtml(g.record, g.text), { headers: { "content-type": "text/html; charset=utf-8" } }) : new Response("This kept copy was removed.", { status: 404 });
  });
  const keepTab = async (o: { tab?: number; reason?: string; close?: boolean; bookmark?: boolean } = {}) => {
    if (callerNet.enabled) return { ok: false, reason: "caller-network-on", message: "Keep is switched off while the caller network is on." };
    const all = getTabs();
    const t = typeof o.tab === "number" ? all.find((x) => x.id === o.tab) : all.find((x) => x.active);
    if (!t) return { ok: false, reason: "no-tab", message: "There is no such tab." };
    if (!/^https?:\/\//i.test(t.url)) return { ok: false, reason: "not-web", message: "Only web pages can be kept." };
    const wc = t.wcId != null ? webContents.fromId(t.wcId) : undefined;
    if (!wc || wc.isDestroyed()) return { ok: false, reason: "no-tab", message: "That tab is not ready." };
    // Never keep a copy of a page with a sign-in form showing (it may hold what someone typed).
    const login = await wc.executeJavaScript("[...document.querySelectorAll('input[type=password]')].some((e) => e.offsetParent !== null)").catch(() => false);
    if (login) return { ok: false, reason: "login", message: "Pages with a sign-in form are not kept." };
    if (!t.active) {
      await askChrome("tab.activate", { id: t.id });
      await new Promise((r) => setTimeout(r, 200)); // let it be drawn before taking the picture
    }
    const img = await wc.capturePage().catch(() => null);
    const png = img && !img.isEmpty() ? img.toPNG() : null;
    const text = String((await wc.executeJavaScript("document.body ? document.body.innerText : ''").catch(() => "")) ?? "");
    let record: KeptRecord = await keep.add({ url: t.url, title: t.title, text, png, ...(o.reason ? { reason: o.reason } : {}) });
    // Also a bookmark on askrobots, and the picture and text in its Files, when connected (a page kept is a page worth finding
    // again, from anywhere). Private, with readable names; the local copy stays either way.
    let bookmarked = false;
    if (o.bookmark !== false && mcp.isLoaded() && mcp.isSignedIn(BOOKMARK_SERVER)) {
      bookmarked = (await bookmarks.add(t.url, t.title)).ok;
      const when = new Date(record.keptAt).toISOString().slice(0, 16).replace("T", " ");
      const description = `Kept from ${record.url} on ${when} UTC: ${record.title}${record.reason ? ` (why: ${record.reason})` : ""}`.slice(0, 500);
      const files: NonNullable<KeptRecord["remote"]>["files"] = [];
      let error: string | undefined;
      const upload = async (kind: "image" | "text", filename: string, body: Buffer) => {
        if (mcp.missingScopes(BOOKMARK_SERVER).includes("files:upload")) {
          error = "saving files was not allowed when you connected; connect again to allow it";
          return;
        }
        try {
          const out = await mcp.callDirect(BOOKMARK_SERVER, "upload_file", { filename, content_base64: body.toString("base64"), description }, { fixed: true });
          let id: string | undefined;
          try {
            const j = JSON.parse(out) as Record<string, unknown>;
            id = typeof j.id === "string" ? j.id : typeof j.file_id === "string" ? j.file_id : undefined;
          } catch {
            /* an answer that is not JSON still means it was saved */
          }
          files.push({ kind, filename, ...(id ? { id } : {}) });
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
      };
      // The server's refusal, said plainly (it comes as {"error": "..."} text).
      const plain = (m: string) => {
        let t = m;
        try {
          const j = JSON.parse(m) as Record<string, unknown>;
          if (typeof j.error === "string") t = j.error;
        } catch {
          /* already text */
        }
        return /not available for this connection|unknown tool|not found/i.test(t) ? "askrobots does not allow saving files for this connection yet (the copy is on this Mac)" : t.slice(0, 200);
      };
      if (png) await upload("image", keptFilename(record, "png"), png);
      const header = `${record.title}\n${record.url}\nKept ${when} UTC${record.reason ? `\nWhy: ${record.reason}` : ""}\n\n`;
      await upload("text", keptFilename(record, "txt"), Buffer.from(header + text, "utf8"));
      record = (await keep.update(record.id, { remote: { files, ...(error ? { error: plain(error) } : {}) } })) ?? record;
    }
    if (o.close !== false) await askChrome("tab.close", { id: t.id }).catch(() => {});
    emit({ kind: "kept", title: record.title, url: record.url, id: record.id, imageBytes: record.imageBytes, textChars: record.textChars });
    return { ok: true, record, view: keptUrl(record.id), bookmarked, closed: o.close !== false };
  };
  ipcMain.handle("keep:tab", (_e, o: unknown) => keepTab((o && typeof o === "object" ? o : {}) as { tab?: number }));
  ipcMain.handle("keep:list", (_e, q: unknown) => keep.list(String(q ?? "")));
  ipcMain.handle("keep:remove", (_e, id: unknown) => keep.remove(String(id ?? "")));

  // The address bar: suggestions from open tabs, saved links and kept copies (all local), and search suggestions from the
  // search site for text that is not an address. Those go without cookies (so they are not tied to your account) and not at
  // all while the caller network is on.
  let keptCache: { at: number; list: Array<{ id: string; url: string; title: string; view: string }> } | null = null;
  ipcMain.handle("omnibox:suggest", async (_e, o: unknown) => {
    const q = (o && typeof o === "object" ? o : {}) as { text?: unknown; tabs?: unknown; activeTab?: unknown; autofill?: unknown };
    const text = String(q.text ?? "").slice(0, 500);
    const tabs: OmniTab[] = (Array.isArray(q.tabs) ? q.tabs : []).slice(0, 300).flatMap((t) => (t && typeof t === "object" && typeof (t as OmniTab).id === "number" ? [{ id: (t as OmniTab).id, url: String((t as OmniTab).url ?? ""), title: String((t as OmniTab).title ?? "") }] : []));
    if (text.trim().startsWith("/")) {
      // "/" commands: the tools of the askrobots sign-in, typed. Nothing is listed or sent without a sign-in.
      if (callerNet.enabled) return { autofill: null, rows: [{ kind: "notice", text: "Commands are off while the caller network is on" }] };
      if (!mcp.isSignedIn(BOOKMARK_SERVER)) return { autofill: null, rows: [{ kind: "notice", text: "Connect askrobots to use / commands", connect: true }] };
      try {
        const rows = commandRows(text, (await mcp.commandTools(BOOKMARK_SERVER)).map((t) => toCommand(t, mcp.fixedArgNames(BOOKMARK_SERVER, t.name))));
        return { autofill: null, rows: rows.length ? rows : [{ kind: "notice", text: `askrobots has no command “${text.trim().split(/\s/)[0]}” for this sign-in` }] };
      } catch (e) {
        return { autofill: null, rows: [{ kind: "notice", text: `Could not list the askrobots commands: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) }] };
      }
    }
    if (!keptCache || Date.now() - keptCache.at > 5000) keptCache = { at: Date.now(), list: (await keep.records()).map((r) => ({ id: r.id, url: r.url, title: r.title, view: keptUrl(r.id) })) };
    const bm = bookmarks.state();
    return suggest({ text, tabs, ...(typeof q.activeTab === "number" ? { activeTab: q.activeTab } : {}), bookmarks: [...bm.items, ...bm.known], kept: keptCache.list, autofill: q.autofill !== false });
  });
  // Run a "/" command you typed. Anything the server says may destroy or change things in a way it does not call harmless
  // asks once more (the second Enter), decided here, not by the window.
  ipcMain.handle("omnibox:run", async (_e, o: unknown) => {
    const q = (o && typeof o === "object" ? o : {}) as { text?: unknown; confirmed?: unknown };
    const p = parseCommand(String(q.text ?? "").slice(0, 5000));
    if (!p || !p.name) return { ok: false, message: "Type a command after /" };
    if (callerNet.enabled) return { ok: false, message: "Commands are off while the caller network is on" };
    if (!mcp.isSignedIn(BOOKMARK_SERVER)) return { ok: false, connect: true, message: "Connect askrobots to use / commands" };
    try {
      const t = (await mcp.commandTools(BOOKMARK_SERVER)).find((x) => x.name === p.name);
      if (!t) return { ok: false, message: `askrobots has no /${p.typed} for this sign-in` };
      const c = toCommand(t, mcp.fixedArgNames(BOOKMARK_SERVER, t.name));
      const a = commandArgs(c, p.rest);
      if ("problem" in a) return { ok: false, message: `/${c.name}: ${a.problem}` };
      if (c.destructive && q.confirmed !== true) return { ok: false, confirm: true, message: `/${c.name} may change or remove things on askrobots. Press Enter again to run it.` };
      const text = await mcp.runCommand(BOOKMARK_SERVER, c.name, a.args);
      emit({ kind: "command", server: BOOKMARK_SERVER, tool: c.name });
      // The answer goes into the chat, where it can be asked about next; the window shows the sentence.
      const d = describeResult(c.name, a.args, text, mcp.origin(BOOKMARK_SERVER), c.readOnly);
      chat.recordCommand({ typed: String(q.text ?? "").trim(), tool: c.name, readOnly: c.readOnly, args: a.args, server: BOOKMARK_SERVER, ...d });
      return { ok: true, name: c.name, readOnly: c.readOnly, sentence: d.sentence, ...(d.page ? { page: d.page } : {}) };
    } catch (e) {
      return { ok: false, message: (e instanceof Error ? e.message : String(e)).slice(0, 500) };
    }
  });
  const SUGGEST_URL = process.env.DBB_SUGGEST_URL || "https://askrobots.com/suggest/opensearch?q=%s";
  const suggestCache = new Map<string, { at: number; list: string[] }>();
  ipcMain.handle("omnibox:remote", async (_e, t: unknown) => {
    const text = String(t ?? "").trim();
    if (callerNet.enabled || !remoteAllowed(text)) return [];
    const key = text.toLowerCase();
    const hit = suggestCache.get(key);
    if (hit && Date.now() - hit.at < 120_000) return hit.list;
    try {
      const res = await fetch(SUGGEST_URL.replace("%s", encodeURIComponent(text)), { headers: { "user-agent": USER_AGENT, accept: "application/x-suggestions+json, application/json" }, credentials: "omit", signal: AbortSignal.timeout(1500) });
      if (!res.ok) return [];
      const list = parseSuggestions((await res.text()).slice(0, 20_000), text);
      if (suggestCache.size > 200) suggestCache.clear();
      suggestCache.set(key, { at: Date.now(), list });
      return list;
    } catch {
      return [];
    }
  });

  // The in-browser chat: a model, the page tools (run in-process, the same methods scripts use) and the person's say.
  const chat = new ChatService({
    getAi: () => aiCfg,
    run: (m, p) => handleControl(controlDeps, m, p),
    toPanel: (e) => mainWindow?.webContents.send("chat:event", e),
    announce: (e) => emit(e),
    callerNetworkOn: () => callerNet.enabled,
    extraTools: () => mcp.toolDefs(),
    consent: async ({ model, where }) => {
      const opts: Electron.MessageBoxOptions = {
        type: "question",
        buttons: ["Send", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        message: `Let the assistant send to ${where}?`,
        detail: `Your messages, and whatever the assistant reads from your open pages (text, field names, addresses), go to ${model} at ${where}. If you have connected services, what the assistant reads from them (for example contacts, notes and tasks) goes there too. It does not list or fill password, card number or one-time-code fields, but visible page text is visible to it. You approve each action before it happens. This question is asked once per model per session.`,
      };
      const r = mainWindow ? await dialog.showMessageBox(mainWindow, opts) : await dialog.showMessageBox(opts);
      return r.response === 0;
    },
  });
  ipcMain.handle("chat:state", () => chat.state());
  ipcMain.handle("chat:send", (_e, text: unknown) => chat.send(String(text ?? "")));
  ipcMain.handle("chat:stop", () => (chat.stop(), true));
  ipcMain.handle("chat:confirm", (_e, id: unknown, ok: unknown) => chat.confirm(String(id), ok === true));
  ipcMain.handle("chat:clear", () => (chat.clear(), true));
  ipcMain.handle("chat:mode", (_e, m: unknown) => chat.setMode(m));
  const controlDeps: ControlDeps = {
        askChrome,
        background,
        focusWindow: () => {
          const w = mainWindow;
          if (!w || background) return; // background mode never raises or focuses the window
          if (w.isMinimized()) w.restore();
          w.show();
          w.focus();
          if (process.platform === "darwin") app.focus({ steal: true });
        },
        vault: vaultSvc,
        eventsSince: (n) => ({ events: eventLog.filter((e) => (e.seq as number) > n), next: eventSeq }),
        contextMenu: {
          last: () => (lastMenu ? { wcId: lastMenu.wcId, items: lastMenu.items } : null),
          pick: (id) => (lastMenu ? lastMenu.run(id) : false),
        },
        getApproval: () => approval,
        setApproval: (p) => {
          approval = p;
          emit({ kind: "approval-changed", mode: p.mode, maxUsd: p.maxUsd });
        },
        reader: async (p) => {
          const r = await reader.open({ wcId: Number(p.wcId), interactive: false, withAi: p.ai !== false, acknowledge: p.acknowledge === true });
          const ai = r.done && p.wait !== false ? await r.done : undefined;
          return { ok: r.ok, reason: r.reason, message: r.message, tab: r.tab, state: r.ai, summary: ai };
        },
        downloads: () => [...downloads.values()],
        getNetPolicy: () => ({ blockWebSockets: netPolicy.blockWebSockets || callerNet.enabled }),
        setNetPolicy: (p) => {
          if (typeof p.websockets === "boolean") netPolicy.blockWebSockets = p.websockets;
          emit({ kind: "net-policy-changed", blockWebSockets: netPolicy.blockWebSockets });
        },
        extensions,
        assertNotCallerNet: refuseWhileCallerNet,
        settle: (ctx, opts) => runSettle({ ...ctx, isWithCaller: (u) => callerNet.isParked(u) }, opts),
        callerNet: {
          state: () => ({ limits: { ...callerNet.limits }, cookies: cookiesPerVisit ? "visit" : "off", enabled: callerNet.enabled, userAgent: callerNet.userAgent, answerTimeoutMs: callerNet.answerTimeoutMs, waiting: callerNet.parkedCount() }),
          configure: configureCallerNet,
          pending: (afterId, waitMs) => callerNet.pending(afterId, waitMs),
          answer: (id, a) => callerNet.answer(id, a as unknown as Answer),
          fail: (id, kind, detail) => callerNet.fail(id, kind, detail),
          // A new visit starts with a clean slate: nothing a previous page left in the session (cookies, localStorage,
          // IndexedDB, caches, service workers) is there, and the page being left drops its sessionStorage. A page that
          // moves ITSELF is the same visit and keeps what it set. (Tabs share one session, so this is meant for one visit at a time.)
          freshVisit: async (wcId) => {
            if (!callerNet.enabled) return;
            callerNet.newVisit();
            const wc = webContents.fromId(wcId);
            try {
              await Promise.race([wc?.executeJavaScript("try { sessionStorage.clear(); } catch {}", false), new Promise((r) => setTimeout(r, 1000))]);
            } catch {
              /* a page that cannot be asked has nothing we can clear */
            }
            // Never let clearing storage hold a visit up for ever: past 8 s the visit goes ahead and the problem is announced.
            const cleared = await Promise.race([session.defaultSession.clearStorageData().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 8000))]);
            if (!cleared) emit({ kind: "visit-clean-slate-timeout", message: "clearing stored data took more than 8 s; the visit started anyway" });
          },
          registerDocument: (doc) => callerNet.registerDocument(doc as unknown as Document),
          noteKnownDocument,
        },
        aiStatus: () => describeAi(aiCfg),
        chat,
        mcp,
        resources,
        bookmarks,
        keep: { tab: keepTab, list: (q: string) => keep.list(q), get: (id: string) => keep.get(id), remove: (id: string) => keep.remove(id) },
        setAiProvider: (p) => (p === "anthropic" || p === "openai" ? setAiProvider(p) : false),
        spent: () => formatUsd(engine.policy.spentUsdMicro()),
        receipts: () => JSON.parse(JSON.stringify(engine.ledger.all(), (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
  };
  if (process.env.DBB_CONTROL === "1" || process.argv.includes("--control")) {
    startControl(controlDeps, { port: Number(process.env.DBB_CONTROL_PORT) || 9777, token: process.env.DBB_CONTROL_TOKEN })
      .then((h) => {
        control = h;
        console.error(`[control] automation API on http://127.0.0.1:${h.port}/rpc — token in ${h.file}`);
        mainWindow?.webContents.send("ctl:status", { port: h.port });
        buildMenu(); // refresh the Help menu's status line
      })
      .catch((e) => console.error("[control] failed to start:", e));
  }
  // Report the engine's real client-hint brands (navigator.userAgentData) to the transport, so the
  // HTTP hints can never disagree with what pages see in JS.
  mainWindow?.webContents.once("dom-ready", () => {
    mainWindow?.webContents
      .executeJavaScript(
        "(() => { const u = navigator.userAgentData; return u ? { brands: u.brands.map((b) => ({ brand: b.brand, version: b.version })), platform: u.platform, mobile: u.mobile } : null; })()",
      )
      .then(setClientHints, () => setClientHints(null));
  });
  ipcMain.on("pref:motion", (_e, m: unknown) => {
    if ((m === "always" || m === "system" || m === "never") && m !== motionPref) {
      motionPref = m;
      buildMenu();
    }
  });
  // Per-request progress for the tab throbbers and status line.
  netEvents.on("event", (e: NetEvent) => mainWindow?.webContents.send("net:event", e));
  mainWindow?.webContents.on("did-finish-load", () => {
    if (control) mainWindow?.webContents.send("ctl:status", { port: control.port });
  });
  // Show the balance on load, then poll — so funding shows up without a restart.
  mainWindow?.webContents.once("did-finish-load", () => void refreshBalance());
  mainWindow?.webContents.once("did-finish-load", () => { if (callerNet.enabled) emit({ kind: "net-provider-changed", enabled: true, answerTimeoutMs: callerNet.answerTimeoutMs }); });
  setInterval(() => void refreshBalance(), 20_000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
