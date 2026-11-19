#!/usr/bin/env node
/**
 * Tiny client for the dbbasic-browser automation API.
 *
 *   import { connect } from "./dbb.mjs";
 *   const b = await connect();                 // reads ~/.dbbasic/control.json (or DBB_URL + DBB_TOKEN)
 *   await b.call("page.goto", { url: "https://askrobots.com" });
 *
 *   node dbb.mjs <method> ['{"json":"params"}']   // one-off from a shell
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class DbbError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export async function connect({ url, token } = {}) {
  if (!url || !token) {
    if (process.env.DBB_URL && process.env.DBB_TOKEN) {
      ({ DBB_URL: url, DBB_TOKEN: token } = process.env);
    } else {
      try {
        ({ url, token } = JSON.parse(readFileSync(join(homedir(), ".dbbasic", "control.json"), "utf8")));
      } catch {
        throw new Error("no control.json — is the browser running with DBB_CONTROL=1?");
      }
    }
  }
  let n = 0;
  const call = async (method, params = {}) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: ++n, method, params }),
    });
    const body = await res.json();
    if (!body.ok) throw new DbbError(body.error?.code ?? "error", body.error?.message ?? "request failed");
    return body.result;
  };
  return { call };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [method, json] = process.argv.slice(2);
  if (!method) {
    console.error("usage: dbb.mjs <method> ['{...params}']");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(await (await connect()).call(method, json ? JSON.parse(json) : {}), null, 2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
