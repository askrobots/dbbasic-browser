/**
 * Which model the assistant (the chat) uses: picked in the panel, remembered across restarts. Electron-free, so it is
 * unit-tested.
 *
 * The chat and the AI Reader are different jobs. A TL;DR is one quick call, where the smallest model does fine; the chat
 * reads pages, picks tools and acts over many steps, where a small model asks needless questions and misses the obvious.
 * So the chat has its own choice and a stronger default, and the reader keeps the env file's model.
 *
 * Only models of a provider that is set up (a key, or a local endpoint) are offered. A saved choice for a provider that is
 * no longer set up is ignored, never half-used.
 */

import { PRICES } from "./ai.js";
import type { AiConfig, Provider } from "./ai-config.js";

export interface ModelChoice {
  /** "provider/model": what is saved and sent back from the panel. */
  id: string;
  provider: Provider;
  model: string;
  label: string;
}

/** Cheapest first. Labels are short: the panel's picker is narrow. */
const ANTHROPIC: Array<{ model: string; name: string }> = [
  { model: "claude-haiku-5-5", name: "Haiku 5.5" },
  { model: "claude-sonnet-5-5", name: "Sonnet 5.5" },
  { model: "claude-opus-5-5", name: "Opus 5.5" },
  { model: "claude-fable-5-2", name: "Fable 5.2" },
];
/** The chat's default when Anthropic is set up and nothing else is chosen. */
export const CHAT_DEFAULT_ANTHROPIC = "claude-sonnet-5-5";

/** "· 20×": the cost per message compared with Haiku, from the prices we know (never a guess). */
function costNote(model: string): string {
  const base = PRICES["claude-haiku-5-5"];
  const p = PRICES[model];
  if (!base || !p) return "";
  return model === "claude-haiku-5-5" ? " · cheapest" : ` · ${Math.round(p.in / base.in)}× cost`;
}

/** The models the panel offers, for the providers that are set up. */
export function chatModelChoices(cfg: AiConfig | null): ModelChoice[] {
  if (!cfg) return [];
  const out: ModelChoice[] = [];
  const add = (provider: Provider, model: string, label: string) => {
    const id = `${provider}/${model}`;
    if (!out.some((c) => c.id === id)) out.push({ id, provider, model, label });
  };
  for (const provider of cfg.available) {
    if (provider === "anthropic") {
      for (const m of ANTHROPIC) add("anthropic", m.model, `${m.name}${costNote(m.model)}`);
      // a model named in the env file that is not in the list above still shows, under its own name
      if (cfg.provider === "anthropic" && !ANTHROPIC.some((m) => m.model === cfg.model)) add("anthropic", cfg.model, cfg.model);
    } else {
      // OpenAI, or a model on this machine or network (DBB_AI_BASE_URL): the one the env file names
      const model = cfg.provider === "openai" ? cfg.model : "gpt-5.4-mini";
      add("openai", model, cfg.baseUrl ? `${model} (${new URL(cfg.baseUrl).host})` : model);
    }
  }
  return out;
}

/**
 * The config the chat runs with: the saved choice if it is still on offer; otherwise a model the env file names
 * explicitly for the chat's provider; otherwise Sonnet when Anthropic is the provider; otherwise the env's model.
 */
export function chatAi(cfg: AiConfig | null, saved: string | null): AiConfig | null {
  if (!cfg) return null;
  const choices = chatModelChoices(cfg);
  const pick = saved ? choices.find((c) => c.id === saved) : undefined;
  if (pick) return { ...cfg, provider: pick.provider, model: pick.model };
  if (cfg.provider === "anthropic" && !cfg.modelExplicit) return { ...cfg, model: CHAT_DEFAULT_ANTHROPIC };
  return cfg;
}

/** A saved file's choice: "provider/model" with sane characters, or null. */
export function parseSavedChoice(text: string): string | null {
  try {
    const v = (JSON.parse(text) as { model?: unknown }).model;
    return typeof v === "string" && /^(anthropic|openai)\/[A-Za-z0-9._:-]{1,80}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}
