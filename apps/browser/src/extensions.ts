/**
 * Local extensions: extra automation methods, supplied by code you have on this machine.
 *
 *   DBB_EXTENSIONS=/abs/path/one.mjs:/abs/path/two.mjs
 *
 * Each file is an ES module that exports `register(api)`. It adds methods with `api.method(name, handler)`; a method is
 * reached through the automation API as `ext.<name>`. The handler gets the request's parameters and a few tools
 * (`tools.webContents(params)` returns the page of the tab the request names, without raising the window).
 *
 * Extensions run with the browser's own privileges, so load only code you trust. The files and their folder must belong to you and
 * not be writable by anyone else. An extension can also use Electron directly, so "built-in methods cannot be replaced" is about
 * method names only: trusted code can still change how the browser works. They are loaded from an environment variable
 * only (never from a page, the network or the automation API), only from absolute paths to local files, each load is announced,
 * and an extension that fails to load stops the browser from starting, so it never runs half set up. Built-in methods cannot
 * be replaced: everything an extension adds lives under `ext.`.
 *
 * No electron import: what it needs from the browser is handed in, so it can be tested on its own.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

export interface ExtensionTools<Page> {
  /** The page of the tab named by `params.tab` (default: the active tab). The window is not raised. */
  webContents(params: Record<string, unknown>): Promise<Page>;
}

export type ExtensionHandler<Page = unknown> = (params: Record<string, unknown>, tools: ExtensionTools<Page>) => Promise<unknown> | unknown;

export interface ExtensionApi<Page = unknown> {
  /** Add the automation method `ext.<name>`. Names are lower-case letters, digits and hyphens, optionally with one dot. */
  method(name: string, handler: ExtensionHandler<Page>): void;
}

const NAME = /^[a-z][a-z0-9-]{0,40}(\.[a-z][a-z0-9-]{0,40})?$/;

export class ExtensionRegistry<Page = unknown> {
  private methods = new Map<string, ExtensionHandler<Page>>();
  /** The files that were loaded (absolute), kept for the log. */
  loaded: string[] = [];
  /** Their base names: what the status report shows, so a log or a bug report does not carry a folder layout. */
  loadedNames(): string[] {
    return this.loaded.map((f) => f.slice(f.lastIndexOf("/") + 1));
  }

  has(method: string): boolean {
    return this.methods.has(method);
  }

  names(): string[] {
    return [...this.methods.keys()].sort();
  }

  call(method: string, params: Record<string, unknown>, tools: ExtensionTools<Page>): Promise<unknown> {
    const h = this.methods.get(method);
    if (!h) return Promise.reject(new Error(`no extension method ${method}`));
    return Promise.resolve().then(() => h(params, tools));
  }

  /** The registration surface handed to one extension. */
  apiFor(file: string): ExtensionApi<Page> {
    return {
      method: (name, handler) => {
        if (typeof name !== "string" || !NAME.test(name)) throw new Error(`${file}: "${String(name)}" is not a valid method name`);
        if (typeof handler !== "function") throw new Error(`${file}: the handler for "${name}" must be a function`);
        const full = `ext.${name}`;
        if (this.methods.has(full)) throw new Error(`${file}: ${full} is already registered`);
        this.methods.set(full, handler);
      },
    };
  }
}

/** Split DBB_EXTENSIONS into absolute paths. Anything else is an error, not a guess. */
export function parseExtensionPaths(value: string | undefined): string[] {
  if (!value || !value.trim()) return [];
  const out: string[] = [];
  for (const raw of value.split(":")) {
    const p = raw.trim();
    if (!p) continue;
    if (!isAbsolute(p)) throw new Error(`DBB_EXTENSIONS: "${p}" is not an absolute path`);
    if (!/\.(mjs|js)$/.test(p)) throw new Error(`DBB_EXTENSIONS: "${p}" is not a .mjs or .js file`);
    if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`DBB_EXTENSIONS: "${p}" is not a file`);
    // Code that runs with the browser's privileges must belong to the person running it and not be changeable by anyone else.
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    for (const path of [p, dirname(p)]) {
      const st = statSync(path);
      if (uid !== null && st.uid !== uid) throw new Error(`DBB_EXTENSIONS: "${path}" is not owned by the user running the browser`);
      if ((st.mode & 0o022) !== 0) throw new Error(`DBB_EXTENSIONS: "${path}" can be written by other users (group or others); tighten its permissions`);
    }
    out.push(p);
  }
  return out;
}

/** Load each file and let it register. Throws on the first failure. */
export async function loadExtensions<Page>(paths: string[], registry: ExtensionRegistry<Page>, announce: (file: string) => void = () => {}): Promise<void> {
  for (const file of paths) {
    const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as { register?: (api: ExtensionApi<Page>) => unknown };
    if (typeof mod.register !== "function") throw new Error(`${file}: an extension must export a function named register`);
    await mod.register(registry.apiFor(file));
    registry.loaded.push(file);
    announce(file);
  }
}
