/**
 * The browser's network transport: a fetch-shaped function built on Electron's
 * `net.request`, whose ONE job beyond fetching is to NOT follow redirects itself.
 *
 * Why not `net.fetch`: inside `protocol.handle` every response we return is the final
 * answer for the renderer's request. If we follow a 3xx internally, the renderer never
 * learns it was redirected — the page shows the destination's content under the
 * ORIGINAL url and origin. That breaks the address bar, relative links, same-origin
 * checks and password-manager origin matching, and it silently dodges the per-request
 * payment decision for the redirect target. `net.fetch` can't help: with
 * `redirect: "manual"` it throws "Redirect was cancelled" and its Response carries no
 * redirect information.
 *
 * `net.request` can: with `redirect: "manual"` it emits a `redirect` event (status,
 * target, headers) and cancels the request unless `followRedirect()` is called. We never
 * call it. Instead we return the 3xx as a normal Response (`Location` set to the absolute
 * target), the renderer re-requests that URL, and the re-request re-enters our
 * `protocol.handle` handler — so every hop gets its own payment decision, and the page's
 * URL/origin are always the ones the user is actually looking at.
 *
 * Cookies: `useSessionCookies` + `credentials: "include"` make the request read and write
 * the session's cookie jar exactly like a fetch would — including `Set-Cookie` on the 3xx
 * itself, which bot checks such as Anubis depend on.
 *
 * Recursion: `net.request`, like `net.fetch`, IS routed through our own `protocol.handle`
 * handler — without a bypass it would call us back forever. `net.fetch` avoids that with a
 * `bypassCustomProtocolHandlers` option; `net.request` has no public equivalent, but
 * Electron implements `net.fetch` ON TOP of `ClientRequest` and sets the same flag on the
 * request's private `_urlLoaderOptions`. We do exactly what Electron does. That is a
 * private field, so `assertBypassAvailable()` fails loudly at startup if a future Electron
 * removes it, and the end-to-end transport tests cover it.
 */

import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { net, session, type Session } from "electron";
import { chromiumRequestHeaders, type Hints } from "./compat.js";
import type { RawFetch } from "./intercept.js";

/**
 * The engine's own client-hint values (from `navigator.userAgentData`), reported once by the
 * main process after the chrome window loads. Requests wait briefly for it so the very first
 * page load already carries hints that match what the page's JS will report; if it never
 * arrives we proceed without hints rather than block browsing.
 */
let hintsValue: Hints | null = null;
let resolveHints: (h: Hints | null) => void = () => {};
const hintsReady = new Promise<Hints | null>((resolve) => {
  resolveHints = resolve;
  setTimeout(() => resolve(null), 3000).unref?.();
});
export function setClientHints(h: Hints | null): void {
  hintsValue = h;
  resolveHints(h);
}

/**
 * Progress of every request through this transport, for the UI ("waiting for…", "receiving 1.2 MB…",
 * "redirecting…"). Listen on the "event" channel. We can only report what is observable here — request
 * out, response headers in, body bytes, redirect, error; DNS/TCP/TLS happen inside Chromium and are
 * invisible, so they are folded into "waiting".
 */
export interface NetEvent {
  id: number;
  url: string;
  type: "start" | "headers" | "progress" | "end" | "redirect" | "error";
  status?: number;
  /** Content-Length when the server sent one. */
  total?: number;
  /** Body bytes received so far (progress/end). */
  bytes?: number;
  location?: string;
  error?: string;
}
export const netEvents = new EventEmitter();
let netSeq = 0;
const emitNet = (e: NetEvent) => netEvents.emit("event", e);

/** Headers the network stack owns (or that would leak/duplicate state) — never copy these onto the request. */
const REQUEST_HEADERS_WE_DONT_SET = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "proxy-connection",
  "accept-encoding", // the network stack negotiates (and decodes) this itself
  "cookie", // comes from the session's cookie jar via useSessionCookies
]);

/** Statuses that must not carry a body in a Response. */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

function toHeaders(src: Record<string, string | string[] | undefined>, drop: ReadonlySet<string> = new Set()): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined || drop.has(k.toLowerCase())) continue;
    for (const one of Array.isArray(v) ? v : [v]) {
      try {
        out.append(k, one);
      } catch {
        /* a header name/value the Headers class rejects — drop it rather than fail the page */
      }
    }
  }
  return out;
}

/** The private option Electron's own net.fetch sets on a ClientRequest to skip protocol handlers. */
type WithLoaderOptions = { _urlLoaderOptions?: { bypassCustomProtocolHandlers?: boolean } };

function bypassProtocolHandlers(req: unknown): void {
  const opts = (req as WithLoaderOptions)._urlLoaderOptions;
  if (!opts) {
    // Fail loudly: silently continuing would recurse into our own handler and hang every page.
    throw new Error("Electron changed ClientRequest internals (_urlLoaderOptions is gone); update transport.ts");
  }
  opts.bypassCustomProtocolHandlers = true;
}

export function netRequestFetch(ses: Session = session.defaultSession): RawFetch {
  return async (input: Request): Promise<Response> => {
    // Buffer the request body: simplest correct thing for ClientRequest, and bodies here are form posts/API calls.
    const body = input.body ? Buffer.from(await input.arrayBuffer()) : null;
    // What a real Chromium would send (client hints + fetch metadata) — net.request doesn't add them.
    const headers = chromiumRequestHeaders(new URL(input.url), input.headers, hintsValue ?? (await hintsReady), {
      referrer: input.referrer,
      referrerPolicy: input.referrerPolicy,
    });

    const id = ++netSeq;
    const url = input.url;
    emitNet({ id, url, type: "start" });
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return; // e.g. the "Redirect was cancelled" error that follows a handed-back 3xx
        settled = true;
        fn();
      };

      const req = net.request({
        method: input.method,
        url: input.url,
        session: ses,
        redirect: "manual",
        credentials: "include",
        useSessionCookies: true,
      });

      bypassProtocolHandlers(req);

      headers.forEach((value, name) => {
        if (REQUEST_HEADERS_WE_DONT_SET.has(name.toLowerCase())) return;
        try {
          req.setHeader(name, value);
        } catch {
          /* Chromium refuses a few restricted headers — the request still goes out without them */
        }
      });

      // A redirect: hand it to the renderer. We deliberately do NOT call req.followRedirect();
      // the request is cancelled, and the renderer re-requests `redirectUrl` through us.
      req.on("redirect", (status, _method, redirectUrl, headers) => {
        const h = toHeaders(headers, new Set(["set-cookie"])); // already stored by the network stack
        h.set("location", redirectUrl);
        emitNet({ id, url, type: "redirect", status, location: redirectUrl });
        settle(() => resolve(new Response(null, { status, headers: h })));
      });

      req.on("response", (incoming) => {
        // Electron documents IncomingMessage as a Readable stream; its typings just don't say so.
        const res = incoming as typeof incoming & Readable;
        const status = res.statusCode;
        const headers = toHeaders(res.headers); // passed through untouched, as Electron's own net.fetch does
        const total = Number(res.headers["content-length"]);
        emitNet({ id, url, type: "headers", status, ...(Number.isFinite(total) ? { total } : {}) });
        let body: ReadableStream<Uint8Array> | null = null;
        if (NULL_BODY_STATUS.has(status) || input.method === "HEAD") {
          res.on("data", () => {});
          emitNet({ id, url, type: "end", bytes: 0 });
        } else {
          // Count bytes in a pass-through stage (a 'data' listener on `res` would steal chunks from toWeb).
          let bytes = 0;
          let lastEmit = 0;
          body = (Readable.toWeb(res) as ReadableStream<Uint8Array>).pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                bytes += chunk.byteLength;
                const now = Date.now();
                if (now - lastEmit > 120) {
                  lastEmit = now;
                  emitNet({ id, url, type: "progress", bytes });
                }
                controller.enqueue(chunk);
              },
              flush() {
                emitNet({ id, url, type: "end", bytes });
              },
            }),
          ); // handles backpressure and cancellation
        }
        settle(() => resolve(new Response(body, { status, statusText: res.statusMessage, headers })));
      });

      req.on("error", (e) => {
        if (!settled) emitNet({ id, url, type: "error", error: e.message });
        settle(() => reject(e));
      });

      input.signal.addEventListener("abort", () => {
        req.abort();
        if (!settled) emitNet({ id, url, type: "error", error: "aborted" });
        settle(() => reject(new DOMException("The operation was aborted.", "AbortError")));
      });

      if (body) req.end(body);
      else req.end();
    });
  };
}
