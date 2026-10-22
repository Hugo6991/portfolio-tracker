import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireViewerJson: vi.fn() }));

vi.mock("@/lib/server/viewer-auth", () => ({
  privateNoStoreHeaders: {
    "Cache-Control": "private, no-store, max-age=0",
    "Vercel-CDN-Cache-Control": "no-store"
  },
  requireViewerJson: mocks.requireViewerJson
}));

import { GET } from "./route";

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.requireViewerJson.mockReset();
});

describe("private trading dashboard proxy", () => {
  it("rejects an anonymous request before calling the upstream worker", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.requireViewerJson.mockResolvedValueOnce(Response.json({ error: "Viewer access required" }, { status: 401 }));

    const response = await GET(new Request("https://portfolio.test/api/trading"));

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns only a schema-valid private snapshot", async () => {
    mocks.requireViewerJson.mockResolvedValue(null);
    const snapshot = {schemaVersion:"1.1",privacy:{publicReadOnly:true,containsSecrets:false},trades:[],equityCurve:[],walletCandidates:[]};
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify(snapshot),{status:200,headers:{"content-type":"application/json"}})));
    const response = await GET(new Request("https://portfolio.test/api/trading"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("Vercel-CDN-Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(snapshot);
  });

  it("does not leak an upstream error or malformed response", async () => {
    mocks.requireViewerJson.mockResolvedValue(null);
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({error:"secret provider detail"}),{status:500})));
    const response = await GET(new Request("https://portfolio.test/api/trading"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({error:"Trading data is temporarily unavailable."});
  });
});
