"use client";

import { useCallback, useEffect, useState } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type PortfolioHealth = {
  compositionUpdatedAt: string;
  sources: Array<{
    id: string;
    name: string;
    status: "live" | "partial" | "preview" | "error";
    cadence: "15m" | "daily" | "manual";
    valueUpdatedAt: string;
    compositionUpdatedAt: string;
    freshnessState: "fresh" | "late" | "stale";
    usingFallback: boolean;
    nextScheduledAt: string | null;
    fallbackAgeHours: number | null;
    pricing?: {
      provider: "defillama";
      cadence: "15m";
      state: "fresh" | "partial" | "stale";
      updatedAt: string | null;
      eligibleTokenCount: number;
      pricedTokenCount: number;
      fallbackTokenCount: number;
      excludedTokenCount?: number;
      anomalyTokenCount?: number;
      staleTokenCount?: number;
      coverageValuePercent: number;
    };
  }>;
  debankBudget: {
    month: string;
    scanCount: number;
    valuationScanCount: number;
    fullScanCount: number;
    providerRequestCount: number;
    estimatedUnitsUsed: number;
    totalBalanceUnitsPerWallet: number;
    valuationWalletsPerDay: number;
    walletCoverageDays: number;
    dailyValuationUnits: number;
    estimatedFullScanUnits: number;
    projectedUnits: number;
    projectedCostUsd: number;
    projectedAnnualUnits: number;
    standardPackageLifetimeYears: number;
    monthlyWarningUnits: number;
    monthlyHardStopUnits: number;
    withinBudget: boolean;
    warning: boolean;
  };
};

export function PortfolioHealthConsole() {
  const [health, setHealth] = useState<PortfolioHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/portfolio/health", { cache: "no-store" });
      const body = await response.json() as PortfolioHealth & { error?: string };
      if (!response.ok) throw new Error(body.error || "Source health is unavailable");
      setHealth(body);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Source health is unavailable");
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => void load(true);
    const timer = window.setInterval(refresh, 300_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  if (loading && !health) {
    return <div className="grid gap-2"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>;
  }
  if (!health) {
    return (
      <div className="grid min-h-40 place-items-center rounded-md bg-muted/25 p-5 text-center" role="alert">
        <div>
          <CircleAlert className="mx-auto h-5 w-5 text-red-600 dark:text-red-300" />
          <p className="mt-2 text-sm">{error || "Source health is unavailable."}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" /> Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        {health.sources.map((source) => (
          <div key={source.id} className="grid gap-2 rounded-md border border-border/70 bg-muted/25 p-3 sm:grid-cols-[1fr_auto] sm:items-center">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">{source.name}</p>
                <Badge variant="muted">{source.cadence === "15m" ? "Every 15 min" : source.cadence === "daily" ? "Daily rotation" : "Manual"}</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {source.id === "debank" ? "Total checked" : "Value updated"} {formatTimestamp(source.valueUpdatedAt)}
                {source.pricing?.updatedAt
                  ? ` · market prices ${formatTimestamp(source.pricing.updatedAt)} (${source.pricing.coverageValuePercent.toFixed(1)}% coverage)`
                  : ""}
                {source.pricing?.excludedTokenCount
                  ? ` · ${source.pricing.excludedTokenCount} unverified or anomalous tokens excluded`
                  : ""}
                {source.nextScheduledAt ? ` · next ${formatTimestamp(source.nextScheduledAt)}` : ""}
              </p>
            </div>
            <Badge variant={source.freshnessState === "fresh" ? "success" : source.freshnessState === "late" ? "warning" : "destructive"}>
              {sourceFreshnessLabel(source)}
            </Badge>
          </div>
        ))}
      </div>

      <div className="rounded-md border border-border/70 bg-muted/20 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="font-semibold">DeBank monthly budget</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {health.debankBudget.valuationScanCount} two-wallet checks · {health.debankBudget.fullScanCount} detail refreshes in {health.debankBudget.month}
              {` · all wallets covered within ${health.debankBudget.walletCoverageDays} days`}
            </p>
          </div>
          <Badge variant={!health.debankBudget.withinBudget ? "destructive" : health.debankBudget.warning ? "warning" : "success"}>
            {!health.debankBudget.withinBudget ? "Paid scans paused" : health.debankBudget.warning ? "Above warning line" : "Within protected budget"}
          </Badge>
        </div>
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-4">
          <Metric label="Projected units" value={health.debankBudget.projectedUnits.toLocaleString("en-US")} />
          <Metric label="Projected cost" value={`US$${health.debankBudget.projectedCostUsd.toFixed(2)}`} />
          <Metric label="1M-unit lifetime" value={`≈ ${health.debankBudget.standardPackageLifetimeYears.toFixed(1)} years`} />
          <Metric label="Warning / hard stop" value={`${health.debankBudget.monthlyWarningUnits.toLocaleString("en-US")} / ${health.debankBudget.monthlyHardStopUnits.toLocaleString("en-US")}`} />
        </div>
      </div>
    </div>
  );
}

export function sourceFreshnessLabel(source: {
  freshnessState: "fresh" | "late" | "stale";
  cadence: "15m" | "daily" | "manual";
  usingFallback: boolean;
}) {
  if (source.freshnessState === "fresh") return "Fresh";
  if (source.freshnessState === "stale") return "Stale";
  if (source.usingFallback) return "Using fallback";
  return source.cadence === "manual" ? "Update due" : "Late";
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 font-semibold tabular-nums">{value}</p></div>;
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Taipei",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
