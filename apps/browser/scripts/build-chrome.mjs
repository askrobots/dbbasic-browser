#!/usr/bin/env node
/**
 * Build dist/chrome.html: src/chrome.html with the loading animations and the toolbar icons inlined.
 *
 * The chrome page's CSP forbids loading external files, and both must be real inline <svg> (so `currentColor` and the
 * --throb-* / --icon-accent variables follow the UI theme). So at build time:
 *   - the SVGs in assets/throbbers/svg/ are embedded as a JS object at the `THROBBERS` marker;
 *   - the SVGs in assets/icons/svg/ are embedded as a JS object at the `ICONS` marker (for icons the page swaps, like
 *     the star), and each `<!--icon:NAME-->` in the markup is replaced by that icon.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** name → SVG markup for every plain `name.svg` in a folder (the fixed-colour -dark/-light variants are for <img> use). */
function readSvgs(dir, tidy) {
  const out = {};
  for (const f of readdirSync(dir).sort()) {
    if (!/^[a-z0-9-]+\.svg$/.test(f) || /-(dark|light)\.svg$/.test(f)) continue;
    out[f.replace(/\.svg$/, "")] = tidy(readFileSync(join(dir, f), "utf8"));
  }
  if (Object.keys(out).length === 0) throw new Error(`no SVGs found in ${dir}`);
  return out;
}
// <title> would add a native tooltip; the aria-label stays for assistive tech.
const throbbers = readSvgs(join(root, "assets", "throbbers", "svg"), (s) => s.replace(/<title>.*?<\/title>/s, "").trim());
// An icon sits next to its button's words (or the button has its own aria-label), so it is decoration: hidden from
// assistive tech, no tooltip of its own.
const icons = readSvgs(join(root, "assets", "icons", "svg"), (s) =>
  s.replace(/<title>.*?<\/title>/s, "").replace(/\s*role="img"\s*aria-label="[^"]*"/, ' class="ico" aria-hidden="true" focusable="false"').trim());

// Escape "</" so nothing inside the JSON can ever close the surrounding <script>.
const asJs = (o) => JSON.stringify(o).replace(/<\//g, "<\\/");
const inline = (html, marker, o) => {
  if (!html.includes(marker)) throw new Error(`marker ${marker} not found in src/chrome.html`);
  return html.replace(marker, () => asJs(o));
};

let html = readFileSync(join(root, "src", "chrome.html"), "utf8");
html = inline(html, "/*__THROBBERS__*/ {}", throbbers);
html = inline(html, "/*__ICONS__*/ {}", icons);
let placed = 0;
html = html.replace(/<!--icon:([a-z0-9-]+)-->/g, (_, name) => {
  if (!icons[name]) throw new Error(`<!--icon:${name}--> in src/chrome.html, but there is no assets/icons/svg/${name}.svg`);
  placed++;
  return icons[name];
});

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist", "chrome.html"), html);
console.log(`chrome.html: inlined ${Object.keys(throbbers).length} throbbers and ${Object.keys(icons).length} icons (${placed} placed in the toolbar)`);
