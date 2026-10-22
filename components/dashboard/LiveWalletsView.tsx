"use client";

import { PanelBoundary } from "@/components/shared/PanelBoundary";
import { BalanceListRow, compactQuantity } from "./BalanceListRow";
import { MobileAnalytics } from "./MobileAnalytics";
import { PendingWithdrawals } from "@/components/dashboard/PendingWithdrawals";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  CircleAlert,
  Coins,
  ExternalLink,
  Layers3,
  RefreshCw,
  WalletCards
} from "lucide-react";
import { toast } from "sonner";
import { InteractiveDonut, type DonutChartItem } from "@/components/dashboard/InteractiveDonut";
import { WalletTrendChart } from "@/components/dashboard/WalletTrendChart";
import {
  WALLET_DISPLAY_THRESHOLD_USD,
  buildWalletAllocation,
  filterDisplayWallets,
  getWalletDetails,
  normalizeWalletAllocationForDonut,
  positionStateLabel,
  type WalletDetailPosition,
  type WalletDetailToken
} from "@/components/dashboard/wallet-view-model";
import { PageHeader, ReloadButton } from "@/components/shared/PageHeader";
import { AssetMark, ProtocolMark } from "@/components/shared/BrandMark";
import { useCurrency } from "@/components/shared/Providers";
import { useFxRate } from "@/components/shared/useFxRate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { compactAddress, formatMoney } from "@/lib/format";
import { toDisplayAmount } from "@/lib/fx";
import { useApiQuery } from "@/lib/client/api-query";
import { withCurrentDeliveryAge, walletHoldingLogos } from "@/lib/portfolio-overview";
import type { LivePortfolioSnapshot, LiveWallet } from "@/lib/live-portfolio";
import { cn } from "@/lib/utils";

const ALLOCATION_COLORS = ["#2dd4bf", "#38bdf8", "#a78bfa", "#f59e0b", "#fb7185", "#84cc16", "#f97316", "#94a3b8"];

export function LiveWalletsView() {
  const query = useApiQuery<LivePortfolioSnapshot>("/api/portfolio");
  const snapshot = useMemo(() => query.data ? withCurrentDeliveryAge(query.data) : null, [query.data]);
  const isLoading = query.loading;
  const error = query.error;
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null);
  const { currency } = useCurrency();
  const fx = useFxRate(32);

  async function refresh(announce = false) {
    try {
      await query.refresh(true);
      if (announce) toast.success("Latest wallet snapshot loaded");
    } catch (requestError) {
      if (announce) toast.error("Reload failed", { description: requestError instanceof Error ? requestError.message : "Please try again" });
    }
  }

  const display = useCallback(
    (valueUsd: number) => formatMoney(toDisplayAmount(valueUsd, currency, fx.rate), currency),
    [currency, fx.rate]
  );
  const visibleWallets = useMemo(
    () => filterDisplayWallets(snapshot?.wallets || []),
    [snapshot?.wallets]
  );

  useEffect(() => {
    if (selectedWalletId && !visibleWallets.some((wallet) => wallet.id === selectedWalletId)) {
      setSelectedWalletId(null);
    }
  }, [selectedWalletId, visibleWallets]);

  const hiddenWalletCount = Math.max(0, (snapshot?.wallets.length || 0) - visibleWallets.length);
  const selectedWallet = visibleWallets.find((wallet) => wallet.id === selectedWalletId) || null;
  const walletSourceRows = (snapshot?.sources || []).filter((source) => source.kind === "wallet");
  const walletSourceIds = new Set(walletSourceRows.map((source) => source.id.toLowerCase()));
  const walletSourcesComplete = walletSourceIds.has("debank")
    && walletSourceIds.has("hyperliquid")
    && walletSourceRows.every((source) => source.status === "live");
  const visibleWalletTotal = visibleWallets.reduce((sum, wallet) => sum + wallet.valueUsd, 0);
  const hyperliquidTotal = visibleWallets.reduce((sum, wallet) => sum + wallet.hyperliquidValueUsd, 0);
  const debankTotal = visibleWallets.reduce((sum, wallet) => sum + wallet.debankValueUsd, 0);
  const allocationWallets = useMemo(
    () => selectedWallet ? [selectedWallet] : visibleWallets,
    [selectedWallet, visibleWallets]
  );
  const rawAllocation = useMemo(() => buildWalletAllocation(allocationWallets), [allocationWallets]);
  const allocationLogos = useMemo(() => walletHoldingLogos(allocationWallets), [allocationWallets]);
  const allocationTotal = selectedWallet?.valueUsd ?? visibleWalletTotal;
  const allocation = useMemo(
    () => limitAllocation(normalizeWalletAllocationForDonut(rawAllocation, allocationTotal)),
    [allocationTotal, rawAllocation]
  );
  const allocationUsesAssets = allocation.some((item) => Boolean(item.symbol));
  const donutItems: DonutChartItem[] = allocation.map((item, index) => ({
    id: item.id,
    label: item.label,
    value: item.value,
    color: ALLOCATION_COLORS[index % ALLOCATION_COLORS.length],
    assetSymbol: item.symbol,
    iconUrl: item.symbol ? allocationLogos.get(item.symbol.toUpperCase()) : null
  }));

  return (
    <TooltipProvider delayDuration={250}>
      <div className="page-stack">
        <PageHeader title="Wallets" actions={<ReloadButton onClick={() => void refresh(true)} busy={query.refreshing} />} />

        {error || snapshot?.delivery?.mode === "stale-cache" ? (
          <div className={cn(
            "flex items-start gap-3 rounded-md border px-4 py-3 text-sm",
            error
              ? "border-red-400/20 bg-red-400/8 text-red-800 dark:text-red-100"
              : "border-amber-400/25 bg-amber-400/8 text-amber-950 dark:text-amber-100"
          )}>
            <CircleAlert className={cn(
              "mt-0.5 h-4 w-4 shrink-0",
              error ? "text-red-600 dark:text-red-300" : "text-amber-600 dark:text-amber-300"
            )} />
            <p>{error || "Showing the last known good wallet snapshot while background sync retries."}</p>
          </div>
        ) : null}

        <div className="card-grid grid sm:grid-cols-3 [&>div:not(:first-child)]:hidden sm:[&>div:not(:first-child)]:block">
          <SummaryMetric
            label="Tracked wallet value"
            value={snapshot ? display(visibleWalletTotal) : null}
            detail={`Wallets ≥ ${display(WALLET_DISPLAY_THRESHOLD_USD)}`}
            loading={isLoading}
          />
          <SummaryMetric label="DeBank" value={snapshot ? display(debankTotal) : null} detail="Tokens + protocols" loading={isLoading} />
          <SummaryMetric label="Hyperliquid" value={snapshot ? display(hyperliquidTotal) : null} detail="Staking + trading + vaults" loading={isLoading} />
        </div>

        {snapshot ? (
          <MobileAnalytics><div className="card-grid grid xl:grid-cols-2">
            <Card className="min-w-0">
              <CardHeader className="pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle>{selectedWallet ? `${selectedWallet.name} allocation` : allocationUsesAssets ? "Asset allocation" : "Wallet allocation"}</CardTitle>

                  </div>
                  {selectedWallet ? (
                    <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => setSelectedWalletId(null)}>
                      All wallets
                    </Button>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="pt-2">
                <InteractiveDonut
                  items={donutItems}
                  totalValue={selectedWallet?.valueUsd || visibleWalletTotal}
                  centerLabel={selectedWallet ? "Wallet" : "Tracked"}
                  emptyMessage="No wallet over the display threshold."
                  ariaLabel="Wallet asset allocation"
                  formatValue={display}
                />
              </CardContent>
            </Card>
            <PanelBoundary><WalletTrendChart
              currentValueUsd={selectedWallet?.valueUsd ?? visibleWalletTotal}
              currentComplete={walletSourcesComplete && (!selectedWallet || selectedWallet.status === "live")}
              generatedAt={snapshot.generatedAt}
              walletIds={visibleWallets.map((wallet) => wallet.id)}
              selection={selectedWallet ? {
                walletId: selectedWallet.id,
                name: selectedWallet.name
              } : null}
            /></PanelBoundary>
          </div></MobileAnalytics>
        ) : isLoading ? (
          <div className="card-grid grid xl:grid-cols-2">
            <Skeleton className="h-[430px] w-full rounded-lg" />
            <Skeleton className="h-[430px] w-full rounded-lg" />
          </div>
        ) : null}

        <Card className="min-w-0 overflow-hidden">
          <CardHeader className="flex-row items-end justify-between gap-4 space-y-0">
            <div className="min-w-0">
              <CardTitle>Wallets</CardTitle>

            </div>
            {snapshot ? <span className="shrink-0 text-sm text-muted-foreground">{visibleWallets.length}</span> : null}
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {isLoading && !snapshot ? (
              <div className="space-y-3 px-6 pb-6">
                {["wallet-loading-1", "wallet-loading-2", "wallet-loading-3", "wallet-loading-4", "wallet-loading-5"].map((key) => <Skeleton key={key} className="h-[76px] w-full" />)}
              </div>
            ) : visibleWallets.length ? (
              <div>
                <div className="hidden grid-cols-[minmax(260px,2fr)_minmax(110px,0.8fr)_minmax(120px,0.9fr)_88px_minmax(120px,0.9fr)_40px] gap-4 border-y border-border/60 bg-muted/15 px-6 py-3 text-xs font-semibold text-muted-foreground xl:grid">
                  <span>Wallet</span>
                  <span className="text-right">DeBank</span>
                  <span className="text-right">Hyperliquid</span>
                  <span className="text-right">Positions</span>
                  <span className="text-right">Total</span>
                  <span className="sr-only">Expand</span>
                </div>
                <div className="divide-y divide-border/60">
                  {visibleWallets.map((wallet) => (
                    <WalletRow
                      key={wallet.id}
                      wallet={wallet}
                      display={display}
                      expanded={selectedWalletId === wallet.id}
                      onToggle={() => setSelectedWalletId((current) => current === wallet.id ? null : wallet.id)}
                    />
                  ))}
                </div>
                {hiddenWalletCount > 0 ? (
                  <p className="border-t border-border/60 px-6 py-3 text-sm text-muted-foreground">
                    {hiddenWalletCount} {hiddenWalletCount === 1 ? "wallet" : "wallets"} below {display(WALLET_DISPLAY_THRESHOLD_USD)} hidden
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="grid min-h-56 place-items-center px-6 text-center">
                <div>
                  <WalletCards className="mx-auto h-6 w-6 text-muted-foreground" />
                  <p className="mt-3 font-medium">No wallet over {display(WALLET_DISPLAY_THRESHOLD_USD)}</p>
                  <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">
                    Smaller balances are intentionally omitted from this view.
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
}

function WalletRow({
  wallet,
  display,
  expanded,
  onToggle
}: {
  wallet: LiveWallet;
  display: (valueUsd: number) => string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const details = useMemo(() => getWalletDetails(wallet), [wallet]);
  const panelId = `wallet-detail-${wallet.id.replace(/[^a-z0-9_-]/gi, "-")}`;
  const positionCount = details.positions.length || wallet.protocolCount;

  return (
    <div className={cn("transition-colors", expanded && "bg-muted/15")}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onToggle}
        className={cn(
          "grid min-h-[76px] w-full grid-cols-[minmax(0,1fr)_auto_16px] items-center gap-3 px-5 py-3 text-left transition-colors sm:px-6",
          "hover:bg-muted/30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          "xl:grid-cols-[minmax(260px,2fr)_minmax(110px,0.8fr)_minmax(120px,0.9fr)_88px_minmax(120px,0.9fr)_40px] xl:gap-4"
        )}
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-2">
              <span className="wrap-break-word text-sm font-semibold leading-6 wrap-anywhere">{wallet.name}</span>
              {wallet.status !== "live" ? <Badge variant="destructive">Unavailable</Badge> : null}
            </span>
            <span className="mt-1 hidden truncate font-mono text-xs text-muted-foreground xl:block">{compactAddress(wallet.address)}</span>
          </span>
        </span>
        <span className="hidden text-right text-sm font-medium tabular-nums xl:block">{display(wallet.debankValueUsd)}</span>
        <span className="hidden text-right text-sm font-medium tabular-nums xl:block">
          {wallet.hyperliquidValueUsd >= 0.01 ? display(wallet.hyperliquidValueUsd) : "—"}
        </span>
        <span className="hidden text-right text-sm tabular-nums xl:block">{positionCount}</span>
        <span className="text-right">
          <span className="block font-semibold tabular-nums">{display(wallet.valueUsd)}</span>

        </span>
        <ChevronDown className={cn("h-4 w-4 justify-self-end text-muted-foreground transition-transform", expanded && "rotate-180")} aria-hidden="true" />
      </button>
      {expanded ? (
        <div id={panelId} className="border-t border-border/60 bg-background/30 px-4 py-5 sm:px-6 sm:py-6">
          <WalletDetail wallet={wallet} tokens={details.tokens} positions={details.positions} display={display} />
        </div>
      ) : null}
    </div>
  );
}

function WalletDetail({
  wallet,
  tokens,
  positions,
  display
}: {
  wallet: LiveWallet;
  tokens: WalletDetailToken[];
  positions: WalletDetailPosition[];
  display: (valueUsd: number) => string;
}) {
  const liquidValue = tokens.filter((token) => token.state === "liquid").reduce((sum, token) => sum + token.valueUsd, 0);
  const deployedValue = positions.reduce((sum, position) => sum + position.valueUsd, 0)
    + tokens.filter((token) => token.state !== "liquid").reduce((sum, token) => sum + token.valueUsd, 0);
  const reconciliationUsd = wallet.reconciliationUsd ?? 0;
  const reportedValueUsd = wallet.debankReportedValueUsd ?? wallet.debankValueUsd;
  const hasCompositionDrift = Math.abs(reconciliationUsd) > 100 &&
    reportedValueUsd > 0 && Math.abs(reconciliationUsd) / reportedValueUsd > 0.02;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <DetailMetric label="Liquid" value={display(liquidValue)} />
        <DetailMetric label="In protocols" value={display(deployedValue)} />
      </div>
      <details className="text-sm leading-6 text-muted-foreground">
        <summary className={cn("min-h-11 cursor-pointer py-2.5", hasCompositionDrift && "text-amber-700 dark:text-amber-300")}>
          {hasCompositionDrift ? `Valuation difference ${display(reconciliationUsd)}` : "Wallet details"}
        </summary>
        <div className="space-y-2 pb-3">
          <p className="break-all font-mono">{wallet.address}</p>
          <a className="inline-flex min-h-11 items-center gap-2 text-primary underline underline-offset-4" href={wallet.debankUrl} target="_blank" rel="noreferrer">Open in DeBank <ExternalLink className="h-4 w-4" /></a>
          <p>Prices: {wallet.priceUpdatedAt ? formatTaipeiDateTime(wallet.priceUpdatedAt) : "Quote time unavailable"}</p>
          {wallet.debankReportedAt ? <p>DeBank total checked: {formatTaipeiDateTime(wallet.debankReportedAt)}</p> : null}
          {wallet.compositionUpdatedAt ? <p>Full holdings checked: {formatTaipeiDateTime(wallet.compositionUpdatedAt)}</p> : null}
          <p>Difference from the last DeBank total: {display(reconciliationUsd)} · Excluded from balance</p>
          {wallet.excludedTokenCount ? <p>{wallet.excludedTokenCount} unvalued tokens excluded</p> : null}
          {Object.entries(wallet.chainRefreshes ?? {}).map(([chain, times]) => <p key={chain}>
            <span className="uppercase">{chain}</span>
            {times.tokensAt ? ` · Balances ${formatTaipeiDateTime(times.tokensAt)}` : ""}
            {times.protocolsAt ? ` · Positions ${formatTaipeiDateTime(times.protocolsAt)}` : ""}
          </p>)}
        </div>
      </details>

      <PendingWithdrawals movements={wallet.pendingMovements} />

      {tokens.length || positions.length ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <DetailSection
            title="Wallet tokens"
            description="Liquid balances and token-level states"
            icon={<Coins className="h-4 w-4" aria-hidden="true" />}
            count={tokens.length}
          >
            {tokens.length ? (
              <div className="divide-y divide-border/50">
                {tokens.map((token) => <TokenRow key={token.id} token={token} display={display} />)}
              </div>
            ) : <DetailSectionEmpty message="No direct token balances in this wallet." />}
          </DetailSection>
          <DetailSection
            title="Protocols & staking"
            description="Deposits, debt, vaults, and staking positions"
            icon={<Layers3 className="h-4 w-4" aria-hidden="true" />}
            count={positions.length}
          >
            {positions.length ? (
              <div className="divide-y divide-border/50">
                {positions.map((position) => <PositionRow key={position.id} position={position} display={display} />)}
              </div>
            ) : <DetailSectionEmpty message="No protocol or staking positions in this wallet." />}
          </DetailSection>
        </div>
      ) : (
        <div className="rounded-md bg-muted/25 px-5 py-6 text-center">
          <p className="text-sm font-medium">Position details are not present in this snapshot.</p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">Refresh the wallet sync or inspect the address directly in DeBank.</p>
        </div>
      )}
    </div>
  );
}

function DetailSection({
  title,
  description,
  icon,
  count,
  children
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border/60 bg-card/70">
      <div className="flex items-start justify-between gap-3 px-4 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">{icon}</span>
          <div className="min-w-0">
            <h4 className="text-sm font-semibold">{title}</h4>
            <p className="sr-only">{description}</p>
          </div>
        </div>
        <Badge variant="muted">{count}</Badge>
      </div>
      <div className="border-t border-border/60">{children}</div>
    </section>
  );
}

function TokenRow({ token, display }: { token: WalletDetailToken; display: (valueUsd: number) => string }) {
  return (
    <BalanceListRow label={token.symbol} value={display(token.valueUsd)} quantity={compactQuantity(token.amount)}
      icon={<AssetMark symbol={token.symbol} iconUrl={token.iconUrl} />}
      secondary={<>{token.chainLabel || token.chain}{token.state !== "liquid" ? ` · ${positionStateLabel(token.state)}` : ""}
        {token.priceState === "stale" ? <span className="block text-amber-700 dark:text-amber-300">Quote unavailable</span> : null}</>}>
      <p>{token.name}{token.protocolName ? ` · ${token.protocolName}` : ""}</p>
      <p className="break-all">{formatTokenAmount(token.amount, token.symbol)}</p>
      <p>{token.priceState === "fresh" ? "Market quote" : token.priceSource === "defillama" ? "Last market quote" : "Last holding valuation"}{token.priceUpdatedAt ? ` · ${formatTaipeiDateTime(token.priceUpdatedAt)}` : ""}</p>
    </BalanceListRow>
  );
}

function PositionRow({ position, display }: { position: WalletDetailPosition; display: (valueUsd: number) => string }) {
  const showState = !["unknown", "supplied", "position"].includes(position.state);
  return (
    <BalanceListRow label={position.protocolName} value={display(position.valueUsd)}
      icon={<ProtocolMark name={position.protocolName} iconUrl={position.protocolIconUrl} />}
      secondary={<>{position.chainLabel || position.chain}{showState ? ` · ${positionStateLabel(position.state)}` : ""}
        {position.unlockAt ? <span className="block text-amber-700 dark:text-amber-300">Unlocks {formatUnlockDate(position.unlockAt)}</span> : null}
        {position.debtUsd !== null && position.debtUsd > 0 ? <span className="block text-amber-700 dark:text-amber-300">{display(position.debtUsd)} debt</span> : null}</>}>
      <p>{position.name}{position.source ? ` · ${position.source}` : ""}</p>
      {position.assetUsd !== null && position.debtUsd !== null && position.debtUsd > 0 ? <p>{display(position.assetUsd)} assets · {display(position.debtUsd)} debt</p> : null}
      {position.protocolUrl ? <a href={position.protocolUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-2 text-primary underline underline-offset-4">Open protocol <ExternalLink className="h-4 w-4" /></a> : null}
      {position.tokens.map((token) => <div key={token.id} className="flex flex-wrap items-center justify-between gap-2">
        <span>{token.symbol} · {positionStateLabel(token.state)}</span><span className="tabular-nums">{display(token.valueUsd)}</span>
      </div>)}
    </BalanceListRow>
  );
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-md bg-muted/50 px-3 py-2">
      <span className="block text-sm font-medium text-muted-foreground">{label}</span>
      <span className="mt-0.5 block text-sm font-semibold tabular-nums">{value}</span>
    </span>
  );
}

function DetailSectionEmpty({ message }: { message: string }) {
  return <p className="px-4 py-8 text-center text-sm leading-6 text-muted-foreground">{message}</p>;
}

function SummaryMetric({ label, value, detail, loading }: { label: string; value: string | null; detail: string; loading: boolean }) {
  return (
    <Card>
      <CardContent className="p-5 sm:p-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        {loading && !value ? <Skeleton className="mt-3 h-7 w-36" /> : <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>}
        <p className="mt-1 hidden text-sm text-muted-foreground sm:block">{detail}</p>
      </CardContent>
    </Card>
  );
}

function limitAllocation(items: ReturnType<typeof buildWalletAllocation>) {
  if (items.length <= 8) return items;
  const leading = items.slice(0, 7);
  const other = items.slice(7).reduce((sum, item) => sum + item.value, 0);
  return [...leading, { id: "other", label: "Other", value: other }];
}

function formatTokenAmount(amount: number | null, symbol: string) {
  if (amount === null) return "Amount unavailable";
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 12 }).format(amount)} ${symbol}`;
}

function formatUnlockDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function formatTaipeiDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
