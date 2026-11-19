/**
 * The AI Reader's document model and page builder — Electron-free so it is unit-tested.
 *
 * Trust boundary: extraction runs INSIDE the (hostile) page, so whatever it returns is untrusted data —
 * a page can tamper with the extractor, lie about its structure, or try to smuggle markup through.
 * Nothing it returns is ever used as HTML. `validateExtraction` accepts only a small plain-data
 * vocabulary (headings, paragraphs, lists, quotes, code, images, links), clamps every size, and drops
 * anything else; `buildReaderHtml` then writes the page from scratch with every string escaped. The
 * result is a script-free document under a strict CSP (no scripts, no forms, no frames, no connections).
 */

import type { Summary } from "./ai.js";

export interface Run {
  x: string;
  b?: 1;
  i?: 1;
  c?: 1;
  href?: string;
}

export type Block =
  | { t: "h"; level: number; runs: Run[] }
  | { t: "p"; runs: Run[] }
  | { t: "ul" | "ol"; items: Run[][] }
  | { t: "quote"; runs: Run[] }
  | { t: "pre"; text: string }
  | { t: "img"; src: string; alt: string }
  | { t: "hr" };

export interface Extracted {
  /** "article" when a main article was found; "text" when we fell back to the page's visible text. */
  mode: "article" | "text";
  url: string;
  title: string;
  byline: string;
  siteName: string;
  lang: string;
  blocks: Block[];
}

export const LIMITS = { blocks: 800, runs: 400, items: 200, runChars: 4000, totalChars: 250_000, title: 300 } as const;

const str = (v: unknown, max: number): string => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);

/** http(s) only, no credentials — anything else (javascript:, data:, file:, blob:) is dropped. */
export function safeHttpUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 4000) return null;
  try {
    const u = new URL(v);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

function cleanRuns(v: unknown, budget: { left: number }): Run[] {
  if (!Array.isArray(v)) return [];
  const out: Run[] = [];
  for (const r of v.slice(0, LIMITS.runs)) {
    if (!r || typeof r !== "object" || budget.left <= 0) continue;
    const o = r as Record<string, unknown>;
    const x = str(o.x, LIMITS.runChars);
    if (!x) continue;
    budget.left -= x.length;
    const run: Run = { x };
    if (o.b) run.b = 1;
    if (o.i) run.i = 1;
    if (o.c) run.c = 1;
    const href = safeHttpUrl(o.href);
    if (href) run.href = href;
    out.push(run);
  }
  return out;
}

/** Accept only well-formed plain data; null if it isn't an extraction at all. */
export function validateExtraction(raw: unknown): Extracted | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const url = safeHttpUrl(o.url);
  if (!url || !Array.isArray(o.blocks)) return null;
  const budget = { left: LIMITS.totalChars };
  const blocks: Block[] = [];
  for (const b of o.blocks.slice(0, LIMITS.blocks)) {
    if (!b || typeof b !== "object" || budget.left <= 0) continue;
    const r = b as Record<string, unknown>;
    switch (r.t) {
      case "h": {
        const runs = cleanRuns(r.runs, budget);
        if (runs.length) blocks.push({ t: "h", level: Math.min(6, Math.max(2, Math.trunc(Number(r.level)) || 2)), runs });
        break;
      }
      case "p":
      case "quote": {
        const runs = cleanRuns(r.runs, budget);
        if (runs.length) blocks.push({ t: r.t, runs });
        break;
      }
      case "ul":
      case "ol": {
        const items = (Array.isArray(r.items) ? r.items.slice(0, LIMITS.items) : []).map((it) => cleanRuns(it, budget)).filter((it) => it.length);
        if (items.length) blocks.push({ t: r.t, items });
        break;
      }
      case "pre": {
        const text = str(r.text, LIMITS.runChars * 4);
        if (text.trim()) {
          budget.left -= text.length;
          blocks.push({ t: "pre", text });
        }
        break;
      }
      case "img": {
        const src = safeHttpUrl(r.src);
        if (src) blocks.push({ t: "img", src, alt: str(r.alt, 300) });
        break;
      }
      case "hr":
        blocks.push({ t: "hr" });
        break;
      default:
        break; // unknown vocabulary: dropped
    }
  }
  if (blocks.length === 0) return null;
  return {
    mode: o.mode === "article" ? "article" : "text",
    url,
    title: str(o.title, LIMITS.title).replace(/\s+/g, " ").trim() || new URL(url).host,
    byline: str(o.byline, 200).replace(/\s+/g, " ").trim(),
    siteName: str(o.siteName, 100).replace(/\s+/g, " ").trim(),
    lang: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(str(o.lang, 20)) ? str(o.lang, 20) : "en",
    blocks,
  };
}

const runsText = (runs: Run[]) => runs.map((r) => r.x).join("");

/** The article as plain text (what the summarizer is given). */
export function blocksToText(blocks: Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.t === "h") parts.push(`${"#".repeat(Math.min(b.level, 4))} ${runsText(b.runs)}`);
    else if (b.t === "p" || b.t === "quote") parts.push(runsText(b.runs));
    else if (b.t === "ul" || b.t === "ol") parts.push(b.items.map((it, i) => `${b.t === "ol" ? `${i + 1}.` : "-"} ${runsText(it)}`).join("\n"));
    else if (b.t === "pre") parts.push(b.text);
    else if (b.t === "img" && b.alt) parts.push(`[image: ${b.alt}]`);
  }
  return parts.join("\n\n");
}

export const wordCount = (text: string) => (text.match(/\S+/g) ?? []).length;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function runsHtml(runs: Run[]): string {
  return runs
    .map((r) => {
      let h = escapeHtml(r.x);
      if (r.c) h = `<code>${h}</code>`;
      if (r.i) h = `<em>${h}</em>`;
      if (r.b) h = `<strong>${h}</strong>`;
      if (r.href) h = `<a href="${escapeHtml(r.href)}" rel="noopener noreferrer">${h}</a>`;
      return h;
    })
    .join("");
}

function blockHtml(b: Block): string {
  switch (b.t) {
    case "h":
      return `<h${b.level}>${runsHtml(b.runs)}</h${b.level}>`;
    case "p":
      return `<p>${runsHtml(b.runs)}</p>`;
    case "quote":
      return `<blockquote>${runsHtml(b.runs)}</blockquote>`;
    case "ul":
    case "ol":
      return `<${b.t}>${b.items.map((it) => `<li>${runsHtml(it)}</li>`).join("")}</${b.t}>`;
    case "pre":
      return `<pre>${escapeHtml(b.text)}</pre>`;
    case "img":
      return `<figure><img src="${escapeHtml(b.src)}" alt="${escapeHtml(b.alt)}" loading="lazy" referrerpolicy="no-referrer"></figure>`;
    case "hr":
      return "<hr>";
  }
}

export type AiState = "pending" | "none" | "declined" | "error";
export interface ReaderView {
  ai:
    | { state: AiState; provider?: string; model?: string; message?: string }
    /** The finished summary — what a Back/Forward/reload of the reader page must show. */
    | { state: "done"; tldr: string; points: string[]; foot: string };
}

export const READER_CSP = "default-src 'none'; img-src http: https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const STYLE = `
:root { color-scheme: light dark; --bg:#faf8f4; --fg:#1d1d1f; --muted:#6b6b72; --rule:#e4e0d8; --card:#fff; --accent:#2f5fd0; --tldr:#eef3ff; --tldr-rule:#c9d8ff; --sk:#dfe6f7; }
@media (prefers-color-scheme: dark) { :root { --bg:#16161a; --fg:#e8e8ea; --muted:#9a9aa2; --rule:#2c2c33; --card:#1e1e24; --accent:#7aa2ff; --tldr:#1a2033; --tldr-rule:#2c3d6b; --sk:#26304f; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 19px/1.72 Charter, "Iowan Old Style", Georgia, "Times New Roman", serif; }
main { max-width: 700px; margin: 0 auto; padding: 44px 22px 90px; }
.badge { display: inline-block; font: 600 11px/1 -apple-system, system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); border: 1px solid var(--tldr-rule); border-radius: 999px; padding: 5px 10px; margin-bottom: 18px; }
h1 { font: 700 34px/1.2 -apple-system, "Helvetica Neue", system-ui, sans-serif; letter-spacing: -.02em; margin: 0 0 12px; }
.meta { font: 14px/1.5 -apple-system, system-ui, sans-serif; color: var(--muted); margin: 0 0 28px; }
.meta a { color: var(--muted); }
.tldr { background: var(--tldr); border: 1px solid var(--tldr-rule); border-radius: 14px; padding: 18px 22px 16px; margin: 0 0 38px; font: 16.5px/1.6 -apple-system, system-ui, sans-serif; }
.tldr .lbl { font-weight: 700; font-size: 12px; letter-spacing: .1em; color: var(--accent); margin-bottom: 8px; }
.tldr #tldr-body { font-size: 18px; line-height: 1.55; font-weight: 500; }
.tldr ul { margin: 12px 0 0; padding-left: 20px; } .tldr li { margin: 4px 0; }
.tldr .foot { margin-top: 12px; font-size: 12px; color: var(--muted); }
.tldr .sk { display: none; }
.tldr.pending #tldr-body { display: none; }
.tldr.pending .sk { display: block; height: 13px; border-radius: 7px; background: var(--sk); margin: 9px 0; animation: pulse 1.3s ease-in-out infinite; }
.tldr.pending .sk:nth-child(3) { width: 82%; } .tldr.pending .sk:nth-child(4) { width: 58%; }
.tldr.none, .tldr.declined, .tldr.error { background: var(--card); border-color: var(--rule); }
.tldr.none .lbl, .tldr.declined .lbl, .tldr.error .lbl { color: var(--muted); }
.tldr.none #tldr-body, .tldr.declined #tldr-body, .tldr.error #tldr-body { font-weight: 400; font-size: 15px; color: var(--muted); }
@keyframes pulse { 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) { .tldr.pending .sk { animation: none; } }
article h2, article h3, article h4, article h5, article h6 { font-family: -apple-system, "Helvetica Neue", system-ui, sans-serif; line-height: 1.3; letter-spacing: -.01em; margin: 1.9em 0 .6em; }
article h2 { font-size: 26px; } article h3 { font-size: 21px; } article h4, article h5, article h6 { font-size: 18px; }
article p { margin: 0 0 1.1em; } article a { color: var(--accent); }
article ul, article ol { padding-left: 1.3em; margin: 0 0 1.1em; } article li { margin: .3em 0; }
article blockquote { margin: 1.2em 0; padding: .1em 0 .1em 1.1em; border-left: 3px solid var(--rule); color: var(--muted); }
article pre { overflow: auto; background: var(--card); border: 1px solid var(--rule); border-radius: 10px; padding: 14px 16px; font: 14px/1.5 ui-monospace, Menlo, monospace; }
article code { font: .86em ui-monospace, Menlo, monospace; background: var(--card); border: 1px solid var(--rule); border-radius: 5px; padding: .08em .35em; }
article figure { margin: 1.6em 0; } article img { max-width: 100%; height: auto; border-radius: 8px; display: block; }
hr { border: 0; border-top: 1px solid var(--rule); margin: 2em 0; }
footer { margin-top: 48px; padding-top: 18px; border-top: 1px solid var(--rule); font: 14px/1.5 -apple-system, system-ui, sans-serif; color: var(--muted); }
footer a { color: var(--accent); }
`;

const AI_NOTE: Record<Exclude<AiState, "pending">, string> = {
  none: "No AI summary: add an Anthropic or OpenAI API key (see Help ▸ AI Reader).",
  declined: "No summary was written, so nothing from this page was sent to an AI provider.",
  error: "The summary could not be written.",
};

export function buildReaderHtml(ex: Extracted, view: ReaderView): string {
  const text = blocksToText(ex.blocks);
  const words = wordCount(text);
  const minutes = Math.max(1, Math.round(words / 220));
  let host = ex.url;
  try {
    host = new URL(ex.url).host;
  } catch {
    /* keep the url */
  }
  const meta = [ex.byline, ex.siteName && ex.siteName !== host ? ex.siteName : host, `${minutes} min read`].filter(Boolean).map(escapeHtml).join(" · ");
  const ai = view.ai;
  const pending = ai.state === "pending";
  const body = pending
    ? `<div class="sk"></div><div class="sk"></div><div class="sk"></div><div id="tldr-body"></div>`
    : ai.state === "done"
      ? `<div id="tldr-body">${escapeHtml(ai.tldr)}</div>`
      : `<div id="tldr-body">${escapeHtml(ai.state === "error" && ai.message ? `${AI_NOTE.error} ${ai.message}` : AI_NOTE[ai.state as Exclude<AiState, "pending">])}</div>`;
  const points = ai.state === "done" ? ai.points.map((p) => `<li>${escapeHtml(p)}</li>`).join("") : "";
  const foot =
    ai.state === "done"
      ? escapeHtml(ai.foot)
      : pending && ai.provider
        ? `Summarizing with ${escapeHtml(ai.provider)}${ai.model ? ` · ${escapeHtml(ai.model)}` : ""}…`
        : "";
  const note = ex.mode === "text" ? `<p class="meta">This page isn't an article, so this is its visible text, not a cleaned-up article.</p>` : "";
  return `<!doctype html>
<html lang="${escapeHtml(ex.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${READER_CSP}"><meta name="referrer" content="no-referrer">
<title>${escapeHtml(ex.title)}</title><style>${STYLE}</style></head>
<body><main>
<header><div class="badge">AI Reader</div><h1>${escapeHtml(ex.title)}</h1><p class="meta">${meta} · <a href="${escapeHtml(ex.url)}" rel="noopener noreferrer">original</a></p></header>
<section id="tldr" class="tldr ${ai.state}"><div class="lbl">TL;DR</div>${body}<ul id="tldr-points">${points}</ul><div id="tldr-foot" class="foot">${foot}</div></section>
${note}<article>${ex.blocks.map(blockHtml).join("\n")}</article>
<footer>Read on the original page: <a href="${escapeHtml(ex.url)}" rel="noopener noreferrer">${escapeHtml(host)}</a></footer>
</main></body></html>`;
}

export function readerDataUrl(html: string): string {
  return `data:text/html;charset=utf-8;base64,${Buffer.from(html, "utf8").toString("base64")}`;
}

export interface TldrUpdate {
  state: "done" | "error";
  tldr: string;
  points: string[];
  foot: string;
}

/**
 * JavaScript that fills the TL;DR in an already-open reader page. Values are embedded as JSON string
 * literals and written with textContent only — never as HTML.
 */
export function tldrUpdateScript(u: TldrUpdate): string {
  return `(() => {
  const d = document, sec = d.getElementById("tldr");
  if (!sec) return false;
  sec.className = "tldr " + ${JSON.stringify(u.state === "done" ? "done" : "error")};
  d.getElementById("tldr-body").textContent = ${JSON.stringify(u.tldr)};
  const ul = d.getElementById("tldr-points"); ul.textContent = "";
  for (const p of ${JSON.stringify(u.points)}) { const li = d.createElement("li"); li.textContent = p; ul.appendChild(li); }
  d.getElementById("tldr-foot").textContent = ${JSON.stringify(u.foot)};
  return true;
})()`;
}

export function footFor(r: { provider: string; model: string; ms: number; usage: { inputTokens: number; outputTokens: number }; costUsd: number | null; truncated: boolean }): string {
  const cost = r.costUsd == null ? "" : ` · ≈$${r.costUsd < 0.01 ? r.costUsd.toFixed(4) : r.costUsd.toFixed(3)}`;
  const cut = r.truncated ? " · long page: only the first part was summarized" : "";
  return `Summarized by ${r.model} (${r.provider}) in ${(r.ms / 1000).toFixed(1)} s · ${r.usage.inputTokens.toLocaleString("en-US")} in / ${r.usage.outputTokens.toLocaleString("en-US")} out tokens${cost}${cut}`;
}

export const summaryToUpdate = (s: Summary, foot: string): TldrUpdate => ({ state: "done", tldr: s.tldr, points: s.points, foot });
