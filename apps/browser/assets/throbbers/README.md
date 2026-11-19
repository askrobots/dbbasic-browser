# Loading animations

Thirteen small looping animations, one for each thing a page load can be doing. The browser shows them
inline in the tab strip and the status line (see `src/chrome.html`).

| State | File | What it means |
|---|---|---|
| connecting | `connecting` | navigation started, no request on the wire yet |
| secure | `secure` | secure handshake |
| waiting | `waiting` | request sent, no response yet |
| receiving | `receiving` | response body arriving |
| redirecting | `redirecting` | following a redirect |
| challenge | `challenge` | a bot check (proof of work) |
| pay-pending | `pay-pending` | x402 payment needed, waiting for the user's yes |
| pay-paying | `pay-paying` | paying |
| pay-settled | `pay-settled` | paid |
| summarizing | `summarizing` | the AI Reader is summarizing |
| slow | `slow` | still waiting, for a long time |
| failed | `failed` | the load failed |
| offline | `offline` | no network |

## Format

Each is one SVG on a 16×16 grid, animated with SMIL as a seamless loop (first and last frame equal).
Ink is `currentColor`; the accent, paid and failed colours are the CSS variables `--throb-accent`,
`--throb-ok` and `--throb-fail` (with defaults), so an inline SVG follows the surrounding theme with no
second file. The tab size is the design size: stroke 1.5 on the 16 grid, so 32 and 64 are the same drawing
larger. Each is about 1 KB.

SMIL clocks start when the SVG is inserted into the document: to restart a state's animation, replace the
element rather than re-setting its attributes. For `prefers-reduced-motion`, call `pauseAnimations()` on the
`<svg>`; every state leaves a readable still.

## Regenerating

```bash
python3 make_throbbers.py --svg-only   # SVGs only; needs nothing
python3 make_throbbers.py              # also APNG/GIF/preview.html; needs Pillow and Playwright's Chromium
```

The extra files the full run writes (`apng/`, `gif/`, `preview.html`, and the fixed-colour `*-dark.svg` /
`*-light.svg`) are git-ignored; they are for use as `<img>` where an inline SVG isn't possible.

## Where the drawings come from

Every shape is written out in `make_throbbers.py` from lines, circles and arcs. No image was traced, imported
or copied, and none is modelled on another browser's throbber or on any company's mark; the subjects are
generic (a padlock, a gear, an hourglass, a coin, a tick, a cross). They were drawn for this project and are
under the project's Apache-2.0 licence.
