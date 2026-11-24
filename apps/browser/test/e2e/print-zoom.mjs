// Print, Save as PDF and zoom: what the File and View menus, ⌘P / ⌘⇧S / ⌘+ ⌘− ⌘0 and the page's right-click menu run.
// The print dialog is recorded, not shown (a scripted run must not put a dialog on anyone's screen); the PDF goes to the
// suite's download folder without a dialog. Menu commands are sent as the menu sends them; keys are sent to the page.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export default async function (ctx) {
  const { call: T, check, base, sleep, tmp } = ctx;
  const c = await ctx.chrome();
  async function waitFor(fn, what, tries = 60) {
    for (let i = 0; i < tries; i++) { const v = await fn().catch(() => null); if (v) return v; await sleep(100); }
    throw new Error("timed out waiting for " + what);
  }
  const active = async () => (await T("tabs.list")).find((t) => t.active);
  const menu = (cmd) => c.ev(`(onTabCmd(${JSON.stringify(cmd)}), true)`);
  const badge = () => c.ev(`(() => { const b = document.getElementById("zoomBtn"); return b.hidden ? "" : b.textContent; })()`);
  const dpr = async () => (await T("page.eval", { js: "window.devicePixelRatio" })).value;
  const mod = process.platform === "darwin" ? "meta" : "control";
  const key = (keyCode, mods = [mod]) => c.ev(`(() => { active.wv.focus(); active.wv.sendInputEvent({ type: "keyDown", keyCode: ${JSON.stringify(keyCode)}, modifiers: ${JSON.stringify(mods)} }); active.wv.sendInputEvent({ type: "keyUp", keyCode: ${JSON.stringify(keyCode)}, modifiers: ${JSON.stringify(mods)} }); return true; })()`);

  const page = await T("tabs.new", { url: base + "/free" });
  await T("tabs.activate", { tab: page.id });
  await waitFor(async () => (await active()).id === page.id && !(await active()).loading, "the page");
  await T("page.eval", { js: `document.title = "A page: to print / save", true` });
  const base1 = await dpr();

  // ---- zoom ----
  check((await badge()) === "", "at 100% no zoom size shows next to the address");
  await menu("zoom-in");
  await waitFor(async () => (await badge()) === "110%", "110%");
  check(Math.abs((await dpr()) / base1 - 1.1) < 0.02, "View ▸ Zoom In makes the page 110%, and the size shows next to the address", `${await badge()}, ratio ${(await dpr()) / base1}`);
  await menu("zoom-in");
  check(await waitFor(async () => (await badge()) === "125%", "125%").then(() => true, () => false), "again: 125%, Chrome's next step");
  await menu("zoom-out");
  check(await waitFor(async () => (await badge()) === "110%", "110%").then(() => true, () => false), "View ▸ Zoom Out steps back to 110%");

  // the site remembers it: another page of the same site opens at that size
  const other = await T("tabs.new", { url: base + "/headers?zoom=1" });
  await T("tabs.activate", { tab: other.id });
  await waitFor(async () => !(await active()).loading, "the second page");
  check(await waitFor(async () => (await badge()) === "110%", "the site's size").then(() => true, () => false), "another page of the same site opens at the site's size", await badge());
  check(Math.abs((await dpr()) / base1 - 1.1) < 0.02, "and is drawn at that size");
  const saved = join(tmp, "profile-print-zoom", "zoom.json");
  const file = existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")) : null;
  check(file && file.sites && file.sites["127.0.0.1"] === 1.1, "the size is saved for the next start", JSON.stringify(file));

  // keys sent to the page reach the menu when the page doesn't take them
  await key("=");
  const viaKey = await waitFor(async () => ((await badge()) === "125%" ? true : null), "⌘= from the page").catch(() => false);
  check(viaKey === true, "⌘= while the page has the keyboard zooms in", await badge());
  await key("0");
  const reset = await waitFor(async () => ((await badge()) === "" ? true : null), "⌘0 from the page").catch(() => false);
  check(reset === true && Math.abs((await dpr()) / base1 - 1) < 0.02, "⌘0 goes back to actual size, and the size next to the address goes away");
  await T("tabs.activate", { tab: page.id });
  check(await waitFor(async () => ((await badge()) === "" ? true : null), "the first tab back at 100%").then(() => true, () => false), "and the site's other open tab follows");
  const after = existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")) : null;
  check(after && !("127.0.0.1" in after.sites), "a site back at 100% is forgotten", JSON.stringify(after));
  await T("tabs.close", { tab: other.id }).catch(() => {});

  // ---- print ----
  let since = (await T("x402.events", { since: 0 })).next;
  const nextEvent = async (kind) => waitFor(async () => { const r = await T("x402.events", { since }); const e = r.events.find((x) => x.kind === kind); if (e) since = r.next; return e; }, kind);
  await menu("print");
  const pr = await nextEvent("print-dialog").catch(() => null);
  check(!!pr && /\/free/.test(pr.url), "File ▸ Print… opens the print dialog for the page (recorded here, not shown)", JSON.stringify(pr));
  await sleep(400); // a menu click and a key press this close together count as one press
  await key("p");
  const prKey = await nextEvent("print-dialog").catch(() => null);
  check(!!prKey, "⌘P while the page has the keyboard does the same");
  // a page with its own print (a document editor) keeps ⌘P
  await T("page.eval", { js: "window.__ownPrint = 0, addEventListener('keydown', (e) => { if (e.code === 'KeyP' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); __ownPrint++; } }), true" });
  await sleep(400);
  await key("p");
  await sleep(800);
  const stolen = (await T("x402.events", { since })).events.some((e) => e.kind === "print-dialog");
  check(!stolen && (await T("page.eval", { js: "window.__ownPrint" })).value === 1, "a page with its own print (a document editor) gets ⌘P instead, as in Chrome");

  // ---- save as PDF ----
  const dir = join(tmp, "downloads-print-zoom");
  const pdfs = () => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".pdf")) : []);
  await menu("save-pdf");
  const got = await waitFor(async () => pdfs()[0], "the PDF", 100).catch(() => null);
  check(got === "A page_ to print - save.pdf", "File ▸ Save as PDF… saves the page, named after its title (no slashes or colons)", String(got));
  const bytes = got ? readFileSync(join(dir, got)) : Buffer.alloc(0);
  check(bytes.subarray(0, 5).toString() === "%PDF-" && bytes.length > 1000, "and it is a real PDF", `${bytes.length} bytes`);
  await menu("save-pdf");
  check(await waitFor(async () => (pdfs().length === 2 ? true : null), "a second PDF").then(() => true, () => false), "saving again never overwrites the first", pdfs().join(" | "));

  // ---- the right-click menu runs the same ----
  await c.ev(`(() => { active.wv.sendInputEvent({ type: "mouseMove", x: 300, y: 300 }); active.wv.sendInputEvent({ type: "mouseDown", x: 300, y: 300, button: "right", clickCount: 1 }); active.wv.sendInputEvent({ type: "mouseUp", x: 300, y: 300, button: "right", clickCount: 1 }); return true; })()`);
  const cm = await nextEvent("context-menu").catch(() => null);
  check(!!cm && cm.items.includes("print") && cm.items.includes("save-pdf"), "right-click on the page offers Print… and Save as PDF…", cm && cm.items.join(","));
  await T("menu.pick", { id: "save-pdf" });
  check(await waitFor(async () => (pdfs().length === 3 ? true : null), "a third PDF").then(() => true, () => false), "and Save as PDF… there saves it too");

  await T("tabs.close", { tab: page.id }).catch(() => {});
}
