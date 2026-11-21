# Toolbar icons

Drawn icons for the toolbar buttons, in place of emoji: emoji depend on the installed font, look different on
every Linux machine, and some show as empty boxes. These look the same everywhere and follow the theme.

| Icon | File | Button |
|---|---|---|
| keep | `keep` | `keepBtn` Keep: keep a copy of this page and close the tab |
| save / saved | `save`, `saved` | `starBtn`: outline before, filled after |
| bookmarks | `bookmarks` | `bmBtn` Bookmarks |
| chat | `chat` | `chatBtn` Chat |
| reader | `reader` | `readerBtn` Reader |
| passwords | `passwords` | `keyBtn` Passwords |
| x402 | `x402` | `inspectBtn` the payments inspector |
| tests | `tests` | `galleryBtn` x402 tests (dev) |
| tour | `tour` | `tourBtn` Tour (dev) |
| back / forward | `back`, `forward` | back / fwd |
| new tab | `new-tab` | newTab |
| stop | `stop` | stop loading; pairs with the reload icon already in `src/chrome.html` |

## Format

Each is one static SVG on a 16×16 grid, drawn from lines, circles and arcs in `make_icons.py`; nothing is
traced from or modelled on another browser's or company's icons. The stroke is 1.8 with round caps and joins,
the same as the reload icon in `src/chrome.html`, so the toolbar reads as one set. Ink is `currentColor`, so an
inline SVG follows the surrounding theme. The only colour is the filled `saved` star, through the CSS variable
`--icon-accent` (default `#f5b301`). Each file is about 300–450 bytes.

`preview.html` shows every icon at 16 and 32 px on dark and light backgrounds, plus a toolbar mock-up next to
the existing reload icon.

## Regenerating

```bash
python3 make_icons.py      # writes svg/ and preview.html; needs nothing but Python 3
```

Apache-2.0, like the rest of the browser.
