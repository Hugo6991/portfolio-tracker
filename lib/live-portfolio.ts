import type { AssetIdentity, HoldingValuation, ValuationCounts } from "./asset-identity";

export type LiveSourceKind = "exchange" | "wallet" | "bank";
export type LiveSourceStatus = "live" | "partial" | "preview" | "error";

export type LiveSource = {
  pricingBasis?: string | null;
  valuation?: ValuationCounts;
  id: string;
  name: string;
  kind: LiveSourceKind;
  status: LiveSourceStatus;
  valueUsd: number;
  itemCount: number;
  updatedAt: string;
  detail: string;
  cadence?: "15m" | "daily" | "manual";
  valueUpdatedAt?: string;
  compositionUpdatedAt?: string;
  freshnessState?: "fresh" | "late" | "stale";
  nextScheduledAt?: string | null;
  pricing?: {
    provider: "defillama";
    cadence: "15m";
    state: "fresh" | "partial" | "stale";
    updatedAt: string | null;
    eligibleTokenCount: number;
    pricedTokenCount: number;
    fallbackTokenCount: number;
    excludedTokenCount?: number;
    anomalyTokenCount?: number;
    staleTokenCount?: number;
    coverageValuePercent: number;
  };
  fallback?: {
    lastGoodAt: string;
    attemptStatus: "partial" | "error";
  };
};

export type LiveHolding = AssetIdentity & HoldingValuation & {
  iconUrl?: string | null;
  symbol: string;
  name: string;
  amount: number | null;
  valueUsd: number;
  sources: string[];
  accountCount: number;
};

export type LiveWalletDataSource = "debank" | "hyperliquid";

export type LiveWalletAssetState =
  | "liquid"
  | "staked"
  | "supplied"
  | "borrowed"
  | "locked"
  | "claimable"
  | "collateral"
  | "trading"
  | "vault"
  | "unknown";

export type LiveWalletToken = AssetIdentity & {
  id: string;
  source: LiveWalletDataSource;
  symbol: string;
  name: string;
  chainId: string;
  chainName: string;
  protocolId: string | null;
  protocolName: string | null;
  iconUrl: string | null;
  contractAddress?: string | null;
  verificationState?: "verified" | "unverified" | "unknown";
  debankIsVerified?: boolean | null;
  debankIsCore?: boolean | null;
  valuationState?: "priced" | "fallback" | "excluded";
  exclusionReason?:
    | "denylisted"
    | "native-symbol-impersonation"
    | "unverified"
    | "legacy-unverified"
    | "low-confidence"
    | "stale-quote"
    | "price-anomaly";
  amount: number | null;
  priceUsd: number | null;
  snapshotPriceUsd?: number | null;
  snapshotPriceUpdatedAt?: string | null;
  snapshotValueUsd?: number;
  priceConfidence?: number | null;
  priceSource?: "defillama" | "debank-snapshot";
  priceState?: "fresh" | "fallback" | "stale" | "excluded";
  priceUpdatedAt?: string | null;
  valueUsd: number;
  state: LiveWalletAssetState;
};

export type LiveWalletPosition = {
  id: string;
  source: LiveWalletDataSource;
  protocolId: string;
  protocolName: string;
  protocolIconUrl: string | null;
  protocolUrl: string | null;
  chainId: string;
  chainName: string;
  name: string;
  state: LiveWalletAssetState;
  /** Authoritative net position value. Nested token values are explanatory and must not be summed into wallet totals again. */
  valueUsd: number;
  assetValueUsd: number;
  debtValueUsd: number;
  unlockAt: string | null;
  tokens: LiveWalletToken[];
};

export type PendingWalletMovement = {
  id: string;
  label: string;
  amount: string;
  asset: string;
  status: "queued" | "awaiting-claim";
  recordedAt: string;
  expectedAt: string | null;
};

export type LiveWallet = {
  id: string;
  name: string;
  address: string;
  debankUrl: string;
  valueUsd: number;
  /** Trusted estimate: repriced verified liquid tokens + frozen DeFi detail. */
  debankValueUsd: number;
  /** Last raw diagnostic total returned by DeBank total_balance. */
  debankReportedValueUsd?: number;
  rawDeBankReportedValueUsd?: number;
  debankReportedAt?: string;
  /** Diagnostic-only difference; never included in debankValueUsd. */
  reconciliationUsd?: number;
  reconciliationState?: "diagnostic" | "review-required";
  excludedTokenCount?: number;
  priceUpdatedAt?: string | null;
  compositionUpdatedAt?: string;
  /** Scoped observations must never advance the whole-wallet composition date. */
  chainRefreshes?: Record<string, { tokensAt?: string; protocolsAt?: string }>;
  /** Operation records only. Never included in holdings or wallet totals. */
  pendingMovements?: PendingWalletMovement[];
  hyperliquidValueUsd: number;
  tokenCount: number;
  protocolCount: number;
  /** Direct on-wallet balances already included in debankValueUsd. */
  tokens: LiveWalletToken[];
  /** Protocol and Hyperliquid detail rows already included in debankValueUsd or hyperliquidValueUsd. */
  positions: LiveWalletPosition[];
  status: "live" | "error";
  updatedAt: string;
};

export type PortfolioLatestAttempt = {
  completedAt: string;
  status: "success" | "validating-change" | "review-required" | "source-incomplete" | "failed";
  reasonCodes: string[];
  confirmationCount: number;
  reviewReady: boolean;
  candidateNetWorthUsd: number | null;
  previousNetWorthUsd: number;
  affectedSources: Array<{
    id: string;
    name: string;
    status: LiveSourceStatus | "unknown";
    previousValueUsd: number | null;
    candidateValueUsd: number | null;
    deltaUsd: number | null;
    deltaPercent: number | null;
  }>;
};

export type LivePortfolioSnapshot = {
  valuationBasis?: string;
  generatedAt: string;
  delivery?: {
    mode: "live" | "cache" | "stale-cache";
    persisted: boolean;
    cacheAgeSeconds: number | null;
    cacheTtlSeconds: number;
    latestAttempt?: PortfolioLatestAttempt | null;
  };
  netWorthUsd: number;
  liveValueUsd: number;
  previewValueUsd: number;
  groups: {
    exchangesUsd: number;
    walletsUsd: number;
    banksUsd: number;
  };
  sources: LiveSource[];
  holdings: LiveHolding[];
  wallets: LiveWallet[];
  connectedSourceCount: number;
  expectedSourceCount: number;
  isPartial: boolean;
  errors: Array<{ source: string; message: string }>;
};
