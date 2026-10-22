import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo-mode";
import { demoHeaders, demoHealth } from "@/lib/server/demo-fixtures";
import type { LiveSource } from "@/lib/live-portfolio";
import { getManualSourceFreshness } from "@/lib/source-freshness";
import {
  readLatestPortfolioSnapshot,
  readMonthlyDeBankUsage,
  readPortfolioSyncMonitor
} from "@/lib/server/portfolio-snapshot-store";
import { privateNoStoreHeaders, requireViewerJson } from "@/lib/server/viewer-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const estimatedFullScanUnits = 1_109;
const totalBalanceUnitsPerWallet = 30;
const valuationWalletsPerDay = 2;
const monthlyWarningUnits = 5_000;
const monthlyHardStopUnits = 10_000;
const usdPerMillionUnits = 200;
const standardPackageUnits = 1_000_000;
const cexFreshHours = 45 / 60;
const sourceFallbackHours = 24;
const debankValueFreshHours = 8 * 24;
const debankValueUsableHours = 14 * 24;
const debankCompositionFreshHours = 35 * 24;
const debankCompositionUsableHours = 45 * 24;

function sourceHealth(source: LiveSource, snapshotCapturedAt: string, now: string) {
  const valueUpdatedAt = source.valueUpdatedAt ?? source.fallback?.lastGoodAt ?? source.updatedAt;
  const ageMs = Date.parse(now) - Date.parse(valueUpdatedAt);
  const fallbackAgeHours = Number.isFinite(ageMs)
    ? Math.round(Math.max(0, ageMs) / 3_600_000 * 10) / 10
    : null;
  const isDeBank = source.id === "debank";
  const cadence = source.cadence ?? (isDeBank ? "daily" : source.kind === "bank" ? "manual" : "15m");
  const compositionUpdatedAt = source.compositionUpdatedAt ?? snapshotCapturedAt;
  const compositionAgeMs = Date.parse(now) - Date.parse(compositionUpdatedAt);
  const compositionAgeHours = Number.isFinite(compositionAgeMs)
    ? Math.max(0, compositionAgeMs) / 3_600_000
    : Number.POSITIVE_INFINITY;
  const freshnessState = source.status === "error" || fallbackAgeHours === null
    ? "stale"
    : isDeBank
      ? fallbackAgeHours <= debankValueFreshHours && compositionAgeHours <= debankCompositionFreshHours
        ? "fresh"
        : fallbackAgeHours <= debankValueUsableHours && compositionAgeHours <= debankCompositionUsableHours
          ? "late"
          : "stale"
      : cadence === "manual"
        ? getManualSourceFreshness(source.status, fallbackAgeHours)
        : fallbackAgeHours <= cexFreshHours
          ? "fresh"
          : fallbackAgeHours <= sourceFallbackHours ? "late" : "stale";
  return {
    id: source.id,
    name: source.name,
    status: source.status,
    cadence,
    valueUpdatedAt,
    compositionUpdatedAt,
    freshnessState,
    usingFallback: Boolean(source.fallback),
    nextScheduledAt: getNextScheduledAt(cadence, now),
    fallbackAgeHours,
    ...(source.pricing ? { pricing: source.pricing } : {})
  };
}

function getNextScheduledAt(cadence: "15m" | "daily" | "manual", now: string) {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp) || cadence === "manual") return null;
  if (cadence === "15m") {
    return new Date(Math.floor(timestamp / 900_000) * 900_000 + 900_000).toISOString();
  }
  const taipeiDate = new Date(timestamp + 8 * 3_600_000).toISOString().slice(0, 10);
  let target = Date.parse(`${taipeiDate}T00:30:00.000Z`);
  if (target <= timestamp) target += 24 * 3_600_000;
  return new Date(target).toISOString();
}

export async function GET(request: Request) {
  const denied = await requireViewerJson(request);
  if (denied) return denied;
  if (isDemoMode()) return NextResponse.json(demoHealth(), { headers: demoHeaders });
  try {
    const [current, sync, monthly] = await Promise.all([
      readLatestPortfolioSnapshot(),
      readPortfolioSyncMonitor(),
      readMonthlyDeBankUsage()
    ]);
    if (!current) {
      return NextResponse.json({ error: "Portfolio health is not ready" }, { status: 503, headers: privateNoStoreHeaders });
    }

    const taipeiNow = new Date(Date.now() + 8 * 3_600_000);
    const year = taipeiNow.getUTCFullYear();
    const monthIndex = taipeiNow.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    const elapsedDays = Math.max(1, taipeiNow.getUTCDate());
    const walletCount = current.snapshot.wallets?.length || 12;
    const dailyValuationUnits = valuationWalletsPerDay * totalBalanceUnitsPerWallet;
    const remainingValuationDays = Math.max(0, daysInMonth - elapsedDays);
    const pendingMonthlyFullScanUnits = monthly.fullScanCount === 0 && elapsedDays <= 1
      ? estimatedFullScanUnits
      : 0;
    const projectedUnits = monthly.estimatedUnits + remainingValuationDays * dailyValuationUnits + pendingMonthlyFullScanUnits;
    const projectedCostUsd = Math.round(projectedUnits / 1_000_000 * usdPerMillionUnits * 100) / 100;
    const projectedAnnualUnits = 365 * dailyValuationUnits + 12 * estimatedFullScanUnits;
    const standardPackageLifetimeYears = Math.round(standardPackageUnits / projectedAnnualUnits * 10) / 10;

    const generatedAt = new Date().toISOString();
    return NextResponse.json({
      generatedAt,
      compositionUpdatedAt: current.captured_at,
      sources: current.snapshot.sources.map((source) => sourceHealth(source, current.captured_at, generatedAt)),
      sync,
      debankBudget: {
        month: monthly.month,
        scanCount: monthly.scanCount,
        valuationScanCount: monthly.valuationScanCount,
        fullScanCount: monthly.fullScanCount,
        providerRequestCount: monthly.requestCount,
        estimatedUnitsUsed: monthly.estimatedUnits,
        totalBalanceUnitsPerWallet,
        valuationWalletsPerDay,
        walletCoverageDays: Math.ceil(walletCount / valuationWalletsPerDay),
        dailyValuationUnits,
        estimatedFullScanUnits,
        projectedUnits,
        projectedCostUsd,
        projectedAnnualUnits,
        standardPackageLifetimeYears,
        monthlyWarningUnits,
        monthlyHardStopUnits,
        withinBudget: projectedUnits <= monthlyHardStopUnits,
        warning: projectedUnits > monthlyWarningUnits
      }
    }, {
      headers: privateNoStoreHeaders
    });
  } catch {
    return NextResponse.json({ error: "Portfolio health is temporarily unavailable" }, { status: 503, headers: privateNoStoreHeaders });
  }
}
