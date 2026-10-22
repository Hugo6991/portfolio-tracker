import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LivePortfolioSnapshot } from "../live-portfolio";

vi.mock("server-only", () => ({}));

let claimPortfolioSync: typeof import("./portfolio-snapshot-store").claimPortfolioSync;
let finishPortfolioSync: typeof import("./portfolio-snapshot-store").finishPortfolioSync;
let hasPortfolioSyncAttempt: typeof import("./portfolio-snapshot-store").hasPortfolioSyncAttempt;
let readLatestPortfolioRejection: typeof import("./portfolio-snapshot-store").readLatestPortfolioRejection;
let readLatestPortfolioAttempt: typeof import("./portfolio-snapshot-store").readLatestPortfolioAttempt;
let readLatestPortfolioReport: typeof import("./portfolio-snapshot-store").readLatestPortfolioReport;
let readLatestPortfolioSnapshot: typeof import("./portfolio-snapshot-store").readLatestPortfolioSnapshot;
let readLatestPortfolioSyncSummary: typeof import("./portfolio-snapshot-store").readLatestPortfolioSyncSummary;
let readPortfolioSyncMonitor: typeof import("./portfolio-snapshot-store").readPortfolioSyncMonitor;
let readPreviousCompletePortfolioSnapshot: typeof import("./portfolio-snapshot-store").readPreviousCompletePortfolioSnapshot;

const fetchMock = vi.fn<typeof fetch>();

beforeAll(async () => {
  ({
    claimPortfolioSync,
    finishPortfolioSync,
    hasPortfolioSyncAttempt,
    readLatestPortfolioAttempt,
    readLatestPortfolioRejection,
    readLatestPortfolioReport,
    readLatestPortfolioSnapshot,
    readLatestPortfolioSyncSummary,
    readPortfolioSyncMonitor,
    readPreviousCompletePortfolioSnapshot
  } = await import("./portfolio-snapshot-store"));
});

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://portfolio.supabase.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("reliable portfolio sync storage", () => {
  it("reads the singleton current snapshot before immutable history", async () => {
    fetchMock.mockResolvedValue(jsonResponse([row()]));

    const latest = await readLatestPortfolioSnapshot();

    expect(latest).toEqual(row());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain("/rest/v1/portfolio_current?");
  });

  it("falls back to legacy history only when the additive current table is missing", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse([row()]));

    const latest = await readLatestPortfolioSnapshot();

    expect(latest).toEqual(row());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("/rest/v1/portfolio_snapshots?");
  });

  it("does not revive a legacy partial snapshot after the current table exists", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    const latest = await readLatestPortfolioSnapshot();

    expect(latest).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not hide a database outage by treating it as a migration fallback", async () => {
    fetchMock.mockResolvedValue(new Response("unavailable", { status: 503 }));

    await expect(readLatestPortfolioSnapshot()).rejects.toThrow(
      "Current snapshot read failed with HTTP 503"
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reads the last complete full snapshot before the current Taipei day", async () => {
    fetchMock.mockResolvedValue(jsonResponse([row()]));

    const previous = await readPreviousCompletePortfolioSnapshot({
      ...snapshot(),
      generatedAt: "2026-09-06T02:00:00.000+08:00"
    });

    expect(previous?.captured_at).toBe("2026-08-22T00:07:00.000Z");
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("captured_at")).toBe("lt.2026-09-05T16:00:00.000Z");
    expect(url.searchParams.get("is_partial")).toBe("eq.false");
    expect(url.searchParams.get("limit")).toBe("1");
  });

  it("claims a deterministic job through Supabase", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{
      claimed: true,
      run_id: 9,
      lease_token: "lease-token",
      reason: "claimed"
    }]));

    const claim = await claimPortfolioSync({
      jobKey: "portfolio:value:2026-08-22T00:00:00.000Z",
      syncKind: "value",
      trigger: "cron",
      startedAt: "2026-08-22T00:07:00.000Z"
    });

    expect(claim).toEqual({
      claimed: true,
      runId: 9,
      leaseToken: "lease-token",
      reason: "claimed"
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/rest/v1/rpc/claim_portfolio_sync_v2");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      p_sync_kind: "value",
      p_lease_seconds: 180
    });
  });

  it("finds any prior attempt for an attempt-once paid job", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ id: 9 }]));

    await expect(hasPortfolioSyncAttempt("debank-daily:2026-09-11")).resolves.toBe(true);

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toContain("/rest/v1/portfolio_sync_runs");
    expect(url.searchParams.get("job_key")).toBe("eq.debank-daily:2026-09-11");
    expect(url.searchParams.get("limit")).toBe("1");
  });

  it("sends publication flags and source payloads to the fenced finish RPC", async () => {
    fetchMock.mockResolvedValue(jsonResponse(true));
    const current = snapshot();

    const finished = await finishPortfolioSync({
      runId: 9,
      leaseToken: "lease-token",
      completedAt: "2026-08-22T00:08:00.000Z",
      status: "success",
      durationMs: 1_000,
      snapshot: current,
      qualityStatus: "complete",
      publishCurrent: true,
      writeValue: true,
      writeFull: false,
      detail: { quality: { accepted: true } },
      sourcePayloads: []
    });

    expect(finished).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/rest/v1/rpc/finish_portfolio_sync_v3");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      p_run_id: 9,
      p_snapshot: current,
      p_publish_current: true,
      p_write_value: true,
      p_write_full: false,
      p_source_payloads: []
    });
  });

  it("preserves the whole-snapshot behavior while the v3 RPC is rolling out", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("missing function", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse(true));

    const finished = await finishPortfolioSync({
      runId: 9,
      leaseToken: "lease-token",
      completedAt: "2026-08-22T00:08:00.000Z",
      status: "partial",
      durationMs: 1_000,
      snapshot: { ...snapshot(), isPartial: true },
      qualityStatus: "degraded",
      publishCurrent: true,
      writeValue: false,
      writeFull: false,
      detail: { quality: { accepted: true, status: "degraded" } },
      sourcePayloads: []
    });

    expect(finished).toBe(true);
    expect(String(fetchMock.mock.calls[1][0])).toContain("/rest/v1/rpc/finish_portfolio_sync_v2");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      p_status: "skipped_degraded",
      p_quality_status: "rejected",
      p_publish_current: false
    });
  });

  it("reads the latest rejected candidate for collapse confirmation", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{
      completed_at: "2026-08-22T00:15:00.000Z",
      detail: {
        candidate: { netWorthUsd: 10, sources: [{ id: "binance", valueUsd: 10, itemCount: 1 }] },
        collapseConfirmationCount: 2
      }
    }]));

    const rejection = await readLatestPortfolioRejection("current-15m");

    expect(rejection).toMatchObject({
      completedAt: "2026-08-22T00:15:00.000Z",
      confirmationCount: 2,
      candidate: { netWorthUsd: 10 }
    });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("detail->>mode")).toBe("eq.current-15m");
  });

  it("does not count a non-collapse rejection as a quarantine confirmation", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{
      completed_at: "2026-08-22T00:15:00.000Z",
      detail: {
        candidate: { netWorthUsd: 10, sources: [{ id: "binance", valueUsd: 10, itemCount: 1 }] },
        collapseConfirmationCount: 0
      }
    }]));

    await expect(readLatestPortfolioRejection()).resolves.toBeNull();
  });

  it("returns only sanitized reason codes and source ids for the latest sync", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{
      completed_at: "2026-09-05T09:17:48.103Z",
      status: "skipped_degraded",
      detail: {
        quality: {
          reasons: [
            { code: "value-collapse", sourceId: "debank", message: "private detail" },
            { code: "value-collapse", sourceId: "bitget" },
            { code: "value-collapse", sourceId: "../unsafe" }
          ]
        },
        errors: [{ token: "do-not-return" }]
      }
    }]));

    const summary = await readLatestPortfolioSyncSummary();

    expect(summary).toEqual({
      completedAt: "2026-09-05T09:17:48.103Z",
      status: "skipped_degraded",
      rejectedSources: ["debank", "bitget"],
      reasonCodes: ["value-collapse"]
    });
    expect(JSON.stringify(summary)).not.toContain("private detail");
    expect(JSON.stringify(summary)).not.toContain("do-not-return");
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("detail->>mode")).toBe("eq.daily-full");
  });

  it("classifies a confirmed complete-value collapse for manual review", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{
      completed_at: "2026-09-06T00:30:00.000Z",
      status: "skipped_degraded",
      detail: {
        quality: {
          reasons: [{ code: "value-collapse", sourceId: "gate", message: "private" }],
          collapseReadyForReview: true
        },
        candidate: {
          netWorthUsd: 80,
          sources: [{ id: "gate", valueUsd: 10, itemCount: 2 }]
        },
        collapseConfirmationCount: 3,
        sources: [{ id: "gate", name: "Private label", status: "live", valueUsd: 10 }],
        errors: [{ message: "do-not-return" }]
      }
    }]));
    const current = {
      ...snapshot(),
      sources: [{
        id: "gate",
        name: "Gate",
        kind: "exchange" as const,
        status: "live" as const,
        valueUsd: 100,
        itemCount: 3,
        updatedAt: "2026-09-05T00:00:00.000Z",
        detail: "complete"
      }]
    };

    const attempt = await readLatestPortfolioAttempt(current);

    expect(attempt).toEqual({
      completedAt: "2026-09-06T00:30:00.000Z",
      status: "review-required",
      reasonCodes: ["value-collapse"],
      confirmationCount: 3,
      reviewReady: true,
      candidateNetWorthUsd: 80,
      previousNetWorthUsd: 100,
      affectedSources: [{
        id: "gate",
        name: "Gate",
        status: "live",
        previousValueUsd: 100,
        candidateValueUsd: 10,
        deltaUsd: -90,
        deltaPercent: -90
      }]
    });
    expect(JSON.stringify(attempt)).not.toContain("private");
    expect(JSON.stringify(attempt)).not.toContain("do-not-return");
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("detail->>mode")).toBe("eq.current-15m");
    expect(url.searchParams.get("completed_at")).toBe("not.is.null");
  });

  it("does not make an incomplete provider attempt manually acceptable", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{
      completed_at: "2026-09-06T00:30:00.000Z",
      status: "skipped_degraded",
      detail: {
        quality: {
          reasons: [{ code: "incomplete-source", sourceId: "gate" }],
          collapseReadyForReview: true
        },
        candidate: {
          netWorthUsd: 80,
          sources: [{ id: "gate", valueUsd: 10, itemCount: 1 }]
        },
        collapseConfirmationCount: 3,
        sources: [{ id: "gate", status: "partial", valueUsd: 10 }]
      }
    }]));

    const attempt = await readLatestPortfolioAttempt({
      ...snapshot(),
      sources: [{
        id: "gate",
        name: "Gate",
        kind: "exchange",
        status: "live",
        valueUsd: 100,
        itemCount: 3,
        updatedAt: "2026-09-05T00:00:00.000Z",
        detail: "complete"
      }]
    });

    expect(attempt).toMatchObject({
      status: "source-incomplete",
      reviewReady: false,
      affectedSources: [{ id: "gate", status: "partial" }]
    });
  });

  it("reports latest attempt, latest success, and an overdue attempt without raw detail", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get("status") === "eq.success") {
        return jsonResponse([{ completed_at: "2026-09-04T00:01:00.000Z" }]);
      }
      return jsonResponse([{
        started_at: "2026-09-05T00:00:00.000Z",
        completed_at: "2026-09-05T00:01:00.000Z",
        status: "skipped_degraded",
        detail: {
          mode: "current-15m",
          quality: { reasons: [{ code: "value-collapse", sourceId: "gate", message: "private" }] },
          token: "do-not-return"
        }
      }]);
    });

    const monitor = await readPortfolioSyncMonitor(new Date("2026-09-06T03:00:00.000Z"));

    expect(monitor).toEqual({
      lastAttemptAt: "2026-09-05T00:00:00.000Z",
      lastSuccessfulAt: "2026-09-04T00:01:00.000Z",
      attemptLagHours: 27,
      isAttemptOverdue: true,
      latest: {
        completedAt: "2026-09-05T00:01:00.000Z",
        status: "skipped_degraded",
        rejectedSources: ["gate"],
        reasonCodes: ["value-collapse"]
      }
    });
    expect(JSON.stringify(monitor)).not.toContain("private");
    expect(JSON.stringify(monitor)).not.toContain("do-not-return");
    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
    const latestUrl = urls.find((url) => !url.searchParams.has("status"))!;
    const successUrl = urls.find((url) => url.searchParams.get("status") === "eq.success")!;
    expect(latestUrl.searchParams.has("detail->>mode")).toBe(false);
    expect(latestUrl.searchParams.get("limit")).toBe("1");
    expect(successUrl.searchParams.get("completed_at")).toBe("not.is.null");
  });

  it("reads the latest success independently after many rejected attempts", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      return url.searchParams.get("status") === "eq.success"
        ? jsonResponse([{ completed_at: "2026-10-01T03:37:01.000Z" }])
        : jsonResponse([{
            started_at: "2026-10-03T12:22:00.000Z",
            completed_at: "2026-10-03T12:22:03.000Z",
            status: "skipped_degraded",
            detail: { quality: { reasons: [{ code: "value-collapse", sourceId: "okx" }] } }
          }]);
    });

    const monitor = await readPortfolioSyncMonitor(new Date("2026-10-03T12:35:00.000Z"));

    expect(monitor.lastSuccessfulAt).toBe("2026-10-01T03:37:01.000Z");
    expect(monitor.latest?.reasonCodes).toEqual(["value-collapse"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("filters reports at the database instead of scanning recent value-sync runs", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{
      completed_at: "2026-08-22T01:15:00.000Z",
      detail: {
        portfolioReport: {
          date: "2026-08-22",
          summary: "Daily baseline.",
          alerts: [],
          currentUsd: 100,
          deltaUsd: null,
          deltaPercent: null,
          generator: "rules",
          model: null
        }
      }
    }]));

    const report = await readLatestPortfolioReport();

    expect(report?.summary).toBe("Daily baseline.");
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("detail->portfolioReport")).toBe("not.is.null");
    expect(url.searchParams.get("limit")).toBe("1");
  });
});

function row() {
  return {
    captured_at: "2026-08-22T00:07:00.000Z",
    snapshot: snapshot()
  };
}

function snapshot(): LivePortfolioSnapshot {
  return {
    generatedAt: "2026-08-22T00:07:00.000Z",
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

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
