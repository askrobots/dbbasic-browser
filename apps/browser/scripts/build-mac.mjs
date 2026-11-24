#!/usr/bin/env node
/**
 * The Mac app people download: dbbasic-browser.app, zipped.
 *
 *   npm run build:mac                  → release/dbbasic-browser.app
 *                                        release/dbbasic-browser-<version>-macos-<arch>.zip  (+ a .json beside it)
 *   npm run build:mac -- --allow-dirty   a trial build from uncommitted changes, named so it can't pass for a release
 *
 * It is Electron's own Electron.app (the one npm installed and checked against Electron's published checksums) with
 * our name, icon and version, and the standalone build (scripts/build-standalone.mjs) in Contents/Resources/app.
 * It is for the processor of the Electron that npm installed, so build on an Apple-chip Mac for macos-arm64.
 *
 * A release is built from one commit, the one its tag points at: the working tree must be clean, and the build says
 * so when HEAD has no version tag yet. The .json records the file's name, size, SHA-256, the commit and the tag.
 *
 * The app is signed ad hoc only (no Apple Developer ID), so macOS warns the first time it is opened.
 * The zip is made with ditto, which keeps the bundle's symlinks and permissions; other zip tools can break the app.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("build-mac: run this on a Mac (it uses ditto, codesign and the Mac Electron.app)");
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "dbbasic-browser";
const BUNDLE_ID = "com.askrobots.dbbasic-browser";
const allowDirty = process.argv.includes("--allow-dirty");
const run = (cmd, args, opts = {}) => (execFileSync(cmd, args, { cwd: root, encoding: "utf8", ...opts }) ?? "").trim();

// ---- which commit, which version ----
const commit = run("git", ["rev-parse", "HEAD"]);
const dirty = run("git", ["status", "--porcelain"]) !== "";
if (dirty && !allowDirty) {
  console.error("build-mac: the working tree has uncommitted changes. A release is built from one commit: commit first,\n" +
    "or pass --allow-dirty for a trial build (its name says so).");
  process.exit(1);
}
const { displayVersion } = await import(join(root, "src", "version.ts"));
const semver = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const shown = displayVersion(semver);
const tags = run("git", ["tag", "--points-at", "HEAD"]).split("\n").filter(Boolean);
const tagged = tags.includes(shown);

// ---- the Electron.app to start from ----
const electronBin = createRequire(import.meta.url)("electron");
const srcApp = join(dirname(electronBin), "..", "..");
const electronVersion = readFileSync(join(srcApp, "..", "version"), "utf8").trim();
const archs = run("lipo", ["-archs", electronBin]).split(/\s+/);
const arch = archs.length === 1 && archs[0] === "arm64" ? "arm64" : archs.length === 1 && archs[0] === "x86_64" ? "x64" : null;
if (!arch) {
  console.error(`build-mac: expected an arm64 or x86_64 Electron, found: ${archs.join(" ")}`);
  process.exit(1);
}

// ---- build the app's files ----
run("npm", ["run", "build:standalone"], { stdio: "inherit" });

const out = join(root, "release");
const appDir = join(out, `${NAME}.app`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
try {
  run("cp", ["-cR", srcApp, appDir]); // an APFS clone where possible: fast, no extra disk
} catch {
  cpSync(srcApp, appDir, { recursive: true, verbatimSymlinks: true });
}
const res = join(appDir, "Contents", "Resources");
rmSync(join(res, "default_app.asar"), { force: true }); // Electron's sample app; ours goes in Resources/app
cpSync(join(root, "standalone"), join(res, "app"), { recursive: true });
cpSync(join(root, "assets", "icon.icns"), join(res, "electron.icns")); // CFBundleIconFile names this file

const plist = join(appDir, "Contents", "Info.plist");
const pb = (cmd) => execFileSync("/usr/libexec/PlistBuddy", ["-c", cmd, plist], { stdio: ["ignore", "ignore", "pipe"] });
const setKey = (key, value) => {
  try { pb(`Delete :${key}`); } catch { /* not there yet */ }
  pb(`Add :${key} string ${value}`);
};
setKey("CFBundleName", NAME);
setKey("CFBundleDisplayName", NAME);
setKey("CFBundleIdentifier", BUNDLE_ID);
setKey("CFBundleShortVersionString", semver.replace(/-.*/, "")); // macOS wants plain numbers here
setKey("CFBundleVersion", semver.replace(/-.*/, ""));
setKey("LSApplicationCategoryType", "public.app-category.productivity");
setKey("DBBasicCommit", commit);
try { pb("Delete :ElectronAsarIntegrity"); } catch { /* the sample app's hash; there is no asar now */ }

// Changing the bundle breaks Electron's signature, and an Apple-chip Mac won't run unsigned code: sign it ad hoc.
run("codesign", ["--force", "--deep", "--sign", "-", appDir], { stdio: "ignore" });
run("codesign", ["--verify", "--deep", "--strict", appDir]);

// ---- the zip, and what it is ----
const suffix = dirty ? `-dev-${commit.slice(0, 7)}` : "";
const zipName = `${NAME}-${shown}${suffix}-macos-${arch}.zip`;
const zip = join(out, zipName);
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appDir, zip]);
const sha256 = await new Promise((resolve, reject) => {
  const h = createHash("sha256");
  createReadStream(zip).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
});
const size = statSync(zip).size;
const info = { file: zipName, platform: `macos-${arch}`, size, sha256, commit, tag: tagged ? shown : null, version: shown, electron: electronVersion, dirty };
writeFileSync(join(out, `${zipName}.json`), JSON.stringify(info, null, 2) + "\n");

console.log(`\n${zip}`);
console.log(`  ${(size / 1024 / 1024).toFixed(1)} MB (${size} bytes)`);
console.log(`  sha256 ${sha256}`);
console.log(`  commit ${commit}${dirty ? " plus uncommitted changes (trial build, not for upload)" : ""}`);
if (!dirty && !tagged) console.log(`  HEAD has no ${shown} tag yet: tag this commit before uploading the zip to its release.`);
if (existsSync(appDir)) console.log(`  app: ${appDir}`);
