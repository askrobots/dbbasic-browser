/**
 * A local certificate authority for MITM.
 *
 * To pay a 402 on an https:// subresource we have to see the plaintext request and
 * swap the response — which means terminating TLS ourselves. That requires presenting
 * a cert the client trusts for the target host, so we run a local root CA, install it
 * once in the OS trust store, and mint short-lived leaf certs per host on demand.
 *
 * This is the same mechanism every debugging proxy (Charles, mitmproxy, Fiddler) uses.
 * The root key never leaves the machine; treat ~/.dbbasic-browser/ca-key.pem like a
 * password — anyone with it can impersonate any site to this user.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import forge from "node-forge";

export interface CaFiles {
  certPem: string;
  keyPem: string;
}

export class CertificateAuthority {
  private caCert: forge.pki.Certificate;
  private caKey: forge.pki.rsa.PrivateKey;
  private leafCache = new Map<string, { cert: string; key: string }>();

  private constructor(caCert: forge.pki.Certificate, caKey: forge.pki.rsa.PrivateKey) {
    this.caCert = caCert;
    this.caKey = caKey;
  }

  /** Load the CA from `dir`, generating and persisting it on first run. */
  static loadOrCreate(dir = join(homedir(), ".dbbasic-browser")): CertificateAuthority {
    mkdirSync(dir, { recursive: true });
    const certPath = join(dir, "ca-cert.pem");
    const keyPath = join(dir, "ca-key.pem");

    if (existsSync(certPath) && existsSync(keyPath)) {
      const cert = forge.pki.certificateFromPem(readFileSync(certPath, "utf8"));
      const key = forge.pki.privateKeyFromPem(readFileSync(keyPath, "utf8")) as forge.pki.rsa.PrivateKey;
      return new CertificateAuthority(cert, key);
    }

    const { cert, key } = generateRootCa();
    writeFileSync(certPath, forge.pki.certificateToPem(cert), { mode: 0o644 });
    writeFileSync(keyPath, forge.pki.privateKeyToPem(key), { mode: 0o600 });
    return new CertificateAuthority(cert, key);
  }

  /** In-memory CA for tests — nothing touches disk. */
  static ephemeral(): CertificateAuthority {
    const { cert, key } = generateRootCa();
    return new CertificateAuthority(cert, key);
  }

  rootCertPem(): string {
    return forge.pki.certificateToPem(this.caCert);
  }

  /** A leaf cert+key for `host`, signed by the root. Cached per host. */
  certFor(host: string): { cert: string; key: string } {
    const cached = this.leafCache.get(host);
    if (cached) return cached;

    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
    cert.validity.notAfter = new Date(Date.now() + 397 * 24 * 3600 * 1000); // CA/B max

    const attrs = [{ name: "commonName", value: host }];
    cert.setSubject(attrs);
    cert.setIssuer(this.caCert.subject.attributes);
    cert.setExtensions([
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: altNamesFor(host) },
    ]);
    cert.sign(this.caKey, forge.md.sha256.create());

    const out = {
      cert: forge.pki.certificateToPem(cert),
      key: forge.pki.privateKeyToPem(keys.privateKey),
    };
    this.leafCache.set(host, out);
    return out;
  }
}

function generateRootCa(): { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);

  const attrs = [
    { name: "commonName", value: "dbbasic-browser x402 proxy CA" },
    { name: "organizationName", value: "dbbasic-browser" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

function altNamesFor(host: string): Array<{ type: number; value?: string; ip?: string }> {
  // type 7 = IP, type 2 = DNS
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  return isIp ? [{ type: 7, ip: host }] : [{ type: 2, value: host }];
}

let counter = 0;
function serial(): string {
  // Positive, unique-per-process hex serial. Avoids Math.random (unavailable here
  // in some sandboxes) and keeps leaf serials distinct within a run.
  counter += 1;
  return (Date.now() * 1000 + counter).toString(16);
}
