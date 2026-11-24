// The chrome UI: password-manager offers and panel, locking, and the built-in Help page.
import { fileURLToPath } from "node:url";

export default async function (ctx) {
  const { call: T, check, base, sleep } = ctx;
  const c = await ctx.chrome();
  const bar = () => c.ev(`(() => { const b = document.getElementById('offerbar'); return b.classList.contains('show') ? b.innerText.replace(/\\s+/g,' ').trim() : '' })()`);

  await T("vault.unlock", { master: ctx.vaultMaster });
  const start = (await T("vault.state")).count;

  // a login page we have a saved login for → the fill offer
  await T("page.goto", { url: base + "/login" });
  await sleep(900);
  let t = await bar();
  check(/Saved login for/.test(t) && /Sign in as demo/.test(t), "fill offer on a login page with a saved login", t);

  // a real typed submit with NEW credentials → the save offer, which survives the navigation
  await T("page.type", { selector: "input[name=username]", text: "newuser" });
  await T("page.type", { selector: "input[name=password]", text: "Sup3r-secret-pw" });
  await T("page.press", { key: "Enter" });
  await sleep(1500);
  t = await bar();
  check(/Save password for/.test(t) && t.includes("newuser"), "save offer after a real submit (and it survives the navigation)", t);
  check(!(await c.ev(`document.documentElement.innerHTML`)).includes("Sup3r-secret-pw"), "the password is NOT present anywhere in the chrome UI's DOM");
  await c.ev(`[...document.querySelectorAll('#offerbar .sbtn')].find(b => b.textContent === 'Save').click(); 1`);
  await sleep(700);
  check((await T("vault.state")).count === start + 1, "clicking Save stores the login", `${start} → ${(await T("vault.state")).count}`);
  check((await bar()) === "", "the offer bar goes away after saving");

  // a page-forged submit event must NOT raise a save offer (only trusted input counts)
  await T("page.goto", { url: base + "/login" });
  await sleep(900);
  await c.ev(`tabs[0].fillOffer = null; tabs[0].saveOffer = null; 1`);
  await T("page.eval", { js: `(() => { document.querySelector('input[name=username]').value='fake'; document.querySelector('input[name=password]').value='fake-pw-zzz'; document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); })()` });
  await sleep(800);
  check((await c.ev(`!!tabs[0].saveOffer`)) === false, "a page-forged submit event does not trigger a save offer");

  // the panel
  await c.ev(`document.getElementById('keyBtn').click(); 1`);
  await sleep(600);
  const panel = await c.ev(`document.getElementById('vaultPanel').innerText.replace(/\\s+/g,' ')`);
  check(/saved/.test(panel) && /newuser/.test(panel) && /demo/.test(panel), "the 🔑 panel lists the logins", panel.slice(0, 80));
  check(!panel.includes("Sup3r-secret-pw") && !panel.includes("demo-pass"), "the panel shows no passwords");
  await c.ev(`document.getElementById('keyBtn').click(); 1`);

  // locking
  await c.ev(`window.x402.vault.lock(); 1`);
  await sleep(400);
  check((await T("vault.state")).unlocked === false, "lock() locks the vault");
  await T("login").then(() => check(false, "login worked while locked"), (e) => check(e.code === "locked", "login is refused while locked"));

  // Help renders, at an anchor
  const help = new URL("../../dist/help.html", import.meta.url);
  const nt = await T("tabs.new", { url: fileURLToPath(help) ? help.href + "#automation" : "", wait: true });
  await sleep(500);
  const title = (await T("page.eval", { tab: nt.id, js: "document.title + ' | ' + location.hash + ' | h2s=' + document.querySelectorAll('h2').length" })).value;
  check(/dbbasic-browser Help/.test(title) && /#automation/.test(title), "the Help page renders in a tab, at its anchor", title);
  await T("tabs.close", { tab: nt.id });

  // Back and Forward are greyed out when there is nowhere to go that way.
  const navBtns = () => c.ev(`(document.getElementById('back').disabled ? 'back-off' : 'back-on') + ' ' + (document.getElementById('fwd').disabled ? 'fwd-off' : 'fwd-on')`);
  const waitNav = async (want) => { let v = ""; for (let i = 0; i < 50; i++) { v = await navBtns(); if (v === want) break; await sleep(100); } return v; };
  const navTab = await T("tabs.new", { url: base + "/free", wait: true });
  let nb = await waitNav("back-off fwd-off");
  check(nb === "back-off fwd-off", "a new tab's first page: Back and Forward are both greyed out", nb);
  await T("page.goto", { url: base + "/links" });
  nb = await waitNav("back-on fwd-off");
  check(nb === "back-on fwd-off", "after going to a second page, Back works and Forward is still greyed out", nb);
  await c.ev(`document.getElementById('back').click(); 1`);
  nb = await waitNav("back-off fwd-on");
  check(nb === "back-off fwd-on", "after going back, Forward works and Back is greyed out", nb);
  await T("tabs.close", { tab: navTab.id });

  // Hovering a link shows its address in the status area: green for this site, amber for another, and not by colour alone.
  const linkBar = () => c.ev(`(() => { const e = document.getElementById('link'); return e.classList.contains('show') ? { text: e.innerText.replace(/\\s+/g, ' ').trim(), cls: e.className } : null })()`);
  await T("page.goto", { url: base + "/links" });
  await sleep(500);
  check((await linkBar()) === null, "no link under the pointer: the link bar is hidden");
  await T("page.hover", { selector: "#same" });
  await sleep(300);
  let lb = await linkBar();
  check(lb && /same/.test(lb.cls) && lb.text.includes(base + "/free?from=links") && /this site/.test(lb.text), "hovering a link on this site shows its full address, marked 'this site' (green)", lb && lb.text);
  await T("page.hover", { selector: "#other" });
  await sleep(300);
  lb = await linkBar();
  check(lb && /other/.test(lb.cls) && /localhost/.test(lb.text) && /other site/.test(lb.text), "a link to another site is marked 'other site' (amber)", lb && lb.text);
  await T("page.hover", { selector: "#plain" });
  await sleep(300);
  check((await linkBar()) === null, "moving off the link hides the bar again");
  await T("page.hover", { selector: "#same" });
  await sleep(300);
  await T("page.goto", { url: base + "/free" });
  await sleep(400);
  check((await linkBar()) === null, "navigating away clears a stale link address");

  // Reload button: reloads the page, and is a Stop button while a page is loading.
  await T("page.goto", { url: base + "/free" });
  await T("page.eval", { js: "window.__marker = 'before-reload'" });
  check(await c.ev(`(() => { const b = document.getElementById('reload'); return !!b && !!b.querySelector('svg') && b.getAttribute('aria-label') === 'Reload' && /Reload/.test(b.title) })()`), "the toolbar has a reload button");
  // Drawn icons, not emoji: emoji depend on the installed font (on Linux some show as empty boxes).
  const icons = await c.ev(`(() => ["newTab", "back", "fwd", "keepBtn", "starBtn", "galleryBtn", "tourBtn", "bmBtn", "chatBtn", "readerBtn", "keyBtn", "inspectBtn"]
    .map((id) => { const b = document.getElementById(id); const s = b && b.querySelector('svg.ico'); return !s ? id + ": no icon" : /\\p{Extended_Pictographic}/u.test(b.textContent) ? id + ": emoji" : s.getAttribute('aria-hidden') !== 'true' ? id + ": icon not hidden" : ''; })
    .filter(Boolean).join(", "))()`);
  check(icons === "", "every toolbar button has a drawn icon and no emoji", icons);
  check(await c.ev(`!!document.getElementById('back').getAttribute('aria-label') && !!document.getElementById('fwd').getAttribute('aria-label') && !!document.getElementById('newTab').getAttribute('aria-label')`), "icon-only buttons have a name for screen readers");
  await c.ev(`document.getElementById('reload').click()`);
  let gone = false;
  for (let i = 0; i < 60 && !gone; i++) { await sleep(100); gone = (await T("page.eval", { js: "window.__marker === undefined" })).value === true; }
  check(gone, "clicking it reloads the page (a value the page held is gone)");
  // while a slow page loads it is a Stop button, and clicking it stops the load
  const slow = T("page.goto", { url: base + "/slow", wait: false });
  await sleep(500);
  const during = await c.ev(`(() => { const b = document.getElementById('reload'); return b.getAttribute('aria-label') + '|' + b.title })()`);
  check(/^Stop\|Stop/.test(during), "while a page is loading the button is a Stop button", during);
  await slow.catch(() => {});
  await c.ev(`document.getElementById('reload').click()`);
  let back = false;
  for (let i = 0; i < 60 && !back; i++) { await sleep(100); back = await c.ev(`document.getElementById('reload').getAttribute('aria-label') === 'Reload'`); }
  check(back, "clicking Stop ends the load and the button goes back to Reload");

  // find in page: the page's own find, with a count, next and previous, per tab
  const findTab = await T("tabs.new", { url: base + "/keep-me" });
  await sleep(600);
  const fb = () => c.ev(`(() => ({ open: document.getElementById('findBar').classList.contains('open'), v: document.getElementById('findIn').value, n: document.getElementById('findCount').textContent, focus: document.activeElement && document.activeElement.id, none: document.getElementById('findBar').classList.contains('none') }))()`);
  const waitFb = async (pred, what) => { for (let i = 0; i < 50; i++) { const v = await fb(); if (pred(v)) return v; await sleep(100); } throw new Error("timed out waiting for " + what + ": " + JSON.stringify(await fb())); };
  const fkey = (k, shift = false) => c.ev(`document.getElementById('findIn').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, shiftKey: ${shift}, bubbles: true }))`);
  await c.ev(`onTabCmd("find")`);
  let f = await waitFb((v) => v.open, "the find bar");
  check(f.open && f.focus === "findIn", "Edit ▸ Find (⌘F) opens the find bar with the typing in it", JSON.stringify(f));
  await c.ev(`(() => { const i = document.getElementById('findIn'); i.value = 'marmalade'; i.dispatchEvent(new Event('input')); })()`);
  f = await waitFb((v) => v.n === "1 of 2", "the first match");
  check(f.focus === "findIn", "typing finds the matches and counts them (1 of 2), and the typing stays in the bar", JSON.stringify(f));
  await fkey("Enter");
  f = await waitFb((v) => v.n === "2 of 2", "the next match");
  check(true, "Enter goes to the next match");
  await fkey("Enter", true);
  f = await waitFb((v) => v.n === "1 of 2", "the previous match");
  check(true, "Shift+Enter goes back to the previous one");
  await c.ev(`onTabCmd("find-next")`);
  f = await waitFb((v) => v.n === "2 of 2", "Find Next");
  check(true, "Find Next (⌘G) goes to the next match");
  await c.ev(`(() => { const i = document.getElementById('findIn'); i.value = 'zebrafinchqq'; i.dispatchEvent(new Event('input')); })()`);
  f = await waitFb((v) => v.n === "No matches", "no matches");
  check(f.none, "text that is not on the page says No matches", JSON.stringify(f));
  await c.ev(`(() => { const i = document.getElementById('findIn'); i.value = 'quick brown'; i.dispatchEvent(new Event('input')); })()`);
  await waitFb((v) => v.n === "1 of 1", "the phrase");
  // another tab has its own find: the bar goes away there, and comes back here
  const otherTab = await T("tabs.new", { url: base + "/free" });
  await sleep(400);
  f = await fb();
  check(!f.open, "another tab does not show this tab's find bar", JSON.stringify(f));
  await T("tabs.activate", { tab: findTab.id });
  f = await waitFb((v) => v.open && v.v === "quick brown", "the find bar back on its tab");
  check(true, "switching back shows the find bar with what was being found");
  await fkey("Escape");
  f = await waitFb((v) => !v.open, "the bar to close");
  const sel = (await T("page.eval", { js: "String(getSelection())" })).value;
  check(sel === "quick brown", "Esc closes the find bar and leaves the match selected on the page (⌘C copies it)", JSON.stringify(sel));
  await c.ev(`onTabCmd("find")`);
  f = await waitFb((v) => v.open, "the bar again");
  const selAll = await c.ev(`(() => { const i = document.getElementById('findIn'); return i.selectionStart === 0 && i.selectionEnd === i.value.length })()`);
  check(f.v === "quick brown" && selAll, "opening it again offers the last search, selected so typing replaces it", JSON.stringify(f));
  await fkey("Escape");
  await T("tabs.close", { tab: otherTab.id }).catch(() => {});
  await T("tabs.close", { tab: findTab.id }).catch(() => {});
}

