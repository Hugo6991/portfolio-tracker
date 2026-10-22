import {
  assetAllocationOrder,
  buildCryptoAssetAllocation,
  type AssetAllocationId
} from "./asset-allocation";
import type { LiveHolding, LivePortfolioSnapshot } from "./live-portfolio";
import { getTaipeiDate } from "./portfolio-history";

export type AssetHistoryValuesUsd = Record<AssetAllocationId, number>;

export type AssetHistorySourceQuality = "complete" | "partial";
export type AssetHistoryBreakdownQuality = "complete" | "reconciled" | "unavailable";
export type AssetHistorySeries = "total" | AssetAllocationId;

export type AssetHistoryPoint = {
  date: string;
  capturedAt: string;
  totalLiveCryptoUsd: number;
  totalInvestableUsd: number;
  valuesUsd: AssetHistoryValuesUsd;
  sourceQuality: AssetHistorySourceQuality;
  breakdownQuality: AssetHistoryBreakdownQuality;
  classifiedValueUsd: number;
  unclassifiedUsd: number;
  classificationCoveragePercent: number;
  /** Compatibility flag for clients that predate the split quality model. */
  isPartial: boolean;
};

export type AssetHistoryResponse = {
  configured: boolean;
  points: AssetHistoryPoint[];
};

export type AssetHistoryCalendarPoint = {
  date: string;
  point: AssetHistoryPoint | null;
};

type SnapshotRecord = Record<string, unknown>;
type UnknownRecord = Record<string, unknown>;

/**
 * Produces stable daily category keys for charting while accepting older stored
 * snapshots whose normalized holdings may be missing or less detailed.
 */
export function canonicalizeDailyAssetSnapshots(
  snapshots: readonly LivePortfolioSnapshot[]
): AssetHistoryPoint[] {
  return latestDailySnapshots(snapshots).map(({ date, capturedAt, snapshot }) => {
    const holdings = getLiveCryptoHoldings(snapshot);
    const allocation = buildCryptoAssetAllocation(holdings);
    const configuredTotal = finiteNumber(snapshot.liveValueUsd)
      ?? sumCryptoGroups(snapshot)
      ?? allocation.totalUsd;
    const totalLiveCryptoUsd = Math.max(0, configuredTotal);
    const valuesUsd = emptyValues();
    const hasStoredBreakdown = Array.isArray(snapshot.holdings);

    for (const group of allocation.groups) valuesUsd[group.id] = group.valueUsd;

    const difference = totalLiveCryptoUsd - allocation.totalUsd;
    if (difference > 0.01) valuesUsd.other += difference;
    const sourceQuality: AssetHistorySourceQuality = snapshot.isPartial === true
      ? "partial"
      : "complete";
    const breakdownQuality: AssetHistoryBreakdownQuality = (
      (!hasStoredBreakdown && totalLiveCryptoUsd > 0.01) || difference < -0.01
    )
      ? "unavailable"
      : difference > 0.01
        ? "reconciled"
        : "complete";

    return {
      date,
      capturedAt,
      totalLiveCryptoUsd,
      totalInvestableUsd: totalLiveCryptoUsd,
      valuesUsd,
      sourceQuality,
      breakdownQuality,
      classifiedValueUsd: allocation.totalUsd,
      unclassifiedUsd: Math.max(0, difference),
      classificationCoveragePercent: totalLiveCryptoUsd > 0
        ? Math.min(100, Math.max(0, (allocation.totalUsd / totalLiveCryptoUsd) * 100))
        : 100,
      isPartial: sourceQuality !== "complete" || breakdownQuality === "unavailable"
    };
  });
}

/**
 * Total-value history remains usable when only the asset breakdown is absent.
 * Category series additionally require a trustworthy breakdown.
 */
export function getAssetHistorySeriesValue(
  point: AssetHistoryPoint,
  series: AssetHistorySeries
) {
  if (point.sourceQuality !== "complete") return null;
  if (series === "total") return point.totalLiveCryptoUsd;
  if (point.breakdownQuality === "unavailable") return null;
  return point.valuesUsd[series];
}

/** Inserts explicit calendar gaps so charts never connect across missing days. */
export function calendarizeAssetHistory(
  points: readonly AssetHistoryPoint[]
): AssetHistoryCalendarPoint[] {
  if (points.length === 0) return [];
  const byDate = new Map(points.map((point) => [point.date, point]));
  const firstDate = points[0]?.date;
  const lastDate = points.slice(-1)[0]?.date;
  const first = firstDate ? Date.parse(`${firstDate}T00:00:00Z`) : Number.NaN;
  const last = lastDate ? Date.parse(`${lastDate}T00:00:00Z`) : Number.NaN;
  if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) {
    return points.map((point) => ({ date: point.date, point }));
  }

  const calendar: AssetHistoryCalendarPoint[] = [];
  for (let timestamp = first; timestamp <= last; timestamp += 86_400_000) {
    const date = new Date(timestamp).toISOString().slice(0, 10);
    calendar.push({ date, point: byDate.get(date) ?? null });
  }
  return calendar;
}

function latestDailySnapshots(snapshots: readonly LivePortfolioSnapshot[]) {
  const daily = new Map<string, { date: string; capturedAt: string; snapshot: SnapshotRecord }>();
  const sorted = snapshots
    .map((snapshot) => asRecord(snapshot))
    .filter((snapshot): snapshot is SnapshotRecord => Boolean(snapshot))
    .filter((snapshot) => isIsoTimestamp(snapshot.generatedAt))
    .slice()
    .sort((left, right) => String(left.generatedAt).localeCompare(String(right.generatedAt)));

  for (const snapshot of sorted) {
    const capturedAt = String(snapshot.generatedAt);
    const date = getTaipeiDate(capturedAt);
    daily.set(date, { date, capturedAt, snapshot });
  }

  return [...daily.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function getLiveCryptoHoldings(snapshot: SnapshotRecord): Array<Pick<LiveHolding, "symbol" | "valueUsd" | "assetClass">> {
  return recordArray(snapshot.holdings).flatMap((holding) => {
    const symbol = stringValue(holding.symbol);
    const valueUsd = finiteNumber(holding.valueUsd);
    if (!symbol || valueUsd === null || isBankOnlyHolding(holding)) return [];
    return [{ symbol, valueUsd, ...(holding.assetClass === "equity" ? { assetClass: "equity" as const } : {}) }];
  });
}

function isBankOnlyHolding(holding: UnknownRecord) {
  if (!Array.isArray(holding.sources) || holding.sources.length === 0) return false;
  return holding.sources.every((source) => {
    return typeof source === "string" && source.trim().toLowerCase() === "bank csv";
  });
}

function sumCryptoGroups(snapshot: SnapshotRecord) {
  const groups = asRecord(snapshot.groups);
  const exchangesUsd = finiteNumber(groups?.exchangesUsd);
  const walletsUsd = finiteNumber(groups?.walletsUsd);
  if (exchangesUsd === null && walletsUsd === null) return null;
  return (exchangesUsd ?? 0) + (walletsUsd ?? 0);
}

function emptyValues(): AssetHistoryValuesUsd {
  return Object.fromEntries(assetAllocationOrder.map((id) => [id, 0])) as AssetHistoryValuesUsd;
}

function asRecord(value: unknown): SnapshotRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as SnapshotRecord
    : null;
}

function recordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is UnknownRecord => Boolean(item))
    : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isIsoTimestamp(value: unknown) {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}
