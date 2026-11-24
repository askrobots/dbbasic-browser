import { describe, expect, it } from "vitest";
import { DownloadList, MAX_KEPT, type DownloadRecord } from "../src/downloads-store";

const base = (over: Partial<DownloadRecord> = {}): Omit<DownloadRecord, "id"> => ({
  name: "report.pdf",
  host: "example.com",
  url: "https://example.com/report.pdf",
  total: 100,
  received: 0,
  state: "progressing",
  path: "/downloads/report.pdf",
  startedAt: 1000,
  ...over,
});

describe("the downloads list", () => {
  it("is saved when a download starts and ends, and read back after a restart", () => {
    let file: string | null = null;
    let saves = 0;
    const a = new DownloadList(null, (t) => ((file = t), saves++), () => 5000);
    const r = a.add(base());
    expect(r.id).toBe(1);
    a.update(r.id, { received: 50 }); // progress alone: not saved each time
    expect(saves).toBe(1);
    a.update(r.id, { received: 100, state: "completed" });
    expect(saves).toBe(2);
    expect(a.get(r.id)?.endedAt).toBe(5000);
    const b = new DownloadList(file, () => {});
    expect(b.list().map((x) => [x.id, x.name, x.state, x.received])).toEqual([[1, "report.pdf", "completed", 100]]);
    expect(b.add(base({ name: "next.zip" })).id).toBe(2); // ids carry on after a restart
  });

  it("lists one still running when the browser closed as interrupted", () => {
    const file = JSON.stringify({ v: 1, items: [{ ...base(), id: 3, state: "progressing" }, { ...base(), id: 4, state: "paused" }] });
    expect(new DownloadList(file, () => {}).list().map((x) => x.state)).toEqual(["interrupted", "interrupted"]);
  });

  it("ignores a damaged file and damaged entries, and keeps only web addresses for Retry", () => {
    expect(new DownloadList("{nope", () => {}).list()).toEqual([]);
    const file = JSON.stringify({ v: 1, items: [{ id: "x", name: "a" }, { id: 2 }, { ...base(), id: 5, url: "javascript:alert(1)", state: "bogus", extra: "dropped" }] });
    const l = new DownloadList(file, () => {}).list();
    expect(l.length).toBe(1);
    expect(l[0]).toMatchObject({ id: 5, url: "", state: "interrupted" });
    expect("extra" in l[0]!).toBe(false);
  });

  it("removes one or clears the finished ones, never a running download", () => {
    const a = new DownloadList(null, () => {});
    const done = a.add(base({ state: "completed" }));
    const run = a.add(base({ name: "big.bin" }));
    expect(a.remove(run.id)).toBe(false);
    expect(a.remove(done.id)).toBe(true);
    a.add(base({ state: "cancelled" }));
    expect(a.clear()).toBe(1);
    expect(a.list().map((x) => x.name)).toEqual(["big.bin"]);
  });

  it("keeps the newest MAX_KEPT", () => {
    const a = new DownloadList(null, () => {});
    for (let i = 0; i <= MAX_KEPT; i++) a.add(base({ name: `f${i}`, state: "completed" }));
    expect(a.list().length).toBe(MAX_KEPT);
    expect(a.list()[0]!.name).toBe("f1");
  });
});
