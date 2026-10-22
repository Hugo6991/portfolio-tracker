import { NextResponse } from "next/server";
import { isCronRequestAuthorized } from "@/lib/server/cron-auth";
import { syncCexSources } from "@/lib/server/cex-sources";
import {
  CEX_SNAPSHOT_WRITER_VERSION,
  claimCexSync,
  finishCexSync,
  isCexSnapshotStorageConfigured,
  readLatestCexSnapshots,
  writeCexSnapshots,
  type CexSyncClaim
} from "@/lib/server/cex-snapshot-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "Cron is not configured" }, { status: 503 });
  if (!isCronRequestAuthorized(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isCexSnapshotStorageConfigured()) {
    return NextResponse.json({ error: "CEX snapshot storage is not configured" }, { status: 424 });
  }

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const manualRequest = new URL(request.url).searchParams.get("manual") === "1";
  let claim: CexSyncClaim | null = null;
  try {
    claim = await claimCexSync({
      jobKey: getCexJobKey(startedAt, manualRequest),
      trigger: manualRequest ? "manual" : "cron",
      startedAt,
      leaseSeconds: 180
    });
    if (!claim.claimed) {
      return NextResponse.json({
        ok: true,
        status: claim.reason,
        generatedAt: startedAt,
        writerVersion: CEX_SNAPSHOT_WRITER_VERSION
      }, { status: claim.reason === "already_running" ? 202 : 200 });
    }

    const previous = await readLatestCexSnapshots();
    const snapshots = await syncCexSources(previous);
    const storage = await writeCexSnapshots(snapshots);
    const errorCount = snapshots.reduce((sum, snapshot) => sum + snapshot.errors.length, 0);
    const liveCount = snapshots.filter((snapshot) => snapshot.status === "live").length;
    const status = liveCount === snapshots.length && storage.written === snapshots.length
      ? "success"
      : storage.written > 0
        ? "partial"
        : "failed";
    const detail = {
      writerVersion: CEX_SNAPSHOT_WRITER_VERSION,
      sources: snapshots.map((snapshot) => ({
        exchange: snapshot.exchange,
        status: snapshot.status,
        capturedAt: snapshot.capturedAt,
        valueUsd: snapshot.valueUsd,
        itemCount: snapshot.itemCount,
        errors: snapshot.errors
      })),
      storage
    };
    const finished = await finishCexSync({
      claim,
      startedAt,
      completedAt: new Date().toISOString(),
      status,
      durationMs: Date.now() - started,
      detail
    });
    if (!finished) throw new Error("CEX sync lease expired before completion");
    return NextResponse.json({
      ok: status !== "failed",
      status,
      generatedAt: startedAt,
      liveCount,
      sourceCount: snapshots.length,
      errorCount,
      writerVersion: CEX_SNAPSHOT_WRITER_VERSION,
      storage
    }, { status: status === "failed" ? 503 : 200 });
  } catch {
    if (claim?.claimed) try {
      await finishCexSync({
        claim,
        startedAt,
        completedAt: new Date().toISOString(),
        status: "failed",
        durationMs: Date.now() - started,
        detail: { message: "CEX synchronization failed" }
      });
    } catch {
      // The sanitized primary failure is returned even if health logging is unavailable.
    }
    return NextResponse.json({ error: "CEX synchronization failed" }, { status: 503 });
  }
}

function getCexJobKey(startedAt: string, manual: boolean) {
  const timestamp = new Date(startedAt).getTime();
  const bucketMs = manual ? 300_000 : 900_000;
  const bucket = new Date(Math.floor(timestamp / bucketMs) * bucketMs).toISOString();
  return `cex:${manual ? "manual" : "scheduled"}:${bucket}`;
}
