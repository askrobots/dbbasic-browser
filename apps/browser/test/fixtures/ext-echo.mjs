// A tiny extension for the tests. It also pins the parts of the browser that local extensions are allowed to rely on:
// the page of a tab, the window that hosts it, and that asking for a page never raises or focuses the window.
import { BrowserWindow } from "electron";

export function register(api) {
  api.method("echo", async (params, tools) => {
    const wc = await tools.webContents(params);
    return { url: wc.getURL(), said: params.say ?? null };
  });
  api.method("boom", () => {
    throw new Error("boom on purpose");
  });
  // The window that hosts a page, found the way an extension would find it.
  api.method("host", async (params, tools) => {
    const wc = await tools.webContents(params);
    const win = wc.hostWebContents ? BrowserWindow.fromWebContents(wc.hostWebContents) : null;
    return { found: !!win, contentSize: win ? win.getContentSize() : null, type: wc.getType() };
  });
  // The window's state, to compare before and after other calls.
  api.method("window", () => {
    const win = BrowserWindow.getAllWindows()[0];
    return { focused: win.isFocused(), visible: win.isVisible(), minimized: win.isMinimized(), size: win.getContentSize(), position: win.getPosition() };
  });
  // Can the page be painted into an image (the same call page.screenshot uses)? Never waits for ever.
  api.method("paintable", async (params, tools) => {
    const wc = await tools.webContents(params);
    const img = await Promise.race([wc.capturePage(), new Promise((_, no) => setTimeout(() => no(new Error("not painted within 8 s")), 8000))]);
    const s = img.getSize();
    return { width: s.width, height: s.height, empty: img.isEmpty() };
  });
}
