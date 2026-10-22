"use client";

import { useCurrency } from "./Providers";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export function CurrencyToggle({ compact = false }: { compact?: boolean }) {
  const { currency, setCurrency } = useCurrency();
  return (
    <ToggleGroup
      type="single"
      value={currency}
      onValueChange={(value) => value && setCurrency(value as typeof currency)}
      aria-label="Display currency"
      orientation={compact ? "vertical" : "horizontal"}
      className={compact ? "flex-col rounded-xl border border-border bg-muted p-0" : "rounded-xl border border-border bg-muted p-1"}
      size="sm"
      variant="ghost"
    >
      {(["USD", "TWD"] as const).map((item) => (
        <ToggleGroupItem key={item} value={item} className={compact ? "h-11 w-11 min-w-0 rounded-lg p-0 text-xs font-medium" : "h-9 min-w-14 rounded-lg px-3 text-sm font-medium"}>
          {item}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
