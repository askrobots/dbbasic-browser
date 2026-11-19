// Runs INSIDE the page being read (injected by the main process together with Mozilla's Readability).
// It returns PLAIN DATA only — never HTML. The page is hostile and may tamper with this code, so the
// main process re-validates everything (src/reader.ts validateExtraction) and builds the reader page itself.
//
// Shape: { mode: "article"|"text", url, title, byline, siteName, lang, blocks: [...] }
//        or { error: "login" | "extract-failed" }
(function (Readability) {
  "use strict";
  var MAX_BLOCKS = 800, MAX_CHARS = 250000;
  var total = 0;
  var doc = document;
  var SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|IFRAME|OBJECT|EMBED|SELECT|TEXTAREA|INPUT|CANVAS|VIDEO|AUDIO|LINK|META)$/;
  var INLINE = /^(A|SPAN|STRONG|B|EM|I|CODE|KBD|SAMP|SMALL|MARK|ABBR|CITE|Q|SUB|SUP|U|S|DEL|INS|TIME|BDI|BDO|WBR)$/;

  function visible(el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }
  // Never read a login page: it may contain (or be about to contain) credentials.
  var pw = doc.querySelectorAll('input[type="password"]');
  for (var i = 0; i < pw.length; i++) if (visible(pw[i])) return { error: "login" };

  function abs(u) { try { return new URL(u, doc.baseURI).href; } catch (e) { return ""; } }
  function http(u) { return /^https?:/i.test(u) ? u : ""; }

  function inline(node, out, fmt) {
    var kids = node.childNodes;
    for (var i = 0; i < kids.length; i++) {
      if (total > MAX_CHARS) return;
      var n = kids[i];
      if (n.nodeType === 3) {
        var x = n.nodeValue.replace(/\s+/g, " ");
        if (x.trim() || (x === " " && out.length)) { out.push(Object.assign({ x: x }, fmt)); total += x.length; }
      } else if (n.nodeType === 1) {
        var tag = n.tagName;
        if (SKIP.test(tag) || tag === "IMG") continue;
        if (tag === "BR") { out.push({ x: "\n" }); continue; }
        var f = Object.assign({}, fmt);
        if (tag === "STRONG" || tag === "B") f.b = 1;
        else if (tag === "EM" || tag === "I") f.i = 1;
        else if (tag === "CODE" || tag === "KBD" || tag === "SAMP") f.c = 1;
        else if (tag === "A") { var h = http(abs(n.getAttribute("href") || "")); if (h) f.href = h; }
        inline(n, out, f);
      }
    }
  }
  function trimRuns(runs) {
    while (runs.length && !runs[0].x.trim()) runs.shift();
    while (runs.length && !runs[runs.length - 1].x.trim()) runs.pop();
    if (runs.length) { runs[0].x = runs[0].x.replace(/^\s+/, ""); runs[runs.length - 1].x = runs[runs.length - 1].x.replace(/\s+$/, ""); }
    return runs;
  }
  function paragraphFrom(nodes, out, type) {
    var runs = [];
    for (var i = 0; i < nodes.length; i++) inline({ childNodes: [nodes[i]] }, runs, {});
    runs = trimRuns(runs);
    if (runs.length) out.push({ t: type || "p", runs: runs });
  }
  function image(img, out) {
    var src = http(abs(img.currentSrc || img.getAttribute("src") || img.getAttribute("data-src") || ""));
    var w = parseInt(img.getAttribute("width") || "0", 10), h = parseInt(img.getAttribute("height") || "0", 10);
    if (!src || (w && w < 60) || (h && h < 60)) return; // icons, spacers and tracking pixels
    out.push({ t: "img", src: src, alt: img.getAttribute("alt") || "" });
  }

  function blocks(root, out) {
    var kids = root.childNodes, run = [];
    function flush() { if (run.length) { paragraphFrom(run, out); run = []; } }
    for (var i = 0; i < kids.length; i++) {
      if (out.length >= MAX_BLOCKS || total > MAX_CHARS) break;
      var n = kids[i];
      if (n.nodeType === 3) { if (n.nodeValue.trim()) run.push(n); continue; }
      if (n.nodeType !== 1) continue;
      var tag = n.tagName;
      if (SKIP.test(tag)) continue;
      if (INLINE.test(tag)) { run.push(n); continue; }
      flush();
      if (/^H[1-6]$/.test(tag)) {
        var hr = []; inline(n, hr, {}); hr = trimRuns(hr);
        if (hr.length) out.push({ t: "h", level: Number(tag.charAt(1)), runs: hr });
      } else if (tag === "P") {
        paragraphFrom(n.childNodes, out);
        var imgs = n.querySelectorAll("img"); for (var k = 0; k < imgs.length; k++) image(imgs[k], out);
      } else if (tag === "UL" || tag === "OL") {
        var items = [], lis = n.children;
        for (var j = 0; j < lis.length; j++) if (lis[j].tagName === "LI") { var r = []; inline(lis[j], r, {}); r = trimRuns(r); if (r.length) items.push(r); }
        if (items.length) out.push({ t: tag === "OL" ? "ol" : "ul", items: items });
      } else if (tag === "BLOCKQUOTE") {
        paragraphFrom(n.childNodes, out, "quote");
      } else if (tag === "PRE") {
        var text = n.textContent || ""; if (text.trim()) { out.push({ t: "pre", text: text }); total += text.length; }
      } else if (tag === "IMG") {
        image(n, out);
      } else if (tag === "PICTURE") {
        var pi = n.querySelector("img"); if (pi) image(pi, out);
      } else if (tag === "HR") {
        out.push({ t: "hr" });
      } else if (tag === "TABLE") {
        var rows = n.querySelectorAll("tr");
        for (var q = 0; q < rows.length && out.length < MAX_BLOCKS; q++) {
          var cells = rows[q].querySelectorAll("th,td"), parts = [];
          for (var c = 0; c < cells.length; c++) { var t = (cells[c].textContent || "").replace(/\s+/g, " ").trim(); if (t) parts.push(t); }
          if (parts.length) { out.push({ t: "p", runs: [{ x: parts.join(" | ") }] }); total += parts.join(" | ").length; }
        }
      } else {
        blocks(n, out); // DIV, SECTION, ARTICLE, FIGURE, FIGCAPTION, MAIN, …
      }
    }
    flush();
  }

  try {
    var out = [], mode = "text", title = "", byline = "", siteName = "", lang = "";
    var art = null;
    if (Readability) {
      try { art = new Readability(doc.cloneNode(true), { charThreshold: 250 }).parse(); } catch (e) { art = null; }
    }
    if (art && art.textContent && art.textContent.trim().length > 400) {
      var parsed = new DOMParser().parseFromString(art.content, "text/html");
      blocks(parsed.body, out);
      mode = "article"; title = art.title || ""; byline = art.byline || ""; siteName = art.siteName || ""; lang = art.lang || "";
    }
    if (out.length === 0) {
      // Not an article (a home page, results, a dashboard…): the page's VISIBLE text — innerText skips what is hidden.
      var root = doc.querySelector("main, article, [role=main]") || doc.body;
      var parts = String(root.innerText || "").split(/\n\s*\n+/);
      for (var p = 0; p < parts.length && out.length < MAX_BLOCKS && total < MAX_CHARS; p++) {
        var s = parts[p].replace(/\s+/g, " ").trim();
        if (s) { out.push({ t: "p", runs: [{ x: s }] }); total += s.length; }
      }
      mode = "text";
    }
    return {
      mode: mode, url: location.href, title: title || doc.title || "", byline: byline, siteName: siteName || "",
      lang: lang || doc.documentElement.lang || "", blocks: out
    };
  } catch (e) {
    return { error: "extract-failed" };
  }
})
