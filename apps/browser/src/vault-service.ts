/**
 * Main-process glue between @dbbasic/vault and the browser.
 *
 * Design rule: secrets never enter the chrome UI's renderer. The page's preload sends a
 * submitted login straight to us; we hold it in memory as a pending offer and the UI
 * only learns "there is something to save for <origin>". Filling is the reverse — the UI
 * says "fill credential X into tab Y" and we deliver it to that page ourselves, after
 * checking the page's REAL origin (webContents.getURL), never one supplied by the UI.
 */

import { ipcMain, webContents, type BrowserWindow, type WebContents } from "electron";
import { Vault, VaultError, generatePassword, normalizeOrigin, type CredentialSummary } from "@dbbasic/vault";

const IDLE_LOCK_MS = 10 * 60_000;
const PENDING_TTL_MS = 2 * 60_000;

export type VaultResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

interface Pending {
  origin: string;
  username: string;
  password: string;
  at: number;
}

export interface VaultState {
  exists: boolean;
  unlocked: boolean;
  count: number | null;
}

export interface VaultService {
  state(): Promise<VaultState>;
  fill(wcId: number, id: string | undefined, submit: boolean): Promise<VaultResult<{ username: string; origin: string }>>;
  /** Unlock for automation without a UI prompt (master from env). */
  unlock(master: string): Promise<VaultResult<VaultState>>;
}

async function wrap<T>(fn: () => Promise<T> | T): Promise<VaultResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof VaultError) return { ok: false, code: e.code, message: e.message };
    return { ok: false, code: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

export function registerVault(opts: { path: string; getWindow: () => BrowserWindow | null }): VaultService {
  let vault: Vault | null = null;
  let lockTimer: NodeJS.Timeout | undefined;
  const pending = new Map<number, Pending>(); // keyed by guest webContents id

  const win = () => opts.getWindow();
  const isOurGuest = (wc: WebContents | undefined): wc is WebContents => {
    const w = win();
    return !!wc && !wc.isDestroyed() && wc.getType() === "webview" && !!w && wc.hostWebContents === w.webContents;
  };
  const need = (): Vault => {
    if (!vault?.unlocked) throw new VaultError("locked", "vault is locked");
    touch();
    return vault;
  };

  async function state(): Promise<VaultState> {
    return { exists: await Vault.exists(opts.path), unlocked: !!vault?.unlocked, count: vault?.unlocked ? vault.list().length : null };
  }
  const push = async () => win()?.webContents.send("vault:state", await state());

  function lock(): void {
    clearTimeout(lockTimer);
    vault?.lock();
    vault = null;
    void push();
  }
  function touch(): void {
    clearTimeout(lockTimer);
    lockTimer = setTimeout(lock, IDLE_LOCK_MS); // idle auto-lock
  }
  const adopt = async (v: Vault) => {
    vault = v;
    touch();
    await push();
    return state();
  };

  const originOf = (wc: WebContents) => {
    try {
      return normalizeOrigin(wc.getURL());
    } catch {
      return null; // about:blank, file:, … — never has credentials
    }
  };

  // ---- from the chrome UI --------------------------------------------------
  ipcMain.handle("vault:state", () => state());
  ipcMain.handle("vault:create", (_e, master: string) => wrap(async () => adopt(await Vault.create(opts.path, String(master)))));
  ipcMain.handle("vault:unlock", (_e, master: string) => wrap(async () => adopt(await Vault.unlock(opts.path, String(master)))));
  ipcMain.handle("vault:lock", () => lock());
  ipcMain.handle("vault:list", (_e, wcId?: number) =>
    wrap(() => {
      const v = need();
      if (wcId == null) return v.list();
      const wc = webContents.fromId(wcId);
      const origin = isOurGuest(wc) ? originOf(wc) : null;
      return origin ? v.find(origin) : [];
    }),
  );
  ipcMain.handle("vault:generate", (_e, len?: number) => generatePassword(Math.min(Math.max(Number(len) || 20, 8), 64)));
  ipcMain.handle("vault:remove", (_e, id: string) => wrap(async () => { await need().remove(String(id)); await push(); }));

  // Manual add for the page in tab `wcId` (origin comes from the page, not the UI).
  ipcMain.handle("vault:add", (_e, a: { wcId: number; username: string; password: string }) =>
    wrap(async () => {
      const wc = webContents.fromId(a.wcId);
      const origin = isOurGuest(wc) ? originOf(wc) : null;
      if (!origin) throw new VaultError("bad-origin", "this page can't hold credentials");
      const s = await need().add({ origin, username: String(a.username), password: String(a.password) });
      await push();
      return s;
    }),
  );

  ipcMain.handle("vault:accept", (_e, wcId: number) =>
    wrap(async () => {
      const p = pending.get(wcId);
      if (!p || Date.now() - p.at > PENDING_TTL_MS) throw new VaultError("not-found", "nothing to save (offer expired)");
      const s = await need().add({ origin: p.origin, username: p.username, password: p.password });
      pending.delete(wcId);
      await push();
      return s;
    }),
  );
  ipcMain.handle("vault:dismiss", (_e, wcId: number) => void pending.delete(wcId));
  ipcMain.handle("vault:fill", (_e, a: { wcId: number; id: string; submit?: boolean }) => fill(a.wcId, a.id, !!a.submit));

  // ---- from the pages (guest preload) --------------------------------------
  ipcMain.on("vault:form", (e) => {
    const wc = e.sender;
    if (!isOurGuest(wc) || !vault?.unlocked) return;
    const origin = originOf(wc);
    const matches = origin ? vault.find(origin) : [];
    if (matches.length) win()?.webContents.send("vault:offer", { kind: "fill", wcId: wc.id, origin, matches });
  });

  ipcMain.on("vault:submit", async (e, p: { username?: string; password?: string }) => {
    const wc = e.sender;
    if (!isOurGuest(wc) || !p?.password) return;
    const origin = originOf(wc);
    if (!origin) return;
    const username = String(p.username ?? "");
    const password = String(p.password);

    let mode: "new" | "update" | "locked" | "no-vault" = "new";
    if (!(await Vault.exists(opts.path))) mode = "no-vault";
    else if (!vault?.unlocked) mode = "locked";
    else {
      const existing = vault.find(origin).find((c) => c.username === username);
      if (existing) {
        if (vault.get(existing.id).password === password) return; // already saved, nothing to offer
        mode = "update";
      }
    }
    pending.set(wc.id, { origin, username, password, at: Date.now() });
    setTimeout(() => {
      const cur = pending.get(wc.id);
      if (cur && Date.now() - cur.at >= PENDING_TTL_MS) pending.delete(wc.id);
    }, PENDING_TTL_MS + 1000);
    win()?.webContents.send("vault:offer", { kind: "save", wcId: wc.id, origin, username, mode });
  });

  async function fill(wcId: number, id: string | undefined, submit: boolean) {
    return wrap(() => {
      const wc = webContents.fromId(wcId);
      if (!isOurGuest(wc)) throw new VaultError("not-found", "no such tab");
      const v = need();
      const origin = originOf(wc);
      if (!origin) throw new VaultError("bad-origin", "this page can't hold credentials");
      let credId = id;
      if (!credId) {
        const m = v.find(origin);
        if (m.length !== 1) throw new VaultError("not-found", m.length ? `${m.length} saved logins match — pass an id` : "no saved login for this site");
        credId = m[0]!.id;
      }
      const c = v.getFor(wc.getURL(), credId); // throws if the credential is for another origin
      wc.send("vault:fill", { origin: c.origin, username: c.username, password: c.password, submit });
      return { username: c.username, origin: c.origin };
    });
  }

  return { state, fill, unlock: (m) => wrap(async () => adopt(await Vault.unlock(opts.path, m))) };
}

export type { CredentialSummary };
