import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let db: PGlite;
const migration = "supabase/migrations/202610030001_durable_request_rate_limits.sql";

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role service_role; create role anon; create role authenticated;");
  await db.exec(readFileSync(migration, "utf8"));
}, 20_000);

afterAll(async () => {
  await db?.close();
});

describe("durable request rate limit migration", () => {
  it("allows the configured window and atomically blocks the next attempt", async () => {
    const key = "a".repeat(64);
    const at = "2026-10-03T12:00:00.000Z";
    const attempts = await Promise.all(Array.from({ length: 11 }, () => consume(key, at, 900, 10)));

    expect(attempts.filter((result) => result.allowed).length).toBe(10);
    expect(attempts.filter((result) => !result.allowed).length).toBe(1);
    expect(attempts.find((result) => !result.allowed)?.retryAfterSeconds).toBe(900);
  });

  it("keeps a blocked key blocked and resets it after the window", async () => {
    const key = "b".repeat(64);
    const at = "2026-10-03T12:00:00.000Z";
    await consume(key, at, 60, 1);
    expect((await consume(key, at, 60, 1)).allowed).toBe(false);
    expect((await consume(key, "2026-10-03T12:01:01.000Z", 60, 1)).allowed).toBe(true);
  });

  it("keeps the table private and exposes the RPC only to the service role", async () => {
    const privileges = (await db.query<{
      anonTableAllowed: boolean;
      authenticatedTableAllowed: boolean;
      serviceRoleTableAllowed: boolean;
      serviceRoleRpcAllowed: boolean;
      anonRpcAllowed: boolean;
      authenticatedRpcAllowed: boolean;
    }>(`
      select
        has_table_privilege('anon', 'request_rate_limits', 'select') as "anonTableAllowed",
        has_table_privilege('authenticated', 'request_rate_limits', 'select') as "authenticatedTableAllowed",
        has_table_privilege('service_role', 'request_rate_limits', 'select') as "serviceRoleTableAllowed",
        has_function_privilege(
          'service_role',
          'consume_request_rate_limit(text,integer,integer,timestamptz)',
          'execute'
        ) as "serviceRoleRpcAllowed",
        has_function_privilege(
          'anon',
          'consume_request_rate_limit(text,integer,integer,timestamptz)',
          'execute'
        ) as "anonRpcAllowed",
        has_function_privilege(
          'authenticated',
          'consume_request_rate_limit(text,integer,integer,timestamptz)',
          'execute'
        ) as "authenticatedRpcAllowed"
    `)).rows[0];
    expect(privileges).toEqual({
      anonTableAllowed: false,
      authenticatedTableAllowed: false,
      serviceRoleTableAllowed: false,
      serviceRoleRpcAllowed: true,
      anonRpcAllowed: false,
      authenticatedRpcAllowed: false
    });
  });

  it("rejects null policy inputs before attempting a write", async () => {
    const key = "c".repeat(64);
    const at = "2026-10-03T12:00:00.000Z";

    await expect(
      db.query("select consume_request_rate_limit($1, $2, $3, $4)", [key, null, 10, at])
    ).rejects.toThrow("Rate-limit window is invalid");
    await expect(
      db.query("select consume_request_rate_limit($1, $2, $3, $4)", [key, 60, null, at])
    ).rejects.toThrow("Rate-limit attempt count is invalid");
    await expect(
      db.query("select consume_request_rate_limit($1, $2, $3, $4)", [key, 60, 10, null])
    ).rejects.toThrow("Rate-limit timestamp is invalid");
  });
});

async function consume(key: string, at: string, windowSeconds: number, maxAttempts: number) {
  return (await db.query<{ result: { allowed: boolean; attemptCount: number; retryAfterSeconds: number } }>(
    "select consume_request_rate_limit($1, $2, $3, $4) as result",
    [key, windowSeconds, maxAttempts, at]
  )).rows[0].result;
}
