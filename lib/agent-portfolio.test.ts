import { describe, expect, it } from "vitest";
import type { FxRateSnapshot } from "./fx";
import type { LivePortfolioSnapshot } from "./live-portfolio";
import type { PortfolioHistoryPoint } from "./portfolio-history";
import { buildAgentPortfolioResponse } from "./agent-portfolio";

describe("agent portfolio view", () => {
  it("returns allocation and risk signals without private identifiers or values by default", () => {
    const response = buildAgentPortfolioResponse({
      snapshot: snapshot(),
      history: [],
      capturedAt: "2026-09-01T00:00:00.000Z"
    });
    const serialized = JSON.stringify(response);

    expect(response.allocation.custody).toEqual([
      { id: "exchanges", percent: 70 },
      { id: "wallets", percent: 20 },
      { id: "banks", percent: 10 }
    ]);
    expect(response.allocation.topHoldings[0]).toMatchObject({ symbol: "BTC", percent: 55 });
    expect(response.allocation.topHoldings.find((holding) => holding.symbol === "TWD")?.assetClass).toBeUndefined();
    expect(response.riskSignals.map((signal) => signal.code)).toContain("single-asset-concentration");
    expect("absoluteValues" in response).toBe(false);
    expect("totals" in response).toBe(false);
    expect(response.privacy.absoluteValuesExposed).toBe(false);
    expect(serialized).not.toContain("0xprivate");
    expect(serialized).not.toContain("Binance main");
    expect(serialized).not.toContain("\"valueUsd\":550");
    expect(response.brief.language).toBe("zh-Hant");
    expect(response.brief.text).toContain("• 🏦 CEX ███████░░░ 70.0%");
    expect(response.brief.text).toContain("• 🪙 BTC 55.0%｜USDT 25.0%｜ETH 10.0%｜Top 3 90.0%");
    expect(response.brief.text).toContain("不構成交易建議");
  });

  it("adds aggregate totals and previous-complete-day change only when requested", () => {
    const response = buildAgentPortfolioResponse({
      snapshot: snapshot(),
      history: [historyPoint("2026-08-31", 800), historyPoint("2026-09-01", 1000)],
      capturedAt: "2026-09-01T00:00:00.000Z",
      includeTotals: true,
      fx: fx(),
      latestSync: {
        completedAt: "2026-09-01T00:05:00.000Z",
        status: "skipped_degraded",
        rejectedSources: ["debank"],
        reasonCodes: ["value-collapse"]
      }
    });
    const serialized = JSON.stringify(response);

    expect(response.privacy).toEqual({
      absoluteValuesExposed: true,
      aggregatedTotalsExposed: true,
      sourceValuesExposed: false,
      walletAddressesExposed: false,
      accountIdentifiersExposed: false
    });
    expect(response.totals).toMatchObject({
      totalUsd: 1000,
      totalTwd: 32000,
      fxTwdPerUsd: 32,
      asOfDate: "2026-09-01",
      comparisonBasis: "previous-complete-day",
      previousCompleteDate: "2026-08-31",
      deltaUsd: 200,
      deltaTwd: 6400,
      deltaPercent: 25
    });
    expect(response.latestSync?.rejectedSources).toEqual(["debank"]);
    expect(serialized).not.toContain("0xprivate");
    expect(serialized).not.toContain("\"valueUsd\":550");
    expect(serialized).not.toContain("\"amount\":");
  });

  it("does not invent a comparison when no previous complete day exists", () => {
    const response = buildAgentPortfolioResponse({
      snapshot: snapshot(),
      history: [historyPoint("2026-09-01", 1000)],
      capturedAt: "2026-09-01T00:00:00.000Z",
      includeTotals: true,
      fx: fx()
    });

    expect(response.totals).toMatchObject({
      previousCompleteDate: null,
      deltaUsd: null,
      deltaTwd: null,
      deltaPercent: null
    });
  });

  it("treats a snapshot older than 24 hours as stale even if its stored delivery mode says cache", () => {
    const rebuilt = buildAgentPortfolioResponse({
      snapshot: {
        ...snapshot(),
        delivery: { mode: "cache", persisted: true, cacheAgeSeconds: 90_000, cacheTtlSeconds: 1200 }
      },
      history: [],
      capturedAt: "2026-09-01T00:00:00.000Z"
    });

    expect(rebuilt.brief.text).toContain("資料品質異常");
    expect(rebuilt.brief.text).toContain("暫不解讀配置變化");
  });
});

function historyPoint(date: string, netWorthUsd: number): PortfolioHistoryPoint {
  return {
    date,
    capturedAt: `${date}T00:00:00.000Z`,
    netWorthUsd,
    exchangesUsd: netWorthUsd,
    walletsUsd: 0,
    banksUsd: 0,
    sourceCount: 2,
    isPartial: false,
    deltaUsd: null,
    deltaPercent: null
  };
}

function fx(): FxRateSnapshot {
  return {
    base: "USD",
    quote: "TWD",
    rate: 32,
    cnyPerUsd: 7.2,
    fetchedAt: "2026-09-01T00:00:00.000Z",
    source: "ExchangeRate API",
    status: "updated_today"
  };
}

function snapshot(): LivePortfolioSnapshot {
  return {
    generatedAt: "2026-09-01T00:00:00.000Z",
    delivery: { mode: "cache", persisted: true, cacheAgeSeconds: 60, cacheTtlSeconds: 1200 },
    netWorthUsd: 1000,
    liveValueUsd: 900,
    previewValueUsd: 100,
    groups: { exchangesUsd: 700, walletsUsd: 200, banksUsd: 100 },
    sources: [{
      id: "binance",
      name: "Binance",
      kind: "exchange",
      status: "live",
      valueUsd: 700,
      itemCount: 2,
      updatedAt: "2026-09-01T00:00:00.000Z",
      detail: "private source detail"
    }],
    holdings: [
      { symbol: "BTC", name: "Bitcoin", amount: 0.01, valueUsd: 550, sources: ["Binance"], accountCount: 1 },
      { symbol: "USDT", name: "Tether", amount: 250, valueUsd: 250, sources: ["Binance"], accountCount: 1 },
      { symbol: "ETH", name: "Ether", amount: 0.1, valueUsd: 100, sources: ["DeBank"], accountCount: 1 },
      { symbol: "TWD", name: "New Taiwan dollar", amount: 3000, valueUsd: 100, sources: ["Bank CSV"], accountCount: 1 }
    ],
    wallets: [{
      id: "private-wallet",
      name: "Private wallet",
      address: "0xprivate",
      debankUrl: "https://debank.com/profile/0xprivate",
      valueUsd: 200,
      debankValueUsd: 200,
      hyperliquidValueUsd: 0,
      tokenCount: 1,
      protocolCount: 0,
      tokens: [],
      positions: [],
      status: "live",
      updatedAt: "2026-09-01T00:00:00.000Z"
    }],
    connectedSourceCount: 2,
    expectedSourceCount: 2,
    isPartial: false,
    errors: []
  };
}
