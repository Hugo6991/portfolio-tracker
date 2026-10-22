import {
  CEX_EXCHANGES,
  type CexExchange,
  type CexHistoryPoint,
  type CexSourceSnapshot
} from "./cex";

const CEX_BASE_INTERVAL_MS = 15 * 60_000;
const expectedExchanges = new Set<string>(CEX_EXCHANGES);

export type CurrentCexSnapshotSummary = {
  complete: boolean;
  expectedSourceCount: number;
  liveSourceCount: number;
  capturedAtStart: string | null;
  capturedAtEnd: string | null;
};

/**
 * Selects one internally aligned 15-minute run for every requested chart interval.
 * A latest complete run wins; otherwise the most informative partial run is kept
 * so the chart can show a gap without combining balances captured at different times.
 */
export function sampleAlignedCexHistory(
  points: CexHistoryPoint[],
  intervalMinutes: number
): CexHistoryPoint[] {
  const requestedMinutes = Number.isFinite(intervalMinutes) ? intervalMinutes : 15;
  const intervalMs = Math.max(15, Math.round(requestedMinutes / 15) * 15) * 60_000;
  const intervals = new Map<number, Map<number, Map<CexExchange, CexHistoryPoint>>>();

  for (const point of points) {
    const bucketAt = new Date(point.bucket_at).getTime();
    const capturedAt = new Date(point.captured_at).getTime();
    const value = Number(point.total_usd);
    if (
      !expectedExchanges.has(point.exchange) ||
      !Number.isFinite(bucketAt) ||
      !Number.isFinite(capturedAt) ||
      !Number.isFinite(value) ||
      value < 0
    ) continue;

    const runTimestamp = Math.floor(bucketAt / CEX_BASE_INTERVAL_MS) * CEX_BASE_INTERVAL_MS;
    const intervalTimestamp = Math.floor(runTimestamp / intervalMs) * intervalMs;
    const runs = intervals.get(intervalTimestamp) ?? new Map<number, Map<CexExchange, CexHistoryPoint>>();
    const run = runs.get(runTimestamp) ?? new Map<CexExchange, CexHistoryPoint>();
    const current = run.get(point.exchange);
    if (!current || capturedAt >= new Date(current.captured_at).getTime()) {
      run.set(point.exchange, {
        ...point,
        bucket_at: new Date(runTimestamp).toISOString(),
        total_usd: value
      });
    }
    runs.set(runTimestamp, run);
    intervals.set(intervalTimestamp, runs);
  }

  return [...intervals.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, runs]) => {
      const selected = [...runs.entries()].sort(compareRuns).slice(-1)[0]?.[1];
      if (!selected) return [];
      return CEX_EXCHANGES.flatMap((exchange) => {
        const point = selected.get(exchange);
        return point ? [point] : [];
      });
    });
}

export function summarizeCurrentCexSnapshot(
  sources: CexSourceSnapshot[]
): CurrentCexSnapshotSummary {
  const latestByExchange = new Map<CexExchange, CexSourceSnapshot>();
  for (const source of sources) {
    if (!expectedExchanges.has(source.exchange)) continue;
    const current = latestByExchange.get(source.exchange);
    const sourceCapturedAt = timestamp(source.capturedAt);
    const currentCapturedAt = current ? timestamp(current.capturedAt) : Number.NaN;
    if (!current || !Number.isFinite(currentCapturedAt) || sourceCapturedAt >= currentCapturedAt) {
      latestByExchange.set(source.exchange, source);
    }
  }

  const expectedSources = CEX_EXCHANGES.flatMap((exchange) => {
    const source = latestByExchange.get(exchange);
    return source ? [source] : [];
  });
  const liveSources = expectedSources.filter((source) => source.status === "live");
  const liveBucketValues = liveSources.flatMap((source) => {
    const value = timestamp(source.bucketAt);
    return Number.isFinite(value) ? [Math.floor(value / CEX_BASE_INTERVAL_MS)] : [];
  });
  const alignedBuckets = new Set(liveBucketValues);
  const capturedAtValues = expectedSources
    .map((source) => timestamp(source.capturedAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);

  return {
    complete:
      liveSources.length === CEX_EXCHANGES.length &&
      liveBucketValues.length === CEX_EXCHANGES.length &&
      capturedAtValues.length === CEX_EXCHANGES.length &&
      alignedBuckets.size === 1,
    expectedSourceCount: CEX_EXCHANGES.length,
    liveSourceCount: liveSources.length,
    capturedAtStart: toIso(capturedAtValues[0]),
    capturedAtEnd: toIso(capturedAtValues.slice(-1)[0])
  };
}

function compareRuns(
  [leftTimestamp, left]: [number, Map<CexExchange, CexHistoryPoint>],
  [rightTimestamp, right]: [number, Map<CexExchange, CexHistoryPoint>]
) {
  const leftLiveCount = liveSourceCount(left);
  const rightLiveCount = liveSourceCount(right);
  const leftComplete = leftLiveCount === CEX_EXCHANGES.length;
  const rightComplete = rightLiveCount === CEX_EXCHANGES.length;
  if (leftComplete !== rightComplete) return leftComplete ? 1 : -1;
  if (leftLiveCount !== rightLiveCount) return leftLiveCount - rightLiveCount;
  return leftTimestamp - rightTimestamp;
}

function liveSourceCount(run: Map<CexExchange, CexHistoryPoint>) {
  return CEX_EXCHANGES.filter((exchange) => run.get(exchange)?.status === "live").length;
}

function timestamp(value: string) {
  return new Date(value).getTime();
}

function toIso(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) ? new Date(value).toISOString() : null;
}
