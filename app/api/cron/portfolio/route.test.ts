import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LivePortfolioSnapshot } from "@/lib/live-portfolio";

const evaluatePortfolioSnapshot = vi.fn();
const getPortfolioCollapseConfirmation = vi.fn();
const summarizePortfolioCandidate = vi.fn();
const getTaipeiDate = vi.fn();
const getLivePortfolioCandidate = vi.fn();
const generatePortfolioReport = vi.fn();
const claimPortfolioSync = vi.fn();
const finishPortfolioSync = vi.fn();
const hasPortfolioSyncAttempt = vi.fn();
const readLatestPortfolioRejection = vi.fn();
const readLatestPortfolioReport = vi.fn();
const readLatestPortfolioSnapshot = vi.fn();
const readMonthlyDeBankUsage = vi.fn();
const readPreviousDailySnapshot = vi.fn();

vi.mock("@/lib/portfolio-snapshot-policy", () => ({
  evaluatePortfolioSnapshot,
  getPortfolioCollapseConfirmation,
  summarizePortfolioCandidate
}));
vi.mock("@/lib/portfolio-history", () => ({
  getTaipeiDate,
  snapshotToHistoryPoint: vi.fn((value: LivePortfolioSnapshot) => ({
    date: "2026-08-22",
    capturedAt: value.generatedAt,
    netWorthUsd: value.netWorthUsd,
    exchangesUsd: value.groups.exchangesUsd,
    walletsUsd: value.groups.walletsUsd,
    banksUsd: value.groups.banksUsd,
    sourceCount: value.connectedSourceCount,
    isPartial: value.isPartial,
    deltaUsd: null,
    deltaPercent: null
  }))
}));
vi.mock("@/lib/server/cron-auth", () => ({ isCronRequestAuthorized: vi.fn(() => true) }));
vi.mock("@/lib/server/live-portfolio", () => ({ getLivePortfolioCandidate }));
vi.mock("@/lib/server/portfolio-report", () => ({ generatePortfolioReport }));
vi.mock("@/lib/server/portfolio-sync-log", () => ({
  logPortfolioSync: vi.fn(),
  sanitizePortfolioSyncError: vi.fn((error: unknown, fallback: string) => (
    error instanceof Error ? error.message : fallback
  ))
}));
vi.mock("@/lib/server/portfolio-snapshot-store", () => ({
  claimPortfolioSync,
  finishPortfolioSync,
  hasPortfolioSyncAttempt,
  isPortfolioSnapshotStorageConfigured: vi.fn(() => true),
  readLatestPortfolioReport,
  readLatestPortfolioRejection,
  readLatestPortfolioSnapshot,
  readMonthlyDeBankUsage,
  readPreviousDailySnapshot
}));

let runPortfolioCron: typeof import("./route").GET;

beforeAll(async () => {
  ({ GET: runPortfolioCron } = await import("./route"));
});

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "test-secret");
  for (const mock of [
    evaluatePortfolioSnapshot,
    getPortfolioCollapseConfirmation,
    summarizePortfolioCandidate,
    getLivePortfolioCandidate,
    generatePortfolioReport,
    claimPortfolioSync,
    finishPortfolioSync,
    hasPortfolioSyncAttempt,
    readLatestPortfolioRejection,
    readLatestPortfolioReport,
    readLatestPortfolioSnapshot,
    readMonthlyDeBankUsage,
    readPreviousDailySnapshot
  ]) mock.mockReset();

  claimPortfolioSync.mockResolvedValue({
    claimed: true,
    runId: 84,
    leaseToken: "lease-token",
    reason: "claimed"
  });
  hasPortfolioSyncAttempt.mockResolvedValue(false);
  evaluatePortfolioSnapshot.mockReturnValue({ accepted: true, status: "complete", reasons: [] });
  summarizePortfolioCandidate.mockReturnValue({ netWorthUsd: 1_500, sources: [] });
  getPortfolioCollapseConfirmation.mockReturnValue({ confirmed: false, count: 1 });
  getTaipeiDate.mockReturnValue("2026-08-22");
  getLivePortfolioCandidate.mockResolvedValue({
    snapshot: snapshot(),
    sourcePayloads: [],
    providerUsage: { debank: { scanAttempted: true, requestCount: 2, scanKind: "total-balance", estimatedUnits: 60 } }
  });
  readLatestPortfolioSnapshot.mockResolvedValue(null);
  readMonthlyDeBankUsage.mockResolvedValue({
    month: "2026-08",
    scanCount: 0,
    requestCount: 0,
    valuationScanCount: 0,
    fullScanCount: 0,
    estimatedUnits: 0
  });
  readLatestPortfolioReport.mockResolvedValue(null);
  readLatestPortfolioRejection.mockResolvedValue(null);
  readPreviousDailySnapshot.mockResolvedValue(null);
  finishPortfolioSync.mockResolvedValue(true);
  generatePortfolioReport.mockResolvedValue(report());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("daily full portfolio sync", () => {
  it("publishes the current LKG and immutable full snapshot even with a legacy query parameter", async () => {
    const response = await runPortfolioCron(request("?mode=hourly"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ mode: "daily-full", status: "success", dailyReport: "generated" });
    expect(getLivePortfolioCandidate).toHaveBeenCalledWith({
      mode: "valuation",
      baselineSnapshot: null
    });
    expect(claimPortfolioSync).toHaveBeenCalledWith(expect.objectContaining({
      jobKey: "debank-daily:2026-08-22"
    }));
    expect(finishPortfolioSync).toHaveBeenCalledWith(expect.objectContaining({
      publishCurrent: true,
      writeFull: true,
      writeValue: false,
      qualityStatus: "complete"
    }));
    expect(generatePortfolioReport).toHaveBeenCalledOnce();
  });

  it("skips an already generated Taipei-day report while still publishing the snapshot", async () => {
    readLatestPortfolioReport.mockResolvedValue({
      ...report(),
      generatedAt: "2026-08-21T16:08:00.000Z"
    });

    const response = await runPortfolioCron(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.dailyReport).toBe("already-generated");
    expect(finishPortfolioSync).toHaveBeenCalledWith(expect.objectContaining({ publishCurrent: true }));
    expect(generatePortfolioReport).not.toHaveBeenCalled();
  });

  it("runs the four-endpoint detail scan only on the first Taipei day of the month", async () => {
    getTaipeiDate.mockReturnValue("2026-09-01");

    const response = await runPortfolioCron(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.debankSyncMode).toBe("full");
    expect(getLivePortfolioCandidate).toHaveBeenCalledWith({
      mode: "full",
      baselineSnapshot: null
    });
    expect(claimPortfolioSync).toHaveBeenCalledWith(expect.objectContaining({
      jobKey: "debank-daily:2026-09-01"
    }));
  });

  it("does not lose a good snapshot when report dependencies fail", async () => {
    readLatestPortfolioReport.mockRejectedValue(new Error("report storage unavailable"));

    const response = await runPortfolioCron(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.dailyReport).toBe("unavailable");
    expect(finishPortfolioSync).toHaveBeenCalledWith(expect.objectContaining({
      status: "success",
      publishCurrent: true,
      writeFull: true
    }));
  });

  it("keeps last-known-good and skips the report when quality fails", async () => {
    evaluatePortfolioSnapshot.mockReturnValue({
      accepted: false,
      status: "rejected",
      reasons: [{ code: "reported-partial" }]
    });

    const response = await runPortfolioCron(request());
    const body = await response.json();

    expect(body).toMatchObject({
      status: "skipped_degraded",
      preservedLastKnownGood: true,
      debankSyncMode: "valuation",
      providerUsage: {
        debank: { scanKind: "total-balance", requestCount: 2, estimatedUnits: 60 }
      },
      dailyReport: "skipped-quality-gate"
    });
    expect(finishPortfolioSync).toHaveBeenCalledWith(expect.objectContaining({
      publishCurrent: false,
      writeFull: false
    }));
    expect(readLatestPortfolioReport).not.toHaveBeenCalled();
    expect(generatePortfolioReport).not.toHaveBeenCalled();
  });

  it("fails closed before current, history and report publication when valuation coverage is incomplete", async () => {
    const incomplete = snapshot();
    delete incomplete.valuationBasis;
    getLivePortfolioCandidate.mockResolvedValue({
      snapshot: incomplete,
      sourcePayloads: [],
      providerUsage: { debank: { scanAttempted: true, requestCount: 2, scanKind: "total-balance", estimatedUnits: 60 } }
    });

    const response = await runPortfolioCron(request("?acceptCollapse=1"));
    const body = await response.json();

    expect(body).toMatchObject({
      status: "skipped_degraded",
      preservedLastKnownGood: true,
      reasons: [{ code: "valuation-basis-incomplete" }],
      collapseReadyForReview: false,
      dailyReport: "skipped-quality-gate"
    });
    expect(getPortfolioCollapseConfirmation).not.toHaveBeenCalled();
    expect(readLatestPortfolioReport).not.toHaveBeenCalled();
    expect(readPreviousDailySnapshot).not.toHaveBeenCalled();
    expect(generatePortfolioReport).not.toHaveBeenCalled();
    expect(finishPortfolioSync).toHaveBeenCalledWith(expect.objectContaining({
      publishCurrent: false,
      writeValue: false,
      writeFull: false,
      qualityStatus: "rejected"
    }));
  });

  it("publishes a degraded current composite but skips the daily snapshot and report", async () => {
    const degraded = snapshot();
    degraded.isPartial = true;
    degraded.sources = [{
      id: "debank",
      name: "DeBank",
      kind: "wallet",
      status: "partial",
      valueUsd: 500,
      itemCount: 1,
      updatedAt: degraded.generatedAt,
      detail: "Using last known good",
      fallback: { lastGoodAt: degraded.generatedAt, attemptStatus: "error" }
    }];
    degraded.errors = [{ source: "DeBank", message: "rate limited" }];
    getLivePortfolioCandidate.mockResolvedValue({
      snapshot: degraded,
      sourcePayloads: [],
      providerUsage: { debank: { scanAttempted: true, requestCount: 4, scanKind: "total-balance", estimatedUnits: 120 } }
    });
    evaluatePortfolioSnapshot.mockReturnValue({ accepted: true, status: "degraded", reasons: [] });

    const response = await runPortfolioCron(request());
    const body = await response.json();

    expect(body).toMatchObject({
      status: "partial",
      fallbackSourceCount: 1,
      dailyReport: "skipped-source-fallback"
    });
    expect(finishPortfolioSync).toHaveBeenCalledWith(expect.objectContaining({
      status: "partial",
      qualityStatus: "degraded",
      publishCurrent: true,
      writeFull: false
    }));
    expect(generatePortfolioReport).not.toHaveBeenCalled();
  });

  it("does not start providers when another instance owns the aggregate lease", async () => {
    claimPortfolioSync.mockResolvedValue({
      claimed: false,
      runId: 83,
      leaseToken: null,
      reason: "already_running"
    });

    const response = await runPortfolioCron(request());

    expect(response.status).toBe(202);
    expect(getLivePortfolioCandidate).not.toHaveBeenCalled();
    expect(finishPortfolioSync).not.toHaveBeenCalled();
  });

  it("blocks every later paid attempt for the same Taipei date regardless of prior outcome", async () => {
    hasPortfolioSyncAttempt.mockResolvedValue(true);

    const response = await runPortfolioCron(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "already_completed" });
    expect(claimPortfolioSync).not.toHaveBeenCalled();
    expect(getLivePortfolioCandidate).not.toHaveBeenCalled();
  });

  it("fails closed before providers when the monthly investigation threshold is near", async () => {
    readMonthlyDeBankUsage.mockResolvedValue({
      month: "2026-08",
      scanCount: 40,
      requestCount: 480,
      valuationScanCount: 40,
      fullScanCount: 0,
      estimatedUnits: 9_941
    });

    const response = await runPortfolioCron(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "budget_paused",
      estimatedUnitsUsed: 9_941,
      monthlyHardStopUnits: 10_000
    });
    expect(claimPortfolioSync).not.toHaveBeenCalled();
    expect(getLivePortfolioCandidate).not.toHaveBeenCalled();
  });

  it("allows one explicitly authorized full scan with its own daily lease and full reserve", async () => {
    const response = await runPortfolioCron(request("?forceFull=1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.debankSyncMode).toBe("full");
    expect(getLivePortfolioCandidate).toHaveBeenCalledWith({
      mode: "full",
      baselineSnapshot: null
    });
    expect(claimPortfolioSync).toHaveBeenCalledWith(expect.objectContaining({
      jobKey: "debank-full-manual:2026-08-22",
      syncKind: "full",
      trigger: "manual"
    }));
  });
});

function request(query = "") {
  return new Request(`https://portfolio.test/api/cron/portfolio${query}`, {
    headers: { authorization: "Bearer test-secret" }
  });
}

function snapshot(): LivePortfolioSnapshot {
  return {
    valuationBasis: "binance-equities-v1",
    generatedAt: "2026-08-21T16:07:00.000Z",
    netWorthUsd: 1_500,
    liveValueUsd: 1_500,
    previewValueUsd: 0,
    groups: { exchangesUsd: 1_000, walletsUsd: 500, banksUsd: 0 },
    sources: [],
    holdings: [],
    wallets: [],
    connectedSourceCount: 2,
    expectedSourceCount: 2,
    isPartial: false,
    errors: []
  };
}

function report() {
  return {
    date: "2026-08-22",
    summary: "Daily baseline.",
    alerts: [],
    currentUsd: 1_500,
    deltaUsd: null,
    deltaPercent: null,
    generator: "rules" as const,
    model: null
  };
}
