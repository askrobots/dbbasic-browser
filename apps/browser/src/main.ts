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
      // One structured event stream drives both the toolbar (meter/toasts) and the
      // per-tab inspector. All bigints are pre-formatted so IPC stays plain JSON.
      const send = (payload: Record<string, unknown>) =>
        mainWindow?.webContents.send("x402:event", payload);

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
      } else if (e.type === "skipped") {
        send({ kind: "skipped", resource: e.resourceUrl, reason: e.reason });
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
      additionalArguments: [`--homepage=${process.env.HOMEPAGE ?? ""}`],
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
