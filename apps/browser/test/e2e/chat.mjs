// The in-browser chat, end to end, against a scripted model on the demo server (see /v1/chat/completions there).
export default async function (ctx) {
  const { call: T, check, base, sleep } = ctx;
  const ev = async (since) => T("chat.events", { since });
  /** Wait until an event matching `pred` shows up after `since`. */
  async function waitEvent(since, pred, what) {
    for (let i = 0; i < 200; i++) {
      const { events } = await ev(since);
      const hit = events.find(pred);
      if (hit) return hit;
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${what}`);
  }
  const value = async (name) => (await T("page.eval", { js: `document.querySelector('[name=${name}]').value` })).value;

  const st = await T("chat.state");
  check(st.available && st.provider === "openai" && st.endpoint === new URL(base).host && st.mode === "ask" && !st.running, "the chat is available with the model endpoint named (host only), and starts in ask mode", JSON.stringify({ ...st, transcript: undefined }));
  check(!JSON.stringify(st).includes("e2e-fake-key"), "no key appears in the chat state");

  // the model picker: only models of providers that are set up are offered, and nothing else can be picked
  // (an Anthropic key in this machine's ~/.dbbasic/env adds Anthropic's models; CI has none)
  const host = new URL(base).host;
  check(st.models.some((m) => m.id === "openai/fake-model" && m.label === `fake-model (${host})`) && st.models.every((m) => /^(anthropic|openai)\//.test(m.id) && (m.id.startsWith("anthropic/") || m.id === "openai/fake-model")) && st.modelId === "openai/fake-model", "the assistant offers only the models it is set up for, the stand-in one named with its machine", JSON.stringify(st.models));
  const badPick = await T("chat.model", { model: "openai/gpt-not-offered" });
  const goodPick = await T("chat.model", { model: "openai/fake-model" });
  check(badPick.ok === false && goodPick.ok === true && goodPick.model === "fake-model", "a model that is not on offer cannot be picked", JSON.stringify({ badPick, goodPick }));

  await T("page.goto", { url: base + "/forms" });

  // reading
  const r1 = await T("chat.send", { text: "read this page" });
  check(r1.ok && r1.ended === "answered" && /^The page says: .*Sign up/.test(r1.reply), "the assistant reads the page with a tool and answers from it", r1.reply);
  check(r1.events.some((e) => e.kind === "tool-start" && e.name === "read_page") && !r1.events.some((e) => e.kind === "confirm"), "reading is shown as a step and needs no approval");

  const log = await (await fetch(base + "/v1/_log")).json();
  const lastReq = JSON.stringify(log.at(-1));
  const tm = log.at(-1).messages.at(-1);
  const word = /<untrusted-([0-9a-f]{12})>/.exec(log.at(-1).messages[0].content)?.[1];
  check(tm.role === "tool" && /^\[Content from a web page/.test(tm.content) && !!word && tm.content.includes(`<untrusted-${word}>`) && tm.content.endsWith(`</untrusted-${word}>`), "what a tool returned goes to the model with a line saying it is not from the person, between tags that carry this conversation's random word (the same word as in the system prompt)", word);
  check(/UNTRUSTED/.test(log.at(-1).messages[0].content) && log.at(-1).tools.some((t) => t.function.name === "type_text"), "the model is told the data is untrusted and is given the tools");
  check(!/hunter2|4111111111111111|123456|csrf-secret-value/.test(JSON.stringify(log)), "none of the secret values on the page ever reached the model");

  // filling in ask mode: each action waits for a yes
  let since = (await ev(0)).next;
  const run = T("chat.send", { text: "fill the form" });
  const c1 = await waitEvent(since, (e) => e.kind === "confirm", "the first approval");
  check(c1.name === "list_fields" ? false : /Type “Grace” into “First name”/.test(c1.summary) && c1.danger === false, "the first action is shown in words and is not marked dangerous", c1.summary);
  check((await value("first")) === "Ada", "nothing has changed on the page before the person says yes");
  await T("chat.confirm", { id: c1.id, ok: true });
  const c2 = await waitEvent(c1.seq, (e) => e.kind === "confirm", "the second approval");
  check(/Choose “United States” in “Country”/.test(c2.summary), "the next action waits for its own yes", c2.summary);
  await T("chat.confirm", { id: c2.id, ok: true });
  const r2 = await run;
  check(r2.ended === "answered" && (await value("first")) === "Grace" && (await value("country")) === "us", "after the yeses the name and the dropdown are filled in", JSON.stringify({ first: await value("first"), country: await value("country") }));
  check((await T("page.eval", { js: "window.submitted === true" })).value === false, "filling in did not submit the form");

  // a password field is refused outright, with no question asked
  since = (await ev(0)).next;
  const r3 = await T("chat.send", { text: "password please" });
  check(r3.reply === "Result: refused" && !r3.events.some((e) => e.kind === "confirm") && r3.events.some((e) => e.kind === "tool-denied"), "typing into a password field is refused without asking", r3.reply);
  check((await T("page.eval", { js: "document.querySelector('[name=pw]').value" })).value === "hunter2-secret", "the password field is unchanged");

  // submitting is a dangerous click: asked about, and a no really means no
  since = (await ev(0)).next;
  const run4 = T("chat.send", { text: "submit it" });
  const c4 = await waitEvent(since, (e) => e.kind === "confirm", "the submit approval");
  check(c4.danger === true && /submits the form/.test(c4.summary), "clicking a submit button is marked dangerous and says what it does", c4.summary);
  await T("chat.confirm", { id: c4.id, ok: false });
  const r4 = await run4;
  check(r4.reply === "Result: declined" && (await T("page.eval", { js: "window.submitted === true" })).value === false, "a no stops the click, and the assistant is told not to retry");
  since = (await ev(0)).next;
  const run4b = T("chat.send", { text: "submit it" });
  const c4b = await waitEvent(since, (e) => e.kind === "confirm", "the second submit approval");
  await T("chat.confirm", { id: c4b.id, ok: true });
  await run4b;
  check((await T("page.eval", { js: "window.submitted === true" })).value === true, "a yes lets the click through");

  // auto mode: ordinary steps run unasked, dangerous ones still ask
  await T("page.goto", { url: base + "/forms" });
  await T("chat.mode", { mode: "auto" });
  const r5 = await T("chat.send", { text: "fill the form" });
  check(r5.ended === "answered" && !r5.events.some((e) => e.kind === "confirm") && (await value("first")) === "Grace", "in auto mode filling in runs without asking", r5.reply);
  since = (await ev(0)).next;
  const run6 = T("chat.send", { text: "submit it" });
  const c6 = await waitEvent(since, (e) => e.kind === "confirm", "the submit approval in auto mode");
  check(c6.danger === true, "in auto mode a submit is still asked about");
  await T("chat.confirm", { id: c6.id, ok: false });
  await run6;
  since = (await ev(0)).next;
  const urlBefore = (await T("tabs.list")).find((t) => t.active).url;
  const run7 = T("chat.send", { text: "leave this site" });
  const c7 = await waitEvent(since, (e) => e.kind === "confirm", "the approval to open another site");
  check(c7.danger === true && /localhost/.test(c7.summary), "in auto mode going to a site that is not open is still asked about", c7.summary);
  await T("chat.confirm", { id: c7.id, ok: false });
  const r7 = await run7;
  check(r7.reply === "Result: declined" && (await T("tabs.list")).find((t) => t.active).url === urlBefore, "and a no leaves the tab where it was");
  await T("chat.mode", { mode: "ask" });

  // never silent, and the person can clear it
  const evs = await T("x402.events", { since: 0 });
  check(evs.events.some((e) => e.kind === "ai-chat" && e.modelCalls >= 1 && e.provider === "openai" && e.where === new URL(base).host), "every finished run is announced in the event log with the model and how much it used");
  await T("chat.clear");
  const cleared = await T("chat.state");
  check(cleared.transcript.length === 1 && cleared.transcript[0].kind === "cleared", "clearing empties the conversation");
  const afterClear = await T("chat.send", { text: "hello" });
  const lastLog = (await (await fetch(base + "/v1/_log")).json()).at(-1);
  check(afterClear.ok && lastLog.messages.filter((m) => m.role === "user").length === 1, "after clearing, the model sees a fresh conversation");


  // the panel (the chrome UI): open it, type, approve with a click, see the answer
  const c = await ctx.chrome();
  const q = (js) => c.ev(`(() => { ${js} })()`);
  await T("chat.clear");
  await T("page.goto", { url: base + "/forms" });
  await c.ev(`setChat(false)`); // earlier questions from the scripts opened it by themselves
  await c.ev(`toggleChat()`);
  await sleep(300);
  check(await q(`return document.getElementById('chat').classList.contains('open') && (/@/.test(document.getElementById('chatSub').textContent) || (!document.getElementById('chatModel').hidden && document.getElementById('chatModel').selectedOptions[0].textContent.includes('${new URL(base).host}'))) && /go to/.test(document.getElementById('chatPriv').textContent)`), "the panel opens and names the model and where your words go", await q(`return JSON.stringify([document.getElementById('chat').className, document.getElementById('chatSub').textContent, document.getElementById('chatPriv').textContent])`));
  const fits = await q(`const p = document.getElementById('chat').getBoundingClientRect(); return JSON.stringify(['chatModel', 'chatMode', 'chatClear', 'chatClose'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return [id, Math.round(r.left), Math.round(r.right), Math.round(p.right)]; }))`);
  check(JSON.parse(fits).every(([id, l, r, pr]) => (id === 'chatModel' && r === 0) || (r <= pr + 1 && r > l)), "the panel's header fits: the model picker, the mode, New and close are all inside it", fits);
  check(await q(`return !!document.getElementById('chatEmpty')`), "an empty conversation shows a short hint");
  await c.ev(`(() => { const i = document.getElementById('chatIn'); i.value = 'fill the form'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
  const waitDom = async (js, what) => { for (let i = 0; i < 150; i++) { if (await q(js)) return true; await sleep(50); } throw new Error("timed out waiting for " + what); };
  await waitDom(`return document.querySelectorAll('#chatLog .ask:not(.done)').length === 1`, "an approval card");
  check(await q(`const a = document.querySelector('#chatLog .ask'); return /Type “Grace” into “First name”/.test(a.querySelector('.what').textContent) && !a.classList.contains('danger') && document.getElementById('chatSend').textContent === 'Stop'`), "typing a message shows the action as a card with Do it / Skip, and the button becomes Stop");
  await q(`document.querySelector('#chatLog .ask:not(.done) .sbtn').click()`);
  await waitDom(`return document.querySelectorAll('#chatLog .ask:not(.done)').length === 1 && /Choose/.test(document.querySelector('#chatLog .ask:not(.done) .what').textContent)`, "the second card");
  await q(`document.querySelector('#chatLog .ask:not(.done) .sbtn.quiet').click()`); // Skip
  await waitDom(`return document.getElementById('chatSend').textContent === 'Send' && [...document.querySelectorAll('#chatLog .m.a')].some((m) => /Filled in/.test(m.textContent))`, "the answer");
  check(await q(`return [...document.querySelectorAll('#chatLog .ask')].map((a) => a.querySelector('.tag').textContent).join('|') === 'Approved|Skipped'`), "the cards end up marked Approved and Skipped");
  check((await value("first")) === "Grace" && (await value("country")) === "ca", "a click on Do it ran the action; a click on Skip did not (the country is still Canada)");
  check(await q(`return !document.getElementById('chatLog').innerHTML.includes('<script')`), "text from the model is shown as text, not as markup");
  await c.ev(`toggleChat()`);
  check(await q(`return !document.getElementById('chat').classList.contains('open')`), "the panel closes");

  // a question from a script opens the panel by itself, so the person sees it
  since = (await ev(0)).next;
  const run8 = T("chat.send", { text: "submit it" });
  await waitEvent(since, (e) => e.kind === "confirm", "the approval for the panel check");
  await waitDom(`return document.getElementById('chat').classList.contains('open') && document.querySelectorAll('#chatLog .ask.danger:not(.done)').length === 1`, "the panel to open itself");
  check(true, "a question that needs an answer opens the panel by itself, marked risky");
  await q(`document.querySelector('#chatLog .ask.danger .sbtn.quiet').click()`);
  await run8;

  // off while the caller network is on
  await T("net.provider", { enabled: true, userAgent: "E2E-Chat/1.0 (+https://example.invalid/about)" });
  const off = await T("chat.send", { text: "read this page" });
  const offState = await T("chat.state");
  await T("net.provider", { enabled: false });
  check(off.ok === false && off.reason === "caller-network-on" && offState.available === false, "the chat is switched off while the caller network is on", JSON.stringify(off));
}
