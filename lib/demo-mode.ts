/**
 * Demo mode serves synthetic fixtures from lib/server/demo-fixtures.ts instead of
 * Supabase, and skips viewer login. It exists so the open source copy of this app can
 * run with `PORTFOLIO_DEMO_MODE=1 npm run dev` and no credentials at all.
 *
 * Off unless the variable is exactly "1". Never enable it on a deployment that also
 * has Supabase or provider keys configured; the fixtures would mask real data.
 */
export function isDemoMode() {
  return process.env.PORTFOLIO_DEMO_MODE === "1";
}
