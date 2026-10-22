import { countValuations, type AssetIdentity, type HoldingValuation, type ValuationCounts } from "./asset-identity";

export const CEX_EXCHANGES = ["binance", "okx", "bitget", "htx", "gate"] as const;
export const OKX_SIMPLE_EARN_ACCOUNT_ID = "okx-simple-earn";

export type CexExchange = (typeof CEX_EXCHANGES)[number];
export type CexStatus = "live" | "partial" | "stale" | "error";

const CEX_EXCHANGE_NAMES: Record<CexExchange, string> = {
  binance: "Binance",
  okx: "OKX",
  bitget: "Bitget",
  htx: "HTX",
  gate: "Gate"
};

export function getCexExchangeName(exchange: CexExchange) {
  return CEX_EXCHANGE_NAMES[exchange];
}

export type CexHolding = AssetIdentity & HoldingValuation & {
  name?: string;
  exchange: CexExchange;
  accountType: string;
  symbol: string;
  amount: number | null;
  valueUsd: number | null;
};

export function getCexHoldingPresentation(holding: Pick<CexHolding, "symbol">) {
  const isEstimate = holding.symbol.toUpperCase().endsWith("-ESTIMATE");
  return {
    isEstimate,
    label: isEstimate ? "Gate unallocated account value" : holding.symbol
  };
}

export type CexAccount = {
  id: string;
  name: string;
  status: "live" | "stale" | "error";
  valueUsd: number;
  itemCount: number;
  holdings: CexHolding[];
  error?: string;
};

export type CexSourceSnapshot = {
  pricingBasis?: string | null;
  valuation?: ValuationCounts;
  exchange: CexExchange;
  name: string;
  status: CexStatus;
  capturedAt: string;
  bucketAt: string;
  valueUsd: number;
  itemCount: number;
  accounts: CexAccount[];
  holdings: CexHolding[];
  errors: Array<{ accountType: string; message: string }>;
};

export type CexPublicResponse = {
  generatedAt: string;
  staleAfterSeconds: number;
  totalUsd: number;
  sources: CexSourceSnapshot[];
  holdings: CexHolding[];
};

export type CexHistoryPoint = {
  exchange: CexExchange;
  bucket_at: string;
  captured_at: string;
  total_usd: number;
  status: CexStatus;
};

export type CexHistoryResponse = {
  points: CexHistoryPoint[];
  error?: string;
};

export const CEX_STALE_AFTER_SECONDS = 45 * 60;

export function sanitizeCexError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(
      /((?:api[-_ ]?key|access[-_ ]?key|accesskeyid|secret|passphrase|signature|authorization)["']?\s*[:=]\s*["']?)[^&,"'\s}\]]+/gi,
      "$1[redacted]"
    )
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, "[redacted]")
    .slice(0, 180);
}

export function getCexBucketAt(value: Date | string = new Date()) {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Date(Math.floor(date.getTime() / 900_000) * 900_000).toISOString();
}

export function isCexSnapshotStale(capturedAt: string, now = Date.now()) {
  return now - new Date(capturedAt).getTime() > CEX_STALE_AFTER_SECONDS * 1000;
}

export function withCexFreshness(snapshot: CexSourceSnapshot, now = Date.now()): CexSourceSnapshot {
  if (!isCexSnapshotStale(snapshot.capturedAt, now)) return snapshot;
  return {
    ...snapshot,
    status: "stale",
    accounts: snapshot.accounts.map((account) => ({ ...account, status: "stale" }))
  };
}

export function mergeCexAccounts(
  current: CexSourceSnapshot,
  previous: CexSourceSnapshot | undefined
): CexSourceSnapshot {
  const previousAccounts = new Map((previous?.accounts ?? []).map((account) => [account.id, account]));
  let usedIncompatibleFallback = false;
  const accounts = current.accounts.map((account) => {
    if (account.status !== "error") return account;
    const fallback = previousAccounts.get(account.id);
    const usableFallback = fallback && !fallback.holdings.some((holding) => (
      /^EQ_/.test(holding.symbol) && holding.amount !== 0 &&
      (holding.valueUsd === null || holding.valueUsd <= 0)
    ));
    if (usableFallback && previous?.pricingBasis !== current.pricingBasis) {
      usedIncompatibleFallback = true;
    }
    return usableFallback
      ? { ...fallback, status: "stale" as const, error: account.error }
      : account;
  });
  const hasRequiredOkxEarnCoverage = current.exchange !== "okx" || accounts.some((account) => (
    account.id === OKX_SIMPLE_EARN_ACCOUNT_ID &&
    (account.status === "live" || account.status === "stale")
  ));
  return finalizeCexSnapshot({
    ...current,
    pricingBasis: usedIncompatibleFallback || !hasRequiredOkxEarnCoverage
      ? null
      : current.pricingBasis,
    accounts
  });
}

export function finalizeCexSnapshot(snapshot: CexSourceSnapshot): CexSourceSnapshot {
  const holdings = snapshot.accounts.flatMap((account) => account.holdings);
  const liveAccounts = snapshot.accounts.filter((account) => account.status === "live").length;
  const usableAccounts = snapshot.accounts.filter((account) => account.status !== "error").length;
  return {
    ...snapshot,
    status: liveAccounts === snapshot.accounts.length
      ? "live"
      : usableAccounts > 0
        ? "partial"
        : "error",
    valueUsd: holdings.reduce((sum, holding) => sum + (holding.valueUsd || 0), 0),
    itemCount: holdings.length,
    valuation: countValuations(holdings),
    accounts: snapshot.accounts,
    holdings
  };
}

export function buildCexPublicResponse(snapshots: CexSourceSnapshot[], now = new Date()): CexPublicResponse {
  const sources = snapshots.map((snapshot) => withCexFreshness(snapshot, now.getTime()));
  return {
    generatedAt: now.toISOString(),
    staleAfterSeconds: CEX_STALE_AFTER_SECONDS,
    totalUsd: sources.reduce((sum, source) => sum + source.valueUsd, 0),
    sources,
    holdings: sources.flatMap((source) => source.holdings)
  };
}

export function createUnavailableCexSnapshot(
  exchange: CexExchange,
  capturedAt = new Date().toISOString(),
  message = "No successful CEX snapshot is available"
): CexSourceSnapshot {
  const name = getCexExchangeName(exchange);
  return finalizeCexSnapshot({
    exchange,
    name,
    status: "error",
    capturedAt,
    bucketAt: getCexBucketAt(capturedAt),
    valueUsd: 0,
    itemCount: 0,
    accounts: [{
      id: `${exchange}-exchange`,
      name: "Exchange",
      status: "error",
      valueUsd: 0,
      itemCount: 0,
      holdings: [],
      error: message
    }],
    holdings: [],
    errors: [{ accountType: "Exchange", message }]
  });
}
