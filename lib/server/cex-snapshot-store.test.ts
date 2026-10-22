import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CexExchange, CexSourceSnapshot } from "../cex";

vi.mock("server-only", () => ({}));

let readCexHistory: typeof import("./cex-snapshot-store").readCexHistory;
let readLatestCexSnapshots: typeof import("./cex-snapshot-store").readLatestCexSnapshots;
let writeCexSnapshots: typeof import("./cex-snapshot-store").writeCexSnapshots;
let claimCexSync: typeof import("./cex-snapshot-store").claimCexSync;
let finishCexSync: typeof import("./cex-snapshot-store").finishCexSync;

const fetchMock = vi.fn<typeof fetch>();

beforeAll(async () => {
  ({
    claimCexSync,
    finishCexSync,
    readCexHistory,
    readLatestCexSnapshots,
    writeCexSnapshots
  } = await import("./cex-snapshot-store"));
});

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://portfolio.supabase.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("CEX snapshot storage reads", () => {
  it("excludes OKX history without Simple Earn coverage without deleting audit rows", async () => {
    fetchMock.mockImplementation(async input => {
      const url = new URL(String(input));
      expect(url.searchParams.get("pricing_basis")).toBe("eq.binance-equities-v1");
      expect(url.searchParams.get("accounts")).toBe(url.searchParams.get("exchange") === "eq.okx"
        ? 'cs.[{"id":"okx-simple-earn"}]' : null);
      return jsonResponse([]);
    });
    expect(await readCexHistory()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
  it("reads the latest row for every exchange without a shared global window", async () => {
    const capturedAt: Record<CexExchange, string> = {
      binance: "2026-08-18T00:00:00.000Z",
      okx: "2026-08-22T00:00:00.000Z",
      bitget: "2026-08-22T00:15:00.000Z",
      htx: "2026-08-22T00:30:00.000Z",
      gate: "2026-08-22T00:45:00.000Z"
    };
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const filter = url.searchParams.get("exchange");
      const exchange = filter?.replace(/^eq\./, "") as CexExchange | undefined;
      if (!exchange || !(exchange in capturedAt)) {
        throw new Error(`Missing per-exchange filter in ${url}`);
      }
      expect(url.searchParams.get("limit")).toBe("1");
      expect(url.searchParams.get("order")).toBe("captured_at.desc");
      return jsonResponse([snapshotRow(exchange, capturedAt[exchange])]);
    });

    const latest = await readLatestCexSnapshots();

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(Object.keys(latest).sort()).toEqual(["binance", "bitget", "gate", "htx", "okx"]);
    expect(latest.binance?.capturedAt).toBe("2026-08-18T00:00:00.000Z");
  });

  it("restores the pricing basis and valuation metadata from the latest row", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("select")).toContain("pricing_basis");
      const exchange = url.searchParams.get("exchange")?.replace(/^eq\./, "") as CexExchange;
      return jsonResponse([{
        ...snapshotRow(exchange, "2026-09-22T00:00:00.000Z"),
        pricing_basis: "binance-equities-v1",
        holdings: [{ exchange, accountType: "Funding", symbol: "EQ_TSLA", amount: 2,
          valueUsd: 742, assetClass: "equity", exposureSymbol: "TSLA", valuationState: "priced" }]
      }]);
    });

    const latest = await readLatestCexSnapshots();

    expect(latest.binance).toMatchObject({
      pricingBasis: "binance-equities-v1",
      valuation: { priced: 1, excluded: 0, unpriced: 0 }
    });
    expect(latest.binance?.holdings[0]).toMatchObject({ assetClass: "equity", exposureSymbol: "TSLA" });
  });

  it("preserves healthy exchanges when one latest-row request fails", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const exchange = url.searchParams.get("exchange")?.replace(/^eq\./, "") as CexExchange;
      if (exchange === "htx") return new Response("unavailable", { status: 503 });
      return jsonResponse([snapshotRow(exchange, "2026-08-22T00:00:00.000Z")]);
    });

    const latest = await readLatestCexSnapshots();

    expect(Object.keys(latest).sort()).toEqual(["binance", "bitget", "gate", "okx"]);
    expect(latest.htx).toBeUndefined();
  });

  it("paginates beyond PostgREST's 1,000-row cap and samples across page boundaries", async () => {
    const firstPage = Array.from({ length: 1_000 }, (_, index) => historyRow(index));
    const secondPage = [historyRow(1_000), historyRow(1_001)];
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("limit")).toBe("1000");
      expect(url.searchParams.get("order")).toBe("captured_at.asc,bucket_at.asc,exchange.asc");
      const exchange = url.searchParams.get("exchange");
      if (exchange !== "eq.binance") return jsonResponse([]);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (offset === 0) return jsonResponse(firstPage);
      if (offset === 1_000) return jsonResponse(secondPage);
      throw new Error(`Unexpected history offset ${offset}`);
    });

    const points = await readCexHistory(30, 45);

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(points).toHaveLength(334);
    expect(points.at(-1)).toMatchObject({
      exchange: "binance",
      total_usd: 1_001,
      captured_at: historyRow(1_001).captured_at
    });
  });

  it("samples one aligned complete run instead of mixing each exchange's latest row", async () => {
    const exchanges = ["binance", "okx", "bitget", "htx", "gate"] as const;
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const exchange = url.searchParams.get("exchange")?.replace(/^eq\./, "") as CexExchange;
      const rows = [snapshotRow(exchange, "2026-08-22T00:00:00.000Z")];
      if (exchange !== "gate") rows.push(snapshotRow(exchange, "2026-08-22T00:45:00.000Z"));
      return jsonResponse(rows);
    });

    const points = await readCexHistory(7, 60);

    expect(points).toHaveLength(exchanges.length);
    expect(new Set(points.map((point) => point.bucket_at))).toEqual(
      new Set(["2026-08-22T00:00:00.000Z"])
    );
    expect(points.map((point) => point.exchange)).toEqual(exchanges);
  });

  it("fails the history read when a later page fails instead of returning a truncated series", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const exchange = url.searchParams.get("exchange");
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (exchange !== "eq.binance") return jsonResponse([]);
      if (offset === 0) {
        return jsonResponse(Array.from({ length: 1_000 }, (_, index) => historyRow(index)));
      }
      return new Response("unavailable", { status: 503 });
    });

    await expect(readCexHistory(30, 15)).rejects.toThrow(
      "CEX history read failed with HTTP 503"
    );
  });
});

describe("CEX snapshot storage writes", () => {
  it("writes the pricing basis through the fenced RPC", async () => {
    let stored: Record<string, unknown> | null = null;
    fetchMock.mockImplementation(async (_input, init) => {
      stored = (JSON.parse(String(init?.body)) as { p_snapshot: Record<string, unknown> }).p_snapshot;
      return jsonResponse(true);
    });

    await writeCexSnapshots([{ ...sourceSnapshot("binance"), pricingBasis: "binance-equities-v1" }]);

    expect(stored).toMatchObject({ exchange: "binance", pricing_basis: "binance-equities-v1" });
  });
  it("isolates one exchange write failure instead of losing the whole batch", async () => {
    fetchMock.mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { p_snapshot: { exchange: CexExchange } };
      return body.p_snapshot.exchange === "htx"
        ? new Response(null, { status: 409 })
        : jsonResponse(true);
    });
    const snapshots = (["binance", "okx", "bitget", "htx", "gate"] as const)
      .map((exchange) => sourceSnapshot(exchange));

    const result = await writeCexSnapshots(snapshots);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result).toEqual({
      written: 4,
      skipped: 0,
      failed: 1,
      errors: ["htx: HTTP 409"]
    });
  });

  it("persists a partial attempt that carries the last complete account values", async () => {
    let stored: { exchange: string; status: string; total_usd: number } | null = null;
    fetchMock.mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { p_snapshot: typeof stored };
      stored = body.p_snapshot;
      return jsonResponse(true);
    });
    const complete = sourceSnapshot("gate");
    const partial: CexSourceSnapshot = {
      ...complete,
      status: "partial",
      accounts: complete.accounts.map((account) => ({ ...account, status: "stale" })),
      errors: [{ accountType: "Exchange", message: "total balance unavailable" }]
    };

    const result = await writeCexSnapshots([partial]);

    expect(result).toMatchObject({ written: 1, skipped: 0, failed: 0 });
    expect(stored).toMatchObject({ exchange: "gate", status: "partial", total_usd: 100 });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/rpc/upsert_cex_snapshot_v2");
  });

  it("uses direct storage only during the pre-migration rollout window", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("missing function", { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));

    const result = await writeCexSnapshots([sourceSnapshot("gate")]);

    expect(result).toMatchObject({ written: 1, skipped: 0, failed: 0 });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/rpc/upsert_cex_snapshot_v2");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/cex_snapshots?on_conflict=");
  });

  it("counts a newer-row rejection as skipped rather than failed", async () => {
    fetchMock.mockResolvedValue(jsonResponse(false));

    const result = await writeCexSnapshots([sourceSnapshot("gate")]);

    expect(result).toEqual({ written: 0, skipped: 1, failed: 0, errors: [] });
  });

  it("fences direct writers and pins every cron job to the canonical production URL", () => {
    const migration = readFileSync(join(
      process.cwd(),
      "supabase/migrations/202609060002_fence_cex_writer_and_recover_schedule.sql"
    ), "utf8");

    expect(migration).toContain("security definer");
    expect(migration).toContain("upsert_cex_snapshot_v2");
    expect(migration).toContain("revoke insert, update, delete, truncate");
    expect(migration).toContain("vault.update_secret");
    expect(migration).toContain("https://your-old-app.vercel.app");
    expect(migration).toContain("command ilike '%/api/cron/cex%'");
  });

  it("ships an additive lease migration for overlapping CEX workers", () => {
    const migration = readFileSync(join(
      process.cwd(),
      "supabase/migrations/202609060003_add_cex_sync_lease.sql"
    ), "utf8");

    expect(migration).toContain("claim_cex_sync_v1");
    expect(migration).toContain("finish_cex_sync_v1");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("cex_sync_runs_running_lease_idx");
    expect(migration).toContain("lease_expires_at <= clock_timestamp()");
  });
});

describe("CEX sync lease storage", () => {
  it("claims a cross-instance lease through the database RPC", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{
      claimed: true,
      run_id: 17,
      lease_token: "lease-token",
      reason: "claimed"
    }]));

    const claim = await claimCexSync({
      jobKey: "cex:scheduled:2026-09-06T15:00:00.000Z",
      trigger: "cron",
      startedAt: "2026-09-06T15:00:01.000Z"
    });

    expect(claim).toEqual({
      claimed: true,
      runId: 17,
      leaseToken: "lease-token",
      reason: "claimed",
      mode: "lease"
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/rpc/claim_cex_sync_v1");
  });

  it("uses legacy health logging while the additive RPC is rolling out", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("missing function", { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));

    const claim = await claimCexSync({
      jobKey: "cex:scheduled:2026-09-06T15:00:00.000Z",
      trigger: "cron",
      startedAt: "2026-09-06T15:00:01.000Z"
    });
    const finished = await finishCexSync({
      claim,
      startedAt: "2026-09-06T15:00:01.000Z",
      completedAt: "2026-09-06T15:00:02.000Z",
      status: "success",
      durationMs: 1_000,
      detail: {}
    });

    expect(claim.mode).toBe("legacy");
    expect(finished).toBe(true);
    expect(String(fetchMock.mock.calls[1][0])).toContain("/cex_sync_runs");
  });

  it("finishes only the run associated with the lease token", async () => {
    fetchMock.mockResolvedValue(jsonResponse(true));

    const finished = await finishCexSync({
      claim: {
        claimed: true,
        runId: 17,
        leaseToken: "lease-token",
        reason: "claimed",
        mode: "lease"
      },
      startedAt: "2026-09-06T15:00:01.000Z",
      completedAt: "2026-09-06T15:00:02.000Z",
      status: "success",
      durationMs: 1_000,
      detail: {}
    });

    expect(finished).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/rpc/finish_cex_sync_v1");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      p_run_id: 17,
      p_lease_token: "lease-token"
    });
  });
});

function snapshotRow(exchange: CexExchange, capturedAt: string) {
  return {
    exchange,
    bucket_at: capturedAt,
    captured_at: capturedAt,
    status: "live",
    total_usd: "100",
    item_count: 0,
    accounts: [],
    holdings: [],
    errors: []
  };
}

function sourceSnapshot(exchange: CexExchange): CexSourceSnapshot {
  const capturedAt = "2026-08-22T00:00:00.000Z";
  return {
    exchange,
    name: exchange,
    status: "live",
    capturedAt,
    bucketAt: capturedAt,
    valueUsd: 100,
    itemCount: 1,
    accounts: [{
      id: `${exchange}-spot`,
      name: "Spot",
      status: "live",
      valueUsd: 100,
      itemCount: 1,
      holdings: [{ exchange, accountType: "Spot", symbol: "USDT", amount: 100, valueUsd: 100 }]
    }],
    holdings: [{ exchange, accountType: "Spot", symbol: "USDT", amount: 100, valueUsd: 100 }],
    errors: []
  };
}

const historyStart = Date.parse("2026-08-01T00:00:00.000Z");

function historyRow(index: number) {
  const capturedAt = new Date(historyStart + index * 15 * 60_000).toISOString();
  return {
    exchange: "binance" as const,
    bucket_at: capturedAt,
    captured_at: capturedAt,
    total_usd: String(index),
    status: "live"
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
