"use client";

import { BalanceListRow, compactQuantity } from "./BalanceListRow";
import { MobileAnalytics } from "./MobileAnalytics";
import { PanelBoundary } from "@/components/shared/PanelBoundary";

import { Fragment, useState } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";
import { AssetTrendChart } from "@/components/dashboard/AssetTrendChart";
import { InteractiveDonut, type DonutChartItem } from "@/components/dashboard/InteractiveDonut";
import { CurrencyToggle } from "@/components/shared/CurrencyToggle";
import { AssetMark, SourceMark } from "@/components/shared/BrandMark";
import { useCurrency } from "@/components/shared/Providers";
import { useFxRate } from "@/components/shared/useFxRate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { assetLabel } from "@/lib/display";
import { buildCryptoAssetAllocation, getAssetAllocationId, type AssetAllocationId } from "@/lib/asset-allocation";
import { formatMoney } from "@/lib/format";
import { toDisplayAmount } from "@/lib/fx";
import { portfolioOverviewUrl, useApiQuery } from "@/lib/client/api-query";
import { withCurrentDeliveryAge, type PortfolioOverview } from "@/lib/portfolio-overview";
import { SMALL_BALANCE_THRESHOLD_USD, partitionSmallBalances } from "@/lib/small-balances";

const allocationColors: Record<AssetAllocationId, string> = {
  stablecoins: "#f0b90b",
  btc: "#f7931a",
  hype: "#6ee7b7",
  bnb: "#f3ba2f",
  eth: "#627eea",
  uni: "#38bdf8",
  equities: "#a78bfa",
  other: "#64748b"
};

const allocationMarks: Partial<Record<AssetAllocationId, string>> = {
  stablecoins: "USDT",
  btc: "BTC",
  hype: "HYPE",
  bnb: "BNB",
  eth: "ETH",
  uni: "UNI"
};

export function LiveAssetsView() {
  const query = useApiQuery<PortfolioOverview>(portfolioOverviewUrl);
  const snapshot = query.data ? withCurrentDeliveryAge(query.data) : null;
  const loading = query.loading;
  const error = query.error;
  const load = () => query.refresh().catch(() => undefined);
  const [showSmallBalances, setShowSmallBalances] = useState(false);
  const { currency } = useCurrency();
  const fx = useFxRate(32);

  const display = (valueUsd: number) => formatMoney(toDisplayAmount(valueUsd, currency, fx.rate), currency);
  if (loading && !snapshot) {
    return (
      <div className="page-stack" aria-label="Loading asset analytics" aria-live="polite" role="status">
        <div className="card-grid grid xl:grid-cols-2">
          <Skeleton className="h-[430px] rounded-lg" />
          <Skeleton className="h-[430px] rounded-lg" />
        </div>
        <Skeleton className="h-[560px] rounded-lg" />
      </div>
    );
  }
  if (!snapshot) return <Card><CardContent className="grid min-h-64 place-items-center text-center"><div><CircleAlert className="mx-auto text-red-600 dark:text-red-300" /><p className="mt-3">{error}</p><Button onClick={() => void load()} className="mt-5"><RefreshCw />Retry</Button></div></CardContent></Card>;

  const { visible, hidden, hiddenCount, hiddenTotalUsd } = partitionSmallBalances(snapshot.holdings);
  const holdings = showSmallBalances ? [...visible, ...hidden] : visible;
  const allocation = buildCryptoAssetAllocation(snapshot.holdings);
  const allocationItems: DonutChartItem[] = allocation.groups.map((group) => ({
    id: group.id,
    label: group.label,
    detail: group.detail,
    value: group.valueUsd,
    color: allocationColors[group.id],
    assetSymbol: allocationMarks[group.id]
  }));
  const debankSource = snapshot.sources.find((source) => source.id === "debank");

  return (
    <div className="page-stack min-w-0">
      {snapshot.delivery?.mode === "stale-cache" ? (
        <div className="flex items-start gap-3 rounded-xl border border-amber-400/25 bg-amber-400/8 px-4 py-3 text-sm text-amber-950 dark:text-amber-100">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
          <p>Showing asset exposure from the last known good snapshot while background sync retries.</p>
        </div>
      ) : null}
      {debankSource?.freshnessState === "late" || debankSource?.freshnessState === "stale" ? (
        <div className="flex items-start gap-3 rounded-xl border border-amber-400/25 bg-amber-400/8 px-4 py-3 text-sm text-amber-950 dark:text-amber-100">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
          <p>
            DeBank updates daily. The latest trusted wallet value is from {formatSourceTime(debankSource.valueUpdatedAt ?? debankSource.updatedAt)}
            {debankSource.freshnessState === "stale" ? " and is too old for allocation or performance analysis." : "."}
          </p>
        </div>
      ) : null}
      {debankSource ? (
        <details className="order-4 text-sm leading-6 text-muted-foreground"><summary className="min-h-11 cursor-pointer py-3">Valuation details</summary><div>
          <span className="font-medium text-foreground">Wallet valuation:</span>{" "}
          liquid prices {debankSource.pricing?.updatedAt
            ? `updated ${formatSourceTime(debankSource.pricing.updatedAt)}`
            : "are using the last snapshot"}
          {debankSource.pricing ? ` · ${debankSource.pricing.coverageValuePercent.toFixed(1)}% live-price coverage` : ""}
          {` · DeBank total checked ${formatSourceTime(debankSource.valueUpdatedAt ?? debankSource.updatedAt)}`}
          {debankSource.compositionUpdatedAt
            ? ` · DeFi structure captured ${formatSourceTime(debankSource.compositionUpdatedAt)}`
            : ""}
        </div></details>
      ) : null}
      {debankSource?.pricing?.state === "partial" || debankSource?.pricing?.state === "stale" ? (
        <div className="flex items-start gap-3 rounded-xl border border-amber-400/25 bg-amber-400/8 px-4 py-3 text-sm text-amber-950 dark:text-amber-100">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
          <p>
            Some token quotes are unavailable
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-3 sm:hidden">
        <div><p className="text-sm text-muted-foreground">Investable holdings</p><p className="mt-1 text-2xl font-semibold tabular-nums">{display(allocation.totalUsd)}</p></div>
        <CurrencyToggle />
      </div>
      <MobileAnalytics><section className="card-grid grid min-w-0 xl:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 p-5 pb-2 sm:p-6 sm:pb-2">
            <div>
              <CardTitle>Asset allocation</CardTitle>

            </div>
            <div className="hidden sm:block"><CurrencyToggle /></div>
          </CardHeader>
          <CardContent className="p-5 pt-2 sm:p-6 sm:pt-2">
            <InteractiveDonut
              items={allocationItems}
              totalValue={allocation.totalUsd}
              centerLabel="Investable holdings"
              emptyMessage="No valued holdings are available yet."
              ariaLabel="Asset allocation by asset class"
              formatValue={display}
            />
          </CardContent>
        </Card>
        <PanelBoundary><AssetTrendChart /></PanelBoundary>
      </section></MobileAnalytics>

      <Card className="min-w-0">
        <CardHeader className="flex-row flex-wrap items-end justify-between gap-4 space-y-0">
          <div className="min-w-0 flex-1">
            <CardTitle>Asset exposure</CardTitle>

          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            {hiddenCount > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={showSmallBalances}
                aria-controls="asset-balances"
                className="h-auto min-h-11 max-w-full justify-start whitespace-normal text-left sm:justify-center sm:text-center"
                onClick={() => setShowSmallBalances((current) => !current)}
              >
                {showSmallBalances ? "Hide small" : "Show small"}
              </Button>
            ) : null}
            {hiddenCount > 0 && !showSmallBalances ? (
              <span className="text-sm text-muted-foreground tabular-nums">{hiddenCount} under the threshold · {display(hiddenTotalUsd)}</span>
            ) : null}
          </div>
        </CardHeader>
        <CardContent id="asset-balances" className="px-0 pb-2">
          <ul className="divide-y divide-border/60 xl:hidden" aria-label="Asset balances">
            {holdings.map((row, index) => (
              <li key={row.symbol}>
                {showSmallBalances && hiddenCount > 0 && index === visible.length ? <p className="bg-muted/25 px-4 py-3 text-sm font-semibold">Small balances</p> : null}
                <BalanceListRow label={row.symbol === "GATE-ESTIMATE" ? "Gate account" : displaySymbol(row)} value={display(row.valueUsd)} quantity={compactQuantity(row.amount)}
                  secondary={row.symbol === "GATE-ESTIMATE" ? "Estimated value" : getAssetAllocationId(row.symbol) === "fiat" ? "Bank preview" : undefined} icon={<AssetMark symbol={row.symbol} iconUrl={row.iconUrl} />}>
                  <p className="font-medium text-foreground">{row.name || assetLabel(row.symbol)}</p>
                  <p>{row.sources.join(" · ")}</p>
                  {row.assetClass === "equity" ? <p>Stocks and ETFs</p> : null}
                  <p>{row.accountCount} accounts · {formatAssetAllocation(row.symbol, row.valueUsd, allocation.totalUsd)}</p>
                  {row.amount !== null ? <p className="break-all">{row.amount.toLocaleString("en-US", { maximumFractionDigits: 12 })} {row.symbol}</p> : null}
                </BalanceListRow>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto xl:block">
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Asset</TableHead>
                  <TableHead>Sources</TableHead>
                  <TableHead className="text-right">Accounts</TableHead>
                  <TableHead className="text-right">Asset allocation</TableHead>
                  <TableHead className="pr-6 text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody id="asset-balance-rows">
                {holdings.map((row, index) => (
                  <Fragment key={row.symbol}>
                    {showSmallBalances && hiddenCount > 0 && index === visible.length ? (
                      <TableRow className="bg-muted/20 hover:bg-muted/20">
                        <TableCell colSpan={5} className="py-2.5 pl-6 text-xs font-semibold text-muted-foreground">
                          Small balances under US${SMALL_BALANCE_THRESHOLD_USD}
                        </TableCell>
                      </TableRow>
                    ) : null}
                    <TableRow>
                      <TableCell className="pl-6">
                        <div className="flex items-center gap-3">
                          <AssetMark symbol={row.symbol} iconUrl={row.iconUrl} />
                          <div className="min-w-0">
                            <div className="font-semibold">{displaySymbol(row)}</div>
                            <div className="max-w-56 truncate text-sm text-muted-foreground">{row.name || assetLabel(row.symbol)}</div>
                            {row.assetClass === "equity" ? <p className="whitespace-nowrap text-xs text-muted-foreground">Stocks and ETFs</p> : null}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1.5">
                          {row.sources.map((source) => (
                            <Badge key={source} variant="muted" className="gap-1.5 pl-1">
                              <SourceMark source={source} />
                              {source}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{row.accountCount}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums text-muted-foreground">
                        {formatAssetAllocation(row.symbol, row.valueUsd, allocation.totalUsd)}
                      </TableCell>
                      <TableCell className="pr-6 text-right font-semibold tabular-nums">{display(row.valueUsd)}</TableCell>
                    </TableRow>
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function formatSourceTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Taipei",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatAssetAllocation(symbol: string, value: number, total: number) {
  if (getAssetAllocationId(symbol) === "fiat") return "Bank preview";
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return "—";
  const percent = (value / total) * 100;
  if (Math.abs(percent) < 0.1) return percent < 0 ? "−<0.1%" : "<0.1%";
  return `${percent.toFixed(1)}%`;
}

// Tokenized stocks are stored as EQ_<ticker>; people read the ticker.
function displaySymbol(row: { symbol: string; assetClass?: "crypto" | "equity"; exposureSymbol?: string }) {
  return row.assetClass === "equity" ? row.exposureSymbol ?? row.symbol.replace(/^EQ_/, "") : row.symbol;
}
