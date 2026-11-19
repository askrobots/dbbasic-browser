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
- **Help menu** and a built-in help page; **File ▸ Open Page in Default Browser** (⌘⇧O); an app icon and a branded dev
  launcher (correct Dock name and icon on macOS).
- **End-to-end test suites** (`npm run e2e -w @dbbasic/browser`, 88 checks) that drive the real browser through its own
  automation API, plus 94 unit tests and a test that fails if an API key is ever committed.

### Changed
- **Electron 33.4.11 → 45.4.1** (Chromium 130 → 156). The old line was out of support and flagged high-severity by
  `npm audit`.
- The User-Agent is now Chromium-compatible, without the `Electron/` token, and ends with
  `dbbasic-browser/<version> (+https://dbbasic.com)`. We do not claim to be Firefox or Chrome.
- Development tooling: esbuild 0.21 → 0.28, vitest 2 → 5, and in-range patch updates. `npm audit` reports 0 findings.

### Fixed
- **Redirects were followed inside the network layer**, so after a redirect the page showed the destination's content under
  the *original* URL and origin. This broke the address bar and same-origin checks, let a redirect into a paid page skip its
  payment decision, and made askrobots.com's bot check misbehave. Redirects now go back to the page, which re-requests the
  target.
- Requests now carry what a real Chromium sends: a `Referer` (it was missing), client hints that match the page's own
  JavaScript, and correct `Sec-Fetch-*` metadata.
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
