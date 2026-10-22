import type { LivePortfolioSnapshot } from "./live-portfolio";

export type PortfolioQualityReason = {
  code:
    | "invalid-timestamp"
    | "invalid-number"
    | "duplicate-source"
    | "empty-bootstrap"
    | "missing-source"
    | "incomplete-source"
    | "value-collapse"
    | "source-count-mismatch"
    | "group-total-mismatch"
    | "source-total-mismatch"
    | "valuation-basis-incomplete"
    | "reported-partial"
    | "reported-errors";
  sourceId?: string;
};

export type PortfolioQualityEvaluation = {
  accepted: boolean;
  status: "complete" | "degraded" | "rejected";
  reasons: PortfolioQualityReason[];
};

export type PortfolioCandidateSummary = {
  netWorthUsd: number;
  sources: Array<{ id: string; valueUsd: number; itemCount: number }>;
};

export type PortfolioCollapseConfirmation = {
  confirmed: boolean;
  count: number;
};

const reconciliationToleranceUsd = 0.05;
const meaningfulSourceUsd = 50;
// Treat a large, unexplained step-down as suspicious even when a provider
// reports a structurally valid `live` response. This catches truncated pages
// and schema regressions without blocking value that visibly moved to another
// source in the same aggregate.
const aggregateRetentionFloor = 0.5;
const sourceRetentionFloor = 0.7;
const explainedLossRatio = 0.8;

export function getPortfolioSnapshotQuality(snapshot: LivePortfolioSnapshot) {
  return snapshot.sources.reduce((score, source) => {
    if (source.status === "live") return score + 3;
    if (source.status === "partial") return score + 2;
    if (source.status === "preview") return score + 1;
    return score;
  }, 0);
}

export function shouldUseCachedPortfolioSnapshot(
  live: LivePortfolioSnapshot,
  cached: LivePortfolioSnapshot,
  cachedAgeSeconds: number,
  maxStaleSeconds: number
) {
  return (
    cachedAgeSeconds <= maxStaleSeconds &&
    getPortfolioSnapshotQuality(cached) > getPortfolioSnapshotQuality(live)
  );
}

/**
 * Decides whether a newly assembled aggregate is safe to publish as the next
 * last-known-good snapshot. Partial attempts remain observable in the sync
 * ledger, but never replace the user-facing aggregate.
 */
export function evaluatePortfolioSnapshot(
  candidate: LivePortfolioSnapshot,
  previous: LivePortfolioSnapshot | null = null
): PortfolioQualityEvaluation {
  const reasons: PortfolioQualityReason[] = [];
  const fallbackSources = candidate.sources.filter((source) => source.fallback);
  const canPublishWithFallback = fallbackSources.length > 0 && candidate.sources.every((source) => (
    source.kind === "bank"
      ? source.status === "preview" || source.status === "live" || Boolean(source.fallback)
      : source.status === "live" || Boolean(source.fallback)
  ));
  const add = (reason: PortfolioQualityReason) => {
    if (!reasons.some((item) => item.code === reason.code && item.sourceId === reason.sourceId)) {
      reasons.push(reason);
    }
  };

  if (!Number.isFinite(new Date(candidate.generatedAt).getTime())) {
    add({ code: "invalid-timestamp" });
  }

  const aggregateNumbers = [
    candidate.netWorthUsd,
    candidate.liveValueUsd,
    candidate.previewValueUsd,
    candidate.groups.exchangesUsd,
    candidate.groups.walletsUsd,
    candidate.groups.banksUsd,
    candidate.connectedSourceCount,
    candidate.expectedSourceCount
  ];
  if (aggregateNumbers.some((value) => !Number.isFinite(value))) {
    add({ code: "invalid-number" });
  }

  const sourceIds = new Set<string>();
  for (const source of candidate.sources) {
    if (sourceIds.has(source.id)) add({ code: "duplicate-source", sourceId: source.id });
    sourceIds.add(source.id);
    if (
      !Number.isFinite(source.valueUsd) ||
      !Number.isFinite(source.itemCount) ||
      !Number.isFinite(new Date(source.updatedAt).getTime())
    ) {
      add({ code: "invalid-number", sourceId: source.id });
    }
    if (source.kind !== "bank" && source.status !== "live" && !source.fallback) {
      add({ code: "incomplete-source", sourceId: source.id });
    }
    if (source.kind === "bank" && source.status !== "preview" && source.status !== "live" && !source.fallback) {
      add({ code: "incomplete-source", sourceId: source.id });
    }
  }

  for (const source of previous?.sources ?? []) {
    if (source.kind !== "bank" && !sourceIds.has(source.id)) {
      add({ code: "missing-source", sourceId: source.id });
    }
  }

  if (
    previous &&
    previous.netWorthUsd >= meaningfulSourceUsd &&
    candidate.netWorthUsd <= previous.netWorthUsd * aggregateRetentionFloor
  ) {
    add({ code: "value-collapse" });
  }

  if (previous) {
    const candidateSources = new Map(candidate.sources.map((source) => [source.id, source]));
    for (const previousSource of previous.sources) {
      if (previousSource.kind === "bank" || previousSource.valueUsd < meaningfulSourceUsd) continue;
      const currentSource = candidateSources.get(previousSource.id);
      if (!currentSource || currentSource.status !== "live") continue;
      const sourceDrop = previousSource.valueUsd - currentSource.valueUsd;
      const portfolioDrop = previous.netWorthUsd - candidate.netWorthUsd;
      if (
        currentSource.valueUsd <= previousSource.valueUsd * sourceRetentionFloor &&
        sourceDrop > 0 &&
        portfolioDrop >= sourceDrop * explainedLossRatio
      ) {
        add({ code: "value-collapse", sourceId: previousSource.id });
      }
    }
  }

  const requiredSources = candidate.sources.filter((source) => source.kind !== "bank");
  const connectedSources = requiredSources.filter(
    (source) => source.status === "live" || source.status === "partial"
  );
  if (
    candidate.expectedSourceCount !== requiredSources.length ||
    candidate.connectedSourceCount !== connectedSources.length ||
    candidate.connectedSourceCount !== candidate.expectedSourceCount
  ) {
    add({ code: "source-count-mismatch" });
  }
  if (
    previous === null &&
    candidate.netWorthUsd <= reconciliationToleranceUsd
  ) {
    add({ code: "empty-bootstrap" });
  }

  const groupTotal = candidate.groups.exchangesUsd
    + candidate.groups.walletsUsd
    + candidate.groups.banksUsd;
  if (
    !approximatelyEqual(candidate.liveValueUsd, candidate.groups.exchangesUsd + candidate.groups.walletsUsd) ||
    !approximatelyEqual(candidate.previewValueUsd, candidate.groups.banksUsd) ||
    !approximatelyEqual(candidate.netWorthUsd, groupTotal)
  ) {
    add({ code: "group-total-mismatch" });
  }

  const sourceTotal = candidate.sources.reduce((sum, source) => sum + source.valueUsd, 0);
  if (!approximatelyEqual(candidate.netWorthUsd, sourceTotal)) {
    add({ code: "source-total-mismatch" });
  }
  if (candidate.isPartial && !canPublishWithFallback) add({ code: "reported-partial" });
  if (candidate.errors.length > 0 && !canPublishWithFallback) add({ code: "reported-errors" });

  return {
    accepted: reasons.length === 0,
    status: reasons.length === 0
      ? fallbackSources.length > 0 ? "degraded" : "complete"
      : "rejected",
    reasons
  };
}

export function summarizePortfolioCandidate(
  snapshot: LivePortfolioSnapshot
): PortfolioCandidateSummary {
  return {
    netWorthUsd: snapshot.netWorthUsd,
    sources: snapshot.sources
      .filter((source) => source.kind !== "bank")
      .map((source) => ({
        id: source.id,
        valueUsd: source.valueUsd,
        itemCount: source.itemCount
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  };
}

export function getPortfolioCollapseConfirmation(input: {
  evaluation: PortfolioQualityEvaluation;
  candidate: PortfolioCandidateSummary;
  previous: {
    completedAt: string;
    candidate: PortfolioCandidateSummary;
    confirmationCount: number;
  } | null;
  now?: number;
}): PortfolioCollapseConfirmation {
  if (
    input.evaluation.accepted ||
    input.evaluation.reasons.length === 0 ||
    input.evaluation.reasons.some((reason) => reason.code !== "value-collapse")
  ) {
    return { confirmed: false, count: 0 };
  }

  const previousAt = input.previous ? new Date(input.previous.completedAt).getTime() : Number.NaN;
  const ageMs = (input.now ?? Date.now()) - previousAt;
  const minimumAgeMs = (input.previous?.confirmationCount ?? 0) >= 3 ? 0 : 60_000;
  const consecutive = input.previous &&
    Number.isFinite(previousAt) &&
    ageMs >= minimumAgeMs &&
    ageMs <= 45 * 60_000 &&
    candidatesAreConsistent(input.candidate, input.previous.candidate)
      ? Math.max(1, input.previous.confirmationCount) + 1
      : 1;

  return { confirmed: consecutive >= 3, count: consecutive };
}

function candidatesAreConsistent(
  current: PortfolioCandidateSummary,
  previous: PortfolioCandidateSummary
) {
  if (!approximatelyRelative(current.netWorthUsd, previous.netWorthUsd)) return false;
  if (current.sources.length !== previous.sources.length) return false;
  return current.sources.every((source, index) => {
    const prior = previous.sources[index];
    return Boolean(
      prior &&
      source.id === prior.id &&
      source.itemCount === prior.itemCount &&
      approximatelyRelative(source.valueUsd, prior.valueUsd)
    );
  });
}

function approximatelyEqual(left: number, right: number) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) <= reconciliationToleranceUsd;
}

function approximatelyRelative(left: number, right: number) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) <= Math.max(1, Math.max(Math.abs(left), Math.abs(right)) * 0.05);
}
