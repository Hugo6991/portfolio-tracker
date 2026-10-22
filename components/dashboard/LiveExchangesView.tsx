"use client";

import { useState } from "react";
import { BalanceListRow, compactQuantity } from "./BalanceListRow";
import { MobileAnalytics } from "./MobileAnalytics";
import { AssetMark } from "@/components/shared/BrandMark";
import { useApiQuery } from "@/lib/client/api-query";
import { PanelBoundary } from "@/components/shared/PanelBoundary";
import { ChevronDown, CircleAlert, Clock3, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { CexOverview } from "@/components/dashboard/CexOverview";
import { PageHeader, ReloadButton } from "@/components/shared/PageHeader";
import { useCurrency } from "@/components/shared/Providers";
import { useFxRate } from "@/components/shared/useFxRate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getCexHoldingPresentation, type CexPublicResponse, type CexSourceSnapshot } from "@/lib/cex";
import { formatMoney, formatPercent } from "@/lib/format";
import { toDisplayAmount } from "@/lib/fx";
import { cn } from "@/lib/utils";

export function LiveExchangesView() {
  const [selectedExchange, setSelectedExchange] = useState<string | null>(null);
  const query = useApiQuery<CexPublicResponse>("/api/cex");
  const { data, loading, error } = query;
  const { currency } = useCurrency();
  const fx = useFxRate(32);
  async function refresh(announce = false) {
    try {
      await query.refresh();
      if (announce) toast.success("CEX snapshot reloaded");
    } catch (requestError) {
      if (announce) toast.error("Reload failed", { description: requestError instanceof Error ? requestError.message : "Please try again" });
    }
  }

  const display = (valueUsd: number) => formatMoney(toDisplayAmount(valueUsd, currency, fx.rate), currency);

  const header = <PageHeader title="Exchanges" actions={data ? <ReloadButton onClick={() => void refresh(true)} busy={query.refreshing} /> : undefined} />;
  if (loading && !data) return <div className="page-stack">{header}<ExchangeSkeleton /></div>;
  if (!data) return <div className="page-stack">{header}<ErrorCard message={error || "No successful CEX snapshot is available."} onRetry={() => void refresh()} /></div>;

  return (
    <div className="page-stack">
      {header}

      {error ? <div className="rounded-xl border border-amber-400/20 bg-amber-400/8 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">{error}</div> : null}

      <MobileAnalytics><PanelBoundary><CexOverview data={data} /></PanelBoundary></MobileAnalytics>

      <div className="card-grid hidden xl:grid xl:grid-cols-3 2xl:grid-cols-5">
        {data.sources.map((source) => <ExchangeSummary key={source.exchange} source={source} display={display} total={data.totalUsd} />)}
      </div>

      {data.sources.map((source) => (
        <Card key={source.exchange} className="min-w-0">
          <button type="button" aria-expanded={selectedExchange === source.exchange} aria-controls={`exchange-balances-${source.exchange}`}
            onClick={() => setSelectedExchange((current) => current === source.exchange ? null : source.exchange)}
            className="grid min-h-20 w-full grid-cols-[minmax(0,1fr)_auto_16px] items-center gap-3 rounded-lg px-5 py-4 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring xl:hidden">
            <span className="text-sm font-semibold">{source.name}{source.status !== "live" ? <span className="mt-1 block"><FreshnessBadge source={source} /></span> : null}</span>
            <span className="text-sm font-semibold tabular-nums">{display(source.valueUsd)}</span>
            <ChevronDown aria-hidden="true" className={cn("h-4 w-4 text-muted-foreground", selectedExchange === source.exchange && "rotate-180")} />
          </button>
          <CardHeader className="hidden flex-row flex-wrap items-start justify-between gap-3 space-y-0 xl:flex">
            <div>
              <CardTitle>{source.name}</CardTitle>
              <p className="mt-1 hidden text-sm text-muted-foreground xl:block">{source.accounts.length} account types · {source.itemCount} positions</p>
            </div>
            <div className="text-right">
              <p className="text-sm font-semibold tabular-nums xl:hidden">{display(source.valueUsd)}</p>
              {source.status !== "live" ? <FreshnessBadge source={source} /> : null}
            </div>
          </CardHeader>
          <CardContent id={`exchange-balances-${source.exchange}`} className={cn("px-0 pb-2 xl:block", selectedExchange !== source.exchange && "hidden")}>
            <ul className="divide-y divide-border/60 border-t border-border/60 xl:hidden" aria-label={`${source.name} balances`}>
              {source.holdings.length ? source.holdings.slice().sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0)).map((holding, index) => {
                const presentation = getCexHoldingPresentation(holding);
                // biome-ignore lint/suspicious/noArrayIndexKey: Provider rows can repeat account and symbol without a stable upstream row ID.
                return <li key={`${holding.accountType}:${holding.symbol}:${index}`}>
                  <BalanceListRow label={presentation.isEstimate ? holding.accountType : presentation.label} value={holding.valuationState === "excluded" ? "Included in Earn" : holding.valueUsd === null ? "Unvalued" : display(holding.valueUsd)}
                    quantity={compactQuantity(holding.amount)} icon={presentation.isEstimate ? undefined : <AssetMark symbol={holding.symbol} />}
                    secondary={presentation.isEstimate ? <span className="text-amber-700 dark:text-amber-300">Estimated value</span> : holding.accountType}>
                    {presentation.isEstimate ? <p>{presentation.label}</p> : <p className="break-all">{holding.amount === null ? "Amount unavailable" : `${formatAmount(holding.amount)} ${holding.symbol}`}</p>}
                    {holding.valueUsd !== null ? <p>{formatPercent((holding.valueUsd / Math.max(source.valueUsd, 1)) * 100)} of {source.name}</p> : null}
                    {holding.assetClass === "equity" ? <p>Stocks and ETFs · {holding.exposureSymbol}</p> : null}
                    {holding.priceSource ? <p>Price source: {holding.priceSource}</p> : null}
                    <p>Updated {formatTimestamp(source.capturedAt)}</p>
                  </BalanceListRow>
                </li>;
              }) : <li className="px-5 py-8 text-sm text-muted-foreground">No valued positions</li>}
            </ul>
            <div className="hidden overflow-x-auto xl:block">
              <Table className="min-w-[920px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Account</TableHead>
                    <TableHead>Asset</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead className="pr-6 text-right">Share</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {source.holdings.length ? source.holdings
                    .slice()
                    .sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0))
                    .map((holding, index) => {
                      const presentation = getCexHoldingPresentation(holding);
                      // biome-ignore lint/suspicious/noArrayIndexKey: Provider rows can repeat account and symbol without a stable upstream row ID.
                      return <TableRow key={`${holding.accountType}:${holding.symbol}:${index}`}>
                          <TableCell className="pl-6"><Badge variant="outline">{holding.accountType}</Badge></TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2 font-semibold">
                              <span>{presentation.label}</span>
                              {presentation.isEstimate ? <Badge variant="muted">Estimated</Badge> : null}
                              {holding.assetClass === "equity" ? <Badge variant="muted">Equity</Badge> : null}
                            </div>
                            {holding.exposureSymbol ? <p className="mt-1 text-xs text-muted-foreground">{holding.exposureSymbol} · {holding.priceSource}</p> : null}
                            {presentation.isEstimate ? (
                              <p className="mt-1 text-xs font-normal text-muted-foreground">Account-level value, not an asset position</p>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">{holding.amount === null ? "—" : formatAmount(holding.amount)}</TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">{holding.valuationState === "excluded" ? "Included in Earn" : holding.valueUsd === null ? "Unvalued" : display(holding.valueUsd)}</TableCell>
                          <TableCell className="pr-6 text-right tabular-nums">{holding.valueUsd === null ? "—" : formatPercent((holding.valueUsd / Math.max(source.valueUsd, 1)) * 100)}</TableCell>
                        </TableRow>;
                    }) : (
                      <TableRow><TableCell colSpan={5} className="h-28 text-center text-muted-foreground">No valued positions in this snapshot.</TableCell></TableRow>
                    )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ExchangeSummary({ source, display, total }: { source: CexSourceSnapshot; display: (value: number) => string; total: number }) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div><p className="text-sm text-muted-foreground">{source.name}</p><p className="mt-2 text-2xl font-semibold tabular-nums">{display(source.valueUsd)}</p></div>
          <FreshnessBadge source={source} />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{formatPercent((source.valueUsd / Math.max(total, 1)) * 100)} of CEX · {formatTimestamp(source.capturedAt)}</p>
      </CardContent>
    </Card>
  );
}

function FreshnessBadge({ source }: { source: CexSourceSnapshot }) {
  const variant = source.status === "live" ? "success" : source.status === "error" ? "destructive" : "warning";
  const label = source.status === "live" ? "Live" : source.status === "stale" ? "Stale" : source.status === "partial" ? "Partial" : "Failed";
  return <Badge variant={variant}>{source.status === "stale" ? <Clock3 className="mr-1 h-3 w-3" /> : null}{label}</Badge>;
}

function ExchangeSkeleton() {
  return <div className="space-y-6"><Skeleton className="h-10 w-full" /><div className="grid gap-4 xl:grid-cols-[minmax(320px,0.65fr)_minmax(0,1.35fr)]"><Skeleton className="h-[350px]" /><Skeleton className="h-[350px]" /></div><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">{[0, 1, 2, 3, 4].map((item) => <Skeleton key={item} className="h-32" />)}</div><Skeleton className="h-[520px]" /></div>;
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <Card><CardContent className="grid min-h-64 place-items-center p-8 text-center"><div><CircleAlert className="mx-auto h-6 w-6 text-red-300" /><p className="mt-3 font-semibold">CEX data unavailable</p><p className="mt-2 text-sm text-muted-foreground">{message}</p><Button onClick={onRetry} className="mt-5"><RefreshCw />Retry</Button></div></CardContent></Card>;
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatAmount(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: value >= 1 ? 6 : 10 }).format(value);
}
