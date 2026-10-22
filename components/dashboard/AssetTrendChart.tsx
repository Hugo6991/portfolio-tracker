"use client";

import { useApiQuery } from "@/lib/client/api-query";

import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps
} from "recharts";
import { ArrowDownRight, ArrowUpRight, RefreshCw } from "lucide-react";
import { useCurrency } from "@/components/shared/Providers";
import { useFxRate } from "@/components/shared/useFxRate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  calendarizeAssetHistory,
  getAssetHistorySeriesValue,
  type AssetHistoryResponse,
  type AssetHistorySeries
} from "@/lib/asset-history";
import { formatMoney } from "@/lib/format";
import { toDisplayAmount } from "@/lib/fx";
import { cn } from "@/lib/utils";
import { chartActiveDot, chartCursor, useChartMotion, useTooltipMotion } from "@/components/dashboard/chart-motion";

const ranges = { "1M": 30, "3M": 90, "1Y": 365, All: 730 } as const;
type HistoryRange = keyof typeof ranges;
type AssetTrendSeries = AssetHistorySeries;
type TrendMode = "value" | "share";

const seriesOptions: Array<{ id: AssetTrendSeries; label: string; color: string }> = [
  { id: "total", label: "All assets", color: "#10b981" },
  { id: "stablecoins", label: "Stablecoins", color: "#f0b90b" },
  { id: "btc", label: "BTC", color: "#f7931a" },
  { id: "hype", label: "HYPE", color: "#6ee7b7" },
  { id: "bnb", label: "BNB", color: "#f3ba2f" },
  { id: "eth", label: "ETH", color: "#627eea" },
  { id: "uni", label: "UNI", color: "#38bdf8" },
  { id: "equities", label: "Stocks", color: "#a78bfa" },
  { id: "other", label: "Other", color: "#64748b" }
];

export function AssetTrendChart() {
  const chartMotion = useChartMotion();
  const tooltipMotion = useTooltipMotion();
  const [range, setRange] = useState<HistoryRange>("1M");
  const [series, setSeries] = useState<AssetTrendSeries>("total");
  const [mode, setMode] = useState<TrendMode>("value");
  const { data, error, loading, refresh } = useApiQuery<AssetHistoryResponse>(`/api/assets/history?days=${ranges[range]}`);
  const load = () => refresh().catch(() => undefined);
  const { currency } = useCurrency();
  const fx = useFxRate(32);

  useEffect(() => {
    if (series === "total" && mode === "share") setMode("value");
  }, [mode, series]);

  const selectedOption = seriesOptions.find((option) => option.id === series) ?? seriesOptions[0];
  const points = useMemo(() => calendarizeAssetHistory(data?.points ?? []).map(({ date, point }) => {
    const valueUsd = point ? getAssetHistorySeriesValue(point, series) : null;
    return {
      ...point,
      date,
      valueUsd,
      displayValue: valueUsd === null
        ? null
        : mode === "share"
          ? point && (point.totalInvestableUsd ?? point.totalLiveCryptoUsd) > 0 ? (valueUsd / (point.totalInvestableUsd ?? point.totalLiveCryptoUsd)) * 100 : null
          : toDisplayAmount(valueUsd, currency, fx.rate)
    };
  }), [currency, data?.points, fx.rate, mode, series]);
  const change = calculateChange(points);
  const delta = calculateDelta(points);
  const shareDelta = calculateDisplayDelta(points);
  const domain = calculateDomain(points);
  const validPointCount = points.filter((point) => point.displayValue !== null).length;
  const direction = mode === "share" ? shareDelta : delta;
  const latestVisibleDate = points.slice().reverse().find((point) => point.displayValue !== null)?.date;

  return (
    <Card className="h-full min-w-0">
      <CardHeader className="space-y-4 p-5 pb-3 sm:p-6 sm:pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <CardTitle>Holdings trend</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Daily value by asset class{latestVisibleDate ? ` · Through ${formatDate(latestVisibleDate)}` : ""}
            </p>
            {validPointCount >= 2 ? (
              <p
                className={cn(
                  "mt-2 flex items-center gap-1 text-sm font-semibold tabular-nums",
                  direction === 0
                    ? "text-muted-foreground"
                    : direction > 0
                      ? "text-emerald-700 dark:text-emerald-300"
                      : "text-red-700 dark:text-red-300"
                )}
              >
                {direction > 0 ? <ArrowUpRight className="h-4 w-4" aria-hidden="true" /> : null}
                {direction < 0 ? <ArrowDownRight className="h-4 w-4" aria-hidden="true" /> : null}
                {mode === "share"
                  ? `${formatSignedPoints(shareDelta)} allocation change`
                  : `${formatSignedMoney(delta, currency, fx.rate)} · ${formatChange(change)}`}
                <span className="font-normal text-muted-foreground">{selectedOption.label}</span>
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <ToggleGroup
              type="single"
              value={mode}
              onValueChange={(value) => value && setMode(value as TrendMode)}
              size="sm"
              variant="ghost"
              className="w-fit rounded-md border border-border/70 bg-muted/25 p-1"
              aria-label="Trend display mode"
            >
              <ToggleGroupItem value="value" className="h-7 px-2 text-xs">Value</ToggleGroupItem>
              <ToggleGroupItem value="share" disabled={series === "total"} className="h-7 px-2 text-xs">Share %</ToggleGroupItem>
            </ToggleGroup>
            <ToggleGroup
              type="single"
              value={range}
              onValueChange={(value) => value && setRange(value as HistoryRange)}
              size="sm"
              variant="ghost"
              className="w-fit rounded-md border border-border/70 bg-muted/25 p-1"
              aria-label="Asset history range"
            >
              {Object.keys(ranges).map((item) => (
                <ToggleGroupItem key={item} value={item} className="h-7 px-2 text-xs sm:px-3">
                  {item}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>
        <fieldset className="flex w-full min-w-0 max-w-full gap-1.5 overflow-x-auto pb-1" aria-label="Asset trend series">
          {seriesOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={series === option.id}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition",
                "hover:border-foreground/25 hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                series === option.id
                  ? "border-foreground/25 bg-foreground text-background"
                  : "border-border/70 bg-muted/20 text-muted-foreground"
              )}
              onClick={() => setSeries(option.id)}
            >
              {option.label}
            </button>
          ))}
        </fieldset>
      </CardHeader>
      <CardContent className="p-5 pt-0 sm:p-6 sm:pt-0" aria-busy={loading}>
        {loading ? <Skeleton className="h-64 w-full rounded-md" aria-label="Loading asset history" /> : null}
        {!loading && error ? <ChartState message="Asset history is unavailable right now." action={() => void load()} /> : null}
        {!loading && !error && validPointCount < 2 ? <ChartState message="The trend appears after two complete daily snapshots." /> : null}
        {!loading && !error && validPointCount >= 2 ? (
          <div
            className="h-64"
            role="img"
            aria-label={mode === "share"
              ? `${selectedOption.label} allocation-share trend, ${formatSignedPoints(shareDelta)}`
              : `${selectedOption.label} holdings trend, ${formatChange(change)}`}
          >
            <ResponsiveContainer>
              <AreaChart data={points} margin={{ left: 0, right: 8, top: 12, bottom: 0 }}>
                <defs>
                  <linearGradient id="assetTrendFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={selectedOption.color} stopOpacity={0.32} />
                    <stop offset="95%" stopColor={selectedOption.color} stopOpacity={0.015} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.42} />
                <XAxis
                  dataKey="date"
                  tickFormatter={shortDate}
                  tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={32}
                />
                <YAxis hide domain={domain} />
                <Tooltip {...tooltipMotion} cursor={chartCursor} content={<AssetTooltip currency={currency} label={selectedOption.label} mode={mode} />} />
                <Area
                  type="monotone"
                  dataKey="displayValue"
                  stroke={selectedOption.color}
                  fill="url(#assetTrendFill)"
                  strokeWidth={2.5}
                  connectNulls={false}
                  dot={false}
                  activeDot={chartActiveDot(selectedOption.color)}
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

function AssetTooltip({ active, payload, currency, label, mode }: TooltipProps<number, string> & { currency: "USD" | "TWD"; label: string; mode: TrendMode }) {
  const point = payload?.[0]?.payload as { date?: string; displayValue?: number | null } | undefined;
  if (!active || !point?.date || point.displayValue === undefined || point.displayValue === null) return null;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-popover-foreground shadow-card">
      <p className="text-xs text-muted-foreground">{formatDate(point.date)}</p>
      <p className="mt-1 text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums">
        {mode === "share" ? `${point.displayValue.toFixed(2)}%` : formatMoney(point.displayValue, currency)}
      </p>
    </div>
  );
}

function ChartState({ message, action }: { message: string; action?: () => void }) {
  return (
    <div className="grid min-h-64 place-items-center rounded-md bg-muted/25 px-5 text-center" role={action ? "alert" : "status"}>
      <div>
        <p className="text-sm leading-6 text-muted-foreground">{message}</p>
        {action ? <Button size="sm" variant="outline" className="mt-3" onClick={action}><RefreshCw />Retry</Button> : null}
      </div>
    </div>
  );
}

function calculateChange(points: Array<{ valueUsd: number | null }>) {
  const values = points.flatMap((point) => point.valueUsd === null ? [] : [point.valueUsd]);
  const first = values[0] ?? 0;
  const last = values.slice(-1)[0] ?? 0;
  return first === 0 ? 0 : ((last - first) / first) * 100;
}

function calculateDelta(points: Array<{ valueUsd: number | null }>) {
  const values = points.flatMap((point) => point.valueUsd === null ? [] : [point.valueUsd]);
  return (values.slice(-1)[0] ?? 0) - (values[0] ?? 0);
}

function calculateDisplayDelta(points: Array<{ displayValue: number | null }>) {
  const values = points.flatMap((point) => point.displayValue === null ? [] : [point.displayValue]);
  return (values.slice(-1)[0] ?? 0) - (values[0] ?? 0);
}

function calculateDomain(points: Array<{ displayValue: number | null }>): [number, number] {
  const values = points.flatMap((point) => point.displayValue === null ? [] : [point.displayValue]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  const padding = min === max ? Math.max(Math.abs(min) * 0.01, 1) : (max - min) * 0.08;
  return [Math.max(0, min - padding), max + padding];
}

function formatSignedMoney(valueUsd: number, currency: "USD" | "TWD", fxRate: number) {
  const converted = toDisplayAmount(Math.abs(valueUsd), currency, fxRate);
  const value = formatMoney(converted, currency);
  return valueUsd > 0 ? `+${value}` : valueUsd < 0 ? `−${value}` : value;
}

function formatChange(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatSignedPoints(value: number) {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)} pp`;
}

function formatDate(value: string) {
  return new Date(`${value}T00:00:00+08:00`).toLocaleDateString("en", { dateStyle: "medium" });
}

function shortDate(value: string) {
  const [, month, day] = value.split("-");
  return `${month}/${day}`;
}
