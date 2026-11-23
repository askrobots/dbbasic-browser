// Preload: the only bridge between the chrome UI and the main process.
// CommonJS on purpose — preload runs before the ESM app and stays tiny and sandbox-safe.
const { contextBridge, ipcRenderer } = require("electron");

const homepageArg = process.argv.find((a) => a.startsWith("--homepage="));
const homepage = homepageArg ? homepageArg.slice("--homepage=".length) : "";
const wvArg = process.argv.find((a) => a.startsWith("--webview-preload="));
const webviewPreload = wvArg ? wvArg.slice("--webview-preload=".length) : "";
const sub = (channel) => (callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("x402", {
  /** Optional URL to open on startup (from the HOMEPAGE env var), or "". */
  homepage,
  /** file:// URL of the script injected into every page (login detection + fill). */
  webviewPreload,
  /** Password manager. Secrets never cross this bridge — see vault-service.ts. */
  vault: {
    state: () => ipcRenderer.invoke("vault:state"),
    create: (master) => ipcRenderer.invoke("vault:create", master),
    unlock: (master) => ipcRenderer.invoke("vault:unlock", master),
    lock: () => ipcRenderer.invoke("vault:lock"),
    list: (wcId) => ipcRenderer.invoke("vault:list", wcId),
    add: (args) => ipcRenderer.invoke("vault:add", args),
    remove: (id) => ipcRenderer.invoke("vault:remove", id),
    generate: (len) => ipcRenderer.invoke("vault:generate", len),
    accept: (wcId) => ipcRenderer.invoke("vault:accept", wcId),
    dismiss: (wcId) => ipcRenderer.invoke("vault:dismiss", wcId),
    fill: (args) => ipcRenderer.invoke("vault:fill", args),
    onState: sub("vault:state"),
    onOffer: sub("vault:offer"),
  },
  /** Subscribe to payment events (paid / skipped / quoted). Returns an unsubscribe fn. */
  onEvent(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("x402:event", listener);
    return () => ipcRenderer.removeListener("x402:event", listener);
  },
  /** AI Reader. Keys never cross this bridge: only provider/model names. */
  cards: {
    open: (args) => ipcRenderer.invoke("cards:open", args),
  },
  reader: {
    open: (args) => ipcRenderer.invoke("reader:open", args),
    ai: () => ipcRenderer.invoke("reader:ai"),
    setProvider: (p) => ipcRenderer.invoke("reader:provider", p),
  },
  /** The assistant chat. Keys never cross this bridge: only provider and model names. */
  chat: {
    state: () => ipcRenderer.invoke("chat:state"),
    send: (text) => ipcRenderer.invoke("chat:send", text),
    stop: () => ipcRenderer.invoke("chat:stop"),
    confirm: (id, ok) => ipcRenderer.invoke("chat:confirm", id, ok),
    clear: () => ipcRenderer.invoke("chat:clear"),
    setMode: (m) => ipcRenderer.invoke("chat:mode", m),
    setModel: (id) => ipcRenderer.invoke("chat:model", id),
    onEvent: sub("chat:event"),
  },
  /** Keep: copies of pages (image and text), so their tabs can be closed. Local only. */
  keep: {
    tab: (o) => ipcRenderer.invoke("keep:tab", o || {}),
    list: (q) => ipcRenderer.invoke("keep:list", q || ""),
    remove: (id) => ipcRenderer.invoke("keep:remove", id),
  },
  /** Bookmarks: saved links on askrobots. */
  omnibox: {
    suggest: (o) => ipcRenderer.invoke("omnibox:suggest", o || {}),
    remote: (text) => ipcRenderer.invoke("omnibox:remote", String(text || "")),
    run: (text, confirmed) => ipcRenderer.invoke("omnibox:run", { text: String(text || ""), confirmed: confirmed === true }),
  },
  bookmarks: {
    state: () => ipcRenderer.invoke("bookmarks:state"),
    refresh: () => ipcRenderer.invoke("bookmarks:refresh"),
    add: (url, title) => ipcRenderer.invoke("bookmarks:add", url, title),
    search: (q) => ipcRenderer.invoke("bookmarks:search", q),
    check: (url) => ipcRenderer.invoke("bookmarks:check", url),
    setCheck: (on) => ipcRenderer.invoke("bookmarks:set-check", on),
    onChanged: sub("bookmarks:changed"),
  },
  /** Browsing history on the askrobots account (recorded only while signed in, with the history permission). */
  /** Site icons as data: URLs, by host (see favicons.ts). onUpdate gets {host, icon} (icon null: forgotten). */
  favicons: {
    all: () => ipcRenderer.invoke("favicons:all"),
    onUpdate: sub("favicon:update"),
  },
  /** Plugins (style rules from gitstable). Calls answer {ok, value} or {ok: false, error}. */
  plugins: {
    state: () => ipcRenderer.invoke("plugins:state"),
    preview: (source) => ipcRenderer.invoke("plugins:preview", source),
    install: (token) => ipcRenderer.invoke("plugins:install", token),
    enable: (id, on) => ipcRenderer.invoke("plugins:enable", id, on),
    remove: (id) => ipcRenderer.invoke("plugins:remove", id),
    allOff: (off) => ipcRenderer.invoke("plugins:all-off", off),
    onChanged: sub("plugins:changed"),
    /** gitstable's Install button was followed: open Plugins with that release looked up. */
    onOpen: sub("plugins:open"),
  },
  history: {
    state: () => ipcRenderer.invoke("history:state"),
    pause: (on) => ipcRenderer.invoke("history:pause", on),
    open: () => ipcRenderer.invoke("history:open"),
    forget: (scope, target) => ipcRenderer.invoke("history:forget", scope, target),
    never: (target) => ipcRenderer.invoke("history:never", target),
    onChanged: sub("history:changed"),
  },
  /** What the browser is using (memory and CPU per tab, cache, disk). */
  resources: {
    state: () => ipcRenderer.invoke("resources:state"),
    clearCache: () => ipcRenderer.invoke("resources:clear-cache"),
  },
  /** Connections to other services (MCP). Tokens never cross this bridge. */
  mcp: {
    state: () => ipcRenderer.invoke("mcp:state"),
    connect: (id) => ipcRenderer.invoke("mcp:connect", id),
    cancel: (id) => ipcRenderer.invoke("mcp:cancel", id),
    disconnect: (id) => ipcRenderer.invoke("mcp:disconnect", id),
  },
  /** Tell the main process the loading-animation preference (always|system|never) so the menu can show it. */
  reportMotion(mode) {
    ipcRenderer.send("pref:motion", mode);
  },
  /** Per-request network progress: {id,url,type:start|headers|progress|end|redirect|error,...}. */
  onNetEvent: sub("net:event"),
  /** Menu accelerator commands: new | close | focus-url | next | prev | reload. */
  onTabCommand(callback) {
    const listener = (_event, cmd) => callback(cmd);
    ipcRenderer.on("tab:cmd", listener);
    return () => ipcRenderer.removeListener("tab:cmd", listener);
  },
  /** A page asked for a new window (target=_blank / window.open) — open it as a tab. */
  onOpenTab(callback) {
    const listener = (_event, url, opts) => callback(url, opts || {});
    ipcRenderer.on("tab:open", listener);
    return () => ipcRenderer.removeListener("tab:open", listener);
  },
  /** A right-click menu item the chrome does itself: search for the selection, or ask the assistant about it. */
  onMenuAction(callback) {
    const listener = (_event, a) => callback(a);
    ipcRenderer.on("ctx:action", listener);
    return () => ipcRenderer.removeListener("ctx:action", listener);
  },
  /** Automation: main asks the UI to do a tab operation; the handler's return value is the answer. */
  onControl(handler) {
    ipcRenderer.on("ctl:req", async (_e, { id, op, args }) => {
      try {
        ipcRenderer.send("ctl:res", { id, result: await handler(op, args) });
      } catch (e) {
        ipcRenderer.send("ctl:res", { id, error: String((e && e.message) || e) });
      }
    });
  },
  /** Mirror of the tab list for the automation API. */
  syncTabs(list) {
    ipcRenderer.send("tabs:sync", list);
  },
  /** Fires when the automation API is listening ({port}). */
  onControlStatus(callback) {
    ipcRenderer.on("ctl:status", (_e, payload) => callback(payload));
  },
  /** Current window spend, formatted. */
  spent() {
    return ipcRenderer.invoke("x402:spent");
  },
  /** All receipts in the ledger. */
  receipts() {
    return ipcRenderer.invoke("x402:receipts");
  },
  /** Subscribe to wallet balance updates ({usdc, address}). */
  onBalance(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("x402:balance", listener);
    return () => ipcRenderer.removeListener("x402:balance", listener);
  },
  /** The wallet address ({address}). */
  wallet() {
    return ipcRenderer.invoke("x402:wallet");
  },
  /** Open an http(s) URL in the operating system's default browser. */
  openExternal(url) {
    return ipcRenderer.invoke("x402:open-external", url);
  },
  /** Copy text to the clipboard. */
  copy(text) {
    return ipcRenderer.invoke("x402:copy", text);
  },
  /** Copy the address and open the faucet in the OS browser. */
  fund() {
    return ipcRenderer.invoke("x402:fund");
  },
  /** Refund the merchant wallet back to the buyer ({tx} or {error}). */
  refund() {
    return ipcRenderer.invoke("x402:refund");
  },
});
