import { describe, expect, it } from "vitest";
import type { X402Engine } from "@dbbasic/x402-engine";
import { bypassingFetch, createPaymentHandler, topOriginOf } from "../src/intercept.js";

describe("topOriginOf", () => {
  it("uses the referrer origin so subresources are billed to their page", () => {
    const req = new Request("https://cdn.paid.example/img.png", {
      headers: { referer: "https://reader.example/article?x=1" },
    });
    expect(topOriginOf(req)).toBe("https://reader.example");
  });

  it("returns empty for a top-level navigation (its own budget scope)", () => {
    const req = new Request("https://reader.example/");
    expect(topOriginOf(req)).toBe("");
  });

  it("ignores about:client and malformed referrers", () => {
    const req = new Request("https://x.example/", { headers: { referer: "not-a-url" } });
    expect(topOriginOf(req)).toBe("");
  });
});

describe("createPaymentHandler", () => {
  it("routes the request through the engine with the derived topOrigin", async () => {
    const seen: { url: string; topOrigin: string }[] = [];
    const fakeEngine = {
      fetch: async (request: Request, topOrigin: string) => {
        seen.push({ url: request.url, topOrigin });
        return { response: new Response("paid body", { status: 200 }) };
      },
    } as unknown as X402Engine;

    const handler = createPaymentHandler(fakeEngine);
    const req = new Request("https://api.paid.example/data", {
      headers: { referer: "https://app.example/dashboard" },
    });
    const res = await handler(req);

    expect(await res.text()).toBe("paid body");
    expect(seen).toEqual([{ url: "https://api.paid.example/data", topOrigin: "https://app.example" }]);
  });
});

describe("bypassingFetch", () => {
  it("delegates to the provided bypassing fetch (recursion guard contract)", async () => {
    let called = 0;
    const raw = bypassingFetch(async (input) => {
      called++;
      return new Response(`fetched ${input.url}`);
    });
    const res = await raw(new Request("https://origin.example/x"));
    expect(called).toBe(1);
    expect(await res.text()).toBe("fetched https://origin.example/x");
  });
});
