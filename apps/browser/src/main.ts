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

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, net, protocol } from "electron";
import { privateKeyToAccount } from "viem/accounts";
import { PolicyEngine, Ledger, X402Engine, formatUsd } from "@dbbasic/x402-engine";
import { bypassingFetch, createPaymentHandler } from "./intercept.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// TEST KEY ONLY — never fund. Replaced by the session hot wallet task.
const TEST_KEY = (process.env.X402_PRIVATE_KEY ??
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d") as `0x${string}`;

let mainWindow: BrowserWindow | null = null;

function buildEngine(): X402Engine {
  const account = privateKeyToAccount(TEST_KEY);
  const policy = new PolicyEngine();
  const ledger = new Ledger();

  // The engine's own network calls must bypass our protocol.handle('https') or they
  // loop back into us forever. This is the single most important wiring detail here.
  const rawFetch = bypassingFetch((input) =>
    net.fetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body as ReadableStream | null,
      // @ts-expect-error duplex required by undici for streamed bodies
      duplex: input.body ? "half" : undefined,
      bypassCustomProtocolHandlers: true,
    }),
  );

  return new X402Engine({
    account,
    policy,
    ledger,
    fetchImpl: rawFetch as typeof fetch,
    approve: async ({ quote, resourceUrl, reason }) => {
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
      if (e.type === "paid") {
        const r = e.receipt;
        mainWindow?.webContents.send("x402:event", {
          kind: "paid",
          amount: formatUsd(r.priceUsdMicro),
          asset: r.assetSymbol,
          dest: r.destOrigin,
          status: r.status,
          tx: r.txHash ?? null,
          totalSpent: formatUsd(policy.spentUsdMicro()),
        });
      } else if (e.type === "skipped") {
        mainWindow?.webContents.send("x402:event", { kind: "skipped", resource: e.resourceUrl, reason: e.reason });
      } else if (e.type === "quoted" && e.quotes.length > 0) {
        // Price-before-paying: the 402 itself is free, so we can always tell the user
        // the cost before any payment is made.
        const cheapest = e.quotes.reduce((a, b) => (b.priceUsdMicro < a.priceUsdMicro ? b : a));
        mainWindow?.webContents.send("x402:event", {
          kind: "quoted",
          resource: e.resourceUrl,
          price: formatUsd(cheapest.priceUsdMicro),
          asset: cheapest.assetSymbol,
        });
      }
    },
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      webviewTag: true, // the page renders in a <webview>; chrome is the host document
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(join(__dirname, "chrome.html"));
  mainWindow.on("closed", () => (mainWindow = null));
}

app.whenReady().then(() => {
  const engine = buildEngine();

  // Take over https AND http. From here, every request the browser makes is
  // paid-aware. x402 works over plain http too (the spec is transport-agnostic), and
  // it's what lets a local http demo exercise the same path as a real https site.
  const payHandler = createPaymentHandler(engine);
  protocol.handle("https", payHandler);
  protocol.handle("http", payHandler);

  ipcMain.handle("x402:receipts", () => engine.ledger.all());
  ipcMain.handle("x402:spent", () => formatUsd(engine.policy.spentUsdMicro()));

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
