import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const hook = join(__dirname, "..", "..", "..", ".githooks", "pre-push");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const zero = "0".repeat(40);

function repoWith(content: string) {
  const dir = mkdtempSync(join(tmpdir(), "dbb-hook-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "first\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  const base = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "b.txt"), content);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "two");
  return { dir, base, head: git(dir, "rev-parse", "HEAD") };
}
const runHook = (r: { dir: string; base: string; head: string }, remoteSha = r.base) =>
  spawnSync("bash", [hook], { cwd: r.dir, input: `refs/heads/main ${r.head} refs/heads/main ${remoteSha}\n`, encoding: "utf8", env: { ...process.env, PREPUSH_ONLY: "secrets" } });

describe("the pre-push hook's secret scan", () => {
  it("refuses a push whose added lines contain a key-shaped string, and does not print it in full", () => {
    const fake = "sk-ant-" + "api03-" + "A".repeat(40);
    const r = runHook(repoWith(`key = ${fake}\n`));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refusing to push");
    expect(r.stderr).not.toContain(fake);
  });
  it("refuses a private key block and a cloud key", () => {
    expect(runHook(repoWith("-----BEGIN " + "RSA PRIVATE KEY-----\n")).status).toBe(1); // built at runtime so this file is not itself key-shaped
    expect(runHook(repoWith("id=AKIA" + "ABCDEFGHIJKLMNOP\n")).status).toBe(1);
  });
  it("allows ordinary changes", () => {
    const r = runHook(repoWith("just some text, a version 1.2.3, and a hash abcdef0123456789\n"));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no key-shaped secrets");
  });
  it("scans a brand new branch (remote sha all zeros) and a deleted ref is ignored", () => {
    const r = repoWith("AKIA" + "ABCDEFGHIJKLMNOP\n");
    expect(spawnSync("bash", [hook], { cwd: r.dir, input: `refs/heads/new ${r.head} refs/heads/new ${zero}\n`, encoding: "utf8", env: { ...process.env, PREPUSH_ONLY: "secrets" } }).status).toBe(1);
    expect(spawnSync("bash", [hook], { cwd: r.dir, input: `(delete) ${zero} refs/heads/old ${r.base}\n`, encoding: "utf8", env: { ...process.env, PREPUSH_ONLY: "secrets" } }).status).toBe(0);
  });
});
