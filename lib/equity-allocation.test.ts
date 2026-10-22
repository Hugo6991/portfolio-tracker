import { describe, expect, it } from "vitest";
import { buildCryptoAssetAllocation } from "./asset-allocation";
import { walletAssetIdentity } from "./asset-identity";
import { canonicalizeDailyAssetSnapshots } from "./asset-history";
import { buildAgentFinanceResponse } from "./agent-finance";
import type { LivePortfolioSnapshot } from "./live-portfolio";
import { fallbackFxRate } from "./fx";

describe("equity identity through allocation and finance", () => {
  const holdings = ["EQ_TSLA", "TSLAB", "TSLAON"].map((symbol) => ({
    symbol, name: symbol, assetClass: "equity" as const, exposureSymbol: "TSLA",
    amount: 1, valueUsd: 370, accountCount: 1, sources: ["Binance"]
  }));
  const snapshot: LivePortfolioSnapshot = {
    generatedAt: "2026-09-22T00:00:00Z", netWorthUsd: 1110, liveValueUsd: 1110, previewValueUsd: 0,
    groups: { exchangesUsd: 1110, walletsUsd: 0, banksUsd: 0 },
    holdings, sources: [], wallets: [], connectedSourceCount: 0, expectedSourceCount: 0,
    isPartial: false, errors: []
  };
  it("preserves all instruments while summing one equity bucket", () => {
    const result = buildCryptoAssetAllocation([...holdings, { symbol: "BNB", valueUsd: 100 }, { symbol: "BTCB", valueUsd: 200 }]);
    expect(result.groups.find((g) => g.id === "equities")).toMatchObject({ valueUsd: 1110, symbols: ["EQ_TSLA", "TSLAB", "TSLAON"] });
    expect(result.totalUsd).toBe(1410);
    expect(result.groups.find((g) => g.id === "btc")?.valueUsd).toBe(200);
  });
  it("classifies a known wallet contract without trusting a symbol suffix", () => {
    expect(walletAssetIdentity({ chainId: "bsc", contractAddress: "0x2494b603319d4d9f9715c9f4496d9e0364b59d93" })).toEqual({ assetClass: "equity", exposureSymbol: "TSLA" });
    expect(walletAssetIdentity({ chainId: "base", contractAddress: "0x2494b603319d4d9f9715c9f4496d9e0364b59d93" })).toEqual({});
  });
  it("propagates equities to history and the private API without quantities", () => {
    const history = canonicalizeDailyAssetSnapshots([snapshot]);
    expect(history[0]).toMatchObject({ totalInvestableUsd: 1110, totalLiveCryptoUsd: 1110, valuesUsd: { equities: 1110, other: 0 } });
    const response = buildAgentFinanceResponse({ snapshot, previousSnapshot: null, history: [], capturedAt: snapshot.generatedAt,
      sync: null, fx: fallbackFxRate, expenses: { source: null, records: null }, now: new Date(snapshot.generatedAt) });
    expect(response.schemaVersion).toBe("2026-09-22");
    expect(response.portfolio.allocation.assetBuckets[0]).toMatchObject({ id: "equities", percent: 100 });
    expect(response.portfolio.allocation.topHoldings).toHaveLength(3);
    expect(response.portfolio.allocation.topHoldings[0]).toMatchObject({ assetClass: "equity", exposureSymbol: "TSLA" });
    expect(JSON.stringify(response)).not.toContain('"amount"');
    expect(response.portfolio.positionChanges).toEqual([]);
  });
  it("does not report a valuation correction as a position gain", () => {
    const corrected = { ...snapshot, valuationBasis: "binance-equities-v1" };
    const response = buildAgentFinanceResponse({ snapshot: corrected, previousSnapshot: snapshot,
      history: [], capturedAt: corrected.generatedAt, sync: null, fx: fallbackFxRate,
      expenses: { source: null, records: null }, now: new Date(corrected.generatedAt) });
    expect(response.portfolio.positionChanges).toEqual([]);
    expect(response.portfolio.performance).toMatchObject({ dayChangePercent: null, sevenDayChangePercent: null, thirtyDayChangePercent: null });
  });
});
