import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LivePortfolioSnapshot } from "@/lib/live-portfolio";

const evaluatePortfolioSnapshot = vi.fn();
const getPortfolioCollapseConfirmation = vi.fn();
const summarizePortfolioCandidate = vi.fn();
const getLivePortfolioCandidate = vi.fn();
const claimPortfolioSync = vi.fn();
const finishPortfolioSync = vi.fn();
const readLatestPortfolioRejection = vi.fn();
const readLatestPortfolioSnapshot = vi.fn();

vi.mock("@/lib/portfolio-snapshot-policy", () => ({
  evaluatePortfolioSnapshot,
  getPortfolioCollapseConfirmation,
  summarizePortfolioCandidate
}));
vi.mock("@/lib/server/cron-auth", () => ({
  isCronRequestAuthorized: vi.fn((authorization: string | null, secret: string) => (
    authorization === `Bearer ${secret}`
  ))
}));
vi.mock("@/lib/server/live-portfolio", () => ({ getLivePortfolioCandidate }));
vi.mock("@/lib/server/portfolio-sync-log", () => ({
  logPortfolioSync: vi.fn(),
  sanitizePortfolioSyncError: vi.fn((error: unknown, fallback: string) => (
    error instanceof Error ? error.message : fallback
  ))
}));
vi.mock("@/lib/server/portfolio-snapshot-store", () => ({
  claimPortfolioSync,
  finishPortfolioSync,
  isPortfolioSnapshotStorageConfigured: vi.fn(() => true),
  readLatestPortfolioRejection,
  readLatestPortfolioSnapshot
}));

let runPortfolioValueCron: typeof import("./route").GET;

beforeAll(async () => {
  ({ GET: runPortfolioValueCron } = await import("./route"));
});

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "test-secret");
  for (const mock of [
    evaluatePortfolioSnapshot,
    getPortfolioCollapseConfirmation,
    summarizePortfolioCandidate,
    getLivePortfolioCandidate,
    claimPortfolioSync,
    finishPortfolioSync,
    readLatestPortfolioRejection,
    readLatestPortfolioSnapshot
  ]) mock.mockReset();

  claimPortfolioSync.mockResolvedValue({
    claimed: true,
    runId: 42,
    leaseToken: "lease-token",
    reason: "claimed"
  });
  evaluatePortfolioSnapshot.mockReturnValue({ accepted: true, status: "complete", reasons: [] });
  summarizePortfolioCandidate.mockReturnValue({ netWorthUsd: 1_500, sources: [] });
  getPortfolioCollapseConfirmation.mockReturnValue({ confirmed: false, count: 1 });
  getLivePortfolioCandidate.mockResolvedValue({
    snapshot: snapshot(),
    sourcePayloads: [],
    providerUsage: { debank: { scanAttempted: false, requestCount: 0, scanKind: "none", estimatedUnits: 0 } }
  });
  readLatestPortfolioSnapshot.mockResolvedValue(null);
  readLatestPortfolioRejection.mockResolvedValue(null);
  finishPortfolioSync.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("15-minute current portfolio sync", () => {
  it("persists a corrected manual baseline without a DeBank scan", async () => {
    getLivePortfolioCandidate.mockResolvedValue({
      snapshot: snapshot(), sourcePayloads: [],
      providerUsage: { debank: { scanAttempted: false, requestCount: 0, scanKind: "none", estimatedUnits: 0 } }
    });
    const response = await runPortfolioValueCron(request("?manual=1"));
    expect((await response.json()).providerUsage.debank.requestCount).toBe(0);
    expect(finishPortfolioSync).toHaveBeenCalledWith(expect.objectContaining({ writeFull: true, writeValue: true }));
    expect(getLivePortfolioCandidate).toHaveBeenCalledWith(expect.objectContaining({ mode: "current" }));
  });

  it("fails closed when corrected valuation coverage is incomplete", async () => {
    const incomplete = snapshot();
    delete incomplete.valuationBasis;
    getLivePortfolioCandidate.mockResolvedValue({
      snapshot: incomplete,
      sourcePayloads: [],
      providerUsage: { debank: { scanAttempted: false, requestCount: 0, scanKind: "none", estimatedUnits: 0 } }
    });

    const response = await runPortfolioValueCron(request("?acceptCollapse=1"));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      status: "skipped_degraded",
      preservedLastKnownGood: true,
      reasons: [{ code: "valuation-basis-incomplete" }],
      collapseReadyForReview: false
    });
    expect(getPortfolioCollapseConfirmation).not.toHaveBeenCalled();
    expect(finishPortfolioSync).toHaveBeenCalledWith(expect.objectContaining({
      publishCurrent: false,
      writeValue: false,
      writeFull: false,
      qualityStatus: "rejected"
    }));
  });
  it("fails closed without the cron bearer secret", async () => {
    const response = await runPortfolioValueCron(
      new Request("https://portfolio.test/api/cron/portfolio-value")
    );

    expect(response.status).toBe(401);
    expect(claimPortfolioSync).not.toHaveBeenCalled();
    expect(getLivePortfolioCandidate).not.toHaveBeenCalled();
  });

  it("publishes current and compact history through the fenced completion RPC", async () => {
    const response = await runPortfolioValueCron(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ mode: "current-15m", status: "success" });
    expect(claimPortfolioSync).toHaveBeenCalledWith(expect.objectContaining({ syncKind: "value" }));
    expect(getLivePortfolioCandidate).toHaveBeenCalledWith({
      mode: "current",
      baselineSnapshot: null
    });
    expect(finishPortfolioSync).toHaveBeenCalledWith(expect.objectContaining({
      runId: 42,
      publishCurrent: true,
      writeValue: true,
      writeFull: false,
      qualityStatus: "complete"
    }));
  });

  it("records a rejected attempt without replacing last-known-good data", async () => {
    evaluatePortfolioSnapshot.mockReturnValue({
      accepted: false,
      status: "rejected",
      reasons: [{ code: "incomplete-source", sourceId: "debank" }]
    });

    const response = await runPortfolioValueCron(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "skipped_degraded",
      preservedLastKnownGood: true
    });
    expect(finishPortfolioSync).toHaveBeenCalledWith(expect.objectContaining({
      status: "skipped_degraded",
      publishCurrent: false,
      writeValue: false,
      writeFull: false
    }));
  });

  it("publishes a current composite without writing history when a source uses fallback", async () => {
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
      providerUsage: { debank: { scanAttempted: false, requestCount: 0, scanKind: "none", estimatedUnits: 0 } }
    });
    evaluatePortfolioSnapshot.mockReturnValue({ accepted: true, status: "degraded", reasons: [] });

    const response = await runPortfolioValueCron(request());
    const body = await response.json();

    expect(body).toMatchObject({ status: "partial", fallbackSourceCount: 1 });
    expect(finishPortfolioSync).toHaveBeenCalledWith(expect.objectContaining({
      status: "partial",
      qualityStatus: "degraded",
      publishCurrent: true,
      writeValue: false,
      writeFull: false
    }));
  });

  it("does not fan out when another server instance owns the lease", async () => {
    claimPortfolioSync.mockResolvedValue({
      claimed: false,
      runId: 41,
      leaseToken: null,
      reason: "already_running"
    });

    const response = await runPortfolioValueCron(request());

    expect(response.status).toBe(202);
    expect(getLivePortfolioCandidate).not.toHaveBeenCalled();
    expect(finishPortfolioSync).not.toHaveBeenCalled();
  });

  it("requires protected acknowledgement after three consistent quarantined attempts", async () => {
    evaluatePortfolioSnapshot.mockReturnValue({
      accepted: false,
      status: "rejected",
      reasons: [{ code: "value-collapse" }]
    });
    readLatestPortfolioRejection.mockResolvedValue({
      completedAt: "2026-08-22T00:15:00.000Z",
      candidate: { netWorthUsd: 1_500, sources: [] },
      confirmationCount: 2
    });
    getPortfolioCollapseConfirmation.mockReturnValue({ confirmed: true, count: 3 });

    const quarantinedResponse = await runPortfolioValueCron(request());
    const quarantinedBody = await quarantinedResponse.json();

    expect(quarantinedBody).toMatchObject({
      status: "skipped_degraded",
      collapseReadyForReview: true
    });

    const response = await runPortfolioValueCron(request("?acceptCollapse=1"));
    const body = await response.json();

    expect(body.status).toBe("success");
    expect(claimPortfolioSync).toHaveBeenLastCalledWith(expect.objectContaining({
      trigger: "manual"
    }));
    expect(finishPortfolioSync).toHaveBeenLastCalledWith(expect.objectContaining({
      publishCurrent: true,
      qualityStatus: "complete"
    }));
  });

  it("records an authenticated retry as manual without accepting a collapse", async () => {
    const response = await runPortfolioValueCron(request("?manual=1"));

    expect(response.status).toBe(200);
    expect(claimPortfolioSync).toHaveBeenCalledWith(expect.objectContaining({
      trigger: "manual",
      jobKey: expect.stringContaining("portfolio:manual:retry:")
    }));
  });

  it("returns a conflict when manual acceptance is not eligible", async () => {
    evaluatePortfolioSnapshot.mockReturnValue({
      accepted: false,
      status: "rejected",
      reasons: [{ code: "incomplete-source", sourceId: "gate" }]
    });

    const response = await runPortfolioValueCron(request("?acceptCollapse=1"));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.status).toBe("skipped_degraded");
    expect(finishPortfolioSync).toHaveBeenCalledWith(expect.objectContaining({
      publishCurrent: false
    }));
  });

  it("schedules the cache refresh after CEX sync and defines fenced claim and finish RPCs", () => {
    const schemaMigration = readFileSync(join(
      process.cwd(),
      "supabase/migrations/202608220002_reliable_portfolio_sync.sql"
    ), "utf8");
    const scheduleMigration = readFileSync(join(
      process.cwd(),
      "supabase/migrations/202608220003_schedule_reliable_portfolio_sync.sql"
    ), "utf8");
    const sourceFallbackMigration = readFileSync(join(
      process.cwd(),
      "supabase/migrations/202609070001_enable_per_source_lkg.sql"
    ), "utf8");

    expect(schemaMigration).toContain("claim_portfolio_sync_v2");
    expect(schemaMigration).toContain("finish_portfolio_sync_v2");
    expect(schemaMigration).toContain("portfolio_source_state");
    expect(schemaMigration).toContain("notify pgrst, 'reload schema'");
    expect(scheduleMigration).toContain("portfolio-current-sync-15m");
    expect(scheduleMigration).toContain("7,22,37,52 * * * *");
    expect(scheduleMigration).toContain("portfolio-full-sync-daily-retry");
    expect(scheduleMigration).toContain("42 1 * * *");
    expect(sourceFallbackMigration).toContain("finish_portfolio_sync_v3");
    expect(sourceFallbackMigration).toContain("record_portfolio_source_payloads_v1");
    expect(sourceFallbackMigration).toContain("every incomplete source must carry a last-known-good fallback");
  });
});

function request(query = "") {
  return new Request(`https://portfolio.test/api/cron/portfolio-value${query}`, {
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
