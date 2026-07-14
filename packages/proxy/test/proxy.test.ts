import { createServer as createHttp, type Server, request as httpRequest } from "node:http";
import { createServer as createHttps } from "node:https";
import { connect as tlsConnect } from "node:tls";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { PolicyEngine, Ledger, X402Engine } from "@dbbasic/x402-engine";
import { X402Proxy } from "../src/server.js";
import { CertificateAuthority } from "../src/ca.js";

const NETWORK = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

/** A mock x402 origin: 402 with a PAYMENT-REQUIRED header, then 200 once paid. */
function makeOrigin(handler: (req: unknown) => void, https = false, certHost = "localhost") {
  const originCa = CertificateAuthority.ephemeral();
  const listener = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    handler(req);
    if (!req.headers["payment-signature"]) {
      const challenge = {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: NETWORK,
            amount: "10000",
            asset: USDC,
            payTo: PAY_TO,
            maxTimeoutSeconds: 60,
            extra: { name: "USDC", version: "2" },
          },
        ],
      };
      res.writeHead(402, { "PAYMENT-REQUIRED": b64(challenge), "content-type": "text/plain" });
      res.end("payment required");
      return;
    }
    res.writeHead(200, {
      "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xabc", network: NETWORK }),
      "content-type": "text/plain",
    });
    res.end("PAID CONTENT");
  };
  if (https) {
    const leaf = originCa.certFor(certHost);
    return { server: createHttps({ cert: leaf.cert, key: leaf.key }, listener), ca: originCa };
  }
  return { server: createHttp(listener), ca: originCa };
}

function freshEngine(fetchImpl?: typeof fetch) {
  return new X402Engine({
    account,
    policy: new PolicyEngine(),
    ledger: new Ledger(),
    fetchImpl,
  });
}

// ---- HTTP forward-proxy path ----
describe("proxy: plain HTTP", () => {
  let origin: Server;
  let originUrl: string;
  let proxy: X402Proxy;
  let proxyPort: number;
  let hits = 0;

  beforeAll(async () => {
    const m = makeOrigin(() => hits++);
    origin = m.server;
    await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
    originUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;

    proxy = new X402Proxy({ engine: freshEngine(), ca: CertificateAuthority.ephemeral() });
    ({ port: proxyPort } = await proxy.listen(0));
  });

  afterAll(async () => {
    await proxy.close();
    origin.close();
  });

  it("pays a 402 and returns the paid content through the proxy", async () => {
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: proxyPort, method: "GET", path: `${originUrl}/article` },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve(data));
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(body).toBe("PAID CONTENT");
    expect(hits).toBe(2); // one 402, one paid retry
  });
});

// ---- HTTPS MITM path (the real reason the proxy exists) ----
describe("proxy: HTTPS via CONNECT + MITM", () => {
  let origin: Server;
  let originPort: number;
  let proxy: X402Proxy;
  let proxyPort: number;
  let proxyCaPem: string;

  beforeAll(async () => {
    const m = makeOrigin(() => {}, true, "127.0.0.1");
    origin = m.server;
    await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
    originPort = (origin.address() as AddressInfo).port;

    // The proxy's OUTBOUND fetch must trust the mock origin's self-signed cert.
    // Scope the relaxation to this test process only.
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    afterAll(() => {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    });

    const proxyCa = CertificateAuthority.ephemeral();
    proxyCaPem = proxyCa.rootCertPem();
    proxy = new X402Proxy({ engine: freshEngine(), ca: proxyCa });
    ({ port: proxyPort } = await proxy.listen(0));
  });

  afterAll(async () => {
    await proxy.close();
    origin.close();
  });

  it("terminates TLS, pays the 402 inside the tunnel, returns paid content", async () => {
    // Use 127.0.0.1 end to end: the origin binds IPv4-only, so resolving "localhost"
    // (which prefers ::1) would hang the proxy's outbound fetch. The CA issues IP SANs.
    const host = "127.0.0.1";
    const target = `${host}:${originPort}`;

    // 1. CONNECT to the proxy to open a tunnel.
    const socket = await new Promise<import("node:stream").Duplex>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: target });
      req.on("connect", (res, sock) => {
        if (res.statusCode !== 200) return reject(new Error(`CONNECT got ${res.statusCode}`));
        resolve(sock);
      });
      req.on("error", reject);
      req.end();
    });

    // 2. TLS to the proxy, trusting the proxy's root CA (as an installed CA would).
    // SNI can't be an IP literal, so omit servername; chain trust via `ca` is still
    // enforced, only the hostname match is skipped (fine for an IP-literal target).
    const tls = tlsConnect({ socket, ca: [proxyCaPem], checkServerIdentity: () => undefined });
    await new Promise<void>((resolve, reject) => {
      tls.on("secureConnect", () => {
        expect(tls.authorized).toBe(true); // proves the MITM leaf chains to our CA
        resolve();
      });
      tls.on("error", reject);
      setTimeout(() => reject(new Error("TLS handshake timeout")), 3000);
    });

    // 3. Speak plain HTTP inside the encrypted tunnel.
    tls.write(`GET /premium HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`);
    const raw = await new Promise<string>((resolve, reject) => {
      let data = "";
      const done = () => resolve(data);
      tls.on("data", (c) => {
        data += c.toString();
        if (data.includes("PAID CONTENT")) done(); // full body arrived
      });
      tls.on("end", done);
      tls.on("close", done);
      tls.on("error", reject);
      setTimeout(() => reject(new Error(`response timeout, got ${data.length}B: ${data.slice(0, 120)}`)), 3000);
    });

    expect(raw).toContain("200");
    expect(raw).toContain("PAID CONTENT");
  });
});
