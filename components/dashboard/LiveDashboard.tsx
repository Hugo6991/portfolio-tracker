"use client";

import { PanelBoundary } from "@/components/shared/PanelBoundary";

import { useState } from "react";
import Link from "next/link";
import { CircleAlert, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  InteractiveDonut,
  type DonutChartItem
} from "@/components/dashboard/InteractiveDonut";
import { PortfolioAssistant } from "@/components/dashboard/PortfolioAssistant";
import { PortfolioHistory } from "@/components/dashboard/PortfolioHistory";
import { useCurrency } from "@/components/shared/Providers";
import { PageHeader, ReloadButton } from "@/components/shared/PageHeader";
import { useFxRate } from "@/components/shared/useFxRate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoney } from "@/lib/format";
import { toDisplayAmount } from "@/lib/fx";
import { portfolioOverviewUrl, useApiQuery } from "@/lib/client/api-query";
import { withCurrentDeliveryAge, type PortfolioOverview } from "@/lib/portfolio-overview";
import { buildDashboardHoldingBreakdown } from "@/lib/portfolio-dashboard";
import { cn } from "@/lib/utils";

const holdingColors = ["#059669", "#0284c7", "#7c3aed", "#d97706", "#e11d48", "#0891b2"];

export function LiveDashboard() {
  const query = useApiQuery<PortfolioOverview>(portfolioOverviewUrl);
  const snapshot = query.data ? withCurrentDeliveryAge(query.data) : null;
  const isLoading = query.loading;
  const error = query.error;
  const { currency } = useCurrency();
  const fx = useFxRate(32);

  async function refresh(announce = false) {
    try {
      await query.refresh(true);
      if (announce) toast.success("Latest snapshot loaded");
    } catch (requestError) {
      if (announce) toast.error("Reload failed", { description: requestError instanceof Error ? requestError.message : "Please try again" });
    }
  }

  if (!snapshot && isLoading) return <DashboardSkeleton />;
  if (!snapshot) return <DashboardError message={error || "Portfolio data is unavailable."} onRetry={() => void refresh()} />;

  const display = (valueUsd: number) => formatMoney(toDisplayAmount(valueUsd, currency, fx.rate), currency);
  const connectedLabel = `${snapshot.connectedSourceCount}/${snapshot.expectedSourceCount} sources`;
  const holdingBreakdown = buildDashboardHoldingBreakdown(snapshot.holdings);
  const locationItems: DonutChartItem[] = [
    { id: "exchanges", label: "Exchanges", value: snapshot.groups.exchangesUsd, color: "#059669" },
    { id: "wallets", label: "EVM wallets", value: snapshot.groups.walletsUsd, color: "#0284c7" },
    { id: "banks", label: "Banks", badge: "Preview", value: snapshot.groups.banksUsd, color: "#d97706" }
  ];
  const holdingItems: DonutChartItem[] = holdingBreakdown.slices.map((slice, index) => ({
    id: slice.id,
    label: slice.label,
    value: slice.valueUsd,
    color: slice.isOther ? "#475569" : holdingColors[index % holdingColors.length],
    assetSymbol: slice.isOther ? undefined : slice.id
  }));
  const latestAttemptNeedsAttention = snapshot.delivery?.latestAttempt
    ? snapshot.delivery.latestAttempt.status !== "success"
    : false;
  const debankSource = snapshot.sources.find((source) => source.id === "debank");

  return (
    <div className="page-stack mx-auto max-w-7xl">
      <PageHeader title="Portfolio" actions={<ReloadButton onClick={() => void refresh(true)} busy={query.refreshing} />} />

      {snapshot.isPartial || snapshot.delivery?.mode === "stale-cache" || latestAttemptNeedsAttention || error
        ? <SyncNotice snapshot={snapshot} error={error} onSynced={() => refresh()} />
        : null}

      <Card className="overflow-hidden">
        <CardContent className="p-5 sm:p-6">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium text-muted-foreground">Net worth</p>
              <Badge
                variant={snapshot.isPartial ? "warning" : "success"}
                className={snapshot.isPartial
                  ? "text-amber-700 dark:text-amber-300"
                  : "hidden text-emerald-700 dark:text-emerald-300 sm:inline-flex"}
              >
                {connectedLabel}
              </Badge>
            </div>
            <p className="mt-4 wrap-break-word text-[2.5rem] font-semibold leading-none tabular-nums">
              {display(snapshot.netWorthUsd)}
            </p>
            <p className="mt-4 text-sm text-muted-foreground">
              Updated {formatTimestamp(snapshot.generatedAt)}
            </p>
            {debankSource ? (
              <details className="mt-1 text-sm leading-6 text-muted-foreground"><summary className="min-h-11 cursor-pointer py-2.5">Valuation details</summary><p>{getDeliveryLabel(snapshot)}</p><p>
                Liquid prices {debankSource.pricing?.updatedAt ? `updated ${formatTimestamp(debankSource.pricing.updatedAt)}` : "using snapshot values"}
                {debankSource.pricing ? ` · ${debankSource.pricing.coverageValuePercent.toFixed(1)}% value coverage` : ""}
                {` · DeBank total checked ${formatTimestamp(debankSource.valueUpdatedAt ?? debankSource.updatedAt)}`}
                {debankSource.compositionUpdatedAt && debankSource.compositionUpdatedAt !== (debankSource.valueUpdatedAt ?? debankSource.updatedAt)
                  ? ` · structure captured ${formatTimestamp(debankSource.compositionUpdatedAt)}`
                  : ""}
              </p></details>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <section aria-label="Portfolio timeline and insights" className="card-grid grid min-w-0 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.45fr)]">
        <PanelBoundary><PortfolioHistory /></PanelBoundary>
        <PanelBoundary><PortfolioAssistant /></PanelBoundary>
      </section>

      <section className="card-grid grid xl:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Where it’s held</CardTitle>
          </CardHeader>
          <CardContent>
            <InteractiveDonut
              items={locationItems}
              totalValue={snapshot.netWorthUsd}
              centerLabel="Net worth"
              emptyMessage="No account allocation is available yet."
              ariaLabel="Portfolio allocation by account type"
              formatValue={display}
            />
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>What you own</CardTitle>
          </CardHeader>
          <CardContent>
            <InteractiveDonut
              items={holdingItems}
              totalValue={holdingBreakdown.totalUsd}
              centerLabel="Holdings"
              emptyMessage="No valued holdings are available yet."
              ariaLabel="Portfolio allocation by holding"
              formatValue={display}
            />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function getDeliveryLabel(snapshot: PortfolioOverview) {
  if (snapshot.delivery?.mode === "stale-cache") {
    return `Last known good · ${formatAge(snapshot.delivery.cacheAgeSeconds)}`;
  }
  if (snapshot.delivery?.mode === "cache") {
    const ageSeconds = snapshot.delivery.cacheAgeSeconds ?? 0;
    return ageSeconds < 60 ? "Cached <1 min" : `Cached ${Math.round(ageSeconds / 60)}m`;
  }
  return "Live";
}

function SyncNotice({
  snapshot,
  error,
  onSynced
}: {
  snapshot: PortfolioOverview;
  error: string | null;
  onSynced: () => Promise<void>;
}) {
  const [action, setAction] = useState<"retry" | "accept-collapse" | null>(null);
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [syncStep, setSyncStep] = useState<"exchanges" | "portfolio" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const latestAttempt = snapshot.delivery?.latestAttempt;
  const notice = getSyncNotice(snapshot, error || actionError);
  const canAccept = latestAttempt?.status === "review-required" && latestAttempt.reviewReady;

  async function submitAction() {
    if (!action) return;
    if (!password) {
      setActionError("Enter the portfolio password to continue.");
      return;
    }
    setIsSubmitting(true);
    setActionError(null);
    try {
      if (action === "retry") {
        setSyncStep("exchanges");
        const cex = await requestSyncAction("refresh-cex", password);
        if (cex.status === "already_running") {
          throw new Error("Exchange balances are already refreshing. Try again in a moment.");
        }
      }

      setSyncStep("portfolio");
      const body = await requestSyncAction(action, password);
      setAction(null);
      setPassword("");
      if (body.status === "success") {
        toast.success(action === "accept-collapse" ? "Latest balances accepted" : "Portfolio synchronized");
      } else {
        toast.warning("Latest data is still being verified", {
          description: "The last validated snapshot remains protected."
        });
      }
      await onSynced();
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : "The sync could not be completed.");
    } finally {
      setSyncStep(null);
      setIsSubmitting(false);
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-3 rounded-xl border border-amber-400/25 bg-amber-400/8 px-4 py-3 text-sm text-amber-950 dark:text-amber-100"
    >
      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-semibold">{notice.label}</span>
          <span className="text-xs text-amber-800/80 dark:text-amber-100/70">Showing last validated values.</span>
        </p>
        {notice.message ? (
          <details className="mt-1 text-xs text-amber-800/80 dark:text-amber-100/70">
            <summary className="w-fit cursor-pointer font-medium text-amber-800 hover:text-amber-950 dark:text-amber-200 dark:hover:text-amber-100">View details</summary>
            <p className="mt-2 max-w-4xl wrap-break-word leading-5">{notice.message}</p>
          </details>
        ) : null}
        {!action ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 px-0 text-amber-800 hover:bg-transparent hover:text-amber-950 dark:text-amber-200 dark:hover:text-amber-100 sm:hidden"
            onClick={() => {
              setAction(canAccept ? "accept-collapse" : "retry");
              setActionError(null);
            }}
          >
            {canAccept ? "Review & accept" : "Retry sync"}
          </Button>
        ) : null}
        {action ? (
          <form
            className="mt-3 flex max-w-xl flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              void submitAction();
            }}
          >
            <div className="grid flex-1 gap-1">
              <label
                htmlFor="portfolio-sync-password"
                className="text-xs font-medium text-amber-900 dark:text-amber-100"
              >
                Portfolio password
              </label>
              <Input
                id="portfolio-sync-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setActionError(null);
                }}
                disabled={isSubmitting}
                className="min-h-10 bg-background/70"
              />
            </div>
            <Button type="submit" size="sm" className="min-h-10 self-end" disabled={isSubmitting}>
              {syncStep === "exchanges"
                ? "Refreshing exchanges"
                : syncStep === "portfolio"
                  ? "Updating portfolio"
                  : action === "accept-collapse"
                    ? "Confirm balances"
                    : "Sync now"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-10 self-end"
              disabled={isSubmitting}
              onClick={() => {
                setAction(null);
                setPassword("");
                setActionError(null);
              }}
            >
              Cancel
            </Button>
          </form>
        ) : null}
      </div>
      <div className="hidden shrink-0 items-center gap-1 sm:flex">
        {!action ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-amber-800 hover:bg-amber-300/10 hover:text-amber-950 dark:text-amber-200 dark:hover:text-amber-100"
            onClick={() => {
              setAction(canAccept ? "accept-collapse" : "retry");
              setActionError(null);
            }}
          >
            {canAccept ? "Review & accept" : "Retry sync"}
          </Button>
        ) : null}
        <Button asChild variant="ghost" size="sm" className="text-amber-800 hover:bg-amber-300/10 hover:text-amber-950 dark:text-amber-200 dark:hover:text-amber-100">
          <Link href="/settings">Settings</Link>
        </Button>
      </div>
    </div>
  );
}

async function requestSyncAction(
  action: "refresh-cex" | "retry" | "accept-collapse",
  password: string
) {
  const response = await fetch("/api/portfolio/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, password })
  });
  const body = await response.json() as { status?: string; error?: string };
  if (!response.ok) {
    throw new Error(body.error || (
      response.status === 409
        ? "This snapshot is not eligible for manual acceptance."
        : "The sync could not be completed."
    ));
  }
  return body;
}

function getSyncNotice(snapshot: PortfolioOverview, error: string | null) {
  if (error) return { label: "Portfolio check failed", message: error };
  const latest = snapshot.delivery?.latestAttempt;
  const age = formatAge(snapshot.delivery?.cacheAgeSeconds);
  const fallbackSources = snapshot.sources.filter((source) => source.fallback);
  const sourceChanges = latest?.affectedSources.map((source) => {
    const values = source.previousValueUsd !== null && source.candidateValueUsd !== null
      ? `${formatMoney(source.previousValueUsd, "USD")} → ${formatMoney(source.candidateValueUsd, "USD")}`
      : source.status;
    const percent = source.deltaPercent === null ? "" : ` (${source.deltaPercent >= 0 ? "+" : ""}${source.deltaPercent.toFixed(1)}%)`;
    return `${source.name}: ${values}${percent}`;
  }).join(" · ");

  if (latest?.status === "review-required") {
    return {
      label: "Large balance change needs confirmation",
      message: `A complete change repeated ${latest.confirmationCount} times and is ready for review.${sourceChanges ? ` ${sourceChanges}.` : ""} Current snapshot: ${age}.`
    };
  }
  if (latest?.status === "validating-change") {
    return {
      label: "Checking a large balance change",
      message: `The complete candidate has repeated ${latest.confirmationCount} of 3 required times.${sourceChanges ? ` ${sourceChanges}.` : ""} Current snapshot: ${age}.`
    };
  }
  if (latest?.status === "source-incomplete") {
    if (fallbackSources.length > 0) {
      const names = fallbackSources.map((source) => source.name).join(", ");
      const oldestFallback = fallbackSources.reduce((oldest, source) => (
        !oldest || source.fallback!.lastGoodAt < oldest ? source.fallback!.lastGoodAt : oldest
      ), "");
      return {
        label: fallbackSources.length === 1
          ? `${names} is using its last verified value`
          : `${names} are using their last verified values`,
        message: `Other sources updated normally. Fallback data is from ${formatTimestamp(oldestFallback)} and will expire automatically if it becomes too old.`
      };
    }
    return {
      label: latest.affectedSources.length === 1
        ? `${latest.affectedSources[0].name} data is incomplete`
        : "One or more data sources are incomplete",
      message: `${sourceChanges || "The latest attempt did not contain complete source coverage."} The incomplete candidate was not published. Current snapshot: ${age}.`
    };
  }
  if (latest?.status === "failed") {
    return {
      label: "Background sync failed",
      message: `The latest provider sync did not complete. Current snapshot: ${age}.`
    };
  }
  return {
    label: "Background sync missed its schedule",
    message: `No newer validated snapshot has been published. Current snapshot: ${age}.`
  };
}

function DashboardSkeleton() {
  return (
    <div className="mx-auto max-w-7xl space-y-6" aria-label="Syncing portfolio data" aria-live="polite" role="status">
      <div className="flex items-end justify-between"><Skeleton className="h-9 w-48" /><Skeleton className="h-10 w-56" /></div>
      <Skeleton className="h-[200px] rounded-lg" />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.45fr)]">
        <Skeleton className="h-[460px] rounded-lg" />
        <Skeleton className="h-[390px] rounded-lg" />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-[470px] rounded-lg" />
        <Skeleton className="h-[470px] rounded-lg" />
      </div>
    </div>
  );
}

function DashboardError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mx-auto grid min-h-[70vh] max-w-2xl place-items-center px-6 text-center">
      <div>
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-md bg-red-400/10 text-red-600 dark:text-red-300"><CircleAlert /></span>
        <h1 className="mt-5 text-2xl font-semibold">Portfolio data unavailable</h1>
        <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-muted-foreground">{message}</p>
        <Button onClick={onRetry} className="mt-6"><RefreshCw />Try again</Button>
      </div>
    </div>
  );
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatAge(ageSeconds: number | null | undefined) {
  if (ageSeconds == null || !Number.isFinite(ageSeconds)) return "age unknown";
  if (ageSeconds < 60) return "less than a minute old";
  if (ageSeconds < 3_600) return `${Math.round(ageSeconds / 60)}m old`;
  return `${Math.round(ageSeconds / 3_600)}h old`;
}
