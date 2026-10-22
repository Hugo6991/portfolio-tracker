import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("production domain migration", () => {
  it("moves every database-owned sync job to the new canonical domain", () => {
    const migration = readFileSync(join(
      process.cwd(),
      "supabase/migrations/202609210001_switch_production_domain.sql"
    ), "utf8");

    expect(migration).toContain("https://your-app.vercel.app");
    expect(migration).not.toContain("https://your-old-app.vercel.app");
    expect(migration).toContain("vault.update_secret");
    expect(migration).toContain("portfolio-cex-sync-15m");
    expect(migration).toContain("portfolio-current-sync-15m");
    expect(migration).toContain("portfolio-full-sync-daily");
    expect(migration).toContain("'/api/cron/cex'");
    expect(migration).toContain("'/api/cron/portfolio-value'");
    expect(migration).toContain("'/api/cron/portfolio'");
  });
});
