/**
 * Bridge between Node's HTTP plumbing and the transport-agnostic X402Engine.
 *
 * Everything the proxy receives — whether it arrived as plaintext HTTP or was
 * decrypted out of a CONNECT tunnel — funnels through `handle()`. That is the whole
 * point of the engine-first design: the proxy is dumb pipe, the payment decision
 * lives in exactly one place, shared with the browser and the agent runtime.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { X402Engine } from "@dbbasic/x402-engine";

/** Build the absolute request URL. For CONNECT-tunnelled traffic req.url is a path. */
function absoluteUrl(req: IncomingMessage, scheme: "http" | "https", connectHost?: string): string {
  if (req.url && /^https?:\/\//.test(req.url)) return req.url; // classic forward-proxy form
  const host = connectHost ?? req.headers.host;
  if (!host) throw new Error("cannot resolve request host");
  return `${scheme}://${host}${req.url ?? "/"}`;
}

/**
 * The origin of the page the user is actually looking at, used to scope budgets.
 * We take it from Referer; a subresource must be billed against its page, never
 * against itself, or the pair-scoped rate cap means nothing. Absent Referer (a
 * top-level navigation, curl, or an agent) yields "" — its own budget scope.
 */
function topOriginOf(req: IncomingMessage): string {
  const ref = req.headers["referer"];
  if (!ref) return "";
  try {
    return new URL(ref).origin;
  } catch {
    return "";
  }
}

function toWebRequest(req: IncomingMessage, url: string): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    // Hop-by-hop and proxy-specific headers must not be forwarded.
    if (k === "proxy-connection" || k === "connection" || k === "keep-alive") continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    // @ts-expect-error Node requires duplex for streamed request bodies
    duplex: hasBody ? "half" : undefined,
    redirect: "manual",
  });
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }
  // Stream, never buffer — large downloads and video must pass through untouched.
  const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  nodeStream.pipe(res);
  await new Promise<void>((resolve, reject) => {
    nodeStream.on("end", resolve);
    nodeStream.on("error", reject);
    res.on("close", resolve);
  });
}

export interface HandleOptions {
  scheme: "http" | "https";
  /** host:port from the CONNECT line, when this came out of a tunnel. */
  connectHost?: string;
  onError?: (err: unknown, url: string) => void;
}

export async function handle(
  engine: X402Engine,
  req: IncomingMessage,
  res: ServerResponse,
  opts: HandleOptions,
): Promise<void> {
  let url = "";
  try {
    url = absoluteUrl(req, opts.scheme, opts.connectHost);
    const webReq = toWebRequest(req, url);
    const { response } = await engine.fetch(webReq, topOriginOf(req));
    await writeWebResponse(res, response);
  } catch (err) {
    opts.onError?.(err, url);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`x402 proxy error for ${url}: ${String(err)}`);
    } else {
      res.destroy();
    }
  }
}
