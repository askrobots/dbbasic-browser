import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { macFootprints, parseFootprint } from "../src/process-memory";

const sample = JSON.stringify({
  processes: [
    { name: "Electron", pid: 10, footprint: 134911488, auxiliary: { phys_footprint: 135009792 } },
    { name: "Electron Helper (Renderer)", pid: 11, footprint: 422_000_000 },
    { name: "odd", pid: "x", footprint: 1 },
    { name: "no number", pid: 12 },
  ],
});

describe("process memory", () => {
  it("reads the physical footprint of each process, in bytes", () => {
    expect([...parseFootprint(sample)]).toEqual([[10, 135009792], [11, 422_000_000]]);
    expect(parseFootprint("not json").size).toBe(0);
    expect(parseFootprint("{}").size).toBe(0);
  });

  it("asks the macOS tool for the given pids only (no shell), and gives nothing elsewhere or on failure", async () => {
    const calls: string[][] = [];
    const exec = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      writeFileSync(args[args.length - 1] as string, sample);
    };
    const m = await macFootprints([10, 11, 11, -5, 3.5], "darwin", exec);
    expect(m.get(11)).toBe(422_000_000);
    expect(calls[0]).toEqual(["/usr/bin/footprint", "-p", "10", "-p", "11", "--noCategories", "-j", expect.stringMatching(/dbb-fp-.*fp\.json$/)]);
    expect((await macFootprints([10], "linux", exec)).size).toBe(0);
    expect((await macFootprints([], "darwin", exec)).size).toBe(0);
    expect((await macFootprints([10], "darwin", async () => { throw new Error("no tool"); })).size).toBe(0);
  });
});
