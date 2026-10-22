import { NextResponse } from "next/server";
import { VALUATION_BASIS } from "@/lib/valuation-basis";
import {
  evaluatePortfolioSnapshot,
  getPortfolioCollapseConfirmation,
  summarizePortfolioCandidate,
  type PortfolioQualityEvaluation
} from "@/lib/portfolio-snapshot-policy";
import { isCronRequestAuthorized } from "@/lib/server/cron-auth";
import { getLivePortfolioCandidate } from "@/lib/server/live-portfolio";
import { logPortfolioSync, sanitizePortfolioSyncError } from "@/lib/server/portfolio-sync-log";
import {
  claimPortfolioSync,
  finishPortfolioSync,
  isPortfolioSnapshotStorageConfigured,
  readLatestPortfolioRejection,
  readLatestPortfolioSnapshot,
  type PortfolioSyncClaim
} from "@/lib/server/portfolio-snapshot-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

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
  const manualRequest = acceptConfirmedCollapse || searchParams.get("manual") === "1";
  let claim: PortfolioSyncClaim | null = null;

  try {
    claim = await claimPortfolioSync({
      jobKey: manualRequest
        ? getManualJobKey(startedAt, acceptConfirmedCollapse ? "accept" : "retry")
        : getValueJobKey(startedAt),
      syncKind: "value",
      trigger: manualRequest ? "manual" : "cron",
      startedAt,
      leaseSeconds: 180
    });
    if (!claim.claimed) {
      logPortfolioSync("info", "sync_not_claimed", {
        mode: "current-15m",
        reason: claim.reason,
        activeRunId: claim.runId
      });
      return NextResponse.json({
        ok: true,
        mode: "current-15m",
        status: claim.reason
      }, { status: claim.reason === "already_running" ? 202 : 200 });
    }
    assertClaimLease(claim);

    logPortfolioSync("info", "sync_started", {
      mode: "current-15m",
      runId: claim.runId
    });
    const latest = await readLatestPortfolioSnapshot();
    const { snapshot, sourcePayloads, providerUsage } = await getLivePortfolioCandidate({
      mode: "current",
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
    const detail = {
      mode: "current-15m",
      quality: {
        ...quality,
        collapseReadyForReview: collapseConfirmation.confirmed,
        confirmedCollapseAccepted,
        originalReasons: confirmedCollapseAccepted ? evaluatedQuality.reasons : undefined
      },
      candidate,
      collapseConfirmationCount: collapseConfirmation.count,
      providerUsage,
      sources: snapshot.sources.map((source) => ({
        id: source.id,
        name: source.name,
        status: source.status,
        updatedAt: source.updatedAt,
        valueUsd: source.valueUsd
      })),
      errors: snapshot.errors
    };

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
        detail
      });
      if (!finished) throw new Error("Portfolio sync lease expired before completion");
      logPortfolioSync("warn", "snapshot_rejected", {
        mode: "current-15m",
        runId: claim.runId,
        reasons: quality.reasons
      });
      return NextResponse.json({
        ok: true,
        mode: "current-15m",
        status: "skipped_degraded",
        preservedLastKnownGood: true,
        generatedAt: snapshot.generatedAt,
        sourceCount: snapshot.connectedSourceCount,
        errorCount: snapshot.errors.length,
        providerUsage,
        reasons: quality.reasons,
        collapseReadyForReview: collapseConfirmation.confirmed
      }, { status: acceptConfirmedCollapse ? 409 : 200 });
    }

    const usesFallback = quality.status === "degraded";
    const finished = await finishPortfolioSync({
      runId: claim.runId,
      leaseToken: claim.leaseToken,
      completedAt: new Date().toISOString(),
      status: usesFallback ? "partial" : "success",
      durationMs: Date.now() - started,
      snapshot,
      qualityStatus: quality.status,
      publishCurrent: true,
      writeValue: !usesFallback,
      // Persist the existing provider data as a baseline without a paid full scan.
      writeFull: manualRequest && !usesFallback && snapshot.valuationBasis === VALUATION_BASIS,
      sourcePayloads,
      detail
    });
    if (!finished) throw new Error("Portfolio sync lease expired before publication");
    logPortfolioSync("info", "snapshot_published", {
      mode: "current-15m",
      runId: claim.runId,
      durationMs: Date.now() - started,
      sourceCount: snapshot.connectedSourceCount
    });
    return NextResponse.json({
      ok: true,
      mode: "current-15m",
      status: usesFallback ? "partial" : "success",
      generatedAt: snapshot.generatedAt,
      sourceCount: snapshot.connectedSourceCount,
      errorCount: snapshot.errors.length,
      providerUsage,
      fallbackSourceCount: snapshot.sources.filter((source) => source.fallback).length
    });
  } catch (error) {
    const message = sanitizePortfolioSyncError(error, "Portfolio current sync failed");
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
          detail: { mode: "current-15m", message }
        });
        if (!failureRecorded) {
          logPortfolioSync("error", "sync_failure_record_failed", {
            mode: "current-15m",
            runId: claim.runId,
            message: "Sync lease no longer belongs to this worker"
          });
        }
      } catch (finishError) {
        logPortfolioSync("error", "sync_failure_record_failed", {
          mode: "current-15m",
          runId: claim.runId,
          message: sanitizePortfolioSyncError(finishError, "Sync failure could not be recorded")
        });
      }
    }
    logPortfolioSync("error", "sync_failed", {
      mode: "current-15m",
      runId: claim?.runId ?? null,
      message
    });
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

function getValueJobKey(startedAt: string) {
  const timestamp = new Date(startedAt).getTime();
  const bucket = new Date(Math.floor(timestamp / 900_000) * 900_000).toISOString();
  return `portfolio:value:${bucket}`;
}

function getManualJobKey(startedAt: string, action: "retry" | "accept") {
  const timestamp = new Date(startedAt).getTime();
  const bucket = new Date(Math.floor(timestamp / 300_000) * 300_000).toISOString();
  return `portfolio:manual:${action}:${bucket}`;
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
  const previous = await readLatestPortfolioRejection("current-15m").catch((error) => {
    logPortfolioSync("warn", "collapse_confirmation_read_failed", {
      mode: "current-15m",
      message: sanitizePortfolioSyncError(error, "Previous rejection could not be read")
    });
    return null;
  });
  return getPortfolioCollapseConfirmation({ evaluation, candidate, previous });
}
