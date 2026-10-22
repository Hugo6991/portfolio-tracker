import "server-only";
import { assetAllocationOrder, buildCryptoAssetAllocation } from "@/lib/asset-allocation";
import type { AssetHistoryPoint, AssetHistoryResponse } from "@/lib/asset-history";
import { CEX_EXCHANGES, type CexExchange, type CexHolding, type CexHistoryResponse, type CexPublicResponse, type CexSourceSnapshot, CEX_STALE_AFTER_SECONDS } from "@/lib/cex";
import type { ExpenseCategory, ExpenseSourceName, NormalizedExpense } from "@/lib/expense-records";
import type { FxRateSnapshot } from "@/lib/fx";
import type { LiveHolding, LivePortfolioSnapshot, LiveSource, LiveWallet, LiveWalletAssetState, LiveWalletPosition, LiveWalletToken } from "@/lib/live-portfolio";
import type { PortfolioHistoryInterval, PortfolioHistoryPoint, PortfolioHistoryResponse } from "@/lib/portfolio-history";
import type { TradingDashboardSnapshot } from "@/lib/trading-dashboard";
import { VALUATION_BASIS } from "@/lib/valuation-basis";
import type { WalletHistoryResponse } from "@/lib/wallet-history";

/**
 * Synthetic data for demo mode. Every number here is invented: no balance, address,
 * account label or exchange account below belongs to a real person. Keep it that way.
 * Totals are small on purpose so nobody mistakes the demo for a real portfolio.
 */

const DAY = 86_400_000;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const demoAddress = (n: number) => `0x${"0".repeat(36)}${n.toString(16).padStart(4, "0")}`;

// A deterministic walk that ends exactly at today's value. Several frequencies layered
// so the line reads like a market, not a sine wave. daysAgo can be fractional (hourly).
function walk(daysAgo: number, current: number, amplitude: number) {
  const shape = (d: number) =>
    amplitude * (0.5 * Math.sin(d / 11) + 0.25 * Math.sin(d / 4.3 + 1) + 0.12 * Math.sin(d / 1.7 + 2) + 0.06 * Math.sin(d * 2.9) + 0.03 * Math.sin(d * 17)) -
    d * (amplitude / 45);
  return Math.round(current + shape(daysAgo) - shape(0));
}

function now() {
  return new Date();
}

const EXCHANGE_LABEL: Record<CexExchange, string> = {
  binance: "Exchange A",
  okx: "Exchange B",
  bitget: "Exchange C",
  htx: "Exchange D",
  gate: "Exchange E"
};

type DemoCexRow = {
  exchange: CexExchange;
  accountType: string;
  symbol: string;
  name: string;
  amount: number;
  priceUsd: number;
  exposureSymbol?: string;
};

// The same coin sits on several venues on purpose: the demo shows why one total is needed.
const CEX_ROWS: DemoCexRow[] = [
  { exchange: "binance", accountType: "Spot", symbol: "USDT", name: "Tether", amount: 4_000, priceUsd: 1 },
  { exchange: "binance", accountType: "Spot", symbol: "BTC", name: "Bitcoin", amount: 0.12, priceUsd: 64_000 },
  { exchange: "binance", accountType: "Spot", symbol: "BNB", name: "BNB", amount: 3, priceUsd: 600 },
  { exchange: "binance", accountType: "Stocks", symbol: "EQ_TSLA", name: "Tesla", amount: 5, priceUsd: 430, exposureSymbol: "TSLA" },
  { exchange: "binance", accountType: "Stocks", symbol: "EQ_SPCX", name: "SpaceX", amount: 8, priceUsd: 185, exposureSymbol: "SPCX" },
  { exchange: "okx", accountType: "Funding", symbol: "ETH", name: "Ethereum", amount: 1.2, priceUsd: 3_000 },
  { exchange: "okx", accountType: "Earn", symbol: "USDC", name: "USD Coin", amount: 5_000, priceUsd: 1 },
  { exchange: "okx", accountType: "Spot", symbol: "SOL", name: "Solana", amount: 20, priceUsd: 150 },
  { exchange: "okx", accountType: "Spot", symbol: "UNI", name: "Uniswap", amount: 250, priceUsd: 8 },
  { exchange: "bitget", accountType: "Spot", symbol: "USDT", name: "Tether", amount: 1_500, priceUsd: 1 },
  { exchange: "bitget", accountType: "Spot", symbol: "SUI", name: "Sui", amount: 800, priceUsd: 2.5 },
  { exchange: "bitget", accountType: "Stocks", symbol: "EQ_TSLA", name: "Tesla", amount: 2, priceUsd: 430, exposureSymbol: "TSLA" },
  { exchange: "htx", accountType: "Spot", symbol: "BTC", name: "Bitcoin", amount: 0.02, priceUsd: 64_000 },
  { exchange: "htx", accountType: "Spot", symbol: "AVAX", name: "Avalanche", amount: 40, priceUsd: 25 },
  { exchange: "gate", accountType: "Spot", symbol: "USDT", name: "Tether", amount: 600, priceUsd: 1 },
  { exchange: "gate", accountType: "Spot", symbol: "LINK", name: "Chainlink", amount: 60, priceUsd: 15 }
];

type DemoWalletKey = "main" | "cold" | "defi" | "arbitrum" | "hot";
type DemoToken = { symbol: string; name: string; chainId: string; chainName: string; amount: number; priceUsd: number; state?: LiveWalletAssetState };

const CHAIN = {
  eth: { chainId: "eth", chainName: "Ethereum" },
  base: { chainId: "base", chainName: "Base" },
  arb: { chainId: "arb", chainName: "Arbitrum" },
  bsc: { chainId: "bsc", chainName: "BNB Chain" },
  hyper: { chainId: "hyper", chainName: "HyperEVM" }
} as const;

// Ten liquid coins across five wallets, all from the top 100 by market cap.
const WALLET_TOKENS: Array<DemoToken & { wallet: DemoWalletKey }> = [
  { wallet: "main", symbol: "ETH", name: "Ethereum", ...CHAIN.eth, amount: 1, priceUsd: 3_000 },
  { wallet: "main", symbol: "USDC", name: "USD Coin", ...CHAIN.base, amount: 2_000, priceUsd: 1 },
  { wallet: "main", symbol: "UNI", name: "Uniswap", ...CHAIN.eth, amount: 300, priceUsd: 8 },
  { wallet: "cold", symbol: "BTC", name: "Wrapped Bitcoin", ...CHAIN.eth, amount: 0.08, priceUsd: 64_000 },
  { wallet: "cold", symbol: "ETH", name: "Ethereum", ...CHAIN.eth, amount: 1.5, priceUsd: 3_000 },
  { wallet: "cold", symbol: "AAVE", name: "Aave", ...CHAIN.eth, amount: 10, priceUsd: 160 },
  { wallet: "defi", symbol: "LINK", name: "Chainlink", ...CHAIN.eth, amount: 40, priceUsd: 15 },
  { wallet: "arbitrum", symbol: "ARB", name: "Arbitrum", ...CHAIN.arb, amount: 3_000, priceUsd: 0.5 },
  { wallet: "arbitrum", symbol: "USDT", name: "Tether", ...CHAIN.arb, amount: 1_200, priceUsd: 1 },
  { wallet: "arbitrum", symbol: "ETH", name: "Ethereum", ...CHAIN.arb, amount: 0.4, priceUsd: 3_000 },
  { wallet: "hot", symbol: "BNB", name: "BNB", ...CHAIN.bsc, amount: 2, priceUsd: 600 },
  { wallet: "hot", symbol: "USDT", name: "Tether", ...CHAIN.bsc, amount: 800, priceUsd: 1 },
  { wallet: "hot", symbol: "HYPE", name: "Hyperliquid", ...CHAIN.hyper, amount: 40, priceUsd: 30 }
];

const ICON_BASE = "https://raw.githubusercontent.com/0xa3k5/web3icons/3fa8ef5e17a1a213058a047e862499f00fc0dc81/raw-svgs/tokens/branded";

// Lending and vault deposits. Borrowed tokens count against the position.
const WALLET_POSITIONS: Array<{
  wallet: DemoWalletKey;
  source?: "debank" | "hyperliquid";
  protocolId: string;
  protocolName: string;
  protocolIconUrl: string | null;
  protocolUrl: string;
  chain: (typeof CHAIN)[keyof typeof CHAIN];
  name: string;
  tokens: DemoToken[];
}> = [
  {
    wallet: "main", protocolId: "aave3", protocolName: "Aave V3", protocolIconUrl: `${ICON_BASE}/AAVE.svg`, protocolUrl: "https://app.aave.com",
    chain: CHAIN.eth, name: "Lending",
    tokens: [
      { symbol: "USDC", name: "USD Coin", ...CHAIN.eth, amount: 5_000, priceUsd: 1, state: "supplied" },
      { symbol: "ETH", name: "Ethereum", ...CHAIN.eth, amount: 1, priceUsd: 3_000, state: "supplied" },
      { symbol: "USDT", name: "Tether", ...CHAIN.eth, amount: 1_500, priceUsd: 1, state: "borrowed" }
    ]
  },
  {
    wallet: "defi", protocolId: "morpho", protocolName: "Morpho", protocolIconUrl: null, protocolUrl: "https://app.morpho.org",
    chain: CHAIN.base, name: "Steakhouse USDC vault",
    tokens: [{ symbol: "USDC", name: "USD Coin", ...CHAIN.base, amount: 6_000, priceUsd: 1, state: "vault" }]
  },
  {
    wallet: "defi", protocolId: "morpho", protocolName: "Morpho", protocolIconUrl: null, protocolUrl: "https://app.morpho.org",
    chain: CHAIN.eth, name: "Gauntlet WETH vault",
    tokens: [{ symbol: "ETH", name: "Ethereum", ...CHAIN.eth, amount: 0.8, priceUsd: 3_000, state: "vault" }]
  },
  {
    wallet: "defi", protocolId: "uniswap3", protocolName: "Uniswap V3", protocolIconUrl: `${ICON_BASE}/UNI.svg`, protocolUrl: "https://app.uniswap.org",
    chain: CHAIN.arb, name: "ETH/USDC liquidity",
    tokens: [
      { symbol: "ETH", name: "Ethereum", ...CHAIN.arb, amount: 0.3, priceUsd: 3_000, state: "liquid" },
      { symbol: "USDC", name: "USD Coin", ...CHAIN.arb, amount: 900, priceUsd: 1, state: "liquid" }
    ]
  },
  {
    wallet: "hot", source: "hyperliquid", protocolId: "hyperliquid", protocolName: "Hyperliquid", protocolIconUrl: "/brand/web3icons/shared/hyper-evm.svg",
    protocolUrl: "https://app.hyperliquid.xyz", chain: CHAIN.hyper, name: "Staking",
    tokens: [{ symbol: "HYPE", name: "Hyperliquid", ...CHAIN.hyper, amount: 50, priceUsd: 30, state: "staked" }]
  },
  {
    wallet: "hot", source: "hyperliquid", protocolId: "hyperliquid", protocolName: "Hyperliquid", protocolIconUrl: "/brand/web3icons/shared/hyper-evm.svg",
    protocolUrl: "https://app.hyperliquid.xyz", chain: CHAIN.hyper, name: "HLP vault",
    tokens: [{ symbol: "USDC", name: "USD Coin", ...CHAIN.hyper, amount: 1_000, priceUsd: 1, state: "vault" }]
  }
];

const WALLET_META: Record<DemoWalletKey, { id: string; name: string; address: string }> = {
  main: { id: "demo-wallet-main", name: "Main wallet", address: demoAddress(1) },
  cold: { id: "demo-wallet-cold", name: "Cold wallet", address: demoAddress(2) },
  defi: { id: "demo-wallet-defi", name: "DeFi wallet", address: demoAddress(3) },
  arbitrum: { id: "demo-wallet-arbitrum", name: "Arbitrum wallet", address: demoAddress(4) },
  hot: { id: "demo-wallet-hot", name: "Hot wallet", address: demoAddress(5) }
};

const BANKS_USD = 8_000;

function cexSnapshots(at: Date): CexSourceSnapshot[] {
  const stamp = at.toISOString();
  return CEX_EXCHANGES.map((exchange) => {
    const holdings: CexHolding[] = CEX_ROWS.filter((r) => r.exchange === exchange).map((r) => ({
      exchange,
      accountType: r.accountType,
      symbol: r.symbol,
      name: r.name,
      amount: r.amount,
      valueUsd: Math.round(r.amount * r.priceUsd),
      priceUsd: r.priceUsd,
      priceSource: "demo",
      valuationState: "priced",
      ...(r.exposureSymbol ? { assetClass: "equity" as const, exposureSymbol: r.exposureSymbol } : { assetClass: "crypto" as const })
    }));
    const valueUsd = holdings.reduce((s, h) => s + (h.valueUsd ?? 0), 0);
    return {
      pricingBasis: VALUATION_BASIS,
      valuation: { priced: holdings.length, excluded: 0, unpriced: 0 },
      exchange,
      name: EXCHANGE_LABEL[exchange],
      status: holdings.length ? "live" : "live",
      capturedAt: stamp,
      bucketAt: stamp,
      valueUsd,
      itemCount: holdings.length,
      accounts: holdings.length
        ? [{ id: `demo-${exchange}`, name: `${EXCHANGE_LABEL[exchange]} account`, status: "live", valueUsd, itemCount: holdings.length, holdings }]
        : [],
      holdings,
      errors: []
    };
  });
}

function walletToken(id: string, t: DemoToken, stamp: string, protocol?: { id: string; name: string; source?: "debank" | "hyperliquid" }): LiveWalletToken {
  return {
    id,
    source: protocol?.source ?? "debank",
    symbol: t.symbol,
    name: t.name,
    chainId: t.chainId,
    chainName: t.chainName,
    protocolId: protocol?.id ?? null,
    protocolName: protocol?.name ?? null,
    iconUrl: null,
    contractAddress: ZERO_ADDRESS,
    verificationState: "verified",
    valuationState: "priced",
    amount: t.amount,
    priceUsd: t.priceUsd,
    priceSource: "defillama",
    priceState: "fresh",
    priceUpdatedAt: stamp,
    valueUsd: Math.round(t.amount * t.priceUsd),
    state: t.state ?? "liquid",
    assetClass: "crypto"
  };
}

function wallets(at: Date): LiveWallet[] {
  const stamp = at.toISOString();
  return (Object.keys(WALLET_META) as DemoWalletKey[]).map((key) => {
    const meta = WALLET_META[key];
    const tokens = WALLET_TOKENS.filter((t) => t.wallet === key).map((t, i) => walletToken(`${meta.id}-${i}`, t, stamp));
    const positions: LiveWalletPosition[] = WALLET_POSITIONS.filter((p) => p.wallet === key).map((p, i) => {
      const nested = p.tokens.map((t, j) => walletToken(`${meta.id}-p${i}-${j}`, t, stamp, { id: p.protocolId, name: p.protocolName, source: p.source }));
      const assetValueUsd = nested.filter((t) => t.state !== "borrowed").reduce((s, t) => s + t.valueUsd, 0);
      const debtValueUsd = nested.filter((t) => t.state === "borrowed").reduce((s, t) => s + t.valueUsd, 0);
      return {
        id: `${meta.id}-p${i}`,
        source: p.source ?? "debank",
        protocolId: p.protocolId,
        protocolName: p.protocolName,
        protocolIconUrl: p.protocolIconUrl,
        protocolUrl: p.protocolUrl,
        chainId: p.chain.chainId,
        chainName: p.chain.chainName,
        name: p.name,
        state: nested[0]?.state ?? "unknown",
        valueUsd: assetValueUsd - debtValueUsd,
        assetValueUsd,
        debtValueUsd,
        unlockAt: null,
        tokens: nested
      };
    });
    const hyperliquidValueUsd = positions.filter((p) => p.source === "hyperliquid").reduce((s, p) => s + p.valueUsd, 0);
    const debankValueUsd = tokens.reduce((s, t) => s + t.valueUsd, 0) + positions.filter((p) => p.source === "debank").reduce((s, p) => s + p.valueUsd, 0);
    const valueUsd = debankValueUsd + hyperliquidValueUsd;
    return {
      id: meta.id,
      name: meta.name,
      address: meta.address,
      debankUrl: `https://debank.com/profile/${meta.address}`,
      valueUsd,
      debankValueUsd,
      hyperliquidValueUsd,
      tokenCount: tokens.length,
      protocolCount: new Set(positions.map((p) => `${p.chainId}:${p.protocolId}`)).size,
      tokens,
      positions,
      status: "live",
      updatedAt: stamp,
      compositionUpdatedAt: stamp,
      priceUpdatedAt: stamp
    };
  });
}

function holdings(cex: CexSourceSnapshot[], ws: LiveWallet[]): LiveHolding[] {
  const map = new Map<string, LiveHolding>();
  const add = (h: { symbol: string; name: string; amount: number; valueUsd: number; priceUsd: number; assetClass?: "crypto" | "equity"; exposureSymbol?: string }, source: string) => {
    const row = map.get(h.symbol) ?? {
      symbol: h.symbol, name: h.name, amount: 0, valueUsd: 0, sources: [], accountCount: 0, priceUsd: h.priceUsd, valuationState: "priced",
      assetClass: h.assetClass ?? "crypto", ...(h.exposureSymbol ? { exposureSymbol: h.exposureSymbol } : {})
    };
    row.amount = (row.amount ?? 0) + h.amount;
    row.valueUsd += h.valueUsd;
    if (!row.sources.includes(source)) {
      row.sources.push(source);
      row.accountCount += 1;
    }
    map.set(h.symbol, row);
  };
  for (const s of cex) {
    for (const h of s.holdings) {
      add({ symbol: h.symbol, name: h.name ?? h.symbol, amount: h.amount ?? 0, valueUsd: h.valueUsd ?? 0, priceUsd: h.priceUsd ?? 0, assetClass: h.assetClass, exposureSymbol: h.exposureSymbol }, s.name);
    }
  }
  for (const w of ws) {
    const nested = w.positions.flatMap((p) => p.tokens.map((t) => {
      const sign = t.state === "borrowed" ? -1 : 1;
      return { ...t, amount: (t.amount ?? 0) * sign, valueUsd: t.valueUsd * sign };
    }));
    for (const t of [...w.tokens, ...nested]) add({ symbol: t.symbol, name: t.name, amount: t.amount ?? 0, valueUsd: t.valueUsd, priceUsd: t.priceUsd ?? 0 }, w.name);
  }
  map.set("USD", { symbol: "USD", name: "Bank cash", amount: BANKS_USD, valueUsd: BANKS_USD, sources: ["Bank A", "Bank B"], accountCount: 2, priceUsd: 1, valuationState: "priced" });
  return [...map.values()].sort((a, b) => b.valueUsd - a.valueUsd);
}

export function demoPortfolioSnapshot(at = now()): LivePortfolioSnapshot {
  const stamp = at.toISOString();
  const cex = cexSnapshots(at);
  const ws = wallets(at);
  const exchangesUsd = cex.reduce((s, c) => s + c.valueUsd, 0);
  const walletsUsd = ws.reduce((s, w) => s + w.valueUsd, 0);
  const sources: LiveSource[] = [
    ...cex.filter((c) => c.itemCount > 0).map<LiveSource>((c) => ({
      id: c.exchange, name: c.name, kind: "exchange", status: "live", valueUsd: c.valueUsd, itemCount: c.itemCount,
      updatedAt: stamp, detail: "Synthetic demo fixture", cadence: "15m", freshnessState: "fresh", valueUpdatedAt: stamp
    })),
    { id: "debank", name: "Wallets", kind: "wallet", status: "live", valueUsd: walletsUsd, itemCount: ws.length, updatedAt: stamp, detail: "Synthetic demo fixture", cadence: "daily", freshnessState: "fresh" },
    { id: "bank-preview", name: "Banks", kind: "bank", status: "preview", valueUsd: BANKS_USD, itemCount: 2, updatedAt: stamp, detail: "Synthetic demo fixture", cadence: "manual" }
  ];
  return {
    valuationBasis: VALUATION_BASIS,
    generatedAt: stamp,
    delivery: { mode: "cache", persisted: true, cacheAgeSeconds: 45, cacheTtlSeconds: 1_200, latestAttempt: null },
    netWorthUsd: exchangesUsd + walletsUsd + BANKS_USD,
    liveValueUsd: exchangesUsd + walletsUsd,
    previewValueUsd: BANKS_USD,
    groups: { exchangesUsd, walletsUsd, banksUsd: BANKS_USD },
    sources,
    holdings: holdings(cex, ws),
    wallets: ws,
    connectedSourceCount: sources.length,
    expectedSourceCount: sources.length,
    isPartial: false,
    errors: []
  };
}

export function demoCexResponse(at = now()): CexPublicResponse {
  const sources = cexSnapshots(at);
  return {
    generatedAt: at.toISOString(),
    staleAfterSeconds: CEX_STALE_AFTER_SECONDS,
    totalUsd: sources.reduce((s, c) => s + c.valueUsd, 0),
    sources,
    holdings: sources.flatMap((s) => s.holdings)
  };
}

export function demoFx(at = now()): FxRateSnapshot {
  return { base: "USD", quote: "TWD", rate: 32, cnyPerUsd: 7.2, fetchedAt: at.toISOString(), source: "Seed data", status: "seed" };
}

function dailyPoints(days: number, at: Date, stepMs = DAY): PortfolioHistoryPoint[] {
  const snapshot = demoPortfolioSnapshot(at);
  const out: PortfolioHistoryPoint[] = [];
  const exchangeShare = snapshot.groups.exchangesUsd / snapshot.netWorthUsd;
  const walletShare = snapshot.groups.walletsUsd / snapshot.netWorthUsd;
  for (let i = days - 1; i >= 0; i--) {
    const capturedAt = new Date(at.getTime() - i * stepMs);
    const netWorthUsd = walk((i * stepMs) / DAY, snapshot.netWorthUsd, snapshot.netWorthUsd * 0.035);
    const prev = out.at(-1);
    const exchangesUsd = Math.round(netWorthUsd * exchangeShare);
    const walletsUsd = Math.round(netWorthUsd * walletShare);
    out.push({
      date: capturedAt.toISOString().slice(0, 10),
      capturedAt: capturedAt.toISOString(),
      netWorthUsd,
      exchangesUsd: i === 0 ? snapshot.groups.exchangesUsd : exchangesUsd,
      walletsUsd: i === 0 ? snapshot.groups.walletsUsd : walletsUsd,
      banksUsd: i === 0 ? snapshot.groups.banksUsd : netWorthUsd - exchangesUsd - walletsUsd,
      sourceCount: snapshot.sources.length,
      isPartial: false,
      deltaUsd: prev ? netWorthUsd - prev.netWorthUsd : null,
      deltaPercent: prev ? Math.round(((netWorthUsd - prev.netWorthUsd) / prev.netWorthUsd) * 10_000) / 100 : null
    });
  }
  return out;
}

export function demoPortfolioHistory(interval: PortfolioHistoryInterval, days: number, at = now()): PortfolioHistoryResponse {
  const points = interval === "hourly"
    ? dailyPoints(Math.min(days, 7) * 24, at, 3_600_000)
    : dailyPoints(days, at);
  const last = points.at(-1)!;
  return {
    configured: true,
    interval,
    points,
    latestReport: {
      date: last.date,
      generatedAt: at.toISOString(),
      summary: "Demo data. Every balance on this page is synthetic, so this brief only shows what a daily report looks like.",
      alerts: [],
      currentUsd: last.netWorthUsd,
      deltaUsd: last.deltaUsd,
      deltaPercent: last.deltaPercent,
      generator: "rules",
      model: null
    },
    latestObservation: { capturedAt: at.toISOString(), quality: "complete", hasPerformanceGap: false, staleSourceIds: [] }
  };
}

export function demoAssetHistory(days: number, at = now()): AssetHistoryResponse {
  const allocation = buildCryptoAssetAllocation(demoPortfolioSnapshot(at).holdings);
  const shares = assetAllocationOrder.map((id) => [id, (allocation.groups.find((g) => g.id === id)?.valueUsd ?? 0) / allocation.totalUsd] as const);
  const points: AssetHistoryPoint[] = dailyPoints(days, at).map((p) => {
    const live = p.exchangesUsd + p.walletsUsd;
    const valuesUsd = Object.fromEntries(shares.map(([id, share]) => [id, Math.round(live * share)])) as AssetHistoryPoint["valuesUsd"];
    valuesUsd.other += live - Object.values(valuesUsd).reduce((s, v) => s + v, 0);
    return {
      date: p.date,
      capturedAt: p.capturedAt,
      totalLiveCryptoUsd: live,
      totalInvestableUsd: live,
      valuesUsd,
      sourceQuality: "complete",
      breakdownQuality: "complete",
      classifiedValueUsd: live,
      unclassifiedUsd: 0,
      classificationCoveragePercent: 100,
      isPartial: false
    };
  });
  return { configured: true, points };
}

export function demoWalletHistory(days = 90, at = now()): WalletHistoryResponse {
  const ws = wallets(at);
  const walletTotal = ws.reduce((s, w) => s + w.valueUsd, 0);
  const base = dailyPoints(days, at);
  return {
    configured: true,
    overview: base.map((p) => ({ date: p.date, capturedAt: p.capturedAt, valueUsd: p.walletsUsd, quality: "complete", isPartial: false })),
    wallets: ws.map((w) => ({
      walletId: w.id,
      points: base.map((p) => ({ date: p.date, capturedAt: p.capturedAt, isTracked: true, valueUsd: Math.round(p.walletsUsd * (w.valueUsd / walletTotal)), quality: "complete" }))
    }))
  };
}

export function demoCexHistory(days: number, intervalMinutes: number, at = now()): CexHistoryResponse {
  const sources = cexSnapshots(at).filter((s) => s.itemCount > 0);
  const step = Math.max(15, intervalMinutes) * 60_000;
  const count = Math.min(400, Math.round((Math.min(30, days) * DAY) / step));
  const points: CexHistoryResponse["points"] = [];
  for (let i = count - 1; i >= 0; i--) {
    const t = new Date(at.getTime() - i * step).toISOString();
    for (const s of sources) {
      points.push({ exchange: s.exchange, bucket_at: t, captured_at: t, total_usd: walk((i * step) / DAY, s.valueUsd, s.valueUsd * 0.03), status: "live" });
    }
  }
  return { points };
}

export function demoTrading(at = now()): TradingDashboardSnapshot {
  const stamp = at.toISOString();
  const addr = demoAddress(9);
  return {
    schemaVersion: "1.1",
    generatedAt: stamp,
    stage: "canary",
    mode: "paused",
    privacy: { publicReadOnly: true, containsSecrets: false },
    chain: { chainId: 4663, status: "healthy", primaryBlock: "1000000", secondaryBlock: "1000000", blockDelta: "0", maximumBlockDelta: "10" },
    wallet: { alias: "Demo canary", address: addr, explorerUrl: `https://example.invalid/address/${addr}`, usdgBalance: 101.2, wethBalance: 0, ethGasBalance: 0.01 },
    performance: { initialCapitalUsdg: 100, currentUsdg: 101.2, realizedGrossPnlUsdg: 1.2, confirmedExecutionGasEth: 0.0004, netPnlUsdg: null, netPnlReason: "ETH_GAS_NOT_CONVERTED_TO_USDG" },
    progress: { completedRoundTrips: 2, maximumRoundTrips: 5, confirmedOrders: 4, pendingOrders: 0, openPositions: 0 },
    equityCurve: [
      { cycleNumber: 1, occurredAt: new Date(at.getTime() - 3 * DAY).toISOString(), realizedGrossPnlUsdg: 0.7, cumulativeGrossPnlUsdg: 0.7 },
      { cycleNumber: 2, occurredAt: new Date(at.getTime() - DAY).toISOString(), realizedGrossPnlUsdg: 0.5, cumulativeGrossPnlUsdg: 1.2 }
    ],
    trades: [1, 2].map((n) => ({
      cycleNumber: n,
      status: "closed",
      tokenSymbol: n === 1 ? "UNI" : "LINK",
      tokenAddress: ZERO_ADDRESS,
      entryUsdg: 20,
      exitUsdg: n === 1 ? 20.7 : 20.5,
      realizedGrossPnlUsdg: n === 1 ? 0.7 : 0.5,
      confirmedExecutionGasEth: 0.0002,
      openedAt: new Date(at.getTime() - (4 - n) * DAY).toISOString(),
      closedAt: new Date(at.getTime() - (3 - n) * DAY).toISOString(),
      entryTxHash: null,
      entryExplorerUrl: null,
      exitTxHash: null,
      exitExplorerUrl: null,
      exitReasonCodes: ["DEMO"]
    })),
    decision: { executionMode: "execution-canary", strategyPipeline: "not-connected", positionState: "NONE", reasonCodes: ["DEMO_MODE"] },
    walletCandidates: []
  };
}

export function demoHealth(at = now()) {
  const snapshot = demoPortfolioSnapshot(at);
  const stamp = at.toISOString();
  return {
    generatedAt: stamp,
    compositionUpdatedAt: stamp,
    sources: snapshot.sources.map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.kind,
      status: source.status,
      cadence: source.cadence ?? "manual",
      freshnessState: "fresh",
      valueUpdatedAt: stamp,
      compositionUpdatedAt: stamp,
      ageSeconds: 45,
      detail: "Synthetic demo fixture"
    })),
    sync: { status: "idle", lastRunAt: stamp, lastSuccessAt: stamp, nextRunAt: new Date(at.getTime() + 900_000).toISOString(), note: "Demo mode never calls a provider" },
    debankBudget: {
      month: stamp.slice(0, 7), scanCount: 0, valuationScanCount: 0, fullScanCount: 0, providerRequestCount: 0, estimatedUnitsUsed: 0,
      totalBalanceUnitsPerWallet: 0, valuationWalletsPerDay: 0, walletCoverageDays: 0, dailyValuationUnits: 0, estimatedFullScanUnits: 0,
      projectedUnits: 0, projectedCostUsd: 0, projectedAnnualUnits: 0, standardPackageLifetimeYears: 0, monthlyWarningUnits: 5_000,
      monthlyHardStopUnits: 10_000, withinBudget: true, warning: false
    }
  };
}

type DemoExpense = [date: string, merchant: string, category: ExpenseCategory, amount: number, currency: "TWD" | "CNY" | "USD", source: ExpenseSourceName];

// One month of spending pulled from five places, the way it arrives in real life.
const DEMO_EXPENSES: DemoExpense[] = [
  ["2026-10-01", "Taipower electricity bill", "living", 1_860, "TWD", "Bank CSV"],
  ["2026-10-02", "Rent transfer", "living", 22_000, "TWD", "Bank CSV"],
  ["2026-10-03", "MRT top up", "traffic", 500, "TWD", "Money Book CSV"],
  ["2026-10-04", "Family Mart", "food", 128, "TWD", "Money Book CSV"],
  ["2026-10-05", "Hema Fresh", "food", 186, "CNY", "Alipay CSV"],
  ["2026-10-05", "Didi ride", "traffic", 42, "CNY", "Alipay CSV"],
  ["2026-10-06", "Luckin Coffee", "food", 19, "CNY", "WeChat Pay CSV"],
  ["2026-10-07", "Ramen dinner", "food", 420, "TWD", "Receipt capture"],
  ["2026-10-08", "Cloud hosting", "subscription", 20, "USD", "Bank CSV"],
  ["2026-10-09", "AI assistant plan", "subscription", 20, "USD", "Bank CSV"],
  ["2026-10-10", "Gym membership", "fitness", 1_388, "TWD", "Money Book CSV"],
  ["2026-10-11", "Pharmacy", "health", 350, "TWD", "Receipt capture"],
  ["2026-10-12", "Taobao order", "shopping", 268, "CNY", "Alipay CSV"],
  ["2026-10-13", "High speed rail", "travel", 1_490, "TWD", "Money Book CSV"],
  ["2026-10-14", "Bookstore", "shopping", 760, "TWD", "Manual entry"],
  ["2026-10-15", "Cinema", "entertainment", 330, "TWD", "Money Book CSV"],
  ["2026-10-16", "Coworking day pass", "work", 450, "TWD", "Receipt capture"],
  ["2026-10-17", "Supermarket", "food", 1_240, "TWD", "Bank CSV"]
];

export function demoExpenseLedger() {
  const fx = demoFx();
  const records: NormalizedExpense[] = DEMO_EXPENSES.map(([date, merchant, category, amount, currency, sourceName], i) => ({
    id: `demo-expense-${i + 1}`,
    sourceType: "expense",
    sourceName,
    merchant,
    date,
    category,
    nativeAmount: amount,
    nativeCurrency: currency,
    usdValue: Math.round((currency === "USD" ? amount : currency === "TWD" ? amount / fx.rate : amount / (fx.cnyPerUsd ?? 7.2)) * 100) / 100,
    note: "",
    attachmentName: sourceName === "Receipt capture" ? "receipt.jpg" : null,
    inputMethod: sourceName === "Receipt capture" ? "camera" : sourceName === "Manual entry" ? "manual" : "csv",
    settlementStatus: "settled",
    ledgerRevision: 1,
    updatedAt: `${date}T12:00:00.000Z`,
    syncStatus: "updated_today",
    isSeed: false
  }));
  return { configured: true as const, storage: "supabase" as const, records, deletedIds: [], eventCount: records.length };
}

export const demoHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Portfolio-Data": "demo"
};

export function demoAgentBrief(asText: boolean) {
  const s = demoPortfolioSnapshot();
  const text = "Demo data. Every number here is synthetic. Sources " + s.connectedSourceCount + "/" + s.expectedSourceCount + " fresh. Exchanges " +
    Math.round((s.groups.exchangesUsd / s.netWorthUsd) * 100) + "%, wallets " + Math.round((s.groups.walletsUsd / s.netWorthUsd) * 100) + "%, banks " +
    Math.round((s.groups.banksUsd / s.netWorthUsd) * 100) + "%.";
  return asText
    ? new Response(text, { headers: { ...demoHeaders, "Content-Type": "text/plain; charset=utf-8" } })
    : Response.json({ demo: true, brief: text }, { headers: demoHeaders });
}
