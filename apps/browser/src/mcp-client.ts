/**
 * A small client for MCP servers over HTTP (the "streamable HTTP" transport): JSON-RPC in a POST, answered either as
 * JSON or as a short event stream. It lists a server's tools and calls them; that is all the chat needs.
 * Main process only. The access token comes from `getToken` on every request, so a refresh in between is picked up.
 */

import type { Fetch } from "./mcp-oauth.js";

export class McpAuthError extends Error {
  constructor(message = "the server wants a fresh sign-in") {
    super(message);
    this.name = "McpAuthError";
  }
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** The server's own hints (MCP tool annotations). Hints only: what a tool may do is still decided here, not by them. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}
export interface McpResult {
  text: string;
  isError: boolean;
}

const PROTOCOL = "2025-03-26";
const MAX_RESPONSE = 4_000_000;

/** Pick the JSON-RPC reply with our id out of a text/event-stream body. */
export function parseEventStream(body: string, id: number): Record<string, unknown> | null {
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      const j = JSON.parse(data) as Record<string, unknown>;
      if (j.id === id) return j;
    } catch {
      /* not JSON: skip */
    }
  }
  return null;
}

export class McpClient {
  private nextId = 1;
  private session: string | null = null;
  private ready = false;

  constructor(
    private url: string,
    private getToken: () => Promise<string>,
    private f: Fetch,
    private info = { name: "dbbasic-browser", version: "1" },
  ) {}

  private async post(body: Record<string, unknown>, expectReply: boolean): Promise<Record<string, unknown> | null> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${await this.getToken()}`,
      "mcp-protocol-version": PROTOCOL,
      ...(this.session ? { "mcp-session-id": this.session } : {}),
    };
    const res = await this.f(this.url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    if (res.status === 401) throw new McpAuthError();
    if (res.status === 404 && this.session) {
      this.session = null;
      this.ready = false;
      throw new Error("the server forgot this session; try again");
    }
    const text = await res.text();
    if (text.length > MAX_RESPONSE) throw new Error("the server's reply is too large");
    if (!res.ok) throw new Error(`the server answered ${res.status}`);
    if (!expectReply) return null;
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    const j = type.includes("text/event-stream") ? parseEventStream(text, body.id as number) : (JSON.parse(text) as Record<string, unknown>);
    if (!j) throw new Error("the server sent no reply");
    return j;
  }

  private async rpc(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await this.init();
    return this.call(method, params);
  }

  private async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const j = (await this.post({ jsonrpc: "2.0", id, method, params }, true)) as Record<string, unknown>;
    const err = j.error as { message?: string; code?: number } | undefined;
    if (err) {
      if (err.code === -32000 && /authenticat/i.test(String(err.message))) throw new McpAuthError();
      throw new Error(String(err.message ?? "the server returned an error").slice(0, 300));
    }
    return (j.result ?? {}) as Record<string, unknown>;
  }

  private async init(): Promise<void> {
    if (this.ready) return;
    await this.call("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: this.info });
    this.ready = true;
    try {
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, false);
    } catch (e) {
      if (e instanceof McpAuthError) throw e; // anything else about this courtesy message is not worth failing for
    }
  }

  async listTools(): Promise<McpTool[]> {
    const out: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.rpc("tools/list", cursor ? { cursor } : {});
      const tools = Array.isArray(r.tools) ? (r.tools as Array<Record<string, unknown>>) : [];
      for (const t of tools) {
        if (typeof t.name !== "string") continue;
        const a = t.annotations && typeof t.annotations === "object" ? (t.annotations as Record<string, unknown>) : null;
        const annotations = a ? { ...(typeof a.readOnlyHint === "boolean" ? { readOnlyHint: a.readOnlyHint } : {}), ...(typeof a.destructiveHint === "boolean" ? { destructiveHint: a.destructiveHint } : {}) } : null;
        out.push({ name: t.name, ...(typeof t.description === "string" ? { description: t.description } : {}), ...(t.inputSchema && typeof t.inputSchema === "object" ? { inputSchema: t.inputSchema as Record<string, unknown> } : {}), ...(annotations && Object.keys(annotations).length ? { annotations } : {}) });
      }
      cursor = typeof r.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpResult> {
    const r = await this.rpc("tools/call", { name, arguments: args });
    const content = Array.isArray(r.content) ? (r.content as Array<Record<string, unknown>>) : [];
    const parts = content.map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : `[${String(c.type ?? "content")} not shown]`));
    if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
    return { text: parts.join("\n"), isError: r.isError === true };
  }
}
