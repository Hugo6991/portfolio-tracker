import "server-only";
import { countValuations } from "../asset-identity";
import { VALUATION_BASIS } from "../valuation-basis";

import {
  buildCexPublicResponse,
  CEX_EXCHANGES,
  OKX_SIMPLE_EARN_ACCOUNT_ID,
  getCexExchangeName,
  type CexExchange,
  type CexHistoryPoint,
  type CexPublicResponse,
  type CexStatus,
  type CexSourceSnapshot
} from "../cex";
import { sampleAlignedCexHistory } from "../cex-history";

type CexSnapshotRow = {
  pricing_basis?: string | null;
  exchange: CexExchange;
  bucket_at: string;
  captured_at: string;
  status: CexSourceSnapshot["status"];
  total_usd: number | string;
  item_count: number;
  accounts: CexSourceSnapshot["accounts"];
  holdings: CexSourceSnapshot["holdings"];
  errors: CexSourceSnapshot["errors"];
};

type CexHistoryRow = {
  exchange: CexExchange;
  bucket_at: string;
  captured_at: string;
  total_usd: string | number;
  status: CexStatus;
};

export type CexSyncRun = {
  startedAt: string;
  completedAt: string;
  status: "success" | "partial" | "failed";
  durationMs: number;
  detail: Record<string, unknown>;
};

export type CexSyncClaim = {
  claimed: boolean;
  runId: number | null;
  leaseToken: string | null;
  reason: "claimed" | "already_running" | "already_completed";
  mode: "lease" | "legacy";
};

export const CEX_SNAPSHOT_WRITER_VERSION = "cex-rpc-v2";

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && serviceRoleKey ? { url, serviceRoleKey } : null;
}

function headers(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json"
  };
}

export function isCexSnapshotStorageConfigured() {
  return getSupabaseConfig() !== null;
}

function rowToSnapshot(row: CexSnapshotRow): CexSourceSnapshot {
  return {
    pricingBasis: row.pricing_basis,
    valuation: countValuations(row.holdings),
    exchange: row.exchange,
    name: getCexExchangeName(row.exchange),
    status: row.status,
    capturedAt: row.captured_at,
    bucketAt: row.bucket_at,
    valueUsd: Number(row.total_usd),
    itemCount: row.item_count,
    accounts: row.accounts,
    holdings: row.holdings,
    errors: row.errors
  };
}

export async function readLatestCexSnapshots(): Promise<Partial<Record<CexExchange, CexSourceSnapshot>>> {
  const config = getSupabaseConfig();
  if (!config) return {};

  const results = await Promise.allSettled(CEX_EXCHANGES.map(async (exchange) => {
    const query = new URLSearchParams({
      select: "exchange,bucket_at,captured_at,status,total_usd,item_count,accounts,holdings,errors,pricing_basis",
      exchange: `eq.${exchange}`,
      order: "captured_at.desc",
      limit: "1"
    });
    const response = await fetch(`${config.url}/rest/v1/cex_snapshots?${query}`, {
      headers: headers(config.serviceRoleKey),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`CEX snapshot read failed with HTTP ${response.status}`);
    const rows = await response.json() as CexSnapshotRow[];
    return rows[0] ? rowToSnapshot(rows[0]) : null;
  }));

  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length === results.length) {
    throw new Error("CEX snapshot reads failed for all exchanges");
  }
  if (failures.length > 0) {
    console.warn(JSON.stringify({
      scope: "cex-snapshot-store",
      event: "partial_latest_read",
      failedCount: failures.length
    }));
  }

  const latest: Partial<Record<CexExchange, CexSourceSnapshot>> = {};
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      latest[result.value.exchange] = result.value;
    }
  }
  return latest;
}

export async function readCexPublicResponse(): Promise<CexPublicResponse> {
  const latest = await readLatestCexSnapshots();
  return buildCexPublicResponse(CEX_EXCHANGES.flatMap((exchange) => latest[exchange] ? [latest[exchange]!] : []));
}

export async function writeCexSnapshots(snapshots: CexSourceSnapshot[]) {
  const config = getSupabaseConfig();
  if (!config) return { written: 0, skipped: snapshots.length, failed: 0, errors: [] as string[] };
  const usable = snapshots.filter((snapshot) => (
    snapshot.status !== "error" &&
    snapshot.accounts.some((account) => account.status !== "error")
  ));
  if (!usable.length) {
    return { written: 0, skipped: snapshots.length, failed: 0, errors: [] as string[] };
  }

  const results = await Promise.all(usable.map(async (snapshot) => {
    try {
      const storedSnapshot = {
        pricing_basis: snapshot.pricingBasis ?? null,
        exchange: snapshot.exchange,
        bucket_at: snapshot.bucketAt,
        captured_at: snapshot.capturedAt,
        status: snapshot.status,
        total_usd: snapshot.valueUsd,
        item_count: snapshot.itemCount,
        accounts: snapshot.accounts,
        holdings: snapshot.holdings,
        errors: snapshot.errors
      };
      let response = await fetch(`${config.url}/rest/v1/rpc/upsert_cex_snapshot_v2`, {
        method: "POST",
        headers: headers(config.serviceRoleKey),
        body: JSON.stringify({ p_snapshot: storedSnapshot }),
        cache: "no-store",
        signal: AbortSignal.timeout(10_000)
      });

      // This fallback exists only for the deployment-before-migration rollout
      // window. The migration revokes direct writes, so old deployments cannot
      // use this path after the fenced RPC becomes available.
      if (response.status === 404) {
        response = await fetch(`${config.url}/rest/v1/cex_snapshots?on_conflict=exchange,bucket_at`, {
          method: "POST",
          headers: {
            ...headers(config.serviceRoleKey),
            Prefer: "resolution=merge-duplicates,return=minimal"
          },
          body: JSON.stringify(storedSnapshot),
          cache: "no-store",
          signal: AbortSignal.timeout(10_000)
        });
        return response.ok
          ? { exchange: snapshot.exchange, written: true as const, error: null }
          : {
              exchange: snapshot.exchange,
              written: false as const,
              error: `${snapshot.exchange}: HTTP ${response.status}`
            };
      }

      if (!response.ok) {
        return {
          exchange: snapshot.exchange,
          written: false as const,
          error: `${snapshot.exchange}: HTTP ${response.status}`
        };
      }
      const written = await response.json() as unknown;
      return written === true
        ? { exchange: snapshot.exchange, written: true as const, error: null }
        : { exchange: snapshot.exchange, written: false as const, error: null };
    } catch {
      return {
        exchange: snapshot.exchange,
        written: false as const,
        error: `${snapshot.exchange}: request failed`
      };
    }
  }));
  const errors = results.flatMap((result) => result.error ? [result.error] : []);
  const written = results.filter((result) => result.written).length;
  const staleWrites = results.filter((result) => !result.written && !result.error).length;
  return {
    written,
    skipped: snapshots.length - usable.length + staleWrites,
    failed: errors.length,
    errors
  };
}

export async function writeCexSyncRun(run: CexSyncRun) {
  const config = getSupabaseConfig();
  if (!config) return false;
  const response = await fetch(`${config.url}/rest/v1/cex_sync_runs`, {
    method: "POST",
    headers: { ...headers(config.serviceRoleKey), Prefer: "return=minimal" },
    body: JSON.stringify({
      started_at: run.startedAt,
      completed_at: run.completedAt,
      status: run.status,
      duration_ms: run.durationMs,
      detail: run.detail
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`CEX sync run write failed with HTTP ${response.status}`);
  return true;
}

export async function claimCexSync(input: {
  jobKey: string;
  trigger: "cron" | "manual";
  startedAt: string;
  leaseSeconds?: number;
}): Promise<CexSyncClaim> {
  const config = getSupabaseConfig();
  if (!config) throw new Error("CEX snapshot storage is not configured");
  const response = await fetch(`${config.url}/rest/v1/rpc/claim_cex_sync_v1`, {
    method: "POST",
    headers: headers(config.serviceRoleKey),
    body: JSON.stringify({
      p_job_key: input.jobKey,
      p_trigger: input.trigger,
      p_started_at: input.startedAt,
      p_lease_seconds: input.leaseSeconds ?? 180
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });

  // Keep deployment order safe: the application can ship before the additive
  // migration, then begins leasing as soon as PostgREST exposes the RPC.
  if (response.status === 404) {
    return {
      claimed: true,
      runId: null,
      leaseToken: null,
      reason: "claimed",
      mode: "legacy"
    };
  }
  if (!response.ok) throw new Error(`CEX sync claim failed with HTTP ${response.status}`);

  const rows = await response.json() as Array<{
    claimed: boolean;
    run_id: number | string | null;
    lease_token: string | null;
    reason: CexSyncClaim["reason"];
  }>;
  const row = rows[0];
  if (!row || !["claimed", "already_running", "already_completed"].includes(row.reason)) {
    throw new Error("CEX sync claim returned an invalid response");
  }
  return {
    claimed: row.claimed === true,
    runId: row.run_id === null ? null : Number(row.run_id),
    leaseToken: row.claimed ? row.lease_token : null,
    reason: row.reason,
    mode: "lease"
  };
}

export async function finishCexSync(input: CexSyncRun & { claim: CexSyncClaim }) {
  if (input.claim.mode === "legacy") {
    return writeCexSyncRun(input);
  }
  if (!Number.isFinite(input.claim.runId) || !input.claim.leaseToken) {
    throw new Error("CEX sync claim did not return a lease");
  }

  const config = getSupabaseConfig();
  if (!config) throw new Error("CEX snapshot storage is not configured");
  const response = await fetch(`${config.url}/rest/v1/rpc/finish_cex_sync_v1`, {
    method: "POST",
    headers: headers(config.serviceRoleKey),
    body: JSON.stringify({
      p_run_id: input.claim.runId,
      p_lease_token: input.claim.leaseToken,
      p_completed_at: input.completedAt,
      p_status: input.status,
      p_duration_ms: input.durationMs,
      p_detail: input.detail
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`CEX sync completion failed with HTTP ${response.status}`);
  return await response.json() as boolean;
}

export async function readCexHistory(days = 30, intervalMinutes = 15) {
  const config = getSupabaseConfig();
  if (!config) return [];
  const boundedDays = Math.min(30, Math.max(1, Math.round(days)));
  const from = new Date(Date.now() - boundedDays * 86_400_000).toISOString();
  const pageSize = 1_000;

  const exchangeRows = await Promise.all(CEX_EXCHANGES.map(async (exchange) => {
    const allRows: CexHistoryRow[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const query = new URLSearchParams({
        select: "exchange,bucket_at,captured_at,total_usd,status",
        pricing_basis: `eq.${VALUATION_BASIS}`,
        exchange: `eq.${exchange}`,
        captured_at: `gte.${from}`,
        order: "captured_at.asc,bucket_at.asc,exchange.asc",
        limit: String(pageSize),
        offset: String(offset)
      });
      // Earlier OKX snapshots omit Earn and can contain a false balance collapse.
      // Keep audit rows intact, but compare only snapshots with this coverage.
      if (exchange === "okx") {
        query.set("accounts", `cs.${JSON.stringify([{ id: OKX_SIMPLE_EARN_ACCOUNT_ID }])}`);
      }
      const response = await fetch(`${config.url}/rest/v1/cex_snapshots?${query}`, {
        headers: headers(config.serviceRoleKey),
        cache: "no-store",
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) throw new Error(`CEX history read failed with HTTP ${response.status}`);
      const rows = await response.json() as CexHistoryRow[];
      allRows.push(...rows);
      if (rows.length < pageSize) break;
    }
    return allRows;
  }));

  const points = exchangeRows.flatMap((rows) => rows.map<CexHistoryPoint>((row) => ({
    ...row,
    total_usd: Number(row.total_usd)
  })));
  return sampleAlignedCexHistory(points, intervalMinutes);
}
