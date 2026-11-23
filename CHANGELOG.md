# Changelog

All notable changes to dbbasic-browser. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are the year and month of the release and a count from 1: **2026.11v1** is the first release of November 2026,
then 2026.11v2, and 2026.12v1 is the first of December. (package.json spells it 2026.11.1, as semver requires.)

## [Unreleased]

### Added
- **Plugins, starting with style rules.** **Tools ▸ Plugins** installs a style rule from gitstable.com: type its
  repository (owner/name), look it up, and the browser says which sites it changes before you install it. A style rule
  only changes how its sites look: CSS that could load or send anything (`url()`, `@import`, fonts, image sets, escapes)
  is refused, and plugins asking for anything else are refused too. It installs from a release tag at the exact commit
  the tag points to; every file is checked against its git blob id, and checked again at every start, so a copy changed
  on this computer is switched off. Rules apply at once to open pages; one switch turns them all off to see sites as
  they are; each can be switched off, updated or removed. **Plugins** in the status bar is always there and opens the
  panel; on a page a plugin is changing, it names that plugin instead (or says it is off). On a plugin's own page on
  gitstable.com it offers **Install** (or **Update**): one click looks the plugin up in the panel, and you press Install.
  The browser fetches gitstable's list of plugins for this only while you are on gitstable.com, at most every five minutes,
  or every minute on a plugin's own page, so a release made minutes ago is offered there. A plugin's name alone
  (`x-whole-window`) also works in the look-up box: it is found among the installed plugins or in gitstable's list.
  A gitstable page opened with `?install=owner/repository@version` (an Install button there) opens Plugins with that
  release looked up, for plugins in gitstable's list only; Install is still your click. None are applied while the caller network is on, or when the
  browser is started with `DBB_SAFE_MODE=1`. Ask the assistant to change how a page looks and it points you to Plugins
  (it can't write one itself yet), not to extensions made for other browsers.

- **View rules: a second kind of plugin, and card views.** A view rule names, by CSS selectors only, where a site keeps
  its posts. Installed from gitstable like a style rule, it adds a button to the status bar on its sites (its label and
  one of a few icons the browser draws: cards, grid, list, columns); the button shows the page's posts as dense cards
  in a tab of the browser's own, many at once and laid out as masonry with no gaps, newest across the top. The browser
  reads the posts itself, in a separate world the page can't reach, and scrolls the tab a few screens at a reading pace
  to gather more; **More posts** reads further, showing the site's tab for the few seconds it scrolls, and adds a new
  block below. Posts marked as ads are set aside behind a line that says how many; long posts are cut to ten lines.
  The card page has no scripts and sends nothing anywhere; each card links to the post. A view rule can't run code,
  change the page or send anything, and asking for more than plain text and addresses is refused. Nothing is built in:
  for X, install `askrobots/x-cards`. The assistant can open a card view too, where one is installed. Plugin level 2
  (view rules need it).

### Fixed
- **Cookies on requests to other sites.** Since 2026-11-20 the browser sent no cookies on any request to another
  origin: clicked links, frames, images and a page's own calls to its API on another subdomain. A form that answers with
  a redirect to another site, such as an OAuth **Authorize** button, failed outright (`ERR_INVALID_ARGUMENT`). Navigations,
  plain loads and a page's fetches carry cookies again; only loads made with an Origin header (`crossorigin` scripts,
  styles and fonts) stay without them on other origins, which keeps CDN scripts and fonts loading.

## [2026.11v1] - 2026-11-23

### Added
- **A version number: 2026.11v1**, the year and month of the release and a count. It is in **Help ▸ Version**, the About
  panel and the browser's User-Agent (`dbbasic-browser/2026.11v1`). Plugins will get a separate interface level
  (starting at 1) that goes up only when what a plugin can rely on changes.
- **Site icons (favicons)** in the tabs, the address bar's suggestions and the bookmarks and kept panels, so you can
  spot a site at a glance. Each site's icon is fetched once, from the first of its pages you open, without cookies and
  outside the payment handler, and kept on this computer in a file only you can read (looked at again after a week).
  Typing fetches nothing; no icons while the caller network is on or for sites on the never-record list; forgetting a site
  forgets its icon. The browser window only shows icons as data, never loading anything from a site itself.
- **The address bar suggests pages from your history**, next to open tabs, saved links and kept copies: type a few words
  of a page's title or address. History from all your computers is suggested, since it lives on your askrobots account.
  The browser keeps a copy of the list here (addresses, titles and times, never the pages' text, in a file only you can
  read), so typing sends nothing anywhere. It is kept up to date when the browser opens, after visits are sent and every
  five minutes; a page forgotten on any computer goes from the suggestions; signing out deletes the copy.
- **⌘← and ⌘→ go back and forward** (Alt+← and Alt+→ on Linux and Windows), from the page or the browser's own
  window, as in other browsers. Never inside a text field, where they move the cursor, and not when the page uses the key
  itself.
- **History, on your askrobots account.** While you are signed in to askrobots, each page you visit is kept with its
  address, title, time, how long you stayed and its visible text, so you can find it later by a few words you remember.
  Never recorded: sign-in and payment pages (by address, title or a showing password field), this machine and the private
  network, glances under two seconds, sites you said never to record, and anything while paused or while the caller
  network is on. Addresses lose their fragment and query parameters, except the few that identify the page (YouTube's
  video, a Hacker News item). A **History** button in the status bar pauses and resumes; a **History** menu forgets this
  page, this site or the last hour, never records a site again, and opens your history on askrobots.com (⌘Y). The
  assistant can search history ("where did I see…?") but asks every time, since the results go to its AI; it can never
  record or forget. Pages waiting to be sent stay in memory and are dropped on sign-out or a new sign-in, so they never
  reach another account. Needs the new `history` permission: connect to askrobots again.
- **Pick the assistant's model** at the top of its panel: Haiku, Sonnet, Opus or Fable (with each one's cost next to
  Haiku's), or the OpenAI or local model you have set up. The choice is remembered. The assistant now defaults to Sonnet
  5.5, because Haiku asked needless questions and missed the obvious; the reader's quick summaries stay on the small
  model. The assistant is also told today's date, and treats "this" and "that" as the page you have open.
  Approvals for askrobots now say what will happen in words ("Add a task on askrobots.com:") with every field on its
  own line, in full; adding a task, note, comment or link is no longer marked risky (changing a task still is). Web
  addresses in the assistant's replies are links. Before adding a task it looks for one that already covers it.
- **The assistant does more on askrobots.** It can add tasks ("add a task to check this out when I'm nearby"), comment
  on and update them, add notes, articles and contacts, start and stop the time tracker, and read your articles. Like
  saving a link, every change is asked about before it is sent, even in Auto mode; notes and articles are always private.
  Still left out on purpose: sending or reading mail, deleting, money, approving or cancelling tasks, running code, paid
  image generation, anything public, and rewriting whole articles. A personal `mcp-servers.json` entry for askrobots
  replaces the built-in tool list, so copy the new names into its `tools` to get them there too.
- **A right-click menu.** On a link: Open Link in New Tab, Copy Link Address. On an image: open, copy, copy address,
  save. On selected text: Copy, Search askrobots for it, Ask the Assistant About This (the text goes into the chat box;
  nothing is sent on its own). In a text field: spelling suggestions, Undo, Redo, Cut, Copy, Paste, Select All. Elsewhere:
  Back, Forward, Reload. Inspect Element on pages. The address bar and chat box get the text items. ⌘-click (Ctrl+click
  off a Mac) and middle-click now open a link in a tab behind the page you are on. The automation API can read the last
  menu and pick an item (`menu.last`, `menu.pick`).
- **Drawn toolbar icons** in place of emoji (Keep, Save, Bookmarks, Chat, Reader, Passwords, x402, back, forward, new
  tab, stop). Emoji depend on the installed font, look different on every Linux machine and sometimes show as empty boxes;
  these are small SVGs drawn for the project (assets/icons) that follow the theme.
- **Linux in CI.** The end-to-end suite runs on Ubuntu 24.04 under a virtual display, with the page sandbox on.
  `scripts/linux-sandbox.sh` lets Chromium's sandbox start on systems that restrict user namespaces (Ubuntu 24.04 and
  later) by loading an AppArmor profile for the Electron binary only, so `--no-sandbox` is never needed.
- **Find in page** (⌘F, Edit ▸ Find). A find bar over the page with a match count, Enter / ⇧Enter and ⌘G / ⌘⇧G for
  next and previous, and Esc to close with the match left selected. Each tab keeps its own search, and a page that
  loads under an open bar is searched again. It uses the page's own find: nothing leaves the machine.
- **A smarter address bar.** As you type: what Enter will do, open tabs (switch to them), your askrobots bookmarks, kept
  copies, askrobots search suggestions, and "Ask the assistant". Sites you use are completed inline ("slash" →
  slashdot.org, local sites keep their port and http). Suggestions are asked for only for text that is not an address,
  without cookies, and can be switched off. A page loading while you type no longer overwrites what you typed, and ⌘K
  reaches the page even when the address bar has the focus. With askrobots connected, `/` lists the askrobots tools your
  sign-in may use (and the site's short names, `/note`, `/task`, `/search`, `/websearch`); Enter runs one with the rest
  of the line as its argument. The command and its answer go into the chat, so you can ask about them next: a save
  says what was saved, with Open for its askrobots page; a search or list opens the chat with each thing found linked.
  Destructive tools ask first; nothing is sent without a sign-in.
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
- **A status bar, words on the buttons, and everything in the menu bar.** What the browser is using and spending (memory,
  the x402 inspector, wallet, Fund, paid this session) moved from the toolbar to a status bar along the bottom, with the
  page's status and the link you point at on its left. Toolbar buttons say what they do (Keep, Save, Bookmarks, Chat,
  Reader, Passwords), down to icons in a narrow window. New Go, Bookmarks and Tools menus hold every feature, with
  ⌘[ / ⌘] for back and forward, ⌘D to save a bookmark and ⌘⇧B for the list.
- **The assistant remembers having read your private data.** Once a message (or a command you ran) has brought in something
  from your accounts, later messages in the same conversation still ask before anything that could carry it out of the
  browser, in any mode, until you clear the conversation. Before, each message started fresh.
- **Electron 33.4.11 → 45.4.1** (Chromium 130 → 156). The old line was out of support and flagged high-severity by
  `npm audit`.
- The User-Agent is now Chromium-compatible, without the `Electron/` token, and ends with
  `dbbasic-browser/<version> (+https://dbbasic.com)`. We do not claim to be Firefox or Chrome.
- Development tooling: esbuild 0.21 → 0.28, vitest 2 → 5, and in-range patch updates. `npm audit` reports 0 findings.

### Fixed
- **A link that opens a new tab now gives that page the keyboard**, so the space bar scrolls it or pauses its video
  straight away. The address bar took the focus instead, as if the tab were empty, and you had to click the page first.
  Switching to a tab gives its page the keyboard too, except while you are typing in the browser's own fields.
- **The assistant took back correct work mid-task** ("I need to correct myself: I never read the article"). To save
  space it shortens older tool results, and that included the page it was working from, so by its reply it thought it
  had made things up. The latest page read now stays whole, and a shortened result says it was seen in full.
- **Tab keys work whatever page has the focus.** A page that swallows keys (an editor, a site with its own shortcuts)
  could stop ⌘⇧] / ⌘⇧[ from switching tabs until you clicked the tab bar. The browser's own keys (⌘⇧] ⌘⇧[, Ctrl+Tab,
  ⌘1–⌘9, ⌘T, ⌘W, ⌘L) are now caught before the page sees them, as in other browsers. The reload button is the size of
  back and forward.
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
