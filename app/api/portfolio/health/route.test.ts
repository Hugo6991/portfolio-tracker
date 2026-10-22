import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const readLatestPortfolioSnapshot = vi.fn();
const readMonthlyDeBankUsage = vi.fn();
const readPortfolioSyncMonitor = vi.fn();
const requireViewerJson = vi.fn();

vi.mock("@/lib/server/portfolio-snapshot-store", () => ({
  readLatestPortfolioSnapshot,
  readMonthlyDeBankUsage,
  readPortfolioSyncMonitor
}));
vi.mock("@/lib/server/viewer-auth", () => ({
  privateNoStoreHeaders: {
    "Cache-Control": "private, no-store, max-age=0",
    "Vercel-CDN-Cache-Control": "no-store"
  },
  requireViewerJson
}));

let readHealth: typeof import("./route").GET;

beforeAll(async () => {
  ({ GET: readHealth } = await import("./route"));
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-11T00:45:00.000Z"));
  requireViewerJson.mockReset().mockResolvedValue(null);
  readLatestPortfolioSnapshot.mockReset().mockResolvedValue({
    captured_at: "2026-09-11T00:45:00.000Z",
    snapshot: {
      sources: [{
        id: "debank",
        name: "DeBank",
        kind: "wallet",
        status: "live",
        valueUsd: 123_456,
        itemCount: 12,
        updatedAt: "2026-09-11T00:30:00.000Z",
        detail: "12 wallets including a private provider response",
        cadence: "daily",
        valueUpdatedAt: "2026-09-11T00:30:00.000Z",
        compositionUpdatedAt: "2026-09-11T00:45:00.000Z",
        freshnessState: "fresh",
        nextScheduledAt: "2026-09-12T00:30:00.000Z",
        pricing: {
          provider: "defillama",
          cadence: "15m",
          state: "fresh",
          updatedAt: "2026-09-11T00:45:00.000Z",
          eligibleTokenCount: 8,
          pricedTokenCount: 8,
          fallbackTokenCount: 0,
          coverageValuePercent: 100
        }
      }]
    }
  });
  readPortfolioSyncMonitor.mockReset().mockResolvedValue({
    lastAttemptAt: "2026-09-11T00:45:00.000Z",
    lastSuccessfulAt: "2026-09-11T00:45:00.000Z",
    attemptLagHours: 0,
    isAttemptOverdue: false,
    latest: { completedAt: "2026-09-11T00:45:00.000Z", status: "success", rejectedSources: [], reasonCodes: [] }
  });
  readMonthlyDeBankUsage.mockReset().mockResolvedValue({
    month: "2026-09",
    scanCount: 1,
    requestCount: 2,
    valuationScanCount: 1,
    fullScanCount: 0,
    estimatedUnits: 60
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("portfolio health API", () => {
  it("rejects an anonymous request before reading health storage", async () => {
    requireViewerJson.mockResolvedValueOnce(Response.json({ error: "Viewer access required" }, { status: 401 }));

    const response = await readHealth(new Request("https://portfolio.test/api/portfolio/health"));

    expect(response.status).toBe(401);
    expect(readLatestPortfolioSnapshot).not.toHaveBeenCalled();
    expect(readPortfolioSyncMonitor).not.toHaveBeenCalled();
    expect(readMonthlyDeBankUsage).not.toHaveBeenCalled();
  });

  it("returns source timing and budget status without private portfolio data", async () => {
    const response = await readHealth(new Request("https://portfolio.test/api/portfolio/health"));
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.sources[0]).toMatchObject({
      id: "debank",
      cadence: "daily",
      freshnessState: "fresh",
      fallbackAgeHours: 0.3,
      pricing: { provider: "defillama", coverageValuePercent: 100 }
    });
    expect(body.debankBudget).toMatchObject({
      scanCount: 1,
      providerRequestCount: 2,
      valuationWalletsPerDay: 2,
      walletCoverageDays: 6,
      dailyValuationUnits: 60,
      monthlyWarningUnits: 5_000,
      monthlyHardStopUnits: 10_000,
      projectedAnnualUnits: 35_208,
      standardPackageLifetimeYears: 28.4,
      warning: false,
      withinBudget: true
    });
    expect(serialized).not.toContain("123456");
    expect(serialized).not.toContain("private provider response");
    expect(serialized).not.toContain("address");
    expect(serialized).not.toContain("holding");
  });

  it("fails closed without leaking storage errors", async () => {
    readLatestPortfolioSnapshot.mockRejectedValue(new Error("secret service key"));

    const response = await readHealth(new Request("https://portfolio.test/api/portfolio/health"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).not.toContain("secret service key");
  });

  it("recomputes source freshness and the next run from the current time", async () => {
    vi.setSystemTime(new Date("2026-09-13T01:01:00.000Z"));
    readLatestPortfolioSnapshot.mockResolvedValue({
      captured_at: "2026-09-11T00:45:00.000Z",
      snapshot: {
        wallets: [],
        sources: [{
          id: "okx",
          name: "OKX",
          kind: "exchange",
          status: "live",
          valueUsd: 100,
          itemCount: 1,
          updatedAt: "2026-09-11T00:45:00.000Z",
          valueUpdatedAt: "2026-09-11T00:45:00.000Z",
          freshnessState: "fresh",
          nextScheduledAt: "2026-09-11T01:00:00.000Z",
          detail: "stored snapshot"
        }]
      }
    });

    const response = await readHealth(new Request("https://portfolio.test/api/portfolio/health"));
    const body = await response.json();

    expect(body.sources[0]).toMatchObject({
      id: "okx",
      freshnessState: "stale",
      fallbackAgeHours: 48.3,
      nextScheduledAt: "2026-09-13T01:15:00.000Z"
    });
  });

  it("uses the shared manual freshness thresholds for bank balances", async () => {
    vi.setSystemTime(new Date("2026-10-20T08:00:00.000Z"));
    readLatestPortfolioSnapshot.mockResolvedValue({
      captured_at: "2026-10-20T08:00:00.000Z",
      snapshot: {
        wallets: [],
        sources: [{
          id: "bank-csv",
          name: "Bank CSV",
          kind: "bank",
          status: "preview",
          valueUsd: 300,
          itemCount: 2,
          updatedAt: "2026-10-01T08:00:00.000Z",
          valueUpdatedAt: "2026-10-01T08:00:00.000Z",
          compositionUpdatedAt: "2026-10-01T08:00:00.000Z",
          freshnessState: "fresh",
          detail: "stored bank snapshot"
        }]
      }
    });

    const response = await readHealth(new Request("https://portfolio.test/api/portfolio/health"));
    const body = await response.json();

    expect(body.sources[0]).toMatchObject({
      id: "bank-csv",
      cadence: "manual",
      freshnessState: "late",
      usingFallback: false,
      fallbackAgeHours: 456,
      nextScheduledAt: null
    });
  });
});
