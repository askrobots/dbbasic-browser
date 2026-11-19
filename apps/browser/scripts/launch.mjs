#!/usr/bin/env node
/**
 * Launch the built app (dist/main.js) with proper branding.
 *
 * Why this exists: on macOS the Dock label, the app-menu title and the Dock icon come
 * from the .app BUNDLE, not from our code — so running plain `electron dist/main.js`
 * always shows "Electron" and the Electron logo. In dev we therefore make a branded copy
 * of Electron.app (name, bundle id, icon), re-sign it ad hoc, and run the app inside it.
 * The copy is cached in .bundle/ (gitignored) and rebuilt only when Electron or the icon
 * changes. A packaged release would use electron-builder instead; this is the dev path.
 *
 * Other platforms: window/taskbar icon is set in main.ts, so we just run electron.
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const NAME = "dbbasic-browser";
const BUNDLE_ID = "com.askrobots.dbbasic-browser";
const electronPath = createRequire(import.meta.url)("electron"); // path to the electron binary

let exe = electronPath;

if (process.platform === "darwin") {
  const srcApp = join(dirname(electronPath), "..", ".."); // …/Electron.app
  const icon = join(root, "assets", "icon.icns");
  const outDir = join(root, ".bundle");
  const app = join(outDir, `${NAME}.app`);
  const stampFile = join(outDir, "stamp");
  const electronVersion = readFileSync(join(srcApp, "..", "version"), "utf8").trim();
  const stamp = `${electronVersion}|${existsSync(icon) ? statSync(icon).mtimeMs : "noicon"}|${NAME}|${BUNDLE_ID}`;

  const upToDate = existsSync(app) && existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp;
  if (!upToDate) {
    console.error(`[launch] building branded ${NAME}.app …`);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    try {
      execFileSync("cp", ["-cR", srcApp, app]); // APFS clone: near-instant, no extra disk
    } catch {
      cpSync(srcApp, app, { recursive: true, verbatimSymlinks: true });
    }
    const plist = join(app, "Contents", "Info.plist");
    const pb = (cmd) => { try { execFileSync("/usr/libexec/PlistBuddy", ["-c", cmd, plist]); } catch { /* key may not exist */ } };
    for (const [k, v] of [["CFBundleName", NAME], ["CFBundleDisplayName", NAME], ["CFBundleIdentifier", BUNDLE_ID]]) {
      pb(`Delete :${k}`);
      pb(`Add :${k} string ${v}`);
    }
    if (existsSync(icon)) {
      execFileSync("cp", [icon, join(app, "Contents", "Resources", "electron.icns")]); // CFBundleIconFile points here
    }
    // Editing Info.plist breaks the bundle's signature; macOS (esp. Apple Silicon) wants a valid one.
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "ignore" });
    writeFileSync(stampFile, stamp);
  }
  exe = join(app, "Contents", "MacOS", "Electron");
}

const child = spawn(exe, [join(root, "dist", "main.js"), ...process.argv.slice(2)], { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
