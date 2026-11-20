/**
 * Model adapters for the chat: Anthropic (Messages API with tool use) and anything that speaks the OpenAI chat
 * API, which includes a model running on this machine or on your network (set DBB_AI_BASE_URL). Both turn the
 * chat's provider-neutral messages into the provider's shape and back. Main process only (it holds API keys).
 * Replies arrive whole; the loop shows each tool step as it happens.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AiConfig } from "./ai-config.js";
import type { ChatMsg, ModelClient, ModelTurn, ToolCall, ToolSpec } from "./chat-core.js";

const MAX_TOKENS = 4096;

export interface AnthropicChatLike {
  messages: { create(params: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<AnthropicChatResponse> };
}
export interface AnthropicChatResponse {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}
export interface OpenAIChatLike {
  chat: { completions: { create(params: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<OpenAIChatResponse> } };
}
export interface OpenAIChatResponse {
  choices: Array<{
    message?: { content?: string | null; refusal?: string | null; tool_calls?: Array<{ id: string; type?: string; function: { name: string; arguments: string } }> };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// ---- Anthropic --------------------------------------------------------------------------------------

export function toAnthropicMessages(messages: ChatMsg[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === "user") return { role: "user", content: m.text };
    if (m.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      if (m.text.trim()) content.push({ type: "text", text: m.text });
      for (const c of m.calls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
      return { role: "assistant", content: content.length ? content : [{ type: "text", text: "(no reply)" }] };
    }
    return { role: "user", content: m.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.text, ...(r.isError ? { is_error: true } : {}) })) };
  });
}

export function anthropicClient(cfg: AiConfig, inject?: AnthropicChatLike): ModelClient {
  const client = (): AnthropicChatLike => {
    if (inject) return inject;
    if (!cfg.keys.anthropic) throw new Error("no Anthropic API key is configured");
    return new Anthropic({ apiKey: cfg.keys.anthropic, timeout: 90_000, maxRetries: 1 }) as unknown as AnthropicChatLike;
  };
  return {
    provider: "anthropic",
    model: cfg.model,
    async turn({ system, messages, tools, signal }): Promise<ModelTurn> {
      const res = await client().messages.create(
        { model: cfg.model, max_tokens: MAX_TOKENS, system, messages: toAnthropicMessages(messages), tools: tools.map(toAnthropicTool) },
        signal ? { signal } : undefined,
      );
      const text = res.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      const calls: ToolCall[] = res.content.filter((b) => b.type === "tool_use").map((b) => ({ id: String(b.id), name: String(b.name), input: asObject(b.input) }));
      const stop = res.stop_reason === "refusal" ? "refusal" : res.stop_reason === "max_tokens" ? "length" : calls.length ? "tools" : "end";
      return { text, calls, stop, usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 } };
    },
  };
}
const toAnthropicTool = (t: ToolSpec) => ({ name: t.name, description: t.description, input_schema: t.input_schema });

// ---- OpenAI and compatible --------------------------------------------------------------------------

export function toOpenAIMessages(system: string, messages: ChatMsg[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.text || null,
        ...(m.calls.length ? { tool_calls: m.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}),
      });
    } else for (const r of m.results) out.push({ role: "tool", tool_call_id: r.id, content: r.text });
  }
  return out;
}

export function openaiClient(cfg: AiConfig, inject?: OpenAIChatLike): ModelClient {
  const client = (): OpenAIChatLike => {
    if (inject) return inject;
    const key = cfg.keys.openai ?? (cfg.baseUrl ? "none" : undefined);
    if (!key) throw new Error("no OpenAI API key is configured");
    return new OpenAI({ apiKey: key, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}), timeout: 120_000, maxRetries: 1 }) as unknown as OpenAIChatLike;
  };
  return {
    provider: "openai",
    model: cfg.model,
    async turn({ system, messages, tools, signal }): Promise<ModelTurn> {
      const res = await client().chat.completions.create(
        {
          model: cfg.model,
          max_completion_tokens: MAX_TOKENS,
          messages: toOpenAIMessages(system, messages),
          tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
        },
        signal ? { signal } : undefined,
      );
      const choice = res.choices[0];
      const msg = choice?.message;
      const calls: ToolCall[] = (msg?.tool_calls ?? []).map((c) => {
        let input: Record<string, unknown> = {};
        try {
          input = asObject(JSON.parse(c.function.arguments || "{}"));
        } catch {
          /* the model sent broken arguments: the tool will say what is missing */
        }
        return { id: c.id, name: c.function.name, input };
      });
      const stop = msg?.refusal ? "refusal" : choice?.finish_reason === "length" ? "length" : calls.length ? "tools" : "end";
      return { text: msg?.content ?? msg?.refusal ?? "", calls, stop, usage: { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 } };
    },
  };
}

export function chatModel(cfg: AiConfig): ModelClient {
  return cfg.provider === "anthropic" ? anthropicClient(cfg) : openaiClient(cfg);
}
