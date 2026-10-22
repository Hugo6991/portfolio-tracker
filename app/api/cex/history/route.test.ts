import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readCexHistory: vi.fn(),
  requireViewerJson: vi.fn()
}));

vi.mock("@/lib/server/cex-snapshot-store", () => ({
  readCexHistory: mocks.readCexHistory
}));
vi.mock("@/lib/server/viewer-auth", () => ({
  privateNoStoreHeaders: {
    "Cache-Control": "private, no-store, max-age=0",
    "Vercel-CDN-Cache-Control": "no-store"
  },
  requireViewerJson: mocks.requireViewerJson
}));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireViewerJson.mockResolvedValue(null);
});

describe("CEX history API", () => {
  it("rejects an anonymous request before reading history storage", async () => {
    mocks.requireViewerJson.mockResolvedValueOnce(Response.json({ error: "Viewer access required" }, { status: 401 }));

    const response = await GET(new Request("https://portfolio.test/api/cex/history"));

    expect(response.status).toBe(401);
    expect(mocks.readCexHistory).not.toHaveBeenCalled();
  });

  it("returns bounded history for an authorized viewer", async () => {
    mocks.readCexHistory.mockResolvedValue([{ capturedAt: "2026-10-03T00:00:00.000Z" }]);

    const response = await GET(new Request(
      "https://portfolio.test/api/cex/history?days=999&interval=5"
    ));

    expect(response.status).toBe(200);
    expect(mocks.readCexHistory).toHaveBeenCalledWith(30, 15);
    await expect(response.json()).resolves.toEqual({
      points: [{ capturedAt: "2026-10-03T00:00:00.000Z" }]
    });
  });
});
