/**
 * A network layer the CALLER supplies.
 *
 * Normally the browser fetches every request itself (transport.ts). In this mode it makes none: each request a page
 * would make is parked here and handed to the caller (through the automation API), which answers it with a response
 * or refuses it with a reason. The browser then does with that answer exactly what it would do with a network one:
 * a 3xx goes back to the page, which asks again (so every hop is the caller's decision), and a refusal ends the load
 * with the reason the caller gave.
 *
 *   - Nothing is fetched here, retried, or remembered. State (cookies, caches, pacing) is the caller's.
 *   - Waiting on the caller is not "a slow server": it has its own state, and ONE upper bound that the caller sets.
 *     Past the bound the request fails with its own reason ("caller-silent"), so a caller that never answers cannot
 *     hang a load for ever.
 *   - A main document the caller already fetched can be loaded as it is (`registerDocument`): it comes with its final
 *     address, status, headers and the redirects that led to it, so relative links resolve against the right address
 *     and the facts list the redirects even though this browser never saw them.
 *
 * No electron import: the pieces it needs from the browser are handed in, so it can be tested on its own.
 */

import type { FailureKind } from "./settle.js";
import { FAILURE_KINDS } from "./settle.js";
import type { NetEvent } from "./transport.js";

export const DEFAULT_ANSWER_TIMEOUT_MS = 20_000;
const MIN_ANSWER_TIMEOUT_MS = 1_000;
const MAX_ANSWER_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const DOCUMENT_TTL_MS = 60_000;

/** A request waiting for the caller. */
export interface ParkedRequest {
  id: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Base64 request body, for methods that have one. */
  bodyBase64?: string;
  /** The address of the page this request follows (its referrer), "" for a first visit. Lets the caller treat a move the page made itself as the same visit. */
  follows: string;
  /** What it is for ("document", "image", "script"…), when the browser knows. */
  destination: string;
  /** True for a top-level navigation. */
  navigate: boolean;
  waitingMs: number;
}

export interface Answer {
  status: number;
  statusText?: string;
  headers?: Record<string, string | string[]>;
  bodyBase64?: string;
  bodyText?: string;
}

/** A main document the caller already has. */
export interface Document extends Answer {
  /** The address the document finally came from: relative links resolve against it. */
  url: string;
  /** The redirects that led to it, in order. */
  redirects?: Array<{ status?: number; to: string }>;
}

export class ProviderError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Headers that describe how a body was TRANSPORTED. The body handed over is the body to show, so they never apply. */
const DROPPED_HEADERS = new Set(["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive", "set-cookie", "set-cookie2"]);
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

export const normUrl = (u: string): string => {
  try {
    return new URL(u).href;
  } catch {
    return u;
  }
};

/** Turn a caller's answer into a Response, validating everything the caller sent. */
export function buildResponse(requestUrl: string, a: Answer, method = "GET"): { response: Response; bytes: number } {
  if (!a || typeof a !== "object") throw new ProviderError("bad-params", "an answer is an object with a status");
  const status = a.status;
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new ProviderError("bad-params", "status must be a whole number from 200 to 599");
  if (a.bodyBase64 !== undefined && a.bodyText !== undefined) throw new ProviderError("bad-params", "give bodyBase64 or bodyText, not both");
  let body: Buffer | null = null;
  if (a.bodyBase64 !== undefined) {
    if (typeof a.bodyBase64 !== "string" || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(a.bodyBase64)) throw new ProviderError("bad-params", "bodyBase64 is not valid base64");
    body = Buffer.from(a.bodyBase64, "base64");
  } else if (a.bodyText !== undefined) {
    if (typeof a.bodyText !== "string") throw new ProviderError("bad-params", "bodyText must be a string");
    body = Buffer.from(a.bodyText, "utf8");
  }
  if (body && body.byteLength > MAX_BODY_BYTES) throw new ProviderError("too-large", `a body can be at most ${MAX_BODY_BYTES} bytes`);

  const headers = new Headers();
  if (a.headers !== undefined) {
    if (!a.headers || typeof a.headers !== "object" || Array.isArray(a.headers)) throw new ProviderError("bad-params", "headers must be an object of name → value");
    for (const [k, v] of Object.entries(a.headers)) {
      if (DROPPED_HEADERS.has(k.toLowerCase())) continue;
      for (const one of Array.isArray(v) ? v : [v]) {
        if (typeof one !== "string") throw new ProviderError("bad-params", `header ${k} must be text`);
        try {
          headers.append(k, one);
        } catch {
          throw new ProviderError("bad-params", `header ${k} is not a valid header`);
        }
      }
    }
  }
  if (status >= 300 && status < 400 && headers.has("location")) {
    // The page resolves a relative Location itself, but the facts and the events want it absolute.
    try {
      headers.set("location", new URL(headers.get("location")!, requestUrl).href);
    } catch {
      /* leave it as the caller gave it */
    }
  }
  const nullBody = NULL_BODY_STATUS.has(status) || method === "HEAD" || (status >= 300 && status < 400 && !body);
  return {
    response: new Response(nullBody ? null : (body as unknown as BodyInit), { status, statusText: a.statusText ?? "", headers }),
    bytes: nullBody ? 0 : (body?.byteLength ?? 0),
  };
}

/**
 * What a request is for. The request object a protocol handler gets carries no mode or destination, so this reads the
 * two headers Chromium itself sets: only a navigation sends Upgrade-Insecure-Requests, and Accept says what a
 * subresource is. Best effort; "" means the browser did not say.
 */
export function kindOf(h: Record<string, string>): { navigate: boolean; destination: string } {
  if (h["upgrade-insecure-requests"]) return { navigate: true, destination: "document" };
  const a = h["accept"] ?? "";
  if (/^image\//.test(a)) return { navigate: false, destination: "image" };
  if (/^text\/css/.test(a)) return { navigate: false, destination: "style" };
  return { navigate: false, destination: "" };
}

export function clampAnswerTimeout(ms: unknown): number {
  const n = Number(ms);
  if (!Number.isFinite(n)) return DEFAULT_ANSWER_TIMEOUT_MS;
  return Math.min(MAX_ANSWER_TIMEOUT_MS, Math.max(MIN_ANSWER_TIMEOUT_MS, Math.round(n)));
}

interface Entry {
  req: ParkedRequest;
  since: number;
  timer: NodeJS.Timeout;
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
}

export class CallerNetwork {
  enabled = false;
  userAgent = "";
  answerTimeoutMs = DEFAULT_ANSWER_TIMEOUT_MS;
  private parked = new Map<number, Entry>();
  private waiters = new Set<() => void>();
  private documents = new Map<string, { doc: Document; expires: number }>();
  private emit: (e: NetEvent) => void;
  private nextId: () => number;

  constructor(emit: (e: NetEvent) => void, nextId: () => number) {
    this.emit = emit;
    this.nextId = nextId;
  }

  /** Is a document the caller already has waiting for this address? */
  hasDocumentFor(url: string): boolean {
    const hit = this.documents.get(normUrl(url));
    return !!hit && hit.expires >= Date.now();
  }

  /** Is a request for this address waiting on the caller right now? */
  isParked(url: string): boolean {
    const u = normUrl(url);
    for (const e of this.parked.values()) if (normUrl(e.req.url) === u) return true;
    return false;
  }

  parkedCount(): number {
    return this.parked.size;
  }

  /** What the browser calls instead of fetching. */
  async fetch(input: Request): Promise<Response> {
    // A document the caller already has is served as it is, once.
    const doc = this.takeDocument(input.url, input.method);
    if (doc) return this.serveDocument(input.url, doc);

    const hasBody = !!input.body && input.method !== "GET" && input.method !== "HEAD";
    const bodyBuf = hasBody ? Buffer.from(await input.arrayBuffer()) : null;
    if (bodyBuf && bodyBuf.byteLength > MAX_BODY_BYTES) throw this.refuse(input.url, "other", "request body too large to hand over", "observed");

    const headers: Record<string, string> = {};
    input.headers.forEach((v, k) => (headers[k] = v));
    headers["user-agent"] = this.userAgent; // the caller's identity, never the desktop browser's
    const referrer = input.referrer && input.referrer !== "about:client" ? input.referrer : (input.headers.get("referer") ?? "");

    const id = this.nextId();
    this.emit({ id, url: input.url, type: "start" });
    return new Promise<Response>((resolve, reject) => {
      const req: ParkedRequest = {
        id,
        url: input.url,
        method: input.method,
        headers,
        ...(bodyBuf ? { bodyBase64: bodyBuf.toString("base64") } : {}),
        follows: referrer,
        ...kindOf(headers),
        waitingMs: 0,
      };
      const timer = setTimeout(() => this.failEntry(id, "caller-silent", `the caller did not answer within ${this.answerTimeoutMs} ms`, "observed"), this.answerTimeoutMs);
      timer.unref?.();
      this.parked.set(id, { req, since: Date.now(), timer, resolve, reject });
      input.signal.addEventListener("abort", () => {
        const e = this.parked.get(id);
        if (!e) return;
        clearTimeout(e.timer);
        this.parked.delete(id);
        this.emit({ id, url: input.url, type: "error", error: "aborted" });
        e.reject(new DOMException("The operation was aborted.", "AbortError"));
      });
      for (const w of [...this.waiters]) w();
    });
  }

  /** Requests waiting for the caller, those after `afterId`. Waits up to `waitMs` for one to arrive. */
  async pending(afterId: number, waitMs: number): Promise<ParkedRequest[]> {
    const snapshot = () => [...this.parked.values()].filter((e) => e.req.id > afterId).map((e) => ({ ...e.req, waitingMs: Date.now() - e.since }));
    let out = snapshot();
    if (out.length || waitMs <= 0) return out;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, Math.min(waitMs, 30_000));
      this.waiters.add(done);
    });
    out = snapshot();
    return out;
  }

  answer(id: number, a: Answer): void {
    const e = this.parked.get(id);
    if (!e) throw new ProviderError("no-request", `no request ${id} is waiting (answered already, timed out, or aborted)`);
    const { response, bytes } = buildResponse(e.req.url, a, e.req.method); // throws before anything changes if the answer is bad
    clearTimeout(e.timer);
    this.parked.delete(id);
    this.emitAnswer(id, e.req.url, response, bytes);
    e.resolve(response);
  }

  /** Refuse a request with a reason from the shared list. */
  fail(id: number, kind: unknown, detail?: unknown): void {
    if (typeof kind !== "string" || !(FAILURE_KINDS as readonly string[]).includes(kind) || kind === "caller-silent") {
      throw new ProviderError("bad-params", `kind must be one of: ${FAILURE_KINDS.filter((k) => k !== "caller-silent").join(", ")}`);
    }
    if (!this.parked.has(id)) throw new ProviderError("no-request", `no request ${id} is waiting (answered already, timed out, or aborted)`);
    this.failEntry(id, kind as FailureKind, typeof detail === "string" ? detail.slice(0, 300) : "refused by the caller", "caller");
  }

  /** Refuse every waiting request (used when the mode is turned off). */
  failAll(kind: FailureKind, detail: string): void {
    for (const id of [...this.parked.keys()]) this.failEntry(id, kind, detail, "observed");
  }

  /** Load a main document the caller already has. It is served once, when the browser asks for that address. */
  registerDocument(doc: Document): void {
    const answer = buildResponse(doc.url, doc); // validates it now, so a bad document is an error to the caller, not a broken page
    void answer;
    if (!/^https?:\/\//i.test(doc.url)) throw new ProviderError("bad-params", "url must be an http(s) address");
    const redirects = doc.redirects ?? [];
    if (!Array.isArray(redirects) || redirects.some((r) => !r || typeof r.to !== "string" || (r.status !== undefined && !Number.isInteger(r.status)))) throw new ProviderError("bad-params", "redirects must be a list of {status, to}");
    this.documents.set(normUrl(doc.url), { doc: { ...doc, redirects }, expires: Date.now() + DOCUMENT_TTL_MS });
  }

  private takeDocument(url: string, method: string): Document | null {
    const now = Date.now();
    for (const [k, v] of this.documents) if (v.expires < now) this.documents.delete(k);
    if (method !== "GET") return null;
    const key = normUrl(url);
    const hit = this.documents.get(key);
    if (!hit) return null;
    this.documents.delete(key);
    return hit.doc;
  }

  private serveDocument(url: string, doc: Document): Response {
    const id = this.nextId();
    this.emit({ id, url, type: "start" });
    const { response, bytes } = buildResponse(url, doc);
    this.emitAnswer(id, url, response, bytes);
    return response;
  }

  private emitAnswer(id: number, url: string, response: Response, bytes: number): void {
    const ct = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const loc = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && loc) this.emit({ id, url, type: "redirect", status: response.status, location: loc });
    else {
      this.emit({ id, url, type: "headers", status: response.status, total: bytes, ...(ct ? { contentType: ct } : {}) });
      this.emit({ id, url, type: "end", bytes });
    }
  }

  private failEntry(id: number, kind: FailureKind, detail: string, source: "observed" | "caller"): void {
    const e = this.parked.get(id);
    if (!e) return;
    clearTimeout(e.timer);
    this.parked.delete(id);
    this.emit({ id, url: e.req.url, type: "error", error: `${detail}`, failureKind: kind, failureSource: source });
    e.reject(new Error(`caller:${kind}: ${detail}`));
  }

  /** A failure raised before anything was parked. */
  private refuse(url: string, kind: FailureKind, detail: string, source: "observed" | "caller"): Error {
    this.emit({ id: this.nextId(), url, type: "error", error: detail, failureKind: kind, failureSource: source });
    return new Error(`caller:${kind}: ${detail}`);
  }
}
