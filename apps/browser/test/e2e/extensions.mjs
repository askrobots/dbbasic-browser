// Local extensions: extra automation methods from a file named in DBB_EXTENSIONS (see src/extensions.ts).
export default async function (ctx) {
  const { call: T, check, base } = ctx;
  const rejects = (p) => p.then(() => null, (e) => e);

  const st = await T("status");
  check(Array.isArray(st.extensions) && st.extensions.length === 1 && st.extensions[0] === "ext-echo.mjs", "status lists the extension by file name only (no folder layout)", JSON.stringify(st.extensions));

  await T("page.goto", { url: base + "/free" });
  const r = await T("ext.echo", { say: "hello" });
  check(r.said === "hello" && r.url === base + "/free", "an extension method runs with its parameters and can reach the page of the active tab", JSON.stringify(r));

  const t2 = await T("tabs.new", { url: base + "/headers", activate: false });
  const r2 = await T("ext.echo", { tab: t2.id ?? (await T("tabs.list")).at(-1).id });
  check(/\/headers$/.test(r2.url), "…and of the tab it names", r2.url);

  check((await rejects(T("ext.boom")))?.code === "extension-error", "an extension that throws is an API error, not a crash");
  check((await rejects(T("ext.nothing")))?.code === "no-method", "an unknown extension method is 'no-method'");
  check((await rejects(T("echo")))?.code === "no-method", "an extension method is only reachable as ext.<name>");
}
