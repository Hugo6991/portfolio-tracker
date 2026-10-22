import type { PendingWalletMovement } from "@/lib/live-portfolio";

export function PendingWithdrawals({ movements }: { movements?: PendingWalletMovement[] }) {
  if (!movements?.length) return null;
  return (
    <section aria-label="Pending withdrawals" className="rounded-md border border-border/70">
      <h4 className="px-4 py-3 text-sm font-semibold">Pending withdrawals</h4>
      <ul className="divide-y divide-border/50 border-t border-border/50">
        {movements.map((movement) => (
          <li key={movement.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="wrap-break-word text-sm font-medium">{movement.label}</p>
              <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
                {movement.status === "awaiting-claim" ? "Awaiting claim" : "Queued"}
                {movement.expectedAt ? ` · Est. ${new Date(movement.expectedAt).toLocaleDateString("en-US", { timeZone: "Asia/Taipei", month: "short", day: "numeric" })}` : ""}
              </p>
            </div>
            <p className="text-right text-sm tabular-nums">
              {movement.amount}<span className="mt-1 block text-muted-foreground">{movement.asset}</span>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
