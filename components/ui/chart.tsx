"use client";

import * as React from "react";
import { ResponsiveContainer } from "recharts";
import { cn } from "@/lib/utils";

export type ChartConfig = Record<string, { label: string; color: string }>;

const ChartContext = React.createContext<{ config: ChartConfig } | null>(null);

export function ChartContainer({
  config,
  className,
  children
}: {
  config: ChartConfig;
  className?: string;
  children: React.ReactElement;
}) {
  return (
    <ChartContext.Provider value={{ config }}>
      <div className={cn("h-[260px] w-full text-xs", className)}>
        <ResponsiveContainer>{children}</ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export function ChartTooltipContent({ active, payload, label }: { active?: boolean; payload?: any[]; label?: string }) {
  const context = React.useContext(ChartContext);
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-popover-foreground shadow-md">
      {label ? <div className="mb-1 text-xs text-muted-foreground">{label}</div> : null}
      <div className="grid gap-1">
        {payload.map((item) => {
          const config = context?.config[item.dataKey as string];
          return (
            <div key={item.dataKey} className="flex items-center justify-between gap-6">
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="h-2 w-2 rounded-full" style={{ background: config?.color ?? item.color }} />
                {config?.label ?? item.name}
              </span>
              <span className="font-mono text-xs text-foreground">{item.value}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
