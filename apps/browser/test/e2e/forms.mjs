// Form tools: page.forms and page.find list what is on a page with refs, and click/hover/type accept those refs.
export default async function (ctx) {
  const { call: T, check, base } = ctx;
  const rejects = (p) => p.then(() => null, (e) => e);

  await T("page.goto", { url: base + "/forms" });
  const r = await T("page.forms");
  const by = (name) => r.fields.find((f) => f.name === name);

  check(r.forms.length === 1 && r.forms[0].method === "post" && r.forms[0].action === base + "/forms/submit", "the form is listed with its method and an address without the query string", JSON.stringify(r.forms));
  check(by("first")?.label === "First name" && by("first").required && by("first").value === "Ada" && by("first").autocomplete === "given-name", "a text field has its label (from <label for>), required flag, value and autocomplete", JSON.stringify(by("first")));
  check(by("email")?.label === "Email" && by("email").placeholder === "you@example.com", "a wrapping <label> and a placeholder are reported");
  check(by("phone")?.label === "Phone number", "aria-label is used as the label");
  check(by("country")?.value === "ca" && by("country").options.length === 2 && by("country").options.find((o) => o.value === "ca").selected, "a select reports its options and the chosen one");
  const radios = r.fields.filter((f) => f.name === "via");
  check(radios.length === 2 && radios[0].checked === true && radios[1].checked === false && radios[0].group === "Contact by", "radios report checked state and the fieldset legend", JSON.stringify(radios.map((x) => [x.value, x.checked, x.group])));
  check(by("news")?.checked === false, "a checkbox reports checked");
  check(by("note")?.kind === "textarea" && by("note").value === "hello", "a textarea reports its value");

  // Things that must never leave the page.
  const pw = by("pw"), card = by("cardnumber"), otp = by("code");
  check(pw?.sensitive && pw.reason === "password" && pw.filled === true && !("value" in pw), "a password field is flagged and its value is not returned", JSON.stringify(pw));
  check(card?.sensitive && card.reason === "card" && !("value" in card), "a card-number field (autocomplete cc-number) is flagged and its value is not returned");
  check(otp?.sensitive && otp.reason === "one-time code" && !("value" in otp), "a one-time-code field is flagged and its value is not returned");
  const text = JSON.stringify(r);
  check(!/hunter2|4111111111111111|123456|csrf-secret-value/.test(text), "none of the secret values appear anywhere in the reply");
  check(!by("csrf") && !by("display-none") && r.skippedHidden >= 2, "hidden and display:none fields are skipped by default and counted", `skipped ${r.skippedHidden}`);

  const all = await T("page.forms", { includeHidden: true });
  const csrf = all.fields.find((f) => f.name === "csrf");
  check(csrf?.sensitive && csrf.reason === "hidden" && !("value" in csrf), "includeHidden lists a hidden field but still never its value", JSON.stringify(csrf));

  check(r.buttons.some((b) => b.text === "Create account" && b.type === "submit" && b.form === 0) && r.buttons.some((b) => b.text === "Cancel"), "buttons are listed with their text and the form they belong to");
  check(r.fields.some((f) => f.kind === "editable" && f.label === "Rich note"), "a contenteditable region is listed as an editable field");
  check(typeof r.frames.count === "number", "frames are counted (their fields are not listed)", JSON.stringify(r.frames));

  // find
  const f1 = await T("page.find", { text: "read the news" });
  check(f1.matches.length === 1 && f1.matches[0].role === "link" && f1.matches[0].href === base + "/free", "find by words returns a link with its address", JSON.stringify(f1.matches[0]));
  const f2 = await T("page.find", { label: "Email" });
  check(f2.matches.length >= 1 && f2.matches[0].role === "textbox", "find by label returns the field", JSON.stringify(f2.matches[0]));
  const f3 = await T("page.find", { role: "button" });
  check(f3.matches.length === 2, "find by role lists the buttons", String(f3.matches.length));
  check((await rejects(T("page.find")))?.code === "bad-params", "find with nothing to look for is a bad-params error");
  const f4 = await T("page.find", { text: "nothing like this" });
  check(f4.total === 0 && f4.matches.length === 0, "find with no match is an empty list, not an error");

  // refs drive the real input methods
  const cancel = r.buttons.find((b) => b.text === "Cancel");
  const clicked = await T("page.click", { ref: cancel.ref });
  const nClicks = (await T("page.eval", { js: "window.clicks" })).value;
  check(nClicks === 1, "page.click accepts a ref and really clicks it", JSON.stringify({ clicked, nClicks, cancel }));
  await T("page.type", { ref: by("phone").ref, text: "555-0100" });
  check((await T("page.eval", { js: "document.querySelector('[name=phone]').value" })).value === "555-0100", "page.type accepts a ref and types into it");
  await T("page.type", { ref: by("first").ref, text: "Grace" });
  check((await T("page.eval", { js: "document.querySelector('[name=first]').value" })).value === "Grace", "typing replaces the old value by default");
  check((await T("page.hover", { ref: f1.matches[0].ref })).hovered.x > 0, "page.hover accepts a ref");

  // refs stay the same for the same element, and a ref to something that is gone is an error, never a wrong click
  const again = await T("page.forms");
  check(again.fields.find((f) => f.name === "first").ref === by("first").ref, "the same element keeps the same ref between calls");
  await T("page.eval", { js: "document.querySelector('[name=phone]').remove()" });
  const gone = await rejects(T("page.click", { ref: by("phone").ref }));
  check(gone?.code === "no-element" && /not on the page/.test(gone.message), "a ref to a removed element is 'no-element'", gone?.message);
  check((await rejects(T("page.click", { ref: "e99999" })))?.code === "no-element", "a ref that never existed is 'no-element'");
  const sel = await rejects(T("page.click", { selector: "#nope" }));
  check(sel?.code === "no-element", "a selector that matches nothing is still 'no-element'");

  // After a navigation the old refs do not resolve (new document, new registry).
  await T("page.goto", { url: base + "/free" });
  check((await rejects(T("page.click", { ref: cancel.ref })))?.code === "no-element", "refs do not survive navigation");
}
