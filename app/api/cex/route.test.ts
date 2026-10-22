import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const readLatestCexSnapshots = vi.fn();
const requireViewerJson = vi.fn();
const createUnavailableCexSnapshot = vi.fn((exchange: string) => ({
  exchange,
  status: "error",
  capturedAt: "2026-08-22T00:00:00.000Z"
}));
const buildCexPublicResponse = vi.fn((sources: unknown[]) => ({ sources }));

vi.mock("@/lib/cex", () => ({
  CEX_EXCHANGES: ["binance", "okx", "bitget", "htx", "gate"],
  buildCexPublicResponse,
  createUnavailableCexSnapshot
}));
vi.mock("@/lib/server/cex-snapshot-store", () => ({ readLatestCexSnapshots }));
vi.mock("@/lib/server/viewer-auth", () => ({
  privateNoStoreHeaders: {
    "Cache-Control": "private, no-store, max-age=0",
    "Vercel-CDN-Cache-Control": "no-store"
  },
  requireViewerJson
}));

let readCex: typeof import("./route").GET;

beforeAll(async () => {
  ({ GET: readCex } = await import("./route"));
});

beforeEach(() => {
  readLatestCexSnapshots.mockReset();
  requireViewerJson.mockReset().mockResolvedValue(null);
  createUnavailableCexSnapshot.mockClear();
  buildCexPublicResponse.mockClear();
});

describe("CEX read API", () => {
  it("rejects an anonymous request before reading snapshot storage", async () => {
    requireViewerJson.mockResolvedValueOnce(Response.json({ error: "Viewer access required" }, { status: 401 }));

    const response = await readCex(new Request("https://portfolio.test/api/cex"));

    expect(response.status).toBe(401);
    expect(readLatestCexSnapshots).not.toHaveBeenCalled();
  });

  it("returns bootstrap 503 instead of calling providers when storage is empty", async () => {
    readLatestCexSnapshots.mockResolvedValue({});

    const response = await readCex(new Request("https://portfolio.test/api/cex"));

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(buildCexPublicResponse).not.toHaveBeenCalled();
  });

  it("returns stored sources and explicit unavailable placeholders", async () => {
    readLatestCexSnapshots.mockResolvedValue({
      binance: { exchange: "binance", status: "live", capturedAt: "2026-08-22T00:00:00.000Z" }
    });

    const response = await readCex(new Request("https://portfolio.test/api/cex"));
    const body = await response.json() as { sources: Array<{ exchange: string }> };

    expect(response.status).toBe(200);
    expect(body.sources.map((source) => source.exchange)).toEqual([
      "binance",
      "okx",
      "bitget",
      "htx",
      "gate"
    ]);
    expect(createUnavailableCexSnapshot).toHaveBeenCalledTimes(4);
  });

  it("fails closed on a storage outage", async () => {
    readLatestCexSnapshots.mockRejectedValue(new Error("database unavailable"));

    const response = await readCex(new Request("https://portfolio.test/api/cex"));

    expect(response.status).toBe(503);
    expect(buildCexPublicResponse).not.toHaveBeenCalled();
  });
});
