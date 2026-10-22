import { describe, expect, it } from "vitest";
import type { LiveHolding, LivePortfolioSnapshot } from "./live-portfolio";
import {
  calendarizeAssetHistory,
  canonicalizeDailyAssetSnapshots,
  getAssetHistorySeriesValue
} from "./asset-history";

function holding(symbol: string, valueUsd: number, sources = ["Binance"]): LiveHolding {
  return {
    symbol,
    name: symbol,
    amount: null,
    valueUsd,
    sources,
    accountCount: 1
  };
}

function snapshot({
  generatedAt = "2026-08-11T17:15:00.000Z",
  holdings = [],
  liveValueUsd = holdings.reduce((sum, item) => sum + item.valueUsd, 0),
  isPartial = false
}: {
  generatedAt?: string;
  holdings?: LiveHolding[];
  liveValueUsd?: number;
  isPartial?: boolean;
} = {}): LivePortfolioSnapshot {
  return {
    generatedAt,
    netWorthUsd: liveValueUsd,
    liveValueUsd,
    previewValueUsd: 0,
    groups: { exchangesUsd: liveValueUsd, walletsUsd: 0, banksUsd: 0 },
    sources: [],
    holdings,
    wallets: [],
    connectedSourceCount: 0,
    expectedSourceCount: 0,
    isPartial,
    errors: []
  };
}

describe("asset history", () => {
  it("emits all stable allocation keys and excludes bank-only fiat holdings", () => {
    const cryptoHoldings = [
      holding("USDT", 100),
      holding("WBTC", 200),
      holding("HYPE", 300),
      holding("WBNB", 400),
      holding("WETH", 500),
      holding("UNI", 600),
      holding("SOL", 700)
    ];
    const result = canonicalizeDailyAssetSnapshots([
      snapshot({
        holdings: [
          ...cryptoHoldings,
          holding("USD", 900, ["Bank CSV"]),
          holding("TWD", 1_000, ["Bank CSV"])
        ],
        liveValueUsd: 2_800
      })
    ]);

    expect(result[0]).toMatchObject({
      date: "2026-08-12",
      totalLiveCryptoUsd: 2_800,
      sourceQuality: "complete",
      breakdownQuality: "complete",
      classificationCoveragePercent: 100,
      isPartial: false,
      valuesUsd: {
        stablecoins: 100,
        btc: 200,
        hype: 300,
        bnb: 400,
        eth: 500,
        uni: 600,
        other: 700
      }
    });
  });

  it("keeps the latest snapshot for a Taipei day without mutating input order", () => {
    const earlier = snapshot({
      generatedAt: "2026-08-11T17:15:00.000Z",
      holdings: [holding("BTC", 100)]
    });
    const latest = snapshot({
      generatedAt: "2026-08-12T03:00:00.000Z",
      holdings: [holding("BTC", 125)]
    });
    const nextDay = snapshot({
      generatedAt: "2026-08-12T17:15:00.000Z",
      holdings: [holding("BTC", 150)]
    });
    const input = [nextDay, earlier, latest];
    const originalOrder = input.map((item) => item.generatedAt);

    const result = canonicalizeDailyAssetSnapshots(input);

    expect(input.map((item) => item.generatedAt)).toEqual(originalOrder);
    expect(result.map((point) => [point.date, point.valuesUsd.btc])).toEqual([
      ["2026-08-12", 125],
      ["2026-08-13", 150]
    ]);
  });

  it("places an unclassified legacy total in Other and marks its breakdown unavailable", () => {
    const legacy = snapshot({ holdings: [], liveValueUsd: 1_000 });
    const legacyRecord: Record<string, unknown> = { ...legacy };
    delete legacyRecord.holdings;

    const result = canonicalizeDailyAssetSnapshots([
      legacyRecord as LivePortfolioSnapshot
    ]);

    expect(result[0]).toMatchObject({
      totalLiveCryptoUsd: 1_000,
      sourceQuality: "complete",
      breakdownQuality: "unavailable",
      isPartial: true,
      valuesUsd: { other: 1_000 }
    });
    expect(getAssetHistorySeriesValue(result[0], "total")).toBe(1_000);
    expect(getAssetHistorySeriesValue(result[0], "other")).toBeNull();
  });

  it("keeps a complete snapshot drawable when filtered dust creates a small remainder", () => {
    const result = canonicalizeDailyAssetSnapshots([
      snapshot({
        holdings: [holding("USDT", 330_683.7903452907)],
        liveValueUsd: 330_684.0054954869
      })
    ]);

    expect(result[0]).toMatchObject({
      sourceQuality: "complete",
      breakdownQuality: "reconciled",
      classifiedValueUsd: 330_683.7903452907,
      unclassifiedUsd: 0.2151501962216571,
      isPartial: false
    });
    expect(result[0].classificationCoveragePercent).toBeGreaterThan(99.999);
    expect(getAssetHistorySeriesValue(result[0], "total")).toBe(330_684.0054954869);
    expect(getAssetHistorySeriesValue(result[0], "other")).toBeCloseTo(0.2151501962216571);
  });

  it("preserves a source-level partial flag even when category totals reconcile", () => {
    const result = canonicalizeDailyAssetSnapshots([
      snapshot({ holdings: [holding("USDC", 500)], isPartial: true })
    ]);

    expect(result[0]).toMatchObject({ isPartial: true, totalLiveCryptoUsd: 500 });
    expect(result[0].sourceQuality).toBe("partial");
    expect(getAssetHistorySeriesValue(result[0], "total")).toBeNull();
  });

  it("inserts explicit calendar gaps instead of connecting across missing days", () => {
    const points = canonicalizeDailyAssetSnapshots([
      snapshot({ generatedAt: "2026-08-23T16:00:00.000Z", holdings: [holding("BTC", 100)] }),
      snapshot({ generatedAt: "2026-08-25T16:00:00.000Z", holdings: [holding("BTC", 110)] })
    ]);

    expect(calendarizeAssetHistory(points).map(({ date, point }) => [date, point?.totalLiveCryptoUsd ?? null])).toEqual([
      ["2026-08-24", 100],
      ["2026-08-25", null],
      ["2026-08-26", 110]
    ]);
  });

  it("returns no points for empty history", () => {
    expect(canonicalizeDailyAssetSnapshots([])).toEqual([]);
  });
});
