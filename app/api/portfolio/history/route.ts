import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo-mode";
import { demoHeaders, demoPortfolioHistory } from "@/lib/server/demo-fixtures";
import { publicReadHeaders } from "@/lib/server/public-read-headers";
import { privateNoStoreHeaders, requireViewerJson } from "@/lib/server/viewer-auth";
import type { PortfolioHistoryInterval } from "@/lib/portfolio-history";
import {
  readLatestPortfolioReport,
  readLatestPortfolioSnapshot,
  readPortfolioHistory
} from "@/lib/server/portfolio-snapshot-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = await requireViewerJson(request);
  if (denied) return denied;
  const startedAt = performance.now();
  const url = new URL(request.url);
  const interval: PortfolioHistoryInterval = url.searchParams.get("interval") === "hourly"
    ? "hourly"
    : "daily";
  const daysParam = url.searchParams.get("days");
  const requestedDays = daysParam === null ? Number.NaN : Number(daysParam);
  const defaultDays = interval === "hourly" ? 7 : 365;
  const minimumDays = interval === "hourly" ? 1 : 7;
  const maximumDays = interval === "hourly" ? 90 : 730;
  const days = Number.isFinite(requestedDays)
    ? Math.min(maximumDays, Math.max(minimumDays, Math.round(requestedDays)))
    : defaultDays;
  if (isDemoMode()) return NextResponse.json(demoPortfolioHistory(interval, days), { headers: demoHeaders });

  try {
    const [points, storedReport, current] = await Promise.all([
      readPortfolioHistory(days, interval),
      readLatestPortfolioReport().catch(() => null),
      readLatestPortfolioSnapshot().catch(() => null)
    ]);
    const latestCompleteDate = points.filter((point) => !point.isPartial).at(-1)?.date;
    const latestReport = storedReport?.date === latestCompleteDate ? storedReport : null;
    return NextResponse.json(
      {
        configured: true,
        interval,
        points,
        latestReport,
        latestObservation: current ? {
          capturedAt: current.captured_at,
          quality: current.snapshot.isPartial ? "degraded" : "complete",
          hasPerformanceGap: current.snapshot.isPartial,
          staleSourceIds: current.snapshot.sources
            .filter((source) => source.freshnessState === "stale" || source.freshnessState === "late" || source.status === "error")
            .map((source) => source.id)
        } : null
      },
      { headers: publicReadHeaders(startedAt, 60) }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Portfolio history is unavailable";
    return NextResponse.json({ error: message.slice(0, 160) }, { status: 503, headers: privateNoStoreHeaders });
  }
}
