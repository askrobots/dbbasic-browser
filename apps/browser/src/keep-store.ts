/**
 * "Keep": a copy of a page, so its tab can be closed without losing what was in it. Each kept page is a folder with what the
 * page looked like (an image of what was on screen), its text, and a small record (address, title, time, optional reason and
 * tags). Kept pages are found again by searching their text, and looked at in a tab served by the browser itself
 * (`dbb-kept://<id>/`), which works even when the original page has changed, logged you out or gone away.
 *
 * Local only: nothing here leaves the machine. Electron-free so it is unit-tested.
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

export const KEPT_SCHEME = "dbb-kept";
const ID_RE = /^[0-9a-f]{16}$/;
const MAX_TEXT = 400_000;

export interface KeptRecord {
  id: string;
  url: string;
  title: string;
  /** Epoch ms. */
  keptAt: number;
  reason?: string;
  tags: string[];
  /** Characters of text kept. */
  textChars: number;
  imageBytes: number;
  /** Copies saved to the person's account (askrobots Files), when connected. */
  remote?: { files: Array<{ kind: "image" | "text"; filename: string; id?: string }>; error?: string };
}

/**
 * A readable file name for a kept copy: "<title> (<site>, <date>).<ext>". Characters that file systems or URLs treat
 * specially are dropped, and the name is kept short enough for any of them.
 */
export function keptFilename(r: Pick<KeptRecord, "title" | "url" | "keptAt">, ext: "png" | "txt"): string {
  let host = "";
  try {
    host = new URL(r.url).hostname.replace(/^www\./, "");
  } catch {
    /* no site */
  }
  const clean = (x: string) => x.replace(/[\u0000-\u001f\/\\:*?"<>|#%{}^~\[\]`]+/g, " ").replace(/\s+/g, " ").trim();
  let title = clean(r.title || "");
  const titleIsSite = !title || title.toLowerCase() === host.toLowerCase();
  if (titleIsSite) title = host || "Page";
  if (title.length > 90) title = `${title.slice(0, 89).trimEnd()}…`;
  const date = new Date(r.keptAt).toISOString().slice(0, 10);
  return `${title} (${host && !titleIsSite ? `${host}, ` : ""}${date}).${ext}`;
}

export const keptUrl = (id: string, file = "") => `${KEPT_SCHEME}://${id}/${file}`;

/** The kept page id and the file asked for, from a dbb-kept:// address, or null. */
export function parseKeptUrl(url: string): { id: string; file: "" | "page.png" } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== `${KEPT_SCHEME}:` || !ID_RE.test(u.hostname)) return null;
    const file = u.pathname.replace(/^\/+/, "");
    if (file !== "" && file !== "page.png") return null;
    return { id: u.hostname, file };
  } catch {
    return null;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** The page shown for a kept copy: the image and the text, nothing that runs. */
export function keptPageHtml(r: KeptRecord, text: string): string {
  const when = new Date(r.keptAt).toLocaleString();
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Kept: ${esc(r.title)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${KEPT_SCHEME}:; style-src 'unsafe-inline'">
<style>
body{font:16px/1.6 -apple-system,system-ui,sans-serif;margin:0;color:#222;background:#f6f6f4}
header{position:sticky;top:0;background:#20242c;color:#e8e8ea;padding:10px 22px;font-size:13px;display:flex;gap:14px;align-items:baseline;flex-wrap:wrap}
header b{color:#fff;font-size:14px} header a{color:#9cc3ff} header .r{color:#f0c674}
main{max-width:980px;margin:0 auto;padding:18px 22px 60px}
figure{margin:0 0 22px} figure img{max-width:100%;border:1px solid #ddd;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.08)}
figcaption{color:#777;font-size:12px;margin-top:6px}
.text{background:#fff;border:1px solid #e3e3e0;border-radius:8px;padding:18px 24px;white-space:normal}
h2{font-size:15px;color:#555;margin:26px 0 8px}
</style></head><body>
<header><b>Kept copy</b><span>${esc(r.title)}</span><a href="${esc(r.url)}">${esc(r.url)}</a><span>kept ${esc(when)}</span>${r.reason ? `<span class="r">Why: ${esc(r.reason)}</span>` : ""}${r.tags.length ? `<span>${esc(r.tags.join(", "))}</span>` : ""}</header>
<main>
${r.imageBytes ? `<figure><img src="${keptUrl(r.id, "page.png")}" alt="What the page looked like"><figcaption>What was on screen when it was kept.</figcaption></figure>` : ""}
<h2>Text of the page</h2>
<div class="text">${paras || "<p><i>No text.</i></p>"}</div>
</main></body></html>`;
}

export class KeepStore {
  constructor(private dir: string) {}

  private folder(id: string) {
    if (!ID_RE.test(id)) throw new Error("not a kept page");
    return join(this.dir, id);
  }

  async add(p: { url: string; title: string; text: string; png: Buffer | null; reason?: string; tags?: string[]; now?: number }): Promise<KeptRecord> {
    const id = randomBytes(8).toString("hex");
    const f = this.folder(id);
    await fs.mkdir(f, { recursive: true, mode: 0o700 });
    const text = p.text.slice(0, MAX_TEXT);
    const r: KeptRecord = {
      id,
      url: p.url,
      title: p.title.slice(0, 300) || p.url,
      keptAt: p.now ?? Date.now(),
      ...(p.reason ? { reason: p.reason.slice(0, 300) } : {}),
      tags: (p.tags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 20),
      textChars: text.length,
      imageBytes: p.png?.length ?? 0,
    };
    await fs.writeFile(join(f, "text.txt"), text, { mode: 0o600 });
    if (p.png) await fs.writeFile(join(f, "page.png"), p.png, { mode: 0o600 });
    await fs.writeFile(join(f, "record.json"), JSON.stringify(r), { mode: 0o600 });
    return r;
  }

  async get(id: string): Promise<{ record: KeptRecord; text: string } | null> {
    try {
      const f = this.folder(id);
      const record = JSON.parse(await fs.readFile(join(f, "record.json"), "utf8")) as KeptRecord;
      return { record, text: await fs.readFile(join(f, "text.txt"), "utf8").catch(() => "") };
    } catch {
      return null;
    }
  }

  async image(id: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(join(this.folder(id), "page.png"));
    } catch {
      return null;
    }
  }

  /** Newest first. With a query, only pages whose title, address, reason, tags or text contain every word of it. */
  async list(query = "", limit = 200): Promise<Array<KeptRecord & { snippet?: string }>> {
    let ids: string[];
    try {
      ids = (await fs.readdir(this.dir)).filter((n) => ID_RE.test(n));
    } catch {
      return [];
    }
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const out: Array<KeptRecord & { snippet?: string }> = [];
    for (const id of ids) {
      const g = await this.get(id);
      if (!g) continue;
      const r = g.record;
      if (words.length) {
        const hay = `${r.title}\n${r.url}\n${r.reason ?? ""}\n${r.tags.join(" ")}\n${g.text}`.toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
        const at = g.text.toLowerCase().indexOf(words[0] as string);
        out.push({ ...r, ...(at >= 0 ? { snippet: g.text.slice(Math.max(0, at - 60), at + 120).replace(/\s+/g, " ").trim() } : {}) });
      } else out.push(r);
    }
    out.sort((a, b) => b.keptAt - a.keptAt);
    return out.slice(0, limit);
  }

  /** Change a kept copy's record (for example once it has been saved to the person's account). */
  async update(id: string, patch: Partial<Omit<KeptRecord, "id">>): Promise<KeptRecord | null> {
    const g = await this.get(id);
    if (!g) return null;
    const r = { ...g.record, ...patch, id: g.record.id };
    await fs.writeFile(join(this.folder(id), "record.json"), JSON.stringify(r), { mode: 0o600 });
    return r;
  }

  async remove(id: string): Promise<boolean> {
    try {
      await fs.rm(this.folder(id), { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}
