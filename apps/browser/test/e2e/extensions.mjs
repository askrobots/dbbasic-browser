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

  // What extensions are allowed to rely on, pinned here so a change to the browser cannot break them silently.
  const host = await T("ext.host");
  check(host.found && host.type === "webview" && host.contentSize[0] > 0 && host.contentSize[1] > 0, "the page's host window is reachable from its web contents, and the page is a webview", JSON.stringify(host));
  const paint = await T("ext.paintable");
  check(!paint.empty && paint.width > 100 && paint.height > 100, "the active page can be painted to an image", `${paint.width}x${paint.height}`);

  // Asking for a page never raises, focuses, moves or resizes the window, including when the tab has to be made the visible one.
  const w0 = await T("ext.window");
  await T("ext.echo", {});
  const other = (await T("tabs.list")).find((t) => !t.active);
  if (other) await T("ext.echo", { tab: other.id });
  const w1 = await T("ext.window");
  check(JSON.stringify(w1) === JSON.stringify(w0), "asking for a page (even another tab) does not raise, focus, move or resize the window", JSON.stringify({ before: w0, after: w1 }));
}
