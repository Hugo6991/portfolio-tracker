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
import {
  ArrowDownRight,
  ArrowUpRight,
  ChartNoAxesCombined,
  ChartPie,
  Clock3,
  RefreshCw
} from "lucide-react";
import {
  buildCexHistoryUrl,
  buildCexTotalHistory,
  getCexHistoryRanges,
  summarizeCexTotalHistory,
  type CexHistoryRangeId,
  type CexTotalHistoryDatum
} from "@/components/dashboard/cex-summary-view-model";
import { InteractiveDonut, type DonutChartItem } from "@/components/dashboard/InteractiveDonut";
import { useCurrency } from "@/components/shared/Providers";
import { useFxRate } from "@/components/shared/useFxRate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { CexHistoryResponse, CexPublicResponse } from "@/lib/cex";
import { summarizeCurrentCexSnapshot } from "@/lib/cex-history";
import { formatMoney } from "@/lib/format";
import { toDisplayAmount } from "@/lib/fx";
import { cn } from "@/lib/utils";
import { chartActiveDot, chartCursor, useChartMotion, useTooltipMotion } from "@/components/dashboard/chart-motion";

type CexOverviewView = "trend" | "allocation";

type ChartSeriesPoint = CexTotalHistoryDatum & {
  displayValue: number | null;
  timestamp: number;
};

const exchangeColors = {
  binance: "#f59e0b",
  okx: "#38bdf8",
  bitget: "#2dd4bf",
  htx: "#a78bfa",
  gate: "#f472b6"
} as const;

const chartMargin = { left: 0, right: 8, top: 12, bottom: 0 } as const;
const chartTickStyle = { fontSize: 12, fill: "hsl(var(--muted-foreground))" } as const;

export function CexOverview({ data }: { data: CexPublicResponse }) {
  const [view, setView] = useState<CexOverviewView>("trend");
  const [range, setRange] = useState<CexHistoryRangeId>("7D");
  const { data: history, loading: historyLoading, error: historyError, refresh } = useApiQuery<CexHistoryResponse>(buildCexHistoryUrl(range));
  const loadHistory = () => refresh().catch(() => undefined);
  const { currency } = useCurrency();
  const fx = useFxRate(32);

  const display = useCallback((valueUsd: number) => (
    formatMoney(toDisplayAmount(valueUsd, currency, fx.rate), currency)
  ), [currency, fx.rate]);

  const totalHistory = useMemo(
    () => buildCexTotalHistory(history?.points ?? [], range),
    [history?.points, range]
  );
  const summary = useMemo(
    () => summarizeCexTotalHistory(totalHistory, data.totalUsd),
    [data.totalUsd, totalHistory]
  );
  const chartSeries = useMemo<ChartSeriesPoint[]>(() => totalHistory.map((point) => ({
    ...point,
    displayValue: point.totalUsd === null ? null : toDisplayAmount(point.totalUsd, currency, fx.rate),
    timestamp: new Date(point.capturedAt).getTime()
  })), [currency, fx.rate, totalHistory]);
  const allocationItems = useMemo<DonutChartItem[]>(() => data.sources.map((source) => ({
    id: source.exchange,
    label: source.name,
    detail: source.status === "live" ? "Live snapshot" : `${capitalize(source.status)} snapshot`,
    value: source.valueUsd,
    color: exchangeColors[source.exchange],
    badge: source.status === "live" ? undefined : capitalize(source.status)
  })), [data.sources]);
  const currentSnapshot = useMemo(
    () => summarizeCurrentCexSnapshot(data.sources),
    [data.sources]
  );
  const shownDeltaUsd = currentSnapshot.complete ? summary.deltaUsd : null;
  const shownDeltaPercent = currentSnapshot.complete ? summary.deltaPercent : null;

  return (
    <section className="card-grid grid min-w-0 xl:grid-cols-[minmax(320px,0.65fr)_minmax(0,1.35fr)]" aria-label="CEX portfolio overview">
      <Card className="min-w-0">
        <CardContent className="flex h-full min-h-[350px] flex-col p-6 sm:p-7">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-muted-foreground">CEX total</p>
              <p className="mt-1 text-xs text-muted-foreground">All connected exchanges</p>
            </div>
            <Badge variant={currentSnapshot.complete ? "success" : "warning"}>
              {currentSnapshot.complete
                ? `${currentSnapshot.expectedSourceCount}/${currentSnapshot.expectedSourceCount} aligned`
                : `${currentSnapshot.liveSourceCount}/${currentSnapshot.expectedSourceCount} live`}
            </Badge>
          </div>

          <div className="mt-10">
            <p className="whitespace-nowrap text-2xl font-semibold leading-none tracking-tight tabular-nums ">
              {display(data.totalUsd)}
            </p>
            <div className="mt-4 min-h-6">
              {historyLoading ? <Skeleton className="h-5 w-40" /> : null}
              {!historyLoading && shownDeltaUsd !== null ? (
                <p className={cn(
                  "flex items-center gap-1.5 text-sm font-semibold tabular-nums",
                  shownDeltaUsd > 0
                    ? "text-emerald-700 dark:text-emerald-300"
                    : shownDeltaUsd < 0
                      ? "text-red-700 dark:text-red-300"
                      : "text-muted-foreground"
                )}>
                  {shownDeltaUsd > 0 ? <ArrowUpRight className="h-4 w-4" aria-hidden="true" /> : null}
                  {shownDeltaUsd < 0 ? <ArrowDownRight className="h-4 w-4" aria-hidden="true" /> : null}
                  {formatSignedMoney(shownDeltaUsd, currency, fx.rate)} · {formatChange(shownDeltaPercent)}
                  <span className="font-normal text-muted-foreground">{range}</span>
                </p>
              ) : null}
              {!historyLoading && shownDeltaUsd === null ? (
                <p className="text-sm text-muted-foreground">
                  {currentSnapshot.complete
                    ? historyError
                      ? "Change is unavailable while history is offline."
                      : "Change appears after history is captured."
                    : currentSnapshot.liveSourceCount === currentSnapshot.expectedSourceCount
                      ? "Change is paused until source snapshots align."
                      : `Change is paused until all ${currentSnapshot.expectedSourceCount} sources are live.`}
                </p>
              ) : null}
            </div>
          </div>

          <div className="mt-auto border-t border-border/60 pt-5">
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
              {currentSnapshot.complete ? "Aligned source snapshot" : "Source snapshot window"}
            </p>
            <p className="mt-1 text-sm font-medium tabular-nums">
              {formatCaptureWindow(currentSnapshot.capturedAtStart, currentSnapshot.capturedAtEnd) || "Not available"}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <Tabs value={view} onValueChange={(value) => setView(value as CexOverviewView)}>
          <CardHeader className="gap-4 space-y-0 p-5 pb-3 sm:flex-row sm:items-start sm:justify-between sm:p-6 sm:pb-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-sm">CEX overview</CardTitle>
                {view === "trend" && summary.gapCount > 0 && !historyLoading ? (
                  <Badge variant="muted">{summary.gapCount} {summary.gapCount === 1 ? "gap" : "gaps"}</Badge>
                ) : null}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {view === "trend" ? `Complete snapshots · ${range}` : "Current value by exchange"}
              </p>
            </div>
            <TabsList className="h-11 w-full shrink-0 sm:w-auto" aria-label="CEX chart view">
              <TabsTrigger value="trend" className="h-9 flex-1 gap-2 sm:flex-none">
                <ChartNoAxesCombined className="h-4 w-4" aria-hidden="true" />
                Trend
              </TabsTrigger>
              <TabsTrigger value="allocation" className="h-9 flex-1 gap-2 sm:flex-none">
                <ChartPie className="h-4 w-4" aria-hidden="true" />
                Allocation
              </TabsTrigger>
            </TabsList>
          </CardHeader>

          <CardContent className="min-w-0 p-5 pt-0 sm:p-6 sm:pt-0">
            <TabsContent value="trend" className="mt-0 min-w-0">
              <div className="mb-3 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">Only complete, time-aligned snapshots are plotted.</p>
                <ToggleGroup
                  type="single"
                  value={range}
                  onValueChange={(value) => value && setRange(value as CexHistoryRangeId)}
                  variant="ghost"
                  size="sm"
                  className="w-full shrink-0 rounded-md border border-border/70 bg-muted/25 p-1 sm:w-auto"
                  aria-label="CEX history range"
                >
                  {getCexHistoryRanges().map((item) => (
                    <ToggleGroupItem key={item.id} value={item.id} className="h-10 flex-1 px-3 text-xs sm:flex-none">
                      {item.id}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              <CexTrendChart
                series={chartSeries}
                range={range}
                currency={currency}
                loading={historyLoading}
                error={historyError}
                completePointCount={summary.completePointCount}
                retry={() => void loadHistory()}
              />
            </TabsContent>

            <TabsContent value="allocation" className="mt-0 min-w-0">
              <InteractiveDonut
                items={allocationItems}
                totalValue={data.totalUsd}
                centerLabel="CEX total"
                emptyMessage="Exchange allocation will appear after the first successful sync."
                ariaLabel={`CEX allocation across ${data.sources.length} exchanges`}
                formatValue={display}
                splitAtDesktop
              />
            </TabsContent>
          </CardContent>
        </Tabs>
      </Card>
    </section>
  );
}

function CexTrendChart({
  series,
  range,
  currency,
  loading,
  error,
  completePointCount,
  retry
}: {
  series: ChartSeriesPoint[];
  range: CexHistoryRangeId;
  currency: "USD" | "TWD";
  loading: boolean;
  error: string | null;
  completePointCount: number;
  retry: () => void;
}) {
  const chartMotion = useChartMotion();
  const tooltipMotion = useTooltipMotion();
  if (loading) return <Skeleton className="h-[286px] w-full rounded-md" role="status" aria-label="Loading CEX history" />;

  if (error) {
    return (
      <ChartState
        icon={<ChartNoAxesCombined className="h-5 w-5" aria-hidden="true" />}
        title="History is unavailable"
        message={error}
        action={retry}
        alert
      />
    );
  }

  if (completePointCount < 2) {
    return (
      <ChartState
        icon={<Clock3 className="h-5 w-5" aria-hidden="true" />}
        title={completePointCount === 1 ? "First complete snapshot captured" : "No complete snapshots yet"}
        message="The curve appears after two complete, time-aligned CEX snapshots. Partial snapshots remain visible as gaps, never as estimated values."
      />
    );
  }

  return (
    <div className="h-[286px] min-w-0" role="img" aria-label={`CEX total asset history for ${range}`}>
      <ResponsiveContainer>
        <AreaChart data={series} margin={chartMargin}>
          <defs>
            <linearGradient id="cexTotalHistoryFill" x1="0" y1="0" x2="0" y2="1">
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
            tickFormatter={(value) => formatChartTick(value, range)}
            tick={chartTickStyle}
            tickLine={false}
            axisLine={false}
            minTickGap={36}
          />
          <YAxis hide domain={calculateChartDomain(series)} />
          <Tooltip {...tooltipMotion} cursor={chartCursor} content={<CexHistoryTooltip currency={currency} />} />
          <Area
            type="monotone"
            dataKey="displayValue"
            stroke="#10b981"
            fill="url(#cexTotalHistoryFill)"
            strokeWidth={2.5}
            dot={completePointCount <= 48 ? { r: 2, fill: "#10b981", strokeWidth: 0 } : false}
            activeDot={chartActiveDot("#10b981")}
            {...chartMotion}
            connectNulls={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function CexHistoryTooltip({
  active,
  payload,
  currency
}: TooltipProps<number, string> & { currency: "USD" | "TWD" }) {
  const datum = payload?.[0]?.payload as ChartSeriesPoint | undefined;
  if (!active || !datum || datum.displayValue === null || datum.gapReason) return null;

  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-popover-foreground shadow-card">
      <p className="text-xs text-muted-foreground">{formatFullTimestamp(datum.capturedAt)}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums">{formatMoney(datum.displayValue, currency)}</p>
      <p className="mt-1 text-xs text-muted-foreground">Complete, time-aligned snapshot</p>
    </div>
  );
}

function ChartState({
  icon,
  title,
  message,
  action,
  alert = false
}: {
  icon: React.ReactNode;
  title: string;
  message: string;
  action?: () => void;
  alert?: boolean;
}) {
  return (
    <div className="grid min-h-[286px] place-items-center rounded-md bg-muted/25 px-5 text-center" role={alert ? "alert" : "status"}>
      <div className="max-w-md">
        <span className="mx-auto grid h-10 w-10 place-items-center rounded-md bg-primary/10 text-primary">{icon}</span>
        <p className="mt-4 font-semibold">{title}</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{message}</p>
        {action ? (
          <Button type="button" size="sm" variant="outline" className="mt-4" onClick={action}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
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

function formatSignedMoney(valueUsd: number, currency: "USD" | "TWD", fxRate: number) {
  const value = formatMoney(toDisplayAmount(Math.abs(valueUsd), currency, fxRate), currency);
  return valueUsd > 0 ? `+${value}` : valueUsd < 0 ? `−${value}` : value;
}

function formatChange(value: number | null) {
  if (value === null) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatFullTimestamp(value: string) {
  return new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Taipei",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatCaptureWindow(start: string | null, end: string | null) {
  if (!start && !end) return null;
  if (!start || !end || start === end) {
    const capturedAt = start ?? end;
    return capturedAt ? formatFullTimestamp(capturedAt) : null;
  }
  return `${formatFullTimestamp(start)} – ${formatFullTimestamp(end)}`;
}

function formatChartTick(value: string | number, range: CexHistoryRangeId) {
  const date = new Date(value);
  if (range === "24H") {
    return new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Taipei",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  }
  return new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Taipei",
    month: "numeric",
    day: "numeric",
    ...(range === "7D" ? { hour: "2-digit", hour12: false } : {})
  }).format(date);
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
