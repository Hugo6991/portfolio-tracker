import type { TooltipProps } from "recharts";
import { formatMoney } from "../../lib/format";

export function ExpenseMonthTooltip({
  active,
  payload,
  label,
  currency
}: TooltipProps<number, string> & { currency: "USD" | "TWD" }) {
  const datum = payload?.[0]?.payload as {
    month?: string;
    total?: number;
    baselineStatus?: "historical" | "forecast";
    historicalActualTotal?: number;
    historicalActualThrough?: string;
    ledgerTotal?: number;
    ledgerThrough?: string;
    ledgerRecordCount?: number;
  } | undefined;
  const total = datum?.total;
  if (!active || typeof total !== "number" || !Number.isFinite(total)) return null;

  return (
    <div className="min-w-40 rounded-md border border-border bg-popover px-3 py-2 text-popover-foreground shadow-card">
      <p className="text-xs text-muted-foreground">{datum?.month ?? label}</p>
      <div className="mt-1 flex items-baseline justify-between gap-6">
        <span className="text-xs text-muted-foreground">{datum?.baselineStatus === "forecast" ? "Forecast total" : "Historical total"}</span>
        <span className="font-mono text-sm font-semibold tabular-nums">
          {formatMoney(total, currency)}
        </span>
      </div>
      {typeof datum?.historicalActualTotal === "number" && datum.historicalActualThrough ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Historical actual {formatMoney(datum.historicalActualTotal, currency)} through {formatMonthDay(datum.historicalActualThrough)}
        </p>
      ) : null}
      {typeof datum?.ledgerTotal === "number" && datum.ledgerThrough ? (
        <div className="mt-2 border-t border-border pt-2">
          <div className="flex items-baseline justify-between gap-6">
            <span className="text-xs text-muted-foreground">Confirmed ledger</span>
            <span className="font-mono text-sm font-semibold tabular-nums">
              {formatMoney(datum.ledgerTotal, currency)}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {datum.ledgerRecordCount ?? 0} {(datum.ledgerRecordCount ?? 0) === 1 ? "record" : "records"} through {formatMonthDay(datum.ledgerThrough)}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function formatMonthDay(date: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00Z`));
}
