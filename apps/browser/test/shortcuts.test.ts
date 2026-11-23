import { describe, expect, it } from "vitest";
import { reservedShortcut, type KeyInput } from "../src/shortcuts";

const k = (over: Partial<KeyInput>): KeyInput => ({ type: "keyDown", key: "", code: "", meta: false, control: false, shift: false, alt: false, ...over });

describe("the browser's own keys", () => {
  it("⌘⇧] and ⌘⇧[ switch tabs on a Mac, by the key's place or by the character any layout reports", () => {
    expect(reservedShortcut(k({ meta: true, shift: true, code: "BracketRight", key: "}" }), true)).toBe("next");
    expect(reservedShortcut(k({ meta: true, shift: true, code: "", key: "]" }), true)).toBe("next");
    expect(reservedShortcut(k({ meta: true, shift: true, code: "BracketLeft", key: "{" }), true)).toBe("prev");
    expect(reservedShortcut(k({ meta: true, alt: true, key: "ArrowRight" }), true)).toBe("next");
  });
  it("Ctrl+Tab everywhere, ⌘1–⌘9, ⌘T, ⌘W, ⌘L and ⌘R", () => {
    expect(reservedShortcut(k({ control: true, key: "Tab" }), true)).toBe("next");
    expect(reservedShortcut(k({ control: true, shift: true, key: "Tab" }), false)).toBe("prev");
    expect(reservedShortcut(k({ meta: true, code: "Digit3", key: "3" }), true)).toBe("tab:3");
    expect(reservedShortcut(k({ meta: true, key: "t" }), true)).toBe("new");
    expect(reservedShortcut(k({ meta: true, key: "W" }), true)).toBe("close");
    expect(reservedShortcut(k({ meta: true, key: "l" }), true)).toBe("focus-url");
    expect(reservedShortcut(k({ control: true, key: "t" }), false)).toBe("new");
    expect(reservedShortcut(k({ meta: true, key: "r" }), true)).toBe("reload"); // even while the page has the keyboard
    expect(reservedShortcut(k({ control: true, key: "r" }), false)).toBe("reload");
    expect(reservedShortcut(k({ meta: true, shift: true, key: "R" }), true)).toBeNull(); // ⌘⇧R is the AI Reader's (the menu's)
  });
  it("leaves everything else to the page", () => {
    expect(reservedShortcut(k({ meta: true, key: "k" }), true)).toBeNull(); // the page's own search box
    expect(reservedShortcut(k({ meta: true, key: "]", code: "BracketRight" }), true)).toBeNull(); // ⌘] (forward) stays with the page first: editors indent with it
    expect(reservedShortcut(k({ meta: true, key: "c" }), true)).toBeNull();
    expect(reservedShortcut(k({ key: "]" }), true)).toBeNull();
    expect(reservedShortcut(k({ control: true, key: "t" }), true)).toBeNull(); // Ctrl+T on a Mac is the page's
    expect(reservedShortcut(k({ meta: true, shift: true, code: "BracketRight", key: "}", type: "keyUp" }), true)).toBeNull();
  });
});
