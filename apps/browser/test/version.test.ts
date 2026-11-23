import { describe, expect, it } from "vitest";
import { compareVersions, displayVersion, nextVersion, parseVersion, semverVersion, shownVersion } from "../src/version.ts";

describe("version: year.month and a release count", () => {
  it("shows package.json's semver with the month padded and a v before the count", () => {
    expect(displayVersion("2026.11.1")).toBe("2026.11v1");
    expect(displayVersion("2026.1.3")).toBe("2026.01v3");
    expect(displayVersion("2026.12.1-beta.2")).toBe("2026.12v1-beta.2");
  });

  it("writes semver without a leading zero, which semver forbids", () => {
    const v = parseVersion("2027.01v1");
    expect(v && semverVersion(v)).toBe("2027.1.1");
  });

  it("reads either spelling, and nothing else", () => {
    expect(parseVersion("2026.11v1")).toEqual({ year: 2026, month: 11, n: 1, pre: "" });
    expect(parseVersion("2026.11.1")).toEqual({ year: 2026, month: 11, n: 1, pre: "" });
    for (const bad of ["0.1.0", "2026.13.1", "2026.11.0", "2026.011.1", "2026.11v01", "2026.1v1", "2026.11", "v2026.11.1"]) {
      expect(parseVersion(bad), bad).toBeNull();
    }
    expect(displayVersion("0.1.0")).toBe("0.1.0");
  });

  it("counts up within a month and starts again at 1 in a new one (by the UTC month)", () => {
    const nov = new Date("2026-11-23T12:00:00Z");
    expect(shownVersion(nextVersion("0.1.0", nov))).toBe("2026.11v1");
    expect(shownVersion(nextVersion("2026.11.1", nov))).toBe("2026.11v2");
    expect(shownVersion(nextVersion("2026.11.2", new Date("2026-12-01T00:00:00Z")))).toBe("2026.12v1");
    expect(shownVersion(nextVersion("2026.12.1", new Date("2027-01-01T00:30:00Z")))).toBe("2027.01v1");
    expect(shownVersion(nextVersion("2026.11.1", new Date("2026-11-30T23:59:59-05:00")))).toBe("2026.12v1"); // already December in UTC
  });

  it("after a pre-release, the next is that release, final", () => {
    expect(shownVersion(nextVersion("2026.12.1-beta.2", new Date("2026-12-05T00:00:00Z")))).toBe("2026.12v1");
  });

  it("sorts in release order, a pre-release before its final", () => {
    const order = ["2026.11v1", "2026.11v2", "2026.12v1-beta.1", "2026.12v1-beta.2", "2026.12v1", "2027.01v1"];
    const parsed = order.map((s) => parseVersion(s)!);
    const shuffled = [...parsed].reverse().sort(compareVersions);
    expect(shuffled.map(shownVersion)).toEqual(order);
  });
});
