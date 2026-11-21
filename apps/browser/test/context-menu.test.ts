import { describe, expect, it } from "vitest";
import { clipLabel, contextMenuItems, type ClickedOn, type MenuContext } from "../src/context-menu.js";

const page: MenuContext = { page: true, canGoBack: true, canGoForward: false, newTabs: true };
const ids = (p: ClickedOn, c: MenuContext = page) => contextMenuItems(p, c).map((it) => ("id" in it ? it.id : "—"));

describe("right-click menu", () => {
  it("on a link: open in a new tab and copy its address", () => {
    expect(ids({ linkURL: "https://example.com/a" })).toEqual(["open-link-tab", "copy-link", "—", "inspect"]);
  });

  it("a word of the link selected by the right-click itself is not offered as a selection", () => {
    expect(ids({ linkURL: "https://example.com/a", linkText: "a link to open", selectionText: "link" })).toEqual(["open-link-tab", "copy-link", "—", "inspect"]);
    expect(ids({ linkURL: "https://example.com/a", linkText: "a link", selectionText: "text chosen beforehand" })).toEqual(["open-link-tab", "copy-link", "—", "copy", "search-selection", "ask-selection", "—", "inspect"]);
  });

  it("a link that is not a web address can be copied but not opened", () => {
    expect(ids({ linkURL: "mailto:a@example.com" })).toEqual(["copy-link", "—", "inspect"]);
    expect(ids({ linkURL: "javascript:alert(1)" })).toEqual(["back", "forward", "reload", "—", "inspect"]);
  });

  it("no new tabs while new tabs are off", () => {
    expect(ids({ linkURL: "https://example.com/" }, { ...page, newTabs: false })).toEqual(["copy-link", "—", "inspect"]);
    expect(ids({ selectionText: "hello" }, { ...page, newTabs: false })).toEqual(["copy", "ask-selection", "—", "inspect"]);
  });

  it("on an image: open, copy, copy address, save", () => {
    expect(ids({ mediaType: "image", srcURL: "https://example.com/p.png" })).toEqual(["open-image-tab", "copy-image", "copy-image-address", "save-image", "—", "inspect"]);
    expect(ids({ mediaType: "image", srcURL: "data:image/png;base64,AAAA" })).toEqual(["copy-image", "—", "inspect"]);
  });

  it("an image inside a link gets both", () => {
    expect(ids({ linkURL: "https://example.com/", mediaType: "image", srcURL: "https://example.com/p.png" })).toEqual(["open-link-tab", "copy-link", "—", "open-image-tab", "copy-image", "copy-image-address", "save-image", "—", "inspect"]);
  });

  it("on selected text: copy, search for it, ask the assistant", () => {
    const items = contextMenuItems({ selectionText: "  the quick   brown fox jumps over the lazy dog " }, page);
    expect(items.map((it) => ("id" in it ? it.id : "—"))).toEqual(["copy", "search-selection", "ask-selection", "—", "inspect"]);
    expect(items.find((it) => "id" in it && it.id === "search-selection")).toMatchObject({ label: "Search askrobots for “the quick brown fox jum…”" });
  });

  it("in a text field: the edit items, enabled as the field says", () => {
    const items = contextMenuItems({ isEditable: true, editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: true, canSelectAll: true } }, page);
    expect(items.map((it) => ("id" in it ? `${it.id}${it.enabled === false ? "(off)" : ""}` : "—"))).toEqual(["undo(off)", "redo(off)", "—", "cut(off)", "copy(off)", "paste", "select-all", "—", "inspect"]);
  });

  it("a misspelled word offers its suggestions first", () => {
    expect(ids({ isEditable: true, misspelledWord: "teh", dictionarySuggestions: ["the", "ten", "tea", "tech", "teak", "team"] })[0]).toBe("spell:0");
    expect(ids({ isEditable: true, misspelledWord: "teh", dictionarySuggestions: ["the", "ten", "tea", "tech", "teak", "team"] }).filter((i) => i.startsWith("spell:"))).toHaveLength(5);
    expect(contextMenuItems({ isEditable: true, misspelledWord: "zxqv", dictionarySuggestions: [] }, page)[0]).toMatchObject({ id: "no-suggestions", enabled: false });
  });

  it("anywhere else on a page: back, forward, reload", () => {
    const items = contextMenuItems({}, page);
    expect(items.map((it) => ("id" in it ? `${it.id}${it.enabled === false ? "(off)" : ""}` : "—"))).toEqual(["back", "forward(off)", "reload", "—", "inspect"]);
  });

  it("the browser's own fields get only the text items", () => {
    const own: MenuContext = { page: false, canGoBack: false, canGoForward: false, newTabs: true };
    expect(ids({ isEditable: true, linkURL: "https://example.com/" }, own)).toEqual(["undo", "redo", "—", "cut", "copy", "paste", "select-all"]);
    expect(ids({ selectionText: "a label" }, own)).toEqual(["copy"]);
    expect(ids({}, own)).toEqual([]);
  });

  it("never starts or ends with a separator, or has two in a row", () => {
    for (const p of [{}, { linkURL: "https://x.example/" }, { selectionText: "x" }, { isEditable: true }, { mediaType: "image", srcURL: "https://x.example/i.png" }]) {
      for (const c of [page, { ...page, page: false }]) {
        const s = ids(p, c).join(",");
        expect(s.startsWith("—")).toBe(false);
        expect(s.endsWith("—")).toBe(false);
        expect(s.includes("—,—")).toBe(false);
      }
    }
  });

  it("clips long selections for the label", () => {
    expect(clipLabel("short")).toBe("short");
    expect(clipLabel("a\nb\tc")).toBe("a b c");
    expect(clipLabel("x".repeat(40), 10)).toBe("xxxxxxxxx…");
  });
});
