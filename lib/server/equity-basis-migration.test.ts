import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VALUATION_BASIS } from "../valuation-basis";

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role service_role; create role anon; create role authenticated;
    create table cex_snapshots (exchange text, bucket_at timestamptz, captured_at timestamptz,
      status text, total_usd numeric, item_count integer, accounts jsonb, holdings jsonb,
      errors jsonb, writer_version text, primary key(exchange,bucket_at));
    create table portfolio_snapshots (captured_at timestamptz, net_worth_usd numeric,
      is_partial boolean, source_count integer, snapshot jsonb, sync_run_id bigint,
      quality_status text, quality jsonb);
    create table portfolio_value_snapshots (captured_at timestamptz, net_worth_usd numeric,
      exchanges_usd numeric, wallets_usd numeric, banks_usd numeric, is_partial boolean,
      source_count integer, sync_run_id bigint, quality_status text, quality jsonb);`);
  await db.exec(readFileSync("supabase/migrations/202609220001_binance_equity_valuation_basis.sql", "utf8"));
  for (const [time, value, basis, status] of [
    ["2026-09-20T00:00:00Z", 385000, null, "complete"],
    ["2026-09-21T00:00:00Z", 399870, VALUATION_BASIS, "complete"],
    ["2026-09-22T00:00:00Z", 900000, VALUATION_BASIS, "degraded"]
  ]) {
    const quality = JSON.stringify({ valuationBasis: basis });
    await db.query("insert into portfolio_value_snapshots values ($1,$2,$2,0,0,false,7,1,$3,$4)", [time,value,status,quality]);
    await db.query("insert into portfolio_snapshots values ($1,$2,false,7,$3,1,$4,$5)", [time,value,JSON.stringify({
      groups: { exchangesUsd: value, walletsUsd: 0, banksUsd: 0 },
      liveValueUsd: value, sources: [], holdings: [{ symbol: "EQ_TSLA", assetClass: "equity", valueUsd: 14870 }]
    }), status, quality]);
  }
}, 20_000);
afterAll(async () => { await db?.close(); });

describe("equity valuation basis migration", () => {
  it("returns only the first corrected baseline without deleting old audit rows", async () => {
    const { rows } = await db.query<{ net_worth_usd: string }>("select * from read_portfolio_history_v2('2026-09-01','daily',$1)", [VALUATION_BASIS]);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].net_worth_usd)).toBe(399870);
    const audit = await db.query<{ count: number }>("select count(*)::int as count from portfolio_snapshots");
    expect(audit.rows[0].count).toBe(3);
  });
  it("keeps equity classification in compact asset chart snapshots", async () => {
    const { rows } = await db.query<{ snapshot: { valuationBasis: string; holdings: Array<{ assetClass: string }> } }>(
      "select * from read_portfolio_chart_snapshots_v2('2026-09-01','assets',$1)", [VALUATION_BASIS]);
    expect(rows).toHaveLength(1);
    expect(rows[0].snapshot.valuationBasis).toBe(VALUATION_BASIS);
    expect(rows[0].snapshot.holdings[0].assetClass).toBe("equity");
  });
  it("stores pricing basis, accepts legacy callers and rejects older writes", async () => {
    const snapshot = { exchange: "binance", bucket_at: "2026-09-22T00:00:00Z",
      captured_at: "2026-09-22T00:01:00Z", status: "live", total_usd: 100,
      item_count: 0, accounts: [], holdings: [], errors: [] };
    const write = (payload: unknown) => db.query<{ ok: boolean }>("select upsert_cex_snapshot_v2($1) as ok", [JSON.stringify(payload)]);
    expect((await write(snapshot)).rows[0].ok).toBe(true);
    expect((await write({ ...snapshot, captured_at: "2026-09-22T00:02:00Z", pricing_basis: VALUATION_BASIS })).rows[0].ok).toBe(true);
    expect((await write(snapshot)).rows[0].ok).toBe(false);
    expect((await db.query<{ pricing_basis: string }>("select pricing_basis from cex_snapshots")).rows[0].pricing_basis).toBe(VALUATION_BASIS);
  });
  it("does not grant anonymous callers access to new readers", async () => {
    for (const name of ["read_portfolio_history_v2", "read_portfolio_chart_snapshots_v2"]) {
      const { rows } = await db.query<{ allowed: boolean }>("select has_function_privilege('anon',$1,'execute') as allowed", [`${name}(timestamptz,text,text)`]);
      expect(rows[0].allowed).toBe(false);
    }
  });
});
