# SPDX-License-Identifier: Apache-2.0
"""Toolbar icons for the browser's chrome: drawn here from lines, circles and arcs, nothing traced or copied.

    python3 make_icons.py            writes svg/ and preview.html beside this file (needs nothing but Python 3)

Each icon is one static SVG on a 16x16 grid with the same stroke as the reload icon in src/chrome.html (1.8,
round caps and joins), so the whole toolbar reads as one set. Ink is currentColor, so an inline SVG follows the
theme; the only colour is the filled "saved" star, through --icon-accent (default amber). Emoji looked different
on every Linux font setup, and some showed as empty boxes; these look the same everywhere.
"""
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
STROKE = 1.8                      # the reload icon's weight, kept for the whole set
ACCENT = '#f5b301'


def f(x):
    return f'{x:.2f}'.rstrip('0').rstrip('.')


def star(cx, cy, outer, inner):
    """A five-pointed star as a closed path, point up."""
    pts = []
    for i in range(10):
        r = outer if i % 2 == 0 else inner
        a = -math.pi / 2 + i * math.pi / 5
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return 'M' + ' L'.join(f'{f(x)} {f(y)}' for x, y in pts) + ' Z'


STAR = star(8, 8.6, 6.4, 2.75)

# name -> (button and what it does, svg body drawn with stroke=currentColor)
ICONS = {
    'keep': ('keepBtn "Keep": keep a copy of this page and close the tab',
             '<path d="M8 1.8 V9"/><path d="M5 6.2 L8 9.2 L11 6.2"/>'
             '<path d="M2.2 9.6 V12.6 A1.4 1.4 0 0 0 3.6 14 H12.4 A1.4 1.4 0 0 0 13.8 12.6 V9.6"/>'),
    'save': ('starBtn "Save": not saved yet', f'<path d="{STAR}"/>'),
    'saved': ('starBtn "Saved": saved (filled with --icon-accent)',
              f'<path d="{STAR}" style="fill:var(--icon-accent,{ACCENT});stroke:var(--icon-accent,{ACCENT})"/>'),
    'bookmarks': ('bmBtn "Bookmarks": the bookmarks panel',
                  '<path d="M4.2 2 H11.8 V14 L8 11 L4.2 14 Z"/><path d="M6.4 5.2 H9.6"/>'),
    'chat': ('chatBtn "Chat": the assistant chat',
             '<path d="M4 2.6 H12 A2 2 0 0 1 14 4.6 V9 A2 2 0 0 1 12 11 H8.4 L5.2 13.6 V11 H4 A2 2 0 0 1 2 9 V4.6 '
             'A2 2 0 0 1 4 2.6 Z"/>'),
    'reader': ('readerBtn "Reader": the AI reading view',
               '<path d="M8 4 C6.4 2.9 4.4 2.6 1.9 3 V12.6 C4.4 12.2 6.4 12.5 8 13.6 C9.6 12.5 11.6 12.2 14.1 12.6 '
               'V3 C11.6 2.6 9.6 2.9 8 4 Z"/><path d="M8 4 V13.6"/>'),
    'passwords': ('keyBtn "Passwords": saved passwords',
                  '<circle cx="5.1" cy="10.9" r="3"/><path d="M7.2 8.8 L13.8 2.2"/><path d="M11.4 4.6 L13.2 6.4"/>'
                  '<path d="M9.4 6.6 L10.8 8"/>'),
    'x402': ('inspectBtn "x402": the payments inspector',
             '<path d="M9.2 1.6 L3.6 9 H8 L6.8 14.4 L12.4 7 H8 Z"/>'),
    'tests': ('galleryBtn "x402 tests": the local test gallery (dev)',
              '<path d="M5.2 1.8 H10.8"/><path d="M6.4 1.8 V6.4 L2.6 12.6 A1 1 0 0 0 3.5 14.2 H12.5 '
              'A1 1 0 0 0 13.4 12.6 L9.6 6.4 V1.8"/><path d="M4.4 10.2 H11.6"/>'),
    'tour': ('tourBtn "Tour": the guided tour (dev)', '<path d="M5 2.8 L12.6 8 L5 13.2 Z"/>'),
    'back': ('back: go back', '<path d="M10.2 2.8 L5 8 L10.2 13.2"/>'),
    'forward': ('fwd: go forward', '<path d="M5.8 2.8 L11 8 L5.8 13.2"/>'),
    'new-tab': ('newTab: a new tab', '<path d="M8 2.6 V13.4"/><path d="M2.6 8 H13.4"/>'),
    'stop': ('stop: stop loading (pairs with reload)', '<path d="M3.6 3.6 L12.4 12.4"/><path d="M12.4 3.6 L3.6 12.4"/>'),
}

# the reload icon already in src/chrome.html, shown in the preview only, to compare weights
RELOAD = ('<path d="M13.2 6.2A5.5 5.5 0 1 0 13.5 9.5"/><path d="M13.6 2.2v4.3H9.3"/>')


def svg(name, body, label):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" '
            f'stroke="currentColor" stroke-width="{STROKE}" stroke-linecap="round" stroke-linejoin="round" '
            f'role="img" aria-label="{label}"><title>{label}</title>{body}</svg>\n')


def write_svgs():
    os.makedirs(f'{HERE}/svg', exist_ok=True)
    for name, (what, body) in ICONS.items():
        open(f'{HERE}/svg/{name}.svg', 'w').write(svg(name, body, name.replace('-', ' ')))


def preview():
    def row(size):
        cells = []
        for name, (what, body) in list(ICONS.items()) + [('reload (existing)', ('', RELOAD))]:
            s = svg(name, body, name).replace('width="16" height="16"', f'width="{size}" height="{size}"')
            cells.append(f'<figure>{s}<figcaption>{name}</figcaption></figure>')
        return ''.join(cells)

    def toolbar():
        names = ['back', 'forward', 'stop', 'new-tab', 'keep', 'saved', 'tests', 'tour', 'bookmarks', 'chat',
                 'reader', 'passwords', 'x402']
        btns = []
        for n in names:
            s = svg(n, ICONS[n][1], n)
            label = {'keep': 'Keep', 'saved': 'Saved', 'tests': 'x402 tests', 'tour': 'Tour', 'bookmarks': 'Bookmarks',
                     'chat': 'Chat', 'reader': 'Reader', 'passwords': 'Passwords', 'x402': 'x402'}.get(n, '')
            btns.append(f'<span class="btn">{s}{(" " + label) if label else ""}</span>')
        return ''.join(btns)

    rows = ''.join(
        f'<section class="{theme}"><h2>{theme} · {size}px</h2><div class="grid">{row(size)}</div></section>'
        for theme in ('dark', 'light') for size in (16, 32))
    bars = ''.join(f'<section class="{t}"><h2>{t} · toolbar at 16px</h2><div class="bar">{toolbar()}</div></section>'
                   for t in ('dark', 'light'))
    open(f'{HERE}/preview.html', 'w').write(f'''<!doctype html><meta charset="utf-8"><title>Toolbar icons</title>
<style>
body{{margin:0;font:13px -apple-system,system-ui,sans-serif;background:#888}}
section{{padding:14px 18px}} h2{{margin:0 0 10px;font-size:13px;font-weight:600}}
.dark{{background:#1b1b1d;color:#e6e6e6}} .light{{background:#f1f3f4;color:#24292f}}
.grid{{display:flex;flex-wrap:wrap;gap:14px}}
figure{{margin:0;display:flex;flex-direction:column;align-items:center;gap:6px;min-width:64px}}
figcaption{{font-size:11px;opacity:.75}}
.bar{{display:flex;flex-wrap:wrap;gap:6px}}
.btn{{display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border-radius:7px;font-size:13px}}
.dark .btn{{background:#2b2b2e}} .light .btn{{background:#fff;border:1px solid #d0d7de}}
</style>
{bars}{rows}
''')


if __name__ == '__main__':
    write_svgs()
    preview()
    print(f'wrote {len(ICONS)} icons to svg/ and preview.html')
