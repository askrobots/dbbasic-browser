/**
 * The browser's version, in two spellings of the same three values: the year and month of the release line (the UTC
 * month it was cut, written down when it is cut, never read from the build clock) and a release count from 1.
 *
 *   shown to people and used as the git tag:  2026.11v1, 2026.12v1-beta.2
 *   package.json and updaters (semver):      2026.11.1, 2026.12.1-beta.2   (no leading zero on the month: semver forbids it)
 *
 * package.json holds the semver spelling and is the only place it is written; scripts/version.mjs rewrites it. Plugins
 * get a separate plain integer, PLUGIN_API_LEVEL, raised only when what a plugin can rely on changes.
 * No imports, so scripts can load this file with Node directly.
 */

/** What a plugin can rely on. Raise it only when the plugin interface changes; plugins declare `min_api`. */
export const PLUGIN_API_LEVEL = 2;

export interface Version { year: number; month: number; n: number; pre: string }

const SEMVER = /^(\d{4})\.([1-9]|1[0-2])\.([1-9]\d*)(?:-([0-9A-Za-z.]+))?$/;
const SHOWN = /^(\d{4})\.(0[1-9]|1[0-2])v([1-9]\d*)(?:-([0-9A-Za-z.]+))?$/;

function parse(re: RegExp, s: string): Version | null {
  const m = re.exec(s.trim());
  if (!m) return null;
  const [, y = "", mo = "", n = "", pre = ""] = m;
  return { year: Number(y), month: Number(mo), n: Number(n), pre };
}

/** "2026.11.1" → {2026, 11, 1}; also accepts the shown form. null for anything else (0.1.0, a date, garbage). */
export function parseVersion(s: string): Version | null {
  return parse(SEMVER, s) ?? parse(SHOWN, s);
}

export function shownVersion(v: Version): string {
  return `${v.year}.${String(v.month).padStart(2, "0")}v${v.n}${v.pre ? "-" + v.pre : ""}`;
}

export function semverVersion(v: Version): string {
  return `${v.year}.${v.month}.${v.n}${v.pre ? "-" + v.pre : ""}`;
}

/** The shown spelling of a package.json version; a version not in this scheme is shown as it is. */
export function displayVersion(semver: string): string {
  const v = parseVersion(semver);
  return v ? shownVersion(v) : semver;
}

/**
 * The next release cut in `now`'s UTC month: the count goes up within a month and starts again at 1 in a new one. After a
 * pre-release, the next is that same release, final (2026.12v1-beta.2 → 2026.12v1).
 */
export function nextVersion(current: string, now: Date): Version {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const v = parseVersion(current);
  if (!v || v.year !== year || v.month !== month) return { year, month, n: 1, pre: "" };
  return { year, month, n: v.pre ? v.n : v.n + 1, pre: "" };
}

/** Sorts like the releases happened: by line, then count, and a pre-release before its final. */
export function compareVersions(a: Version, b: Version): number {
  return a.year - b.year || a.month - b.month || a.n - b.n || (a.pre === b.pre ? 0 : !a.pre ? 1 : !b.pre ? -1 : a.pre < b.pre ? -1 : 1);
}
