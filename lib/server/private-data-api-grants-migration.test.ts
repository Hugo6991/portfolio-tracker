import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationDirectory = "supabase/migrations";
const migrationFiles = readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql"));
const hardeningFile = migrationFiles.find((name) => name.endsWith("_harden_private_data_api_access.sql"));
const hardeningMigration = hardeningFile
  ? readFileSync(`${migrationDirectory}/${hardeningFile}`, "utf8")
  : "";
const ordinaryTables = [
  "portfolio_snapshots",
  "portfolio_sync_runs",
  "expense_events",
  "cex_snapshots",
  "cex_sync_runs",
  "portfolio_value_snapshots",
  "portfolio_current",
  "portfolio_source_state",
  "portfolio_history_corrections",
  "portfolio_legacy_history_corrections",
  "expense_batches",
  "expense_entries"
];

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role service_role; create role anon; create role authenticated;");
  for (const table of ordinaryTables) {
    await db.exec(`create table public.${table} (id bigserial primary key);`);
  }
  await db.exec(`
    create table public.request_rate_limits (
      key_hash text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
      window_started_at timestamptz not null,
      attempt_count integer not null check (attempt_count > 0),
      blocked_until timestamptz,
      updated_at timestamptz not null
    );
    grant all on all tables in schema public to anon, authenticated, service_role;
    grant all on all sequences in schema public to anon, authenticated, service_role;
  `);
  await db.exec(hardeningMigration);
}, 20_000);

afterAll(async () => {
  await db?.close();
});

describe("private Supabase Data API grants", () => {
  it("keeps the migration timeline unique and aligned with production names", () => {
    const versions = migrationFiles.map((name) => name.split("_")[0]);

    expect(new Set(versions).size).toBe(versions.length);
    expect(migrationFiles).toContain("202608130002_add_htx_cex_source.sql");
    expect(migrationFiles).toContain("202608130003_schedule_cex_sync.sql");
    expect(migrationFiles).toContain("202609220002_restore_portfolio_display_history.sql");
    expect(migrationFiles).toContain("202609220003_restore_september_5_history.sql");
  });

  it("ships explicit default grant policy and RPC only storage fences", () => {
    const config = readFileSync("supabase/config.toml", "utf8");

    expect(hardeningFile).toBeDefined();
    expect(config).toContain("auto_expose_new_tables = false");
    expect(hardeningMigration).toContain("alter default privileges for role postgres in schema public");
    expect(hardeningMigration).toContain("revoke all on tables from anon, authenticated, service_role");
    expect(hardeningMigration).toContain("revoke execute on functions from anon, authenticated, service_role");
    expect(hardeningMigration).toContain("revoke execute on functions from public");
    expect(hardeningMigration).toContain("revoke all on table public.request_rate_limits from service_role");
    expect(hardeningMigration).toContain("revoke insert, update, delete, truncate");
    expect(hardeningMigration).toContain("on table public.cex_snapshots");
    expect(hardeningMigration).toContain("grant execute on all functions in schema public to service_role");
  });

  it("removes browser role access while retaining only required server access", async () => {
    const privileges = (await db.query<Record<string, boolean>>(`
      select
        has_table_privilege('anon', 'portfolio_snapshots', 'select') as "anonTable",
        has_table_privilege('authenticated', 'portfolio_snapshots', 'select') as "authenticatedTable",
        has_table_privilege('service_role', 'portfolio_snapshots', 'select,insert') as "snapshotWrite",
        has_table_privilege('service_role', 'portfolio_snapshots', 'update') as "snapshotUpdate",
        has_table_privilege('service_role', 'portfolio_sync_runs', 'select,insert,update') as "syncWrite",
        has_table_privilege('service_role', 'portfolio_sync_runs', 'delete') as "syncDelete",
        has_table_privilege('service_role', 'cex_snapshots', 'select') as "cexRead",
        has_table_privilege('service_role', 'cex_snapshots', 'insert') as "cexDirectWrite",
        has_table_privilege('service_role', 'request_rate_limits', 'select,insert,update,delete') as "rateLimitDirect",
        has_function_privilege(
          'service_role',
          'consume_request_rate_limit(text,integer,integer,timestamptz)',
          'execute'
        ) as "serviceRpc",
        has_function_privilege(
          'anon',
          'consume_request_rate_limit(text,integer,integer,timestamptz)',
          'execute'
        ) as "anonRpc"
    `)).rows[0];

    expect(privileges).toEqual({
      anonTable: false,
      authenticatedTable: false,
      snapshotWrite: true,
      snapshotUpdate: false,
      syncWrite: true,
      syncDelete: false,
      cexRead: true,
      cexDirectWrite: false,
      rateLimitDirect: false,
      serviceRpc: true,
      anonRpc: false
    });
  });

  it("keeps future public schema objects private by default", async () => {
    await db.exec("create table public.future_private_table (id bigserial primary key);");
    const privileges = (await db.query<Record<string, boolean>>(`
      select
        has_table_privilege('anon', 'future_private_table', 'select') as "anonTable",
        has_table_privilege('authenticated', 'future_private_table', 'select') as "authenticatedTable",
        has_table_privilege('service_role', 'future_private_table', 'select') as "serviceTable"
    `)).rows[0];

    expect(privileges).toEqual({
      anonTable: false,
      authenticatedTable: false,
      serviceTable: false
    });
  });
});
