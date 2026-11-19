# Changelog

All notable changes to dbbasic-browser. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Nothing has been released yet, so everything below is under **Unreleased**.

## [Unreleased]

### Added
- **Tabs.** One page per tab with its own payment inspector; a ⚡ marks tabs that paid. Shortcuts: ⌘T, ⌘W, ⌘L, ⌘R,
  Ctrl+Tab. `target=_blank` links open as tabs.
- **Password manager.** `@dbbasic/vault` is a small, dependency-free encrypted vault (scrypt + AES-256-GCM, exact-origin
  matching) usable on its own as a library and CLI. In the browser: a 🔑 panel, save/update offers after a real login, and
  one-click sign-in. Secrets never enter the browser UI.
- **Automation API** (off unless `DBB_CONTROL=1`; loopback-only, bearer token). Real trusted input, tabs, screenshots,
  waits, vault login without exposing the password, x402 events/spend/receipts, and a payment approval policy
  (`ask` / `auto` up to $N / `deny`). A client lives at `apps/browser/scripts/dbb.mjs`.
- **AI Reader** (📖, ⌘⇧R). A clean reading view of the page with a TL;DR on top. The article is extracted locally with
  Mozilla Readability; only the TL;DR comes from an AI provider (Anthropic by default, OpenAI selectable). Nothing is sent
  without a click and a consent dialog; login pages are never read; every provider call is announced with what was sent and
  what it cost. Keys are read at runtime from outside the repository.
- **Loading indicators.** Thirteen animated states in the tab strip and a status line ("Waiting for…", "Receiving…",
  "Redirecting…", "Paying…", "Summarizing…"), driven by real signals. View ▸ Loading Animations (Follow System / Always /
  Never).
- **Downloads.** Progress in the status line, saved/failed notices, the x402 amount shown for paid downloads,
  File ▸ Show Last Download in Finder, and `downloads.list` in the automation API.
- **Home and search.** New tabs open askrobots.com, and anything typed that isn't an address is searched there. The local
  x402 demo gallery has its own toolbar button.
- **Link addresses on hover.** Pointing at (or tabbing to) a link shows its full address in the status area: green and marked
  "this site" when it stays on the same site, amber and marked "other site" when it leaves. `page.hover` in the automation API.
- **Help menu** and a built-in help page; **File ▸ Open Page in Default Browser** (⌘⇧O); an app icon and a branded dev
  launcher (correct Dock name and icon on macOS).
- **"Has the page finished loading?" signal** in the automation API (`page.settle`, or `settle` on `page.goto`). Instead of a
  timeout it returns a verdict that separates *what ended the wait* (two identical frames, quiet, animating, deadline…) from
  *what happened* (ok, error status with the number, blank, failed and why, bot check, payment required, a download).
  Long-lived streams are ignored, late images and fonts are waited for, and at the deadline it names what was still unmet.
  Also returns facts about the load: final URL, redirect chain, status, requests, bytes and hosts. A page that navigates itself
  after loading (script, meta refresh, link) restarts the wait and is reported in `moves`, separately from server redirects.
- **A network layer the caller supplies** (`net.provider`, `net.pending`, `net.answer`, `net.fail`, `page.load`). While on, the
  browser makes no request of its own: each one is handed to the caller, which answers it or refuses it with a reason. A 3xx
  goes back to the page, so every hop is the caller's decision. The caller's identity is required and the desktop browser's is
  never lent to it. Waiting on the caller is its own state with one caller-set bound; past it the load fails as `caller-silent`
  (not "timed out"), and that wait does not count toward the settle deadline. A failure now says who decided it (`source`:
  `observed` or `caller`). `page.load` takes a main document the caller already fetched, with its final address, status,
  headers and the redirects that led to it. Nothing is retried, remembered, or stored (cookies are the caller's).
  Each new visit (`page.goto`, `page.load`) starts with a clean slate: cookies, localStorage, IndexedDB, caches and service workers
  left by an earlier page are cleared, while a page that moves itself keeps what it set. Tabs share one session, so use one visit
  at a time per browser.
  `DBB_CALLER_NETWORK_USER_AGENT=<identity>` starts the browser with this mode already on, before any page exists, and the
  wallet balance poll (a request of the browser's own) is skipped while it is on. A one-file example caller, which answers
  requests with a plain HTTP client and prints the verdict, is in `apps/browser/examples/`.
- **`npm run build:standalone`** bundles everything except Electron into one folder (`apps/browser/standalone/`), so the app runs
  with just an Electron binary: no `npm install`, no Node version requirement on the machine that runs it.
- **`net.policy {blockWebSockets}`** in the automation API (also `DBB_BLOCK_WEBSOCKETS=1`): refuses WebSockets before any
  connection is opened, since Chromium opens them outside our network layer. Every refusal is announced as an event.
- **End-to-end test suites** (`npm run e2e -w @dbbasic/browser`, 88 checks) that drive the real browser through its own
  automation API, plus 94 unit tests and a test that fails if an API key is ever committed.

### Changed
- **Electron 33.4.11 → 45.4.1** (Chromium 130 → 156). The old line was out of support and flagged high-severity by
  `npm audit`.
- The User-Agent is now Chromium-compatible, without the `Electron/` token, and ends with
  `dbbasic-browser/<version> (+https://dbbasic.com)`. We do not claim to be Firefox or Chrome.
- Development tooling: esbuild 0.21 → 0.28, vitest 2 → 5, and in-range patch updates. `npm audit` reports 0 findings.

### Fixed
- A page's web-contents id is now published to the automation API the moment it exists, and the API waits briefly for a
  tab that is listed but not yet addressable, instead of failing right after launch or right after opening a tab.
- **Redirects were followed inside the network layer**, so after a redirect the page showed the destination's content under
  the *original* URL and origin. This broke the address bar and same-origin checks, let a redirect into a paid page skip its
  payment decision, and made askrobots.com's bot check misbehave. Redirects now go back to the page, which re-requests the
  target.
- Requests now carry what a real Chromium sends: a `Referer` (it was missing), client hints that match the page's own
  JavaScript, and correct `Sec-Fetch-*` metadata.
- After a redirect chain the "finished loading" verdict reported the first hop's status (302) instead of the page's own (200).
  The status now comes from the network layer, which saw every real response.
- Real keyboard input in the automation API now brings the window to the front, so a typed Enter can't be lost because
  something else had focus.

### Security
- Downloaded files are marked with the macOS quarantine attribute, so Gatekeeper vets anything downloaded and then run.
  Electron does not do this itself.
- A hostile download filename such as `../../tmp/x` is neutralized and stays inside the chosen folder (covered by a test).
- The AI Reader treats page text as untrusted: extraction returns plain data only, the reader page is rebuilt from scratch
  under a strict content-security policy, summaries are inserted as text, and a prompt injection inside a page is not obeyed
  (tested against both providers).

### Known limitations
- Some large sites (eBay, measured) refuse embedded-Chromium browsers at the edge. We measured the same 403 with our network
  layer off, with a bare Chrome User-Agent and with a Firefox one, while Firefox on the same network was served. We do not
  try to evade it; use **File ▸ Open Page in Default Browser**.
- DNS, TCP and TLS happen inside Chromium and are not observable, so they appear as "waiting" rather than as separate phases.
- Navigation-timing values such as TTFB read `0` inside pages, because Chromium does not fill them in for responses served
  through a custom protocol handler.
- Tabs are not restored between launches.
