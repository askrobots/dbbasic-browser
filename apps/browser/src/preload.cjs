// Preload: the only bridge between the chrome UI and the main process.
// CommonJS on purpose — preload runs before the ESM app and stays tiny and sandbox-safe.
const { contextBridge, ipcRenderer } = require("electron");

const homepageArg = process.argv.find((a) => a.startsWith("--homepage="));
const homepage = homepageArg ? homepageArg.slice("--homepage=".length) : "";

contextBridge.exposeInMainWorld("x402", {
  /** Optional URL to open on startup (from the HOMEPAGE env var), or "". */
  homepage,
  /** Subscribe to payment events (paid / skipped / quoted). Returns an unsubscribe fn. */
  onEvent(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("x402:event", listener);
    return () => ipcRenderer.removeListener("x402:event", listener);
  },
  /** Current window spend, formatted. */
  spent() {
    return ipcRenderer.invoke("x402:spent");
  },
  /** All receipts in the ledger. */
  receipts() {
    return ipcRenderer.invoke("x402:receipts");
  },
});
