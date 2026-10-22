import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireViewerJson: vi.fn() }));

vi.mock("@/lib/server/viewer-auth", () => ({
  privateNoStoreHeaders: {
    "Cache-Control": "private, no-store, max-age=0",
    "Vercel-CDN-Cache-Control": "no-store"
  },
  requireViewerJson: mocks.requireViewerJson
}));

import { GET } from "./route";

beforeEach(() => {
  mocks.requireViewerJson.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("private FX API", () => {
  it("rejects an anonymous request before contacting the rate provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.requireViewerJson.mockResolvedValueOnce(Response.json({ error: "Viewer access required" }, { status: 401 }));

    const response = await GET(new Request("https://portfolio.test/api/fx"));

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an updated rate for an authorized viewer without shared caching", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      result: "success",
      time_last_update_utc: "Fri, 03 Oct 2026 00:00:00 +0000",
      rates: { TWD: 31.25, CNY: 7.1 }
    })));

    const response = await GET(new Request("https://portfolio.test/api/fx"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    await expect(response.json()).resolves.toMatchObject({
      rate: 31.25,
      cnyPerUsd: 7.1,
      status: "updated_today"
    });
  });
});
