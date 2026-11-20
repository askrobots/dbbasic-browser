/**
 * Browser shortcuts a page cannot take. A page that has the keyboard focus sees keys first, and one that swallows
 * them (an editor, a site's own shortcuts) would otherwise stop ⌘⇧] from switching tabs until you clicked the tab bar.
 * Like other browsers, the tab keys are the browser's: they are caught before the page sees them.
 *
 * Electron-free so it is unit-tested.
 */

export interface KeyInput {
  type: string;
  key: string;
  code: string;
  meta: boolean;
  control: boolean;
  shift: boolean;
  alt: boolean;
}

/** The tab command (as the menu sends them) for a key the browser keeps for itself, or null to leave it to the page. */
export function reservedShortcut(i: KeyInput, mac: boolean): string | null {
  if (i.type !== "keyDown") return null;
  // Ctrl+Tab / Ctrl+Shift+Tab on every platform
  if (i.control && !i.meta && !i.alt && i.key === "Tab") return i.shift ? "prev" : "next";
  const mod = mac ? i.meta && !i.control : i.control && !i.meta;
  if (!mod) return null;
  // ⌘⇧] and ⌘⇧[ (reported as } and { on some layouts): by the key's place, so any layout works
  if (i.shift && !i.alt && (i.code === "BracketRight" || i.key === "}" || i.key === "]")) return "next";
  if (i.shift && !i.alt && (i.code === "BracketLeft" || i.key === "{" || i.key === "[")) return "prev";
  if (i.alt && !i.shift && i.key === "ArrowRight") return "next";
  if (i.alt && !i.shift && i.key === "ArrowLeft") return "prev";
  if (i.shift || i.alt) return null;
  const digit = /^Digit([1-9])$/.exec(i.code);
  if (digit) return `tab:${digit[1]}`;
  const k = i.key.toLowerCase();
  if (k === "t") return "new";
  if (k === "w") return "close";
  if (k === "l") return "focus-url";
  return null;
}
