# dbbasic-browser

A browser with first-class [x402](https://x402.org) support — pay for web resources
in stablecoins, transparently, at machine speed. Point it at a page that returns
`402 Payment Required` and it reads the price, pays, and shows you the content. No
popup, no API key, no subscription.

> **Status: early.** The engine, a local proxy, and an Electron shell all work and are
> tested end to end against a mock origin. It has **not** yet moved real money on-chain
> — settlement is stubbed pending a hardware-isolated wallet and a live facilitator
> round trip. Do not point it at mainnet with real funds yet. See [Status](#status).

---

## Why this is a browser, not an extension

x402 needs one specific thing from a browser: when a request returns `402`, something
must inspect the challenge, perform an **async** signature, re-issue the request with a
payment header, and hand the second response back to the page as if it were the first.

A Manifest V3 extension **cannot do this.** MV3 removed blocking `webRequest`, and its
replacement is declarative — it can't pause a subresource, await a signature, and
resume. Transparent payment for arbitrary subresources requires owning the network
stack. A browser (via Electron's `protocol.handle`) or a local proxy can; an extension
can't. That's the whole reason this project exists as a browser.

## The design principle: don't trust the server you're paying

The interesting engineering here isn't the payment handshake (that's ~200 lines). It's
that **the resource server is not trusted** to describe its own payment. A naive x402
client takes three things straight from the 402 response and signs against them:

1. **The EIP-712 domain** (`name`/`version`) it signs over — so the party being paid
   chooses what your wallet attests to.
2. **The asset**, an arbitrary token address — so without pinned decimals a client
   can't actually tell whether `amount: 100000000` is ten cents or a hundred dollars.
3. **The authorization lifetime** (`maxTimeoutSeconds`) — so a server can request a
   year-long window, bank your signed authorization, and settle it whenever it likes.

dbbasic-browser refuses all three:

- A **pinned asset registry** ([`assets.ts`](packages/engine/src/assets.ts)) is the
  root of trust. The EIP-712 domain and decimals come from our table, never the
  server's `extra`. An asset we can't price is an asset we won't pay.
- The authorization lifetime is **clamped** (default 120s), regardless of what the
  server asks.
- Because EIP-3009 is signature-based, exposure equals exactly what you sign — so the
  **signing policy is the security boundary**. Budgets are scoped to
  *(the page you're looking at × the origin being paid)* and rate-limited, not just
  amount-limited. A hostile page firing 1,000 sub-cent 402s hits the rate cap, not your
  balance. Every one of these is covered by a test.

## Monorepo layout

```
packages/engine/   @dbbasic/x402-engine   the payment engine — no UI, no Electron
packages/proxy/    @dbbasic/x402-proxy     a local proxy: any browser/agent, port 8402
apps/browser/      @dbbasic/browser        the Electron browser
```

The engine depends on nothing but `fetch`. The proxy and the browser are thin adapters
over it, so the payment path a human's browser takes is byte-for-byte the one an agent
or a curl-through-the-proxy takes — and all of it is testable headlessly.

## Quickstart

Requires Node 20+.

```bash
npm install          # installs all workspaces
npm test             # runs the engine, proxy, and browser test suites
```

**See it pay, in a real browser window:**

```bash
# terminal 1 — a local x402-gated "room" (real 402 on the wire, mock settlement)
node apps/browser/demo/x402-demo-server.mjs

# terminal 2 — build and launch the browser
npm run build   -w @dbbasic/browser
npm start       -w @dbbasic/browser
```

Type `127.0.0.1:8899` into the address bar. dbbasic-browser auto-pays $0.05 in USDC and
drops you straight into the room; the spend meter in the toolbar ticks up.

Now open the **same URL in a normal browser.** It can't pay, so it renders the 402's
human fallback body: a checkout card with Apple Pay, MetaMask, and a QR to scan. Same
server, same URL — one browser shows a payment card, the other shows the content. That
contrast is the entire pitch: with x402 in the browser, the checkout screen disappears.

**Or use the proxy with any browser or agent:**

```bash
npm start -w @dbbasic/x402-proxy      # listens on 127.0.0.1:8402
curl -x http://127.0.0.1:8402 http://127.0.0.1:8899/
```

## Status

Works and is tested (against a mock origin): the engine, the proxy (HTTP + HTTPS via a
local MITM CA), and the Electron shell (`protocol.handle` interception, native approval
dialog that shows the price before signing, live spend meter).

Not done yet:

- **No real wallet.** Signs with a public test key. A session hot wallet (OS keychain,
  auto-funded, isolated from main funds) is next.
- **Settlement is stubbed.** No live facilitator round trip yet — a Base Sepolia
  `verify`/`settle` is the first time real money would move.
- **EVM only.** Solana (`exact` SVM) is not implemented.
- **USDC price is hardcoded at $1.** Fine for USDC, wrong for EURC or anything
  non-pegged — needs a real FX source.

## Security

This software terminates TLS (in the proxy) and signs payment authorizations. Read
[SECURITY.md](SECURITY.md) before running it against anything real.

## License

See [LICENSE](LICENSE).
