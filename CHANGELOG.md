# Changelog

All notable changes to dbbasic-browser. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Nothing has been released yet, so everything below is under **Unreleased**.

## [Unreleased]

### Added
- **A smarter address bar.** As you type: what Enter will do, open tabs (switch to them), your askrobots bookmarks, kept
  copies, askrobots search suggestions, and "Ask the assistant". Sites you use are completed inline ("slash" →
  slashdot.org, local sites keep their port and http). Suggestions are asked for only for text that is not an address,
  without cookies, and can be switched off. A page loading while you type no longer overwrites what you typed, and ⌘K
  reaches the page even when the address bar has the focus. With askrobots connected, `/` lists the askrobots tools your
  sign-in may use (and the site's short names, `/note`, `/task`, `/search`, `/websearch`); Enter runs one with the rest
  of the line as its argument and shows the answer. Destructive tools ask first; nothing is sent without a sign-in.
- **Keep** (📥 next to the address). One click keeps a copy of the page you are on (a picture of what is on screen, and its
  text), saves it as a bookmark when askrobots is connected and puts the picture and the text in your askrobots Files (private, named
  "<title> (<site>, <date>)"; saving files is its own permission on the consent page, and a server without it still signs
  you in, without that part), and closes the tab, so a tab can go without losing what was in
  it. Kept copies are listed under 🔖 › Kept copies, searched by their text, and open in a tab served by the browser itself
  (text and picture, nothing that runs), even when the original page has changed or gone. Pages with a sign-in form are not
  kept. Local only. The assistant can keep tabs too (with a one-line reason when told). Scriptable as `keep.*`.
- **Bookmarks from askrobots.com.** ☆ next to the address saves the page you are on with one click (no dialog; the star fills
  in), as a private link on askrobots, where the server's entry says saved links go. 🔖 opens the list of your links, newest
  first, loaded from askrobots when the browser opens and when you open the list, and kept as a local copy; searching it
  also searches all your links on askrobots, not only the newest 100. ☆ shows when the page you are on is saved, and when
  another page on the same site is. To know older bookmarks too, the browser asks your askrobots account about the site you
  are on (once every ten minutes per site), and remembers older bookmarks a search turned up; that check is a setting in the
  list, on by default, and sends the site's name to your own account. Tracking parameters (utm_*, fbclid…) do not make a
  saved page look unsaved. The assistant can save a tab as a
  bookmark and close tabs, so it can tidy up for you (both run unasked in Auto mode; in Ask mode each step asks).
- **Tab shortcuts**: ⌘⇧] and ⌘⇧[ switch tabs (as do Ctrl+Tab and ⌘⌥→/←), ⌘1–⌘8 go to that tab and ⌘9 to the last, and ⌘N
  opens a tab (there is one window for now).
- **A reload button** in the toolbar (⌘R as before); while a page is loading it is a Stop button.
- **Resource status** (◔ in the toolbar). Memory and CPU per tab, what the browser costs in total (pages, browser, graphics),
  the cache, and what the data folder is made of, with a Clear cache button and Close per tab; amber when a tab is using over
  800 MB or most of a CPU. On a Mac it reports the physical footprint (Activity Monitor's number, which includes memory the
  system has compressed) rather than resident size, which can hide a tab's real cost. The finished-loading report also names
  which requests failed and which got an error status (addresses without their queries). Scriptable as `resources.*`.
- **Connections to other services (MCP).** Sign in to an MCP server with OAuth (discovery, registration as a public client,
  PKCE, the consent page in a tab of this browser with the redirect caught inside it, quiet refresh, revocation on disconnect) and its tools join the assistant chat. A server adds
  only the tools its entry lists; reads run, everything else asks every time; entries can force arguments and drop result
  fields. Tokens stay in the main process, encrypted by the OS keychain (or in memory with `DBB_MCP_STORE=memory`).
  askrobots.com is built in; more servers go in `mcp-servers.json`. Scriptable as `mcp.*`.
- **Assistant chat** (⌘J). A side panel to talk to an assistant about the page you are on and ask it to read, find, fill in
  and open things, using the browser's own page tools. Every action waits for your OK (or, in Auto mode, everything outside a short
  allow-list asks, and after it has read private data from a connected service typing and opening addresses ask in every mode); password, card and one-time-code fields are never
  filled or listed by value; everything a tool returns is marked as coming from outside (a line saying where, and tags with a random word per conversation so a page cannot forge them) and the assistant is told only your typed messages are instructions. Works with Anthropic, OpenAI, or a model on this
  machine or your network (`DBB_AI_BASE_URL`). Asks before the first message to each model, announces every run in the
  event log, and is off while the caller network is on. Scriptable as `chat.*`.
- **Form tools.** `page.forms` lists a page's fields and buttons (labels, types, options, values) and `page.find` looks
  elements up by their words, label or role. Both return refs that `page.click`, `page.hover` and `page.type` accept; a
  ref to something that has left the page is an error, never a wrong click. Passwords, card and one-time-code fields,
  hidden fields and files are never reported by value.
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
- **Blank-page options** on the finished-loading verdict: `minText` (visible text below this many characters, default 20, makes a page
  "blank"; 0 turns the test off) and `blankWaitMs` (default 0: keep checking for that long, while the page would settle as blank, for text
  or media to appear). A page that stays blank is still reported blank, and the wait is in `waitedMs`.
- **`resources` in the finished-loading verdict**: how much of the page arrived. Counts of requests started, answered (a redirect counts;
  4xx/5xx counted apart), failed with the reasons, cancelled by the page, and still waiting, plus whether the main document was answered or
  failed. `outcome: "ok"` still means only that the main document settled; this makes a half-loaded page visible, which matters to test
  scripts and demo recording as much as to anything driving the browser. A request refused before it started (a limit, a full queue) counts as
  requested and failed. `ERR_UNSAFE_PORT` now classifies as `blocked` (the browser itself refused it).
- **Console and cookie facts** in the finished-loading verdict: console messages counted by level plus the first 20 errors (200 characters
  each, as the page's own text), and the cookies that apply to the final address by name, domain, path and flags, never their values.
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
  It refuses to run on the normal profile (it needs `--user-data-dir`, because it clears stored data at every visit), refuses WebSockets
  and WebRTC while on, and switches off `login`, the reader, payments and refunds, with a visible "Caller network ON" badge. Limits:
  64 requests waiting at once (50 per `net.pending`), and time on the caller is forgiven only up to twice the settle deadline.
  **Known gap:** WebTransport (QUIC) opens connections Electron 45 cannot switch off; a test records it. Deny UDP egress at the
  firewall if that matters.
  `net.provider {limits: {requests, bytes}}` (default none) stops a visit that asks for too much: past a limit the next request fails at once
  with a reason (kind `other`, source `observed`); a response under way is never cut off. While the mode is on, permission prompts,
  downloads and pop-ups are refused (a download is still reported as one, and nothing is written).
  `net.provider {cookies: "visit"}` (default `"off"`: none stored, none sent) keeps cookies for ONE visit: a Set-Cookie in an answer is
  stored in the browser's own cookie store (Chromium applies its rules for Domain, Path, Secure, SameSite and prefixes) before the page
  sees the response, so a site that sets a cookie and redirects back no longer loops; the browser's Cookie header is the only one, third-
  party requests get none, at most 50 cookies of 4 KB per visit, and the next visit starts empty. A page that moves itself more than 20
  times in one visit now ends as a redirect loop.
  `DBB_CALLER_NETWORK_USER_AGENT=<identity>` starts the browser with this mode already on, before any page exists, and the
  wallet balance poll (a request of the browser's own) is skipped while it is on. A one-file example caller, which answers
  requests with a plain HTTP client and prints the verdict, is in `apps/browser/examples/`; by default it refuses private and
  local addresses, caps response size and spaces page loads per host.
- **`npm run build:standalone`** bundles everything except Electron into one folder (`apps/browser/standalone/`), so the app runs
  with just an Electron binary: no `npm install`, no Node version requirement on the machine that runs it.
- **Local extensions** (`DBB_EXTENSIONS=/abs/one.mjs:/abs/two.mjs`): ES modules on this machine that add automation methods, reached as
  `ext.<name>`. Each exports `register(api)` and adds methods with `api.method(name, handler)`; a handler gets the request's parameters and
  `tools.webContents(params)`, the page of a tab without raising the window. They run with the browser's own privileges, load only from
  that environment variable (never from a page, the network or the API), only from absolute local files owned by you and not writable by
  others, and an extension that fails to load stops the browser from starting. `status` shows file names only. Built-in method names
  cannot be replaced, but an extension can use Electron directly, so load only code you trust.
- **Background mode** (`DBB_BACKGROUND=1`): automation that never takes the screen. The window is shown without focus, moved off-screen,
  transparent and click-through (still drawn, unlike a hidden or minimized window), the app stays out of the Dock, and nothing raises or
  focuses it, including real input. The end-to-end suites use it with `E2E_BACKGROUND=1`, and `E2E_PARALLEL=n` runs n suites at once (each its
  own process with its own demo server, ports, profile and vault): the full run of 216 checks takes about 100 seconds at 2 at a time.
- **Pre-push checks** (`git config core.hooksPath .githooks`): refuse a push whose new lines contain a key-shaped secret, then run the type
  check and unit tests; a clone may add its own extra check. The extension surface (a page's host window, painting a page to an image, and
  never raising or focusing the window) is pinned by end-to-end tests with a neutral fixture, so a change to the browser cannot break
  local extensions silently.
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
- **Scripts, styles and fonts from other sites (CDNs) failed to load in CORS mode** (`<script crossorigin>`, `<link crossorigin>`,
  fonts, `fetch` with the default credentials), leaving pages unstyled or without their scripts (YouTube stayed on grey
  placeholder boxes; askrobots' own signed-in pages lost their icons and scripts). The browser always asked for cookies on
  cross-site requests, and a response that says "any site may read this" is refused when the request carried them. Requests now
  follow the page's own credentials setting. Also fixed: a redirect whose own body was `text/plain` with `nosniff` (unpkg's) made
  the browser refuse the script it redirected to.
- A page's web-contents id is now published to the automation API the moment it exists, and the API waits briefly for a
  tab that is listed but not yet addressable, instead of failing right after launch or right after opening a tab.
- **Redirects were followed inside the network layer**, so after a redirect the page showed the destination's content under
  the *original* URL and origin. This broke the address bar and same-origin checks, let a redirect into a paid page skip its
  payment decision, and made askrobots.com's bot check misbehave. Redirects now go back to the page, which re-requests the
  target.
- Requests now carry what a real Chromium sends: a `Referer` (it was missing), client hints that match the page's own
  JavaScript, and correct `Sec-Fetch-*` metadata.
- A `.env` file in whatever folder the browser was started from could set any unset upper-case variable, including the ones that turn on
  the automation API and name its token. It now sets only `X402_*` (the wallet's own settings).
- Going to the address a tab was already on made **two** requests to the site (setting a webview's `src` to its current value
  loads it twice), which also doubled any per-site spacing a caller applies. Explicit navigations now make one.
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
