import { NextResponse } from "next/server";
import { getTaipeiDate, snapshotToHistoryPoint } from "@/lib/portfolio-history";
import { VALUATION_BASIS } from "@/lib/valuation-basis";
import {
  evaluatePortfolioSnapshot,
  getPortfolioCollapseConfirmation,
  summarizePortfolioCandidate,
  type PortfolioQualityEvaluation
} from "@/lib/portfolio-snapshot-policy";
import { isCronRequestAuthorized } from "@/lib/server/cron-auth";
import { getLivePortfolioCandidate, type LivePortfolioCandidate } from "@/lib/server/live-portfolio";
import { generatePortfolioReport } from "@/lib/server/portfolio-report";
import { logPortfolioSync, sanitizePortfolioSyncError } from "@/lib/server/portfolio-sync-log";
import {
  claimPortfolioSync,
  finishPortfolioSync,
  hasPortfolioSyncAttempt,
  isPortfolioSnapshotStorageConfigured,
  readLatestPortfolioReport,
  readLatestPortfolioRejection,
  readLatestPortfolioSnapshot,
  readMonthlyDeBankUsage,
  readPreviousDailySnapshot,
  type PortfolioSyncClaim
} from "@/lib/server/portfolio-snapshot-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const debankMonthlyWarningUnits = 5_000;
const debankMonthlyHardStopUnits = 10_000;
const debankMaxSingleAttemptUnits = 1_500;
const debankRotatingValuationUnits = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Cron is not configured" }, { status: 503 });
  }
  if (!isCronRequestAuthorized(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isPortfolioSnapshotStorageConfigured()) {
    return NextResponse.json(
      { error: "Portfolio snapshot storage is not configured" },
      { status: 424 }
    );
  }

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const searchParams = new URL(request.url).searchParams;
  const acceptConfirmedCollapse = searchParams.get("acceptCollapse") === "1";
  const forceFull = searchParams.get("forceFull") === "1";
  const taipeiDate = getTaipeiDate(startedAt);
  const debankSyncMode = forceFull || taipeiDate.endsWith("-01") ? "full" : "valuation";
  const paidJobKey = forceFull
    ? `debank-full-manual:${taipeiDate}`
    : `debank-daily:${taipeiDate}`;
  const reservedAttemptUnits = debankSyncMode === "full"
    ? debankMaxSingleAttemptUnits
    : debankRotatingValuationUnits;
  let claim: PortfolioSyncClaim | null = null;

  try {
    const [alreadyAttempted, monthlyUsage] = await Promise.all([
      hasPortfolioSyncAttempt(paidJobKey),
      readMonthlyDeBankUsage()
    ]);
    // Unlike the shared claim RPC, a paid DeBank run is attempt-once: a
    // degraded or failed result must still close the Taipei-day budget gate.
    if (alreadyAttempted) {
      return NextResponse.json({
        ok: true,
        mode: "daily-full",
        status: "already_completed"
      });
    }
    // Reserve the worst-case allowance before opening the provider. Paid
    // scans stop before the protected 10k-unit monthly ceiling.
    if (monthlyUsage.estimatedUnits + reservedAttemptUnits > debankMonthlyHardStopUnits) {
      logPortfolioSync("warn", "debank_budget_paused", {
        month: monthlyUsage.month,
        estimatedUnits: monthlyUsage.estimatedUnits,
        hardStopUnits: debankMonthlyHardStopUnits
      });
      return NextResponse.json({
        ok: true,
        mode: "daily-full",
        status: "budget_paused",
        month: monthlyUsage.month,
        estimatedUnitsUsed: monthlyUsage.estimatedUnits,
        monthlyHardStopUnits: debankMonthlyHardStopUnits
      });
    }
    if (monthlyUsage.estimatedUnits + reservedAttemptUnits > debankMonthlyWarningUnits) {
      logPortfolioSync("warn", "debank_budget_warning", {
        month: monthlyUsage.month,
        estimatedUnits: monthlyUsage.estimatedUnits,
        warningUnits: debankMonthlyWarningUnits,
        hardStopUnits: debankMonthlyHardStopUnits
      });
    }
    claim = await claimPortfolioSync({
      jobKey: paidJobKey,
      syncKind: debankSyncMode === "full" ? "full" : "value",
      trigger: acceptConfirmedCollapse || forceFull ? "manual" : "cron",
      startedAt,
      leaseSeconds: 180
    });
    if (!claim.claimed) {
      logPortfolioSync("info", "sync_not_claimed", {
        mode: "daily-full",
        reason: claim.reason,
        activeRunId: claim.runId
      });
      return NextResponse.json({
        ok: true,
        mode: "daily-full",
        status: claim.reason
      }, { status: claim.reason === "already_running" ? 202 : 200 });
    }
    assertClaimLease(claim);

    logPortfolioSync("info", "sync_started", { mode: "daily-full", runId: claim.runId });
    const latest = await readLatestPortfolioSnapshot();
    const { snapshot, sourcePayloads, providerUsage } = await getLivePortfolioCandidate({
      mode: debankSyncMode,
      baselineSnapshot: latest?.snapshot ?? null
    });
    const evaluatedQuality = evaluatePortfolioSnapshot(snapshot, latest?.snapshot ?? null);
    const candidate = summarizePortfolioCandidate(snapshot);
    const hasCurrentValuationBasis = snapshot.valuationBasis === VALUATION_BASIS;
    const collapseConfirmation = hasCurrentValuationBasis
      ? await getCollapseConfirmation(evaluatedQuality, candidate)
      : { confirmed: false, count: 0 };
    const confirmedCollapseAccepted = collapseConfirmation.confirmed && acceptConfirmedCollapse;
    const quality: PortfolioQualityEvaluation = !hasCurrentValuationBasis
      ? {
          accepted: false,
          status: "rejected",
          reasons: [{ code: "valuation-basis-incomplete" }]
        }
      : confirmedCollapseAccepted
        ? { accepted: true, status: "complete", reasons: [] }
        : evaluatedQuality;

    if (!quality.accepted) {
      const finished = await finishPortfolioSync({
        runId: claim.runId,
        leaseToken: claim.leaseToken,
        completedAt: new Date().toISOString(),
        status: "skipped_degraded",
        durationMs: Date.now() - started,
        snapshot,
        qualityStatus: "rejected",
        publishCurrent: false,
        writeValue: false,
        writeFull: false,
        sourcePayloads,
        detail: buildDetail(snapshot, quality, {
          candidate,
          debankSyncMode,
          providerUsage,
          collapseConfirmationCount: collapseConfirmation.count,
          collapseReadyForReview: collapseConfirmation.confirmed,
          dailyReportStatus: "skipped-quality-gate"
        })
      });
      if (!finished) throw new Error("Portfolio sync lease expired before completion");
      logPortfolioSync("warn", "snapshot_rejected", {
        mode: "daily-full",
        runId: claim.runId,
        reasons: quality.reasons
      });
      return NextResponse.json({
        ok: true,
        mode: "daily-full",
        status: "skipped_degraded",
        preservedLastKnownGood: true,
        generatedAt: snapshot.generatedAt,
        sourceCount: snapshot.connectedSourceCount,
        errorCount: snapshot.errors.length,
        debankSyncMode,
        providerUsage,
        dailyReport: "skipped-quality-gate",
        reasons: quality.reasons,
        collapseReadyForReview: collapseConfirmation.confirmed
      });
    }

    if (quality.status === "degraded") {
      const detail = buildDetail(snapshot, quality, {
        candidate,
        debankSyncMode,
        providerUsage,
        collapseConfirmationCount: collapseConfirmation.count,
        collapseReadyForReview: false,
        dailyReportStatus: "skipped-source-fallback"
      });
      const finished = await finishPortfolioSync({
        runId: claim.runId,
        leaseToken: claim.leaseToken,
        completedAt: new Date().toISOString(),
        status: "partial",
        durationMs: Date.now() - started,
        snapshot,
        qualityStatus: "degraded",
        publishCurrent: true,
        writeValue: false,
        writeFull: false,
        sourcePayloads,
        detail
      });
      if (!finished) throw new Error("Portfolio sync lease expired before degraded publication");
      return NextResponse.json({
        ok: true,
        mode: "daily-full",
        status: "partial",
        generatedAt: snapshot.generatedAt,
        netWorthUsd: snapshot.netWorthUsd,
        sourceCount: snapshot.connectedSourceCount,
        errorCount: snapshot.errors.length,
        fallbackSourceCount: snapshot.sources.filter((source) => source.fallback).length,
        debankSyncMode,
        providerUsage,
        dailyReport: "skipped-source-fallback"
      });
    }

    const dailyReport = await maybeGenerateDailyReport(snapshot);
    const detail = buildDetail(snapshot, quality, {
      candidate,
      debankSyncMode,
      providerUsage,
      collapseConfirmationCount: collapseConfirmation.count,
      collapseReadyForReview: collapseConfirmation.confirmed,
      confirmedCollapseAccepted,
      originalReasons: confirmedCollapseAccepted ? evaluatedQuality.reasons : undefined,
      ...(dailyReport.report ? { portfolioReport: dailyReport.report } : {}),
      dailyReportStatus: dailyReport.status
    });
    const finished = await finishPortfolioSync({
      runId: claim.runId,
      leaseToken: claim.leaseToken,
      completedAt: new Date().toISOString(),
      status: "success",
      durationMs: Date.now() - started,
      snapshot,
      qualityStatus: "complete",
      publishCurrent: true,
      writeValue: false,
      writeFull: true,
      sourcePayloads,
      detail
    });
    if (!finished) throw new Error("Portfolio sync lease expired before publication");
    logPortfolioSync("info", "snapshot_published", {
      mode: "daily-full",
      runId: claim.runId,
      durationMs: Date.now() - started,
      sourceCount: snapshot.connectedSourceCount,
      dailyReport: dailyReport.status
    });
    return NextResponse.json({
      ok: true,
      mode: "daily-full",
      status: "success",
      generatedAt: snapshot.generatedAt,
      netWorthUsd: snapshot.netWorthUsd,
      sourceCount: snapshot.connectedSourceCount,
      errorCount: 0,
      debankSyncMode,
      providerUsage,
      dailyReport: dailyReport.status
    });
  } catch (error) {
    const message = sanitizePortfolioSyncError(error, "Scheduled portfolio sync failed");
    if (claim?.claimed && claim.runId !== null && claim.leaseToken) {
      try {
        const failureRecorded = await finishPortfolioSync({
          runId: claim.runId,
          leaseToken: claim.leaseToken,
          completedAt: new Date().toISOString(),
          status: "failed",
          durationMs: Date.now() - started,
          snapshot: null,
          qualityStatus: "rejected",
          publishCurrent: false,
          writeValue: false,
          writeFull: false,
          detail: { mode: "daily-full", message }
        });
        if (!failureRecorded) {
          logPortfolioSync("error", "sync_failure_record_failed", {
            mode: "daily-full",
            runId: claim.runId,
            message: "Sync lease no longer belongs to this worker"
          });
        }
      } catch (finishError) {
        logPortfolioSync("error", "sync_failure_record_failed", {
          mode: "daily-full",
          runId: claim.runId,
          message: sanitizePortfolioSyncError(finishError, "Sync failure could not be recorded")
        });
      }
    }
    logPortfolioSync("error", "sync_failed", {
      mode: "daily-full",
      runId: claim?.runId ?? null,
      message
    });
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

async function maybeGenerateDailyReport(
  snapshot: LivePortfolioCandidate["snapshot"]
) {
  try {
    const current = snapshotToHistoryPoint(snapshot);
    const latestReport = await readLatestPortfolioReport();
    if (latestReport?.date === current.date) {
      return { status: "already-generated" as const, report: null };
    }
    const previousDailySnapshot = await readPreviousDailySnapshot(snapshot);
    const report = await generatePortfolioReport(current, previousDailySnapshot);
    return { status: "generated" as const, report };
  } catch {
    // Snapshot publication is the primary job. Report outages must not create gaps.
    return { status: "unavailable" as const, report: null };
  }
}

function buildDetail(
  snapshot: LivePortfolioCandidate["snapshot"],
  quality: PortfolioQualityEvaluation,
  extra: Record<string, unknown>
) {
  return {
    mode: "daily-full",
    quality,
    sources: snapshot.sources.map((source) => ({
      id: source.id,
      name: source.name,
      status: source.status,
      updatedAt: source.updatedAt,
      valueUsd: source.valueUsd
    })),
    errors: snapshot.errors,
    ...extra
  };
}

function assertClaimLease(
  claim: PortfolioSyncClaim
): asserts claim is PortfolioSyncClaim & { runId: number; leaseToken: string } {
  if (!Number.isFinite(claim.runId) || !claim.leaseToken) {
    throw new Error("Portfolio sync claim did not return a lease");
  }
}

async function getCollapseConfirmation(
  evaluation: PortfolioQualityEvaluation,
  candidate: ReturnType<typeof summarizePortfolioCandidate>
) {
  if (
    evaluation.accepted ||
    evaluation.reasons.some((reason) => reason.code !== "value-collapse")
  ) {
    return { confirmed: false, count: 0 };
  }
  const previous = await readLatestPortfolioRejection("daily-full").catch((error) => {
    logPortfolioSync("warn", "collapse_confirmation_read_failed", {
      mode: "daily-full",
      message: sanitizePortfolioSyncError(error, "Previous rejection could not be read")
    });
    return null;
  });
  return getPortfolioCollapseConfirmation({ evaluation, candidate, previous });
}
