/**
 * The right-click menu: which items to show for what was clicked. Electron-free (main.ts turns the items into a native
 * menu and runs them), so it is unit-tested.
 *
 *   on a link            Open Link in New Tab, Copy Link Address
 *   on an image          Open Image in New Tab, Copy Image, Copy Image Address, Save Image As…
 *   in a text field      spelling suggestions, Undo, Redo, Cut, Copy, Paste, Select All
 *   on selected text     Copy, Search askrobots for "…", Ask the Assistant About This
 *   anywhere else        Back, Forward, Reload; Print…, Save as PDF…
 *   and last             Inspect Element (pages only)
 */

/** The parts of Electron's context-menu params this uses. */
export interface ClickedOn {
  linkURL?: string;
  linkText?: string;
  selectionText?: string;
  isEditable?: boolean;
  editFlags?: { canUndo?: boolean; canRedo?: boolean; canCut?: boolean; canCopy?: boolean; canPaste?: boolean; canSelectAll?: boolean };
  mediaType?: string;
  srcURL?: string;
  hasImageContents?: boolean;
  misspelledWord?: string;
  dictionarySuggestions?: string[];
}

export interface MenuContext {
  /** A web page (true) or the browser's own toolbar and panels (false: only the text items). */
  page: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** False when new tabs are off (the caller-supplied network mode opens none). */
  newTabs: boolean;
}

export type MenuItem = { id: string; label: string; enabled?: boolean } | { type: "separator" };

const web = (u: string | undefined): u is string => !!u && /^https?:\/\//i.test(u);
/** At most n characters of selected text, on one line, for a menu label. */
export function clipLabel(s: string, n = 24): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1).trimEnd() + "…" : one;
}

export function contextMenuItems(p: ClickedOn, c: MenuContext): MenuItem[] {
  const out: MenuItem[] = [];
  const sep = () => out.push({ type: "separator" });
  const f = p.editFlags ?? {};
  const link = p.linkURL && !/^javascript:/i.test(p.linkURL) ? p.linkURL : "";
  // Right-clicking a link can select the word under the pointer (macOS does): that is not a selection worth searching for.
  const raw = (p.selectionText ?? "").trim();
  const selection = link && raw && (p.linkText ?? "").includes(raw) ? "" : raw;
  const image = p.mediaType === "image" && !!p.srcURL;

  if (p.isEditable && p.misspelledWord) {
    const sug = (p.dictionarySuggestions ?? []).slice(0, 5);
    if (sug.length) sug.forEach((w, i) => out.push({ id: `spell:${i}`, label: w }));
    else out.push({ id: "no-suggestions", label: "No Guesses Found", enabled: false });
    sep();
  }
  if (c.page && link) {
    if (web(link) && c.newTabs) out.push({ id: "open-link-tab", label: "Open Link in New Tab" });
    out.push({ id: "copy-link", label: "Copy Link Address" });
    sep();
  }
  if (c.page && image) {
    if (web(p.srcURL) && c.newTabs) out.push({ id: "open-image-tab", label: "Open Image in New Tab" });
    out.push({ id: "copy-image", label: "Copy Image" });
    if (web(p.srcURL)) out.push({ id: "copy-image-address", label: "Copy Image Address" }, { id: "save-image", label: "Save Image As…" });
    sep();
  }
  if (p.isEditable) {
    out.push(
      { id: "undo", label: "Undo", enabled: f.canUndo !== false },
      { id: "redo", label: "Redo", enabled: f.canRedo !== false },
      { type: "separator" },
      { id: "cut", label: "Cut", enabled: f.canCut !== false },
      { id: "copy", label: "Copy", enabled: f.canCopy !== false },
      { id: "paste", label: "Paste", enabled: f.canPaste !== false },
      { id: "select-all", label: "Select All", enabled: f.canSelectAll !== false },
    );
    sep();
  } else if (selection) {
    out.push({ id: "copy", label: "Copy" });
    if (c.page) {
      if (c.newTabs) out.push({ id: "search-selection", label: `Search askrobots for “${clipLabel(selection)}”` });
      out.push({ id: "ask-selection", label: "Ask the Assistant About This" });
    }
    sep();
  }
  if (c.page && !link && !image && !p.isEditable && !selection) {
    out.push(
      { id: "back", label: "Back", enabled: c.canGoBack },
      { id: "forward", label: "Forward", enabled: c.canGoForward },
      { id: "reload", label: "Reload" },
    );
    sep();
    out.push({ id: "print", label: "Print…" }, { id: "save-pdf", label: "Save as PDF…" });
    sep();
  }
  if (c.page) out.push({ id: "inspect", label: "Inspect Element" });

  // no separator first, last, or twice in a row
  const tidy: MenuItem[] = [];
  for (const it of out) if (!("type" in it) || (tidy.length && !("type" in tidy[tidy.length - 1]!))) tidy.push(it);
  while (tidy.length && "type" in tidy[tidy.length - 1]!) tidy.pop();
  return tidy;
}
