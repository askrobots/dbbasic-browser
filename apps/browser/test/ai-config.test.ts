import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS, describeAi, loadAiEnv, parseEnvFile, redact, resolveAi } from "../src/ai-config.js";

// Obviously fake: these are shapes, not secrets.
const A = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
const O = "sk-proj-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";

describe("parseEnvFile", () => {
  it("reads only the allow-listed names — unrelated secrets are never loaded", () => {
    const text = [
      "DATABASE_URL=postgres://user:hunter2@db/prod",
      "X402_PRIVATE_KEY=0xdeadbeef",
      "STRIPE_SECRET_KEY=sk_live_abc123",
      `ANTHROPIC_API_KEY=${A}`,
      "# comment",
      `export OPENAI_API_KEY="${O}"`,
    ].join("\n");
    const got = parseEnvFile(text);
    expect(Object.keys(got).sort()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    expect(JSON.stringify(got)).not.toContain("hunter2");
    expect(JSON.stringify(got)).not.toContain("sk_live");
    expect(JSON.stringify(got)).not.toContain("deadbeef");
  });
  it("handles quotes, single quotes, CRLF, spaces and trailing comments", () => {
    const got = parseEnvFile(`ANTHROPIC_API_KEY = '${A}'\r\nOPENAI_API_KEY=${O}   # prod\r\nDBB_AI_MODEL=\r\n`);
    expect(got.ANTHROPIC_API_KEY).toBe(A);
    expect(got.OPENAI_API_KEY).toBe(O);
    expect(got.DBB_AI_MODEL).toBeUndefined(); // empty value is "unset"
  });
});

describe("loadAiEnv precedence + sources", () => {
  const files = { "/a/env": `ANTHROPIC_API_KEY=${A}\nDBB_AI_MODEL=from-file`, "/b/env": `OPENAI_API_KEY=${O}\nANTHROPIC_API_KEY=should-lose` };
  const readFile = (p: string) => {
    const t = (files as Record<string, string>)[p];
    if (t === undefined) throw new Error("ENOENT");
    return t;
  };
  it("environment beats files; earlier files beat later ones; missing files are skipped", () => {
    const { values, sources } = loadAiEnv({ env: { OPENAI_API_KEY: "from-env" }, files: ["/missing", "/a/env", "/b/env"], readFile });
    expect(values.OPENAI_API_KEY).toBe("from-env");
    expect(values.ANTHROPIC_API_KEY).toBe(A);
    expect(sources).toMatchObject({ OPENAI_API_KEY: "env", ANTHROPIC_API_KEY: "/a/env", DBB_AI_MODEL: "/a/env" });
  });
});

describe("resolveAi", () => {
  const load = (values: Record<string, string>) => ({ values, sources: Object.fromEntries(Object.keys(values).map((k) => [k, "env"])) });
  it("defaults to Anthropic when both keys exist", () => {
    const c = resolveAi(load({ ANTHROPIC_API_KEY: A, OPENAI_API_KEY: O }))!;
    expect(c.provider).toBe("anthropic");
    expect(c.model).toBe(DEFAULT_MODELS.anthropic);
    expect(c.available).toEqual(["anthropic", "openai"]);
  });
  it("falls back to OpenAI when it is the only key", () => {
    const c = resolveAi(load({ OPENAI_API_KEY: O }))!;
    expect(c.provider).toBe("openai");
    expect(c.model).toBe(DEFAULT_MODELS.openai);
  });
  it("returns null with no keys", () => {
    expect(resolveAi(load({}))).toBeNull();
    expect(resolveAi(load({ DBB_AI_PROVIDER: "openai" }))).toBeNull();
  });
  it("honours DBB_AI_PROVIDER only when that provider has a key", () => {
    expect(resolveAi(load({ ANTHROPIC_API_KEY: A, OPENAI_API_KEY: O, DBB_AI_PROVIDER: "openai" }))!.provider).toBe("openai");
    expect(resolveAi(load({ ANTHROPIC_API_KEY: A, DBB_AI_PROVIDER: "openai" }))!.provider).toBe("anthropic");
  });
  it("model overrides: per-provider beats generic beats default", () => {
    const base = { ANTHROPIC_API_KEY: A, OPENAI_API_KEY: O };
    expect(resolveAi(load({ ...base, DBB_AI_MODEL: "generic" }))!.model).toBe("generic");
    expect(resolveAi(load({ ...base, DBB_AI_MODEL: "generic", DBB_AI_MODEL_ANTHROPIC: "claude-haiku-5-5" }))!.model).toBe("claude-haiku-5-5");
  });
});

describe("describeAi / redact never expose key material", () => {
  const cfg = resolveAi({ values: { ANTHROPIC_API_KEY: A, OPENAI_API_KEY: O }, sources: { ANTHROPIC_API_KEY: "/home/u/.dbbasic/env", OPENAI_API_KEY: "env" } })!;
  it("the UI description contains no key", () => {
    const json = JSON.stringify(describeAi(cfg));
    expect(json).not.toContain(A);
    expect(json).not.toContain(O);
    expect(describeAi(cfg).keySources).toEqual({ anthropic: "/home/u/.dbbasic/env", openai: "env" });
    expect(describeAi(null)).toEqual({ configured: false, available: [], keySources: {} });
  });
  it("redact strips held keys and unknown key-shaped strings from error text", () => {
    const msg = `401 for key ${A} and also sk-proj-ZZZZZZZZZZZZZZZZZZZZZZZZZZ plus ${O}`;
    const r = redact(msg, cfg);
    expect(r).not.toContain(A);
    expect(r).not.toContain(O);
    expect(r).not.toContain("sk-proj-ZZZZ");
    expect(redact("plain error", null)).toBe("plain error");
  });
});
