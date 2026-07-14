#!/usr/bin/env node
/**
 * `x402-proxy` — run the payment proxy on 127.0.0.1:8402.
 *
 * Uses a throwaway test key by default; wire a real signer (session hot wallet) once
 * that task lands. Prints where to trust the root CA so https interception works.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { privateKeyToAccount } from "viem/accounts";
import { PolicyEngine, Ledger, X402Engine, formatUsd } from "@dbbasic/x402-engine";
import { X402Proxy } from "./server.js";

const PORT = Number(process.env.X402_PROXY_PORT) || 8402;

// TEST KEY ONLY. Never fund this. Replaced by the session hot wallet task.
const TEST_KEY = (process.env.X402_PRIVATE_KEY ??
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d") as `0x${string}`;

const account = privateKeyToAccount(TEST_KEY);
const policy = new PolicyEngine();
const ledger = new Ledger();

const engine = new X402Engine({
  account,
  policy,
  ledger,
  approve: async (req) => {
    // Headless: anything needing a prompt is refused. The browser wires a real UI here.
    console.log(`[x402] prompt required, refusing (headless): ${req.reason}`);
    return false;
  },
  onEvent: (e) => {
    if (e.type === "paid") {
      const r = e.receipt;
      console.log(`[x402] paid ${formatUsd(r.priceUsdMicro)} ${r.assetSymbol} -> ${r.destOrigin} (${r.status}${r.txHash ? " " + r.txHash : ""})`);
    } else if (e.type === "skipped") {
      console.log(`[x402] skipped ${e.resourceUrl}: ${e.reason}`);
    }
  },
});

const proxy = new X402Proxy({
  engine,
  onError: (err, url) => console.error(`[x402] error ${url}: ${String(err)}`),
});

const caPath = join(homedir(), ".dbbasic-browser", "ca-cert.pem");

proxy.listen(PORT).then(({ host, port }) => {
  console.log(`x402 proxy on http://${host}:${port}`);
  console.log(`signer: ${account.address} (TEST KEY — do not fund)`);
  console.log(`spent this window: ${formatUsd(policy.spentUsdMicro())}`);
  console.log("");
  console.log("To intercept https, trust the root CA once:");
  console.log(`  macOS:  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${caPath}`);
  console.log("Then point a client at the proxy:");
  console.log(`  curl -x http://${host}:${port} --cacert ${caPath} https://<x402-url>`);
});

process.on("SIGINT", async () => {
  console.log(`\nfinal spend: ${formatUsd(policy.spentUsdMicro())}, receipts: ${ledger.all().length}`);
  await proxy.close();
  process.exit(0);
});
