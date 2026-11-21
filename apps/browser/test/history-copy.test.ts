import { describe, expect, it } from "vitest";
import { HistoryCopy, MAX_VISITS } from "../src/history-copy.js";
import { forgetMatch } from "../src/history.js";

const day = 86_400_000;
const NOW = Date.parse("2026-11-21T12:00:00Z");

/** A stand-in for the account's list_history: a change log, read a page at a time from a cursor. */
function account() {
  let seq = 0;
  let resetAt = 0;
  const visits: Array<{ id: string; url: string; title: string; visited_at: string; seq: number }> = [];
  const gone: Array<{ id: string; seq: number }> = [];
  const calls: Array<Record<string, unknown>> = [];
  let n = 1;
  return {
    calls,
    add(url: string, title: string, at = NOW) {
      visits.push({ id: "v" + n++, url, title, visited_at: new Date(at).toISOString(), seq: ++seq });
    },
    forget(pred: (v: { url: string }) => boolean, all = false) {
      for (let i = visits.length - 1; i >= 0; i--) if (pred(visits[i]!)) (gone.push({ id: visits[i]!.id, seq: ++seq }), visits.splice(i, 1));
      if (all) resetAt = seq;
    },
    list(a: Record<string, unknown>) {
      calls.push(a);
      const since = a.cursor === undefined ? 0 : Number(String(a.cursor).slice(1));
      if (Number.isNaN(since) || since > seq) return { error: "unknown cursor" };
      if (a.cursor !== undefined && since < resetAt) return { visits: [], forgotten: [], full_copy: true, cursor: null, has_more: false };
      const limit = Number(a.limit) || 200;
      const newer = visits.filter((v) => v.seq > since).sort((x, y) => x.seq - y.seq);
      const page = newer.slice(0, limit);
      const upTo = page.length ? page[page.length - 1]!.seq : seq;
      return {
        visits: page.map(({ seq: _s, ...v }) => v),
        forgotten: a.cursor === undefined ? [] : gone.filter((g) => g.seq > since && g.seq <= upTo).map((g) => g.id),
        full_copy: false,
        cursor: "c" + upTo,
        has_more: newer.length > limit,
      };
    },
  };
}

function setup(o: { connected?: boolean; saved?: string | null } = {}) {
  const acct = account();
  const disk = { text: o.saved ?? (null as string | null) };
  const st = { connected: o.connected ?? true, now: NOW };
  const copy = new HistoryCopy({
    call: async (tool, args) => {
      if (tool !== "list_history") throw new Error("only list_history");
      return JSON.stringify(acct.list(args));
    },
    connected: () => st.connected,
    load: () => disk.text,
    save: (t) => (disk.text = t),
    now: () => st.now,
  });
  return { acct, copy, disk, st };
}

describe("history: the copy for the address bar", () => {
  it("reads the account's history, then only what changed, from the cursor it was given", async () => {
    const { acct, copy } = setup();
    acct.add("https://a.example/1", "One");
    acct.add("https://b.example/2", "Two");
    await copy.sync();
    expect(copy.pages().map((p) => p.url).sort()).toEqual(["https://a.example/1", "https://b.example/2"]);
    acct.add("https://c.example/3", "Three"); // from another computer
    await copy.sync();
    expect(acct.calls.map((c) => c.cursor)).toEqual([undefined, "c2"]);
    expect(copy.state().visits).toBe(3);
  });

  it("a forget on any computer reaches the copy; a forget-all starts it again", async () => {
    const { acct, copy } = setup();
    acct.add("https://a.example/1", "One");
    acct.add("https://b.example/2", "Two");
    await copy.sync();
    acct.forget((v) => v.url.includes("a.example"));
    await copy.sync();
    expect(copy.pages().map((p) => p.url)).toEqual(["https://b.example/2"]);
    acct.forget(() => true, true);
    acct.add("https://d.example/4", "Four");
    await copy.sync();
    expect(copy.pages().map((p) => p.url)).toEqual(["https://d.example/4"]);
  });

  it("a cursor the account no longer knows: starts again from nothing", async () => {
    const { acct, copy } = setup({ saved: JSON.stringify({ v: 1, cursor: "c999", visits: [{ id: "old", url: "https://gone.example/", title: "Gone", at: NOW }] }) });
    acct.add("https://a.example/1", "One");
    await copy.sync();
    expect(copy.pages().map((p) => p.url)).toEqual(["https://a.example/1"]);
  });

  it("reads page after page when there is more", async () => {
    const { acct, copy } = setup();
    for (let i = 0; i < 1200; i++) acct.add(`https://many.example/${i}`, `Page ${i}`);
    await copy.sync();
    expect(copy.state().visits).toBe(1200);
    expect(acct.calls.length).toBe(3);
    expect(acct.calls.every((c) => c.limit === 500)).toBe(true);
  });

  it("one page however many visits; most visited and most recent first", async () => {
    const { acct, copy } = setup();
    acct.add("https://once.example/", "Once, today", NOW - 1000);
    for (let i = 0; i < 5; i++) acct.add("https://often.example/", "Often", NOW - 3 * day - i);
    acct.add("https://old.example/", "Old", NOW - 90 * day);
    acct.add("https://old.example/", "Old, retitled", NOW - 80 * day);
    await copy.sync();
    const pages = copy.pages();
    expect(pages.map((p) => p.url)).toEqual(["https://often.example/", "https://once.example/", "https://old.example/"]);
    expect(pages[0]).toMatchObject({ visits: 5 });
    expect(pages[2]).toMatchObject({ visits: 2, title: "Old, retitled" });
  });

  it("is saved without the pages' text, and comes back when the browser opens", async () => {
    const a = setup();
    a.acct.add("https://a.example/1", "One");
    await a.copy.sync();
    const saved = a.disk.text!;
    expect(JSON.parse(saved)).toMatchObject({ v: 1, cursor: "c1", visits: [{ id: "v1", url: "https://a.example/1", title: "One" }] });
    expect(saved).not.toMatch(/text/);
    const b = setup({ connected: false, saved });
    expect(b.copy.pages().map((p) => p.url)).toEqual(["https://a.example/1"]);
  });

  it("signing out deletes it; nothing is read while signed out", async () => {
    const { acct, copy, disk, st } = setup();
    acct.add("https://a.example/1", "One");
    await copy.sync();
    copy.clear();
    expect(disk.text).toBeNull();
    expect(copy.pages()).toEqual([]);
    st.connected = false;
    await copy.sync();
    expect(acct.calls).toHaveLength(1);
  });

  it("a forget here takes the visits out at once, by page, site or the last hour", async () => {
    const { acct, copy } = setup();
    acct.add("https://www.other.com/a", "A", NOW - 10 * 60_000);
    acct.add("https://sub.other.com/b", "B", NOW - 2 * 3600_000);
    acct.add("https://example.com/c", "C", NOW - 2 * 3600_000);
    await copy.sync();
    copy.remove(forgetMatch("last_hour", undefined, NOW));
    expect(copy.pages().map((p) => p.url).sort()).toEqual(["https://example.com/c", "https://sub.other.com/b"]);
    copy.remove(forgetMatch("site", "https://www.other.com/", NOW));
    expect(copy.pages().map((p) => p.url)).toEqual(["https://example.com/c"]);
    copy.remove(forgetMatch("url", "https://example.com/c?utm_source=x#y", NOW));
    expect(copy.pages()).toEqual([]);
  });

  it("keeps at most MAX_VISITS visits, the oldest go first", async () => {
    const { acct, copy } = setup();
    for (let i = 0; i < MAX_VISITS + 10; i++) acct.add(`https://p.example/${i}`, "", NOW - (MAX_VISITS + 10 - i) * 1000);
    await copy.sync(); // (one read takes up to 20,000; the rest come on the next)
    await copy.sync();
    expect(copy.state().visits).toBe(MAX_VISITS);
    expect(copy.pages().some((p) => p.url === "https://p.example/0")).toBe(false);
  });
});
