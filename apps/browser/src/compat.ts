/**
 * How the browser presents itself to web servers — kept Electron-free so it is unit-tested.
 *
 * Two jobs:
 *
 * 1. `brandedUserAgent`: a Chromium-compatible User-Agent that says honestly who we are.
 *    Electron's default UA carries an `Electron/x.y.z` token (which many WAFs treat as
 *    "embedded automation, not a browser") and an app token showing ELECTRON's version
 *    rather than ours. We drop both and append our own product token with a link to
 *    dbbasic.com — the same convention Edge ("Edg/…"), Opera ("OPR/…") and Vivaldi use.
 *    We do NOT claim to be Firefox or Chrome: the engine is Chromium, and a UA that
 *    contradicts the client hints, the JS APIs and the TLS fingerprint is worse for
 *    compatibility than an honest Chromium-based UA, besides being untrue.
 *
 * 2. `chromiumRequestHeaders`: our transport (src/transport.ts) builds requests with
 *    net.request, which does not add what Chromium's own loader would: client hints
 *    (`sec-ch-ua*`) and correct fetch metadata (`sec-fetch-*`). A server that compares the
 *    HTTP headers with what the page's own JS reports (`navigator.userAgentData`) sees a
 *    contradiction — the classic "this is not a real browser" tell — and may refuse the
 *    page. This restores what a real Chromium navigation sends.
 */

export interface Product {
  name: string;
  version: string;
  url: string;
}

/** `Chrome/130.0.6723.191` → 130, or null. */
export function chromeMajor(ua: string): number | null {
  const m = /\bChrome\/(\d+)\./.exec(ua);
  return m ? Number(m[1]) : null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Electron's UA minus its `Electron/x` token and its app-name token, plus
 * `<name>/<version> (+<url>)` at the end.
 */
export function brandedUserAgent(baseUA: string, product: Product): string {
  const cleaned = baseUA
    .replace(/\s+Electron\/\S+/g, "")
    .replace(new RegExp(`\\s+${escapeRe(product.name)}\\/\\S+`, "g"), "")
    .replace(new RegExp(`\\s*\\(\\+${escapeRe(product.url)}\\)`, "g"), "") // our own earlier link
    .trim();
  return `${cleaned} ${product.name}/${product.version} (+${product.url})`;
}

/** What the engine itself reports in `navigator.userAgentData` — the source of truth for client hints. */
export interface Hints {
  brands: Array<{ brand: string; version: string }>;
  platform: string;
  mobile: boolean;
}

const sfv = (s: string) => `"${s.replace(/["\\]/g, "\\$&")}"`;

export function secChUa(h: Hints): string {
  return h.brands.map((b) => `${sfv(b.brand)};v=${sfv(b.version)}`).join(", ");
}

/** Chrome only sends client hints / fetch metadata to potentially trustworthy origins. */
export function isTrustworthy(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || /^127(\.\d+){3}$/.test(url.hostname) || url.hostname === "[::1]");
}

const registrableish = (h: string) => h.split(".").slice(-2).join(".");

function siteRelation(target: URL, initiator: URL | null): "none" | "same-origin" | "same-site" | "cross-site" {
  if (!initiator) return "none";
  if (initiator.origin === target.origin) return "same-origin";
  // Good-enough "same site" (eTLD+1 is approximated by the last two labels; the worst case is
  // calling a same-site request cross-site on multi-part public suffixes like .co.uk).
  if (initiator.protocol === target.protocol && registrableish(initiator.hostname) === registrableish(target.hostname)) return "same-site";
  return "cross-site";
}

function parseUrl(v: string | null): URL | null {
  if (!v) return null;
  try {
    return new URL(v);
  } catch {
    return null;
  }
}

/**
 * The `Referer` header a browser sends, per the page's referrer policy. Chromium gives the
 * handler the referrer as a Request PROPERTY and expects the network layer to turn it into
 * a header; through our own transport that never happens, so we do it. Default policy is
 * `strict-origin-when-cross-origin`, like every current browser.
 */
export function refererFor(target: URL, referrer: URL, policy: string): string | null {
  const sameOrigin = referrer.origin === target.origin;
  const downgrade = referrer.protocol === "https:" && target.protocol === "http:";
  const clean = new URL(referrer.href);
  clean.username = "";
  clean.password = "";
  clean.hash = "";
  const full = clean.href;
  const origin = `${referrer.origin}/`;
  switch (policy) {
    case "no-referrer":
      return null;
    case "origin":
      return origin;
    case "unsafe-url":
      return full;
    case "same-origin":
      return sameOrigin ? full : null;
    case "strict-origin":
      return downgrade ? null : origin;
    case "origin-when-cross-origin":
      return sameOrigin ? full : origin;
    case "no-referrer-when-downgrade":
      return downgrade ? null : full;
    default: // "" or strict-origin-when-cross-origin
      return sameOrigin ? full : downgrade ? null : origin;
  }
}

/** What the Request object knows that its headers don't. */
export interface RequestContext {
  referrer?: string;
  referrerPolicy?: string;
}

/**
 * The headers a real Chromium would send for this request, merged over what the renderer
 * gave us. Returns a NEW Headers; the input is not modified.
 *
 * A top-level/frame navigation is recognised the way servers recognise it: an HTML-first
 * `Accept` plus `Upgrade-Insecure-Requests: 1`. Everything else is a subresource, where
 * the destination can only be guessed from `Accept` — scripts and XHR/fetch are
 * indistinguishable here and are reported as `empty`, which is still far closer than the
 * unconditional `no-cors`/`empty`/`none` the loader would otherwise send.
 */
export function chromiumRequestHeaders(url: URL, input: Headers, hints: Hints | null, ctx: RequestContext = {}): Headers {
  const h = new Headers(input);
  const refUrl = parseUrl(ctx.referrer ?? null);
  const hasWebReferrer = !!refUrl && (refUrl.protocol === "https:" || refUrl.protocol === "http:");
  if (hasWebReferrer && !h.has("referer")) {
    const r = refererFor(url, refUrl, ctx.referrerPolicy ?? "");
    if (r) h.set("referer", r);
  }
  if (!isTrustworthy(url)) return h;

  // client hints (the three low-entropy ones Chrome sends on every request)
  if (hints) {
    if (!h.has("sec-ch-ua")) h.set("sec-ch-ua", secChUa(hints));
    if (!h.has("sec-ch-ua-mobile")) h.set("sec-ch-ua-mobile", hints.mobile ? "?1" : "?0");
    if (!h.has("sec-ch-ua-platform")) h.set("sec-ch-ua-platform", sfv(hints.platform));
  }

  // fetch metadata
  const accept = h.get("accept") ?? "";
  const navigation = /\btext\/html\b/.test(accept) && h.get("upgrade-insecure-requests") === "1";
  const initiator = parseUrl(h.get("origin")) ?? (hasWebReferrer ? refUrl : null) ?? parseUrl(h.get("referer"));
  const site = siteRelation(url, initiator);

  if (navigation) {
    h.set("sec-fetch-mode", "navigate");
    h.set("sec-fetch-dest", "document");
    h.set("sec-fetch-site", site);
    h.set("sec-fetch-user", "?1"); // user-activated navigation (typed or clicked)
  } else {
    h.delete("sec-fetch-user");
    h.set("sec-fetch-mode", h.has("origin") ? "cors" : "no-cors");
    h.set("sec-fetch-dest", /^image\//.test(accept) ? "image" : /^text\/css\b/.test(accept) ? "style" : "empty");
    h.set("sec-fetch-site", site === "none" ? "same-origin" : site);
  }
  return h;
}
