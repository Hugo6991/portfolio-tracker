export type Currency = "USD" | "TWD";

export type FxRateSnapshot = {
  base: "USD";
  quote: "TWD";
  rate: number;
  cnyPerUsd: number;
  fetchedAt: string;
  source: "ExchangeRate API" | "Seed data";
  status: "live" | "updated_today" | "cached" | "stale" | "seed";
};

export const fallbackFxRate: FxRateSnapshot = {
  base: "USD",
  quote: "TWD",
  rate: 31,
  cnyPerUsd: 7.2,
  fetchedAt: "2026-07-04T00:00:00+08:00",
  source: "Seed data",
  status: "seed"
};

export function usdToTwd(valueUsd: number, fxTwdUsd: number) {
  return valueUsd * fxTwdUsd;
}

export function twdToUsd(valueTwd: number, fxTwdUsd: number) {
  return valueTwd / fxTwdUsd;
}

export function toDisplayAmount(valueUsd: number, currency: Currency, fxTwdUsd: number) {
  return currency === "USD" ? valueUsd : valueUsd * fxTwdUsd;
}

export function toDisplayFromTwd(valueTwd: number, currency: Currency, fxTwdUsd: number) {
  return currency === "TWD" ? valueTwd : twdToUsd(valueTwd, fxTwdUsd);
}

export function getFxStatusLabel(status: FxRateSnapshot["status"]) {
  const labels: Record<FxRateSnapshot["status"], string> = {
    live: "Live FX",
    updated_today: "Updated today",
    cached: "Cached FX",
    stale: "Stale FX",
    seed: "Seed FX"
  };
  return labels[status];
}
