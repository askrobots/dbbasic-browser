/**
 * The x402 proxy server.
 *
 * Two entry points:
 *   - Plain HTTP: clients send an absolute-URI request line; we route it straight
 *     through the engine.
 *   - HTTPS: clients send CONNECT host:443; we answer 200, wrap the raw socket in
 *     TLS using a per-host leaf cert from our CA, then treat the decrypted stream as
 *     an ordinary HTTP server connection routed through the same engine.
 *
 * Either way, one `handle()` per request. The proxy holds no payment logic.
 */

import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { TLSSocket } from "node:tls";
import type { Duplex } from "node:stream";
import type { X402Engine } from "@dbbasic/x402-engine";
import { CertificateAuthority } from "./ca.js";
import { handle } from "./handler.js";

export interface ProxyOptions {
  engine: X402Engine;
  ca?: CertificateAuthority;
  host?: string;
  port?: number;
  onError?: (err: unknown, url: string) => void;
  onConnect?: (host: string) => void;
}

export class X402Proxy {
  private server: HttpServer;
  private readonly engine: X402Engine;
  private readonly ca: CertificateAuthority;
  private readonly onError?: (err: unknown, url: string) => void;
  private readonly onConnect?: (host: string) => void;

  constructor(opts: ProxyOptions) {
    this.engine = opts.engine;
    this.ca = opts.ca ?? CertificateAuthority.loadOrCreate();
    this.onError = opts.onError;
    this.onConnect = opts.onConnect;

    this.server = createHttpServer((req, res) => {
      handle(this.engine, req, res, { scheme: "http", onError: this.onError });
    });
    this.server.on("connect", (req, socket, head) => this.onConnectTunnel(req, socket, head));
  }

  rootCertPem(): string {
    return this.ca.rootCertPem();
  }

  listen(port = 8402, host = "127.0.0.1"): Promise<{ host: string; port: number }> {
    return new Promise((resolve) => {
      this.server.listen(port, host, () => {
        const addr = this.server.address();
        const bound = typeof addr === "object" && addr ? addr.port : port;
        resolve({ host, port: bound });
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /**
   * A client wants an https tunnel. We terminate it ourselves so the engine can see
   * the plaintext and pay any 402s inside.
   */
  private onConnectTunnel(req: IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    const [host = "", portStr] = (req.url ?? "").split(":");
    const port = Number(portStr) || 443;
    this.onConnect?.(host);

    const { cert, key } = this.ca.certFor(host);
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    // Any bytes already read past the CONNECT line are the start of the client's TLS
    // ClientHello. Push them back BEFORE the TLS layer attaches, or the handshake
    // loses its first bytes and stalls.
    if (head && head.length) clientSocket.unshift(head);

    // Wrap the raw client socket in server-side TLS, presenting our per-host leaf.
    const tlsSocket = new TLSSocket(clientSocket as import("node:net").Socket, {
      isServer: true,
      cert,
      key,
    });
    tlsSocket.on("error", (e) => this.onError?.(e, `CONNECT ${host}:${port}`));
    clientSocket.on("error", () => tlsSocket.destroy());

    // Feed the decrypted stream into an ephemeral HTTP parser. Each request that
    // comes out is routed exactly like a plain-HTTP one, but tagged https and pinned
    // to the CONNECT host so the engine reconstructs the right absolute URL.
    const connectHost = port === 443 ? host : `${host}:${port}`;
    const inner = createHttpServer((ireq, ires) => {
      handle(this.engine, ireq, ires, {
        scheme: "https",
        connectHost,
        onError: this.onError,
      });
    });
    inner.on("clientError", (e) => this.onError?.(e, `inner clientError ${host}`));
    inner.emit("connection", tlsSocket);
  }
}

/** Convenience: the ServerResponse type re-exported for adapters. */
export type { IncomingMessage, ServerResponse };
