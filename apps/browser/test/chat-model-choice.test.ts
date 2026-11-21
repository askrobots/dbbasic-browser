import { describe, expect, it } from "vitest";
import type { AiConfig } from "../src/ai-config.js";
import { CHAT_DEFAULT_ANTHROPIC, chatAi, chatModelChoices, parseSavedChoice } from "../src/chat-model-choice.js";

const anthropic: AiConfig = { provider: "anthropic", model: "claude-haiku-5-5", keys: { anthropic: "k" }, available: ["anthropic"], sources: {} };
const both: AiConfig = { ...anthropic, keys: { anthropic: "k", openai: "o" }, available: ["anthropic", "openai"] };
const local: AiConfig = { provider: "openai", model: "llama-local", keys: {}, available: ["openai"], sources: {}, baseUrl: "http://192.168.1.20:11434/v1" };

describe("the assistant's model", () => {
  it("offers the Anthropic models cheapest first, with what each costs next to Haiku", () => {
    const c = chatModelChoices(anthropic);
    expect(c.map((x) => x.id)).toEqual(["anthropic/claude-haiku-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5", "anthropic/claude-fable-5-2"]);
    expect(c.map((x) => x.label)).toEqual(["Haiku 5.5 · cheapest", "Sonnet 5.5 · 20× cost", "Opus 5.5 · 40× cost", "Fable 5.2 · 80× cost"]);
  });

  it("offers only providers that are set up; a local model shows its machine", () => {
    expect(chatModelChoices(null)).toEqual([]);
    expect(chatModelChoices(both).some((x) => x.provider === "openai")).toBe(true);
    expect(chatModelChoices(local)).toEqual([{ id: "openai/llama-local", provider: "openai", model: "llama-local", label: "llama-local (192.168.1.20:11434)" }]);
  });

  it("a model the env file names that is not in the list still shows", () => {
    const named = { ...anthropic, model: "claude-opus-5", modelExplicit: true };
    expect(chatModelChoices(named).map((x) => x.id)).toContain("anthropic/claude-opus-5");
  });

  it("defaults to Sonnet for the chat, unless the env file named a model", () => {
    expect(chatAi(anthropic, null)?.model).toBe(CHAT_DEFAULT_ANTHROPIC);
    expect(chatAi({ ...anthropic, model: "claude-opus-5-5", modelExplicit: true }, null)?.model).toBe("claude-opus-5-5");
    expect(chatAi(local, null)?.model).toBe("llama-local");
    expect(chatAi(null, "anthropic/claude-opus-5-5")).toBeNull();
  });

  it("uses the saved choice while it is on offer, and ignores it when it is not", () => {
    expect(chatAi(anthropic, "anthropic/claude-opus-5-5")?.model).toBe("claude-opus-5-5");
    const o = chatAi(both, "openai/gpt-5.4-mini");
    expect([o?.provider, o?.model]).toEqual(["openai", "gpt-5.4-mini"]);
    expect(chatAi(anthropic, "openai/gpt-5.4-mini")?.model).toBe(CHAT_DEFAULT_ANTHROPIC); // no OpenAI key any more
    expect(chatAi(anthropic, "anthropic/made-up")?.model).toBe(CHAT_DEFAULT_ANTHROPIC);
    expect(chatAi(anthropic, "anthropic/claude-opus-5-5")?.keys).toEqual(anthropic.keys); // same keys, only the model changes
  });

  it("reads a saved file strictly", () => {
    expect(parseSavedChoice('{"model":"anthropic/claude-opus-5-5"}')).toBe("anthropic/claude-opus-5-5");
    for (const bad of ["", "nope", '{"model":3}', '{"model":"evil/x"}', '{"model":"anthropic/a b"}', '{"model":"anthropic/"}']) expect(parseSavedChoice(bad)).toBeNull();
  });
});
