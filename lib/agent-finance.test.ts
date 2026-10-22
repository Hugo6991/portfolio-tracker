import { describe, expect, it } from "vitest";
import type { NormalizedExpense } from "./expense-records";
import type { FxRateSnapshot } from "./fx";
import type { LivePortfolioSnapshot } from "./live-portfolio";
import type { PortfolioHistoryPoint } from "./portfolio-history";
import { buildAgentFinanceResponse, buildExpenseSummary } from "./agent-finance";

describe("private agent finance response", () => {
  it("returns factual position value changes without private holdings or source values", () => {
    const response = buildAgentFinanceResponse({
      snapshot: snapshot(),
      previousSnapshot: previousSnapshot(),
      history: [history("2026-09-05", 900)],
      capturedAt: "2026-09-06T00:00:00.000Z",
      sync: sync("success"),
      fx: fx(),
      expenses: { source: "supabase", records: expenses() },
      now: new Date("2026-09-06T02:00:00.000Z")
    });
    const serialized = JSON.stringify(response);

    expect(response.portfolio.dataQuality.status).toBe("fresh");
    expect(response.portfolio.positionChanges).toEqual([
      { symbol: "BTC", deltaUsd: 150, currentPercent: 55, weightChangePp: 10.56 },
      { symbol: "ETH", deltaUsd: -100, currentPercent: 10, weightChangePp: -12.22 },
      { symbol: "USDT", deltaUsd: 50, currentPercent: 25, weightChangePp: 2.78 }
    ]);
    expect(response.portfolio.allocation.bankValueStatus).toBe("preview");
    expect(serialized).not.toContain("0xprivate");
    expect(serialized).not.toContain("Private merchant");
    expect(serialized).not.toContain("\"amount\"");
    expect(serialized).not.toContain("\"valueUsd\"");
  });

  it("marks a fresh last-known-good snapshot degraded after a rejected sync", () => {
    const response = buildAgentFinanceResponse({
      snapshot: snapshot(),
      previousSnapshot: previousSnapshot(),
      history: [],
      capturedAt: "2026-09-06T00:00:00.000Z",
      sync: sync("skipped_degraded"),
      fx: fx(),
      expenses: { source: null, records: null },
      now: new Date("2026-09-06T02:00:00.000Z")
    });

    expect(response.portfolio.dataQuality.status).toBe("degraded");
    expect(response.expenses.status).toBe("unavailable");
  });

  it("marks a complete snapshot older than 24 hours stale", () => {
    const old = { ...snapshot(), delivery: undefined };
    const response = buildAgentFinanceResponse({
      snapshot: old,
      previousSnapshot: null,
      history: [],
      capturedAt: "2026-09-03T00:00:00.000Z",
      sync: null,
      fx: fx(),
      expenses: { source: "supabase", records: [] },
      now: new Date("2026-09-06T02:00:00.000Z")
    });

    expect(response.portfolio.dataQuality.status).toBe("stale");
    expect(response.portfolio.positionChanges).toEqual([]);
    expect(response.expenses.status).toBe("empty");
  });

  it("excludes unknown and source-estimate placeholders from position changes", () => {
    const current = snapshot();
    const previous = previousSnapshot();
    current.holdings = [
      ...current.holdings,
      { symbol: "UNKNOWN", name: "Unknown", amount: null, valueUsd: 500, sources: ["DeBank"], accountCount: 1 },
      { symbol: "GATE-ESTIMATE", name: "Gate estimate", amount: null, valueUsd: 400, sources: ["Gate"], accountCount: 1 },
      { symbol: "牛來", name: "牛來", amount: null, valueUsd: 60, sources: ["DeBank"], accountCount: 1 }
    ];

    const response = buildAgentFinanceResponse({
      snapshot: current,
      previousSnapshot: previous,
      history: [],
      capturedAt: "2026-09-06T00:00:00.000Z",
      sync: sync("success"),
      fx: fx(),
      expenses: { source: null, records: null },
      now: new Date("2026-09-06T02:00:00.000Z")
    });

    expect(response.portfolio.positionChanges.map((item) => item.symbol)).toEqual([
      "BTC",
      "ETH",
      "牛來"
    ]);
  });
});

describe("expense aggregation", () => {
  it("builds rolling seven-day, prior-period, month-to-date, and Other totals", () => {
    const summary = buildExpenseSummary(
      { source: "supabase", records: expenses() },
      32,
      new Date("2026-09-06T02:00:00.000Z")
    );

    expect(summary.status).toBe("fresh");
    expect(summary.currentSevenDays).toEqual({
      startDate: "2026-08-31",
      endDate: "2026-09-06",
      totalTwd: 4160
    });
    expect(summary.previousSevenDays).toEqual({
      startDate: "2026-08-24",
      endDate: "2026-08-30",
      totalTwd: 500
    });
    expect(summary.deltaTwd).toBe(3660);
    expect(summary.deltaPercent).toBe(732);
    expect(summary.monthToDate).toMatchObject({ month: "2026-09", throughDate: "2026-09-06", totalTwd: 3160 });
    expect(summary.topCategoriesSevenDays[0]).toMatchObject({
      id: "other",
      label: "Other／其他流出",
      totalTwd: 3000
    });
  });

  it("marks expense data stale after 72 hours without an import", () => {
    const summary = buildExpenseSummary(
      { source: "supabase", records: [expense({ updatedAt: "2026-09-01T00:00:00.000Z" })] },
      32,
      new Date("2026-09-06T02:00:00.000Z")
    );
    expect(summary.status).toBe("stale");
    expect(summary.freshnessHours).toBeGreaterThan(72);
  });
});

function sync(status: "success" | "skipped_degraded") {
  return {
    lastAttemptAt: "2026-09-06T01:00:00.000Z",
    lastSuccessfulAt: status === "success" ? "2026-09-06T01:01:00.000Z" : "2026-09-05T01:01:00.000Z",
    attemptLagHours: 1,
    isAttemptOverdue: false,
    latest: {
      completedAt: "2026-09-06T01:01:00.000Z",
      status,
      rejectedSources: status === "success" ? [] : ["debank"],
      reasonCodes: status === "success" ? [] : ["value-collapse"]
    }
  } as const;
}

function fx(): FxRateSnapshot {
  return {
    base: "USD",
    quote: "TWD",
    rate: 32,
    cnyPerUsd: 7.2,
    fetchedAt: "2026-09-06T00:00:00.000Z",
    source: "ExchangeRate API",
    status: "updated_today"
  };
}

function history(date: string, netWorthUsd: number): PortfolioHistoryPoint {
  return {
    date,
    capturedAt: `${date}T00:00:00.000Z`,
    netWorthUsd,
    exchangesUsd: netWorthUsd,
    walletsUsd: 0,
    banksUsd: 0,
    sourceCount: 7,
    isPartial: false,
    deltaUsd: null,
    deltaPercent: null
  };
}

function snapshot(): LivePortfolioSnapshot {
  return {
    generatedAt: "2026-09-06T00:00:00.000Z",
    delivery: { mode: "cache", persisted: true, cacheAgeSeconds: 7200, cacheTtlSeconds: 1200 },
    netWorthUsd: 1000,
    liveValueUsd: 900,
    previewValueUsd: 100,
    groups: { exchangesUsd: 700, walletsUsd: 200, banksUsd: 100 },
    sources: [
      { id: "binance", name: "Binance", kind: "exchange", status: "live", valueUsd: 700, itemCount: 2, updatedAt: "2026-09-06T00:00:00.000Z", detail: "private" },
      { id: "bank", name: "Bank", kind: "bank", status: "preview", valueUsd: 100, itemCount: 1, updatedAt: "2026-09-06T00:00:00.000Z", detail: "private" }
    ],
    holdings: [
      { symbol: "BTC", name: "Bitcoin", amount: 0.01, valueUsd: 550, sources: ["Binance"], accountCount: 1 },
      { symbol: "USDT", name: "Tether", amount: 250, valueUsd: 250, sources: ["Binance"], accountCount: 1 },
      { symbol: "ETH", name: "Ether", amount: 0.1, valueUsd: 100, sources: ["DeBank"], accountCount: 1 },
      { symbol: "TWD", name: "New Taiwan dollar", amount: 3000, valueUsd: 100, sources: ["Bank"], accountCount: 1 }
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
      updatedAt: "2026-09-06T00:00:00.000Z"
    }],
    connectedSourceCount: 1,
    expectedSourceCount: 1,
    isPartial: false,
    errors: []
  };
}

function previousSnapshot(): LivePortfolioSnapshot {
  const prior = snapshot();
  return {
    ...prior,
    generatedAt: "2026-09-05T00:00:00.000Z",
    netWorthUsd: 900,
    liveValueUsd: 800,
    holdings: [
      { symbol: "BTC", name: "Bitcoin", amount: 0.01, valueUsd: 400, sources: ["Binance"], accountCount: 1 },
      { symbol: "USDT", name: "Tether", amount: 200, valueUsd: 200, sources: ["Binance"], accountCount: 1 },
      { symbol: "ETH", name: "Ether", amount: 0.2, valueUsd: 200, sources: ["DeBank"], accountCount: 1 },
      { symbol: "TWD", name: "New Taiwan dollar", amount: 3000, valueUsd: 100, sources: ["Bank"], accountCount: 1 }
    ]
  };
}

function expenses() {
  return [
    expense({ date: "2026-08-26", nativeAmount: 500, category: "food" }),
    expense({ id: "current-food", date: "2026-08-31", nativeAmount: 1000, category: "food" }),
    expense({ id: "current-other", date: "2026-09-06", nativeAmount: 3000, category: "other" }),
    expense({ id: "current-usd", date: "2026-09-05", nativeAmount: 5, nativeCurrency: "USD", usdValue: 5, category: "subscription" })
  ];
}

function expense(overrides: Partial<NormalizedExpense> = {}): NormalizedExpense {
  return {
    id: "expense-1",
    sourceType: "expense",
    sourceName: "Manual entry",
    merchant: "Private merchant",
    date: "2026-09-06",
    category: "food",
    nativeAmount: 100,
    nativeCurrency: "TWD",
    usdValue: 3.125,
    note: "private",
    attachmentName: null,
    inputMethod: "manual",
    updatedAt: "2026-09-06T01:00:00.000Z",
    syncStatus: "updated_today",
    isSeed: false,
    ...overrides
  };
}
