/**
 * Guard against committing credentials. Scans every file git would commit (tracked + untracked,
 * minus ignored) for API-key and private-key shapes, and checks that no env file is tracked.
 *
 * Deliberately NOT flagged: the well-known public Anvil/Hardhat test key in main.ts (documented
 * as "never fund this one") and on-chain transaction hashes, which look like keys but are public.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const inGit = existsSync(join(root, ".git"));

const PATTERNS: Array<[string, RegExp]> = [
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI key", /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{30,}/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

function candidateFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter(Boolean);
}

describe.skipIf(!inGit)("no credentials in the repository", () => {
  const files = candidateFiles();

  it("no env file (other than .env.example) is tracked or about to be committed", () => {
    const bad = files.filter((f) => /(^|\/)\.env($|\.)/.test(f) && !f.endsWith(".env.example"));
    expect(bad).toEqual([]);
  });

  it("no API-key or private-key shapes appear in any committable file", () => {
    const hits: string[] = [];
    for (const f of files) {
      const p = join(root, f);
      try {
        if (!statSync(p).isFile() || statSync(p).size > 2_000_000) continue;
        const text = readFileSync(p, "utf8");
        if (text.includes("\0")) continue; // binary
        for (const [label, re] of PATTERNS) {
          if (re.test(text)) hits.push(`${f}: ${label}`);
        }
      } catch {
        /* unreadable: skip */
      }
    }
    // No exceptions: tests that need fake keys build them at runtime so none exists in any source file.
    expect(hits).toEqual([]);
  });
});
