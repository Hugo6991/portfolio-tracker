import "server-only";

import { fallbackFxRate, type FxRateSnapshot } from "../fx";

let cached: FxRateSnapshot | null = null;

export async function readAgentFxRate(): Promise<FxRateSnapshot> {
  try {
    const response = await fetch("https://open.er-api.com/v6/latest/USD", {
      next: { revalidate: 3_600 },
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) throw new Error(`FX request failed with HTTP ${response.status}`);

    const payload = await response.json() as {
      result?: string;
      time_last_update_utc?: string;
      rates?: { TWD?: number; CNY?: number };
    };
    const rate = Number(payload.rates?.TWD);
    const cnyPerUsd = Number(payload.rates?.CNY);
    if (payload.result !== "success" || !Number.isFinite(rate) || rate <= 0 || !Number.isFinite(cnyPerUsd)) {
      throw new Error("FX response did not include valid TWD and CNY rates");
    }

    cached = {
      base: "USD",
      quote: "TWD",
      rate,
      cnyPerUsd,
      fetchedAt: payload.time_last_update_utc ?? new Date().toISOString(),
      source: "ExchangeRate API",
      status: "updated_today"
    };
    return cached;
  } catch {
    if (cached) return { ...cached, status: "cached" };
    return { ...fallbackFxRate, status: "stale" };
  }
}
