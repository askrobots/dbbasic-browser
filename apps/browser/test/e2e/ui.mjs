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
}
