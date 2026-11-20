/**
 * Signing in to an MCP server with OAuth, the way a desktop app should: authorization code with PKCE (S256), a
 * loopback listener for the redirect, and no client secret. Main process only: tokens never reach a page or the chrome UI.
 *
 *   1. discover  — the server's protected-resource document names its authorization server; that one names the endpoints
 *   2. register  — once per server (dynamic client registration), keeping the client id
 *   3. authorize — open the person's own browser on the consent page; wait for the redirect on 127.0.0.1
 *   4. exchange  — trade the code for an access token (short-lived) and a refresh token
 *   5. refresh   — quietly, shortly before the access token runs out
 *
 * Everything that touches the network goes through an injectable `fetch`, so the whole flow is tested without one.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export class OAuthError extends Error {
  readonly code: "discovery" | "registration" | "denied" | "timeout" | "state" | "token" | "refresh" | "no-port" | "unsafe";
  constructor(code: OAuthError["code"], message: string) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
  }
}

/** Ports the redirect listener may use. All are registered up front, because a server matches redirect addresses exactly. */
export const REDIRECT_PORTS = [53682, 53683, 53684, 53685, 53686];
export const redirectUri = (port: number) => `http://127.0.0.1:${port}/callback`;

export interface ServerMeta {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  scopes: string[];
}

export interface Tokens {
  access: string;
  refresh?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope?: string;
}

const MAX_DOC = 100_000;

/** https anywhere; plain http only to this machine (a server under test). Nothing else may be asked for a token. */
export function assertSafeEndpoint(u: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new OAuthError("unsafe", `${what} is not an address`);
  }
  const loop = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && loop))) throw new OAuthError("unsafe", `${what} must be https (or http to this machine): ${url.origin}`);
  return url;
}

async function getJson(f: Fetch, url: string, what: string): Promise<Record<string, unknown>> {
  assertSafeEndpoint(url, what);
  let res;
  try {
    res = await f(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new OAuthError("discovery", `could not reach ${new URL(url).host} for ${what}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new OAuthError("discovery", `${what} answered ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_DOC) throw new OAuthError("discovery", `${what} is too large`);
  try {
    const j = JSON.parse(text) as unknown;
    if (j && typeof j === "object" && !Array.isArray(j)) return j as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new OAuthError("discovery", `${what} is not a JSON object`);
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Find the authorization server of an MCP server, and its endpoints. */
export async function discover(mcpUrl: string, f: Fetch): Promise<ServerMeta> {
  const base = assertSafeEndpoint(mcpUrl, "the server address");
  const path = base.pathname === "/" ? "" : base.pathname;
  let prm: Record<string, unknown> | null = null;
  for (const candidate of [`${base.origin}/.well-known/oauth-protected-resource${path}`, `${base.origin}/.well-known/oauth-protected-resource`]) {
    try {
      prm = await getJson(f, candidate, "the server's protected-resource document");
      break;
    } catch (e) {
      if (e instanceof OAuthError && e.code === "unsafe") throw e;
    }
  }
  if (!prm) throw new OAuthError("discovery", `${base.host} does not publish how to sign in (no protected-resource document)`);
  const servers = Array.isArray(prm.authorization_servers) ? prm.authorization_servers.filter((x): x is string => typeof x === "string") : [];
  const issuer = servers[0] ?? base.origin;
  const iss = assertSafeEndpoint(issuer, "the authorization server");
  const ipath = iss.pathname === "/" ? "" : iss.pathname;
  let as: Record<string, unknown> | null = null;
  for (const candidate of [`${iss.origin}/.well-known/oauth-authorization-server${ipath}`, `${iss.origin}/.well-known/openid-configuration${ipath}`]) {
    try {
      as = await getJson(f, candidate, "the authorization server's document");
      break;
    } catch (e) {
      if (e instanceof OAuthError && e.code === "unsafe") throw e;
    }
  }
  if (!as) throw new OAuthError("discovery", `${iss.host} does not publish its sign-in endpoints`);
  const authorizationEndpoint = str(as.authorization_endpoint);
  const tokenEndpoint = str(as.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) throw new OAuthError("discovery", "the authorization server did not name its endpoints");
  assertSafeEndpoint(authorizationEndpoint, "the authorization endpoint");
  assertSafeEndpoint(tokenEndpoint, "the token endpoint");
  const methods = Array.isArray(as.code_challenge_methods_supported) ? as.code_challenge_methods_supported : null;
  if (methods && !methods.includes("S256")) throw new OAuthError("discovery", "the server does not support PKCE with S256");
  const reg = str(as.registration_endpoint);
  const rev = str(as.revocation_endpoint);
  if (reg) assertSafeEndpoint(reg, "the registration endpoint");
  if (rev) assertSafeEndpoint(rev, "the revocation endpoint");
  const scopes = Array.isArray(prm.scopes_supported) ? prm.scopes_supported.filter((x): x is string => typeof x === "string") : Array.isArray(as.scopes_supported) ? as.scopes_supported.filter((x): x is string => typeof x === "string") : [];
  return {
    resource: str(prm.resource) ?? mcpUrl,
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    ...(reg ? { registrationEndpoint: reg } : {}),
    ...(rev ? { revocationEndpoint: rev } : {}),
    scopes,
  };
}

/** Register this app with the server (public client, loopback redirects). Returns the client id. */
export async function register(meta: ServerMeta, f: Fetch, appName: string): Promise<string> {
  if (!meta.registrationEndpoint) throw new OAuthError("registration", "this server does not offer registration, so there is no way to sign in without a client id");
  let res;
  try {
    res = await f(meta.registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: appName,
        redirect_uris: REDIRECT_PORTS.map(redirectUri),
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(meta.scopes.length ? { scope: meta.scopes.join(" ") } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new OAuthError("registration", `could not register: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new OAuthError("registration", `registration was refused (${res.status})`);
  let id: string | undefined;
  try {
    id = str((JSON.parse(text) as Record<string, unknown>).client_id);
  } catch {
    /* handled below */
  }
  if (!id) throw new OAuthError("registration", "registration did not return a client id");
  return id;
}

// ---- PKCE ----------------------------------------------------------------------------------------------------------

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function newPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}
export const newState = () => b64url(randomBytes(24));

export function authorizeUrl(meta: ServerMeta, clientId: string, redirect: string, challenge: string, state: string): string {
  const u = new URL(meta.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirect);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  if (meta.scopes.length) u.searchParams.set("scope", meta.scopes.join(" "));
  u.searchParams.set("resource", meta.resource);
  return u.href;
}

// ---- the redirect listener ---------------------------------------------------------------------------------------

const DONE_PAGE = (ok: boolean) =>
  `<!doctype html><meta charset="utf-8"><title>${ok ? "Signed in" : "Not signed in"}</title><body style="font:16px system-ui;padding:48px;max-width:32em;margin:auto"><h2>${ok ? "You are signed in." : "Sign-in did not finish."}</h2><p>${ok ? "You can close this tab and go back to the browser." : "Go back to the browser and try again."}</p>`;

export interface Callback {
  port: number;
  redirectUri: string;
  /** Resolves with the code once the right redirect arrives; rejects on denial, timeout or cancel. */
  code: Promise<string>;
  cancel(): void;
}

/** Listen on 127.0.0.1 only, on the first free registered port. Wrong state or host is ignored, so a stray request cannot end the flow. */
export async function listenForCode(state: string, opts: { timeoutMs?: number; ports?: number[] } = {}): Promise<Callback> {
  const ports = opts.ports ?? REDIRECT_PORTS;
  let server: Server | undefined;
  let chosen = 0;
  let resolveCode!: (c: string) => void;
  let rejectCode!: (e: Error) => void;
  const code = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  code.catch(() => {}); // the caller handles it; never an unhandled rejection
  const stop = () => {
    clearTimeout(timer);
    server?.close();
    server?.closeAllConnections?.();
  };
  const timer: NodeJS.Timeout = setTimeout(() => {
    stop();
    rejectCode(new OAuthError("timeout", "nobody approved the sign-in in time"));
  }, opts.timeoutMs ?? 300_000);
  for (const port of ports) {
    const s = createServer((req, res) => {
      const actual = (s.address() as AddressInfo).port;
      const u = new URL(req.url ?? "/", `http://127.0.0.1:${actual}`);
      const hostOk = req.headers.host === `127.0.0.1:${actual}` || req.headers.host === `localhost:${actual}`;
      if (!hostOk || req.method !== "GET" || u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      if (u.searchParams.get("state") !== state) {
        res.writeHead(400, { "content-type": "text/html" }).end(DONE_PAGE(false));
        return;
      }
      const err = u.searchParams.get("error");
      const c = u.searchParams.get("code");
      res.writeHead(err || !c ? 400 : 200, { "content-type": "text/html", "cache-control": "no-store" }).end(DONE_PAGE(!err && !!c));
      stop();
      if (err) rejectCode(new OAuthError("denied", err === "access_denied" ? "sign-in was declined" : `the server refused the sign-in (${err.slice(0, 60)})`));
      else if (c) resolveCode(c);
      else rejectCode(new OAuthError("denied", "the server sent no code"));
    });
    const ok = await new Promise<boolean>((resolve) => {
      s.once("error", () => resolve(false));
      s.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (ok) {
      server = s;
      chosen = (s.address() as AddressInfo).port; // the same as `port`, except for port 0 (any free one), which tests use
      break;
    }
  }
  if (!server) {
    clearTimeout(timer);
    throw new OAuthError("no-port", `none of the ports ${ports[0]}–${ports[ports.length - 1]} is free for the sign-in redirect`);
  }
  return { port: chosen, redirectUri: redirectUri(chosen), code, cancel: () => (stop(), rejectCode(new OAuthError("denied", "sign-in was cancelled"))) };
}

// ---- tokens ------------------------------------------------------------------------------------------------------

async function tokenRequest(meta: ServerMeta, f: Fetch, params: Record<string, string>, code: "token" | "refresh", now: number): Promise<Tokens> {
  let res;
  try {
    res = await f(meta.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new OAuthError(code, `could not reach the token endpoint: ${(e as Error).message}`);
  }
  const text = await res.text();
  let j: Record<string, unknown> = {};
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* handled below */
  }
  if (!res.ok) throw new OAuthError(code, `the server refused (${res.status}${typeof j.error === "string" ? `: ${j.error.slice(0, 60)}` : ""})`);
  const access = str(j.access_token);
  if (!access) throw new OAuthError(code, "the server returned no access token");
  const expires = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in : 3600;
  return { access, ...(str(j.refresh_token) ? { refresh: str(j.refresh_token) as string } : {}), expiresAt: now + expires * 1000, ...(str(j.scope) ? { scope: str(j.scope) as string } : {}) };
}

export const exchangeCode = (meta: ServerMeta, f: Fetch, a: { clientId: string; code: string; verifier: string; redirect: string }, now = Date.now()) =>
  tokenRequest(meta, f, { grant_type: "authorization_code", code: a.code, redirect_uri: a.redirect, client_id: a.clientId, code_verifier: a.verifier, resource: meta.resource }, "token", now);

/** A refresh may or may not return a new refresh token; when it does not, the old one stays good. */
export async function refreshTokens(meta: ServerMeta, f: Fetch, a: { clientId: string; refresh: string }, now = Date.now()): Promise<Tokens> {
  const t = await tokenRequest(meta, f, { grant_type: "refresh_token", refresh_token: a.refresh, client_id: a.clientId, resource: meta.resource }, "refresh", now);
  return t.refresh ? t : { ...t, refresh: a.refresh };
}

/** Best effort: tell the server to forget a token. Never throws. */
export async function revoke(meta: ServerMeta, f: Fetch, clientId: string, token: string): Promise<boolean> {
  if (!meta.revocationEndpoint) return false;
  try {
    const res = await f(meta.revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_id: clientId }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
