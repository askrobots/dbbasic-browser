#!/usr/bin/env node
/**
 * dbbasic-vault — standalone CLI for the vault.
 *
 *   dbbasic-vault init
 *   dbbasic-vault add <origin> <username> [--generate [length]]
 *   dbbasic-vault list
 *   dbbasic-vault get <origin|id> [username]     prints the password (and only that) to stdout
 *   dbbasic-vault rm <id>
 *   dbbasic-vault gen [length]
 *
 * Vault file: --vault <path> | $DBB_VAULT | ~/.dbbasic/vault.json
 * Master password: $DBB_VAULT_PASSWORD (for scripts/CI) or a hidden prompt.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Vault, VaultError, generatePassword, normalizeOrigin } from "./vault.ts";

const argv = process.argv.slice(2);
const flagIdx = argv.indexOf("--vault");
const vaultPath = flagIdx >= 0 ? (argv.splice(flagIdx, 2)[1] ?? "") : process.env.DBB_VAULT || join(homedir(), ".dbbasic", "vault.json");
const [cmd, ...rest] = argv;

/** Read a line from the terminal without echoing it. */
function readSecret(prompt: string): Promise<string> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) return Promise.reject(new Error("no terminal for a hidden prompt — set DBB_VAULT_PASSWORD"));
  return new Promise((resolve) => {
    stderr.write(prompt);
    let buf = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stderr.write("\n");
          return resolve(buf);
        }
        if (c === "\u0003") { stdin.setRawMode(false); stderr.write("\n"); process.exit(130); }
        if (c === "\u007f") buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

const master = async (confirm = false): Promise<string> => {
  if (process.env.DBB_VAULT_PASSWORD) return process.env.DBB_VAULT_PASSWORD;
  const m = await readSecret("Master password: ");
  if (confirm && m !== (await readSecret("Again: "))) throw new Error("passwords did not match");
  return m;
};

const open = async () => Vault.unlock(vaultPath, await master());

function fail(msg: string): never {
  process.stderr.write(`dbbasic-vault: ${msg}\n`);
  process.exit(1);
}

try {
  switch (cmd) {
    case "init": {
      mkdirSync(dirname(vaultPath), { recursive: true, mode: 0o700 });
      await Vault.create(vaultPath, await master(true));
      console.error(`created ${vaultPath}`);
      break;
    }
    case "add": {
      const [origin, username, ...flags] = rest;
      if (!origin || !username) fail("usage: add <origin> <username> [--generate [length]]");
      const gi = flags.indexOf("--generate");
      const password = gi >= 0 ? generatePassword(Number(flags[gi + 1]) || 20) : await readSecret(`Password for ${username}@${normalizeOrigin(origin)}: `);
      const v = await open();
      const s = await v.add({ origin, username, password });
      console.error(`saved ${s.username} @ ${s.origin}  (${s.id})`);
      if (gi >= 0) console.log(password);
      break;
    }
    case "list": {
      const v = await open();
      for (const e of v.list()) console.log(`${e.id}  ${e.origin}  ${e.username}`);
      break;
    }
    case "get": {
      const [key, username] = rest;
      if (!key) fail("usage: get <origin|id> [username]");
      const v = await open();
      const byId = v.list().find((e) => e.id === key);
      const matches = byId ? [byId] : v.find(key).filter((e) => !username || e.username === username);
      if (matches.length === 0) fail("no matching credential");
      if (matches.length > 1) fail(`${matches.length} credentials match — pass a username or an id`);
      process.stdout.write(v.get(matches[0]!.id).password + (process.stdout.isTTY ? "\n" : ""));
      break;
    }
    case "rm": {
      if (!rest[0]) fail("usage: rm <id>");
      await (await open()).remove(rest[0]);
      console.error("removed");
      break;
    }
    case "gen":
      console.log(generatePassword(Number(rest[0]) || 20));
      break;
    default:
      console.error("usage: dbbasic-vault [--vault <path>] <init|add|list|get|rm|gen> …");
      process.exit(cmd ? 2 : 0);
  }
} catch (e) {
  fail(e instanceof VaultError || e instanceof Error ? e.message : String(e));
}
