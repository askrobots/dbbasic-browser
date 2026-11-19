#!/usr/bin/env node
/**
 * Build dist/chrome.html: src/chrome.html with the loading-animation SVGs inlined.
 *
 * The chrome page's CSP forbids loading external files, and the animations must be real inline
 * <svg> (so `currentColor` and the --throb-* variables follow the UI theme). So at build time the
 * SVGs in assets/throbbers/svg/ are embedded as a JS object at the `THROBBERS` marker.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "assets", "throbbers", "svg");
const MARKER = "/*__THROBBERS__*/ {}";

const states = {};
for (const f of readdirSync(dir).sort()) {
  if (!/^[a-z-]+\.svg$/.test(f) || /-(dark|light)\.svg$/.test(f)) continue; // the fixed-colour variants are for <img> use
  // <title> would add a native tooltip over the tab; the aria-label stays for assistive tech.
  states[f.replace(/\.svg$/, "")] = readFileSync(join(dir, f), "utf8").replace(/<title>.*?<\/title>/s, "").trim();
}
if (Object.keys(states).length === 0) throw new Error(`no throbber SVGs found in ${dir}`);

const html = readFileSync(join(root, "src", "chrome.html"), "utf8");
if (!html.includes(MARKER)) throw new Error(`marker ${MARKER} not found in src/chrome.html`);
// Escape "</" so nothing inside the JSON can ever close the surrounding <script>.
const json = JSON.stringify(states).replace(/<\//g, "<\\/");

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist", "chrome.html"), html.replace(MARKER, () => json));
console.log(`chrome.html: inlined ${Object.keys(states).length} throbbers (${json.length} bytes)`);
