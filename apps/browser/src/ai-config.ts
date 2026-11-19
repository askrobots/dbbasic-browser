/**
 * Where the AI Reader's API keys come from — and, just as important, where they never do.
 *
 * Keys are NEVER in the repository. They are read at runtime from, in order:
 *   1. the process environment (ANTHROPIC_API_KEY / OPENAI_API_KEY)
 *   2. the file named by DBB_ENV_FILE, if set
 *   3. ~/.dbbasic/env
 * Files are plain `NAME=value` lines (the usual .env shape).
 *
 * Only a FIXED allow-list of variable names is ever read out of a file. An env file may hold
 * unrelated secrets (database URLs, wallet keys, other services' tokens); they are skipped
 * at parse time, so this module cannot leak what it never loads.
 *
 * Key values never leave the main process: the chrome UI gets `describeAi()` (provider, model,
 * which providers are usable, and the file a key came from — never a value), and any error text
 * is passed through `redact()` before it can reach a log or the UI.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Provider = "anthropic" | "openai";

/** The ONLY names read from env files. */
const ALLOWED_NAMES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DBB_AI_PROVIDER",
  "DBB_AI_MODEL", // overrides the model for whichever provider is selected
  "DBB_AI_MODEL_ANTHROPIC",
  "DBB_AI_MODEL_OPENAI",
] as const;
const ALLOWED = new Set<string>(ALLOWED_NAMES);

/**
 * Default models: small and fast, because a TL;DR is a once-per-click, latency-sensitive job. Measured on
 * a real 26k-character page, claude-haiku-5-5 wrote an equally accurate summary in 2.6 s for $0.0015, versus
 * 5.0 s and $0.0585 for claude-opus-5-5 (about 40x the cost). For richer summaries set
 * DBB_AI_MODEL_ANTHROPIC=claude-opus-5-5 (or claude-sonnet-5-5).
 */
export const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: "claude-haiku-5-5",
  openai: "gpt-5.4-mini",
};

/** Parse `NAME=value` lines, keeping ONLY allow-listed names. Handles `export`, quotes, comments, CRLF. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || m[1] === undefined || !ALLOWED.has(m[1])) continue;
    let v = m[2] ?? "";
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, ""); // trailing comment on an unquoted value
    if (v) out[m[1]] = v;
  }
  return out;
}

export interface Loaded {
  values: Record<string, string>;
  /** For each allowed name that was found: "env" or the file it came from. Never a value. */
  sources: Record<string, string>;
}

export interface LoadOptions {
  env?: Record<string, string | undefined>;
  files?: string[];
  readFile?: (path: string) => string;
}

export function defaultEnvFiles(env: Record<string, string | undefined> = process.env): string[] {
  return [...(env.DBB_ENV_FILE ? [env.DBB_ENV_FILE] : []), join(homedir(), ".dbbasic", "env")];
}

/** Collect allow-listed values; earlier sources win (environment, then each file in order). */
export function loadAiEnv(opts: LoadOptions = {}): Loaded {
  const env = opts.env ?? process.env;
  const read = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const values: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const name of ALLOWED_NAMES) {
    const v = env[name];
    if (v) {
      values[name] = v;
      sources[name] = "env";
    }
  }
  for (const file of opts.files ?? defaultEnvFiles(env)) {
    let parsed: Record<string, string>;
    try {
      parsed = parseEnvFile(read(file));
    } catch {
      continue; // missing/unreadable file is normal
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (!(k in values)) {
        values[k] = v;
        sources[k] = file;
      }
    }
  }
  return { values, sources };
}

export interface AiConfig {
  provider: Provider;
  model: string;
  /** Provider -> key. Main process only; never serialize this. */
  keys: Partial<Record<Provider, string>>;
  available: Provider[];
  sources: Record<string, string>;
}

/** Pick the provider (Anthropic by default) and model. Returns null when no usable key exists. */
export function resolveAi(loaded: Loaded): AiConfig | null {
  const { values, sources } = loaded;
  const keys: Partial<Record<Provider, string>> = {};
  if (values.ANTHROPIC_API_KEY) keys.anthropic = values.ANTHROPIC_API_KEY;
  if (values.OPENAI_API_KEY) keys.openai = values.OPENAI_API_KEY;
  const available = (Object.keys(keys) as Provider[]).sort((a, b) => (a === "anthropic" ? -1 : b === "anthropic" ? 1 : 0));
  if (available.length === 0) return null;

  const wanted = values.DBB_AI_PROVIDER as Provider | undefined;
  const provider: Provider = wanted && available.includes(wanted) ? wanted : (available[0] as Provider);
  const model =
    (provider === "anthropic" ? values.DBB_AI_MODEL_ANTHROPIC : values.DBB_AI_MODEL_OPENAI) || values.DBB_AI_MODEL || DEFAULT_MODELS[provider];
  return { provider, model, keys, available, sources };
}

/** Everything the UI may know: no key material. */
export interface AiDescription {
  configured: boolean;
  provider?: Provider;
  model?: string;
  available: Provider[];
  keySources: Partial<Record<Provider, string>>;
}

export function describeAi(cfg: AiConfig | null): AiDescription {
  if (!cfg) return { configured: false, available: [], keySources: {} };
  const keySources: Partial<Record<Provider, string>> = {};
  if (cfg.sources.ANTHROPIC_API_KEY) keySources.anthropic = cfg.sources.ANTHROPIC_API_KEY;
  if (cfg.sources.OPENAI_API_KEY) keySources.openai = cfg.sources.OPENAI_API_KEY;
  return { configured: true, provider: cfg.provider, model: cfg.model, available: cfg.available, keySources };
}

/** Remove any key (or a recognisable fragment of one) from text before it is logged or shown. */
export function redact(text: string, cfg: AiConfig | null): string {
  let out = text;
  for (const k of Object.values(cfg?.keys ?? {})) {
    if (k) out = out.split(k).join("[redacted-key]");
  }
  // Belt and braces for keys we don't hold: the common provider shapes.
  return out.replace(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, "[redacted-key]");
}
