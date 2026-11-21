/**
 * The chat, main-process side: one conversation, one model, the page tools, and the person's say over every action.
 *
 * Privacy and safety rules (the point of the design):
 *  - Nothing goes to a model until the person sends a message, and the first message per model each session asks
 *    first, naming the model and where it is (a provider, or a machine on your network). DBB_AI_CONSENT=1
 *    pre-answers yes, for scripted runs.
 *  - What the assistant reads from pages goes to the model; the panel says so for every read, with how much. Field lists
 *    leave out password, card and code values, but visible page text is visible to it, and the consent question says so.
 *  - Every action is announced; by default each one waits for a yes ("ask"). In "auto" only the risky ones do.
 *  - Off while the caller network is on (that mode makes no requests of its own, and a model call is one).
 *  - API keys stay in this process; the panel only ever sees provider and model names.
 */

import { estimateCostUsd } from "./ai.js";
import { describeAi, redact, type AiConfig } from "./ai-config.js";
import { MAX_RESULT_CHARS, newBoundary, runChat, wrapResult, type ChatEvent, type ChatMsg, type ModelClient, type Policy, type ToolDef } from "./chat-core.js";
import { chatAi, chatModelChoices } from "./chat-model-choice.js";
import { chatModel } from "./chat-models.js";
import { pageTools, type Runner } from "./chat-tools.js";

export type PanelEvent =
  | ChatEvent
  | { kind: "user"; text: string }
  | { kind: "confirm"; id: string; name: string; summary: string; danger: boolean }
  | { kind: "confirm-settled"; id: string; ok: boolean }
  | { kind: "cleared" }
  /** A command the person ran themselves (from the address bar), and what came back. */
  | { kind: "command"; typed: string; tool: string; readOnly: boolean; sentence: string; page?: string; items?: Array<{ title: string; page?: string }>; details: string };
export type LoggedEvent = PanelEvent & { seq: number };

export interface ChatDeps {
  getAi(): AiConfig | null;
  /** Run a browser automation method (tabs.*, page.*) in this process. */
  run: Runner;
  /** Send to the chrome UI. */
  toPanel(payload: LoggedEvent): void;
  /** For the browser's event log: one line per finished run, never silent. */
  announce(payload: Record<string, unknown>): void;
  callerNetworkOn(): boolean;
  /** Ask the person whether the assistant may send what it reads to this model. */
  consent(what: { provider: string; model: string; where: string }): Promise<boolean>;
  /** Tools from connected services (see mcp-service.ts), asked for at the start of each message. */
  extraTools?(): Promise<ToolDef[]>;
  /** Tests and tools can supply the model. */
  modelFor?(cfg: AiConfig): ModelClient;
  /** Where the model picked in the panel is remembered ("provider/model"). */
  modelChoice?: { load(): string | null; save(id: string): void };
}

export interface SendResult {
  ok: boolean;
  reason?: "caller-network-on" | "no-ai" | "busy" | "declined" | "empty";
  message?: string;
  /** How the run ended, when it ran. */
  ended?: Extract<ChatEvent, { kind: "done" }>["reason"];
  reply?: string;
  events?: LoggedEvent[];
}

const MAX_LOG = 500;

export class ChatService {
  private history: ChatMsg[] = [];
  private log: LoggedEvent[] = [];
  private seq = 0;
  private running: AbortController | null = null;
  private pending = new Map<string, (ok: boolean) => void>();
  private consented = new Set<string>();
  /** A random word for this conversation's untrusted tags; a new conversation gets a new one. */
  private boundary = newBoundary();
  mode: Policy["mode"] = "ask";
  /** The conversation has read private data from the person's accounts, so actions that could carry it out always ask. */
  private tainted = false;
  /** Records of commands run while the assistant was busy, added to the conversation when it is done. */
  private queued: string[] = [];

  /** The model picked in the panel, "provider/model", or null for the default. */
  private choice: string | null;

  constructor(private deps: ChatDeps) {
    this.choice = deps.modelChoice?.load() ?? null;
  }

  /** The AI config the chat runs with: the env file's, with the model picked in the panel. */
  private ai(): AiConfig | null {
    return chatAi(this.deps.getAi(), this.choice);
  }

  /** Pick the chat's model ("provider/model", one of those on offer). Takes effect from the next message; remembered. */
  setModel(id: unknown): { ok: boolean; model: string | null } {
    const c = chatModelChoices(this.deps.getAi()).find((x) => x.id === id);
    if (!c) return { ok: false, model: this.ai()?.model ?? null };
    this.choice = c.id;
    this.deps.modelChoice?.save(c.id);
    return { ok: true, model: c.model };
  }

  private push(e: PanelEvent): LoggedEvent {
    const le = { ...e, seq: ++this.seq } as LoggedEvent;
    this.log.push(le);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    this.deps.toPanel(le);
    return le;
  }

  state() {
    const cfg = this.ai();
    const ai = describeAi(cfg);
    return {
      available: ai.configured && !this.deps.callerNetworkOn(),
      callerNetworkOn: this.deps.callerNetworkOn(),
      provider: ai.provider ?? null,
      model: ai.model ?? null,
      modelId: cfg ? `${cfg.provider}/${cfg.model}` : null,
      models: chatModelChoices(this.deps.getAi()).map(({ id, label }) => ({ id, label })),
      endpoint: ai.endpoint ?? null,
      mode: this.mode,
      running: this.running !== null,
      pending: [...this.pending.keys()],
      transcript: this.log.filter((e) => e.kind !== "usage"),
      seq: this.seq,
    };
  }

  eventsSince(n: number): { events: LoggedEvent[]; next: number } {
    return { events: this.log.filter((e) => e.seq > n), next: this.seq };
  }

  setMode(m: unknown): Policy["mode"] {
    if (m === "ask" || m === "auto") this.mode = m;
    return this.mode;
  }

  clear(): void {
    this.stop();
    this.history = [];
    this.queued = [];
    this.tainted = false;
    this.boundary = newBoundary();
    this.log = [];
    this.push({ kind: "cleared" });
  }

  stop(): void {
    this.running?.abort();
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      resolve(false);
    }
  }

  /** The person's answer to an action they were asked about. */
  confirm(id: string, ok: boolean): boolean {
    const r = this.pending.get(id);
    if (!r) return false;
    this.pending.delete(id);
    this.push({ kind: "confirm-settled", id, ok });
    r(ok);
    return true;
  }

  /**
   * Something the person ran themselves from the address bar: shown in the conversation, and kept in it so the next
   * message can ask about it ("open the second one"). What came back is marked as from the person's account, never as
   * instructions, like any tool result; and from here on, actions that could carry it out of the browser ask first.
   */
  recordCommand(c: { typed: string; tool: string; readOnly: boolean; args: Record<string, unknown>; sentence: string; page?: string; items?: Array<{ title: string; page?: string }>; details: string; server: string }): void {
    const details = c.details.slice(0, MAX_RESULT_CHARS);
    this.push({ kind: "command", typed: c.typed.slice(0, 2000), tool: c.tool, readOnly: c.readOnly, sentence: c.sentence, ...(c.page ? { page: c.page } : {}), ...(c.items ? { items: c.items } : {}), details });
    const record =
      `[Not a message to you. A record: the person ran a command themselves, from the browser's address bar. It already ran; do not run it again unless asked. It is here so you can answer questions about it.]\n` +
      `They typed: ${c.typed.slice(0, 2000)}\n` +
      `It called ${c.server}__${c.tool} with ${JSON.stringify(c.args).slice(0, 2000)}${c.page ? `; the thing made is at ${c.page}` : ""}. The answer:\n` +
      wrapResult(c.details.slice(0, 8000), this.boundary, "account");
    this.tainted = true;
    if (this.running) this.queued.push(record);
    else this.addRecord(record);
  }
  private addRecord(record: string) {
    const last = this.history[this.history.length - 1];
    if (last?.role === "user") last.text = `${last.text}\n\n${record}`;
    else this.history.push({ role: "user", text: record });
  }

  /** One message from the person; resolves when the assistant is done. */
  async send(text: string): Promise<SendResult> {
    const cfg = this.ai();
    if (this.deps.callerNetworkOn()) return { ok: false, reason: "caller-network-on", message: "The chat is switched off while the caller network is on." };
    if (!cfg) return { ok: false, reason: "no-ai", message: "No AI is set up. Put ANTHROPIC_API_KEY or OPENAI_API_KEY in ~/.dbbasic/env, or set DBB_AI_BASE_URL for a model on your network." };
    if (this.running) return { ok: false, reason: "busy", message: "The assistant is still working on the last message. Stop it first." };
    const t = String(text ?? "").trim();
    if (!t) return { ok: false, reason: "empty" };

    const model = (this.deps.modelFor ?? chatModel)(cfg);
    const where = cfg.provider === "openai" && cfg.baseUrl ? new URL(cfg.baseUrl).host : model.provider === "anthropic" ? "Anthropic" : "OpenAI";
    const key = `${model.provider}/${model.model}/${where}`;
    if (!this.consented.has(key)) {
      if (process.env.DBB_AI_CONSENT !== "1" && !(await this.deps.consent({ provider: model.provider, model: model.model, where }))) {
        return { ok: false, reason: "declined", message: "Not sent. Nothing leaves the browser until you agree." };
      }
      this.consented.add(key);
    }

    const ctl = new AbortController();
    this.running = ctl;
    const start = this.seq;
    this.push({ kind: "user", text: t });
    let inTok = 0;
    let outTok = 0;
    let steps = 0;
    let ended: SendResult["ended"] = "error";
    let reply = "";
    try {
      await runChat({
        model,
        tools: [...pageTools(this.deps.run), ...((await this.deps.extraTools?.().catch(() => [])) ?? [])],
        history: this.history,
        userText: t,
        policy: { mode: this.mode },
        boundary: this.boundary,
        signal: ctl.signal,
        confirm: (a) =>
          new Promise<boolean>((resolve) => {
            this.pending.set(a.id, resolve);
            this.push({ kind: "confirm", id: a.id, name: a.name, summary: a.summary, danger: a.danger });
          }),
        emit: (e) => {
          if (e.kind === "usage") {
            inTok += e.inputTokens;
            outTok += e.outputTokens;
            steps++;
          }
          if (e.kind === "text") reply = e.text;
          if (e.kind === "done") ended = e.reason;
          // Redact anything that looks like a key before it reaches the panel.
          this.push(e.kind === "done" && e.message ? { ...e, message: redact(e.message, cfg) } : e.kind === "text" ? { ...e, text: redact(e.text, cfg) } : e);
        },
        context: () =>
          `The person is looking at one tab at a time; tools act on the active tab unless you pass a tab id. Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} (their local date).`,
        tainted: this.tainted,
        onTainted: () => {
          this.tainted = true;
        },
      });
    } finally {
      this.running = null;
      this.stop();
      for (const r of this.queued.splice(0)) this.addRecord(r);
    }
    const cost = cfg.provider === "anthropic" ? estimateCostUsd(model.model, { inputTokens: inTok, outputTokens: outTok }) : null;
    this.deps.announce({ kind: "ai-chat", provider: model.provider, model: model.model, where, modelCalls: steps, inputTokens: inTok, outputTokens: outTok, costUsd: cost, ended });
    return { ok: true, ended, reply: redact(reply, cfg), events: this.log.filter((e) => e.seq > start) };
  }
}
