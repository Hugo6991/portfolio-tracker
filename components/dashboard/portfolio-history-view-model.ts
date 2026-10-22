import type { PortfolioHistoryInterval } from "../../lib/portfolio-history";

export type { PortfolioHistoryInterval } from "../../lib/portfolio-history";

export type PortfolioHistoryRangeId = "24H" | "7D" | "30D" | "1M" | "3M" | "1Y" | "2Y";

export type PortfolioHistoryRange = {
  id: PortfolioHistoryRangeId;
  days: number;
};

export type PortfolioHistoryViewPoint = {
  date?: string;
  capturedAt: string;
  netWorthUsd: number;
  isPartial: boolean;
};

export type PortfolioHistoryGap = {
  afterCapturedAt: string;
  beforeCapturedAt: string;
  missingBucketCount: number;
};

export type PortfolioHistoryChartDatum<T extends PortfolioHistoryViewPoint = PortfolioHistoryViewPoint> = {
  capturedAt: string;
  valueUsd: number | null;
  point: T | null;
  gapReason: "partial" | "missing" | null;
  missingBucketCount: number;
  carriedFrom: string | null;
};

export type PortfolioHistoryViewState = "loading" | "error" | "empty" | "partial" | "single" | "ready";

const historyRanges: Record<PortfolioHistoryInterval, readonly PortfolioHistoryRange[]> = {
  hourly: [
    { id: "24H", days: 1 },
    { id: "7D", days: 7 },
    { id: "30D", days: 30 }
  ],
  daily: [
    { id: "1M", days: 30 },
    { id: "3M", days: 90 },
    { id: "1Y", days: 365 },
    { id: "2Y", days: 730 }
  ]
};

export function getPortfolioHistoryRanges(interval: PortfolioHistoryInterval) {
  return historyRanges[interval];
}

export function getDefaultPortfolioHistoryRange(interval: PortfolioHistoryInterval) {
  return interval === "hourly" ? "7D" : "3M";
}

export function buildPortfolioHistoryUrl(interval: PortfolioHistoryInterval, rangeId: PortfolioHistoryRangeId) {
  const ranges = getPortfolioHistoryRanges(interval);
  const range = ranges.find((item) => item.id === rangeId) ?? ranges[0];
  const query = new URLSearchParams({ interval, days: String(range.days) });
  return `/api/portfolio/history?${query.toString()}`;
}

export function normalizePortfolioHistoryPoints<T extends PortfolioHistoryViewPoint>(points: readonly T[]) {
  const byTimestamp = new Map<string, T>();
  for (const point of points) {
    if (!Number.isFinite(point.netWorthUsd) || !isValidTimestamp(point.capturedAt)) continue;
    byTimestamp.set(point.capturedAt, point);
  }
  return Array.from(byTimestamp.values()).sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
}

export function summarizePortfolioHistory(points: readonly PortfolioHistoryViewPoint[]) {
  const normalized = normalizePortfolioHistoryPoints(points);
  const complete = normalized.filter((point) => !point.isPartial);
  const first = complete[0]?.netWorthUsd;
  const last = complete.slice(-1)[0]?.netWorthUsd;
  const deltaUsd = complete.length < 2 || first === undefined || last === undefined ? null : last - first;
  const deltaPercent = deltaUsd === null || first === 0 ? null : (deltaUsd / first) * 100;

  return {
    firstUsd: first ?? null,
    lastUsd: last ?? null,
    deltaUsd,
    deltaPercent,
    partialCount: normalized.filter((point) => point.isPartial).length,
    pointCount: normalized.length,
    completePointCount: complete.length
  };
}

export function findPortfolioHistoryGaps(
  points: readonly PortfolioHistoryViewPoint[],
  interval: PortfolioHistoryInterval
): PortfolioHistoryGap[] {
  const normalized = normalizePortfolioHistoryPoints(points);
  const gaps: PortfolioHistoryGap[] = [];

  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    const distance = interval === "hourly"
      ? hourDistance(previous.capturedAt, current.capturedAt)
      : dayDistance(previous, current);
    if (distance <= 1) continue;
    gaps.push({
      afterCapturedAt: previous.capturedAt,
      beforeCapturedAt: current.capturedAt,
      missingBucketCount: distance - 1
    });
  }

  return gaps;
}

export function buildPortfolioHistoryChartData<T extends PortfolioHistoryViewPoint>(
  points: readonly T[],
  interval: PortfolioHistoryInterval,
  through?: string
): PortfolioHistoryChartDatum<T>[] {
  const normalized = normalizePortfolioHistoryPoints(points);
  const data: PortfolioHistoryChartDatum<T>[] = [];
  const step = interval === "hourly" ? 3_600_000 : 86_400_000;
  let lastComplete: T | null = null;
  let previousBucket: number | null = null;
  const fillUntil = (bucket: number) => {
    if (previousBucket === null || !lastComplete) return;
    for (let timestamp = previousBucket + step; timestamp < bucket; timestamp += step) {
      data.push({
        capturedAt: new Date(timestamp).toISOString(),
        valueUsd: lastComplete.netWorthUsd,
        point: lastComplete,
        gapReason: "missing",
        missingBucketCount: 1,
        carriedFrom: lastComplete.capturedAt
      });
    }
  };

  for (const point of normalized) {
    const bucket = historyBucket(point, interval);
    fillUntil(bucket);
    if (!point.isPartial) lastComplete = point;
    // No backfill before the first trustworthy observation.
    if (lastComplete) {
      data.push({
        capturedAt: point.capturedAt,
        valueUsd: lastComplete.netWorthUsd,
        point: point.isPartial ? lastComplete : point,
        gapReason: point.isPartial ? "partial" : null,
        missingBucketCount: 0,
        carriedFrom: point.isPartial ? lastComplete.capturedAt : null
      });
    }
    previousBucket = bucket;
  }
  if (through && isValidTimestamp(through)) {
    fillUntil(historyBucket({ capturedAt: through }, interval) + step);
  }
  return data;
}

function historyBucket(point: { capturedAt: string; date?: string }, interval: PortfolioHistoryInterval) {
  const timestamp = Date.parse(point.capturedAt);
  if (interval === "hourly") return Math.floor(timestamp / 3_600_000) * 3_600_000;
  const offset = 8 * 3_600_000;
  return (parseCalendarDate(point.date) ?? Math.floor((timestamp + offset) / 86_400_000) * 86_400_000) - offset;
}

export function getPortfolioHistoryViewState({
  loading,
  error,
  pointCount,
  completePointCount
}: {
  loading: boolean;
  error: string | null;
  pointCount: number;
  completePointCount: number;
}): PortfolioHistoryViewState {
  if (loading) return "loading";
  if (error) return "error";
  if (pointCount === 0) return "empty";
  if (completePointCount === 0) return "partial";
  if (completePointCount === 1) return "single";
  return "ready";
}

function isValidTimestamp(value: string) {
  return value.trim().length > 0 && Number.isFinite(new Date(value).getTime());
}

function hourDistance(previous: string, current: string) {
  const previousBucket = Math.floor(new Date(previous).getTime() / 3_600_000);
  const currentBucket = Math.floor(new Date(current).getTime() / 3_600_000);
  return Math.max(0, currentBucket - previousBucket);
}

function dayDistance(previous: PortfolioHistoryViewPoint, current: PortfolioHistoryViewPoint) {
  const previousDate = parseCalendarDate(previous.date) ?? new Date(previous.capturedAt).getTime();
  const currentDate = parseCalendarDate(current.date) ?? new Date(current.capturedAt).getTime();
  return Math.max(0, Math.round((currentDate - previousDate) / 86_400_000));
}

function parseCalendarDate(value: string | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = new Date(`${value}T00:00:00Z`).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}
