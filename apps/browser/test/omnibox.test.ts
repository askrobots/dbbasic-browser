import { describe, expect, it } from "vitest";
import { autofillHost, commandArgs, commandRows, looksLikeAddress, parseCommand, parseSuggestions, remoteAllowed, suggest, toCommand } from "../src/omnibox";

const tabs = [
  { id: 1, url: "https://askrobots.com/", title: "Home - AskRobots" },
  { id: 2, url: "https://www.youtube.com/watch?v=x", title: "A song - YouTube" },
];
const bookmarks = [
  { url: "https://slashdot.org/", title: "Slashdot" },
  { url: "https://slashdot.org/story/1", title: "Amazon Fights the Delivery Protection Act" },
  { url: "https://slashgear.com/", title: "SlashGear" },
  { url: "https://coolify.io/docs/update", title: "Update Coolify | Coolify Docs" },
  { url: "https://news.example/marmalade", title: "Seville marmalade, the right way" },
];
const kept = [{ id: "0123456789abcdef", url: "https://recipes.example/zebra", title: "Zebra cake", view: "dbb-kept://0123456789abcdef/" }];

describe("the address bar", () => {
  it("tells addresses from searches, as Enter does", () => {
    for (const a of ["slashdot.org", "https://x.example/a b", "localhost:3000", "192.168.1.5/admin", "about:blank"]) expect(looksLikeAddress(a), a).toBe(true);
    for (const q of ["slashdot", "coolify update", "what is x402", ""]) expect(looksLikeAddress(q), q).toBe(false);
  });

  it("asks for search suggestions only for text that is not an address or part of one", () => {
    expect(remoteAllowed("coolify update")).toBe(true);
    expect(remoteAllowed("slash")).toBe(true);
    for (const t of ["slashdot.org", "https://intranet.example/secret", "localhost", "a", "user@host", "intranet/secret", "x".repeat(101)]) expect(remoteAllowed(t), t).toBe(false);
  });

  it("completes a site you use from what you typed, the most used one first", () => {
    const urls = bookmarks.map((b) => b.url);
    expect(autofillHost("slash", urls)).toBe("slashdot.org"); // saved twice
    expect(autofillHost("slashg", urls)).toBe("slashgear.com");
    expect(autofillHost("www.cool", urls)).toBe("coolify.io");
    expect(autofillHost("s", urls)).toBeNull(); // too short
    expect(autofillHost("slash dot", urls)).toBeNull();
    expect(autofillHost("slashdot.org", urls)).toBeNull(); // already complete
    expect(autofillHost("zzz", urls)).toBeNull();
    expect(autofillHost("loc", ["http://localhost:8899/x", "file:///etc/x"])).toBe("localhost:8899");
    expect(suggest({ text: "loc", tabs: [{ id: 3, url: "http://localhost:8899/x", title: "Local" }], bookmarks: [], kept: [] }).rows[0]).toEqual({ kind: "go", url: "http://localhost:8899/", title: "localhost:8899" });
  });

  it("puts what Enter does first, then tabs, saved links and kept copies, and the assistant last", () => {
    const r = suggest({ text: "slash", tabs, activeTab: 1, bookmarks, kept });
    expect(r.autofill).toBe("slashdot.org");
    expect(r.rows[0]).toEqual({ kind: "go", url: "https://slashdot.org/", title: "slashdot.org" });
    expect(r.rows.filter((x) => x.kind === "bookmark").map((x) => (x as { url: string }).url)).toEqual(["https://slashdot.org/", "https://slashdot.org/story/1", "https://slashgear.com/"]);
    expect(r.rows.at(-1)).toEqual({ kind: "ask", text: "slash" });

    const s = suggest({ text: "seville marmalade", tabs, bookmarks, kept });
    expect(s.rows[0]).toEqual({ kind: "search", text: "seville marmalade" });
    expect(s.rows[1]).toMatchObject({ kind: "bookmark", url: "https://news.example/marmalade" });

    const t = suggest({ text: "song", tabs, activeTab: 1, bookmarks, kept });
    expect(t.rows[1]).toEqual({ kind: "tab", id: 2, url: "https://www.youtube.com/watch?v=x", title: "A song - YouTube" });
    expect(suggest({ text: "home", tabs, activeTab: 1, bookmarks, kept }).rows.some((x) => x.kind === "tab")).toBe(false); // not the tab you are on

    const k = suggest({ text: "zebra", tabs, bookmarks, kept });
    expect(k.rows.find((x) => x.kind === "kept")).toEqual({ kind: "kept", url: "dbb-kept://0123456789abcdef/", title: "Zebra cake", original: "https://recipes.example/zebra" });

    const a = suggest({ text: "coolify.io/docs", tabs, bookmarks, kept });
    expect(a.rows[0]).toEqual({ kind: "go", url: "coolify.io/docs", title: "coolify.io/docs" });
    expect(a.rows.some((x) => x.kind === "ask")).toBe(false); // an address is not a question

    expect(suggest({ text: "slash", tabs, bookmarks, kept, autofill: false }).rows[0]).toEqual({ kind: "search", text: "slash" }); // while deleting
    expect(suggest({ text: "  ", tabs, bookmarks, kept }).rows).toEqual([]);
  });

  it("an open tab is not listed again as a saved link", () => {
    const r = suggest({ text: "slashdot", tabs: [{ id: 9, url: "https://slashdot.org", title: "Slashdot" }], bookmarks, kept });
    expect(r.rows.filter((x) => x.kind === "tab")).toHaveLength(1);
    expect(r.rows.filter((x) => x.kind === "bookmark").map((x) => (x as { url: string }).url)).toEqual(["https://slashdot.org/story/1"]);
  });

  it("reads OpenSearch suggestions, without the text itself, duplicates or junk", () => {
    expect(parseSuggestions('["slash", ["slashdot", "slash", "Slashdot", "slashfilm", 3, ""]]', "slash")).toEqual(["slashdot", "slashfilm"]);
    expect(parseSuggestions("not json", "x")).toEqual([]);
    expect(parseSuggestions('{"a":1}', "x")).toEqual([]);
    expect(parseSuggestions(JSON.stringify(["q", Array.from({ length: 20 }, (_, i) => "q" + i)]), "q")).toHaveLength(5);
  });

  describe("/ commands", () => {
    const tools = [
      { name: "create_task", description: "Creates a new task\nwith details", inputSchema: { properties: { title: { type: "string" }, priority: { type: "integer" } }, required: ["title"] }, annotations: { readOnlyHint: false, destructiveHint: false } },
      { name: "list_tasks", description: "List tasks", inputSchema: { properties: { status: { type: "string" } } }, annotations: { readOnlyHint: true } },
      { name: "create_note", description: "Create a note", inputSchema: { properties: { content: { type: "string" } }, required: ["content"] }, annotations: { destructiveHint: false } },
      { name: "delete_tag", description: "Delete a tag", inputSchema: { properties: { tag_id: { type: "string" } }, required: ["tag_id"] }, annotations: { destructiveHint: true } },
      { name: "mystery", description: "No hints at all", inputSchema: { properties: {} } },
      { name: "create_link", description: "Save a link", inputSchema: { properties: { url: { type: "string" }, project_id: { type: "string" } }, required: ["project_id", "url"] } },
      { name: "get_task", description: "One task", inputSchema: { properties: { task_id: { type: "integer" }, verbose: { type: "boolean" } }, required: ["task_id", "verbose"] }, annotations: { readOnlyHint: true } },
    ];
    const cmds = tools.map((t) => toCommand(t, t.name === "create_link" ? ["project_id"] : []));

    it("reads a tool as a command: its argument, whether it only reads, and whether it asks first", () => {
      expect(cmds[0]).toMatchObject({ name: "create_task", description: "Creates a new task", arg: "title", argType: "string", argRequired: true, readOnly: false, destructive: false });
      expect(cmds[1]).toMatchObject({ arg: "status", argRequired: false, readOnly: true, destructive: false });
      expect(cmds[3]?.destructive).toBe(true);
      expect(cmds[4]?.destructive).toBe(true); // no hints: assume it may change things, and ask
      expect(cmds[5]).toMatchObject({ arg: "url", needs: [] }); // the project is fixed by the browser, never asked for
    });

    it("parses a line, with the site's short names", () => {
      expect(parseCommand("/note buy milk")).toEqual({ name: "create_note", typed: "note", rest: "buy milk" });
      expect(parseCommand("/create_task  Fix the roof ")).toEqual({ name: "create_task", typed: "create_task", rest: "Fix the roof" });
      expect(parseCommand("/")).toEqual({ name: "", typed: "", rest: "" });
      expect(parseCommand("not a command")).toBeNull();
    });

    it("turns the rest of the line into the argument, typed, or says what is missing", () => {
      expect(commandArgs(cmds[0]!, "buy milk")).toEqual({ args: { title: "buy milk" } });
      expect(commandArgs(cmds[0]!, "")).toEqual({ problem: "type the title" });
      expect(commandArgs(cmds[1]!, "")).toEqual({ args: {} }); // optional
      expect(commandArgs(cmds[4]!, "x")).toEqual({ problem: "takes nothing after its name" });
      expect(commandArgs(cmds[6]!, "12")).toMatchObject({ problem: expect.stringMatching(/needs verbose too/) });
      const num = toCommand({ name: "n", inputSchema: { properties: { id: { type: "integer" } }, required: ["id"] } });
      expect(commandArgs(num, "12")).toEqual({ args: { id: 12 } });
      expect(commandArgs(num, "twelve")).toEqual({ problem: "id must be a number" });
    });

    it("lists matching commands while the name is typed, then the one command with what it will send", () => {
      expect(commandRows("/", cmds).length).toBe(7);
      expect(commandRows("/no", cmds).map((r) => (r as { name: string }).name)).toEqual(["create_note"]); // the short name
      expect(commandRows("/task", cmds).map((r) => (r as { name: string }).name)).toEqual(["create_task", "list_tasks", "get_task"]); // /task, then names containing it
      const one = commandRows("/create_task buy milk", cmds);
      expect(one).toEqual([expect.objectContaining({ kind: "cmd", name: "create_task", line: "/create_task buy milk", preview: "title: buy milk", ready: true })]);
      expect(commandRows("/create_task ", cmds)[0]).toMatchObject({ ready: false, problem: "type the title" });
      expect(commandRows("/list_tasks", cmds)[0]).toMatchObject({ ready: true }); // nothing needed
      expect(commandRows("/nothing here", cmds)).toEqual([]);
      expect(remoteAllowed("/note buy milk")).toBe(false); // a command is never sent as a search
    });
  });
});