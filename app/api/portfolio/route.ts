import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo-mode";
import { demoHeaders, demoPortfolioSnapshot } from "@/lib/server/demo-fixtures";
import type { LivePortfolioSnapshot } from "@/lib/live-portfolio";
import { portfolioOverview } from "@/lib/portfolio-overview";
import { publicReadHeaders } from "@/lib/server/public-read-headers";
import { privateNoStoreHeaders, requireViewerJson } from "@/lib/server/viewer-auth";
import { logPortfolioSync, sanitizePortfolioSyncError } from "@/lib/server/portfolio-sync-log";
import {
  getPortfolioSnapshotTtlSeconds,
  readLatestPortfolioAttemptRow,
  buildPortfolioAttempt,
  readLatestPortfolioSnapshot
} from "@/lib/server/portfolio-snapshot-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function cacheAgeSeconds(capturedAt: string) {
  const age = Date.now() - new Date(capturedAt).getTime();
  return Number.isFinite(age) ? Math.max(0, Math.round(age / 1000)) : Number.POSITIVE_INFINITY;
}

function withDelivery(
  snapshot: LivePortfolioSnapshot,
  mode: NonNullable<LivePortfolioSnapshot["delivery"]>["mode"],
  persisted: boolean,
  age: number | null,
  latestAttempt: NonNullable<LivePortfolioSnapshot["delivery"]>["latestAttempt"] = null
): LivePortfolioSnapshot {
  return {
    ...snapshot,
    delivery: {
      mode,
      persisted,
      cacheAgeSeconds: age,
      cacheTtlSeconds: getPortfolioSnapshotTtlSeconds(),
      latestAttempt
    }
  };
}

export async function GET(_request: Request) {
  const denied = await requireViewerJson(_request);
  if (denied) return denied;
  if (isDemoMode()) {
    const snapshot = demoPortfolioSnapshot();
    const overview = new URL(_request.url).searchParams.get("view") === "overview";
    return NextResponse.json(overview ? portfolioOverview(snapshot) : snapshot, { headers: demoHeaders });
  }
  const startedAt = performance.now();
  try {
    const [cached, attemptRow] = await Promise.all([
      readLatestPortfolioSnapshot(),
      readLatestPortfolioAttemptRow().catch((error) => {
        logPortfolioSync("warn", "snapshot_attempt_read_failed", {
          message: sanitizePortfolioSyncError(error, "Latest sync attempt could not be read")
        });
        return null;
      })
    ]);
    if (!cached) {
      logPortfolioSync("warn", "snapshot_unavailable");
      return NextResponse.json(
        { error: "Portfolio data is not ready yet. The background sync will retry automatically." },
        { status: 503, headers: { ...privateNoStoreHeaders, "Retry-After": "30" } }
      );
    }

    const cachedAge = cacheAgeSeconds(cached.captured_at);
    const mode = cachedAge <= getPortfolioSnapshotTtlSeconds() ? "cache" : "stale-cache";
    const latestAttempt = buildPortfolioAttempt(attemptRow, cached.snapshot);
    const snapshot = withDelivery(cached.snapshot, mode, true, cachedAge, latestAttempt);
    const overview = new URL(_request.url).searchParams.get("view") === "overview";
    return NextResponse.json(
      overview ? portfolioOverview(snapshot) : snapshot,
      {
        headers: {
          ...publicReadHeaders(startedAt, 30, _request),
          "X-Portfolio-Data": mode,
          "X-Portfolio-Age": String(cachedAge)
        }
      }
    );
  } catch (error) {
    const message = sanitizePortfolioSyncError(error, "Portfolio snapshot read failed");
    logPortfolioSync("error", "snapshot_read_failed", { message });
    return NextResponse.json(
      { error: "Portfolio data is temporarily unavailable. The background sync is still protected." },
      { status: 503, headers: { ...privateNoStoreHeaders, "Retry-After": "30" } }
    );
  }
}
