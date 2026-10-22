import { CEX_EXCHANGES, type CexExchange, type CexHistoryPoint } from "../../lib/cex";
import { sampleAlignedCexHistory } from "../../lib/cex-history";

export type CexHistoryRangeId = "24H" | "7D" | "30D";

export type CexHistoryRange = {
  id: CexHistoryRangeId;
  days: number;
  intervalMinutes: number;
};

export type CexTotalHistoryDatum = {
  capturedAt: string;
  totalUsd: number | null;
  completeSourceCount: number;
  expectedSourceCount: number;
  gapReason: "partial" | "missing" | null;
  missingBucketCount: number;
};

export type CexTotalHistorySummary = {
  firstUsd: number | null;
  lastUsd: number | null;
  deltaUsd: number | null;
  deltaPercent: number | null;
  completePointCount: number;
  gapCount: number;
};

const ranges: CexHistoryRange[] = [
  { id: "24H", days: 1, intervalMinutes: 15 },
  { id: "7D", days: 7, intervalMinutes: 60 },
  { id: "30D", days: 30, intervalMinutes: 240 }
];

export function getCexHistoryRanges() {
  return ranges;
}

export function getCexHistoryRange(id: CexHistoryRangeId) {
  return ranges.find((range) => range.id === id) ?? ranges[1];
}

export function buildCexHistoryUrl(id: CexHistoryRangeId) {
  const range = getCexHistoryRange(id);
  return `/api/cex/history?days=${range.days}&interval=${range.intervalMinutes}`;
}

export function buildCexTotalHistory(
  points: CexHistoryPoint[],
  rangeId: CexHistoryRangeId
): CexTotalHistoryDatum[] {
  const { intervalMinutes } = getCexHistoryRange(rangeId);
  const intervalMs = intervalMinutes * 60_000;
  const alignedPoints = sampleAlignedCexHistory(points, intervalMinutes);
  const buckets = new Map<number, Map<CexExchange, CexHistoryPoint>>();

  for (const point of alignedPoints) {
    const timestamp = new Date(point.bucket_at).getTime();
    const bucketTimestamp = Math.floor(timestamp / intervalMs) * intervalMs;
    const bucket = buckets.get(bucketTimestamp) ?? new Map<CexExchange, CexHistoryPoint>();
    bucket.set(point.exchange, point);
    buckets.set(bucketTimestamp, bucket);
  }

  const chartData: CexTotalHistoryDatum[] = [];
  const entries = [...buckets.entries()].sort(([left], [right]) => left - right);

  for (let index = 0; index < entries.length; index += 1) {
    const [timestamp, bucket] = entries[index];
    const previousTimestamp = entries[index - 1]?.[0];
    if (previousTimestamp !== undefined && timestamp - previousTimestamp > intervalMs * 1.5) {
      const missingBucketCount = Math.max(1, Math.round((timestamp - previousTimestamp) / intervalMs) - 1);
      chartData.push({
        capturedAt: new Date(previousTimestamp + (timestamp - previousTimestamp) / 2).toISOString(),
        totalUsd: null,
        completeSourceCount: 0,
        expectedSourceCount: CEX_EXCHANGES.length,
        gapReason: "missing",
        missingBucketCount
      });
    }

    const livePoints = CEX_EXCHANGES.flatMap((exchange) => {
      const point = bucket.get(exchange);
      return point?.status === "live" ? [point] : [];
    });
    const complete = livePoints.length === CEX_EXCHANGES.length;
    const capturedAt = Math.max(...[...bucket.values()].map((point) => new Date(point.bucket_at).getTime()));
    chartData.push({
      capturedAt: new Date(capturedAt).toISOString(),
      totalUsd: complete ? livePoints.reduce((total, point) => total + Number(point.total_usd), 0) : null,
      completeSourceCount: livePoints.length,
      expectedSourceCount: CEX_EXCHANGES.length,
      gapReason: complete ? null : "partial",
      missingBucketCount: 0
    });
  }

  return chartData;
}

export function summarizeCexTotalHistory(
  chartData: CexTotalHistoryDatum[],
  currentTotalUsd: number
): CexTotalHistorySummary {
  const complete = chartData.flatMap((point) => point.totalUsd === null ? [] : [point.totalUsd]);
  const firstUsd = complete[0] ?? null;
  const lastUsd = complete.slice(-1)[0] ?? null;
  const deltaUsd = complete.length < 2 || firstUsd === null || !Number.isFinite(currentTotalUsd) ? null : currentTotalUsd - firstUsd;
  const deltaPercent = deltaUsd === null || firstUsd === 0 ? null : (deltaUsd / firstUsd) * 100;

  return {
    firstUsd,
    lastUsd,
    deltaUsd,
    deltaPercent,
    completePointCount: complete.length,
    gapCount: chartData.reduce((count, point) => (
      count + (point.gapReason === "missing" ? point.missingBucketCount : point.gapReason === "partial" ? 1 : 0)
    ), 0)
  };
}
