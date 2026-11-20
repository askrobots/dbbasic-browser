import { createHash } from "node:crypto";
import { connect as tcpConnect } from "node:net";
import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { McpAuthError, McpClient, parseEventStream } from "../src/mcp-client";
import { OAuthError, REDIRECT_PORTS, authorizeUrl, discover, exchangeCode, listenForCode, newPkce, refreshTokens, register, revoke, type Fetch, type ServerMeta } from "../src/mcp-oauth";
import { DEFAULT_SERVERS, McpService, createStore, dropKeys, loadServerConfigs, parseServerConfigs, type McpServerConfig, type Store } from "../src/mcp-service";

type Handler = (url: URL, init: { method?: string; headers?: Record<string, string>; body?: string }) => { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };

/** A fetch that answers from a routing function, and remembers what it was asked. */
function fakeFetch(handler: Handler): Fetch & { calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> } {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
  const f = (async (url: string, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ?? "" });
    const r = handler(new URL(url), init);
    const status = r.status ?? 200;
    const text = r.text ?? JSON.stringify(r.json ?? {});
    const headers = new Map(Object.entries({ "content-type": r.text !== undefined ? "text/plain" : "application/json", ...(r.headers ?? {}) }).map(([k, v]) => [k.toLowerCase(), v]));
    return { ok: status >= 200 && status < 300, status, headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null }, text: async () => text };
  }) as Fetch & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const BASE = "https://mcp.example.com";
const META_DOCS: Handler = (u) => {
  if (u.pathname === "/.well-known/oauth-protected-resource") return { json: { resource: `${BASE}/api/mcp/`, authorization_servers: [BASE], scopes_supported: ["mcp"] } };
  if (u.pathname === "/.well-known/oauth-authorization-server")
    return { json: { issuer: BASE, authorization_endpoint: `${BASE}/o/authorize/`, token_endpoint: `${BASE}/o/token/`, registration_endpoint: `${BASE}/o/register/`, revocation_endpoint: `${BASE}/o/revoke_token/`, code_challenge_methods_supported: ["S256"] } };
  return { status: 404 };
};
const META: ServerMeta = { resource: `${BASE}/api/mcp/`, issuer: BASE, authorizationEndpoint: `${BASE}/o/authorize/`, tokenEndpoint: `${BASE}/o/token/`, registrationEndpoint: `${BASE}/o/register/`, revocationEndpoint: `${BASE}/o/revoke_token/`, scopes: ["mcp"] };

describe("finding out how to sign in", () => {
  it("follows the protected-resource document to the authorization server and its endpoints", async () => {
    const m = await discover(`${BASE}/api/mcp/`, fakeFetch(META_DOCS));
    expect(m).toMatchObject({ resource: `${BASE}/api/mcp/`, issuer: BASE, tokenEndpoint: `${BASE}/o/token/`, registrationEndpoint: `${BASE}/o/register/`, scopes: ["mcp"] });
  });

  it("refuses a server that cannot do PKCE with S256, or that publishes nothing", async () => {
    const noS256: Handler = (u, i) => (u.pathname.includes("authorization-server") ? { json: { authorization_endpoint: `${BASE}/a`, token_endpoint: `${BASE}/t`, code_challenge_methods_supported: ["plain"] } } : META_DOCS(u, i));
    await expect(discover(`${BASE}/api/mcp/`, fakeFetch(noS256))).rejects.toThrow(/S256/);
    await expect(discover(`${BASE}/api/mcp/`, fakeFetch(() => ({ status: 404 })))).rejects.toMatchObject({ code: "discovery" });
  });

  it("will not talk to plain http (except to this machine) or to an authorization server it was sent somewhere unsafe", async () => {
    await expect(discover("http://mcp.example.com/api/mcp/", fakeFetch(META_DOCS))).rejects.toMatchObject({ code: "unsafe" });
    const evil: Handler = (u, i) => (u.pathname.endsWith("protected-resource") ? { json: { resource: `${BASE}/api/mcp/`, authorization_servers: ["http://evil.example.com"] } } : META_DOCS(u, i));
    await expect(discover(`${BASE}/api/mcp/`, fakeFetch(evil))).rejects.toMatchObject({ code: "unsafe" });
    const sneaky: Handler = (u, i) => (u.pathname.includes("authorization-server") ? { json: { authorization_endpoint: "javascript:alert(1)", token_endpoint: `${BASE}/t` } } : META_DOCS(u, i));
    await expect(discover(`${BASE}/api/mcp/`, fakeFetch(sneaky))).rejects.toMatchObject({ code: "unsafe" });
  });

  it("registers a public client with every loopback redirect, and no secret", async () => {
    const f = fakeFetch(() => ({ status: 201, json: { client_id: "cid-1" } }));
    expect(await register(META, f, "dbbasic-browser")).toBe("cid-1");
    const sent = JSON.parse(f.calls[0]!.body);
    expect(sent).toMatchObject({ client_name: "dbbasic-browser", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] });
    expect(sent.redirect_uris).toEqual(REDIRECT_PORTS.map((p) => `http://127.0.0.1:${p}/callback`));
    await expect(register({ ...META, registrationEndpoint: undefined }, f, "x")).rejects.toMatchObject({ code: "registration" });
    await expect(register(META, fakeFetch(() => ({ status: 429, json: {} })), "x")).rejects.toThrow(/refused \(429\)/);
  });
});

describe("the authorization request", () => {
  it("makes a verifier and a matching S256 challenge, and puts everything in the address", () => {
    const { verifier, challenge } = newPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
    const u = new URL(authorizeUrl(META, "cid", "http://127.0.0.1:53682/callback", challenge, "st"));
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ response_type: "code", client_id: "cid", redirect_uri: "http://127.0.0.1:53682/callback", code_challenge: challenge, code_challenge_method: "S256", state: "st", scope: "mcp" });
    expect(newPkce().verifier).not.toBe(verifier);
  });
});

function get(port: number, path: string, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, headers: host ? { host } : {} }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
    r.on("error", reject);
    r.end();
  });
}

describe("the redirect listener", () => {
  it("takes the code only for the right state, and ignores stray requests", async () => {
    const cb = await listenForCode("right", { ports: [0] });
    expect(cb.redirectUri).toBe(`http://127.0.0.1:${cb.port}/callback`);
    expect(await get(cb.port, "/other")).toBe(404);
    expect(await get(cb.port, "/callback?code=x&state=wrong")).toBe(400);
    expect(await get(cb.port, "/callback?code=x&state=right", "evil.example.com")).toBe(404); // a rebinding page cannot finish it
    expect(await get(cb.port, "/callback?code=THE-CODE&state=right")).toBe(200);
    await expect(cb.code).resolves.toBe("THE-CODE");
  });

  it("reports a denial without reflecting anything into the page, and a cancel", async () => {
    const cb = await listenForCode("s", { ports: [0] });
    expect(await get(cb.port, "/callback?error=access_denied&state=s")).toBe(400);
    await expect(cb.code).rejects.toMatchObject({ code: "denied", message: "sign-in was declined" });
    const c2 = await listenForCode("s", { ports: [0] });
    c2.cancel();
    await expect(c2.code).rejects.toMatchObject({ code: "denied" });
  });

  it("times out, and moves to the next port when one is busy", async () => {
    const t = await listenForCode("s", { ports: [0], timeoutMs: 40 });
    await expect(t.code).rejects.toMatchObject({ code: "timeout" });
    const first = await listenForCode("s", { ports: [0] });
    const second = await listenForCode("s", { ports: [first.port, 0] });
    expect(second.port).not.toBe(first.port);
    first.cancel();
    second.cancel();
  });
});

describe("tokens", () => {
  it("trades a code for tokens, sending the verifier and no secret", async () => {
    const f = fakeFetch(() => ({ json: { access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "mcp" } }));
    const t = await exchangeCode(META, f, { clientId: "cid", code: "c", verifier: "v", redirect: "http://127.0.0.1:53682/callback" }, 1_000);
    expect(t).toEqual({ access: "AT", refresh: "RT", expiresAt: 1_000 + 3_600_000, scope: "mcp" });
    const body = new URLSearchParams(f.calls[0]!.body);
    expect(Object.fromEntries(body)).toMatchObject({ grant_type: "authorization_code", code: "c", code_verifier: "v", client_id: "cid", redirect_uri: "http://127.0.0.1:53682/callback" });
    expect(body.has("client_secret")).toBe(false);
  });

  it("explains a refusal without echoing the server's text, and needs an access token", async () => {
    await expect(exchangeCode(META, fakeFetch(() => ({ status: 400, json: { error: "invalid_grant" } })), { clientId: "c", code: "c", verifier: "v", redirect: "r" })).rejects.toThrow(/refused \(400: invalid_grant\)/);
    await expect(exchangeCode(META, fakeFetch(() => ({ json: {} })), { clientId: "c", code: "c", verifier: "v", redirect: "r" })).rejects.toThrow(/no access token/);
  });

  it("keeps the old refresh token when a refresh does not send a new one", async () => {
    const f = fakeFetch(() => ({ json: { access_token: "AT2", expires_in: 60 } }));
    expect(await refreshTokens(META, f, { clientId: "c", refresh: "RT" }, 0)).toEqual({ access: "AT2", refresh: "RT", expiresAt: 60_000 });
    const g = fakeFetch(() => ({ json: { access_token: "AT3", refresh_token: "RT2" } }));
    expect((await refreshTokens(META, g, { clientId: "c", refresh: "RT" }, 0)).refresh).toBe("RT2");
  });

  it("revokes best-effort and never throws", async () => {
    expect(await revoke(META, fakeFetch(() => ({ status: 200 })), "c", "t")).toBe(true);
    expect(await revoke(META, fakeFetch(() => ({ status: 500 })), "c", "t")).toBe(false);
    expect(await revoke({ ...META, revocationEndpoint: undefined }, fakeFetch(() => ({})), "c", "t")).toBe(false);
  });
});

describe("the MCP client", () => {
  const rpc = (result: unknown, id = 1) => ({ jsonrpc: "2.0", id, result });

  it("starts a session, sends the token, and lists tools across pages", async () => {
    let n = 0;
    const f = fakeFetch((_u, init) => {
      const b = JSON.parse(init.body ?? "{}");
      if (b.method === "initialize") return { json: rpc({}, b.id), headers: { "mcp-session-id": "S1" } };
      if (b.method === "notifications/initialized") return { status: 202, text: "" };
      if (b.method === "tools/list") return { json: rpc(n++ === 0 ? { tools: [{ name: "a" }], nextCursor: "p2" } : { tools: [{ name: "b", description: "B", inputSchema: { type: "object" } }] }, b.id) };
      return { status: 400 };
    });
    const c = new McpClient("https://mcp.example.com/api/mcp/", async () => "TOKEN", f);
    expect((await c.listTools()).map((t) => t.name)).toEqual(["a", "b"]);
    expect(f.calls.every((x) => x.headers.authorization === "Bearer TOKEN")).toBe(true);
    expect(f.calls.filter((x) => x.headers["mcp-session-id"] === "S1").length).toBeGreaterThanOrEqual(3); // later calls carry the session
    expect(f.calls.filter((x) => JSON.parse(x.body).method === "initialize").length).toBe(1);
  });

  it("reads an event-stream reply and joins the text of a tool result", async () => {
    expect(parseEventStream('event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"x":1}}\n\n', 3)).toMatchObject({ result: { x: 1 } });
    expect(parseEventStream('data: {"id":9}\n\n', 3)).toBeNull();
    const f = fakeFetch((_u, init) => {
      const b = JSON.parse(init.body ?? "{}");
      if (b.method === "tools/call") return { text: `data: ${JSON.stringify(rpc({ content: [{ type: "text", text: "one" }, { type: "image" }, { type: "text", text: "two" }], isError: false }, b.id))}\n\n`, headers: { "content-type": "text/event-stream" } };
      return { json: rpc({}, b.id) };
    });
    const r = await new McpClient("https://x.example/mcp", async () => "T", f).callTool("t", { a: 1 });
    expect(r).toEqual({ text: "one\n[image not shown]\ntwo", isError: false });
  });

  it("a 401, or the server's own 'authentication required', is an auth error; other errors are plain errors", async () => {
    await expect(new McpClient("https://x.example/mcp", async () => "T", fakeFetch(() => ({ status: 401, json: {} }))).listTools()).rejects.toBeInstanceOf(McpAuthError);
    const f = fakeFetch((_u, init) => ({ json: { jsonrpc: "2.0", id: JSON.parse(init.body ?? "{}").id, error: { code: -32000, message: "Authentication required" } } }));
    await expect(new McpClient("https://x.example/mcp", async () => "T", f).listTools()).rejects.toBeInstanceOf(McpAuthError);
    const g = fakeFetch((_u, init) => ({ json: { jsonrpc: "2.0", id: JSON.parse(init.body ?? "{}").id, error: { code: -32602, message: "bad arguments" } } }));
    await expect(new McpClient("https://x.example/mcp", async () => "T", g).listTools()).rejects.toThrow("bad arguments");
  });
});

// ---- the service, against one fake server that does OAuth and MCP ---------------------------------------------

const SERVER: McpServerConfig = {
  id: "demo", name: "Demo", url: `${BASE}/api/mcp/`,
  tools: ["read_thing", "write_thing", "get_person"],
  readOnly: ["read_thing", "get_person"],
  fixedArgs: { write_thing: { project_id: "P-1" } },
  dropFields: { get_person: ["notes"] },
};

function fakeServer() {
  const st = { clock: 1_000_000, issued: 0, refreshed: 0, revoked: 0, registered: 0, lastArgs: null as Record<string, unknown> | null, badRefresh: false, expireAccess: false };
  const f = fakeFetch((u, init) => {
    const meta = META_DOCS(u, init);
    if (meta.status !== 404) return meta;
    if (u.pathname === "/o/register/") return (st.registered++, { status: 201, json: { client_id: "cid-" + st.registered } });
    if (u.pathname === "/o/token/") {
      const b = new URLSearchParams(init.body);
      if (b.get("grant_type") === "refresh_token") {
        if (st.badRefresh) return { status: 400, json: { error: "invalid_grant" } };
        st.refreshed++;
        return { json: { access_token: `AT-r${st.refreshed}`, expires_in: 3600 } };
      }
      st.issued++;
      return { json: { access_token: `AT-${st.issued}`, refresh_token: "RT-1", expires_in: 3600 } };
    }
    if (u.pathname === "/o/revoke_token/") return (st.revoked++, { status: 200, text: "" });
    if (u.pathname === "/api/mcp/") {
      if (st.expireAccess || !/^Bearer AT-/.test(init.headers?.authorization ?? "")) return { status: 401, json: {} };
      const b = JSON.parse(init.body ?? "{}");
      if (b.method === "initialize") return { json: { jsonrpc: "2.0", id: b.id, result: {} } };
      if (b.method === "notifications/initialized") return { status: 202, text: "" };
      if (b.method === "tools/list")
        return { json: { jsonrpc: "2.0", id: b.id, result: { tools: [
          { name: "read_thing", description: "Read a thing", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
          { name: "write_thing", description: "Write a thing", inputSchema: { type: "object", properties: { title: { type: "string" }, project_id: { type: "string" } }, required: ["title", "project_id"] } },
          { name: "get_person", description: "Get a person", inputSchema: { type: "object" } },
          { name: "delete_everything", description: "Not allowed", inputSchema: { type: "object" } },
        ] } } };
      if (b.method === "tools/call") {
        st.lastArgs = b.params.arguments;
        const text = b.params.name === "get_person" ? JSON.stringify({ name: "Ada", notes: "secret notes", nested: [{ notes: "more", ok: 1 }] }) : "done";
        return { json: { jsonrpc: "2.0", id: b.id, result: { content: [{ type: "text", text }] } } };
      }
    }
    return { status: 404 };
  });
  return { f, st };
}

function memStore(): Store & { text: string | null } {
  const s = { persistent: true, text: null as string | null, load: () => s.text, save: (t: string | null) => void (s.text = t) };
  return s;
}

async function signIn(svc: McpService, id = "demo") {
  const r = await svc.connect(id, { open: false });
  const u = new URL(r.authorizeUrl);
  const redirect = u.searchParams.get("redirect_uri") as string;
  const res = await fetch(`${redirect}?code=CODE&state=${u.searchParams.get("state")}`);
  expect(res.status).toBe(200);
  await r.done;
  return u;
}

function setup(over: { caller?: () => boolean; now?: () => number } = {}) {
  const { f, st } = fakeServer();
  const store = memStore();
  const announced: Array<Record<string, unknown>> = [];
  const svc = new McpService({ fetch: f, store, servers: [SERVER], openExternal: () => {}, callerNetworkOn: over.caller ?? (() => false), announce: (e) => announced.push(e), now: over.now ?? (() => st.clock) });
  return { svc, f, st, store, announced };
}

describe("signing in and using a server's tools", () => {
  it("signs in with PKCE through a loopback redirect and keeps the tokens out of state()", async () => {
    const { svc, st, store, announced } = setup();
    expect(svc.state()[0]).toMatchObject({ id: "demo", signedIn: false, connecting: false });
    const u = await signIn(svc);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(svc.state()[0]).toMatchObject({ signedIn: true, connecting: false });
    expect(JSON.stringify(svc.state())).not.toMatch(/AT-|RT-/);
    expect(st.registered).toBe(1);
    expect(store.text).toMatch(/AT-1/); // saved (here unencrypted, because the test store is)
    expect(announced.some((e) => e.kind === "mcp-signed-in")).toBe(true);
    await signIn(svc); // signing in again reuses the registration
    expect(st.registered).toBe(1);
  });

  it("remembers a sign-in across a restart", async () => {
    const a = setup();
    await signIn(a.svc);
    const b = new McpService({ fetch: a.f, store: a.store, servers: [SERVER], openExternal: () => {}, callerNetworkOn: () => false, announce: () => {}, now: () => a.st.clock });
    expect(b.state()[0]?.signedIn).toBe(true);
    expect((await b.toolDefs()).length).toBe(3);
  });

  it("gives the assistant only the allowed tools, hides fixed arguments, and asks about every tool that writes", async () => {
    const { svc } = setup();
    await signIn(svc);
    const tools = await svc.toolDefs();
    expect(tools.map((t) => t.name)).toEqual(["demo__read_thing", "demo__write_thing", "demo__get_person"]);
    const w = tools.find((t) => t.name === "demo__write_thing")!;
    expect(w.risk).toBe("act");
    expect(Object.keys((w.input_schema as { properties: object }).properties)).toEqual(["title"]);
    expect((w.input_schema as { required: string[] }).required).toEqual(["title"]);
    const plan = await w.plan!({ title: "x" });
    expect(plan.danger).toBe(true); // asked about even in Auto mode
    expect(plan.summary).toMatch(/Ask Demo to write_thing .*"project_id":"P-1"/);
    expect(tools.find((t) => t.name === "demo__read_thing")!.risk).toBe("read");
  });

  it("forces the fixed arguments whatever the model sends, and drops the named fields from results", async () => {
    const { svc, st } = setup();
    await signIn(svc);
    const tools = await svc.toolDefs();
    await tools.find((t) => t.name === "demo__write_thing")!.run({ title: "t", project_id: "SOMEONE-ELSES" });
    expect(st.lastArgs).toEqual({ title: "t", project_id: "P-1" });
    const person = (await tools.find((t) => t.name === "demo__get_person")!.run({})) as string;
    expect(JSON.parse(person)).toEqual({ name: "Ada", nested: [{ ok: 1 }] });
    expect(dropKeys("not json", ["notes"])).toBe("not json");
  });

  it("refreshes the access token shortly before it expires, once, and keeps working", async () => {
    const { svc, st } = setup();
    await signIn(svc);
    st.clock += 3_600_000 - 30_000; // 30 s left: inside the 60 s margin
    const [a, b] = await Promise.all([svc.token("demo"), svc.token("demo")]);
    expect(a).toBe("AT-r1");
    expect(b).toBe("AT-r1");
    expect(st.refreshed).toBe(1);
    expect(await svc.token("demo")).toBe("AT-r1");
  });

  it("refreshNow refreshes at once and says whether the server rotated the refresh token, without showing any token", async () => {
    const { svc, st } = setup();
    await signIn(svc);
    const r = await svc.refreshNow("demo");
    expect(r).toEqual({ ok: true, rotated: false, expiresInSeconds: 3600 }); // this server keeps the old refresh token
    expect(st.refreshed).toBe(1);
    expect(JSON.stringify(r)).not.toMatch(/AT-|RT-/);
    st.badRefresh = true;
    expect(await svc.refreshNow("demo")).toMatchObject({ ok: false, message: expect.stringMatching(/refused \(400/) });
    expect(await setup().svc.refreshNow("demo")).toMatchObject({ ok: false, message: expect.stringMatching(/not signed in/) });
  });

  it("a refresh the server refuses signs you out, and says so", async () => {
    const { svc, st } = setup();
    await signIn(svc);
    st.clock += 4_000_000;
    st.badRefresh = true;
    await expect(svc.token("demo")).rejects.toBeInstanceOf(McpAuthError);
    expect(svc.state()[0]).toMatchObject({ signedIn: false, error: expect.stringMatching(/signed out/) });
  });

  it("a server that stops accepting the token tells the model to ask the person to connect again", async () => {
    const { svc, st } = setup();
    await signIn(svc);
    const tools = await svc.toolDefs();
    st.expireAccess = true;
    await expect(tools[0]!.run({})).rejects.toThrow(/fresh sign-in/);
  });

  it("disconnecting forgets the tokens and asks the server to revoke them", async () => {
    const { svc, st, store } = setup();
    await signIn(svc);
    expect(await svc.disconnect("demo")).toEqual({ revoked: true });
    expect(st.revoked).toBe(1);
    expect(svc.state()[0]?.signedIn).toBe(false);
    expect(store.text).not.toMatch(/AT-1/);
    expect(await svc.toolDefs()).toEqual([]);
  });

  it("is off while the caller network is on", async () => {
    let on = false;
    const { svc } = setup({ caller: () => on });
    await signIn(svc);
    on = true;
    expect(await svc.toolDefs()).toEqual([]);
    await expect(svc.connect("demo", { open: false })).rejects.toThrow(/caller network/);
  });

  it("cancelling a sign-in ends it, with the reason kept for the panel", async () => {
    const { svc } = setup();
    const r = await svc.connect("demo", { open: false });
    expect(svc.state()[0]?.connecting).toBe(true);
    svc.cancelConnect("demo");
    await expect(r.done).rejects.toBeInstanceOf(OAuthError);
    expect(svc.state()[0]).toMatchObject({ connecting: false, signedIn: false, error: "sign-in was cancelled" });
  });
});

describe("signing in inside the browser's own tab", () => {
  /** A browser that, given the consent address, "approves" and lets the redirect arrive at the service, as the browser's request layer does. */
  function inTab(over: { approve?: boolean; error?: string } = {}) {
    const { f, st } = fakeServer();
    const opened: string[] = [];
    const closed: number[] = [];
    let svc!: McpService;
    svc = new McpService({
      fetch: f, store: memStore(), servers: [SERVER], callerNetworkOn: () => false, announce: () => {}, now: () => st.clock,
      openExternal: () => { throw new Error("the system browser must not be used"); },
      openTab: async (url) => {
        opened.push(url);
        if (over.approve === false) return 7;
        const u = new URL(url);
        const back = new URL(u.searchParams.get("redirect_uri") as string);
        if (over.error) back.searchParams.set("error", over.error);
        else back.searchParams.set("code", "CODE");
        back.searchParams.set("state", u.searchParams.get("state") as string);
        queueMicrotask(() => { caught = svc.captureRedirect(back.href); });
        return 7;
      },
      closeTab: async (id) => void closed.push(id),
    });
    let caught: ReturnType<McpService["captureRedirect"]> = null;
    return { svc, st, opened, closed, caught: () => caught };
  }
  const portOpen = (port: number) => new Promise<boolean>((resolve) => { const s = tcpConnect({ host: "127.0.0.1", port }, () => (s.destroy(), resolve(true))); s.on("error", () => resolve(false)); });

  it("opens the consent page in a tab, catches the redirect itself, closes the tab, and never listens on a port", async () => {
    const t = inTab();
    const r = await t.svc.connect("demo");
    expect(t.opened).toHaveLength(1);
    expect(new URL(t.opened[0] as string).searchParams.get("redirect_uri")).toBe("http://127.0.0.1:53682/callback");
    expect(await portOpen(53682)).toBe(false); // nothing is listening: the redirect is recognised, not received
    await r.done;
    expect(t.svc.state()[0]).toMatchObject({ signedIn: true, connecting: false });
    expect(t.closed).toEqual([7]);
    expect(t.caught()).toMatchObject({ status: 200 });
    expect(t.caught()?.html).toMatch(/signed in/i);
    expect(await t.svc.token("demo")).toMatch(/^AT-/);
  });

  it("only the exact redirect with the right secret state is taken; anything else is an ordinary request", async () => {
    const t = inTab({ approve: false });
    const r = await t.svc.connect("demo");
    const u = new URL(t.opened[0] as string);
    const state = u.searchParams.get("state") as string;
    expect(t.svc.captureRedirect(`http://127.0.0.1:53682/callback?code=x&state=wrong`)).toBeNull();
    expect(t.svc.captureRedirect(`http://127.0.0.1:53682/other?code=x&state=${state}`)).toBeNull();
    expect(t.svc.captureRedirect(`http://evil.example:53682/callback?code=x&state=${state}`)).toBeNull();
    expect(t.svc.captureRedirect(`http://127.0.0.1:53683/callback?code=x&state=${state}`)).toBeNull();
    expect(t.svc.state()[0]?.connecting).toBe(true);
    expect(t.svc.captureRedirect(`http://127.0.0.1:53682/callback?code=ok&state=${state}`)).toMatchObject({ status: 200 });
    await r.done;
    expect(t.svc.captureRedirect(`http://127.0.0.1:53682/callback?code=again&state=${state}`)).toBeNull(); // single use
  });

  it("a declined approval, a cancel and a timeout all end the sign-in, close the tab, and say why", async () => {
    const declined = inTab({ error: "access_denied" });
    const r = await declined.svc.connect("demo");
    await expect(r.done).rejects.toMatchObject({ code: "denied", message: "sign-in was declined" });
    expect(declined.closed).toEqual([7]);
    expect(declined.caught()).toMatchObject({ status: 400 });

    const cancelled = inTab({ approve: false });
    const c = await cancelled.svc.connect("demo");
    cancelled.svc.cancelConnect("demo");
    await expect(c.done).rejects.toMatchObject({ message: "sign-in was cancelled" });
    expect(cancelled.closed).toEqual([7]);

    const { f, st } = fakeServer();
    const slow = new McpService({ fetch: f, store: memStore(), servers: [SERVER], callerNetworkOn: () => false, announce: () => {}, now: () => st.clock, openExternal: () => {}, openTab: async () => 9, closeTab: async () => {}, timeoutMs: 30 });
    const t = await slow.connect("demo");
    await expect(t.done).rejects.toMatchObject({ code: "timeout" });
    expect(slow.captureRedirect("http://127.0.0.1:53682/callback?code=late&state=x")).toBeNull();
  });

  it("asks for extra permissions the server does not publish; an older server that refuses them is asked again without", async () => {
    for (const knows of [true, false]) {
      const opened: string[] = [];
      const regs: string[] = [];
      let granted = "";
      let svc!: McpService;
      const f = fakeFetch((u, init) => {
        const meta = META_DOCS(u, init);
        if (meta.status !== 404) return meta;
        if (u.pathname === "/o/register/") return (regs.push(JSON.parse(init.body ?? "{}").scope), { status: 201, json: { client_id: "cid-" + regs.length } });
        if (u.pathname === "/o/token/") return { json: { access_token: "AT-x", refresh_token: "RT", expires_in: 3600, scope: granted } };
        return { status: 404, json: {} };
      });
      svc = new McpService({
        fetch: f, store: memStore(), servers: [{ ...SERVER, extraScopes: ["files:upload"] }], callerNetworkOn: () => false, announce: () => {}, now: () => 1,
        openExternal: () => { throw new Error("no"); },
        openTab: async (url) => {
          opened.push(url);
          const a = new URL(url);
          const want = (a.searchParams.get("scope") ?? "").split(" ");
          const back = new URL(a.searchParams.get("redirect_uri") as string);
          if (!knows && want.includes("files:upload")) back.searchParams.set("error", "invalid_scope");
          else (back.searchParams.set("code", "C"), (granted = want.join(" ")));
          back.searchParams.set("state", a.searchParams.get("state") as string);
          queueMicrotask(() => svc.captureRedirect(back.href));
          return opened.length;
        },
        closeTab: async () => {},
      });
      await (await svc.connect("demo")).done;
      expect(new URL(opened[0] as string).searchParams.get("scope")).toBe("mcp files:upload");
      expect(svc.state()[0]).toMatchObject({ signedIn: true });
      if (knows) {
        expect(opened).toHaveLength(1);
        expect(regs).toEqual(["mcp files:upload"]);
        expect(svc.missingScopes("demo")).toEqual([]);
        expect(svc.state()[0]?.missingScopes).toBeUndefined();
      } else {
        expect(opened).toHaveLength(2); // asked once more, without the extra
        expect(new URL(opened[1] as string).searchParams.get("scope")).toBe("mcp");
        expect(svc.state()[0]?.error).toBeUndefined();
        expect(svc.missingScopes("demo")).toEqual(["files:upload"]);
        expect(svc.state()[0]?.missingScopes).toEqual(["files:upload"]);
      }
    }
  });

  it("a sign-in from before an extra permission was asked for registers again, and keeps working until the new one is done", async () => {
    const { f, st } = fakeServer();
    const store = memStore();
    const old = new McpService({ fetch: f, store, servers: [SERVER], callerNetworkOn: () => false, announce: () => {}, now: () => st.clock, openExternal: () => {} });
    await signIn(old);
    expect(st.registered).toBe(1);
    let svc!: McpService;
    svc = new McpService({
      fetch: f, store, servers: [{ ...SERVER, extraScopes: ["files:upload"] }], callerNetworkOn: () => false, announce: () => {}, now: () => st.clock, openExternal: () => {},
      openTab: async () => 3, closeTab: async () => {},
    });
    const r = await svc.connect("demo");
    expect(st.registered).toBe(2); // the permissions changed
    expect(await svc.token("demo")).toMatch(/^AT-/); // the old sign-in still works while the new one waits
    svc.cancelConnect("demo");
    await expect(r.done).rejects.toBeInstanceOf(OAuthError);
    expect(svc.state()[0]?.signedIn).toBe(true);
    expect(JSON.parse(store.text as string).servers.demo.clientId).toBe("cid-1"); // and the new client was not kept
  });

  it("nothing is expected when no sign-in is waiting, and scripts can still ask for the address only", async () => {
    const t = inTab();
    expect(t.svc.captureRedirect("http://127.0.0.1:53682/callback?code=a&state=b")).toBeNull();
    const r = await t.svc.connect("demo", { open: false }); // "none": the listener, not a tab
    expect(t.opened).toHaveLength(0);
    expect(new URL(r.authorizeUrl).searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    t.svc.cancelConnect("demo");
    await expect(r.done).rejects.toBeInstanceOf(OAuthError);
  });
});

describe("where tokens are kept, and which servers there are", () => {
  it("writes tokens to disk only when the system can encrypt them, and never as plain text", () => {
    const disk = new Map<string, Buffer>();
    const files = { read: (p: string) => disk.get(p) ?? null, write: (p: string, b: Buffer | null) => void (b ? disk.set(p, b) : disk.delete(p)) };
    const enc = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s.split("").reverse().join("")), decryptString: (b: Buffer) => b.toString().split("").reverse().join("") };
    const s = createStore("/x", enc, files);
    s.save("secret-token");
    expect(disk.get("/x")!.toString()).not.toContain("secret-token");
    expect(s.load()).toBe("secret-token");
    s.save(null);
    expect(disk.size).toBe(0);
    const mem = createStore("/y", { ...enc, isEncryptionAvailable: () => false }, files);
    mem.save("kept in memory");
    expect(mem.persistent).toBe(false);
    expect(mem.load()).toBe("kept in memory");
    expect(disk.size).toBe(0);
  });

  it("never touches the keychain until it must: no file means nothing is decrypted, and the service reads nothing at start-up", () => {
    const calls: string[] = [];
    const enc = { isEncryptionAvailable: () => (calls.push("available"), true), encryptString: (s: string) => (calls.push("encrypt"), Buffer.from(s)), decryptString: (b: Buffer) => (calls.push("decrypt"), b.toString()) };
    const disk = new Map<string, Buffer>();
    const files = { read: (p: string) => disk.get(p) ?? null, write: (p: string, b: Buffer | null) => void (b ? disk.set(p, b) : disk.delete(p)) };
    const store = createStore("/x", enc, files);
    expect(store.load()).toBeNull(); // no file yet
    expect(calls).toEqual([]);
    const { f } = fakeServer();
    const svc = new McpService({ fetch: f, store, servers: [SERVER], openExternal: () => {}, callerNetworkOn: () => false, announce: () => {} });
    expect(calls).toEqual([]); // constructing the service reads nothing
    expect(svc.state()[0]).toMatchObject({ signedIn: false, persistent: true });
    expect(calls).toEqual([]); // and neither does showing the state when nobody is signed in
    store.save("secret"); // a first sign-in is where it reaches the keychain
    expect(calls).toEqual(["available", "encrypt"]);
    expect(store.load()).toBe("secret");
    expect(calls).toEqual(["available", "encrypt", "decrypt"]);
  });

  it("reads extra servers from a file, skips bad entries and says why, and lets an entry replace the built-in one", () => {
    const good = { id: "notes", name: "Notes", url: "https://notes.example/mcp", tools: ["list", "add"], readOnly: ["list"] };
    const r = parseServerConfigs(JSON.stringify([good, { id: "Bad Id", name: "x", url: "https://a.example" }, { ...good, id: "plain", url: "http://notes.example/mcp" }, { ...good, id: "ro", readOnly: ["nope"] }, { ...good, id: "empty", tools: [] }]));
    expect(r.servers.map((s) => s.id)).toEqual(["notes"]);
    expect(r.problems.length).toBe(4);
    expect(parseServerConfigs("not json").problems[0]).toMatch(/not valid JSON/);
    expect(parseServerConfigs(JSON.stringify([{ ...good, url: "http://127.0.0.1:9/mcp" }])).servers.length).toBe(1);
    expect(parseServerConfigs(JSON.stringify([{ ...good, extraScopes: ["files:upload"] }])).servers[0]?.extraScopes).toEqual(["files:upload"]);
    expect(parseServerConfigs(JSON.stringify([{ ...good, extraScopes: ["two words"] }])).servers).toEqual([]);
    const merged = loadServerConfigs("/f", () => JSON.stringify([{ ...good, id: "askrobots", name: "Mine" }])).servers;
    expect(merged.find((s) => s.id === "askrobots")?.name).toBe("Mine");
    expect(merged.find((s) => s.id === "askrobots")?.extraScopes).toEqual(["files:upload"]); // a built-in permission is kept
    expect(loadServerConfigs("/f", () => JSON.stringify([{ ...good, id: "askrobots", extraScopes: [] }])).servers.find((s) => s.id === "askrobots")?.extraScopes).toEqual([]); // unless the entry says otherwise
    expect(loadServerConfigs(undefined).servers).toEqual(DEFAULT_SERVERS);
    expect(loadServerConfigs("/missing", () => { throw new Error("ENOENT"); }).servers).toEqual(DEFAULT_SERVERS);
  });

  it("the built-in askrobots entry reads, saves links as private, names no one's project, and drops contact notes", () => {
    const a = DEFAULT_SERVERS.find((s) => s.id === "askrobots")!;
    expect(a.url).toBe("https://askrobots.com/api/mcp/");
    expect(a.readOnly.every((t) => a.tools.includes(t))).toBe(true);
    expect(a.tools.filter((t) => !a.readOnly.includes(t))).toEqual(["create_link"]); // the only write the assistant gets
    expect(a.browserOnly).toEqual(["upload_file"]); // the browser's own (kept copies), never offered to the assistant
    expect(a.fixedArgs?.upload_file).toEqual({ is_public: false, category: "browser/kept" });
    expect(a.fixedArgs?.create_link).toEqual({ is_public: false });
    expect(JSON.stringify(DEFAULT_SERVERS)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/); // no personal ids in the shipped defaults
    expect(a.dropFields?.get_contact).toEqual(["notes", "interactions"]);
    expect(a.extraScopes).toEqual(["files:upload"]); // saving kept pages in Files is its own permission
  });
});
