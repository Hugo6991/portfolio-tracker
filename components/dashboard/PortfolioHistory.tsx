"use client";

import { useApiQuery } from "@/lib/client/api-query";

import { useCallback, useMemo, useState } from "react";
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
import { ArrowDownRight, ArrowUpRight, ChartNoAxesCombined, Clock3, RefreshCw } from "lucide-react";
import {
  buildPortfolioHistoryChartData,
  buildPortfolioHistoryUrl,
  getDefaultPortfolioHistoryRange,
  getPortfolioHistoryRanges,
  getPortfolioHistoryViewState,
  normalizePortfolioHistoryPoints,
  summarizePortfolioHistory,
  type PortfolioHistoryInterval,
  type PortfolioHistoryRangeId
} from "@/components/dashboard/portfolio-history-view-model";
import { useCurrency } from "@/components/shared/Providers";
import { useFxRate } from "@/components/shared/useFxRate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatMoney } from "@/lib/format";
import { toDisplayAmount } from "@/lib/fx";
import type { PortfolioHistoryPoint, PortfolioHistoryResponse } from "@/lib/portfolio-history";
import { cn } from "@/lib/utils";
import { chartActiveDot, chartCursor, useChartMotion, useTooltipMotion } from "@/components/dashboard/chart-motion";

type ChartSeriesPoint = {
  capturedAt: string;
  displayValue: number | null;
  timestamp: number;
  point: PortfolioHistoryPoint | null;
  gapReason: "partial" | "missing" | null;
  missingBucketCount: number;
  carriedFrom: string | null;
};

const chartMargin = { left: 0, right: 8, top: 14, bottom: 0 } as const;
const chartTickStyle = { fontSize: 12, fill: "hsl(var(--muted-foreground))" } as const;
const chartDot = { r: 2, fill: "#10b981", strokeWidth: 0 } as const;

export function PortfolioHistory() {
  const chartMotion = useChartMotion();
  const tooltipMotion = useTooltipMotion();
  const [interval, setInterval] = useState<PortfolioHistoryInterval>("daily");
  const [range, setRange] = useState<PortfolioHistoryRangeId>(getDefaultPortfolioHistoryRange("daily"));
  const { data, error, loading, refresh } = useApiQuery<PortfolioHistoryResponse>(buildPortfolioHistoryUrl(interval, range));
  const loadHistory = () => refresh().catch(() => undefined);
  const { currency } = useCurrency();
  const fx = useFxRate(32);

  const points = useMemo(() => normalizePortfolioHistoryPoints(data?.points || []), [data?.points]);
  const summary = summarizePortfolioHistory(points);
  const chartSeries = useMemo<ChartSeriesPoint[]>(() => (
    buildPortfolioHistoryChartData(points, interval, new Date().toISOString()).map((datum) => ({
      capturedAt: datum.capturedAt,
      displayValue: datum.valueUsd === null ? null : toDisplayAmount(datum.valueUsd, currency, fx.rate),
      timestamp: new Date(datum.capturedAt).getTime(),
      point: datum.point,
      gapReason: datum.gapReason,
      missingBucketCount: datum.missingBucketCount,
      carriedFrom: datum.carriedFrom
    }))
  ), [currency, fx.rate, interval, points]);
  const observedState = getPortfolioHistoryViewState({
    loading,
    error,
    pointCount: summary.pointCount,
    completePointCount: summary.completePointCount
  });
  const state = observedState === "single" && chartSeries.length > 1 ? "ready" : observedState;
  const chartDomain = calculateChartDomain(chartSeries);
  const periodDeltaLabel = formatSignedMoney(summary.deltaUsd, currency, fx.rate);
  const latestValueLabel = summary.lastUsd === null
    ? null
    : formatMoney(toDisplayAmount(summary.lastUsd, currency, fx.rate), currency);
  const ranges = getPortfolioHistoryRanges(interval);
  const carriedCount = chartSeries.filter((point) => point.carriedFrom !== null).length;
  const tickFormatter = useCallback(
    (value: string | number) => formatTick(value, interval, range),
    [interval, range]
  );

  function changeInterval(nextInterval: PortfolioHistoryInterval) {
    setInterval(nextInterval);
    setRange(getDefaultPortfolioHistoryRange(nextInterval));
  }

  return (
    <Card className="h-full min-w-0">
      <CardHeader className="gap-5 space-y-0 p-5 pb-3 sm:p-6 sm:pb-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-sm">Portfolio history</CardTitle>
            {carriedCount > 0 && state !== "loading" ? (
              <Badge variant="muted">{carriedCount} carried forward</Badge>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {interval === "hourly" ? "Hourly portfolio snapshots" : "Daily portfolio snapshots"} · {range}
          </p>
          {state === "ready" ? (
            <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <p className="text-2xl font-semibold tabular-nums sm:text-2xl">{latestValueLabel}</p>
              <p className={cn(
                "flex items-center gap-1 text-sm font-semibold tabular-nums",
                summary.deltaPercent === null || summary.deltaPercent === 0
                  ? "text-muted-foreground"
                  : summary.deltaPercent > 0
                    ? "text-emerald-700 dark:text-emerald-300"
                    : "text-red-700 dark:text-red-300"
              )}>
                {summary.deltaPercent !== null && summary.deltaPercent > 0 ? <ArrowUpRight className="h-4 w-4" aria-hidden="true" /> : null}
                {summary.deltaPercent !== null && summary.deltaPercent < 0 ? <ArrowDownRight className="h-4 w-4" aria-hidden="true" /> : null}
                {periodDeltaLabel} · {formatChange(summary.deltaPercent)}
              </p>
            </div>
          ) : null}
        </div>

        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap lg:justify-end">
          <ToggleGroup
            type="single"
            value={interval}
            onValueChange={(value) => value && changeInterval(value as PortfolioHistoryInterval)}
            size="sm"
            variant="ghost"
            className="w-full justify-start rounded-md border border-border/70 bg-muted/25 p-1 sm:w-auto"
            aria-label="History interval"
          >
            <ToggleGroupItem value="hourly" className="h-8 flex-1 px-3 text-xs sm:flex-none">Hourly</ToggleGroupItem>
            <ToggleGroupItem value="daily" className="h-8 flex-1 px-3 text-xs sm:flex-none">Daily</ToggleGroupItem>
          </ToggleGroup>
          <ToggleGroup
            type="single"
            value={range}
            onValueChange={(value) => value && setRange(value as PortfolioHistoryRangeId)}
            size="sm"
            variant="ghost"
            className="w-full justify-start rounded-md border border-border/70 bg-muted/25 p-1 sm:w-auto"
            aria-label="History range"
          >
            {ranges.map((item) => (
              <ToggleGroupItem key={item.id} value={item.id} className="h-8 flex-1 px-2 text-xs sm:flex-none sm:px-3">
                {item.id}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </CardHeader>

      <CardContent className="p-5 pt-0 sm:p-6 sm:pt-0" aria-busy={loading}>
        {!loading && data?.latestObservation?.hasPerformanceGap ? (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200" role="status">
            <Clock3 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>
              Latest observation at {formatTimestamp(data.latestObservation.capturedAt, interval)} is degraded.
              The chart carries forward the last complete value until a new complete snapshot arrives
            </p>
          </div>
        ) : null}
        {state === "loading" ? (
          <Skeleton className="h-72 w-full rounded-md sm:h-80" role="status" aria-label="Loading portfolio history" />
        ) : null}
        {state === "error" ? (
          <HistoryState
            icon={<ChartNoAxesCombined className="h-5 w-5" aria-hidden="true" />}
            title="History is unavailable"
            message={error || "The snapshot history endpoint could not be reached."}
            action={() => void loadHistory()}
            alert
          />
        ) : null}
        {state === "empty" ? (
          <HistoryState
            icon={<Clock3 className="h-5 w-5" aria-hidden="true" />}
            title={`No ${interval} snapshots in ${range}`}
            message="The chart needs an initial complete snapshot before it can carry values forward"
          />
        ) : null}
        {state === "partial" ? (
          <HistoryState
            icon={<ChartNoAxesCombined className="h-5 w-5" aria-hidden="true" />}
            title="Only partial snapshots are available"
            message={`${summary.partialCount} incomplete ${summary.partialCount === 1 ? "snapshot was" : "snapshots were"} captured in this range. Their values are excluded until complete source coverage is available.`}
          />
        ) : null}
        {state === "single" ? (
          <HistoryState
            icon={<Clock3 className="h-5 w-5" aria-hidden="true" />}
            title="First complete snapshot captured"
            value={latestValueLabel || undefined}
            message={`A second complete ${interval} snapshot is needed to draw a change curve.${summary.partialCount ? " Partial snapshots are excluded." : ""}`}
          />
        ) : null}
        {state === "ready" ? (
          <div
            className="h-72 sm:h-80"
            role="img"
            aria-label={`${interval} portfolio history for ${range}, ${periodDeltaLabel}, ${formatChange(summary.deltaPercent)}${carriedCount ? `, ${carriedCount} values carried forward` : ""}`}
          >
            <ResponsiveContainer>
              <AreaChart data={chartSeries} margin={chartMargin}>
                <defs>
                  <linearGradient id="portfolioHistoryFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.45} />
                <XAxis
                  dataKey="timestamp"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={tickFormatter}
                  tick={chartTickStyle}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={36}
                />
                <YAxis hide domain={chartDomain} />
                <Tooltip {...tooltipMotion} cursor={chartCursor} content={<HistoryTooltip currency={currency} interval={interval} />} />
                <Area
                  type="monotone"
                  dataKey="displayValue"
                  stroke="#10b981"
                  fill="url(#portfolioHistoryFill)"
                  strokeWidth={2.5}
                  dot={summary.completePointCount <= 48 ? chartDot : false}
                  connectNulls={false}
                  activeDot={chartActiveDot("#10b981")}
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

function HistoryTooltip({
  active,
  payload,
  currency,
  interval
}: TooltipProps<number, string> & { currency: "USD" | "TWD"; interval: PortfolioHistoryInterval }) {
  const datum = payload?.[0]?.payload as ChartSeriesPoint | undefined;
  if (!active || !datum || datum.displayValue === null || !datum.point) return null;

  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-popover-foreground shadow-card">
      <p className="text-xs text-muted-foreground">{formatTimestamp(datum.capturedAt, interval)}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums">{formatMoney(datum.displayValue, currency)}</p>
      <p className="mt-1 text-xs text-muted-foreground">{datum.carriedFrom ? `Carried forward from ${formatTimestamp(datum.carriedFrom, interval)}` : "Complete snapshot"}</p>
    </div>
  );
}

function HistoryState({
  icon,
  title,
  message,
  value,
  action,
  alert = false
}: {
  icon: React.ReactNode;
  title: string;
  message: string;
  value?: string;
  action?: () => void;
  alert?: boolean;
}) {
  return (
    <div className="grid min-h-72 place-items-center rounded-md bg-muted/25 px-5 text-center sm:min-h-80" role={alert ? "alert" : "status"}>
      <div className="max-w-md">
        <span className="mx-auto grid h-10 w-10 place-items-center rounded-md bg-primary/10 text-primary">{icon}</span>
        <p className="mt-4 font-semibold">{title}</p>
        {value ? <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p> : null}
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{message}</p>
        {action ? (
          <Button type="button" size="sm" variant="outline" className="mt-4" onClick={action}>
            <RefreshCw aria-hidden="true" />
            Retry history
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function calculateChartDomain(points: ChartSeriesPoint[]): [number, number] {
  const values = points.flatMap((point) => point.displayValue === null ? [] : [point.displayValue]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  const padding = min === max ? Math.max(Math.abs(min) * 0.01, 1) : (max - min) * 0.08;
  return [min - padding, max + padding];
}

function formatChange(value: number | null) {
  if (value === null) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatSignedMoney(valueUsd: number | null, currency: "USD" | "TWD", fxRate: number) {
  if (valueUsd === null) return "—";
  const value = formatMoney(toDisplayAmount(Math.abs(valueUsd), currency, fxRate), currency);
  return valueUsd > 0 ? `+${value}` : valueUsd < 0 ? `−${value}` : value;
}

function formatTimestamp(value: string, interval: PortfolioHistoryInterval) {
  return new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Taipei",
    month: "short",
    day: "numeric",
    ...(interval === "hourly" ? { hour: "2-digit", minute: "2-digit" } : {})
  }).format(new Date(value));
}

function formatTick(value: string | number, interval: PortfolioHistoryInterval, range: PortfolioHistoryRangeId) {
  const date = new Date(value);
  if (interval === "daily") {
    return new Intl.DateTimeFormat("en", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric" }).format(date);
  }
  if (range === "24H") {
    return new Intl.DateTimeFormat("en", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  }
  return new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Taipei",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    hour12: false
  }).format(date);
}
