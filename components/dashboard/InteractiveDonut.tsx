"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Sector,
  Tooltip,
  type SectorProps
} from "recharts";
import { AssetMark } from "@/components/shared/BrandMark";
import { formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useChartMotion, useTooltipMotion } from "@/components/dashboard/chart-motion";

export type DonutChartItem = {
  id: string;
  label: string;
  detail?: string;
  value: number;
  color: string;
  assetSymbol?: string;
  iconUrl?: string | null;
  badge?: string;
};

type InteractiveDonutProps = {
  items: DonutChartItem[];
  totalValue?: number;
  centerLabel?: string;
  emptyMessage: string;
  ariaLabel: string;
  formatValue: (value: number) => string;
  splitAtDesktop?: boolean;
};

function renderActiveSector(props: unknown) {
  const sector = props as SectorProps;
  // The grown slice mounts fresh on every hover, so it eases out from its resting size instead of snapping.
  return (
    <g className="donut-active-sector" style={{ transformOrigin: `${sector.cx}px ${sector.cy}px` }}>
      <Sector {...sector} outerRadius={Number(sector.outerRadius ?? 0) + 5} />
    </g>
  );
}

export function InteractiveDonut({
  items,
  totalValue,
  centerLabel = "Total",
  emptyMessage,
  ariaLabel,
  formatValue,
  splitAtDesktop = false
}: InteractiveDonutProps) {
  const chartMotion = useChartMotion();
  const tooltipMotion = useTooltipMotion();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const chartItems = useMemo(
    () => items.filter((item) => Number.isFinite(item.value) && item.value > 0),
    [items]
  );
  const itemTotal = chartItems.reduce((sum, item) => sum + item.value, 0);
  const denominator = totalValue && totalValue > 0 ? totalValue : itemTotal;
  const activeId = hoveredId ?? selectedId;
  const matchedActiveIndex = activeId === null
    ? null
    : chartItems.findIndex((item) => item.id === activeId);
  const activeIndex = matchedActiveIndex !== null && matchedActiveIndex >= 0
    ? matchedActiveIndex
    : null;
  const activeItem = activeIndex === null ? null : chartItems[activeIndex] ?? null;

  useEffect(() => {
    if (selectedId && !chartItems.some((item) => item.id === selectedId)) {
      setSelectedId(null);
    }
  }, [chartItems, selectedId]);

  if (itemTotal <= 0 || denominator <= 0) {
    return (
      <div className="grid min-h-[360px] place-items-center text-center" role="status">
        <div>
          <div className="mx-auto grid h-40 w-40 place-items-center rounded-full border-22 border-muted/70">
            <span className="text-xs font-medium text-muted-foreground">No data</span>
          </div>
          <p className="mt-5 text-sm text-muted-foreground">{emptyMessage}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(
      "grid min-w-0 gap-5",
      splitAtDesktop
        ? "xl:grid-cols-[minmax(220px,0.85fr)_minmax(0,1.15fr)] xl:items-center"
        : "min-[1400px]:grid-cols-[minmax(220px,0.85fr)_minmax(0,1.15fr)] min-[1400px]:items-center"
    )}>
      <div className="relative h-[260px] min-w-0" role="img" aria-label={ariaLabel}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={chartItems}
              dataKey="value"
              nameKey="label"
              innerRadius={72}
              outerRadius={102}
              paddingAngle={2}
              cornerRadius={3}
              rootTabIndex={-1}
              startAngle={90}
              endAngle={-270}
              {...chartMotion}
              activeIndex={activeIndex ?? undefined}
              activeShape={renderActiveSector}
              onMouseEnter={(_item, index) => setHoveredId(chartItems[index]?.id ?? null)}
              onMouseLeave={() => setHoveredId(null)}
              onClick={(_item, index) => {
                const selectedItem = chartItems[index];
                if (selectedItem) setSelectedId((current) => current === selectedItem.id ? null : selectedItem.id);
              }}
            >
              {chartItems.map((item, index) => (
                <Cell
                  key={item.id}
                  fill={item.color}
                  stroke="hsl(var(--card))"
                  strokeWidth={3}
                  className={cn(
                    "cursor-pointer outline-hidden transition-opacity duration-150 ease-out",
                    activeIndex !== null && activeIndex !== index && "opacity-60 dark:opacity-[0.42]"
                  )}
                />
              ))}
            </Pie>
            <Tooltip
              {...tooltipMotion}
              formatter={(value: number, name: string) => [
                `${formatValue(value)} · ${formatPercent((value / denominator) * 100)}`,
                name
              ]}
              contentStyle={{
                background: "hsl(var(--popover))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 8,
                boxShadow: "0 8px 24px rgba(0,0,0,0.12)"
              }}
              itemStyle={{ color: "hsl(var(--popover-foreground))" }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 grid place-items-center px-16 text-center">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-muted-foreground">
              {activeItem?.label ?? centerLabel}
            </p>
            <p className="mt-1 truncate text-sm font-semibold tabular-nums">
              {formatValue(activeItem?.value ?? denominator)}
            </p>
            {activeItem ? (
              <p className="mt-1 text-xs font-medium text-muted-foreground">
                {formatPercent((activeItem.value / denominator) * 100)}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid gap-2 lg:grid-cols-2 xl:grid-cols-1">
        {chartItems.map((item, index) => {
          const isSelected = selectedId === item.id;
          const isActive = activeIndex === index;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={isSelected}
              className={cn(
                "flex min-w-0 items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2.5 text-left transition-[background-color,border-color] duration-150 ease-out",
                "hover:border-foreground/25 hover:bg-muted/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                isActive && "border-foreground/30 bg-muted/60 dark:border-foreground/25 dark:bg-muted/50"
              )}
              onMouseEnter={() => setHoveredId(item.id)}
              onMouseLeave={() => setHoveredId(null)}
              onFocus={() => setHoveredId(item.id)}
              onBlur={() => setHoveredId(null)}
              onClick={() => setSelectedId((current) => current === item.id ? null : item.id)}
            >
              <span className="flex min-w-0 items-center gap-3">
                {item.assetSymbol ? (
                  <span className="relative shrink-0">
                    <AssetMark symbol={item.assetSymbol} iconUrl={item.iconUrl} size="sm" />
                    <span
                      className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card ring-1 ring-foreground/30 dark:ring-foreground/20"
                      style={{ background: item.color }}
                    />
                  </span>
                ) : (
                  <span className="grid h-6 w-6 shrink-0 place-items-center">
                    <span className="h-2.5 w-2.5 rounded-full ring-1 ring-foreground/30 dark:ring-foreground/20" style={{ background: item.color }} />
                  </span>
                )}
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-semibold">{item.label}</span>
                    {item.badge ? (
                      <span className="shrink-0 rounded-sm border border-amber-500/50 bg-amber-400/10 px-1.5 py-0.5 text-xs font-semibold leading-none text-amber-700 dark:text-amber-300">
                        {item.badge}
                      </span>
                    ) : null}
                  </span>
                  {item.detail ? <span className="block truncate text-xs text-muted-foreground">{item.detail}</span> : null}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-sm font-semibold tabular-nums">{formatValue(item.value)}</span>
                <span className="block text-xs text-muted-foreground">{formatPercent((item.value / denominator) * 100)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
