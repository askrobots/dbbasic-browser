/**
 * AI Reader, main-process side: read the page, open the reader tab, write the TL;DR.
 *
 * Privacy rules (the point of the design):
 *  - Nothing is sent anywhere unless the user clicks Reader (or an automation client explicitly passes
 *    `acknowledge: true`). Page text goes to the AI provider ONLY for the TL;DR; the reader view itself
 *    is built locally.
 *  - The first summary per provider each session asks first, naming the provider, the model, the host
 *    and how much text. (DBB_AI_CONSENT=1 pre-answers yes, for scripted demos.)
 *  - Pages with a visible password field are never read.
 *  - Every provider call is announced as an `ai-summary` event (toast + event log) with the host, how
 *    many characters were sent, and what it cost — never silent, like every other spend in the browser.
 *  - API keys stay in this process; the UI only ever receives provider and model names.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dialog, webContents, type BrowserWindow, type WebContents } from "electron";
import { AiError, summarize, type SummaryResult } from "./ai.js";
import { redact, type AiConfig, type Provider } from "./ai-config.js";
import { blocksToText, buildReaderHtml, footFor, readerDataUrl, tldrUpdateScript, validateExtraction, type Extracted } from "./reader.js";
import { safeExternalUrl } from "./urls.js";

const here = dirname(fileURLToPath(import.meta.url));
let assets: { readability: string; extractor: string } | null = null;
function loadAssets() {
  assets ??= {
    readability: readFileSync(join(here, "Readability.js"), "utf8"),
    extractor: readFileSync(join(here, "reader-extractor.js"), "utf8"),
  };
  return assets;
}

const LABEL: Record<Provider, string> = { anthropic: "Anthropic", openai: "OpenAI" };

export interface ReaderDeps {
  getWindow(): BrowserWindow | null;
  askChrome(op: string, args: Record<string, unknown>): Promise<unknown>;
  emit(payload: Record<string, unknown>): void;
  getAi(): AiConfig | null;
}

export interface OpenOptions {
  wcId: number;
  /** A human clicked: ask for consent with a dialog. False for automation, which must pass `acknowledge`. */
  interactive: boolean;
  /** false = open the reader with no AI summary at all. */
  withAi?: boolean;
  acknowledge?: boolean;
}

export interface ReaderResult {
  ok: boolean;
  reason?: "not-web" | "login" | "unreadable" | "is-reader" | "no-tab" | "error";
  message?: string;
  tab?: { id: number; wcId: number };
  /** What happened with the summary: pending (still running), or the final state. */
  ai?: { state: "pending" | "none" | "declined"; provider?: Provider; model?: string };
  /** Resolves when the summary has been written (or failed). Not serialized. */
  done?: Promise<AiOutcome>;
}

export type AiOutcome =
  | { ok: true; provider: Provider; model: string; tldr: string; points: string[]; kind: string; ms: number; costUsd: number | null; usage: { inputTokens: number; outputTokens: number }; sentChars: number; truncated: boolean }
  | { ok: false; code: string; message: string }
  | { ok: false; code: "skipped"; message: string };

export function createReader(deps: ReaderDeps) {
  const consented = new Set<Provider>(process.env.DBB_AI_CONSENT === "1" ? ["anthropic", "openai"] : []);
  const win = () => deps.getWindow();

  const isOurGuest = (wc: WebContents | undefined): wc is WebContents => {
    const w = win();
    return !!wc && !wc.isDestroyed() && wc.getType() === "webview" && !!w && wc.hostWebContents === w.webContents;
  };

  async function extract(wc: WebContents): Promise<unknown> {
    const a = loadAssets();
    const full = `(() => {\n${a.readability}\n;return (${a.extractor})(typeof Readability === "function" ? Readability : null);\n})()`;
    try {
      return await wc.executeJavaScript(full, false);
    } catch {
      // A page whose CSP/Trusted Types blocks Readability's DOM work: fall back to visible text only.
      return await wc.executeJavaScript(`(${a.extractor})(null)`, false);
    }
  }

  async function askConsent(cfg: AiConfig, ex: Extracted, chars: number): Promise<boolean> {
    if (consented.has(cfg.provider)) return true;
    const w = win();
    if (!w) return false;
    const label = LABEL[cfg.provider];
    const host = new URL(ex.url).host;
    const { response, checkboxChecked } = await dialog.showMessageBox(w, {
      type: "question",
      buttons: ["Summarize", "Read without a summary"],
      defaultId: 0,
      cancelId: 1,
      title: "Send this page to an AI provider?",
      message: `Send the text of this page to ${label} (${cfg.model}) to write a TL;DR?`,
      detail:
        `About ${chars.toLocaleString("en-US")} characters of text from ${host} will be sent to ${label}. ` +
        `Pages with a login form are never read. Usage is billed to your ${label} account.\n\n` +
        `The reader view itself is built on this computer; only the summary comes from ${label}.`,
      checkboxLabel: `Don't ask again this session for ${label}`,
    });
    if (response !== 0) return false;
    if (checkboxChecked) consented.add(cfg.provider);
    return true;
  }

  async function open(o: OpenOptions): Promise<ReaderResult> {
    const wc = webContents.fromId(o.wcId);
    if (!isOurGuest(wc)) return { ok: false, reason: "no-tab", message: "No such tab." };
    const url = wc.getURL();
    if (url.startsWith("data:text/html")) return { ok: false, reason: "is-reader", message: "This tab is already a reader view." };
    if (!safeExternalUrl(url)) return { ok: false, reason: "not-web", message: "Only web pages can be opened in the AI Reader." };

    let raw: unknown;
    try {
      raw = await extract(wc);
    } catch {
      return { ok: false, reason: "unreadable", message: "Couldn't read this page." };
    }
    if (raw && typeof raw === "object" && (raw as { error?: string }).error === "login") {
      return { ok: false, reason: "login", message: "This page has a login form, so it isn't read by the AI Reader." };
    }
    const ex = validateExtraction(raw);
    if (!ex) return { ok: false, reason: "unreadable", message: "There's no readable text on this page." };
    const text = blocksToText(ex.blocks);

    // ---- decide whether anything may leave this machine ----
    const cfg = deps.getAi();
    let state: "pending" | "none" | "declined" = "none";
    if (cfg && o.withAi !== false) {
      const allowed = o.interactive ? await askConsent(cfg, ex, Math.min(text.length, 60_000)) : !!o.acknowledge || consented.has(cfg.provider);
      state = allowed ? "pending" : "declined";
    } else if (cfg) state = "declined";

    // ---- open the reader tab (built locally from validated data) ----
    const html = buildReaderHtml(ex, {
      ai: state === "pending" && cfg ? { state: "pending", provider: LABEL[cfg.provider], model: cfg.model } : { state: state === "pending" ? "none" : state },
    });
    let tab: { id: number; wcId: number };
    try {
      tab = (await deps.askChrome("tab.new", { url: readerDataUrl(html), activate: true, wait: true, reader: ex.url })) as { id: number; wcId: number };
    } catch (e) {
      return { ok: false, reason: "error", message: `Couldn't open the reader tab: ${(e as Error).message}` };
    }

    if (state !== "pending" || !cfg) {
      return { ok: true, tab, ai: { state } };
    }

    // ---- the TL;DR, written in the background ----
    const done = (async (): Promise<AiOutcome> => {
      const target = () => {
        const t = webContents.fromId(tab.wcId);
        return t && !t.isDestroyed() ? t : null;
      };
      deps.emit({ kind: "reader-busy", wcId: tab.wcId, busy: true, provider: LABEL[cfg.provider], model: cfg.model });
      try {
        const r: SummaryResult = await summarize(cfg, { title: ex.title, url: ex.url, text, lang: ex.lang });
        const t = target();
        if (t) await t.executeJavaScript(tldrUpdateScript({ state: "done", tldr: r.tldr, points: r.points, foot: footFor(r) }));
        // Never silent: every provider call is an event, with what was sent and what it cost.
        deps.emit({
          kind: "ai-summary",
          provider: r.provider,
          model: r.model,
          host: new URL(ex.url).host,
          sentChars: r.sentChars,
          truncated: r.truncated,
          ms: r.ms,
          inputTokens: r.usage.inputTokens,
          outputTokens: r.usage.outputTokens,
          costUsd: r.costUsd,
        });
        return { ok: true, provider: r.provider, model: r.model, tldr: r.tldr, points: r.points, kind: r.kind, ms: r.ms, costUsd: r.costUsd, usage: r.usage, sentChars: r.sentChars, truncated: r.truncated };
      } catch (e) {
        const err = e instanceof AiError ? e : new AiError("provider", String((e as Error)?.message ?? e));
        const message = redact(err.message, cfg);
        const t = target();
        if (t) await t.executeJavaScript(tldrUpdateScript({ state: "error", tldr: `The summary could not be written: ${message}`, points: [], foot: "" })).catch(() => {});
        deps.emit({ kind: "ai-error", provider: cfg.provider, model: cfg.model, code: err.code, message });
        return { ok: false, code: err.code, message };
      } finally {
        deps.emit({ kind: "reader-busy", wcId: tab.wcId, busy: false });
      }
    })();

    return { ok: true, tab, ai: { state: "pending", provider: cfg.provider, model: cfg.model }, done };
  }

  return { open };
}

export type ReaderService = ReturnType<typeof createReader>;
