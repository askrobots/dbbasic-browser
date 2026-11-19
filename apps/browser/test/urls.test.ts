import { describe, expect, it } from "vitest";
import { safeExternalUrl } from "../src/urls.js";

describe("safeExternalUrl", () => {
  it("allows http(s) and normalizes", () => {
    expect(safeExternalUrl("https://www.ebay.com/itm/1?x=2")).toBe("https://www.ebay.com/itm/1?x=2");
    expect(safeExternalUrl("http://127.0.0.1:8899")).toBe("http://127.0.0.1:8899/");
  });
  it("refuses everything that could launch something else", () => {
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "vscode://open", "ssh://host", "about:blank", "", "not a url"]) {
      expect(safeExternalUrl(bad)).toBeNull();
    }
  });
  it("refuses embedded credentials and non-strings", () => {
    expect(safeExternalUrl("https://user:pw@example.com/")).toBeNull();
    expect(safeExternalUrl(undefined)).toBeNull();
    expect(safeExternalUrl({ href: "https://a.test" })).toBeNull();
  });
});
