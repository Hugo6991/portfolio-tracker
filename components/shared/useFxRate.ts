"use client";

import { useApiQuery } from "@/lib/client/api-query";
import { fallbackFxRate, type FxRateSnapshot } from "@/lib/fx";

export function useFxRate(initialRate: number): FxRateSnapshot {
  const { data, error } = useApiQuery<FxRateSnapshot>("/api/fx");
  return data ?? { ...fallbackFxRate, rate: initialRate, status: error ? "stale" : "seed" };
}
