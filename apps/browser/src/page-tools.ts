/**
 * In-page helpers for the form and find methods. They run inside the page (as source text sent to the tab),
 * so they are plain strings, and the only thing this module does is build them. Elements are named by short
 * refs ("e1", "e2"…) kept in a non-enumerable registry on the page's window; a ref whose element has left the
 * document no longer resolves, so a stale ref is an error and never a wrong click.
 *
 * Values that must not leave the page (passwords, card details, one-time codes, hidden fields, files) are never
 * reported: the field is listed with `sensitive: true`, a reason, and whether it is filled, and nothing else.
 */

/** Shared helpers, as source text. */
const LIB = `
  const registry = () => {
    let r = window.__dbbRefs;
    if (!r) { r = { map: new Map(), back: new WeakMap(), n: 0 }; Object.defineProperty(window, "__dbbRefs", { value: r, enumerable: false }); }
    return r;
  };
  const refOf = (el) => {
    const r = registry();
    let k = r.back.get(el);
    if (!k) { k = "e" + (++r.n); r.back.set(el, k); r.map.set(k, new WeakRef(el)); }
    return k;
  };
  const byRef = (k) => { const w = registry().map.get(String(k)); const el = w && w.deref(); return el && el.isConnected ? el : null; };
  const clean = (s, n) => String(s == null ? "" : s).replace(/\\s+/g, " ").trim().slice(0, n || 200);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };
  const labelOf = (el) => {
    const out = [];
    if (el.labels) for (const l of el.labels) out.push(l.innerText || l.textContent);
    const al = el.getAttribute("aria-label"); if (al) out.push(al);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) for (const id of lb.split(/\\s+/)) { const n = document.getElementById(id); if (n) out.push(n.innerText || n.textContent); }
    if (!out.length && el.getAttribute("title")) out.push(el.getAttribute("title"));
    return clean(out.join(" "));
  };
`;

/** The element a call names: by ref when given, else by CSS selector. Evaluates to the element or null. */
export function elementExpr(p: { ref?: unknown; selector?: unknown }): string {
  if (p.ref != null) return `(() => { ${LIB} return byRef(${JSON.stringify(String(p.ref))}); })()`;
  return `document.querySelector(${JSON.stringify(String(p.selector))})`;
}

/** Scroll an element into view and return the centre of it, in page coordinates, or null. */
export function pointOf(p: { ref?: unknown; selector?: unknown }): string {
  return `(() => { const e = ${elementExpr(p)}; if (!e) return null; e.scrollIntoView({block:"center", inline:"center"}); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`;
}

/** Why a field's value is not reported, or null when it may be. */
const SENSITIVE = `
  const sensitiveReason = (el) => {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password") return "password";
    if (type === "hidden") return "hidden";
    if (type === "file") return "file";
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (/(^|\\s)(cc-[a-z-]+|one-time-code|current-password|new-password)(\\s|$)/.test(ac)) return ac.includes("password") ? "password" : ac.includes("one-time") ? "one-time code" : "card";
    const hint = [el.name, el.id].join(" ").toLowerCase();
    if (/(passw|passcode|cvv|cvc|card.?num|cardnumber|ccnum|iban|routing|ssn|social.?sec|\\botp\\b|2fa|pin\\b)/.test(hint)) return "looks sensitive";
    return null;
  };
`;

export const FORMS_JS = (opts: { includeHidden: boolean; limit: number }): string => `(() => {
  ${LIB}
  ${SENSITIVE}
  const limit = ${Math.max(1, Math.min(500, Math.floor(opts.limit)))};
  const includeHidden = ${opts.includeHidden ? "true" : "false"};
  const forms = [...document.forms];
  const formIndex = (el) => { const f = el.form; if (!f) return null; const i = forms.indexOf(f); return i < 0 ? null : i; };
  const fields = [], buttons = [];
  let skippedHidden = 0, truncated = false;
  const all = document.querySelectorAll('input, select, textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"], button, [role="button"]');
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || (tag === "input" ? "text" : "")).toLowerCase();
    const isButton = tag === "button" || el.getAttribute("role") === "button" || (tag === "input" && ["submit", "button", "reset", "image"].includes(type));
    const vis = visible(el);
    if (!vis && !includeHidden && type !== "hidden") { skippedHidden++; continue; }
    if (type === "hidden" && !includeHidden) { skippedHidden++; continue; }
    if (fields.length + buttons.length >= limit) { truncated = true; break; }
    if (isButton) {
      buttons.push({ ref: refOf(el), text: clean(el.innerText || el.value || el.getAttribute("aria-label") || el.title, 120), type: type || null, form: formIndex(el), visible: vis, disabled: !!el.disabled });
      continue;
    }
    const f = {
      ref: refOf(el),
      kind: tag === "input" || tag === "select" || tag === "textarea" ? tag : "editable",
      type: type || null,
      name: el.getAttribute("name") || null,
      id: el.id || null,
      label: labelOf(el) || null,
      group: (() => { const fs = el.closest("fieldset"); return fs ? clean((fs.querySelector("legend") || {}).textContent, 120) || null : null; })(),
      placeholder: el.getAttribute("placeholder") || null,
      autocomplete: el.getAttribute("autocomplete") || null,
      required: !!el.required || el.getAttribute("aria-required") === "true",
      disabled: !!el.disabled,
      readOnly: !!el.readOnly,
      visible: vis,
      form: formIndex(el),
    };
    const why = sensitiveReason(el);
    if (why) {
      f.sensitive = true; f.reason = why;
      f.filled = tag === "select" ? !!el.value : !!(el.value || el.textContent || "").length;
    } else if (tag === "select") {
      f.options = [...el.options].slice(0, 100).map((o) => ({ value: o.value, label: clean(o.label || o.textContent, 80), selected: o.selected }));
      f.value = el.multiple ? [...el.selectedOptions].map((o) => o.value) : el.value;
    } else if (type === "checkbox" || type === "radio") {
      f.checked = !!el.checked; f.value = el.value;
    } else if (tag === "input" || tag === "textarea") {
      f.value = String(el.value || "").slice(0, 500);
      if ((el.value || "").length > 500) f.valueTruncated = true;
    } else {
      f.value = clean(el.textContent, 500);
    }
    fields.push(f);
  }
  const frames = [...document.querySelectorAll("iframe, frame")];
  let sameOrigin = 0;
  for (const fr of frames) { try { if (fr.contentDocument) sameOrigin++; } catch {} }
  return {
    url: location.href,
    title: document.title,
    forms: forms.map((f, i) => { let a = null; try { const u = new URL(f.action, location.href); a = u.origin + u.pathname; } catch {} return { index: i, id: f.id || null, name: f.getAttribute("name") || null, method: (f.method || "get").toLowerCase(), action: a }; }),
    fields, buttons, skippedHidden, truncated,
    // Fields inside frames are not listed: only the top document is read. This says how many frames there are.
    frames: { count: frames.length, sameOrigin },
  };
})()`;

export const FIND_JS = (q: { text?: string; label?: string; role?: string; includeHidden: boolean; limit: number }): string => `(() => {
  ${LIB}
  const needle = ${JSON.stringify((q.text ?? q.label ?? "").toLowerCase())};
  const onlyLabel = ${q.label != null && q.text == null ? "true" : "false"};
  const role = ${JSON.stringify((q.role ?? "").toLowerCase())};
  const includeHidden = ${q.includeHidden ? "true" : "false"};
  const limit = ${Math.max(1, Math.min(50, Math.floor(q.limit)))};
  const sel = 'a[href], button, input, select, textarea, summary, label, [role], [onclick], [tabindex], [contenteditable=""], [contenteditable="true"]';
  const roleOf = (el) => {
    const r = el.getAttribute("role"); if (r) return r;
    const t = el.tagName.toLowerCase(), ty = (el.getAttribute("type") || "").toLowerCase();
    if (t === "a") return "link";
    if (t === "button" || (t === "input" && ["submit", "button", "reset", "image"].includes(ty))) return "button";
    if (t === "select") return "combobox";
    if (t === "textarea" || (t === "input" && !["checkbox", "radio", "hidden"].includes(ty))) return "textbox";
    if (t === "input") return ty;
    return t;
  };
  const out = [];
  let total = 0;
  for (const el of document.querySelectorAll(sel)) {
    const vis = visible(el);
    if (!vis && !includeHidden) continue;
    const rl = roleOf(el);
    if (role && rl !== role) continue;
    const text = clean(el.innerText || el.value || "", 120);
    const label = labelOf(el);
    const hay = onlyLabel ? [label] : [text, label, el.getAttribute("placeholder"), el.getAttribute("title"), el.getAttribute("name"), el.id];
    let score = 0;
    if (!needle) score = 1;
    else for (const h of hay) { const s = clean(h).toLowerCase(); if (!s) continue; if (s === needle) { score = 3; break; } if (s.startsWith(needle)) score = Math.max(score, 2); else if (s.includes(needle)) score = Math.max(score, 1); }
    if (!score) continue;
    total++;
    const r = el.getBoundingClientRect();
    out.push({ score, ref: refOf(el), role: rl, tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || null, text, label: label || null, href: el.tagName === "A" ? el.href : null, visible: vis, inViewport: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth, rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } });
  }
  out.sort((a, b) => b.score - a.score);
  return { total, matches: out.slice(0, limit).map(({ score, ...m }) => m) };
})()`;

/** What a ref points at, so a person can be told what is about to be clicked or typed into (and so secrets are refused). */
export const REF_INFO_JS = (ref: string): string => `(() => {
  ${LIB}
  ${SENSITIVE}
  const el = byRef(${JSON.stringify(ref)});
  if (!el) return { found: false };
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  const inForm = !!el.form;
  const submits = (tag === "button" && (type === "" || type === "submit") && inForm) || (tag === "input" && (type === "submit" || type === "image"));
  return {
    found: true, tag, type: type || null,
    role: el.getAttribute("role") || null,
    text: clean(el.innerText || el.value || "", 120),
    label: labelOf(el) || null,
    name: el.getAttribute("name") || null,
    sensitive: sensitiveReason(el),
    submits,
    link: tag === "a" ? el.href : null,
  };
})()`;

/** Choose an option of a <select> by its value or its visible words, with the events a page expects. */
export const CHOOSE_JS = (ref: string, want: string): string => `(() => {
  ${LIB}
  const el = byRef(${JSON.stringify(ref)});
  if (!el) return { ok: false, why: "not-found" };
  if (el.tagName !== "SELECT") return { ok: false, why: "not-a-select" };
  const w = ${JSON.stringify(want)}.trim().toLowerCase();
  const opts = [...el.options];
  const hit = opts.find((o) => o.value.toLowerCase() === w) || opts.find((o) => clean(o.label || o.textContent).toLowerCase() === w) || opts.find((o) => clean(o.label || o.textContent).toLowerCase().includes(w));
  if (!hit || hit.disabled) return { ok: false, why: "no-such-option", options: opts.slice(0, 40).map((o) => clean(o.label || o.textContent, 60)) };
  el.focus();
  el.value = hit.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, chosen: clean(hit.label || hit.textContent, 80), value: hit.value };
})()`;
