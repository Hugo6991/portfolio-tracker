import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LivePortfolioSnapshot } from "@/lib/live-portfolio";

const readLatestPortfolioSnapshot = vi.fn();
const readLatestPortfolioAttempt = vi.fn();
const readLatestPortfolioAttemptRow = vi.fn();
const requireViewerJson = vi.fn();

vi.mock("@/lib/server/portfolio-sync-log", () => ({
  logPortfolioSync: vi.fn(),
  sanitizePortfolioSyncError: vi.fn(() => "sanitized")
}));
vi.mock("@/lib/server/portfolio-snapshot-store", () => ({
  getPortfolioSnapshotTtlSeconds: vi.fn(() => 1_200),
  buildPortfolioAttempt: readLatestPortfolioAttempt,
  readLatestPortfolioAttemptRow,
  readLatestPortfolioSnapshot
}));
vi.mock("@/lib/server/viewer-auth", () => ({
  privateNoStoreHeaders: {
    "Cache-Control": "private, no-store, max-age=0",
    "Vercel-CDN-Cache-Control": "no-store"
  },
  requireViewerJson
}));

let readPortfolio: typeof import("./route").GET;

beforeAll(async () => {
  ({ GET: readPortfolio } = await import("./route"));
});

beforeEach(() => {
  readLatestPortfolioSnapshot.mockReset();
  readLatestPortfolioAttempt.mockReset();
  readLatestPortfolioAttempt.mockReturnValue(null);
  readLatestPortfolioAttemptRow.mockReset();
  readLatestPortfolioAttemptRow.mockResolvedValue(null);
  requireViewerJson.mockReset().mockResolvedValue(null);
});

describe("portfolio read API", () => {
  it("honors an explicit access policy denial before reading portfolio storage", async () => {
    requireViewerJson.mockResolvedValueOnce(Response.json({ error: "Viewer access required" }, { status: 401 }));

    const response = await readPortfolio(new Request("https://portfolio.test/api/portfolio"));

    expect(response.status).toBe(401);
    expect(readLatestPortfolioSnapshot).not.toHaveBeenCalled();
    expect(readLatestPortfolioAttemptRow).not.toHaveBeenCalled();
  });

  it("serves an overview without wallet details and disables shared caching", async () => {
    readLatestPortfolioSnapshot.mockResolvedValue({ captured_at: new Date().toISOString(), snapshot: snapshot() });
    const response = await readPortfolio(new Request("https://portfolio.test/api/portfolio?view=overview"));
    const body = await response.json();
    expect(body).not.toHaveProperty("wallets");
    expect(body.holdings).toEqual([]);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Vercel-CDN-Cache-Control")).toBe("no-store");
    expect(response.headers.get("Server-Timing")).toMatch(/^read;dur=/);
  });

  it("bypasses edge storage for an explicit reload without triggering provider sync", async () => {
    readLatestPortfolioSnapshot.mockResolvedValue({ captured_at: new Date().toISOString(), snapshot: snapshot() });
    const response = await readPortfolio(new Request("https://portfolio.test/api/portfolio?_fresh=123"));
    expect((await response.json()).wallets).toEqual([]);
    expect(response.headers.get("Vercel-CDN-Cache-Control")).toBe("no-store");
    expect(readLatestPortfolioSnapshot).toHaveBeenCalledOnce();
  });

  it("returns only the persisted snapshot even when a legacy refresh query is present", async () => {
    readLatestPortfolioSnapshot.mockResolvedValue({
      captured_at: new Date().toISOString(),
      snapshot: snapshot()
    });

    const response = await readPortfolio(
      new Request("https://portfolio.test/api/portfolio?refresh=1")
    );
    const body = await response.json() as LivePortfolioSnapshot;

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Portfolio-Data")).toBe("cache");
    expect(body.delivery).toMatchObject({ mode: "cache", persisted: true });
    expect(readLatestPortfolioSnapshot).toHaveBeenCalledOnce();
  });

  it("keeps serving an old last-known-good snapshot and labels it stale", async () => {
    readLatestPortfolioSnapshot.mockResolvedValue({
      captured_at: new Date(Date.now() - 3_600_000).toISOString(),
      snapshot: snapshot()
    });

    const response = await readPortfolio(new Request("https://portfolio.test/api/portfolio"));
    const body = await response.json() as LivePortfolioSnapshot;

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Portfolio-Data")).toBe("stale-cache");
    expect(body.delivery?.mode).toBe("stale-cache");
  });

  it("includes a sanitized latest-attempt diagnosis with a stale snapshot", async () => {
    readLatestPortfolioSnapshot.mockResolvedValue({
      captured_at: new Date(Date.now() - 3_600_000).toISOString(),
      snapshot: snapshot()
    });
    readLatestPortfolioAttempt.mockReturnValue({
      completedAt: "2026-09-06T00:15:00.000Z",
      status: "source-incomplete",
      reasonCodes: ["incomplete-source"],
      confirmationCount: 0,
      reviewReady: false,
      candidateNetWorthUsd: 80,
      previousNetWorthUsd: 100,
      affectedSources: [{
        id: "gate",
        name: "Gate",
        status: "partial",
        previousValueUsd: 20,
        candidateValueUsd: 5,
        deltaUsd: -15,
        deltaPercent: -75
      }]
    });

    const response = await readPortfolio(new Request("https://portfolio.test/api/portfolio"));
    const body = await response.json() as LivePortfolioSnapshot;

    expect(body.delivery?.latestAttempt).toMatchObject({
      status: "source-incomplete",
      affectedSources: [{ id: "gate", status: "partial" }]
    });
  });

  it("returns an explicit bootstrap response without calling providers when no snapshot exists", async () => {
    readLatestPortfolioSnapshot.mockResolvedValue(null);

    const response = await readPortfolio(new Request("https://portfolio.test/api/portfolio"));

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("fails closed when snapshot storage is unavailable", async () => {
    readLatestPortfolioSnapshot.mockRejectedValue(new Error("database unavailable"));

    const response = await readPortfolio(new Request("https://portfolio.test/api/portfolio"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).not.toContain("database unavailable");
  });
});

function snapshot(): LivePortfolioSnapshot {
  return {
    generatedAt: "2026-08-22T00:00:00.000Z",
    netWorthUsd: 100,
    liveValueUsd: 100,
    previewValueUsd: 0,
    groups: { exchangesUsd: 100, walletsUsd: 0, banksUsd: 0 },
    sources: [],
    holdings: [],
    wallets: [],
    connectedSourceCount: 1,
    expectedSourceCount: 1,
    isPartial: false,
    errors: []
  };
}
