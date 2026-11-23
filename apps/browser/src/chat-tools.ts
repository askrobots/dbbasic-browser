/**
 * The tools the chat can use on the open tabs. Each one is a thin layer over the browser's own automation methods
 * (the same ones scripts use), run in-process through `run`. Reading tools just run; tools that change something say
 * what they are about to do first (see chat-core.ts). In Auto mode only a short allow-list runs unasked:
 *  - switching tab, going back, keys that only move (Tab, arrows, Page Up/Down…), closing a tab, saving a tab as a bookmark,
 *    keeping a copy of a tab;
 *  - typing into an ordinary field and choosing in a dropdown;
 *  - clicking a link to a site that is already open, a checkbox or radio button, or a disclosure triangle.
 * Everything else asks: any other click (a "Post" or "Accept" button need not say anything scary), Enter, opening an address on
 * a site that is not open. Clicks that submit a form or are about paying, buying, deleting or sending are always marked risky.
 * After the assistant has read private data from a connected account, typing and opening addresses ask in every mode.
 * Fields for passwords, card numbers and one-time codes are refused outright.
 */

import type { ToolDef } from "./chat-core.js";
import { CHOOSE_JS, REF_INFO_JS } from "./page-tools.js";

export type Runner = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const DANGER = /\b(buy|pay|purchase|order|place|checkout|check out|delete|remove|submit|confirm|send|sign ?up|subscribe|donate|transfer|withdraw|unsubscribe|cancel (my|the) )/i;
const KEYS = ["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"];

interface RefInfo {
  found: boolean;
  tag?: string;
  type?: string | null;
  text?: string;
  label?: string | null;
  name?: string | null;
  sensitive?: string | null;
  submits?: boolean;
  link?: string | null;
}

const str = (input: Record<string, unknown>, k: string): string => {
  const v = input[k];
  if (typeof v !== "string" || !v.trim()) throw new Error(`"${k}" (text) is required`);
  return v;
};
const tabParam = (input: Record<string, unknown>): Record<string, unknown> => (typeof input.tab === "number" ? { tab: input.tab } : {});
const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Only plain http(s) addresses, with no embedded credentials. */
export function webAddress(v: string): URL {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`"${short(v, 60)}" is not a web address`);
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) throw new Error("only plain http(s) addresses without a login in them can be opened");
  return u;
}

export function pageTools(run: Runner): ToolDef[] {
  const info = async (input: Record<string, unknown>): Promise<RefInfo> => {
    const ref = str(input, "ref");
    const r = (await run("page.eval", { js: REF_INFO_JS(ref), ...tabParam(input) })) as { value: RefInfo };
    return r.value;
  };
  const needFound = (i: RefInfo): string | undefined => (i.found ? undefined : "that ref is not on the page any more; call list_fields or find again to get a fresh one");
  const nameOf = (i: RefInfo) => short(i.label || i.text || i.name || i.tag || "element", 60);
  const openHosts = async (): Promise<Set<string>> => {
    const tabs = (await run("tabs.list", {})) as Array<{ url: string }>;
    const hosts = new Set<string>();
    for (const t of tabs) {
      try {
        hosts.add(new URL(t.url).host);
      } catch {
        /* about:blank and friends */
      }
    }
    return hosts;
  };
  const tabProp = { tab: { type: "integer", description: "A tab id from list_tabs. Leave out for the tab the person is looking at." } };
  const refProp = { ref: { type: "string", description: "A ref from list_fields or find, such as e12." } };

  return [
    {
      name: "list_tabs",
      description: "List the open tabs: id, address, title, and which one is active.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read",
      run: async () => (await run("tabs.list", {})) as unknown,
    },
    {
      name: "read_page",
      description: "Read the visible text of a page. Long pages are cut, so for something specific prefer find.",
      input_schema: { type: "object", properties: tabProp, additionalProperties: false },
      risk: "read",
      run: async (input) => {
        const tabs = (await run("tabs.list", {})) as Array<{ id: number; url: string; title: string; active: boolean }>;
        const t = typeof input.tab === "number" ? tabs.find((x) => x.id === input.tab) : tabs.find((x) => x.active);
        const r = (await run("page.text", tabParam(input))) as { text: string | null };
        return `Address: ${t?.url ?? ""}\nTitle: ${t?.title ?? ""}\n\n${r.text ?? ""}`;
      },
    },
    {
      name: "list_fields",
      description:
        "List the form fields and buttons on a page: label, type, options, current value, and a ref for each. Passwords, card numbers and codes are listed without their values. Use the refs with type_text, choose and click.",
      input_schema: { type: "object", properties: { ...tabProp, includeHidden: { type: "boolean" } }, additionalProperties: false },
      risk: "read",
      run: async (input) => run("page.forms", { ...tabParam(input), includeHidden: input.includeHidden === true }),
    },
    {
      name: "find",
      description: "Find links, buttons and fields on a page by their words, label or role (link, button, textbox, checkbox…). Returns refs.",
      input_schema: { type: "object", properties: { ...tabProp, text: { type: "string" }, label: { type: "string" }, role: { type: "string" } }, additionalProperties: false },
      risk: "read",
      run: async (input) => run("page.find", { ...tabParam(input), ...(typeof input.text === "string" ? { text: input.text } : {}), ...(typeof input.label === "string" ? { label: input.label } : {}), ...(typeof input.role === "string" ? { role: input.role } : {}), limit: 20 }),
    },
    {
      name: "open_tab",
      origin: "browser",
      description: "Open an address in a new tab and wait for it to load.",
      input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
      risk: "act",
      plan: async (input) => {
        const u = webAddress(str(input, "url"));
        const known = (await openHosts()).has(u.host);
        return { summary: `Open ${short(u.href, 160)} in a new tab`, danger: !known, carriesData: true };
      },
      run: async (input) => run("tabs.new", { url: webAddress(str(input, "url")).href }),
    },
    {
      name: "go_to",
      origin: "browser",
      description: "Go to an address in a tab and wait for it to load.",
      input_schema: { type: "object", properties: { ...tabProp, url: { type: "string" } }, required: ["url"], additionalProperties: false },
      risk: "act",
      plan: async (input) => {
        const u = webAddress(str(input, "url"));
        const known = (await openHosts()).has(u.host);
        return { summary: `Go to ${short(u.href, 160)}`, danger: !known, safe: known, carriesData: true };
      },
      run: async (input) => run("page.goto", { ...tabParam(input), url: webAddress(str(input, "url")).href }),
    },
    {
      name: "back",
      origin: "browser",
      description: "Go back one page in a tab.",
      input_schema: { type: "object", properties: tabProp, additionalProperties: false },
      risk: "act",
      plan: async () => ({ summary: "Go back one page", safe: true }),
      run: async (input) => run("page.back", tabParam(input)),
    },
    {
      name: "switch_tab",
      origin: "browser",
      description: "Bring a tab to the front.",
      input_schema: { type: "object", properties: { tab: tabProp.tab }, required: ["tab"], additionalProperties: false },
      risk: "act",
      plan: async (input) => ({ summary: `Switch to tab ${String(input.tab)}`, safe: true }),
      run: async (input) => run("tabs.activate", tabParam(input)),
    },
    {
      name: "close_tab",
      origin: "browser",
      description: "Close a tab by its id from list_tabs. Use it to tidy up when the person asks; save what they want to keep first (save_bookmark).",
      input_schema: { type: "object", properties: { tab: tabProp.tab }, required: ["tab"], additionalProperties: false },
      risk: "act",
      plan: async (input) => {
        const tabs = (await run("tabs.list", {})) as Array<{ id: number; url: string; title: string }>;
        const t = tabs.find((x) => x.id === input.tab);
        if (!t) return { summary: "", refuse: `there is no tab ${String(input.tab)}; call list_tabs` };
        let host = t.url;
        try {
          host = new URL(t.url).host;
        } catch {
          /* keep the address */
        }
        return { summary: `Close tab “${short(t.title || host, 60)}” (${short(host, 40)})`, safe: true };
      },
      run: async (input) => run("tabs.close", tabParam(input)),
    },
    {
      name: "save_bookmark",
      origin: "browser",
      description: "Save a tab's page to the person's bookmarks (their saved links on askrobots). Leave out tab for the one they are looking at.",
      input_schema: { type: "object", properties: tabProp, additionalProperties: false },
      risk: "act",
      plan: async (input) => {
        const tabs = (await run("tabs.list", {})) as Array<{ id: number; url: string; title: string; active: boolean }>;
        const t = typeof input.tab === "number" ? tabs.find((x) => x.id === input.tab) : tabs.find((x) => x.active);
        if (!t) return { summary: "", refuse: "there is no such tab; call list_tabs" };
        if (!/^https?:\/\//i.test(t.url)) return { summary: "", refuse: "only web pages can be saved" };
        return { summary: `Save “${short(t.title || t.url, 60)}” to your bookmarks (${short(t.url, 80)})`, safe: true, carriesData: true };
      },
      run: async (input) => {
        const tabs = (await run("tabs.list", {})) as Array<{ id: number; url: string; title: string; active: boolean }>;
        const t = typeof input.tab === "number" ? tabs.find((x) => x.id === input.tab) : tabs.find((x) => x.active);
        if (!t) throw new Error("there is no such tab");
        const r = (await run("bookmarks.add", { url: t.url, title: t.title })) as { ok: boolean; already?: boolean; message?: string };
        if (!r.ok) throw new Error(r.message || "could not save it");
        return r.already ? "already in the bookmarks" : "saved";
      },
    },
    {
      name: "keep_tab",
      origin: "browser",
      description: "Keep a copy of a tab's page on this computer (what is on screen and its text), save it as a bookmark when connected, and close the tab. For tidying up without losing anything.",
      input_schema: { type: "object", properties: { ...tabProp, reason: { type: "string", description: "One line on why it was open, if the person said." } }, additionalProperties: false },
      risk: "act",
      plan: async (input) => {
        const tabs = (await run("tabs.list", {})) as Array<{ id: number; url: string; title: string; active: boolean }>;
        const t = typeof input.tab === "number" ? tabs.find((x) => x.id === input.tab) : tabs.find((x) => x.active);
        if (!t) return { summary: "", refuse: "there is no such tab; call list_tabs" };
        if (!/^https?:\/\//i.test(t.url)) return { summary: "", refuse: "only web pages can be kept" };
        return { summary: `Keep a copy of “${short(t.title || t.url, 60)}” and close the tab`, safe: true };
      },
      run: async (input) => {
        const r = (await run("keep.tab", { ...tabParam(input), ...(typeof input.reason === "string" ? { reason: input.reason } : {}) })) as { ok: boolean; message?: string; bookmarked?: boolean };
        if (!r.ok) throw new Error(r.message || "could not keep it");
        return r.bookmarked ? "kept, saved as a bookmark, and closed" : "kept and closed";
      },
    },
    {
      name: "card_view",
      origin: "browser",
      description:
        "Show a tab's posts as dense cards in a new tab of the browser's own, many at once, with promoted posts set aside. It works on sites that have a card view plugin installed (a view rule from gitstable; for X, askrobots/x-cards). The browser reads the posts itself and scrolls the tab a few screens to gather more; nothing is sent anywhere. Use it when the person wants to see more of a timeline at once, a card or grid view, or fewer ads.",
      input_schema: { type: "object", properties: { ...tabProp }, additionalProperties: false },
      risk: "act",
      plan: async (input) => {
        const tabs = (await run("tabs.list", {})) as Array<{ id: number; url: string; title: string; active: boolean }>;
        const t = typeof input.tab === "number" ? tabs.find((x) => x.id === input.tab) : tabs.find((x) => x.active);
        if (!t) return { summary: "", refuse: "there is no such tab; call list_tabs" };
        const views = ((await run("cards.for", { tab: t.id })) as { views: Array<{ id: string; name: string }> }).views;
        if (!views.length) return { summary: "", refuse: "no card view plugin is installed for this site; tell the person to look one up in Plugins (for X: askrobots/x-cards)" };
        return { summary: `Show the posts on “${short(t.title || t.url, 60)}” as cards with the ${views[0]!.name} plugin (it scrolls that tab a few screens)`, safe: true };
      },
      run: async (input) => {
        const r = (await run("cards.open", tabParam(input))) as { ok: boolean; message?: string; posts?: number; promoted?: number };
        if (!r.ok) throw new Error(r.message || "could not make a card view");
        return `opened ${r.posts} posts as cards in a new tab${r.promoted ? `, ${r.promoted} promoted set aside` : ""}`;
      },
    },
    {
      name: "click",
      origin: "browser",
      description: "Click a link, button, checkbox or radio button by its ref. A click that submits a form or is about buying, paying, deleting or sending is always asked about.",
      input_schema: { type: "object", properties: { ...tabProp, ...refProp }, required: ["ref"], additionalProperties: false },
      risk: "act",
      plan: async (input) => {
        const i = await info(input);
        const gone = needFound(i);
        if (gone) return { summary: "", refuse: gone };
        const words = `${i.text ?? ""} ${i.label ?? ""}`;
        const danger = i.submits === true || DANGER.test(words);
        const kind = i.tag === "a" ? "link" : i.tag === "button" || i.type === "submit" ? "button" : (i.type ?? i.tag ?? "element");
        // Safe to run unasked: a link to a site that is already open, a checkbox or radio button, a disclosure triangle.
        let toOpenSite = false;
        if (i.link) {
          try {
            toOpenSite = (await openHosts()).has(new URL(i.link).host);
          } catch {
            /* not an address */
          }
        }
        const safe = !danger && ((i.tag === "a" && toOpenSite) || i.type === "checkbox" || i.type === "radio" || i.tag === "summary");
        return { summary: `Click ${kind} “${nameOf(i)}”${i.submits ? " (submits the form)" : ""}${i.link ? ` → ${short(i.link, 100)}` : ""}`, danger, safe };
      },
      run: async (input) => run("page.click", { ...tabParam(input), ref: str(input, "ref") }),
    },
    {
      name: "type_text",
      origin: "browser",
      description: "Type into a text field by its ref. By default it replaces what is there. Never for password, card or code fields.",
      input_schema: { type: "object", properties: { ...tabProp, ...refProp, text: { type: "string" }, clear: { type: "boolean", description: "Replace the current value (default true)." } }, required: ["ref", "text"], additionalProperties: false },
      risk: "act",
      plan: async (input) => {
        const i = await info(input);
        const gone = needFound(i);
        if (gone) return { summary: "", refuse: gone };
        if (i.sensitive) return { summary: "", refuse: `“${nameOf(i)}” is a ${i.sensitive} field. I never fill those; the person has to type it themselves.` };
        return { summary: `Type “${short(String(input.text ?? ""), 80)}” into “${nameOf(i)}”`, safe: true, carriesData: true };
      },
      run: async (input) => run("page.type", { ...tabParam(input), ref: str(input, "ref"), text: String(input.text ?? ""), clear: input.clear !== false }),
    },
    {
      name: "choose",
      origin: "browser",
      description: "Choose an option in a dropdown by its ref and the option's value or words.",
      input_schema: { type: "object", properties: { ...tabProp, ...refProp, option: { type: "string" } }, required: ["ref", "option"], additionalProperties: false },
      risk: "act",
      plan: async (input) => {
        const i = await info(input);
        const gone = needFound(i);
        if (gone) return { summary: "", refuse: gone };
        if (i.sensitive) return { summary: "", refuse: `“${nameOf(i)}” is a ${i.sensitive} field.` };
        return { summary: `Choose “${short(str(input, "option"), 60)}” in “${nameOf(i)}”`, safe: true };
      },
      run: async (input) => {
        const r = (await run("page.eval", { js: CHOOSE_JS(str(input, "ref"), str(input, "option")), ...tabParam(input) })) as { value: { ok: boolean; why?: string; options?: string[]; chosen?: string } };
        if (!r.value.ok) throw new Error(r.value.why === "no-such-option" ? `no such option; the choices are: ${(r.value.options ?? []).join(", ")}` : `could not choose (${r.value.why})`);
        return { chosen: r.value.chosen };
      },
    },
    {
      name: "press_key",
      origin: "browser",
      description: `Press one key in the page: ${KEYS.join(", ")}. Enter is always asked about because it can submit a form.`,
      input_schema: { type: "object", properties: { ...tabProp, key: { type: "string", enum: KEYS } }, required: ["key"], additionalProperties: false },
      risk: "act",
      plan: async (input) => {
        const k = str(input, "key");
        if (!KEYS.includes(k)) return { summary: "", refuse: `only these keys can be pressed: ${KEYS.join(", ")}` };
        return { summary: k === "Enter" ? "Press Enter (this can submit a form)" : `Press ${k}`, danger: k === "Enter", safe: k !== "Enter" };
      },
      run: async (input) => run("page.press", { ...tabParam(input), key: str(input, "key") }),
    },
  ];
}
