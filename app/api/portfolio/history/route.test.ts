import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const readPortfolioHistory = vi.fn();
const readLatestPortfolioReport = vi.fn();
const readLatestPortfolioSnapshot = vi.fn();
const requireViewerJson = vi.fn();

vi.mock("@/lib/server/portfolio-snapshot-store", () => ({
  readPortfolioHistory,
  readLatestPortfolioReport,
  readLatestPortfolioSnapshot
}));
vi.mock("@/lib/server/viewer-auth", () => ({
  privateNoStoreHeaders: {
    "Cache-Control": "private, no-store, max-age=0",
    "Vercel-CDN-Cache-Control": "no-store"
  },
  requireViewerJson
}));

let getPortfolioHistory: typeof import("./route").GET;

beforeAll(async () => {
  ({ GET: getPortfolioHistory } = await import("./route"));
});

beforeEach(() => {
  readPortfolioHistory.mockReset();
  readLatestPortfolioReport.mockReset();
  readLatestPortfolioSnapshot.mockReset();
  requireViewerJson.mockReset().mockResolvedValue(null);
  readPortfolioHistory.mockResolvedValue([]);
  readLatestPortfolioReport.mockResolvedValue(null);
  readLatestPortfolioSnapshot.mockResolvedValue(null);
});

describe("portfolio history route", () => {
  it("rejects an anonymous request before reading portfolio history", async () => {
    requireViewerJson.mockResolvedValueOnce(Response.json({ error: "Viewer access required" }, { status: 401 }));

    const response = await getPortfolioHistory(
      new Request("https://portfolio.test/api/portfolio/history")
    );

    expect(response.status).toBe(401);
    expect(readPortfolioHistory).not.toHaveBeenCalled();
    expect(readLatestPortfolioReport).not.toHaveBeenCalled();
    expect(readLatestPortfolioSnapshot).not.toHaveBeenCalled();
  });

  it("preserves the daily default and its existing range", async () => {
    const response = await getPortfolioHistory(
      new Request("https://portfolio.test/api/portfolio/history")
    );

    expect(readPortfolioHistory).toHaveBeenCalledWith(365, "daily");
    await expect(response.json()).resolves.toEqual({
      configured: true,
      interval: "daily",
      points: [],
      latestReport: null,
      latestObservation: null
    });
  });

  it("supports hourly history while bounding its storage window", async () => {
    const response = await getPortfolioHistory(
      new Request("https://portfolio.test/api/portfolio/history?interval=hourly&days=999")
    );

    expect(readPortfolioHistory).toHaveBeenCalledWith(90, "hourly");
    expect(response.status).toBe(200);
    expect((await response.json()).interval).toBe("hourly");
  });

  it("keeps valid curve points available when the optional report read fails", async () => {
    readPortfolioHistory.mockResolvedValue([{ capturedAt: "2026-08-22T00:07:00.000Z" }]);
    readLatestPortfolioReport.mockRejectedValue(new Error("report table unavailable"));

    const response = await getPortfolioHistory(
      new Request("https://portfolio.test/api/portfolio/history?interval=hourly&days=1")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.points).toHaveLength(1);
    expect(body.latestReport).toBeNull();
  });

  it("does not label an older saved report as the latest brief", async () => {
    readPortfolioHistory.mockResolvedValue([{
      date: "2026-08-22",
      capturedAt: "2026-08-21T16:07:00.000Z",
      isPartial: false
    }]);
    readLatestPortfolioReport.mockResolvedValue({ date: "2026-08-21", summary: "Old" });

    const response = await getPortfolioHistory(
      new Request("https://portfolio.test/api/portfolio/history")
    );

    expect(response.status).toBe(200);
    expect((await response.json()).latestReport).toBeNull();
  });

  it("marks a degraded latest observation without adding it to performance points", async () => {
    readLatestPortfolioSnapshot.mockResolvedValue({
      captured_at: "2026-09-11T00:45:00.000Z",
      snapshot: {
        isPartial: true,
        sources: [{ id: "debank", status: "partial", freshnessState: "late" }]
      }
    });

    const response = await getPortfolioHistory(
      new Request("https://portfolio.test/api/portfolio/history?interval=hourly&days=1")
    );
    const body = await response.json();

    expect(body.points).toEqual([]);
    expect(body.latestObservation).toEqual({
      capturedAt: "2026-09-11T00:45:00.000Z",
      quality: "degraded",
      hasPerformanceGap: true,
      staleSourceIds: ["debank"]
    });
  });
});
