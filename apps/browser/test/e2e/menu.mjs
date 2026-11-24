// The right-click menu, and ⌘-click / middle-click opening a link behind the page. Menus are recorded, not shown
// (DBB_RECORD_MENUS), so nothing appears on anyone's screen; the automation API reads the menu and picks an item, which
// runs exactly what a click on that item runs. Nothing here touches the clipboard or a real site.
export default async function (ctx) {
  const { call: T, check, base, sleep } = ctx;
  const c = await ctx.chrome();
  async function waitFor(fn, what, tries = 60) {
    for (let i = 0; i < tries; i++) { const v = await fn().catch(() => null); if (v) return v; await sleep(100); }
    throw new Error("timed out waiting for " + what);
  }
  const active = async () => (await T("tabs.list")).find((t) => t.active);
  const mod = process.platform === "darwin" ? "meta" : "control";

  const page = await T("tabs.new", { url: base + "/free" });
  await T("tabs.activate", { tab: page.id });
  await waitFor(async () => (await active()).id === page.id && !(await active()).loading, "the page");
  await T("page.eval", { js: `(() => {
    const at = (el, x, y) => { el.style.cssText = "position:fixed;left:" + x + "px;top:" + y + "px;margin:0;font:16px sans-serif"; document.body.appendChild(el); return el; };
    const a = at(document.createElement("a"), 20, 20); a.id = "l"; a.href = "/headers?from=menu"; a.textContent = "a link to open";
    const p = at(document.createElement("p"), 20, 80); p.id = "s"; p.textContent = "marmalade oranges and sugar";
    const i = at(document.createElement("input"), 20, 140); i.id = "i"; i.value = "typed words";
    const box = at(document.createElement("div"), 20, 200); box.style.width = "300px"; box.style.height = "120px"; box.style.background = "#fff";
    window.__marker = "before";
    return true;
  })()` });

  // A mouse event on the page itself, at (x, y) in the page.
  const mouse = (x, y, button, modifiers = []) => c.ev(`(() => {
    const o = { x: ${x}, y: ${y}, button: "${button}", clickCount: 1, modifiers: ${JSON.stringify(modifiers)} };
    active.wv.sendInputEvent({ type: "mouseMove", x: o.x, y: o.y }); // as a real pointer would: it is over the element first
    active.wv.sendInputEvent({ ...o, type: "mouseDown" }); active.wv.sendInputEvent({ ...o, type: "mouseUp" }); return true;
  })()`);
  let since = (await T("x402.events", { since: 0 })).next;
  async function rightClick(x, y) {
    await mouse(x, y, "right");
    const ev = await waitFor(async () => {
      const r = await T("x402.events", { since });
      const e = r.events.find((x) => x.kind === "context-menu");
      if (e) since = r.next;
      return e;
    }, "a right-click menu");
    return ev.items;
  }

  // on a link
  let items = await rightClick(40, 28);
  check(items.join(",") === "open-link-tab,copy-link,inspect", "right-click on a link offers Open Link in New Tab and Copy Link Address", items.join(","));
  let before = (await T("tabs.list")).length;
  check((await T("menu.pick", { id: "open-link-tab" })).ok, "picking Open Link in New Tab runs it");
  const opened = await waitFor(async () => { const l = await T("tabs.list"); return l.length === before + 1 ? l.find((t) => /\/headers\?from=menu/.test(t.url)) || null : null; }, "the new tab").catch(() => null);
  check(!!opened, "it opens the link in a new tab");
  check((await active()).id === page.id, "behind the page you are on (you stay where you were)");
  check(!(await T("menu.pick", { id: "paste" })).ok, "an item that was not in the menu cannot be picked");

  // on selected text
  await T("page.eval", { js: `(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById("s")); getSelection().removeAllRanges(); getSelection().addRange(r); return true; })()` });
  items = await rightClick(60, 90);
  check(items.join(",") === "copy,search-selection,ask-selection,inspect", "right-click on selected text offers Copy, Search askrobots and Ask the Assistant", items.join(","));
  const label = (await T("menu.last")).menu.items.find((i) => i.id === "search-selection")?.label;
  check(/^Search askrobots for “marmalade oranges and s…”$/.test(label || ""), "the search item names the text, clipped", label);
  await T("menu.pick", { id: "ask-selection" });
  const chat = await waitFor(async () => c.ev(`document.getElementById("chatIn").value`), "the chat box").catch(() => "");
  check(/marmalade oranges and sugar/.test(chat), "Ask the Assistant puts the text in the chat box for you to finish", JSON.stringify(chat));
  check(!(await c.ev(`[...document.querySelectorAll("#chatLog .m.u")].some((m) => /marmalade/.test(m.textContent))`)), "and sends nothing by itself");
  await c.ev(`(document.getElementById("chatIn").value = "", setChat(false), true)`);

  // in a text field
  items = await rightClick(40, 150);
  check(items.includes("select-all") && !items.includes("reload"), "right-click in a text field offers the edit items", items.join(","));
  const full = (await T("menu.last")).menu.items.filter((i) => i.id).map((i) => i.id);
  check(["undo", "redo", "cut", "copy", "paste", "select-all"].every((i) => full.includes(i)), "all six are in the menu (greyed out when they can't be used)", full.join(","));
  await T("menu.pick", { id: "select-all" });
  const sel = await waitFor(async () => { const v = (await T("page.eval", { js: `(() => { const i = document.getElementById("i"); return i.selectionStart === 0 && i.selectionEnd === i.value.length && document.activeElement === i })()` })).value; return v || null; }, "the field's text selected").catch(() => false);
  check(sel === true, "Select All selects the field's text");

  // anywhere else
  await T("page.eval", { js: "getSelection().removeAllRanges(), document.activeElement && document.activeElement.blur(), true" });
  items = await rightClick(150, 260);
  check(/^(back,)?(forward,)?reload,print,save-pdf,inspect$/.test(items.join(",")), "right-click on the page offers Back, Forward and Reload, then Print and Save as PDF", items.join(","));
  await T("menu.pick", { id: "reload" });
  const reloaded = await waitFor(async () => { const v = await T("page.eval", { js: "window.__marker || 'gone'" }).catch(() => null); return v && v.value === "gone" ? true : null; }, "the reload").catch(() => false);
  check(reloaded === true, "Reload reloads the page");

  // ⌘-click (Ctrl+click off a Mac) and middle-click open the link behind the page
  await waitFor(async () => !(await active()).loading, "the reloaded page");
  await T("page.eval", { js: `(() => { const a = document.createElement("a"); a.href = "/headers?from=click"; a.textContent = "click me"; a.style.cssText = "position:fixed;left:20px;top:20px;font:16px sans-serif"; document.body.appendChild(a); return true; })()` });
  before = (await T("tabs.list")).length;
  await mouse(35, 28, "left", [mod]);
  const viaMod = await waitFor(async () => { const l = await T("tabs.list"); return l.length === before + 1 ? l : null; }, "a tab from the modified click").catch(() => null);
  check(!!viaMod && (await active()).id === page.id, `${mod === "meta" ? "⌘" : "Ctrl+"}click on a link opens it in a new tab behind the page`, JSON.stringify(viaMod && viaMod.map((t) => t.url)));
  before = (await T("tabs.list")).length;
  await mouse(35, 28, "middle");
  const viaMiddle = await waitFor(async () => { const l = await T("tabs.list"); return l.length === before + 1 ? l : null; }, "a tab from the middle click").catch(() => null);
  check(!!viaMiddle && (await active()).id === page.id, "middle-click on a link does the same");

  // the browser's own fields: the address bar gets the text items only
  const own = await c.ev(`(() => { const u = document.getElementById("url"); u.focus(); u.select(); const r = u.getBoundingClientRect(); return [Math.round(r.left + 20), Math.round(r.top + r.height / 2)]; })()`);
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: own[0], y: own[1], button: "right", clickCount: 1 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: own[0], y: own[1], button: "right", clickCount: 1 });
  const ownItems = await waitFor(async () => { const r = await T("x402.events", { since }); const e = r.events.find((x) => x.kind === "context-menu"); if (e) since = r.next; return e && e.items; }, "the address bar's menu").catch(() => null);
  // Paste is greyed out (so not in the recorded list) when the clipboard is empty, as on a fresh CI machine: read the whole menu.
  const ownAll = ownItems ? (await T("menu.last")).menu.items.filter((i) => i.id).map((i) => i.id) : [];
  check(ownAll.join(",") === "undo,redo,cut,copy,paste,select-all", "right-click in the address bar offers the text items (Undo, Redo, Cut, Copy, Paste, Select All) and nothing else", ownAll.join(","));

  for (const t of await T("tabs.list")) if (/from=(menu|click)/.test(t.url)) await T("tabs.close", { tab: t.id }).catch(() => {});
  await T("tabs.close", { tab: page.id }).catch(() => {});
}
