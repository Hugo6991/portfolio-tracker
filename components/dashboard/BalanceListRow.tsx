import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

/** Mobile balances lead with identity and value; metadata stays behind a tap. */
export function BalanceListRow({ label, value, quantity, secondary, icon, children }: {
  label: string; value: string; quantity?: ReactNode; secondary?: ReactNode; icon?: ReactNode; children: ReactNode;
}) {
  return (
    <details className="group" data-balance-row>
      <summary className="grid min-h-20 cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-5 py-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2.5">
          {icon ? <span className="shrink-0">{icon}</span> : null}
          <span className="min-w-0">
            <span className="block wrap-break-word text-sm font-semibold leading-6 wrap-anywhere">{label}<ChevronDown aria-hidden="true" className="ml-1 inline h-3 w-3 text-muted-foreground transition-transform group-open:rotate-180" /></span>
            {secondary ? <span className="mt-0.5 block wrap-break-word text-sm leading-5 text-muted-foreground">{secondary}</span> : null}
          </span>
        </span>
        <span className="text-right">
          <span data-balance-value className="block whitespace-nowrap text-sm font-semibold tabular-nums">{value}</span>
          {quantity ? <span className="mt-0.5 block text-sm tabular-nums text-muted-foreground">{quantity}</span> : null}
        </span>
      </summary>
      <div className="space-y-2 bg-muted/25 px-5 py-4 text-sm leading-6 text-muted-foreground">{children}</div>
    </details>
  );
}

export function compactQuantity(amount: number | null) {
  if (amount === null || !Number.isFinite(amount)) return undefined;
  if (amount !== 0 && Math.abs(amount) < 0.000001) return amount > 0 ? "<0.000001" : "−<0.000001";
  if (Math.abs(amount) >= 1_000_000) return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(amount);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: Math.abs(amount) >= 1 ? 4 : 6 }).format(amount);
}
