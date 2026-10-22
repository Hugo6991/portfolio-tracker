import "server-only";
import type { AssetIdentity, HoldingValuation } from "../asset-identity";
import { countValuations } from "../asset-identity";
import { VALUATION_BASIS } from "../valuation-basis";

import { getPortfolio } from "@/lib/data";
import { assetLabel, getDisplayAccountName } from "@/lib/display";
import {
  CEX_EXCHANGES,
  getCexExchangeName,
  withCexFreshness,
  type CexSourceSnapshot
} from "@/lib/cex";
import type {
  LiveHolding,
  LivePortfolioSnapshot,
  LiveSource,
  LiveWallet,
  LiveWalletToken
} from "@/lib/live-portfolio";
import { getManualSourceFreshness } from "@/lib/source-freshness";
import { readLatestCexSnapshots } from "@/lib/server/cex-snapshot-store";
import {
  fetchDefiLlamaPrices,
  getDefiLlamaPriceKey,
  type DefiLlamaPriceQuote,
  type DefiLlamaPriceResult
} from "./defillama-prices";
import {
  readPortfolioSourcePayloads,
  type PortfolioSourceHolding,
  type PortfolioSourcePayload,
  type StoredPortfolioSourcePayload
} from "@/lib/server/portfolio-source-state";
import {
  buildDeBankWalletHoldings,
  getDeBankTokenExclusion,
  normalizeDeBankProtocolPositions,
  normalizeDeBankWalletTokens,
  normalizeHyperliquidPositions
} from "@/lib/server/wallet-details";

type HoldingAccumulator = AssetIdentity & HoldingValuation & {
  symbol: string;
  name: string;
  amount: number | null;
  valueUsd: number;
  sources: Set<string>;
  accounts: Set<string>;
};

type IntegrationResult = {
  source: LiveSource;
  holdings: PortfolioSourceHolding[];
  wallets?: LiveWallet[];
  errors: Array<{ source: string; message: string }>;
  usage?: { requestCount: number };
};

export type PortfolioSyncMode = "current" | "valuation" | "full";

const requestTimeoutMs = 6_000;
const defaultWalletConcurrency = 2;
const hourMs = 3_600_000;
const dayMs = 24 * hourMs;
const debankValuationWalletsPerDay = 2;
const debankFreshHours = 8 * 24;
const debankUsableHours = 14 * 24;
const debankCompositionFreshHours = 35 * 24;
const debankCompositionUsableHours = 45 * 24;
const defiLlamaQuoteMaxAgeMs = 2 * hourMs;
const acceptedMarketFallbackMaxAgeMs = dayMs;
const defiLlamaMinimumConfidence = 0.9;
const maximumPriceRatio = 10;

class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
    body: unknown
  ) {
    super(`HTTP ${status}: ${JSON.stringify(body)}`);
  }
}

function sanitizeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]").slice(0, 180);
}

async function getJson<T>(
  url: string | URL,
  init?: RequestInit,
  timeoutMs = requestTimeoutMs,
  retries = 1
): Promise<T> {
  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
    if (!response.ok) {
      if (retries > 0 && (response.status === 429 || response.status >= 500)) {
        await waitForRetry();
        return getJson<T>(url, init, timeoutMs, retries - 1);
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new ProviderHttpError(
        response.status,
        Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1_000 : null,
        body
      );
    }
    return body as T;
  } catch (error) {
    if (retries > 0 && (error instanceof TypeError || error instanceof DOMException)) {
      await waitForRetry();
      return getJson<T>(url, init, timeoutMs, retries - 1);
    }
    throw error;
  }
}

function waitForRetry() {
  return new Promise((resolve) => setTimeout(resolve, 200 + Math.round(Math.random() * 200)));
}

function getWalletConcurrency() {
  const configured = Number(process.env.PORTFOLIO_WALLET_CONCURRENCY);
  return Number.isInteger(configured) && configured >= 1 && configured <= 4
    ? configured
    : defaultWalletConcurrency;
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>
) {
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        await worker(values[index]);
      }
    }
  );
  await Promise.all(runners);
}

function addHolding(
  map: Map<string, HoldingAccumulator>,
  row: PortfolioSourceHolding & { source: string }
) {
  const symbol = (row.assetClass === "equity" ? row.symbol.trim() : row.symbol.trim().toUpperCase()) || "UNKNOWN";
  const current = map.get(symbol) ?? {
    symbol,
    name: row.name || assetLabel(symbol),
    amount: row.amount === null ? null : 0,
    valueUsd: 0,
    sources: new Set<string>(),
    accounts: new Set<string>()
  };
  if (row.assetClass) current.assetClass = row.assetClass;
  if (row.exposureSymbol) current.exposureSymbol = row.exposureSymbol;
  if (row.priceSource) current.priceSource = current.priceSource && current.priceSource !== row.priceSource ? "multiple" : row.priceSource;
  if (row.valuationState) current.valuationState = row.valuationState;
  current.valueUsd += Number.isFinite(row.valueUsd) ? row.valueUsd : 0;
  current.amount = current.amount == null || row.amount == null ? null : current.amount + row.amount;
  current.sources.add(row.source);
  current.accounts.add(row.accountId);
  map.set(symbol, current);
}

async function fetchDeBank(now: string): Promise<IntegrationResult> {
  const accessKey = process.env.DEBANK_ACCESS_KEY;
  const baseUrl = process.env.DEBANK_BASE_URL || "https://pro-openapi.debank.com";
  const seed = getPortfolio();
  const wallets = seed.wallets.filter(
    (wallet): wallet is typeof wallet & { address: string } => Boolean(wallet.address && /^0x[a-fA-F0-9]{40}$/.test(wallet.address))
  );

  if (!accessKey) {
    return {
      source: { id: "debank", name: "DeBank", kind: "wallet", status: "error", valueUsd: 0, itemCount: wallets.length, updatedAt: now, detail: "Access key missing" },
      holdings: [],
      wallets: [],
      errors: [{ source: "DeBank", message: "Access key missing" }]
    };
  }

  const headers = { accept: "application/json", AccessKey: accessKey };
  const errors: Array<{ source: string; message: string }> = [];
  const liveWallets: LiveWallet[] = [];
  const holdings: IntegrationResult["holdings"] = [];
  let requestCount = 0;
  let globalFailure: string | null = null;

  // A single wallet at a time makes a global 401/403 a real circuit breaker:
  // after the first rejected wallet, no requests are opened for the other 11.
  await mapWithConcurrency(wallets, 1, async (wallet) => {
    if (globalFailure) return;
    const name = getDisplayAccountName(wallet.name);
    try {
      const tokenUrl = new URL("/v1/user/all_token_list", baseUrl);
      tokenUrl.searchParams.set("id", wallet.address);
      tokenUrl.searchParams.set("is_all", "false");
      const protocolUrl = new URL("/v1/user/all_simple_protocol_list", baseUrl);
      protocolUrl.searchParams.set("id", wallet.address);
      const complexProtocolUrl = new URL("/v1/user/all_complex_protocol_list", baseUrl);
      complexProtocolUrl.searchParams.set("id", wallet.address);
      const totalUrl = new URL("/v1/user/total_balance", baseUrl);
      totalUrl.searchParams.set("id", wallet.address);

      requestCount += 4;
      const [tokens, protocols, complexProtocols, total] = await Promise.all([
        getJson<Array<Record<string, unknown>>>(tokenUrl, { headers }),
        getJson<Array<Record<string, unknown>>>(protocolUrl, { headers }),
        getJson<Array<Record<string, unknown>>>(complexProtocolUrl, { headers }),
        getJson<{ total_usd_value?: number }>(totalUrl, { headers })
      ]);

      const walletTokens = normalizeDeBankWalletTokens(tokens, now);
      const positions = normalizeDeBankProtocolPositions(complexProtocols, protocols, now);
      const tokenValueUsd = walletTokens.reduce((sum, token) => sum + token.valueUsd, 0);
      const structuredProtocolValueUsd = positions.reduce((sum, position) => sum + position.valueUsd, 0);
      const reportedTotalValueUsd = Number(total.total_usd_value);
      const debankValueUsd = tokenValueUsd + structuredProtocolValueUsd;
      const reconciliationUsd = Number.isFinite(reportedTotalValueUsd)
        ? reportedTotalValueUsd - debankValueUsd
        : 0;
      const reconciliationState = isMaterialReconciliation(reconciliationUsd, reportedTotalValueUsd)
        ? "review-required" as const
        : "diagnostic" as const;
      const excludedTokenCount = walletTokens.filter((token) => token.valuationState === "excluded").length;
      for (const holding of buildDeBankWalletHoldings({
        tokens: walletTokens,
        positions,
        protocolValueUsd: structuredProtocolValueUsd,
        walletValueUsd: debankValueUsd
      })) {
        holdings.push({
          ...holding,
          accountId: wallet.address
        });
      }

      liveWallets.push({
        id: wallet.id,
        name,
        address: wallet.address,
        debankUrl: `https://debank.com/profile/${wallet.address}`,
        valueUsd: debankValueUsd,
        debankValueUsd,
        ...(Number.isFinite(reportedTotalValueUsd) ? {
          debankReportedValueUsd: reportedTotalValueUsd,
          rawDeBankReportedValueUsd: reportedTotalValueUsd,
          debankReportedAt: now
        } : {}),
        reconciliationUsd,
        reconciliationState,
        excludedTokenCount,
        priceUpdatedAt: now,
        compositionUpdatedAt: now,
        hyperliquidValueUsd: 0,
        tokenCount: walletTokens.length - excludedTokenCount,
        protocolCount: new Set(positions.map((position) => `${position.chainId}:${position.protocolId}`)).size,
        tokens: walletTokens,
        positions,
        status: "live",
        updatedAt: now
      });
    } catch (error) {
      const message = sanitizeError(error);
      if (isDeBankGlobalFailure(error)) {
        globalFailure = message;
      } else {
        errors.push({ source: name, message });
      }
      liveWallets.push({
        id: wallet.id,
        name,
        address: wallet.address,
        debankUrl: `https://debank.com/profile/${wallet.address}`,
        valueUsd: 0,
        debankValueUsd: 0,
        hyperliquidValueUsd: 0,
        tokenCount: 0,
        protocolCount: 0,
        tokens: [],
        positions: [],
        status: "error",
        updatedAt: now
      });
    }
  });

  if (globalFailure) {
    errors.unshift({ source: "DeBank", message: globalFailure });
  }

  const valueUsd = liveWallets.reduce((sum, wallet) => sum + wallet.valueUsd, 0);
  const successCount = liveWallets.filter((wallet) => wallet.status === "live").length;

  return {
    source: {
      id: "debank",
      name: "DeBank",
      kind: "wallet",
      status: successCount === wallets.length ? "live" : successCount > 0 ? "partial" : "error",
      valueUsd,
      itemCount: successCount,
      updatedAt: now,
      valueUpdatedAt: now,
      compositionUpdatedAt: now,
      detail: `${successCount} of ${wallets.length} EVM wallets`
    },
    holdings,
    wallets: liveWallets.sort((a, b) => b.valueUsd - a.valueUsd),
    errors,
    usage: { requestCount }
  };
}

function isDeBankGlobalFailure(error: unknown) {
  return error instanceof ProviderHttpError && [401, 403].includes(error.status);
}

function isMaterialReconciliation(reconciliationUsd: number, reportedValueUsd: number) {
  return Math.abs(reconciliationUsd) > 100 &&
    reportedValueUsd > 0 &&
    Math.abs(reconciliationUsd) / reportedValueUsd > 0.02;
}

function oldestDate(values: Array<string | null | undefined>) {
  const timestamps = values
    .map((value) => value ? Date.parse(value) : Number.NaN)
    .filter(Number.isFinite);
  return timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString() : null;
}

async function fetchDeBankValuation(
  now: string,
  stored: StoredPortfolioSourcePayload
): Promise<IntegrationResult> {
  const accessKey = process.env.DEBANK_ACCESS_KEY;
  const baseUrl = process.env.DEBANK_BASE_URL || "https://pro-openapi.debank.com";
  const configuredWallets = getConfiguredWalletShells(now);
  if (!accessKey) {
    return {
      source: {
        id: "debank",
        name: "DeBank",
        kind: "wallet",
        status: "error",
        valueUsd: 0,
        itemCount: 0,
        updatedAt: now,
        detail: "Access key missing"
      },
      holdings: [],
      wallets: [],
      errors: [{ source: "DeBank", message: "Access key missing" }],
      usage: { requestCount: 0 }
    };
  }

  const storedWallets = new Map((stored.wallets ?? []).map((wallet) => [wallet.id, wallet]));
  const valuationWallets = selectRotatingDeBankWallets(configuredWallets, now);
  const headers = { accept: "application/json", AccessKey: accessKey };
  const walletsById = new Map(configuredWallets.map((shell) => [
    shell.id,
    storedWallets.get(shell.id) ?? shell
  ]));
  const holdings: PortfolioSourceHolding[] = [];
  const errors: IntegrationResult["errors"] = [];
  let requestCount = 0;
  let successCount = 0;
  let globalFailure: string | null = null;

  await mapWithConcurrency(valuationWallets, 1, async (shell) => {
    if (globalFailure) return;
    const previous = storedWallets.get(shell.id) ?? shell;
    try {
      const totalUrl = new URL("/v1/user/total_balance", baseUrl);
      totalUrl.searchParams.set("id", shell.address);
      requestCount += 1;
      const total = await getJson<{ total_usd_value?: number }>(totalUrl, { headers });
      const totalValueUsd = Number(total.total_usd_value);
      if (!Number.isFinite(totalValueUsd) || totalValueUsd < 0) {
        throw new Error("total_balance did not return a non-negative value");
      }
      const liquidValueUsd = previous.tokens.reduce((sum, token) => sum + token.valueUsd, 0);
      const structuredProtocolValueUsd = previous.positions
        .filter((position) => position.source === "debank")
        .reduce((sum, position) => sum + position.valueUsd, 0);
      const trustedValueUsd = liquidValueUsd + structuredProtocolValueUsd;
      const reconciliationUsd = totalValueUsd - trustedValueUsd;
      walletsById.set(shell.id, {
        ...previous,
        valueUsd: trustedValueUsd,
        debankValueUsd: trustedValueUsd,
        debankReportedValueUsd: totalValueUsd,
        rawDeBankReportedValueUsd: totalValueUsd,
        debankReportedAt: now,
        reconciliationUsd,
        reconciliationState: isMaterialReconciliation(reconciliationUsd, totalValueUsd)
          ? "review-required"
          : "diagnostic",
        compositionUpdatedAt: previous.compositionUpdatedAt ?? stored.source.compositionUpdatedAt ?? stored.source.updatedAt,
        hyperliquidValueUsd: 0,
        status: "live",
        updatedAt: now
      });
      successCount += 1;
    } catch (error) {
      const message = sanitizeError(error);
      if (isDeBankGlobalFailure(error)) globalFailure = message;
      else errors.push({ source: previous.name, message });
    }
  });

  if (globalFailure) errors.unshift({ source: "DeBank", message: globalFailure });
  const wallets = configuredWallets.map((shell) => walletsById.get(shell.id) ?? shell);
  const liveWalletCount = wallets.filter((wallet) => wallet.status === "live").length;
  const valueUsd = wallets
    .filter((wallet) => wallet.status === "live")
    .reduce((sum, wallet) => sum + wallet.debankValueUsd, 0);
  const compositionUpdatedAt = stored.source.compositionUpdatedAt ?? stored.source.updatedAt;
  const oldestWalletCheckAt = oldestDate(
    wallets.map((wallet) => wallet.debankReportedAt ?? wallet.compositionUpdatedAt ?? compositionUpdatedAt)
  ) ?? compositionUpdatedAt;
  const allChecksSucceeded = successCount === valuationWallets.length;
  return {
    source: {
      id: "debank",
      name: "DeBank",
      kind: "wallet",
      status: allChecksSucceeded && liveWalletCount === configuredWallets.length
        ? "live"
        : liveWalletCount > 0 ? "partial" : "error",
      valueUsd,
      itemCount: liveWalletCount,
      updatedAt: now,
      valueUpdatedAt: oldestWalletCheckAt,
      compositionUpdatedAt,
      detail: `${successCount} of ${valuationWallets.length} scheduled wallet totals checked · ${configuredWallets.length} wallets rotate over six days`
    },
    holdings,
    wallets: wallets.sort((left, right) => right.valueUsd - left.valueUsd),
    errors,
    usage: { requestCount }
  };
}

export function selectRotatingDeBankWallets<T extends { id: string }>(wallets: T[], now: string) {
  if (wallets.length <= debankValuationWalletsPerDay) return wallets;
  const groupCount = Math.ceil(wallets.length / debankValuationWalletsPerDay);
  const taipeiDay = Math.floor((Date.parse(now) + 8 * hourMs) / dayMs);
  const groupIndex = ((taipeiDay % groupCount) + groupCount) % groupCount;
  const start = groupIndex * debankValuationWalletsPerDay;
  return wallets.slice(start, start + debankValuationWalletsPerDay);
}

type WalletPricingStats = {
  eligibleTokenCount: number;
  pricedTokenCount: number;
  fallbackTokenCount: number;
  excludedTokenCount: number;
  anomalyTokenCount: number;
  staleTokenCount: number;
  eligibleValueUsd: number;
  pricedValueUsd: number;
};

function excludedToken(
  token: LiveWalletToken,
  reason: NonNullable<LiveWalletToken["exclusionReason"]>
): LiveWalletToken {
  return {
    ...token,
    verificationState: token.verificationState ?? "unknown",
    valuationState: "excluded",
    exclusionReason: reason,
    priceState: "excluded",
    valueUsd: 0
  };
}

function quoteExclusion(
  token: LiveWalletToken,
  quote: DefiLlamaPriceQuote,
  now: string
): LiveWalletToken["exclusionReason"] | null {
  if (quote.confidence === null || quote.confidence < defiLlamaMinimumConfidence) {
    return "low-confidence";
  }
  const providerUpdatedAt = quote.providerUpdatedAt ? Date.parse(quote.providerUpdatedAt) : Number.NaN;
  const ageMs = Date.parse(now) - providerUpdatedAt;
  if (!Number.isFinite(ageMs) || ageMs < -5 * 60_000 || ageMs > defiLlamaQuoteMaxAgeMs) {
    return "stale-quote";
  }
  const snapshotPriceUsd = token.snapshotPriceUsd ?? (
    token.priceSource === "debank-snapshot" ? token.priceUsd : null
  );
  if (snapshotPriceUsd !== null && snapshotPriceUsd > 0) {
    const ratio = quote.priceUsd / snapshotPriceUsd;
    if (ratio > maximumPriceRatio || ratio < 1 / maximumPriceRatio) return "price-anomaly";
  } else if (token.amount !== null && Math.abs(token.amount * quote.priceUsd) > 100) {
    return "price-anomaly";
  }
  return null;
}

function fallbackToken(token: LiveWalletToken, now: string): LiveWalletToken {
  const marketAgeMs = token.priceUpdatedAt
    ? Date.parse(now) - Date.parse(token.priceUpdatedAt)
    : Number.POSITIVE_INFINITY;
  if (
    token.priceSource === "defillama" &&
    Number.isFinite(marketAgeMs) &&
    marketAgeMs >= 0 &&
    marketAgeMs <= acceptedMarketFallbackMaxAgeMs
  ) {
    return {
      ...token,
      valuationState: "fallback",
      exclusionReason: undefined,
      priceState: "fallback"
    };
  }
  const snapshotPriceUsd = token.snapshotPriceUsd ?? (
    token.priceSource === "debank-snapshot" ? token.priceUsd : null
  );
  const snapshotValueUsd = token.snapshotValueUsd ?? (
    token.amount !== null && snapshotPriceUsd !== null
      ? Math.abs(token.amount * snapshotPriceUsd)
      : token.valueUsd
  );
  return {
    ...token,
    valuationState: "fallback",
    exclusionReason: undefined,
    priceUsd: snapshotPriceUsd,
    // Never attach a newer market quote timestamp to the calibration valuation.
    priceUpdatedAt: token.snapshotPriceUpdatedAt ?? (
      token.priceSource === "debank-snapshot" ? token.priceUpdatedAt ?? null : null
    ),
    priceSource: "debank-snapshot",
    priceState: "stale",
    valueUsd: snapshotValueUsd
  };
}

function repriceWallet(
  wallet: LiveWallet,
  pricing: DefiLlamaPriceResult,
  now: string
): { wallet: LiveWallet; stats: WalletPricingStats } {
  const structuredProtocolValueUsd = wallet.positions
    .filter((position) => position.source === "debank")
    .reduce((sum, position) => sum + position.valueUsd, 0);
  const stats: WalletPricingStats = {
    eligibleTokenCount: 0,
    pricedTokenCount: 0,
    fallbackTokenCount: 0,
    excludedTokenCount: 0,
    anomalyTokenCount: 0,
    staleTokenCount: 0,
    eligibleValueUsd: 0,
    pricedValueUsd: 0
  };

  const tokens = wallet.tokens.map((token): LiveWalletToken => {
    const trustExclusion = getDeBankTokenExclusion(token);
    if (trustExclusion) {
      stats.excludedTokenCount += 1;
      return excludedToken(token, trustExclusion);
    }
    const priceKey = getDefiLlamaPriceKey(token);
    if (!priceKey) {
      const fallback = fallbackToken(token, now);
      stats.staleTokenCount += fallback.priceState === "stale" ? 1 : 0;
      return fallback;
    }

    stats.eligibleTokenCount += 1;
    stats.eligibleValueUsd += Math.abs(token.snapshotValueUsd ?? token.valueUsd);
    const quote = pricing.quotes.get(priceKey);
    if (!quote || token.amount === null || !Number.isFinite(token.amount)) {
      stats.fallbackTokenCount += 1;
      const fallback = fallbackToken(token, now);
      stats.staleTokenCount += fallback.priceState === "stale" ? 1 : 0;
      return fallback;
    }
    const marketExclusion = quoteExclusion(token, quote, now);
    if (marketExclusion) {
      stats.excludedTokenCount += 1;
      stats.anomalyTokenCount += 1;
      return excludedToken(token, marketExclusion);
    }

    stats.pricedTokenCount += 1;
    stats.pricedValueUsd += Math.abs(token.snapshotValueUsd ?? token.valueUsd);
    return {
      ...token,
      verificationState: token.verificationState ?? "verified",
      valuationState: "priced",
      exclusionReason: undefined,
      priceUsd: quote.priceUsd,
      priceConfidence: quote.confidence,
      priceSource: "defillama",
      priceState: "fresh",
      priceUpdatedAt: quote.providerUpdatedAt ?? quote.fetchedAt,
      valueUsd: Math.abs(token.amount * quote.priceUsd)
    };
  });

  const liquidValueUsd = tokens.reduce((sum, token) => sum + token.valueUsd, 0);
  const debankValueUsd = liquidValueUsd + structuredProtocolValueUsd;
  const reportedValueUsd = wallet.rawDeBankReportedValueUsd ?? wallet.debankReportedValueUsd;
  const reconciliationUsd = Number.isFinite(reportedValueUsd)
    ? reportedValueUsd! - debankValueUsd
    : 0;
  const reconciliationState = Number.isFinite(reportedValueUsd) &&
    isMaterialReconciliation(reconciliationUsd, reportedValueUsd!)
      ? "review-required" as const
      : "diagnostic" as const;
  const priceUpdatedAt = stats.pricedTokenCount > 0
    ? now
    : wallet.priceUpdatedAt ?? null;

  return {
    wallet: {
      ...wallet,
      valueUsd: debankValueUsd,
      debankValueUsd,
      reconciliationUsd,
      reconciliationState,
      excludedTokenCount: stats.excludedTokenCount,
      priceUpdatedAt,
      tokenCount: tokens.length - stats.excludedTokenCount,
      tokens,
      updatedAt: now
    },
    stats
  };
}

async function repriceDeBankIntegration(
  integration: IntegrationResult,
  now: string
): Promise<IntegrationResult> {
  const originalWallets = integration.wallets ?? [];
  const directTokens = originalWallets
    .filter((wallet) => wallet.status === "live")
    .flatMap((wallet) => wallet.tokens);
  const pricing = await fetchDefiLlamaPrices(directTokens, now);
  const aggregateStats: WalletPricingStats = {
    eligibleTokenCount: 0,
    pricedTokenCount: 0,
    fallbackTokenCount: 0,
    excludedTokenCount: 0,
    anomalyTokenCount: 0,
    staleTokenCount: 0,
    eligibleValueUsd: 0,
    pricedValueUsd: 0
  };
  const wallets = originalWallets.map((wallet) => {
    if (wallet.status !== "live") return wallet;
    const repriced = repriceWallet(wallet, pricing, now);
    for (const key of Object.keys(aggregateStats) as Array<keyof WalletPricingStats>) {
      aggregateStats[key] += repriced.stats[key];
    }
    return repriced.wallet;
  });
  const holdings = wallets
    .filter((wallet) => wallet.status === "live")
    .flatMap((wallet) => {
      const positions = wallet.positions.filter((position) => position.source === "debank");
      const protocolValueUsd = positions.reduce((sum, position) => sum + position.valueUsd, 0);
      return buildDeBankWalletHoldings({
        tokens: wallet.tokens,
        positions,
        protocolValueUsd,
        walletValueUsd: wallet.debankValueUsd
      }).map((holding) => ({ ...holding, accountId: wallet.address }));
    });
  const coverageValuePercent = aggregateStats.eligibleValueUsd > 0
    ? Math.round(aggregateStats.pricedValueUsd / aggregateStats.eligibleValueUsd * 10_000) / 100
    : 100;
  const pricingState = aggregateStats.anomalyTokenCount > 0
    ? aggregateStats.pricedTokenCount > 0 ? "partial" as const : "stale" as const
    : aggregateStats.eligibleTokenCount === 0 ||
      aggregateStats.pricedTokenCount === aggregateStats.eligibleTokenCount
    ? "fresh" as const
    : aggregateStats.pricedTokenCount > 0
      ? "partial" as const
      : "stale" as const;
  const pricingUpdatedAt = aggregateStats.pricedTokenCount > 0
    ? now
    : integration.source.pricing?.updatedAt ?? null;
  const valueUsd = wallets
    .filter((wallet) => wallet.status === "live")
    .reduce((sum, wallet) => sum + wallet.debankValueUsd, 0);
  const errors = pricing.errors.length > 0
    ? [...integration.errors, {
        source: "DefiLlama prices",
        message: `${pricing.failedBatchCount} price ${pricing.failedBatchCount === 1 ? "batch" : "batches"} failed; bounded fallbacks retained`
      }]
    : integration.errors;

  return {
    ...integration,
    source: {
      ...integration.source,
      valueUsd,
      updatedAt: now,
      pricing: {
        provider: "defillama",
        cadence: "15m",
        state: pricingState,
        updatedAt: pricingUpdatedAt,
        eligibleTokenCount: aggregateStats.eligibleTokenCount,
        pricedTokenCount: aggregateStats.pricedTokenCount,
        fallbackTokenCount: aggregateStats.fallbackTokenCount,
        excludedTokenCount: aggregateStats.excludedTokenCount,
        anomalyTokenCount: aggregateStats.anomalyTokenCount,
        staleTokenCount: aggregateStats.staleTokenCount,
        coverageValuePercent
      }
    },
    holdings,
    wallets: wallets.sort((left, right) => right.valueUsd - left.valueUsd),
    errors
  };
}

async function fetchHyperliquid(
  now: string,
  wallets: LiveWallet[],
  mode: PortfolioSyncMode,
  totalWalletCount: number
): Promise<IntegrationResult> {
  const holdings: IntegrationResult["holdings"] = [];
  const errors: IntegrationResult["errors"] = [];
  let successCount = 0;
  let hypePrice: number | null = null;

  try {
    const mids = await getJson<Record<string, string>>("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" })
    });
    const candidate = Number(mids.HYPE || mids["@107"]);
    if (!Number.isFinite(candidate) || candidate <= 0) {
      throw new Error("response did not include a positive HYPE price");
    }
    hypePrice = candidate;
  } catch (error) {
    errors.push({
      source: "Hyperliquid",
      message: `HYPE price unavailable from allMids: ${sanitizeError(error)}`
    });
  }

  await mapWithConcurrency(wallets, getWalletConcurrency(), async (wallet) => {
    try {
      const [staking, perps, vaults] = await Promise.all([
        getJson<{ delegated?: string; undelegated?: string; totalPendingWithdrawal?: string }>("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "delegatorSummary", user: wallet.address.toLowerCase() })
        }),
        getJson<{ marginSummary?: { accountValue?: string } }>("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "clearinghouseState", user: wallet.address.toLowerCase() })
        }),
        getJson<Array<{
          vaultAddress?: string;
          name?: string;
          equity?: string;
          lockupUntil?: number | string;
          lockedUntilTimestamp?: number | string;
          lockedUntil?: number | string;
        }>>("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "userVaultEquities", user: wallet.address.toLowerCase() })
        })
      ]);
      const detailedVaults = await Promise.all(vaults.map(async (vault) => {
        if (!vault.vaultAddress || (Number(vault.equity) || 0) < 0.01) return vault;
        const details = await getJson<{
          name?: string;
          followerState?: { lockupUntil?: number | string } | null;
          followers?: Array<{ user?: string; lockupUntil?: number | string }>;
        }>("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "vaultDetails",
            vaultAddress: vault.vaultAddress,
            user: wallet.address.toLowerCase()
          })
        }, 3_000).catch(() => null);
        if (!details) return vault;
        const follower = details.followerState ?? details.followers?.find(
          (row) => row.user?.toLowerCase() === wallet.address.toLowerCase()
        );
        return {
          ...vault,
          name: details.name || vault.name,
          lockupUntil: follower?.lockupUntil
        };
      }));
      const stakedHype =
        (Number(staking.delegated) || 0) +
        (Number(staking.undelegated) || 0) +
        (Number(staking.totalPendingWithdrawal) || 0);
      const stakingValueUsd = stakedHype * (hypePrice || 0);
      const tradingValueUsd = Number(perps.marginSummary?.accountValue) || 0;
      const vaultValueUsd = detailedVaults.reduce((sum, vault) => sum + (Number(vault.equity) || 0), 0);
      const valueUsd = stakingValueUsd + tradingValueUsd + vaultValueUsd;
      const positions = normalizeHyperliquidPositions({
        address: wallet.address,
        hypePriceUsd: hypePrice || 0,
        staking,
        perps,
        vaults: detailedVaults
      });

      if (stakingValueUsd >= 0.01) {
        holdings.push({
          symbol: "HYPE",
          name: "Hyperliquid",
          amount: stakedHype,
          valueUsd: stakingValueUsd,
          accountId: `${wallet.address}:hyperliquid-staking`
        });
      }
      if (tradingValueUsd >= 0.01) {
        holdings.push({
          symbol: "HL-PERP",
          name: "Hyperliquid trading equity",
          amount: null,
          valueUsd: tradingValueUsd,
          accountId: `${wallet.address}:hyperliquid-perps`
        });
      }
      if (vaultValueUsd >= 0.01) {
        holdings.push({
          symbol: "HL-VAULT",
          name: "Hyperliquid vault equity",
          amount: null,
          valueUsd: vaultValueUsd,
          accountId: `${wallet.address}:hyperliquid-vaults`
        });
      }

      wallet.hyperliquidValueUsd = valueUsd;
      wallet.valueUsd += valueUsd;
      wallet.positions.push(...positions);
      wallet.protocolCount = new Set(
        wallet.positions.map((position) => `${position.source}:${position.chainId}:${position.protocolId}`)
      ).size;
      successCount += 1;
    } catch (error) {
      errors.push({ source: `${wallet.name} / Hyperliquid`, message: sanitizeError(error) });
    }
  });

  const valueUsd = holdings.reduce((sum, holding) => sum + holding.valueUsd, 0);
  const status = hypePrice === null
    ? successCount > 0 ? "partial" : "error"
    : successCount === wallets.length ? "live" : successCount > 0 ? "partial" : "error";
  return {
    source: {
      id: "hyperliquid",
      name: "Hyperliquid",
      kind: "wallet",
      status,
      valueUsd,
      itemCount: holdings.length,
      updatedAt: now,
      detail: [
        `${successCount} of ${wallets.length} ${mode === "current" && wallets.length < totalWalletCount ? "active " : ""}addresses`,
        mode === "current" && wallets.length < totalWalletCount ? `${totalWalletCount} scanned daily` : null,
        "staking + trading",
        hypePrice === null ? "HYPE price unavailable" : null
      ].filter(Boolean).join(" · ")
    },
    holdings,
    wallets,
    errors
  };
}

function getBankPreview(now: string): IntegrationResult {
  const portfolio = getPortfolio();
  const banks = portfolio.banks;
  const includedBanks = banks.filter((bank) => bank.valueUsd != null && bank.valueUsd > 0);
  const updatedAt = includedBanks
    .map((bank) => bank.lastUpdate)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort()
    .at(0) ?? portfolio.meta?.exportedAt ?? now;
  const valueUsd = banks.reduce((sum, bank) => sum + (bank.valueUsd || 0), 0);
  const holdings = includedBanks
    .map((bank) => {
      const symbol = bank.nativeCurrency ?? bank.assets[0] ?? "TWD";
      return {
        symbol,
        name: currencyName(symbol),
        amount: bank.nativeAmount ?? bank.valueTwd,
        valueUsd: bank.valueUsd || 0,
        accountId: bank.id
      };
    });
  return {
    source: {
      id: "bank-csv",
      name: "Bank CSV",
      kind: "bank",
      status: "preview",
      valueUsd,
      itemCount: holdings.length,
      updatedAt,
      valueUpdatedAt: updatedAt,
      compositionUpdatedAt: updatedAt,
      cadence: "manual",
      detail: `${holdings.length} privacy-safe currency aggregates`
    },
    holdings,
    errors: []
  };
}

function currencyName(symbol: string) {
  if (symbol === "TWD") return "New Taiwan dollar";
  if (symbol === "USD") return "US dollar";
  if (symbol === "JPY") return "Japanese yen";
  return symbol;
}

function cexSnapshotToIntegration(snapshot: CexSourceSnapshot): IntegrationResult {
  return {
    source: {
      id: snapshot.exchange,
      pricingBasis: snapshot.pricingBasis,
      name: snapshot.name,
      kind: "exchange",
      status: snapshot.status === "live" ? "live" : snapshot.status === "error" ? "error" : "partial",
      valueUsd: snapshot.valueUsd,
      itemCount: snapshot.itemCount,
      valuation: snapshot.valuation ?? countValuations(snapshot.holdings),
      updatedAt: snapshot.capturedAt,
      detail: `${snapshot.accounts.filter((account) => account.status === "live").length} of ${snapshot.accounts.length} account types${snapshot.status === "stale" ? " · stale" : ""}`
    },
    holdings: snapshot.holdings
      .filter((holding) => holding.valueUsd !== null && holding.valueUsd >= 0.01)
      .map((holding) => ({
        ...holding,
        symbol: holding.symbol,
        amount: holding.amount,
        valueUsd: holding.valueUsd || 0,
        accountId: `${holding.exchange}:${holding.accountType}`
      })),
    errors: snapshot.errors.map((error) => ({ source: `${snapshot.name} / ${error.accountType}`, message: error.message }))
  };
}

export type LivePortfolioCandidate = {
  snapshot: LivePortfolioSnapshot;
  sourcePayloads: PortfolioSourcePayload[];
  providerUsage: {
    debank: {
      scanAttempted: boolean;
      requestCount: number;
      scanKind: "none" | "total-balance" | "full";
      estimatedUnits: number;
    };
  };
};

function getConfiguredWalletShells(now: string): LiveWallet[] {
  return getPortfolio().wallets
    .filter((wallet): wallet is typeof wallet & { address: string } => (
      Boolean(wallet.address && /^0x[a-fA-F0-9]{40}$/.test(wallet.address))
    ))
    .map((wallet) => ({
      id: wallet.id,
      name: getDisplayAccountName(wallet.name),
      address: wallet.address,
      debankUrl: `https://debank.com/profile/${wallet.address}`,
      valueUsd: 0,
      debankValueUsd: 0,
      hyperliquidValueUsd: 0,
      tokenCount: 0,
      protocolCount: 0,
      tokens: [],
      positions: [],
      status: "error" as const,
      updatedAt: now
    }));
}

function storedDeBankIntegration(
  stored: StoredPortfolioSourcePayload | undefined,
  now: string
): IntegrationResult {
  if (!stored || stored.source.kind !== "wallet") {
    return {
      source: {
        id: "debank",
        name: "DeBank",
        kind: "wallet",
        status: "error",
        valueUsd: 0,
        itemCount: 0,
        updatedAt: now,
        detail: "No daily DeBank snapshot is available"
      },
      holdings: [],
      wallets: getConfiguredWalletShells(now),
      errors: [{ source: "DeBank", message: "No usable daily snapshot is available" }]
    };
  }

  const wallets = stored.wallets ?? getConfiguredWalletShells(stored.lastGoodAt);
  const compositionUpdatedAt = stored.source.compositionUpdatedAt ?? stored.source.updatedAt;
  const valueUpdatedAt = stored.source.valueUpdatedAt ?? oldestDate(
    wallets.map((wallet) => wallet.debankReportedAt ?? wallet.compositionUpdatedAt ?? compositionUpdatedAt)
  ) ?? stored.lastGoodAt;
  const ageHours = Math.max(0, (Date.parse(now) - Date.parse(valueUpdatedAt)) / hourMs);
  const compositionAgeHours = Math.max(0, (Date.parse(now) - Date.parse(compositionUpdatedAt)) / hourMs);
  if (ageHours > debankUsableHours || compositionAgeHours > debankCompositionUsableHours) {
    return {
      source: {
        id: "debank",
        name: "DeBank",
        kind: "wallet",
        status: "error",
        valueUsd: 0,
        itemCount: 0,
        updatedAt: stored.lastGoodAt,
        valueUpdatedAt,
        compositionUpdatedAt,
        detail: "Rotating total checks or monthly composition are outside the safe window"
      },
      holdings: [],
      wallets: getConfiguredWalletShells(now),
      errors: [{ source: "DeBank", message: "DeBank verification data is too old to use for allocation or performance" }]
    };
  }
  const freshnessState = ageHours <= debankFreshHours && compositionAgeHours <= debankCompositionFreshHours
    ? "fresh"
    : "late";
  const status = freshnessState === "fresh" ? "live" : "partial";
  return {
    source: {
      ...stored.source,
      name: "DeBank",
      status,
      updatedAt: stored.lastGoodAt,
      valueUpdatedAt,
      compositionUpdatedAt,
      detail: freshnessState === "fresh"
        ? `Rotating wallet checks are current · prices update every 15 minutes`
        : "A rotating wallet check or monthly composition refresh is late",
      ...(status === "partial" ? {
        fallback: {
          lastGoodAt: stored.lastGoodAt,
          attemptStatus: "partial" as const
        }
      } : {})
    },
    holdings: stored.holdings,
    wallets,
    errors: status === "partial"
      ? [{ source: "DeBank", message: "A DeBank verification window is late; bounded trusted data is retained" }]
      : []
  };
}

function nextQuarterHour(now: string) {
  const timestamp = Date.parse(now);
  return new Date(Math.floor(timestamp / 900_000) * 900_000 + 900_000).toISOString();
}

function nextTaipeiDailySync(now: string) {
  const timestamp = Date.parse(now);
  const taipeiDate = new Date(timestamp + 8 * hourMs).toISOString().slice(0, 10);
  let target = Date.parse(`${taipeiDate}T00:30:00.000Z`);
  if (target <= timestamp) target += 24 * hourMs;
  return new Date(target).toISOString();
}

function enrichSourceMetadata(source: LiveSource, compositionUpdatedAt: string): LiveSource {
  const valueUpdatedAt = source.valueUpdatedAt ?? source.fallback?.lastGoodAt ?? source.updatedAt;
  const ageHours = Math.max(0, (Date.parse(compositionUpdatedAt) - Date.parse(valueUpdatedAt)) / hourMs);
  const isDeBank = source.id === "debank";
  const freshnessState = isDeBank
    ? source.status === "error"
      ? "stale"
      : ageHours <= debankFreshHours ? "fresh" : ageHours <= debankUsableHours ? "late" : "stale"
    : source.kind === "bank"
      ? getManualSourceFreshness(source.status, ageHours)
      : source.status === "error" ? "stale" : source.fallback ? "late" : "fresh";
  return {
    ...source,
    cadence: isDeBank ? "daily" : source.kind === "bank" ? "manual" : "15m",
    valueUpdatedAt,
    compositionUpdatedAt: source.compositionUpdatedAt ?? (isDeBank ? source.updatedAt : compositionUpdatedAt),
    freshnessState,
    nextScheduledAt: isDeBank
      ? nextTaipeiDailySync(compositionUpdatedAt)
      : source.kind === "bank" ? null : nextQuarterHour(compositionUpdatedAt)
  };
}

function selectHyperliquidWallets(
  wallets: LiveWallet[],
  stored: StoredPortfolioSourcePayload | undefined,
  mode: PortfolioSyncMode
) {
  if (mode === "full" || !stored?.wallets?.length) return wallets;

  const configuredIds = new Set(
    getPortfolio().wallets
      .filter((wallet) => wallet.chain.toLowerCase() === "hyperliquid")
      .map((wallet) => wallet.id)
  );
  const recentlyActiveIds = new Set(
    (stored?.wallets ?? [])
      .filter((wallet) => (
        wallet.hyperliquidValueUsd >= 0.01 ||
        wallet.positions.some((position) => position.source === "hyperliquid")
      ))
      .map((wallet) => wallet.id)
  );
  const selected = wallets.filter((wallet) => (
    configuredIds.has(wallet.id) || recentlyActiveIds.has(wallet.id)
  ));

  // If every remembered address was removed from the configured wallet list,
  // scan everything once so the active-address set can repair itself.
  return selected.length > 0 ? selected : wallets;
}

function withSourceFallback(
  attempt: IntegrationResult,
  stored: StoredPortfolioSourcePayload | undefined
): IntegrationResult {
  if (
    attempt.source.status === "live" ||
    attempt.source.status === "preview" ||
    !stored ||
    stored.source.kind !== attempt.source.kind
  ) return attempt;

  return {
    source: {
      ...stored.source,
      name: attempt.source.name,
      status: "partial",
      updatedAt: stored.lastGoodAt,
      detail: `Using last known good value from ${stored.lastGoodAt}; latest attempt was ${attempt.source.status}`,
      fallback: {
        lastGoodAt: stored.lastGoodAt,
        attemptStatus: attempt.source.status
      }
    },
    holdings: stored.holdings,
    wallets: stored.wallets ?? attempt.wallets,
    errors: attempt.errors
  };
}

function extractDeBankWallets(wallets: LiveWallet[]) {
  return wallets.map((wallet) => {
    const positions = wallet.positions.filter((position) => position.source === "debank");
    return {
      ...wallet,
      valueUsd: wallet.debankValueUsd,
      hyperliquidValueUsd: 0,
      positions,
      protocolCount: new Set(positions.map((position) => `${position.chainId}:${position.protocolId}`)).size
    };
  });
}

function extractHyperliquidWallets(wallets: LiveWallet[]) {
  return wallets.map((wallet) => {
    const positions = wallet.positions.filter((position) => position.source === "hyperliquid");
    return {
      ...wallet,
      valueUsd: wallet.hyperliquidValueUsd,
      debankValueUsd: 0,
      tokens: [],
      tokenCount: 0,
      positions,
      protocolCount: new Set(positions.map((position) => `${position.chainId}:${position.protocolId}`)).size
    };
  });
}

function mergeWalletSources(debankWallets: LiveWallet[], hyperliquidWallets: LiveWallet[]) {
  const hyperliquid = new Map(hyperliquidWallets.map((wallet) => [wallet.id, wallet]));
  const merged = debankWallets.map((wallet) => {
    const matching = hyperliquid.get(wallet.id);
    hyperliquid.delete(wallet.id);
    const positions = [...wallet.positions, ...(matching?.positions ?? [])];
    const hyperliquidValueUsd = matching?.hyperliquidValueUsd ?? 0;
    return {
      ...wallet,
      valueUsd: wallet.debankValueUsd + hyperliquidValueUsd,
      hyperliquidValueUsd,
      positions,
      protocolCount: new Set(
        positions.map((position) => `${position.source}:${position.chainId}:${position.protocolId}`)
      ).size,
      status: wallet.status === "live" || matching?.status === "live" ? "live" as const : "error" as const
    };
  });
  return [...merged, ...hyperliquid.values()].sort((left, right) => right.valueUsd - left.valueUsd);
}

function toSourcePayload(integration: IntegrationResult): PortfolioSourcePayload {
  const wallets = integration.wallets
    ? integration.source.id === "debank"
      ? extractDeBankWallets(integration.wallets)
      : integration.source.id === "hyperliquid"
        ? extractHyperliquidWallets(integration.wallets)
        : integration.wallets
    : undefined;
  return {
    source: integration.source,
    holdings: integration.holdings,
    ...(wallets ? { wallets } : {})
  };
}

function deBankBaselineFromSnapshot(
  snapshot: LivePortfolioSnapshot | null | undefined
): StoredPortfolioSourcePayload | undefined {
  if (!snapshot) return undefined;
  const priorSource = snapshot.sources.find((source) => source.id === "debank");
  if (!priorSource) return undefined;
  const wallets = extractDeBankWallets(snapshot.wallets).filter((wallet) => (
    /^0x[a-fA-F0-9]{40}$/.test(wallet.address) &&
    Number.isFinite(wallet.debankValueUsd) &&
    wallet.debankValueUsd >= 0
  ));
  if (wallets.length === 0) return undefined;

  const holdings = wallets.flatMap((wallet) => {
    const tokens = wallet.tokens.filter((token) => token.source === "debank");
    const positions = wallet.positions.filter((position) => position.source === "debank");
    const protocolValueUsd = positions.reduce((sum, position) => sum + position.valueUsd, 0);
    return buildDeBankWalletHoldings({
      tokens,
      positions,
      protocolValueUsd,
      walletValueUsd: wallet.debankValueUsd
    }).map((holding) => ({ ...holding, accountId: wallet.address }));
  });
  const lastGoodAt = priorSource.fallback?.lastGoodAt ??
    priorSource.valueUpdatedAt ??
    priorSource.updatedAt ??
    snapshot.generatedAt;
  const valueUsd = wallets.reduce((sum, wallet) => sum + wallet.debankValueUsd, 0);
  return {
    lastGoodAt,
    source: {
      ...priorSource,
      status: "live",
      valueUsd,
      itemCount: wallets.length,
      updatedAt: lastGoodAt,
      valueUpdatedAt: lastGoodAt,
      compositionUpdatedAt: priorSource.compositionUpdatedAt ?? lastGoodAt,
      fallback: undefined,
      detail: "Recovered from the latest trusted portfolio snapshot"
    },
    holdings,
    wallets
  };
}

function mergeLatestDeBankMarketBaseline(
  authoritative: StoredPortfolioSourcePayload | undefined,
  snapshot: StoredPortfolioSourcePayload | undefined,
  now: string
) {
  if (!authoritative) return snapshot;
  if (!snapshot) return authoritative;
  const snapshotWallets = new Map((snapshot.wallets ?? []).map((wallet) => [wallet.id, wallet]));
  const wallets = (authoritative.wallets ?? []).map((wallet) => {
    const latest = snapshotWallets.get(wallet.id);
    if (!latest) return wallet;
    const latestTokens = new Map(latest.tokens.map((token) => [token.id, token]));
    const tokens = wallet.tokens.map((token) => {
      const market = latestTokens.get(token.id);
      const marketAgeMs = market?.priceUpdatedAt
        ? Date.parse(now) - Date.parse(market.priceUpdatedAt)
        : Number.POSITIVE_INFINITY;
      if (
        !market ||
        market.priceSource !== "defillama" ||
        market.valuationState === "excluded" ||
        !Number.isFinite(marketAgeMs) ||
        marketAgeMs < 0 ||
        marketAgeMs > acceptedMarketFallbackMaxAgeMs ||
        market.amount !== token.amount
      ) return token;
      return {
        ...token,
        priceUsd: market.priceUsd,
        priceSource: market.priceSource,
        priceState: market.priceState,
        priceUpdatedAt: market.priceUpdatedAt,
        priceConfidence: market.priceConfidence,
        valuationState: market.valuationState,
        valueUsd: market.valueUsd
      };
    });
    return {
      ...wallet,
      tokens,
      priceUpdatedAt: latest.priceUpdatedAt ?? wallet.priceUpdatedAt
    };
  });
  return {
    ...authoritative,
    wallets,
    lastGoodAt: authoritative.lastGoodAt,
    source: {
      ...authoritative.source,
      pricing: snapshot.source.pricing ?? authoritative.source.pricing,
      valueUpdatedAt: authoritative.source.valueUpdatedAt ?? authoritative.lastGoodAt,
      compositionUpdatedAt: authoritative.source.compositionUpdatedAt,
      fallback: undefined
    }
  };
}

export async function getLivePortfolioCandidate(
  options: { mode?: PortfolioSyncMode; baselineSnapshot?: LivePortfolioSnapshot | null } = {}
): Promise<LivePortfolioCandidate> {
  const mode = options.mode ?? "full";
  const now = new Date().toISOString();
  const [storedCex, storedSources] = await Promise.all([
    readLatestCexSnapshots().catch(
      (): Partial<Record<(typeof CEX_EXCHANGES)[number], CexSourceSnapshot>> => ({})
    ),
    readPortfolioSourcePayloads().catch(() => new Map<string, StoredPortfolioSourcePayload>())
  ]);
  const storedDeBank = mergeLatestDeBankMarketBaseline(
    storedSources.get("debank"),
    deBankBaselineFromSnapshot(options.baselineSnapshot),
    now
  );
  const debankScanKind = mode === "full"
    ? "full"
    : mode === "valuation" && storedDeBank ? "total-balance" : "none";
  const rawDeBankAttempt = debankScanKind === "full"
    ? await fetchDeBank(now)
    : debankScanKind === "total-balance"
      ? await fetchDeBankValuation(now, storedDeBank!)
      : storedDeBankIntegration(storedDeBank, now);
  // A balance scan cannot establish completion of an off-chain withdrawal.
  // Keep explicitly recorded pending operations until the operator updates them.
  if (debankScanKind === "full" && rawDeBankAttempt.wallets) {
    const priorWallets = new Map((storedDeBank?.wallets ?? []).map((wallet) => [wallet.id, wallet]));
    rawDeBankAttempt.wallets = rawDeBankAttempt.wallets.map((wallet) => ({
      ...wallet,
      ...(priorWallets.get(wallet.id)?.pendingMovements
        ? { pendingMovements: priorWallets.get(wallet.id)!.pendingMovements }
        : {})
    }));
  }
  const selectedDeBank = mode !== "current"
    ? withSourceFallback(rawDeBankAttempt, storedDeBank)
    : rawDeBankAttempt;
  const debank = await repriceDeBankIntegration(selectedDeBank, now);
  const persistedDeBankAttempt = selectedDeBank === rawDeBankAttempt
    ? debank
    : rawDeBankAttempt;
  const debankWallets = extractDeBankWallets(debank.wallets || []);
  const hyperliquidWallets = selectHyperliquidWallets(
    debankWallets,
    storedSources.get("hyperliquid"),
    mode
  );
  const hyperliquidAttempt = await fetchHyperliquid(
    now,
    structuredClone(hyperliquidWallets),
    mode,
    debankWallets.length
  );
  const hyperliquid = withSourceFallback(hyperliquidAttempt, storedSources.get("hyperliquid"));
  const banks = getBankPreview(now);
  const cexAttempts = CEX_EXCHANGES.map((exchange) => storedCex[exchange])
    .filter((snapshot): snapshot is CexSourceSnapshot => Boolean(snapshot))
    .map((snapshot) => cexSnapshotToIntegration(withCexFreshness(snapshot)));
  const missingCex = CEX_EXCHANGES
    .filter((exchange) => !storedCex[exchange])
    .map<IntegrationResult>((exchange) => ({
      source: {
        id: exchange,
        name: getCexExchangeName(exchange),
        kind: "exchange",
        status: "error",
        valueUsd: 0,
        itemCount: 0,
        updatedAt: now,
        detail: "No successful snapshot"
      },
      holdings: [],
      errors: [{ source: exchange, message: "No successful CEX snapshot is available" }]
    }));
  const cexAttemptsById = new Map(
    [...cexAttempts, ...missingCex].map((integration) => [integration.source.id, integration])
  );
  const orderedCexAttempts = CEX_EXCHANGES.map((exchange) => cexAttemptsById.get(exchange)!);
  const cex = orderedCexAttempts.map((integration) => (
    withSourceFallback(integration, storedSources.get(integration.source.id))
  ));
  const integrations = [debank, hyperliquid, ...cex, banks].map((integration) => ({
    ...integration,
    source: enrichSourceMetadata(integration.source, now)
  }));
  // Current sync reuses the daily DeBank payload. Omitting it from attempt
  // persistence avoids inventing a DeBank attempt every 15 minutes.
  const attempts = [
    ...(mode !== "current" ? [persistedDeBankAttempt] : []),
    hyperliquidAttempt,
    ...orderedCexAttempts,
    banks
  ];
  const holdingMap = new Map<string, HoldingAccumulator>();

  for (const integration of integrations) {
    for (const holding of integration.holdings) {
      addHolding(holdingMap, {
        ...holding,
        source: integration.source.name
      });
    }
  }

  const holdings: LiveHolding[] = [...holdingMap.values()]
    .map((holding) => ({
      symbol: holding.symbol,
      name: holding.name,
      amount: holding.amount,
      valueUsd: holding.valueUsd,
      sources: [...holding.sources],
      accountCount: holding.accounts.size,
      ...(holding.assetClass ? { assetClass: holding.assetClass } : {}),
      ...(holding.exposureSymbol ? { exposureSymbol: holding.exposureSymbol } : {}),
      ...(holding.priceSource ? { priceSource: holding.priceSource } : {}),
      ...(holding.valuationState ? { valuationState: holding.valuationState } : {}),
      ...(holding.amount ? { priceUsd: holding.valueUsd / holding.amount } : {})
    }))
    .filter((holding) => Math.abs(holding.valueUsd) >= 0.01)
    .sort((a, b) => b.valueUsd - a.valueUsd);

  const exchangesUsd = cex.reduce((sum, integration) => sum + integration.source.valueUsd, 0);
  const walletsUsd = debank.source.valueUsd + hyperliquid.source.valueUsd;
  const banksUsd = banks.source.valueUsd;
  const liveValueUsd = exchangesUsd + walletsUsd;
  const previewValueUsd = banksUsd;
  const liveSources = integrations
    .filter((integration) => integration.source.kind !== "bank")
    .map((integration) => integration.source);
  const wallets = mergeWalletSources(
    extractDeBankWallets(debank.wallets || []),
    extractHyperliquidWallets(hyperliquid.wallets || [])
  );
  const hasCompleteValuationBasis = ["binance", "okx"].every((sourceId) => (
    cex.find((integration) => integration.source.id === sourceId)?.source.pricingBasis === VALUATION_BASIS
  ));

  return {
    snapshot: {
      generatedAt: now,
      ...(hasCompleteValuationBasis
        ? { valuationBasis: VALUATION_BASIS } : {}),
      netWorthUsd: liveValueUsd + previewValueUsd,
      liveValueUsd,
      previewValueUsd,
      groups: { exchangesUsd, walletsUsd, banksUsd },
      sources: integrations.map((integration) => integration.source),
      holdings,
      wallets,
      connectedSourceCount: liveSources.filter((source) => source.status === "live" || source.status === "partial").length,
      expectedSourceCount: liveSources.length,
      isPartial: liveSources.some((source) => source.status === "error" || source.status === "partial"),
      errors: integrations.flatMap((integration) => integration.errors)
    },
    sourcePayloads: attempts.map(toSourcePayload),
    providerUsage: {
      debank: {
        scanAttempted: debankScanKind !== "none",
        requestCount: debankScanKind !== "none" ? rawDeBankAttempt.usage?.requestCount ?? 0 : 0,
        scanKind: debankScanKind,
        estimatedUnits: debankScanKind === "total-balance"
          ? (rawDeBankAttempt.usage?.requestCount ?? 0) * 30
          : debankScanKind === "full" ? 1_109 : 0
      }
    }
  };
}

export async function getLivePortfolioSnapshot(): Promise<LivePortfolioSnapshot> {
  return (await getLivePortfolioCandidate()).snapshot;
}
