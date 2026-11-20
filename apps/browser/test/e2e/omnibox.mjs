// The address bar: completes sites you use, suggests open tabs, kept copies and searches as you type, hands questions to the
// assistant, never sends an address for suggestions, and passes ⌘K to the page.
export default async function (ctx) {
  const { call: T, check, base, sleep } = ctx;
  const cdp = await ctx.chrome();
  const q = (js) => cdp.ev(`(() => { ${js} })()`);
  async function waitFor(fn, what, tries = 60) {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    throw new Error(`timed out waiting for ${what}`);
  }
  const port = new URL(base).port;
  const local = `http://localhost:${port}`;
  // type as a person does: the text arrives through input events
  const type = (text, inputType = "insertText") => q(`const u = document.getElementById('url'); u.focus(); u.value = ${JSON.stringify(text)}; u.dispatchEvent(new InputEvent('input', { inputType: ${JSON.stringify(inputType)} })); return true`);
  const key = (k, extra = {}) => q(`document.getElementById('url').dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: ${JSON.stringify(k)}, bubbles: true }, ${JSON.stringify(extra)}))); return true`);
  const rows = () => q(`return [...document.querySelectorAll('#omni.open .or')].map((r) => r.dataset.kind + ':' + r.querySelector('.tt').textContent)`);
  const bar = () => q(`const u = document.getElementById('url'); return { v: u.value, s: u.selectionStart, e: u.selectionEnd }`);
  const asked = async () => (await fetch(base + "/suggest/_asked")).json();
  const active = async () => (await T("tabs.list")).find((t) => t.active);

  // tabs to find: a page on "localhost" and one with its own ⌘K box
  const cmdk = await T("tabs.new", { url: base + "/cmdk" });
  await T("tabs.new", { url: local + "/free" });
  await sleep(400);
  const kept = await T("tabs.new", { url: base + "/keep-me" });
  await sleep(300);
  await T("keep.tab", { tab: kept.id });

  // a site you use is completed inline, and Enter goes there with its own scheme and port
  await T("tabs.new", { url: base + "/free" });
  await sleep(300);
  await type("loc");
  await waitFor(async () => (await rows()).length, "the suggestions");
  const b = await bar();
  check(b.v === `localhost:${port}` && b.s === 3 && b.e === b.v.length, "typing the start of a site you use completes it, with the rest selected so typing on replaces it", JSON.stringify(b));
  check((await rows())[0] === `go:localhost:${port}`, "and the first row says Enter goes there", JSON.stringify(await rows()));
  await key("Enter");
  await waitFor(async () => (await active()).url.startsWith(local + "/"), "the completed site to open");
  check(true, "Enter opens the completed site (plain http, its port kept)");

  // deleting does not complete again
  await type("lo", "deleteContentBackward");
  await waitFor(async () => (await rows()).length, "rows after deleting");
  check((await bar()).v === "lo" && (await rows())[0] === "search:lo", "while deleting, nothing is completed", JSON.stringify(await bar()));
  await key("Escape");

  // an open tab is offered, and picking it switches to it
  await type("command k");
  await waitFor(async () => (await rows()).some((r) => r === "tab:Command K"), "the open tab row");
  const r1 = await rows();
  check(r1[0] === "search:command k" && r1.at(-1) === "ask:command k", "a search is first, the open tab is listed, and asking the assistant is last", JSON.stringify(r1));
  for (let i = 0; i < r1.indexOf("tab:Command K"); i++) await key("ArrowDown");
  await key("Enter");
  await waitFor(async () => (await active()).id === cmdk.id, "the switch to the tab");
  check(true, "↓ and Enter on an open tab switches to it");

  // kept copies, and search suggestions from the search site
  await type("marmalade");
  await waitFor(async () => (await rows()).some((r) => r === "kept:Marmalade notes"), "the kept copy row");
  check(true, "a kept copy is found by its title");
  await waitFor(async () => (await rows()).includes("suggest:marmalade recipe"), "search suggestions");
  check(true, "search suggestions arrive from the search site");
  await key("Escape");

  // addresses are never sent for suggestions; nor anything while they are switched off
  await type("127.0.0.1/private/path");
  await type("intranet.example/secret");
  await type("localhost:1234");
  await sleep(500);
  await type("pear tart");
  await waitFor(async () => (await rows()).includes("suggest:pear tart recipe"), "suggestions for a search");
  await q(`[...document.querySelectorAll('#omni .of a')][0].click(); return true`);
  await type("plum jam");
  await sleep(500);
  await q(`[...document.querySelectorAll('#omni .of a')][0].click(); return true`); // back on
  const sent = await asked();
  check(sent.includes("pear tart") && !sent.some((x) => /127\.0\.0\.1|intranet|localhost|plum/.test(x)), "only searches are sent for suggestions: never an address, and nothing while switched off", JSON.stringify(sent));
  await key("Escape");
  await key("Escape");

  // what you type is not overwritten by a page that finishes loading meanwhile
  await T("tabs.new", { url: base + "/free" });
  await sleep(300);
  await type("half typed");
  await q(`active.wv.loadURL(${JSON.stringify(base + "/free?later=1")}); return true`);
  await sleep(700);
  check((await bar()).v === "half typed", "a page loading while you type does not overwrite the address bar", JSON.stringify(await bar()));
  await key("Escape");
  await key("Escape");
  check((await bar()).v.includes("/free?later=1"), "Esc twice puts the page's address back");

  // ⌘K reaches the page even when the address bar has the focus (as right after a new tab)
  await T("tabs.activate", { tab: cmdk.id });
  await sleep(200);
  await q(`document.getElementById('url').focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })); return true`);
  const got = await waitFor(async () => { const v = await T("page.eval", { js: "({ n: window.__cmdk || 0, f: document.activeElement && document.activeElement.id })" }); return v.value && v.value.n ? v.value : null; }, "the page's ⌘K", 30).catch(() => null);
  check(got && got.n === 1 && got.f === "box", "⌘K in the address bar goes to the page, whose own search box gets the focus", JSON.stringify(got || { page: (await T("page.eval", { js: "({ url: location.href, keys: window.__keys || [] })" })).value, chrome: await q(`return { id: active.id, url: active.url, ready: active.ready }`), cmdk: cmdk.id }));

  // "/" commands: the askrobots tools of the sign-in (a stand-in here); nothing without a sign-in
  await T("tabs.new", { url: base + "/free" });
  await sleep(300);
  const notes = async () => (await fetch(base + "/o/_notes")).json();
  const out = () => q(`const o = document.getElementById('omniOut'); return o.classList.contains('open') ? o.textContent : ''`);
  await type("/no");
  await waitFor(async () => (await rows()).length, "rows for a command before signing in");
  check((await rows()).join("|") === "notice:Connect askrobots to use / commands", "before connecting, / offers to connect and lists nothing", JSON.stringify(await rows()));
  await key("Enter");
  check(await q(`return document.getElementById('chat').classList.contains('open')`), "and Enter opens the panel where you connect");
  await cdp.ev(`setChat(false)`);
  await T("mcp.connect", { id: "askrobots", wait: true });

  await type("/");
  await waitFor(async () => (await rows()).length > 3, "the command list");
  const all = await rows();
  check(all.includes("cmd:/lookup") && all.includes("cmd:/wipe") && all.includes("cmd:/create_note") && !all.some((r) => /upload_file/.test(r)), "once connected, / lists the service's tools (not the browser's own upload)", JSON.stringify(all));
  await type("/no");
  await waitFor(async () => (await rows())[0] === "cmd:/create_note", "the /note shortcut");
  await key("Tab");
  check((await bar()).v === "/create_note ", "the site's short names work (/note is create_note), and Tab completes the command", JSON.stringify(await bar()));

  await type("/note buy milk");
  await waitFor(async () => (await rows())[0] === "cmd:/note buy milk", "the command row");
  check(/content: buy milk/.test(await q(`return document.querySelector('#omni .or').textContent`)), "the row shows what will be saved before Enter");
  await key("Enter");
  await waitFor(async () => /created/.test(await out()), "the answer");
  check((await notes()).notes.some((n) => n.content === "buy milk"), "Enter runs it on the service, and the answer is shown", await out());

  await type("/lookup marmalade");
  await waitFor(async () => (await rows())[0] === "cmd:/lookup marmalade", "the lookup row");
  await key("Enter");
  await waitFor(async () => /Found 2 notes about marmalade/.test(await out()), "the lookup answer");
  check(!(await q(`return !!document.querySelector('#omniOut script, #omniOut img')`)), "an answer is shown as text, whatever it says");

  await type("/wipe");
  await waitFor(async () => (await rows())[0] === "cmd:/wipe", "the wipe row");
  await key("Enter");
  await waitFor(async () => (await rows()).some((r) => /Press Enter again/.test(r)), "the question");
  check((await notes()).wiped === 0, "a command the service marks as destructive asks first, and does nothing yet", JSON.stringify(await rows()));
  await key("Enter");
  await waitFor(async () => (await notes()).wiped === 1, "the confirmed wipe");
  check(true, "a second Enter runs it");

  await type("/save hello");
  await waitFor(async () => (await rows()).length, "the save row");
  await key("Enter");
  await sleep(300);
  check(/needs project_id too/.test(await q(`return document.getElementById('omni').textContent`)), "a command needing more than one line can give says so instead of running", await q(`return document.getElementById('omni').textContent`));
  await type("/zzz");
  await waitFor(async () => /no command/.test((await rows()).join()), "the unknown command note");
  check(true, "an unknown command says so");
  check(!(await asked()).some((x) => x.startsWith("/")), "commands are never sent for search suggestions");
  await key("Escape");
}
