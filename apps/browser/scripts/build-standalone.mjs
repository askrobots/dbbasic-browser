#!/usr/bin/env node
/**
 * A self-contained build: everything except Electron itself is bundled into one folder, so the app can be run with
 * nothing but an Electron binary — no npm install and no Node version requirement on the machine that runs it.
 *
 *   npm run build:standalone          → standalone/   (copy this folder anywhere)
 *   <electron> standalone/            (e.g.  ./electron-linux/electron standalone/ --no-sandbox   see the notes on sandboxing)
 *
 * It is the normal build plus the three SDK packages that the normal build leaves external (viem, anthropic, openai).
 */
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "standalone");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, "src", "main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["electron"],
  outfile: join(out, "main.js"),
  // Bundled CommonJS packages call require(); give them one.
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  logLevel: "warning",
});

// The rest of what the normal build puts in dist/ (it must have been built first).
for (const f of ["chrome.html", "help.html", "preload.cjs", "webview-preload.cjs", "icon.png", "Readability.js", "reader-extractor.js"]) {
  copyFileSync(join(root, "dist", f), join(out, f));
}
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
writeFileSync(join(out, "package.json"), JSON.stringify({ name: "dbbasic-browser-standalone", version, type: "module", main: "main.js" }, null, 2) + "\n");
console.log(`standalone build: ${out}`);
