import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LivePortfolioSnapshot } from "../live-portfolio";
import { canonicalizeDailyWalletSnapshots } from "../wallet-history";
import { canonicalizeDailyAssetSnapshots } from "../asset-history";

let db: PGlite;
const trusted: LivePortfolioSnapshot[] = [];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role service_role;
    create table portfolio_snapshots (
      captured_at timestamptz, net_worth_usd numeric, is_partial boolean,
      source_count integer, snapshot jsonb, sync_run_id bigint, quality_status text
    );`);
  await db.exec(readFileSync("supabase/migrations/202609180001_compact_portfolio_chart_reads.sql", "utf8"));
  for (const [time, value, state, tracked] of [
    ["2026-09-04T17:00:00Z", 100, "legacy", true],
    ["2026-09-05T17:00:00Z", 200, "complete", true],
    ["2026-09-05T18:00:00Z", 220, "complete", true],
    ["2026-09-05T19:00:00Z", 999999, "degraded", true],
    ["2026-09-06T17:00:00Z", 800000, "legacy", true],
    ["2026-09-07T17:00:00Z", 0, "complete", false],
    ["2026-09-08T17:00:00Z", 0, "complete", true]
  ] as const) {
    const snapshot = fixture(time, value, tracked);
    // A tracked but failed wallet must retain a null gap, not become a zero.
    if (time.includes("09-08")) snapshot.wallets[0].status = "error";
    await db.query("insert into portfolio_snapshots values ($1,$2,false,2,$3,$4,$5)", [
      time, value, JSON.stringify(snapshot), state === "legacy" ? null : 1,
      state === "legacy" ? null : state
    ]);
    if (state === "complete" || time.includes("09-04")) trusted.push(snapshot);
  }
}, 20_000);

afterAll(async () => { await db?.close(); });

async function read(view: string) {
  const result = await db.query<{
    captured_at: Date; net_worth_usd: string; is_partial: boolean;
    source_count: number; snapshot: LivePortfolioSnapshot;
  }>("select * from read_portfolio_chart_snapshots($1,$2)", ["2026-09-01", view]);
  return result.rows.map((row) => ({
    ...row.snapshot, generatedAt: row.captured_at.toISOString(),
    netWorthUsd: Number(row.net_worth_usd), isPartial: row.is_partial,
    connectedSourceCount: row.source_count
  }));
}

describe("compact chart SQL against PostgreSQL", () => {
  it("matches full-snapshot wallet history including removals, failures and the trusted cutover", async () => {
    const compact = await read("wallets");
    expect(canonicalizeDailyWalletSnapshots(compact)).toEqual(canonicalizeDailyWalletSnapshots(trusted));
    expect(compact).toHaveLength(4);
    expect(JSON.stringify(compact)).not.toContain("large-token-detail");
  });
  it("matches asset history without losing the authoritative live total", async () => {
    expect(canonicalizeDailyAssetSnapshots(await read("assets"))).toEqual(canonicalizeDailyAssetSnapshots(trusted));
  });
  it("does not expose a new anonymous database read function", async () => {
    const result = await db.query<{ allowed: boolean }>("select has_function_privilege('public', 'read_portfolio_chart_snapshots(timestamptz,text)', 'execute') as allowed");
    expect(result.rows[0].allowed).toBe(false);
  });
});

function fixture(time: string, value: number, tracked: boolean): LivePortfolioSnapshot {
  return {
    generatedAt: new Date(time).toISOString(), netWorthUsd: value,
    liveValueUsd: value + 5, previewValueUsd: 0, isPartial: false,
    groups: { exchangesUsd: 0, walletsUsd: value, banksUsd: 0 },
    sources: ["debank", "hyperliquid"].map((id) => ({
      id, name: id, kind: "wallet", status: "live", valueUsd: value,
      itemCount: 1, updatedAt: time, detail: ""
    })),
    holdings: [{ symbol: "USDC", name: "USD Coin", amount: value, valueUsd: value, sources: ["debank"], accountCount: 1 }],
    wallets: tracked ? [{
      id: "wallet-1", name: "Wallet", address: "0xabc", valueUsd: value,
      debankValueUsd: value, hyperliquidValueUsd: 0, status: "live", tokens: [
        { name: "large-token-detail" }
      ], positions: []
    } as unknown as LivePortfolioSnapshot["wallets"][number]] : [],
    connectedSourceCount: 2, expectedSourceCount: 2, errors: []
  };
}
