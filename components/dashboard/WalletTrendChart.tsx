"use client";

import { useApiQuery } from "@/lib/client/api-query";

import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from "recharts";
import { ArrowDownRight, ArrowUpRight, RefreshCw } from "lucide-react";
import { useCurrency } from "@/components/shared/Providers";
import { useFxRate } from "@/components/shared/useFxRate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatMoney } from "@/lib/format";
import { toDisplayAmount } from "@/lib/fx";
import type { WalletHistoryResponse } from "@/lib/wallet-history";
import { buildWalletOverviewTrend } from "@/lib/wallet-trend";
import { cn } from "@/lib/utils";
import { chartActiveDot, chartCursor, useChartMotion, useTooltipMotion } from "@/components/dashboard/chart-motion";

const ranges = { "1M": 30, "3M": 90, "1Y": 365 } as const;
type HistoryRange = keyof typeof ranges;

type TrendPoint = {
  date: string;
  valueUsd: number | null;
  displayValue: number | null;
  trackedWalletCount?: number;
};

type WalletTrendSelection = {
  walletId: string;
  name: string;
};

export function WalletTrendChart({
  currentValueUsd,
  currentComplete,
  generatedAt,
  walletIds,
  selection
}: {
  currentValueUsd: number;
  currentComplete: boolean;
  generatedAt: string;
  walletIds: string[];
  selection: WalletTrendSelection | null;
}) {
  const chartMotion = useChartMotion();
  const tooltipMotion = useTooltipMotion();
  const [range, setRange] = useState<HistoryRange>("3M");
  const { data, error, loading, refresh } = useApiQuery<WalletHistoryResponse>(`/api/wallets/history?days=${ranges[range]}`);
  const load = () => refresh().catch(() => undefined);
  const { currency } = useCurrency();
  const fx = useFxRate(32);

  const points = useMemo(() => {
    const selectedSeries = selection
      ? data?.wallets.find((wallet) => wallet.walletId === selection.walletId)
      : null;
    const history = selection
      ? (selectedSeries?.points || []).map((point) => ({
          date: point.date,
          valueUsd: point.quality === "complete" ? point.valueUsd : null
        }))
      : buildWalletOverviewTrend(data ?? null, walletIds);
    const currentDate = taipeiDate(generatedAt);
    const current = {
      date: currentDate,
      valueUsd: currentComplete ? currentValueUsd : null,
      trackedWalletCount: selection ? undefined : walletIds.length
    };
    const latest = history.slice(-1)[0];
    const withCurrent = latest?.date === currentDate
      ? [...history.slice(0, -1), current]
      : [...history, current];
    return withCurrent.map((point) => ({
      ...point,
      displayValue: point.valueUsd === null ? null : toDisplayAmount(point.valueUsd, currency, fx.rate)
    }));
  }, [currency, currentComplete, currentValueUsd, data, fx.rate, generatedAt, selection, walletIds]);
  const change = calculateChange(points);
  const delta = calculateDelta(points);
  const domain = calculateDomain(points);
  const validPointCount = points.filter((point) => point.valueUsd !== null).length;

  return (
    <Card className="h-full min-w-0">
      <CardHeader className="flex-col items-start gap-4 space-y-0 p-5 pb-3 sm:flex-row sm:items-start sm:justify-between sm:p-6 sm:pb-3">
        <div className="min-w-0">
          <CardTitle>{selection ? `${selection.name} trend` : "On-chain trend"}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{selection ? "Daily value for this address" : "Recorded balances for the current wallet view"}</p>
          {!loading && validPointCount >= 2 ? (
            <p className={cn(
              "mt-2 flex items-center gap-1 text-sm font-semibold tabular-nums",
              change === 0 ? "text-muted-foreground" : change > 0 ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"
            )}>
              {change > 0 ? <ArrowUpRight className="h-4 w-4" aria-hidden="true" /> : null}
              {change < 0 ? <ArrowDownRight className="h-4 w-4" aria-hidden="true" /> : null}
              {formatSignedMoney(delta, currency, fx.rate)} · {formatChange(change)}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            value={range}
            onValueChange={(value) => value && setRange(value as HistoryRange)}
            size="sm"
            variant="ghost"
            className="rounded-md border border-border/70 bg-muted/25 p-1"
            aria-label="Wallet history range"
          >
            {(Object.keys(ranges) as HistoryRange[]).map((item) => (
              <ToggleGroupItem key={item} value={item} className="h-7 px-3 text-xs">
                {item}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </CardHeader>
      <CardContent className="p-5 pt-0 sm:p-6 sm:pt-0" aria-busy={loading}>
        {loading ? <Skeleton className="h-[292px] w-full rounded-md" role="status" aria-label="Loading wallet history" /> : null}
        {!loading && error ? (
          <TrendState message="Wallet history is unavailable right now." action={() => void load()} />
        ) : null}
        {!loading && !error && validPointCount < 2 ? (
          <TrendState message={selection ? "This wallet needs a second daily snapshot before its trend can be drawn." : "The trend will appear after a second daily wallet snapshot."} />
        ) : null}
        {!loading && !error && validPointCount >= 2 ? (
          <div className="h-[292px]" role="img" aria-label={`Wallet value trend, ${formatChange(change)}`}>
            <ResponsiveContainer>
              <AreaChart data={points} margin={{ left: 0, right: 8, top: 16, bottom: 0 }}>
                <defs>
                  <linearGradient id="walletTrendFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#2dd4bf" stopOpacity={0.28} />
                    <stop offset="95%" stopColor="#2dd4bf" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.45} />
                <XAxis
                  dataKey="date"
                  tickFormatter={shortDate}
                  tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={32}
                />
                <YAxis hide domain={domain} />
                <Tooltip {...tooltipMotion} cursor={chartCursor} content={<WalletTrendTooltip currency={currency} />} />
                <Area
                  type="monotone"
                  dataKey="displayValue"
                  stroke="#2dd4bf"
                  fill="url(#walletTrendFill)"
                  strokeWidth={2.5}
                  connectNulls={false}
                  dot={false}
                  activeDot={chartActiveDot("#2dd4bf")}
                  {...chartMotion}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function WalletTrendTooltip({ active, payload, currency }: TooltipProps<number, string> & { currency: "USD" | "TWD" }) {
  const point = payload?.[0]?.payload as TrendPoint | undefined;
  if (!active || !point || point.displayValue === null) return null;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-popover-foreground shadow-card">
      <p className="text-xs text-muted-foreground">{formatDate(point.date)}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums">{formatMoney(point.displayValue, currency)}</p>
      {point.trackedWalletCount !== undefined ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {point.trackedWalletCount} {point.trackedWalletCount === 1 ? "wallet" : "wallets"} recorded
        </p>
      ) : null}
    </div>
  );
}

function TrendState({ message, action }: { message: string; action?: () => void }) {
  return (
    <div className="grid min-h-[292px] place-items-center rounded-md bg-muted/25 px-5 text-center" role={action ? "alert" : "status"}>
      <div>
        <p className="max-w-sm text-sm leading-6 text-muted-foreground">{message}</p>
        {action ? (
          <Button type="button" size="sm" variant="outline" className="mt-3" onClick={action}>
            <RefreshCw aria-hidden="true" />
            Retry history
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function calculateChange(points: TrendPoint[]) {
  const values = points.flatMap((point) => point.valueUsd === null ? [] : [point.valueUsd]);
  const first = values[0];
  const last = values.slice(-1)[0];
  if (first === undefined || last === undefined || first === 0) return 0;
  return ((last - first) / first) * 100;
}

function calculateDelta(points: TrendPoint[]) {
  const values = points.flatMap((point) => point.valueUsd === null ? [] : [point.valueUsd]);
  const first = values[0];
  const last = values.slice(-1)[0];
  return first === undefined || last === undefined ? 0 : last - first;
}

function calculateDomain(points: TrendPoint[]): [number, number] {
  const values = points.flatMap((point) => point.displayValue === null ? [] : [point.displayValue]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  const padding = min === max ? Math.max(Math.abs(min) * 0.01, 1) : (max - min) * 0.08;
  return [min - padding, max + padding];
}

function formatChange(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatSignedMoney(valueUsd: number, currency: "USD" | "TWD", fxRate: number) {
  const value = formatMoney(toDisplayAmount(Math.abs(valueUsd), currency, fxRate), currency);
  return valueUsd > 0 ? `+${value}` : valueUsd < 0 ? `−${value}` : value;
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(`${value}T00:00:00Z`));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" }).format(new Date(`${value}T00:00:00Z`));
}

function taipeiDate(value: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}
