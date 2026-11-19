/**
 * A deliberately tiny password vault.
 *
 *   - One file on disk: scrypt-derived key → AES-256-GCM over a JSON document.
 *   - Zero dependencies (node:crypto only), so it runs standalone or inside Electron.
 *   - Credentials are matched by EXACT origin (scheme + host + port). No "same
 *     registrable domain" cleverness: loose matching is how phishing pages get filled.
 *
 * Threat model: protects secrets at rest and from a different origin's page. It does
 * not defend against malware running as you while the vault is unlocked.
 */

import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";

export interface Credential {
  id: string;
  /** Normalized origin, e.g. "https://askrobots.com". */
  origin: string;
  username: string;
  password: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

/** What you may hand to UI/logs: everything except the password. */
export type CredentialSummary = Omit<Credential, "password" | "notes">;

export type NewCredential = Pick<Credential, "origin" | "username" | "password"> & { notes?: string };

interface Envelope {
  v: 1;
  kdf: { name: "scrypt"; salt: string; N: number; r: number; p: number };
  iv: string;
  tag: string;
  data: string; // base64 ciphertext of JSON { entries: Credential[] }
}

const KDF = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_LEN = 32;
const MIN_MASTER = 8;

export type VaultErrorCode = "locked" | "wrong-password" | "exists" | "missing" | "corrupt" | "weak-password" | "bad-origin" | "not-found";

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

/** "https://Askrobots.com:443/login?x=1" → "https://askrobots.com". Throws on non-web URLs. */
export function normalizeOrigin(input: string): string {
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new VaultError("bad-origin", `not a URL: ${input}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new VaultError("bad-origin", `only http(s) origins can hold credentials, got ${u.protocol}`);
  }
  return u.origin;
}

function deriveKey(master: string, salt: Buffer, p: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((res, rej) =>
    scrypt(master, salt, KEY_LEN, { N: p.N, r: p.r, p: p.p, maxmem: 256 * p.N * p.r }, (e, k) => (e ? rej(e) : res(k))),
  );
}

function seal(key: Buffer, entries: Credential[]): Pick<Envelope, "iv" | "tag" | "data"> {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(JSON.stringify({ entries }), "utf8"), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export class Vault {
  readonly path: string;
  private kdf: Envelope["kdf"];
  private entries: Credential[] = [];
  private key: Buffer | null = null;
  private constructor(path: string, kdf: Envelope["kdf"]) {
    this.path = path;
    this.kdf = kdf;
  }

  /** Create a new vault file. Refuses to overwrite an existing one. */
  static async create(path: string, master: string): Promise<Vault> {
    if (master.length < MIN_MASTER) throw new VaultError("weak-password", `master password must be at least ${MIN_MASTER} characters`);
    if (await Vault.exists(path)) throw new VaultError("exists", `vault already exists at ${path}`);
    const kdf = { name: "scrypt" as const, salt: randomBytes(16).toString("base64"), ...KDF };
    const v = new Vault(path, kdf);
    v.key = await deriveKey(master, Buffer.from(kdf.salt, "base64"), kdf);
    await v.save();
    return v;
  }

  /** Open and decrypt. Throws "wrong-password" on a bad master password. */
  static async unlock(path: string, master: string): Promise<Vault> {
    let env: Envelope;
    try {
      env = JSON.parse(await readFile(path, "utf8")) as Envelope;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new VaultError("missing", `no vault at ${path}`);
      throw new VaultError("corrupt", `unreadable vault file: ${(e as Error).message}`);
    }
    if (env.v !== 1 || env.kdf?.name !== "scrypt") throw new VaultError("corrupt", "unsupported vault format");
    const key = await deriveKey(master, Buffer.from(env.kdf.salt, "base64"), env.kdf);
    try {
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
      d.setAuthTag(Buffer.from(env.tag, "base64"));
      const json = Buffer.concat([d.update(Buffer.from(env.data, "base64")), d.final()]).toString("utf8");
      const v = new Vault(path, env.kdf);
      v.key = key;
      v.entries = (JSON.parse(json) as { entries: Credential[] }).entries;
      return v;
    } catch {
      // GCM auth failure: either the wrong key or a tampered file — indistinguishable by design.
      throw new VaultError("wrong-password", "wrong master password (or the vault file was modified)");
    }
  }

  static async exists(path: string): Promise<boolean> {
    try {
      await readFile(path);
      return true;
    } catch {
      return false;
    }
  }

  get unlocked(): boolean {
    return this.key !== null;
  }

  /** Forget the key and decrypted entries. The instance is unusable afterwards. */
  lock(): void {
    this.key?.fill(0);
    this.key = null;
    this.entries = [];
  }

  private need(): Buffer {
    if (!this.key) throw new VaultError("locked", "vault is locked");
    return this.key;
  }

  private async save(): Promise<void> {
    const key = this.need();
    const env: Envelope = { v: 1, kdf: this.kdf, ...seal(key, this.entries) };
    // Write-then-rename so a crash never leaves a half-written (undecryptable) vault.
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(env), { mode: 0o600 });
    await rename(tmp, this.path);
    await chmod(this.path, 0o600).catch(() => {});
  }

  /** Add — or, if (origin, username) already exists, update the password in place. */
  async add(c: NewCredential): Promise<CredentialSummary> {
    this.need();
    const origin = normalizeOrigin(c.origin);
    const now = Date.now();
    let e = this.entries.find((x) => x.origin === origin && x.username === c.username);
    if (e) {
      e.password = c.password;
      if (c.notes !== undefined) e.notes = c.notes;
      e.updatedAt = now;
    } else {
      e = { id: randomUUID(), origin, username: c.username, password: c.password, ...(c.notes !== undefined ? { notes: c.notes } : {}), createdAt: now, updatedAt: now };
      this.entries.push(e);
    }
    await this.save();
    return summarize(e);
  }

  /** Metadata for every entry (no secrets), sorted by origin then username. */
  list(): CredentialSummary[] {
    this.need();
    return this.entries.map(summarize).sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username));
  }

  /** Entries whose origin EXACTLY equals the page's origin. Summaries only. */
  find(url: string): CredentialSummary[] {
    this.need();
    let origin: string;
    try {
      origin = normalizeOrigin(url);
    } catch {
      return [];
    }
    return this.list().filter((e) => e.origin === origin);
  }

  /** The secret. Callers must have already matched the origin (see find). */
  get(id: string): Credential {
    this.need();
    const e = this.entries.find((x) => x.id === id);
    if (!e) throw new VaultError("not-found", `no credential ${id}`);
    return { ...e };
  }

  /** Secret for a page, only if its origin matches exactly. Never cross-origin. */
  getFor(url: string, id: string): Credential {
    const c = this.get(id);
    if (normalizeOrigin(url) !== c.origin) throw new VaultError("bad-origin", `credential is for ${c.origin}, not ${normalizeOrigin(url)}`);
    return c;
  }

  async remove(id: string): Promise<void> {
    this.need();
    const n = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length === n) throw new VaultError("not-found", `no credential ${id}`);
    await this.save();
  }

  /** Re-encrypt under a new master password (fresh salt). */
  async changeMaster(next: string): Promise<void> {
    this.need();
    if (next.length < MIN_MASTER) throw new VaultError("weak-password", `master password must be at least ${MIN_MASTER} characters`);
    this.kdf = { name: "scrypt", salt: randomBytes(16).toString("base64"), ...KDF };
    this.key?.fill(0);
    this.key = await deriveKey(next, Buffer.from(this.kdf.salt, "base64"), this.kdf);
    await this.save();
  }
}

function summarize(e: Credential): CredentialSummary {
  const { password: _p, notes: _n, ...rest } = e;
  return rest;
}

const SETS = {
  lower: "abcdefghijkmnopqrstuvwxyz", // no l
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ", // no I, O
  digit: "23456789", // no 0, 1
  symbol: "!@#$%^&*-_=+?",
} as const;

/** Cryptographically random password with at least one of each class. */
export function generatePassword(length = 20, opts: { symbols?: boolean } = {}): string {
  const sets = [SETS.lower, SETS.upper, SETS.digit, ...(opts.symbols === false ? [] : [SETS.symbol])];
  if (length < sets.length) throw new RangeError(`length must be at least ${sets.length}`);
  const all = sets.join("");
  const pick = (chars: string) => chars[randomInt(chars.length)]!;
  const out = sets.map(pick);
  while (out.length < length) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out.join("");
}

// Unbiased random int in [0, n) via rejection sampling.
function randomInt(n: number): number {
  const max = Math.floor(0x1_0000_0000 / n) * n;
  for (;;) {
    const x = randomBytes(4).readUInt32BE(0);
    if (x < max) return x % n;
  }
}

/** Constant-time string compare (used by callers comparing tokens). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
