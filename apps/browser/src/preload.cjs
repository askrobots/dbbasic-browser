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
  /** Menu accelerator commands: new | close | focus-url | next | prev | reload. */
  onTabCommand(callback) {
    const listener = (_event, cmd) => callback(cmd);
    ipcRenderer.on("tab:cmd", listener);
    return () => ipcRenderer.removeListener("tab:cmd", listener);
  },
  /** A page asked for a new window (target=_blank / window.open) — open it as a tab. */
  onOpenTab(callback) {
    const listener = (_event, url) => callback(url);
    ipcRenderer.on("tab:open", listener);
    return () => ipcRenderer.removeListener("tab:open", listener);
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
