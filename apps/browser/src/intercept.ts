/**
 * The https interception core — deliberately Electron-free so it can be unit-tested
 * without a display.
 *
 * In Electron this is wired via `protocol.handle('https', handler)`: once we handle
 * https, EVERY https request in the browser flows through here, and we are responsible
 * for actually fetching the content ourselves. That is exactly the hook x402 needs —
 * see a 402, sign, retry, hand back the paid response — and it is the thing an MV3
 * extension structurally cannot do.
 *
 * Two subtleties this module exists to get right:
 *
 *  1. Recursion. The engine fetches the network using a `fetch` we supply. If that
 *     fetch is Electron's plain `net.fetch`, it re-enters THIS handler and loops
 *     forever. The main process must pass a fetch that bypasses custom protocol
 *     handlers; `bypassingFetch()` documents and enforces that contract.
 *
 *  2. topOrigin. Budgets are scoped to (page the user is looking at × origin being
 *     paid). A subresource must be billed against ITS PAGE, never itself, or the
 *     pair-scoped rate cap is meaningless. We derive that page origin from the
 *     request's referrer.
 */

import type { X402Engine } from "@dbbasic/x402-engine";

/** A fetch that goes straight to the network without re-entering our protocol handler. */
export type RawFetch = (input: Request) => Promise<Response>;

/**
 * The origin of the page that initiated this request, used to scope budgets.
 * Top-level navigations have no referrer → "" (their own budget scope), which is
 * correct: the user chose to go there.
 */
export function topOriginOf(request: Request): string {
  // WHATWG Request.referrer, then the Referer header as a fallback.
  const ref = request.referrer && request.referrer !== "about:client" ? request.referrer : request.headers.get("referer");
  if (!ref) return "";
  try {
    return new URL(ref).origin;
  } catch {
    return "";
  }
}

/**
 * Wrap a network fetch (Electron's `net.fetch`) so the engine's internal requests go
 * straight to the wire instead of looping back through `protocol.handle('https')`.
 * `bypass` is the function that sets Electron's bypassCustomProtocolHandlers flag; we
 * take it as a parameter so this module never imports electron.
 */
export function bypassingFetch(bypass: (input: Request) => Promise<Response>): RawFetch {
  return (input: Request) => bypass(input);
}

/**
 * Build the `protocol.handle('https', ...)` handler. Every https request in the
 * browser is routed through the engine, which pays any 402 transparently and returns
 * the final response for the renderer to display.
 */
export function createPaymentHandler(engine: X402Engine): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const { response } = await engine.fetch(request, topOriginOf(request));
    return response;
  };
}
