// Runs inside every page (the <webview> guest). It does exactly two things:
//   1. notices login forms / login submits and tells the MAIN process (not the page,
//      not the chrome UI) so the password manager can offer to fill or save;
//   2. fills fields when main says so — after re-checking the origin itself.
// It exposes nothing to the page's own JavaScript (no contextBridge).
const { ipcRenderer } = require("electron");

const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
const pwInputs = (scope = document) => [...scope.querySelectorAll('input[type="password"]')].filter(visible);

// The username field is the closest preceding visible text-ish input in the same form.
function usernameFor(pw) {
  const scope = pw.form || document;
  const cands = [...scope.querySelectorAll("input")].filter(
    (i) => i !== pw && visible(i) && /^(text|email|tel|)$/i.test(i.getAttribute("type") || "") &&
      (i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING),
  );
  const hinted = cands.filter((i) => /user|email|login/i.test(`${i.autocomplete} ${i.name} ${i.id}`));
  return (hinted.length ? hinted : cands).pop() || null;
}

function setValue(el, v) {
  // Use the native setter + real events so React/Vue-controlled inputs notice.
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
  set.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// ---- 0. which link is under the pointer / keyboard focus (shown in the browser's status bar) ----
// Sends only the link's absolute address to the browser UI; nothing else about the page.
let lastLink = null;
function reportLink(a) {
  const href = a && a.href ? String(a.href) : null;
  if (href === lastLink) return;
  lastLink = href;
  ipcRenderer.sendToHost("link-hover", href);
}
const linkOf = (t) => (t && t.closest ? t.closest("a[href], area[href]") : null);
document.addEventListener("mouseover", (e) => reportLink(linkOf(e.target)), true);
document.addEventListener("mouseout", (e) => { if (!e.relatedTarget || !linkOf(e.relatedTarget)) reportLink(null); }, true);
document.addEventListener("focusin", (e) => reportLink(linkOf(e.target)), true);
document.addEventListener("focusout", () => reportLink(null), true);
window.addEventListener("pagehide", () => reportLink(null));

// ---- 1a. "there's a login form here" -------------------------------------
let formTimer = null, lastFormKey = "";
function announceForm() {
  clearTimeout(formTimer);
  formTimer = setTimeout(() => {
    const n = pwInputs().length;
    if (!n) return;
    const key = location.href + "#" + n;
    if (key === lastFormKey) return;
    lastFormKey = key;
    ipcRenderer.send("vault:form");
  }, 300);
}
document.addEventListener("DOMContentLoaded", () => {
  announceForm();
  new MutationObserver(announceForm).observe(document.documentElement, { childList: true, subtree: true });
});

// ---- 1b. "the user just submitted credentials" ---------------------------
let lastSent = "";
function reportSubmit(scope) {
  const pw = pwInputs(scope).find((p) => p.value);
  if (!pw) return;
  const u = usernameFor(pw);
  const payload = { username: u ? u.value : "", password: pw.value };
  const key = payload.username + "\0" + payload.password;
  if (key === lastSent) return; // submit + click + Enter all fire for one login
  lastSent = key;
  setTimeout(() => (lastSent = ""), 1500);
  ipcRenderer.send("vault:submit", payload);
}
// isTrusted: only real user input counts, never a page's synthetic events.
document.addEventListener("submit", (e) => { if (e.isTrusted) reportSubmit(e.target); }, true);
document.addEventListener("keydown", (e) => {
  if (e.isTrusted && e.key === "Enter" && e.target && e.target.type === "password") reportSubmit(e.target.form || document);
}, true);
document.addEventListener("click", (e) => {
  if (!e.isTrusted || !e.target.closest) return;
  const b = e.target.closest('button, input[type="submit"], [role="button"]');
  if (b) reportSubmit(b.form || b.closest("form") || document);
}, true);

// ---- 2. fill, on command from main ---------------------------------------
ipcRenderer.on("vault:fill", (_e, { origin, username, password, submit }) => {
  if (location.origin !== origin) return; // defence in depth: main already checked
  const pw = pwInputs()[0];
  if (!pw) return;
  const u = usernameFor(pw);
  if (u && username) setValue(u, username);
  setValue(pw, password);
  if (submit) {
    const form = pw.form;
    if (form && form.requestSubmit) form.requestSubmit();
    else {
      const btn = (form || document).querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      if (btn) btn.click();
    }
  }
});
