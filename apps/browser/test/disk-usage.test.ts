import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diskUsage } from "../src/disk-usage";

describe("disk usage", () => {
  it("adds up a folder, names its biggest parts, and does not follow links out of it", async () => {
    const d = mkdtempSync(join(tmpdir(), "du-"));
    mkdirSync(join(d, "Cache"));
    mkdirSync(join(d, "Small"));
    writeFileSync(join(d, "Cache", "a"), Buffer.alloc(300_000));
    writeFileSync(join(d, "Cache", "b"), Buffer.alloc(300_000));
    writeFileSync(join(d, "Small", "c"), "x");
    const outside = mkdtempSync(join(tmpdir(), "du-out-"));
    writeFileSync(join(outside, "huge"), Buffer.alloc(5_000_000));
    symlinkSync(outside, join(d, "link"));
    const u = await diskUsage(d);
    expect(u.top[0]?.name).toBe("Cache");
    expect(u.top[0]!.bytes).toBeGreaterThanOrEqual(600_000);
    expect(u.bytes).toBeLessThan(2_000_000); // the 5 MB file behind the link is not counted
    expect(u.files).toBe(3);
    expect(u.truncated).toBe(false);
  });

  it("stops after a number of files and says the figure is a floor; a missing folder is empty", async () => {
    const d = mkdtempSync(join(tmpdir(), "du-"));
    for (let i = 0; i < 30; i++) writeFileSync(join(d, `f${i}`), "x");
    const u = await diskUsage(d, { maxFiles: 10 });
    expect(u.truncated).toBe(true);
    expect(u.files).toBe(10);
    expect(await diskUsage(join(d, "nope"))).toEqual({ bytes: 0, files: 0, truncated: false, top: [] });
  });
});
