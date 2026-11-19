import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Vault, VaultError, generatePassword, normalizeOrigin } from "../src/index.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "vault-")), "v.json");
const M = "correct horse battery";

describe("Vault", () => {
  it("round-trips entries through lock/unlock", async () => {
    const p = tmp();
    const v = await Vault.create(p, M);
    await v.add({ origin: "https://askrobots.com/login", username: "dan", password: "s3cret!" });
    v.lock();
    const v2 = await Vault.unlock(p, M);
    const [e] = v2.find("https://askrobots.com/anything");
    expect(e?.username).toBe("dan");
    expect(v2.get(e!.id).password).toBe("s3cret!");
  });

  it("never writes plaintext to disk, and chmods 600", async () => {
    const p = tmp();
    const v = await Vault.create(p, M);
    await v.add({ origin: "https://askrobots.com", username: "dan", password: "hunter2-unique" });
    const raw = readFileSync(p, "utf8");
    expect(raw).not.toContain("hunter2-unique");
    expect(raw).not.toContain("askrobots");
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("rejects a wrong master password and a tampered file", async () => {
    const p = tmp();
    await Vault.create(p, M);
    await expect(Vault.unlock(p, "wrong password!")).rejects.toMatchObject({ code: "wrong-password" });
    const env = JSON.parse(readFileSync(p, "utf8"));
    env.data = Buffer.from("tampered").toString("base64");
    writeFileSync(p, JSON.stringify(env));
    await expect(Vault.unlock(p, M)).rejects.toMatchObject({ code: "wrong-password" });
  });

  it("matches by EXACT origin only", async () => {
    const v = await Vault.create(tmp(), M);
    await v.add({ origin: "https://askrobots.com", username: "a", password: "p" });
    expect(v.find("https://askrobots.com/x")).toHaveLength(1);
    expect(v.find("https://askrobots.com:443/")).toHaveLength(1); // default port normalizes
    expect(v.find("http://askrobots.com")).toHaveLength(0); // scheme differs
    expect(v.find("https://www.askrobots.com")).toHaveLength(0); // subdomain differs
    expect(v.find("https://askrobots.com.evil.test")).toHaveLength(0); // lookalike
    expect(v.find("https://askrobots.com:8443")).toHaveLength(0); // port differs
    expect(v.find("file:///etc/passwd")).toEqual([]);
  });

  it("getFor refuses a credential from another origin", async () => {
    const v = await Vault.create(tmp(), M);
    const s = await v.add({ origin: "https://askrobots.com", username: "a", password: "p" });
    expect(v.getFor("https://askrobots.com/login", s.id).password).toBe("p");
    expect(() => v.getFor("https://evil.test", s.id)).toThrow(VaultError);
  });

  it("add updates in place for the same origin+username", async () => {
    const v = await Vault.create(tmp(), M);
    await v.add({ origin: "https://a.test", username: "u", password: "one" });
    await v.add({ origin: "https://a.test", username: "u", password: "two" });
    expect(v.list()).toHaveLength(1);
    expect(v.get(v.list()[0]!.id).password).toBe("two");
  });

  it("list/find never expose passwords", async () => {
    const v = await Vault.create(tmp(), M);
    await v.add({ origin: "https://a.test", username: "u", password: "topsecret" });
    expect(JSON.stringify(v.list())).not.toContain("topsecret");
    expect(JSON.stringify(v.find("https://a.test"))).not.toContain("topsecret");
  });

  it("remove and changeMaster", async () => {
    const p = tmp();
    const v = await Vault.create(p, M);
    const s = await v.add({ origin: "https://a.test", username: "u", password: "p" });
    await v.changeMaster("a brand new master");
    await expect(Vault.unlock(p, M)).rejects.toMatchObject({ code: "wrong-password" });
    const v2 = await Vault.unlock(p, "a brand new master");
    await v2.remove(s.id);
    expect(v2.list()).toHaveLength(0);
    await expect(v2.remove(s.id)).rejects.toMatchObject({ code: "not-found" });
  });

  it("a locked vault refuses everything", async () => {
    const v = await Vault.create(tmp(), M);
    v.lock();
    expect(() => v.list()).toThrow(/locked/);
    await expect(v.add({ origin: "https://a.test", username: "u", password: "p" })).rejects.toMatchObject({ code: "locked" });
  });

  it("won't overwrite an existing vault, and enforces a minimum master length", async () => {
    const p = tmp();
    await Vault.create(p, M);
    await expect(Vault.create(p, M)).rejects.toMatchObject({ code: "exists" });
    await expect(Vault.create(tmp(), "short")).rejects.toMatchObject({ code: "weak-password" });
  });
});

describe("helpers", () => {
  it("normalizeOrigin", () => {
    expect(normalizeOrigin("Askrobots.com")).toBe("https://askrobots.com");
    expect(normalizeOrigin("http://127.0.0.1:8899/x?y")).toBe("http://127.0.0.1:8899");
    expect(() => normalizeOrigin("ftp://x.test")).toThrow(VaultError);
  });

  it("generatePassword has every class, right length, and varies", () => {
    const p = generatePassword(24);
    expect(p).toHaveLength(24);
    expect(p).toMatch(/[a-z]/); expect(p).toMatch(/[A-Z]/); expect(p).toMatch(/[0-9]/); expect(p).toMatch(/[^a-zA-Z0-9]/);
    expect(generatePassword(24)).not.toBe(p);
    expect(generatePassword(12, { symbols: false })).toMatch(/^[a-zA-Z0-9]+$/);
  });
});
