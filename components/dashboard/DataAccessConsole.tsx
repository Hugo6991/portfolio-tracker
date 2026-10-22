"use client";

import { Badge } from "@/components/ui/badge";
import { getFxStatusLabel } from "@/lib/fx";
import { useFxRate } from "@/components/shared/useFxRate";
import type { Portfolio } from "@/lib/data";

export function FxRateConsole({ portfolio }: { portfolio: Portfolio }) {
  const fx = useFxRate(portfolio.meta.fxTwdUsd);

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-2xl font-semibold tabular-nums">1 USD = NT${fx.rate.toFixed(2)}</p>
        <Badge variant={fx.status === "live" || fx.status === "updated_today" ? "success" : "muted"}>{getFxStatusLabel(fx.status)}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">ExchangeRate API through a server route, with a cached fallback</p>
    </div>
  );
}
