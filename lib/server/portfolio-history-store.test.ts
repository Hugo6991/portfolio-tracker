import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LivePortfolioSnapshot } from "../live-portfolio";

vi.mock("server-only", () => ({}));

let readAssetHistory: typeof import("./portfolio-snapshot-store").readAssetHistory;
let readLatestPortfolioReport: typeof import("./portfolio-snapshot-store").readLatestPortfolioReport;
let readPortfolioHistory: typeof import("./portfolio-snapshot-store").readPortfolioHistory;
let readPreviousDailySnapshot: typeof import("./portfolio-snapshot-store").readPreviousDailySnapshot;
let readWalletHistory: typeof import("./portfolio-snapshot-store").readWalletHistory;
let writePortfolioValueSnapshot: typeof import("./portfolio-snapshot-store").writePortfolioValueSnapshot;

const fetchMock = vi.fn<typeof fetch>();

beforeAll(async () => {
  ({
    readAssetHistory,
    readLatestPortfolioReport,
    readPortfolioHistory,
    readPreviousDailySnapshot,
    readWalletHistory,
    writePortfolioValueSnapshot
  } = await import("./portfolio-snapshot-store"));
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

describe("stored wallet and asset histories", () => {
  it("reads compact chart snapshots and preserves both history views", async () => {
    fetchMock.mockImplementation(async (url) => new Response(JSON.stringify(
      String(url).includes("quality_status=eq.complete")
        ? []
        : [storedRow("2026-08-11T17:15:00.000Z", 1_500)]
    ), { status: 200, headers: { "Content-Type": "application/json" } }));

    const walletHistory = await readWalletHistory(30);
    const assetHistory = await readAssetHistory(30);

    expect(walletHistory.overview[0]).toMatchObject({
      date: "2026-08-12",
      valueUsd: 1_500,
      quality: "complete"
    });
    expect(walletHistory.wallets[0].points[0]).toMatchObject({ valueUsd: 1_500 });
    expect(assetHistory[0]).toMatchObject({
      date: "2026-08-12",
      totalLiveCryptoUsd: 1_500,
      valuesUsd: { stablecoins: 1_500 }
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).p_view)).toEqual(["wallets", "assets"]);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toContain("/rpc/read_portfolio_chart_snapshots");
      expect(init).toMatchObject({ cache: "no-store" });
    }
  });

  it("reads compact hourly portfolio points through the bucketed history RPC", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([
      compactRow("2026-08-11T16:07:00.000Z", 1_500, true),
      { ...compactRow("2026-08-11T17:07:00.000Z", 1_600, false), wallets_usd: null }
    ]), { status: 200, headers: { "Content-Type": "application/json" } }));

    const points = await readPortfolioHistory(1, "hourly");

    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      date: "2026-08-12",
      capturedAt: "2026-08-11T16:07:00.000Z",
      netWorthUsd: 1_500,
      isPartial: true
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/rpc/read_portfolio_history");
    expect(JSON.parse(String(init?.body))).toMatchObject({ p_interval: "hourly" });
  });

  it("fails closed instead of mixing legacy portfolio values before the basis RPC exists", async () => {
    fetchMock.mockResolvedValue(new Response("missing function", { status: 404 }));
    await expect(readPortfolioHistory(7, "daily")).rejects.toThrow("HTTP 404");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed instead of mixing legacy asset values before the basis RPC exists", async () => {
    fetchMock.mockResolvedValue(new Response("missing function", { status: 404 }));
    await expect(readAssetHistory(30)).rejects.toThrow("HTTP 404");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stores an hourly compact row without serializing the full snapshot payload", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
    const fullSnapshot = {
      ...storedRow("2026-08-11T17:15:45.000Z", 1_500).snapshot,
      generatedAt: "2026-08-11T17:15:45.000Z"
    };

    await writePortfolioValueSnapshot(fullSnapshot);

    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(String(url)).toContain("/rpc/upsert_portfolio_value_snapshot");
    expect(body).toEqual({
      p_bucket_at: "2026-08-11T17:00:00.000Z",
      p_captured_at: "2026-08-11T17:15:45.000Z",
      p_net_worth_usd: 1_500,
      p_exchanges_usd: 0,
      p_wallets_usd: 1_500,
      p_banks_usd: 0,
      p_is_partial: false,
      p_source_count: 2
    });
    expect(String(init?.body)).not.toContain("holdings");
    expect(String(init?.body)).not.toContain("wallets\"");
  });

  it("rejects incomplete compact values instead of persisting a synthetic zero", async () => {
    const incomplete = {
      ...storedRow("2026-08-11T17:15:45.000Z", 1_500).snapshot,
      generatedAt: "2026-08-11T17:15:45.000Z",
      groups: { exchangesUsd: Number.NaN, walletsUsd: 1_500, banksUsd: 0 }
    };

    await expect(writePortfolioValueSnapshot(incomplete)).rejects.toThrow("incomplete");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the previous complete day instead of a newer partial report baseline", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([
      compactRow("2026-08-10T16:07:00.000Z", 1_400, false),
      compactRow("2026-08-11T16:07:00.000Z", 700, true)
    ]), { status: 200, headers: { "Content-Type": "application/json" } }));
    const current = {
      ...storedRow("2026-08-12T16:07:00.000Z", 1_500).snapshot,
      generatedAt: "2026-08-12T16:07:00.000Z"
    };

    const previous = await readPreviousDailySnapshot(current);

    expect(previous).toMatchObject({
      date: "2026-08-11",
      netWorthUsd: 1_400,
      isPartial: false
    });
  });

  it("ignores reports recorded from partial sync runs", async () => {
    fetchMock.mockResolvedValue(new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));

    await readLatestPortfolioReport();

    expect(String(fetchMock.mock.calls[0][0])).toContain("status=eq.success");
  });

  it("fails closed before fetching when snapshot storage is not configured", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");

    await expect(readWalletHistory()).rejects.toThrow("not configured");
    await expect(readAssetHistory()).rejects.toThrow("not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps post-cutover legacy and Gate Spot-only rows out of trusted history", () => {
    const migration = readFileSync(join(
      process.cwd(),
      "supabase/migrations/202609060001_repair_gate_and_verify_portfolio_history.sql"
    ), "utf8");

    expect(migration).toContain("gate-spot-only");
    expect(migration).toContain("legacy-five-source-writer");
    expect(migration).toContain("portfolio_snapshots_verified_writer_check");
    expect(migration).toContain("portfolio_value_snapshots_verified_writer_check");
    expect(migration).toContain("sync_run_id is not null and compact.quality_status = 'complete'");
    expect(migration).toContain("sync_run_id is not null and snapshots.quality_status = 'complete'");
  });

  it("degrades the known DeBank scam-price history without deleting audit rows", () => {
    const migration = readFileSync(join(
      process.cwd(),
      "supabase/migrations/202609120001_quarantine_debank_spam_history.sql"
    ), "utf8");

    expect(migration).toContain("debank-unverified-token-misprice");
    expect(migration).toContain("2026-09-11T14:28:14.227Z");
    expect(migration).toContain("quality_status = 'degraded'");
    expect(migration).toContain("drop constraint if exists portfolio_value_snapshots_verified_writer_check");
    expect(migration).toContain("add constraint portfolio_value_snapshots_verified_writer_check");
    expect(migration).toContain("add constraint portfolio_snapshots_verified_writer_check");
    expect(migration).not.toMatch(/delete\s+from/i);
  });
});

function compactRow(capturedAt: string, valueUsd: number, isPartial: boolean) {
  return {
    captured_at: capturedAt,
    net_worth_usd: valueUsd,
    exchanges_usd: 0,
    wallets_usd: valueUsd,
    banks_usd: 0,
    is_partial: isPartial,
    source_count: 2
  };
}

function storedRow(capturedAt: string, valueUsd: number) {
  return {
    captured_at: capturedAt,
    net_worth_usd: valueUsd,
    is_partial: false,
    source_count: 2,
    snapshot: {
      generatedAt: "2000-01-01T00:00:00.000Z",
      netWorthUsd: valueUsd,
      liveValueUsd: valueUsd,
      previewValueUsd: 0,
      groups: { exchangesUsd: 0, walletsUsd: valueUsd, banksUsd: 0 },
      sources: [
        source("debank", valueUsd),
        source("hyperliquid", 0)
      ],
      holdings: [
        {
          symbol: "USDT",
          name: "Tether",
          amount: valueUsd,
          valueUsd,
          sources: ["DeBank"],
          accountCount: 1
        }
      ],
      wallets: [
        {
          id: "wallet-1",
          name: "Treasury",
          address: "0x0000000000000000000000000000000000000101",
          debankUrl: "https://debank.com/profile/0x0000000000000000000000000000000000000101",
          valueUsd,
          debankValueUsd: valueUsd,
          hyperliquidValueUsd: 0,
          tokenCount: 1,
          protocolCount: 0,
          status: "live",
          updatedAt: capturedAt
        }
      ],
      connectedSourceCount: 2,
      expectedSourceCount: 2,
      isPartial: false,
      errors: []
    } as unknown as LivePortfolioSnapshot
  };
}

function source(id: "debank" | "hyperliquid", valueUsd: number) {
  return {
    id,
    name: id === "debank" ? "DeBank" : "Hyperliquid",
    kind: "wallet",
    status: "live",
    valueUsd,
    itemCount: 1,
    updatedAt: "2026-08-11T17:15:00.000Z",
    detail: "live"
  };
}
