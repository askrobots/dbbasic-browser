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

  await T("page.goto", { url: base + "/forms" });

  // reading
  const r1 = await T("chat.send", { text: "read this page" });
  check(r1.ok && r1.ended === "answered" && /^The page says: .*Sign up/.test(r1.reply), "the assistant reads the page with a tool and answers from it", r1.reply);
  check(r1.events.some((e) => e.kind === "tool-start" && e.name === "read_page") && !r1.events.some((e) => e.kind === "confirm"), "reading is shown as a step and needs no approval");

  const log = await (await fetch(base + "/v1/_log")).json();
  const lastReq = JSON.stringify(log.at(-1));
  check(log.at(-1).messages.at(-1).role === "tool" && log.at(-1).messages.at(-1).content.startsWith("<data>"), "what a tool returned goes to the model tagged as untrusted data");
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

  // off while the caller network is on
  await T("net.provider", { enabled: true, userAgent: "E2E-Chat/1.0 (+https://example.invalid/about)" });
  const off = await T("chat.send", { text: "read this page" });
  const offState = await T("chat.state");
  await T("net.provider", { enabled: false });
  check(off.ok === false && off.reason === "caller-network-on" && offState.available === false, "the chat is switched off while the caller network is on", JSON.stringify(off));
}
