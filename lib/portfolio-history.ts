import type { LivePortfolioSnapshot } from "./live-portfolio";

export type PortfolioHistoryInterval = "daily" | "hourly";

export type PortfolioHistoryPoint = {
  date: string;
  capturedAt: string;
  netWorthUsd: number;
  exchangesUsd: number;
  walletsUsd: number;
  banksUsd: number;
  sourceCount: number;
  isPartial: boolean;
  deltaUsd: number | null;
  deltaPercent: number | null;
};

export type PortfolioReport = {
  date: string;
  generatedAt: string;
  summary: string;
  alerts: string[];
  currentUsd: number;
  deltaUsd: number | null;
  deltaPercent: number | null;
  generator: "rules" | "llm";
  model: string | null;
};

export type PortfolioHistoryResponse = {
  configured: boolean;
  interval: PortfolioHistoryInterval;
  points: PortfolioHistoryPoint[];
  latestReport: PortfolioReport | null;
  latestObservation: {
    capturedAt: string;
    quality: "complete" | "degraded";
    hasPerformanceGap: boolean;
    staleSourceIds: string[];
  } | null;
};

export function getTaipeiDate(isoTimestamp: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(isoTimestamp));
}

export function snapshotToHistoryPoint(snapshot: LivePortfolioSnapshot): PortfolioHistoryPoint {
  return {
    date: getTaipeiDate(snapshot.generatedAt),
    capturedAt: snapshot.generatedAt,
    netWorthUsd: snapshot.netWorthUsd,
    exchangesUsd: snapshot.groups.exchangesUsd,
    walletsUsd: snapshot.groups.walletsUsd,
    banksUsd: snapshot.groups.banksUsd,
    sourceCount: snapshot.connectedSourceCount,
    isPartial: snapshot.isPartial,
    deltaUsd: null,
    deltaPercent: null
  };
}

export function getTaipeiHourBucket(isoTimestamp: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(isoTimestamp));
  const value = (type: Intl.DateTimeFormatPartTypes) => (
    parts.find((part) => part.type === type)?.value ?? ""
  );
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}`;
}

export function canonicalizePortfolioSnapshots(
  snapshots: readonly LivePortfolioSnapshot[],
  interval: PortfolioHistoryInterval
) {
  const buckets = new Map<string, PortfolioHistoryPoint>();
  const sorted = snapshots
    .filter(isUsableHistorySnapshot)
    .slice()
    .sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));

  for (const snapshot of sorted) {
    const point = snapshotToHistoryPoint(snapshot);
    const bucket = interval === "hourly"
      ? getTaipeiHourBucket(snapshot.generatedAt)
      : point.date;
    const current = buckets.get(bucket);
    if (!current || current.isPartial || !point.isPartial) {
      buckets.set(bucket, point);
    }
  }

  const points = Array.from(buckets.values()).sort(
    (a, b) => a.capturedAt.localeCompare(b.capturedAt)
  );
  let previousCompleteUsd: number | null = null;
  return points.map((point) => {
    if (point.isPartial) {
      return { ...point, deltaUsd: null, deltaPercent: null };
    }
    const { deltaUsd, deltaPercent } = calculateChange(point.netWorthUsd, previousCompleteUsd);
    previousCompleteUsd = point.netWorthUsd;
    return { ...point, deltaUsd, deltaPercent };
  });
}

export function canonicalizeDailySnapshots(snapshots: readonly LivePortfolioSnapshot[]) {
  return canonicalizePortfolioSnapshots(snapshots, "daily");
}

export function canonicalizeHourlySnapshots(snapshots: readonly LivePortfolioSnapshot[]) {
  return canonicalizePortfolioSnapshots(snapshots, "hourly");
}

export function calculateChange(current: number, previous: number | null) {
  if (previous === null) return { deltaUsd: null, deltaPercent: null };
  const deltaUsd = current - previous;
  return {
    deltaUsd,
    deltaPercent: previous === 0 ? null : (deltaUsd / previous) * 100
  };
}

function isUsableHistorySnapshot(snapshot: LivePortfolioSnapshot) {
  return (
    Number.isFinite(new Date(snapshot.generatedAt).getTime()) &&
    Number.isFinite(snapshot.netWorthUsd) &&
    Number.isFinite(snapshot.groups?.exchangesUsd) &&
    Number.isFinite(snapshot.groups?.walletsUsd) &&
    Number.isFinite(snapshot.groups?.banksUsd) &&
    Number.isFinite(snapshot.connectedSourceCount)
  );
}

export function buildRuleReport(
  current: PortfolioHistoryPoint,
  previous: PortfolioHistoryPoint | null
): Pick<PortfolioReport, "summary" | "alerts" | "deltaUsd" | "deltaPercent"> {
  const { deltaUsd, deltaPercent } = calculateChange(
    current.netWorthUsd,
    previous?.netWorthUsd ?? null
  );

  if (!previous || deltaUsd === null || deltaPercent === null) {
    return {
      summary: "Daily tracking is active. This snapshot establishes the comparison baseline.",
      alerts: current.isPartial ? ["Some data sources were incomplete during this snapshot."] : [],
      deltaUsd,
      deltaPercent
    };
  }

  const direction = deltaUsd > 0 ? "increased" : deltaUsd < 0 ? "decreased" : "was unchanged";
  const magnitude = Math.abs(deltaPercent);
  const summary = deltaUsd === 0
    ? "Estimated net worth was unchanged from the previous daily snapshot."
    : `Estimated net worth ${direction} ${magnitude.toFixed(2)}% from the previous daily snapshot.`;
  const alerts: string[] = [];

  if (magnitude >= 5) alerts.push(`Large daily move detected: ${deltaPercent.toFixed(2)}%.`);
  if (current.sourceCount < previous.sourceCount) {
    alerts.push(`Data coverage fell from ${previous.sourceCount} to ${current.sourceCount} live sources.`);
  }
  if (current.isPartial) alerts.push("Some data sources were incomplete during this snapshot.");

  return { summary, alerts, deltaUsd, deltaPercent };
}
