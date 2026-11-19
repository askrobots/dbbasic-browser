import { describe, expect, it } from "vitest";
import {
  LIMITS,
  blocksToText,
  buildReaderHtml,
  escapeHtml,
  footFor,
  readerDataUrl,
  safeHttpUrl,
  tldrUpdateScript,
  validateExtraction,
  type Extracted,
} from "../src/reader.js";

const base = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({ mode: "article", url: "https://example.com/post", title: "A Post", byline: "Ann", siteName: "Example", lang: "en", blocks, ...extra });
const P = (x: string) => ({ t: "p", runs: [{ x }] });

describe("safeHttpUrl", () => {
  it("allows plain http(s) only", () => {
    expect(safeHttpUrl("https://a.test/x?y=1")).toBe("https://a.test/x?y=1");
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd", "blob:https://a.test/x", "//a.test", "https://u:p@a.test/", "", null, 5]) {
      expect(safeHttpUrl(bad)).toBeNull();
    }
  });
});

describe("validateExtraction — everything from the page is untrusted", () => {
  it("accepts well-formed data and normalizes it", () => {
    const ex = validateExtraction(base([{ t: "h", level: 1, runs: [{ x: "Heading" }] }, P("Hello"), { t: "ul", items: [[{ x: "a" }], [{ x: "b" }]] }]))!;
    expect(ex.blocks).toHaveLength(3);
    expect(ex.blocks[0]).toMatchObject({ t: "h", level: 2 }); // the title is the only h1
    expect(ex.title).toBe("A Post");
  });
  it("drops unknown block types, raw HTML fields, and non-http links/images", () => {
    const ex = validateExtraction(
      base([
        { t: "script", text: "alert(1)" },
        { t: "html", html: "<img src=x onerror=alert(1)>" },
        { t: "p", runs: [{ x: "link", href: "javascript:alert(1)" }, { x: "ok", href: "https://ok.test/" }], html: "<b>nope</b>" },
        { t: "img", src: "javascript:alert(1)", alt: "x" },
        { t: "img", src: "data:image/svg+xml;base64,PHN2Zz4=", alt: "x" },
        { t: "img", src: "https://img.test/a.png", alt: "fine" },
      ]),
    )!;
    expect(ex.blocks.map((b) => b.t)).toEqual(["p", "img"]);
    const p = ex.blocks[0] as { runs: Array<{ x: string; href?: string }> };
    expect(p.runs[0]!.href).toBeUndefined();
    expect(p.runs[1]!.href).toBe("https://ok.test/");
    expect(JSON.stringify(ex)).not.toContain("onerror");
    expect(JSON.stringify(ex)).not.toContain("<b>");
  });
  it("rejects non-extractions and pages with no usable content", () => {
    expect(validateExtraction(null)).toBeNull();
    expect(validateExtraction("x")).toBeNull();
    expect(validateExtraction(base([], {}))).toBeNull();
    expect(validateExtraction(base([P("x")], { url: "javascript:alert(1)" }))).toBeNull();
    expect(validateExtraction({ ...base([P("x")]), blocks: "nope" })).toBeNull();
  });
  it("enforces size limits", () => {
    const many = Array.from({ length: LIMITS.blocks + 500 }, (_, i) => P(`p${i}`));
    expect(validateExtraction(base(many))!.blocks.length).toBeLessThanOrEqual(LIMITS.blocks);
    const huge = validateExtraction(base([P("x".repeat(LIMITS.runChars * 3))]))!;
    expect((huge.blocks[0] as { runs: Array<{ x: string }> }).runs[0]!.x.length).toBe(LIMITS.runChars);
    expect(validateExtraction(base([P("x")], { title: "t".repeat(5000) }))!.title.length).toBeLessThanOrEqual(LIMITS.title);
  });
  it("falls back to the host when the title is empty, and to 'en' for a bogus lang", () => {
    const ex = validateExtraction(base([P("x")], { title: "  ", lang: "<script>" }))!;
    expect(ex.title).toBe("example.com");
    expect(ex.lang).toBe("en");
  });
});

describe("buildReaderHtml — the page is written from scratch and is script-free", () => {
  const hostile = validateExtraction(
    base(
      [
        P(`</p><script>alert("xss")</script><img src=x onerror=alert(1)>`),
        { t: "h", level: 2, runs: [{ x: `"><svg onload=alert(1)>` }] },
        { t: "pre", text: "<script>alert(1)</script>" },
        { t: "img", src: `https://img.test/a.png" onerror="alert(1)`, alt: `"><script>x</script>` },
        { t: "p", runs: [{ x: "x", href: `https://ok.test/?a="b"&c=<d>` }] },
      ],
      { title: `</title><script>alert("t")</script>`, byline: `<b>by</b>`, siteName: "<i>s</i>" },
    ),
  )!;
  const html = buildReaderHtml(hostile, { ai: { state: "pending", provider: "Anthropic", model: "claude-x" } });

  it("contains no executable markup from the page", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<svg/i);
    // No real TAG may carry an event-handler attribute (the same words appear as escaped, inert text).
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(html).not.toContain('onerror="alert');
  });
  it("escapes text, attributes and the title", () => {
    expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(html).toContain("<title>&lt;/title&gt;&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;by&lt;/b&gt;");
  });
  it("sends a strict CSP and no referrer", () => {
    expect(html).toMatch(/Content-Security-Policy" content="default-src 'none'/);
    expect(html).not.toMatch(/script-src/);
    expect(html).toContain('name="referrer" content="no-referrer"');
    expect(html).toContain("form-action 'none'");
  });
  it("shows the pending skeleton with the provider, and the other states as plain notes", () => {
    expect(html).toContain('class="tldr pending"');
    expect(html).toContain("Summarizing with Anthropic · claude-x");
    const none = buildReaderHtml(hostile, { ai: { state: "none" } });
    expect(none).toContain('class="tldr none"');
    expect(none).toContain("No AI summary");
    const declined = buildReaderHtml(hostile, { ai: { state: "declined" } });
    expect(declined).toContain("nothing from this page was sent");
    expect(buildReaderHtml(hostile, { ai: { state: "error", message: "rate limit" } })).toContain("rate limit");
  });
  it("notes when the page isn't an article", () => {
    const t = validateExtraction(base([P("text")], { mode: "text" }))!;
    expect(buildReaderHtml(t, { ai: { state: "none" } })).toContain("isn't an article");
  });
  it("reading time and original link are present", () => {
    const ex = validateExtraction(base([P("word ".repeat(660))]))!;
    const h = buildReaderHtml(ex, { ai: { state: "none" } });
    expect(h).toContain("3 min read");
    expect(h).toContain('href="https://example.com/post"');
  });
});

describe("buildReaderHtml — the finished state (what Back/Forward must show)", () => {
  const ex = validateExtraction(base([P("Body text")]))!;
  const html = buildReaderHtml(ex, { ai: { state: "done", tldr: "The <b>summary</b>.", points: ["one & two", "<img src=x onerror=alert(1)>"], foot: "Summarized by m" } });
  it("renders the TL;DR, bullet points and footer in the page itself", () => {
    expect(html).toContain('class="tldr done"');
    expect(html).toContain('<div id="tldr-body">The &lt;b&gt;summary&lt;/b&gt;.</div>');
    expect(html).toContain("<li>one &amp; two</li>");
    expect(html).toContain('<div id="tldr-foot" class="foot">Summarized by m</div>');
  });
  it("shows no skeleton and escapes everything the model wrote", () => {
    expect(html).not.toContain('class="sk"');
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/<script/i);
  });
  it("matches what the live update script writes (same structure, so a reload looks identical)", () => {
    expect(html).toMatch(/id="tldr-points"><li>/);
    expect(html).toContain('id="tldr"');
  });
});

describe("readerDataUrl / tldrUpdateScript", () => {
  it("round-trips the HTML through a base64 data URL", () => {
    const html = "<p>héllo ✓</p>";
    const url = readerDataUrl(html);
    expect(url.startsWith("data:text/html;charset=utf-8;base64,")).toBe(true);
    expect(Buffer.from(url.split(",")[1]!, "base64").toString("utf8")).toBe(html);
  });
  it("the update script embeds values as string literals and writes only textContent", () => {
    const evil = `"); alert(1); ("</script><img onerror=x>`;
    const js = tldrUpdateScript({ state: "done", tldr: evil, points: [evil], foot: evil });
    expect(js).not.toContain("innerHTML");
    expect(js).toContain("textContent");
    // Executing the generated code against a tiny fake DOM proves the payload stays inert data.
    const els: Record<string, { className: string; textContent: string; children: Array<{ textContent: string }>; appendChild(c: { textContent: string }): void }> = {};
    const mk = () => ({ className: "", textContent: "", children: [] as Array<{ textContent: string }>, appendChild(c: { textContent: string }) { this.children.push(c); } });
    for (const id of ["tldr", "tldr-body", "tldr-points", "tldr-foot"]) els[id] = mk();
    let alerted = false;
    const doc = { getElementById: (id: string) => els[id], createElement: () => ({ textContent: "" }) };
    new Function("document", "alert", `return ${js}`)(doc, () => (alerted = true));
    expect(alerted).toBe(false);
    expect(els["tldr-body"]!.textContent).toBe(evil);
    expect(els["tldr-points"]!.children[0]!.textContent).toBe(evil);
    expect(els["tldr"]!.className).toBe("tldr done");
  });
});

describe("blocksToText / footFor / escapeHtml", () => {
  it("renders plain text for the summarizer", () => {
    const ex = validateExtraction(base([{ t: "h", level: 2, runs: [{ x: "Head" }] }, P("Para"), { t: "ol", items: [[{ x: "one" }], [{ x: "two" }]] }, { t: "img", src: "https://i.test/a.png", alt: "a cat" }])) as Extracted;
    expect(blocksToText(ex.blocks)).toBe("## Head\n\nPara\n\n1. one\n2. two\n\n[image: a cat]");
  });
  it("footFor shows provider, model, time, tokens and cost only when known", () => {
    const f = footFor({ provider: "anthropic", model: "claude-haiku-5-5", ms: 2631, usage: { inputTokens: 12517, outputTokens: 404 }, costUsd: 0.0015, truncated: true });
    expect(f).toContain("claude-haiku-5-5");
    expect(f).toContain("2.6 s");
    expect(f).toContain("12,517 in / 404 out");
    expect(f).toContain("≈$0.0015");
    expect(f).toContain("only the first part");
    expect(footFor({ provider: "openai", model: "m", ms: 1000, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: null, truncated: false })).not.toContain("$");
  });
  it("escapeHtml covers the five characters", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });
});
