# Security

dbbasic-browser signs cryptographic payment authorizations and, in proxy mode,
terminates TLS. Please read this before running it against anything real.

## Current status: not production-safe

This is early software. **Do not point it at mainnet with real funds.** It signs with
a public test key, settlement is stubbed, and it has not been audited.

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue. Email
**security@askrobots.com** with details and a proof of concept if you have one. We aim
to acknowledge within a few business days.

## Threat model and design choices

The core security stance is that **the resource server you are paying is not trusted**
to describe its own payment. See the README for the full rationale; in brief:

- **Pinned asset registry.** The EIP-712 signing domain and token decimals come from a
  local allowlist ([`packages/engine/src/assets.ts`](packages/engine/src/assets.ts)),
  never from the server's 402 response. An asset that isn't pinned cannot be priced and
  will not be paid.
- **Clamped authorization lifetime.** `validBefore` is bounded locally (default 120s)
  regardless of the server's requested `maxTimeoutSeconds`, so a server cannot bank a
  signed authorization and settle it much later.
- **Rate- and pair-scoped budgets.** Because EIP-3009 authorizations are signature-
  based, your exposure equals exactly what you sign. Auto-approval is bounded by amount
  *and* by payment rate, scoped to (top-level origin × destination origin), so a
  hostile page cannot drain a balance with a flood of sub-cent requests.

## Operational risks to understand

- **The proxy is a TLS man-in-the-middle.** To pay for `https` subresources, the proxy
  ([`packages/proxy`](packages/proxy)) generates a local root CA and mints per-host
  leaf certificates. If you install that CA in your OS trust store, **the CA private
  key can impersonate any website to you.** It is written to `~/.dbbasic-browser/`
  with `0600` permissions and never leaves your machine, but treat it like a password,
  and uninstall the CA when you are not using the proxy. The browser (Electron
  `protocol.handle`) does **not** MITM and does not need a CA — prefer it.
- **The signing key is the security boundary.** Today the engine signs with a well-
  known public test key (`0x59c6…`, the standard Hardhat/Anvil account). It is
  hard-coded so no one can mistake it for a real wallet. **Never fund it.** A real
  deployment must use an isolated session hot wallet, never the user's primary key.
- **Auto-approval spends without prompting.** By design, payments under the configured
  threshold are made without a dialog. Review the policy limits
  ([`packages/engine/src/policy.ts`](packages/engine/src/policy.ts)) before funding a
  real wallet.

## Supported versions

Pre-1.0: only the latest `main` is supported. There are no security backports yet.
