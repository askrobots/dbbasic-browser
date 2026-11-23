#!/usr/bin/env node
// The browser's version (see src/version.ts for the scheme).
//
//   node apps/browser/scripts/version.mjs              show it: 2026.11v1 (package.json: 2026.11.1)
//   node apps/browser/scripts/version.mjs cut          cut the next release in this UTC month
//   node apps/browser/scripts/version.mjs cut 2026.11v1   or a given one (either spelling; -beta.N for a pre-release)
//
// A cut rewrites the version in apps/browser/package.json and the lockfile, and moves the changelog's Unreleased section
// under the new version with today's UTC date. It never commits, tags or pushes: it prints the commands for that.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVersion, nextVersion, shownVersion, semverVersion, compareVersions } from "../src/version.ts";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(app, "..", "..");
const pkgPath = join(app, "package.json");
const lockPath = join(repo, "package-lock.json");
const changelogPath = join(repo, "CHANGELOG.md");

const pkgText = readFileSync(pkgPath, "utf8");
const current = JSON.parse(pkgText).version;
const cur = parseVersion(current);
const [cmd, arg] = process.argv.slice(2);

if (!cmd) {
  console.log(cur ? `${shownVersion(cur)} (package.json: ${current})` : `${current} (not a release version yet)`);
  process.exit(0);
}
if (cmd !== "cut") {
  console.error("usage: version.mjs [cut [version]]");
  process.exit(2);
}

const next = arg ? parseVersion(arg) : nextVersion(current, new Date());
if (!next) {
  console.error(`"${arg}" is not a version like 2026.11v1 or 2026.11.1`);
  process.exit(2);
}
if (cur && compareVersions(next, cur) <= 0) {
  console.error(`${shownVersion(next)} is not after the current ${shownVersion(cur)}`);
  process.exit(1);
}
const semver = semverVersion(next);
const shown = shownVersion(next);

// package.json and the lockfile: replace only the version string, keeping the files' own formatting.
const versionLine = /("version":\s*")[^"]*(")/;
writeFileSync(pkgPath, pkgText.replace(versionLine, `$1${semver}$2`));
const lock = readFileSync(lockPath, "utf8");
const at = lock.indexOf('"apps/browser": {');
if (at < 0) throw new Error("apps/browser is not in package-lock.json");
const head = lock.slice(0, at);
const rest = lock.slice(at);
writeFileSync(lockPath, head + rest.replace(versionLine, `$1${semver}$2`));

// The changelog: what was Unreleased becomes this release; a fresh, empty Unreleased goes above it.
const date = new Date().toISOString().slice(0, 10);
const log = readFileSync(changelogPath, "utf8");
if (!log.includes("\n## [Unreleased]\n")) throw new Error("CHANGELOG.md has no ## [Unreleased] heading");
writeFileSync(changelogPath, log.replace("\n## [Unreleased]\n", `\n## [Unreleased]\n\n## [${shown}] - ${date}\n`));

console.log(`${cur ? shownVersion(cur) : current} → ${shown} (package.json: ${semver})`);
console.log(`next: git commit -am "${shown}" && git tag -a ${shown} -m "${shown}"   (pushing the tag publishes it)`);
