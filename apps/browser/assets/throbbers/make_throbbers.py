# SPDX-License-Identifier: Apache-2.0
"""Loading animations for a browser's tab, toolbar and page area: drawn here from plain shapes, nothing copied.

    python3 make_throbbers.py            writes svg/, apng/, gif/ and preview.html beside this file

Each state is one small SVG on a 16x16 grid (so it reads at tab size and scales up cleanly), animated with
SMIL as a seamless loop. From each SVG the script also renders transparent APNGs and matted GIFs at 16, 32
and 64 px (and @2x), in a light-ink set for dark tab strips and a dark-ink set for light ones.

Needs: Python 3, Pillow, Playwright with Chromium (only for the PNG/GIF rendering; the SVGs need nothing).
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ACCENT, OK, FAIL = '#3b9eff', '#30a46c', '#e5484d'
INKS = {'dark': '#e6e6e6', 'light': '#24292f'}        # ink for a dark strip, ink for a light strip
MATTES = {'dark': '#202124', 'light': '#f1f3f4'}      # what GIF edges are blended towards
FPS = 15


def f(x):
    return f'{x:.3f}'.rstrip('0').rstrip('.')


def samples(fn, n=24):
    """n+1 evenly spaced samples of a function of loop time 0..1 (first == last when fn is periodic)."""
    return [fn(i / n) for i in range(n + 1)]


def anim(attr, fn, dur, n=24):
    vals = ';'.join(f(v) if isinstance(v, (int, float)) else v for v in samples(fn, n))
    return f'<animate attributeName="{attr}" dur="{dur}s" repeatCount="indefinite" values="{vals}"/>'


def anim_t(kind, fn, dur, n=24):
    vals = ';'.join(samples(fn, n))
    return (f'<animateTransform attributeName="transform" type="{kind}" dur="{dur}s" repeatCount="indefinite" '
            f'values="{vals}"/>')


def ease(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def ramp(t, a, b):
    """0 before a, 1 after b, eased between."""
    return ease((t - a) / (b - a)) if b > a else float(t >= b)


def pulse(t, centre, width):
    """1 at centre, falling to 0 at +-width, on a loop."""
    d = abs(((t - centre + 0.5) % 1.0) - 0.5)
    return ease(1 - d / width) if d < width else 0.0


# ---- the states: name -> (seconds per loop, what it means, svg body with {ink} {acc} {ok} {fail}) ----

def connecting():
    d = 1.2
    dots = ''.join(
        f'<circle cx="{x}" cy="8" r="0.95" fill="{{acc}}" stroke="none">'
        + anim('opacity', lambda t, c=c: 0.15 + 0.85 * pulse(t, c, 0.28), d) + '</circle>'
        for x, c in ((6, 0.15), (8, 0.4), (10, 0.65)))
    return d, 'connecting (finding and reaching the server)', (
        '<circle cx="2.8" cy="8" r="1.5" fill="{ink}" stroke="none"/>'
        '<circle cx="13.2" cy="8" r="1.5"/>' + dots)


def tls():
    d = 1.8
    def y(t):
        return -1.9 * (1 - ramp(t, 0.30, 0.48)) if t < 0.9 else -1.9 * ramp(t, 0.9, 1.0)
    return d, 'secure handshake', (
        '<rect x="3.8" y="7.6" width="8.4" height="6" rx="1.3"/>'
        '<g><path d="M5.6 7.6 V5.6 a2.4 2.4 0 0 1 4.8 0 V7.6"/>'
        + anim_t('translate', lambda t: f'0 {f(y(t))}', d) + '</g>'
        '<circle cx="8" cy="10.6" r="1.1" fill="{acc}" stroke="none">'
        + anim('opacity', lambda t: ramp(t, 0.42, 0.52) * (1 - ramp(t, 0.88, 0.96)), d) + '</circle>')


def waiting():
    d = 1.1
    c = 2 * math.pi * 5.2
    return d, 'waiting for the server', (
        '<circle cx="8" cy="8" r="5.2" opacity="0.25"/>'
        f'<circle cx="8" cy="8" r="5.2" stroke="{{acc}}" stroke-dasharray="{f(c * 0.28)} {f(c * 0.72)}">'
        + anim_t('rotate', lambda t: f'{f(360 * t)} 8 8', d) + '</circle>')


def receiving():
    d = 1.0
    return d, 'receiving data', (
        '<path d="M3 10.8 V13.2 H13 V10.8"/>'
        '<g stroke="{acc}"><path d="M8 2.6 V9.4 M5.4 6.9 L8 9.5 L10.6 6.9"/>'
        + anim_t('translate', lambda t: f'0 {f(-3.4 * (1 - ramp(t, 0.0, 0.6)))}', d)
        + anim('opacity', lambda t: ramp(t, 0.0, 0.18) * (1 - ramp(t, 0.72, 0.95)), d) + '</g>')


def redirecting():
    d = 1.4
    path = 'M2.8 11.4 H7.6 a3.4 3.4 0 0 0 3.4 -3.4 V4.2'
    return d, 'redirecting to another address', (
        f'<path d="{path}" opacity="0.35"/><path d="M8.7 6 L11 3.7 L13.3 6" opacity="0.35"/>'
        '<circle r="1.35" fill="{acc}" stroke="none">'
        f'<animateMotion dur="{d}s" repeatCount="indefinite" path="{path}" calcMode="linear"/>'
        + anim('opacity', lambda t: ramp(t, 0.0, 0.12) * (1 - ramp(t, 0.85, 1.0)), d) + '</circle>')


def challenge():
    d = 1.0
    pts = []
    for i in range(8):                                   # an 8-tooth gear, from four points a tooth
        a = i * math.pi / 4
        for da, r in ((-0.20, 4.3), (-0.12, 6.1), (0.12, 6.1), (0.20, 4.3)):
            pts.append(f'{f(8 + r * math.cos(a + da))} {f(8 + r * math.sin(a + da))}')
    gear = 'M' + ' L'.join(pts) + ' Z'
    return d, 'bot check (a short proof of work)', (
        f'<g><path d="{gear}" stroke-width="1.3"/>'
        + anim_t('rotate', lambda t: f'{f(45 * t)} 8 8', d) + '</g>'     # one tooth per loop: seamless
        '<circle cx="8" cy="8" r="1.5" fill="{acc}" stroke="none">'
        + anim('opacity', lambda t: 0.35 + 0.65 * pulse(t, 0.5, 0.5), d) + '</circle>')


def pay_pending():
    d = 2.4
    return d, 'payment needed (waiting for a yes)', (
        '<g><circle cx="8" cy="8" r="5.4" stroke-dasharray="2.3 1.94"/>'
        + anim_t('rotate', lambda t: f'{f(45 * t)} 8 8', d) + '</g>'     # the dash pattern repeats every 45 degrees
        '<path d="M8 5.6 V10.4" stroke="{acc}" stroke-width="1.9">'
        + anim('opacity', lambda t: 0.3 + 0.7 * pulse(t, 0.5, 0.5), d) + '</path>')


def pay_paying():
    d = 1.1
    return d, 'paying', (
        '<path d="M13.2 4.6 V11.4"/><path d="M2.6 8 H4.4" opacity="0.35"/>'
        '<g><circle cx="5" cy="8" r="2.6" stroke="{acc}"/><path d="M5 6.9 V9.1" stroke="{acc}" stroke-width="1.3"/>'
        + anim_t('translate', lambda t: f'{f(6.2 * ramp(t, 0.05, 0.8))} 0', d)
        + anim('opacity', lambda t: ramp(t, 0.0, 0.12) * (1 - ramp(t, 0.68, 0.86)), d) + '</g>')


def pay_settled():
    d = 2.6
    length = 8.4
    return d, 'paid', (
        '<circle cx="8" cy="8" r="5.4" stroke="{ok}"/>'
        # the gap is longer than the path and the start offset goes past its end, or the round cap leaves a dot
        f'<path d="M5.2 8.3 L7.2 10.3 L10.9 6.1" stroke="{{ok}}" stroke-width="1.9" stroke-dasharray="{length} {length + 6}">'
        + anim('stroke-dashoffset', lambda t: (length + 3) * (1 - ramp(t, 0.05, 0.28)) if t < 0.9 else (length + 3) * ramp(t, 0.9, 1.0), d)
        + '</path>')


def summarizing():
    d = 2.0
    def line(y, a, b, to):
        return (f'<path d="M3 {y} H13">'
                + anim('d', lambda t: f'M3 {y} H{f(13 - (13 - to) * ramp(t, a, b) * (1 - ramp(t, 0.9, 1.0)))}', d) + '</path>')
    star = 'M12.4 1.6 L13 3 L14.4 3.6 L13 4.2 L12.4 5.6 L11.8 4.2 L10.4 3.6 L11.8 3 Z'
    return d, 'AI is summarizing the page', (
        line(6.2, 0.10, 0.34, 9) + line(9.4, 0.26, 0.50, 6.5) + line(12.6, 0.42, 0.66, 8)
        + f'<path d="{star}" fill="{{acc}}" stroke="none">'
        + anim('opacity', lambda t: 0.25 + 0.75 * pulse(t, 0.72, 0.22), d) + '</path>')


def slow():
    d = 3.2
    glass = ('M4.6 2.6 H11.4 M4.6 13.4 H11.4 '
             'M5.4 2.6 C5.4 5.8 7.4 6.8 8 8 C8.6 6.8 10.6 5.8 10.6 2.6 '
             'M5.4 13.4 C5.4 10.2 7.4 9.2 8 8 C8.6 9.2 10.6 10.2 10.6 13.4')
    return d, 'still waiting (slow)', (
        f'<g><path d="{glass}" stroke-width="1.3"/>'
        '<path d="M8 8.9 V11.6" stroke="{acc}" stroke-width="1.2">'
        + anim('opacity', lambda t: (0.25 + 0.75 * pulse(t * 4 % 1, 0.5, 0.5)) * (1 - ramp(t, 0.72, 0.8)), d, 32) + '</path>'
        + anim_t('rotate', lambda t: f'{f(180 * ramp(t, 0.8, 1.0))} 8 8', d, 32) + '</g>')   # half a turn looks the same


def failed():
    d = 2.0
    def x(t):
        return 0.7 * math.sin(t / 0.22 * 4 * math.pi) * (1 - t / 0.22) if t < 0.22 else 0.0
    return d, 'failed', (
        '<circle cx="8" cy="8" r="5.6" opacity="0.35"/>'
        '<g stroke="{fail}" stroke-width="1.9"><path d="M5.8 5.8 L10.2 10.2 M10.2 5.8 L5.8 10.2"/>'
        + anim_t('translate', lambda t: f'{f(x(t))} 0', d, 44) + '</g>')


def offline():
    d = 2.2
    return d, 'offline (no connection)', (
        '<circle cx="2.8" cy="8" r="1.5" fill="{ink}" stroke="none"/><circle cx="13.2" cy="8" r="1.5"/>'
        '<path d="M4.6 8 H6.3 M9.7 8 H11.4" opacity="0.5"/>'
        '<path d="M7 10.8 L9 5.2" stroke="{fail}" stroke-width="1.7">'
        + anim('opacity', lambda t: 0.25 + 0.75 * pulse(t, 0.5, 0.5), d) + '</path>')


STATES = {
    'connecting': connecting, 'secure': tls, 'waiting': waiting, 'receiving': receiving,
    'redirecting': redirecting, 'challenge': challenge, 'pay-pending': pay_pending, 'pay-paying': pay_paying,
    'pay-settled': pay_settled, 'summarizing': summarizing, 'slow': slow, 'failed': failed, 'offline': offline,
}


def svg(name, theme=None, size=None):
    """theme None: ink is currentColor and the three colours are CSS variables (for inlining in a page)."""
    dur, title, body = STATES[name]()
    if theme is None:
        ink = 'currentColor'
        body = (body.replace('fill="{acc}"', 'style="fill:var(--throb-accent,%s)"' % ACCENT)
                    .replace('stroke="{acc}"', 'style="stroke:var(--throb-accent,%s)"' % ACCENT)
                    .replace('stroke="{ok}"', 'style="stroke:var(--throb-ok,%s)"' % OK)
                    .replace('stroke="{fail}"', 'style="stroke:var(--throb-fail,%s)"' % FAIL))
    else:
        ink = INKS[theme]
    body = body.format(ink=ink, acc=ACCENT, ok=OK, fail=FAIL)
    dims = f' width="{size}" height="{size}"' if size else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"{dims} fill="none" stroke="{ink}" '
            f'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="{title}">'
            f'<title>{title}</title>{body}</svg>'), dur, title


def write_svgs():
    os.makedirs(f'{HERE}/svg', exist_ok=True)
    for name in STATES:
        for theme in (None, 'dark', 'light'):
            text, _dur, _title = svg(name, theme)
            open(f'{HERE}/svg/{name}{"-" + theme if theme else ""}.svg', 'w').write(text + '\n')


def render():
    """Frames from Chromium (the SVG's own clock is stepped, so loops are exact), then APNG and GIF from Pillow."""
    from io import BytesIO
    from PIL import Image
    from playwright.sync_api import sync_playwright
    os.makedirs(f'{HERE}/apng', exist_ok=True)
    os.makedirs(f'{HERE}/gif', exist_ok=True)
    big = 128
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 200, 'height': 200}, device_scale_factor=1)
        for name in STATES:
            for theme in ('dark', 'light'):
                text, dur, _title = svg(name, theme, big)
                page.set_content(f'<body style="margin:0;background:transparent">{text}</body>')
                page.evaluate('document.querySelector("svg").pauseAnimations()')
                n = max(12, round(dur * FPS))
                frames = []
                for i in range(n):
                    page.evaluate('t => document.querySelector("svg").setCurrentTime(t)', dur * i / n)
                    shot = page.locator('svg').screenshot(omit_background=True)
                    frames.append(Image.open(BytesIO(shot)).convert('RGBA'))
                ms = round(dur * 1000 / n)
                for size in (16, 32, 64):
                    for scale, tag in ((1, ''), (2, '@2x')):
                        px = size * scale
                        small = [fr.resize((px, px), Image.LANCZOS) for fr in frames]
                        small[0].save(f'{HERE}/apng/{name}-{theme}-{size}{tag}.png', save_all=True,
                                      append_images=small[1:], duration=ms, loop=0, disposal=1, blend=0)
                        save_gif(small, MATTES[theme], ms, f'{HERE}/gif/{name}-{theme}-{size}{tag}.gif')
        browser.close()


def save_gif(frames, matte, ms, path):
    """GIF has one transparent colour and no soft edges: blend the edges towards the strip colour (matte),
    then make only the nearly empty pixels transparent. Right on that strip colour, a faint rim on others."""
    from PIL import Image
    w, h = frames[0].size
    back = Image.new('RGBA', (w, h), matte)
    flat = [Image.alpha_composite(back, fr).convert('RGB') for fr in frames]
    sheet = Image.new('RGB', (w * len(flat), h))
    for i, im in enumerate(flat):
        sheet.paste(im, (i * w, 0))
    palette = sheet.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    out = []
    for im, fr in zip(flat, frames):
        q = im.quantize(palette=palette, dither=Image.Dither.NONE)
        alpha = fr.getchannel('A')
        q.paste(255, mask=alpha.point(lambda a: 255 if a < 40 else 0))
        out.append(q)
    out[0].save(path, save_all=True, append_images=out[1:], duration=ms, loop=0, transparency=255, disposal=2)


def preview():
    rows = []
    for name in STATES:
        _text, dur, title = svg(name)
        cells = ''
        for theme in ('dark', 'light'):
            ims = ''.join(f'<img src="svg/{name}-{theme}.svg" width="{s}" height="{s}">' for s in (16, 32, 64))
            ims += ''.join(f'<img src="apng/{name}-{theme}-{s}@2x.png" width="{s}" height="{s}">' for s in (16, 32))
            ims += f'<img src="gif/{name}-{theme}-16@2x.gif" width="16" height="16">'
            cells += f'<td class="{theme}">{ims}</td>'
        rows.append(f'<tr><th>{name}<br><small>{title}, {dur}s</small></th>{cells}</tr>')
    open(f'{HERE}/preview.html', 'w').write(
        '<!doctype html><meta charset="utf-8"><title>Loading animations: draft</title>'
        '<style>body{font:14px system-ui;margin:24px}table{border-collapse:collapse}th{text-align:left;padding:6px 16px 6px 0;'
        'font-weight:600}small{font-weight:400;color:#777}td{padding:10px 14px}td img{margin-right:14px;vertical-align:middle}'
        f'.dark{{background:{MATTES["dark"]}}}.light{{background:{MATTES["light"]}}}</style>'
        '<h1>Loading animations: draft</h1><p>Each cell: SVG at 16, 32, 64; APNG at 16, 32; GIF at 16. '
        'Left on a dark strip, right on a light one.</p><table>' + ''.join(rows) + '</table>\n')


if __name__ == '__main__':
    write_svgs()
    if '--svg-only' not in sys.argv:
        render()
    preview()
    print('wrote', len(STATES), 'states to', HERE)
