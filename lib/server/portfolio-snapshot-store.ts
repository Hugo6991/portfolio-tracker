import "server-only";
import { VALUATION_BASIS } from "@/lib/valuation-basis";

import { canonicalizeDailyAssetSnapshots, type AssetHistoryPoint } from "../asset-history";
import type {
  LivePortfolioSnapshot,
  LiveSourceStatus,
  PortfolioLatestAttempt
} from "../live-portfolio";
import type { PortfolioCandidateSummary } from "../portfolio-snapshot-policy";
import type { PortfolioSourcePayload } from "./portfolio-source-state";
import type {
  PortfolioHistoryInterval,
  PortfolioHistoryPoint,
  PortfolioReport
} from "../portfolio-history";
import { canonicalizePortfolioSnapshots, getTaipeiDate } from "../portfolio-history";
import {
  canonicalizeDailyWalletSnapshots,
  type WalletHistoryData
} from "../wallet-history";

type SnapshotRow = {
  captured_at: string;
  snapshot: LivePortfolioSnapshot;
};

type HistorySnapshotRow = SnapshotRow & {
  net_worth_usd: number | string;
  is_partial: boolean;
  source_count: number;
  sync_run_id?: number | string | null;
  quality_status?: "complete" | "degraded" | "bootstrap" | "rejected" | null;
};

type VerifiedHistoryCutoverRow = {
  captured_at: string;
};

type PortfolioHistoryRow = {
  captured_at: string;
  net_worth_usd: number | string;
  exchanges_usd: number | string | null;
  wallets_usd: number | string | null;
  banks_usd: number | string | null;
  is_partial: boolean;
  source_count: number;
};

type PortfolioSyncRun = {
  startedAt: string;
  completedAt: string;
  trigger: "cron" | "manual";
  status: "success" | "partial" | "skipped_degraded" | "failed";
  durationMs: number;
  netWorthUsd: number | null;
  sourceCount: number;
  errorCount: number;
  detail: Record<string, unknown>;
};

export type PortfolioSyncSummary = {
  completedAt: string;
  status: PortfolioSyncRun["status"];
  rejectedSources: string[];
  reasonCodes: string[];
};

export type PortfolioSyncMonitor = {
  lastAttemptAt: string | null;
  lastSuccessfulAt: string | null;
  attemptLagHours: number | null;
  isAttemptOverdue: boolean;
  latest: PortfolioSyncSummary | null;
};

export type MonthlyDeBankUsage = {
  month: string;
  scanCount: number;
  requestCount: number;
  valuationScanCount: number;
  fullScanCount: number;
  estimatedUnits: number;
};

export type PortfolioSyncClaim = {
  claimed: boolean;
  runId: number | null;
  leaseToken: string | null;
  reason: "claimed" | "already_running" | "already_completed";
};

export type FinishPortfolioSyncInput = {
  runId: number;
  leaseToken: string;
  completedAt: string;
  status: "success" | "partial" | "skipped_degraded" | "failed";
  durationMs: number;
  snapshot: LivePortfolioSnapshot | null;
  qualityStatus: "complete" | "degraded" | "bootstrap" | "rejected";
  publishCurrent: boolean;
  writeValue: boolean;
  writeFull: boolean;
  detail: Record<string, unknown>;
  sourcePayloads?: PortfolioSourcePayload[];
  requireSourcePayloads?: boolean;
};

const defaultTtlSeconds = 1_200;

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && serviceRoleKey ? { url, serviceRoleKey } : null;
}

function getHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json"
  };
}

export function getPortfolioSnapshotTtlSeconds() {
  const configured = Number(process.env.PORTFOLIO_SNAPSHOT_TTL_SECONDS);
  return Number.isFinite(configured) && configured >= 30
    ? Math.round(configured)
    : defaultTtlSeconds;
}

export function isPortfolioSnapshotStorageConfigured() {
  return getSupabaseConfig() !== null;
}

export async function readLatestPortfolioSnapshot(): Promise<SnapshotRow | null> {
  const config = getSupabaseConfig();
  if (!config) return null;

  const currentQuery = new URLSearchParams({
    select: "captured_at,snapshot",
    id: "eq.true",
    limit: "1"
  });
  const currentResponse = await fetch(
    `${config.url}/rest/v1/portfolio_current?${currentQuery.toString()}`,
    {
      headers: getHeaders(config.serviceRoleKey),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000)
    }
  );
  if (currentResponse.ok) {
    const rows = await currentResponse.json() as SnapshotRow[];
    return rows[0] ?? null;
  } else if (currentResponse.status !== 404) {
    throw new Error(`Current snapshot read failed with HTTP ${currentResponse.status}`);
  }

  return readLatestLegacyPortfolioSnapshot(config);
}

export async function readPreviousCompletePortfolioSnapshot(
  snapshot: LivePortfolioSnapshot
): Promise<SnapshotRow | null> {
  const config = getSupabaseConfig();
  if (!config) throw new Error("Portfolio snapshot storage is not configured");
  const currentDate = getTaipeiDate(snapshot.generatedAt);
  const before = new Date(`${currentDate}T00:00:00+08:00`).toISOString();
  const query = new URLSearchParams({
    select: "captured_at,snapshot",
    captured_at: `lt.${before}`,
    is_partial: "eq.false",
    quality_status: "eq.complete",
    sync_run_id: "not.is.null",
    "quality->>valuationBasis": `eq.${VALUATION_BASIS}`,
    order: "captured_at.desc",
    limit: "1"
  });
  const response = await fetch(`${config.url}/rest/v1/portfolio_snapshots?${query}`, {
    headers: getHeaders(config.serviceRoleKey),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Previous complete snapshot read failed with HTTP ${response.status}`);
  const rows = await response.json() as SnapshotRow[];
  const row = rows[0];
  return row
    ? { captured_at: row.captured_at, snapshot: { ...row.snapshot, generatedAt: row.captured_at } }
    : null;
}

async function readLatestLegacyPortfolioSnapshot(
  config: NonNullable<ReturnType<typeof getSupabaseConfig>>
): Promise<SnapshotRow | null> {

  const query = new URLSearchParams({
    select: "captured_at,snapshot",
    order: "captured_at.desc",
    limit: "1"
  });
  const response = await fetch(
    `${config.url}/rest/v1/portfolio_snapshots?${query.toString()}`,
    {
      headers: getHeaders(config.serviceRoleKey),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000)
    }
  );
  if (!response.ok) {
    throw new Error(`Snapshot read failed with HTTP ${response.status}`);
  }
  const rows = await response.json() as SnapshotRow[];
  return rows[0] ?? null;
}

export async function claimPortfolioSync(input: {
  jobKey: string;
  syncKind: "full" | "value";
  trigger: "cron" | "manual";
  startedAt: string;
  leaseSeconds?: number;
}): Promise<PortfolioSyncClaim> {
  const config = getSupabaseConfig();
  if (!config) throw new Error("Portfolio snapshot storage is not configured");

  const response = await fetch(`${config.url}/rest/v1/rpc/claim_portfolio_sync_v2`, {
    method: "POST",
    headers: getHeaders(config.serviceRoleKey),
    body: JSON.stringify({
      p_job_key: input.jobKey,
      p_sync_kind: input.syncKind,
      p_trigger: input.trigger,
      p_started_at: input.startedAt,
      p_lease_seconds: input.leaseSeconds ?? 180
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`Portfolio sync claim failed with HTTP ${response.status}`);
  }
  const rows = await response.json() as Array<{
    claimed: boolean;
    run_id: number | string | null;
    lease_token: string | null;
    reason: PortfolioSyncClaim["reason"];
  }>;
  const row = rows[0];
  if (!row || !["claimed", "already_running", "already_completed"].includes(row.reason)) {
    throw new Error("Portfolio sync claim returned an invalid response");
  }
  return {
    claimed: row.claimed === true,
    runId: row.run_id === null ? null : Number(row.run_id),
    leaseToken: row.claimed ? row.lease_token : null,
    reason: row.reason
  };
}

export async function hasPortfolioSyncAttempt(jobKey: string): Promise<boolean> {
  const config = getSupabaseConfig();
  if (!config) throw new Error("Portfolio snapshot storage is not configured");
  const query = new URLSearchParams({
    select: "id",
    job_key: `eq.${jobKey}`,
    limit: "1"
  });
  const response = await fetch(`${config.url}/rest/v1/portfolio_sync_runs?${query}`, {
    headers: getHeaders(config.serviceRoleKey),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`Portfolio sync attempt read failed with HTTP ${response.status}`);
  }
  const rows = await response.json() as Array<{ id?: unknown }>;
  return rows.length > 0;
}

export async function finishPortfolioSync(input: FinishPortfolioSyncInput) {
  const config = getSupabaseConfig();
  if (!config) throw new Error("Portfolio snapshot storage is not configured");
  const snapshot = input.snapshot;
  const detail = {
    ...input.detail,
    quality: {
      ...(input.detail.quality as Record<string, unknown> | undefined),
      valuationBasis: snapshot?.valuationBasis ?? null
    }
  };
  let response = await fetch(`${config.url}/rest/v1/rpc/finish_portfolio_sync_v3`, {
    method: "POST",
    headers: getHeaders(config.serviceRoleKey),
    body: JSON.stringify({
      p_run_id: input.runId,
      p_lease_token: input.leaseToken,
      p_completed_at: input.completedAt,
      p_status: input.status,
      p_duration_ms: input.durationMs,
      p_net_worth_usd: snapshot?.netWorthUsd ?? null,
      p_source_count: snapshot?.connectedSourceCount ?? 0,
      p_error_count: snapshot?.errors.length ?? (input.status === "failed" ? 1 : 0),
      p_detail: detail,
      p_snapshot: snapshot,
      p_quality_status: input.qualityStatus,
      p_publish_current: input.publishCurrent,
      p_write_value: input.writeValue,
      p_write_full: input.writeFull,
      p_source_payloads: input.sourcePayloads ?? []
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });
  if (response.status === 404) {
    if (input.requireSourcePayloads) throw new Error("Structured source publication requires the v3 database writer");
    response = await fetch(`${config.url}/rest/v1/rpc/finish_portfolio_sync_v2`, {
      method: "POST",
      headers: getHeaders(config.serviceRoleKey),
      body: JSON.stringify({
        p_run_id: input.runId,
        p_lease_token: input.leaseToken,
        p_completed_at: input.completedAt,
        p_status: input.qualityStatus === "degraded" ? "skipped_degraded" : input.status,
        p_duration_ms: input.durationMs,
        p_net_worth_usd: snapshot?.netWorthUsd ?? null,
        p_source_count: snapshot?.connectedSourceCount ?? 0,
        p_error_count: snapshot?.errors.length ?? (input.status === "failed" ? 1 : 0),
        p_detail: detail,
        p_snapshot: snapshot,
        p_quality_status: input.qualityStatus === "degraded" ? "rejected" : input.qualityStatus,
        p_publish_current: input.qualityStatus === "degraded" ? false : input.publishCurrent,
        p_write_value: input.qualityStatus === "degraded" ? false : input.writeValue,
        p_write_full: input.qualityStatus === "degraded" ? false : input.writeFull
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000)
    });
  }
  if (!response.ok) {
    throw new Error(`Portfolio sync completion failed with HTTP ${response.status}`);
  }
  return await response.json() as boolean;
}

export async function readLatestPortfolioRejection(
  mode: "current-15m" | "daily-full" = "current-15m"
): Promise<{
  completedAt: string;
  candidate: PortfolioCandidateSummary;
  confirmationCount: number;
} | null> {
  const config = getSupabaseConfig();
  if (!config) throw new Error("Portfolio snapshot storage is not configured");
  const query = new URLSearchParams({
    select: "completed_at,detail",
    status: "eq.skipped_degraded",
    "detail->>mode": `eq.${mode}`,
    order: "completed_at.desc",
    limit: "1"
  });
  const response = await fetch(`${config.url}/rest/v1/portfolio_sync_runs?${query}`, {
    headers: getHeaders(config.serviceRoleKey),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`Portfolio rejection read failed with HTTP ${response.status}`);
  }
  const rows = await response.json() as Array<{
    completed_at: string;
    detail?: { candidate?: unknown; collapseConfirmationCount?: unknown };
  }>;
  const row = rows[0];
  if (!row || !isPortfolioCandidateSummary(row.detail?.candidate)) return null;
  const count = Number(row.detail?.collapseConfirmationCount);
  if (!Number.isInteger(count) || count < 1) return null;
  return {
    completedAt: row.completed_at,
    candidate: row.detail!.candidate,
    confirmationCount: count
  };
}

export async function readLatestPortfolioSyncSummary(): Promise<PortfolioSyncSummary | null> {
  const config = getSupabaseConfig();
  if (!config) throw new Error("Portfolio snapshot storage is not configured");
  const query = new URLSearchParams({
    select: "completed_at,status,detail",
    "detail->>mode": "eq.daily-full",
    order: "completed_at.desc",
    limit: "1"
  });
  const response = await fetch(`${config.url}/rest/v1/portfolio_sync_runs?${query}`, {
    headers: getHeaders(config.serviceRoleKey),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Portfolio sync summary read failed with HTTP ${response.status}`);

  const rows = await response.json() as Array<{
    completed_at?: unknown;
    status?: unknown;
    detail?: { quality?: { reasons?: unknown } };
  }>;
  const row = rows[0];
  if (!row || typeof row.completed_at !== "string" || !isPortfolioSyncStatus(row.status)) return null;

  const reasons = Array.isArray(row.detail?.quality?.reasons)
    ? row.detail!.quality!.reasons as Array<{ code?: unknown; sourceId?: unknown }>
    : [];
  return {
    completedAt: row.completed_at,
    status: row.status,
    rejectedSources: uniqueStrings(reasons.map((reason) => reason.sourceId)),
    reasonCodes: uniqueStrings(reasons.map((reason) => reason.code))
  };
}

export type PortfolioAttemptRow = {
  completed_at?: unknown;
  status?: unknown;
  detail?: {
    quality?: { reasons?: unknown; collapseReadyForReview?: unknown };
    candidate?: unknown;
    collapseConfirmationCount?: unknown;
    sources?: unknown;
  };
};

export async function readLatestPortfolioAttemptRow(): Promise<PortfolioAttemptRow | null> {
  const config = getSupabaseConfig();
  if (!config) throw new Error("Portfolio snapshot storage is not configured");
  const query = new URLSearchParams({
    select: "completed_at,status,detail",
    "detail->>mode": "eq.current-15m",
    completed_at: "not.is.null",
    order: "completed_at.desc",
    limit: "1"
  });
  const response = await fetch(`${config.url}/rest/v1/portfolio_sync_runs?${query}`, {
    headers: getHeaders(config.serviceRoleKey),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Portfolio attempt read failed with HTTP ${response.status}`);

  const rows = await response.json() as PortfolioAttemptRow[];
  return rows[0] ?? null;
}

export async function readLatestPortfolioAttempt(current: LivePortfolioSnapshot): Promise<PortfolioLatestAttempt | null> {
  return buildPortfolioAttempt(await readLatestPortfolioAttemptRow(), current);
}

export function buildPortfolioAttempt(row: PortfolioAttemptRow | null, current: LivePortfolioSnapshot): PortfolioLatestAttempt | null {
  if (!row || typeof row.completed_at !== "string" || !isPortfolioSyncStatus(row.status)) return null;

  const reasons = Array.isArray(row.detail?.quality?.reasons)
    ? row.detail!.quality!.reasons as Array<{ code?: unknown; sourceId?: unknown }>
    : [];
  const reasonCodes = uniqueStrings(reasons.map((reason) => reason.code));
  const reasonSourceIds = uniqueStrings(reasons.map((reason) => reason.sourceId));
  const candidate = isPortfolioCandidateSummary(row.detail?.candidate)
    ? row.detail!.candidate
    : null;
  const attemptSources = parseAttemptSources(row.detail?.sources);
  const currentSources = new Map(current.sources.map((source) => [source.id, source]));
  const candidateSources = new Map(candidate?.sources.map((source) => [source.id, source]) ?? []);
  const affectedIds = new Set(reasonSourceIds);

  for (const source of attemptSources.values()) {
    if (source.status !== "live" && source.status !== "preview") affectedIds.add(source.id);
  }
  if (reasonCodes.includes("value-collapse")) {
    for (const source of current.sources) {
      const next = candidateSources.get(source.id);
      if (next && source.valueUsd >= 50 && next.valueUsd <= source.valueUsd * 0.7) {
        affectedIds.add(source.id);
      }
    }
  }

  const onlyValueCollapse = reasonCodes.length > 0 && reasonCodes.every((code) => code === "value-collapse");
  const reviewReady = row.detail?.quality?.collapseReadyForReview === true && onlyValueCollapse;
  const confirmationCountValue = Number(row.detail?.collapseConfirmationCount);
  const confirmationCount = Number.isInteger(confirmationCountValue) && confirmationCountValue > 0
    ? confirmationCountValue
    : 0;

  return {
    completedAt: row.completed_at,
    status: row.status === "success"
      ? "success"
      : row.status === "failed"
        ? "failed"
        : onlyValueCollapse
          ? reviewReady ? "review-required" : "validating-change"
          : "source-incomplete",
    reasonCodes,
    confirmationCount,
    reviewReady,
    candidateNetWorthUsd: candidate?.netWorthUsd ?? null,
    previousNetWorthUsd: current.netWorthUsd,
    affectedSources: [...affectedIds].map((id) => {
      const previous = currentSources.get(id);
      const next = candidateSources.get(id);
      const attempt = attemptSources.get(id);
      const previousValueUsd = previous?.valueUsd ?? null;
      const candidateValueUsd = next?.valueUsd ?? attempt?.valueUsd ?? null;
      const deltaUsd = previousValueUsd === null || candidateValueUsd === null
        ? null
        : candidateValueUsd - previousValueUsd;
      return {
        id,
        name: previous?.name ?? attempt?.name ?? id,
        status: attempt?.status ?? "unknown",
        previousValueUsd,
        candidateValueUsd,
        deltaUsd,
        deltaPercent: deltaUsd === null || !previousValueUsd
          ? null
          : deltaUsd / previousValueUsd * 100
      };
    })
  };
}

export async function readPortfolioSyncMonitor(now = new Date()): Promise<PortfolioSyncMonitor> {
  const config = getSupabaseConfig();
  if (!config) throw new Error("Portfolio snapshot storage is not configured");
  const latestQuery = new URLSearchParams({
    select: "started_at,completed_at,status,detail",
    order: "started_at.desc",
    limit: "1"
  });
  const successQuery = new URLSearchParams({
    select: "completed_at",
    status: "eq.success",
    completed_at: "not.is.null",
    order: "completed_at.desc",
    limit: "1"
  });
  const request = (query: URLSearchParams) => fetch(
    `${config.url}/rest/v1/portfolio_sync_runs?${query}`,
    {
      headers: getHeaders(config.serviceRoleKey),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000)
    }
  );
  const [latestResponse, successResponse] = await Promise.all([
    request(latestQuery),
    request(successQuery)
  ]);
  if (!latestResponse.ok || !successResponse.ok) {
    const status = !latestResponse.ok ? latestResponse.status : successResponse.status;
    throw new Error(`Portfolio sync monitor read failed with HTTP ${status}`);
  }

  const latestRows = await latestResponse.json() as Array<{
    started_at?: unknown;
    completed_at?: unknown;
    status?: unknown;
    detail?: { quality?: { reasons?: unknown } };
  }>;
  const successRows = await successResponse.json() as Array<{ completed_at?: unknown }>;
  const latestRow = latestRows.find((row) => typeof row.started_at === "string") ?? null;
  const successRow = successRows.find((row) => typeof row.completed_at === "string") ?? null;
  const lastAttemptAt = typeof latestRow?.started_at === "string" ? latestRow.started_at : null;
  const attemptLagHours = lastAttemptAt
    ? Math.max(0, (now.getTime() - new Date(lastAttemptAt).getTime()) / 3_600_000)
    : null;

  return {
    lastAttemptAt,
    lastSuccessfulAt: typeof successRow?.completed_at === "string" ? successRow.completed_at : null,
    attemptLagHours: attemptLagHours === null ? null : Math.round(attemptLagHours * 10) / 10,
    isAttemptOverdue: attemptLagHours === null || attemptLagHours > 26,
    latest: latestRow && typeof latestRow.completed_at === "string" && isPortfolioSyncStatus(latestRow.status)
      ? syncSummaryFromRow({
          completed_at: latestRow.completed_at,
          status: latestRow.status,
          detail: latestRow.detail
        })
      : null
  };
}

export async function readMonthlyDeBankUsage(now = new Date()): Promise<MonthlyDeBankUsage> {
  const config = getSupabaseConfig();
  if (!config) throw new Error("Portfolio snapshot storage is not configured");
  const taipeiNow = new Date(now.getTime() + 8 * 3_600_000);
  const month = taipeiNow.toISOString().slice(0, 7);
  const start = new Date(`${month}-01T00:00:00+08:00`).toISOString();
  const query = new URLSearchParams({
    select: "started_at,detail",
    started_at: `gte.${start}`,
    "detail->>mode": "eq.daily-full",
    order: "started_at.asc"
  });
  const response = await fetch(`${config.url}/rest/v1/portfolio_sync_runs?${query}`, {
    headers: getHeaders(config.serviceRoleKey),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`DeBank monthly usage read failed with HTTP ${response.status}`);

  const rows = await response.json() as Array<{
    detail?: { providerUsage?: { debank?: {
      scanAttempted?: unknown;
      requestCount?: unknown;
      scanKind?: unknown;
      estimatedUnits?: unknown;
    } } };
  }>;
  return rows.reduce<MonthlyDeBankUsage>((usage, row) => {
    const provider = row.detail?.providerUsage?.debank;
    if (provider?.scanAttempted !== true) return usage;
    usage.scanCount += 1;
    const requestCount = Number(provider.requestCount);
    if (Number.isInteger(requestCount) && requestCount >= 0) usage.requestCount += requestCount;
    if (provider.scanKind === "total-balance") usage.valuationScanCount += 1;
    else usage.fullScanCount += 1;
    const estimatedUnits = Number(provider.estimatedUnits);
    usage.estimatedUnits += Number.isInteger(estimatedUnits) && estimatedUnits >= 0
      ? estimatedUnits
      : provider.scanKind === "total-balance" ? Math.max(0, requestCount) * 30 : 1_109;
    return usage;
  }, {
    month,
    scanCount: 0,
    requestCount: 0,
    valuationScanCount: 0,
    fullScanCount: 0,
    estimatedUnits: 0
  });
}

function isPortfolioSyncStatus(value: unknown): value is PortfolioSyncRun["status"] {
  return value === "success" ||
    value === "partial" ||
    value === "skipped_degraded" ||
    value === "failed";
}

function syncSummaryFromRow(row: {
  completed_at: string;
  status?: unknown;
  detail?: { quality?: { reasons?: unknown } };
}): PortfolioSyncSummary | null {
  if (!isPortfolioSyncStatus(row.status)) return null;
  const reasons = Array.isArray(row.detail?.quality?.reasons)
    ? row.detail!.quality!.reasons as Array<{ code?: unknown; sourceId?: unknown }>
    : [];
  return {
    completedAt: row.completed_at,
    status: row.status,
    rejectedSources: uniqueStrings(reasons.map((reason) => reason.sourceId)),
    reasonCodes: uniqueStrings(reasons.map((reason) => reason.code))
  };
}

function uniqueStrings(values: unknown[]) {
  return Array.from(new Set(values.filter((value): value is string => (
    typeof value === "string" && /^[a-z0-9_-]{1,40}$/i.test(value)
  ))));
}

function parseAttemptSources(value: unknown) {
  const result = new Map<string, {
    id: string;
    name: string;
    status: LiveSourceStatus;
    valueUsd: number;
  }>();
  if (!Array.isArray(value)) return result;
  for (const source of value) {
    if (!source || typeof source !== "object") continue;
    const row = source as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      !/^[a-z0-9_-]{1,40}$/i.test(row.id) ||
      !isLiveSourceStatus(row.status) ||
      !Number.isFinite(row.valueUsd)
    ) continue;
    result.set(row.id, {
      id: row.id,
      name: typeof row.name === "string" && row.name.length <= 80 ? row.name : row.id,
      status: row.status,
      valueUsd: Number(row.valueUsd)
    });
  }
  return result;
}

function isLiveSourceStatus(value: unknown): value is LiveSourceStatus {
  return value === "live" || value === "partial" || value === "preview" || value === "error";
}

function isPortfolioCandidateSummary(value: unknown): value is PortfolioCandidateSummary {
  if (!value || typeof value !== "object") return false;
  const candidate = value as PortfolioCandidateSummary;
  return Number.isFinite(candidate.netWorthUsd) &&
    Array.isArray(candidate.sources) &&
    candidate.sources.every((source) => (
      typeof source?.id === "string" &&
      Number.isFinite(source.valueUsd) &&
      Number.isFinite(source.itemCount)
    ));
}

export async function writePortfolioSnapshot(snapshot: LivePortfolioSnapshot) {
  const config = getSupabaseConfig();
  if (!config) return false;

  const response = await fetch(`${config.url}/rest/v1/portfolio_snapshots`, {
    method: "POST",
    headers: {
      ...getHeaders(config.serviceRoleKey),
      Prefer: "return=minimal"
    },
    body: JSON.stringify({
      captured_at: snapshot.generatedAt,
      net_worth_usd: snapshot.netWorthUsd,
      is_partial: snapshot.isPartial,
      source_count: snapshot.connectedSourceCount,
      snapshot
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`Snapshot write failed with HTTP ${response.status}`);
  }
  return true;
}

export function getPortfolioValueBucketAt(capturedAt: string) {
  const timestamp = new Date(capturedAt).getTime();
  if (!Number.isFinite(timestamp)) throw new Error("Portfolio snapshot timestamp is invalid");
  return new Date(Math.floor(timestamp / 3_600_000) * 3_600_000).toISOString();
}

export async function writePortfolioValueSnapshot(snapshot: LivePortfolioSnapshot) {
  const config = getSupabaseConfig();
  if (!config) return false;
  const values = [
    snapshot.netWorthUsd,
    snapshot.groups.exchangesUsd,
    snapshot.groups.walletsUsd,
    snapshot.groups.banksUsd,
    snapshot.connectedSourceCount
  ];
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("Portfolio value snapshot is incomplete");
  }

  const response = await fetch(
    `${config.url}/rest/v1/rpc/upsert_portfolio_value_snapshot`,
    {
      method: "POST",
      headers: getHeaders(config.serviceRoleKey),
      body: JSON.stringify({
        p_bucket_at: getPortfolioValueBucketAt(snapshot.generatedAt),
        p_captured_at: snapshot.generatedAt,
        p_net_worth_usd: snapshot.netWorthUsd,
        p_exchanges_usd: snapshot.groups.exchangesUsd,
        p_wallets_usd: snapshot.groups.walletsUsd,
        p_banks_usd: snapshot.groups.banksUsd,
        p_is_partial: snapshot.isPartial,
        p_source_count: snapshot.connectedSourceCount
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000)
    }
  );
  if (!response.ok) {
    throw new Error(`Portfolio value snapshot write failed with HTTP ${response.status}`);
  }
  return true;
}

export async function readPortfolioHistory(
  days = 365,
  interval: PortfolioHistoryInterval = "daily"
): Promise<PortfolioHistoryPoint[]> {
  const snapshots = await readPortfolioHistorySnapshots(days, interval);
  return canonicalizePortfolioSnapshots(snapshots, interval);
}

export async function readWalletHistory(days = 365): Promise<WalletHistoryData> {
  return canonicalizeDailyWalletSnapshots(await readChartSnapshots(days, "wallets"));
}

export async function readAssetHistory(days = 365): Promise<AssetHistoryPoint[]> {
  return canonicalizeDailyAssetSnapshots(await readChartSnapshots(days, "assets"));
}

async function readChartSnapshots(days: number, view: "wallets" | "assets"): Promise<LivePortfolioSnapshot[]> {
  const config = getSupabaseConfig();
  if (!config) throw new Error("Portfolio history storage is not configured");
  const from = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();
  const rpc = view === "assets" ? "read_portfolio_chart_snapshots_v2" : "read_portfolio_chart_snapshots";
  const response = await fetch(`${config.url}/rest/v1/rpc/${rpc}`, {
    method: "POST",
    headers: getHeaders(config.serviceRoleKey),
    body: JSON.stringify({
      p_from: from,
      p_view: view,
      ...(view === "assets" ? { p_valuation_basis: VALUATION_BASIS } : {})
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });
  // The additive migration can be deployed independently; other failures surface.
  if (response.status === 404 && view === "wallets") return readStoredPortfolioSnapshots(days);
  if (!response.ok) throw new Error(`Chart history read failed with HTTP ${response.status}`);
  const rows = await response.json() as HistorySnapshotRow[];
  return rows.map((row) => ({
    ...row.snapshot,
    generatedAt: row.captured_at,
    netWorthUsd: Number(row.net_worth_usd),
    isPartial: row.is_partial,
    connectedSourceCount: row.source_count
  }));
}

async function readStoredPortfolioSnapshots(days: number): Promise<LivePortfolioSnapshot[]> {
  const config = getSupabaseConfig();
  if (!config) throw new Error("Portfolio history storage is not configured");
  const from = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();
  const cutoverQuery = new URLSearchParams({
    select: "captured_at",
    sync_run_id: "not.is.null",
    quality_status: "eq.complete",
    order: "captured_at.asc",
    limit: "1"
  });
  const query = new URLSearchParams({
    select: "captured_at,net_worth_usd,is_partial,source_count,sync_run_id,quality_status,snapshot",
    captured_at: `gte.${from}`,
    order: "captured_at.desc",
    limit: "5000"
  });
  const request = (params: URLSearchParams) => fetch(
    `${config.url}/rest/v1/portfolio_snapshots?${params}`,
    {
      headers: getHeaders(config.serviceRoleKey),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000)
    }
  );
  const [cutoverResponse, response] = await Promise.all([
    request(cutoverQuery),
    request(query)
  ]);
  if (!cutoverResponse.ok) {
    throw new Error(`Portfolio history cutover read failed with HTTP ${cutoverResponse.status}`);
  }
  if (!response.ok) throw new Error(`Portfolio history read failed with HTTP ${response.status}`);
  const cutoverRows = await cutoverResponse.json() as VerifiedHistoryCutoverRow[];
  const verifiedCutover = cutoverRows[0]?.captured_at ?? null;
  const rows = await response.json() as HistorySnapshotRow[];
  return rows
    .filter((row) => isTrustedFullHistoryRow(row, verifiedCutover))
    .map((row) => ({
      ...row.snapshot,
      generatedAt: row.captured_at,
      netWorthUsd: Number(row.net_worth_usd),
      isPartial: row.is_partial,
      connectedSourceCount: row.source_count
    }));
}

function isTrustedFullHistoryRow(row: HistorySnapshotRow, verifiedCutover: string | null) {
  if (row.quality_status && row.quality_status !== "complete") return false;
  const isVerified = row.sync_run_id !== null &&
    row.sync_run_id !== undefined &&
    row.quality_status === "complete";
  if (isVerified) return true;
  if (row.sync_run_id !== null && row.sync_run_id !== undefined) return false;
  if (!verifiedCutover) return row.quality_status === null || row.quality_status === undefined;
  return row.captured_at < verifiedCutover &&
    (row.quality_status === null || row.quality_status === undefined);
}

async function readPortfolioHistorySnapshots(
  days: number,
  interval: PortfolioHistoryInterval
): Promise<LivePortfolioSnapshot[]> {
  const config = getSupabaseConfig();
  if (!config) throw new Error("Portfolio history storage is not configured");
  const from = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();
  const response = await fetch(`${config.url}/rest/v1/rpc/read_portfolio_history_v2`, {
    method: "POST",
    headers: getHeaders(config.serviceRoleKey),
    body: JSON.stringify({
      p_from: from,
      p_interval: interval,
      p_valuation_basis: VALUATION_BASIS
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });

  if (response.ok) {
    const rows = await response.json() as PortfolioHistoryRow[];
    return rows.flatMap((row) => {
      const snapshot = portfolioHistoryRowToSnapshot(row);
      return snapshot ? [snapshot] : [];
    });
  }

  // Never mix legacy prices into the current valuation baseline.
  throw new Error(`Portfolio history read failed with HTTP ${response.status}`);
}

function portfolioHistoryRowToSnapshot(row: PortfolioHistoryRow): LivePortfolioSnapshot | null {
  const netWorthUsd = finiteNumber(row.net_worth_usd);
  const exchangesUsd = finiteNumber(row.exchanges_usd);
  const walletsUsd = finiteNumber(row.wallets_usd);
  const banksUsd = finiteNumber(row.banks_usd);
  const capturedAt = typeof row.captured_at === "string" ? row.captured_at : "";
  if (
    !Number.isFinite(new Date(capturedAt).getTime()) ||
    netWorthUsd === null ||
    exchangesUsd === null ||
    walletsUsd === null ||
    banksUsd === null ||
    !Number.isFinite(row.source_count)
  ) {
    return null;
  }

  return {
    generatedAt: capturedAt,
    netWorthUsd,
    liveValueUsd: exchangesUsd + walletsUsd,
    previewValueUsd: banksUsd,
    groups: { exchangesUsd, walletsUsd, banksUsd },
    sources: [],
    holdings: [],
    wallets: [],
    connectedSourceCount: row.source_count,
    expectedSourceCount: row.source_count,
    isPartial: row.is_partial === true,
    errors: []
  };
}

function finiteNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function readPreviousDailySnapshot(snapshot: LivePortfolioSnapshot) {
  const history = await readPortfolioHistory(730, "daily");
  const currentDate = getTaipeiDate(snapshot.generatedAt);
  return history.filter((point) => point.date < currentDate && !point.isPartial).at(-1) ?? null;
}

export async function readLatestPortfolioReport(): Promise<PortfolioReport | null> {
  const config = getSupabaseConfig();
  if (!config) throw new Error("Portfolio report storage is not configured");
  const query = new URLSearchParams({
    select: "completed_at,detail",
    status: "eq.success",
    "detail->portfolioReport": "not.is.null",
    "detail->quality->>valuationBasis": `eq.${VALUATION_BASIS}`,
    order: "completed_at.desc",
    limit: "1"
  });
  const response = await fetch(`${config.url}/rest/v1/portfolio_sync_runs?${query}`, {
    headers: getHeaders(config.serviceRoleKey),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Portfolio report read failed with HTTP ${response.status}`);
  const rows = await response.json() as Array<{
    completed_at: string;
    detail: { portfolioReport?: Omit<PortfolioReport, "generatedAt"> };
  }>;
  const row = rows[0];
  return row?.detail.portfolioReport
    ? { ...row.detail.portfolioReport, generatedAt: row.completed_at }
    : null;
}

export async function writePortfolioSyncRun(run: PortfolioSyncRun) {
  const config = getSupabaseConfig();
  if (!config) return false;

  const response = await fetch(`${config.url}/rest/v1/portfolio_sync_runs`, {
    method: "POST",
    headers: {
      ...getHeaders(config.serviceRoleKey),
      Prefer: "return=minimal"
    },
    body: JSON.stringify({
      started_at: run.startedAt,
      completed_at: run.completedAt,
      trigger: run.trigger,
      status: run.status,
      duration_ms: run.durationMs,
      net_worth_usd: run.netWorthUsd,
      source_count: run.sourceCount,
      error_count: run.errorCount,
      detail: run.detail
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`Sync run write failed with HTTP ${response.status}`);
  }
  return true;
}
