import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const readPortfolioSourcePayloads = vi.fn();
const portfolioBanks = vi.hoisted(() => [] as Array<{
  id: string;
  name: string;
  type: "bank";
  assets: string[];
  nativeAmount: number;
  nativeCurrency: "TWD";
  valueTwd: number;
  valueUsd: number;
  lastUpdate: string;
}>);

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({
  getPortfolio: () => ({
    meta: { exportedAt: "2026-10-01T00:00:00.000Z" },
    wallets: [{
      id: "wallet-1",
      name: "Wallet 1",
      address: `0x${"1".repeat(40)}`,
      chain: "ethereum"
    }, {
      id: "wallet-2",
      name: "Wallet 2",
      address: `0x${"2".repeat(40)}`,
      chain: "ethereum"
    }],
    banks: portfolioBanks
  })
}));
vi.mock("@/lib/display", () => ({
  assetLabel: (symbol: string) => symbol,
  getDisplayAccountName: (name: string) => name
}));
vi.mock("@/lib/cex", async (importOriginal) => ({
  ...await importOriginal<typeof import("../cex")>(),
  CEX_EXCHANGES: ["binance", "okx", "bitget", "htx", "gate"],
  getCexExchangeName: (exchange: string) => exchange.toUpperCase()
}));
vi.mock("@/lib/server/cex-sources", () => ({ syncCexSources: vi.fn(async () => []) }));
vi.mock("@/lib/server/cex-snapshot-store", () => ({ readLatestCexSnapshots: vi.fn(async () => ({})) }));
vi.mock("@/lib/server/portfolio-source-state", () => ({ readPortfolioSourcePayloads }));
vi.mock("@/lib/server/wallet-details", () => ({
  getDeBankTokenExclusion: vi.fn((token: { verificationState?: string; exclusionReason?: string }) => (
    token.exclusionReason ??
    (token.verificationState === "unverified" ? "unverified" : null)
  )),
  resolveDeBankContractAddress: vi.fn((token: { contractAddress?: string | null; id: string }) => (
    token.contractAddress ?? token.id.match(/:balance:(0x[a-fA-F0-9]{40}):/)?.[1] ?? null
  )),
  buildDeBankWalletHoldings: vi.fn((input: {
    tokens: Array<{ symbol: string; name: string; amount: number | null; valueUsd: number }>;
    positions: Array<{ valueUsd: number }>;
    walletValueUsd: number;
  }) => {
    const tokenValueUsd = input.tokens.reduce((sum, token) => sum + token.valueUsd, 0);
    const protocolValueUsd = input.positions.reduce((sum, position) => sum + position.valueUsd, 0);
    const reconciliationUsd = input.walletValueUsd - tokenValueUsd - protocolValueUsd;
    return [
      ...input.tokens.map((token) => ({
        symbol: token.symbol,
        name: token.name,
        amount: token.amount,
        valueUsd: token.valueUsd
      })),
      ...(Math.abs(reconciliationUsd) >= 0.01 ? [{
        symbol: "DEBANK-RECONCILIATION",
        name: "DeBank total reconciliation",
        amount: null,
        valueUsd: reconciliationUsd
      }] : [])
    ];
  }),
  normalizeDeBankProtocolPositions: vi.fn(() => []),
  normalizeDeBankWalletTokens: vi.fn(() => []),
  normalizeHyperliquidPositions: vi.fn(() => [])
}));

let getLivePortfolioSnapshot: typeof import("./live-portfolio").getLivePortfolioSnapshot;
let getLivePortfolioCandidate: typeof import("./live-portfolio").getLivePortfolioCandidate;
let selectRotatingDeBankWallets: typeof import("./live-portfolio").selectRotatingDeBankWallets;

beforeAll(async () => {
  ({
    getLivePortfolioCandidate,
    getLivePortfolioSnapshot,
    selectRotatingDeBankWallets
  } = await import("./live-portfolio"));
});

beforeEach(() => {
  portfolioBanks.splice(0);
  readPortfolioSourcePayloads.mockReset().mockResolvedValue(new Map());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.DEBANK_ACCESS_KEY;
});

describe("bank portfolio source", () => {
  it("uses the oldest included balance timestamp and manual freshness thresholds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T08:00:00.000Z"));
    portfolioBanks.push({
      id: "bank-old",
      name: "Older bank balance",
      type: "bank",
      assets: ["TWD"],
      nativeAmount: 3100,
      nativeCurrency: "TWD",
      valueTwd: 3100,
      valueUsd: 100,
      lastUpdate: "2026-10-01T08:00:00.000Z"
    }, {
      id: "bank-new",
      name: "Newer bank balance",
      type: "bank",
      assets: ["TWD"],
      nativeAmount: 6200,
      nativeCurrency: "TWD",
      valueTwd: 6200,
      valueUsd: 200,
      lastUpdate: "2026-10-19T08:00:00.000Z"
    });
    vi.stubGlobal("fetch", hyperliquidFetchMock({ allMids: () => jsonResponse({ HYPE: "20" }) }));

    const result = await getLivePortfolioCandidate();

    expect(result.snapshot.sources.find((source) => source.id === "bank-csv")).toMatchObject({
      cadence: "manual",
      updatedAt: "2026-10-01T08:00:00.000Z",
      valueUpdatedAt: "2026-10-01T08:00:00.000Z",
      compositionUpdatedAt: "2026-10-01T08:00:00.000Z",
      freshnessState: "late",
      itemCount: 2,
      valueUsd: 300
    });
  });
});

describe("Hyperliquid portfolio source", () => {
  it("propagates OKX Earn exactly once through portfolio totals, HYPE allocation and finance", async () => {
    const { readLatestCexSnapshots } = await import("./cex-snapshot-store");
    const { buildAgentFinanceResponse } = await import("../agent-finance");
    const { fallbackFxRate } = await import("../fx");
    vi.stubGlobal("fetch", hyperliquidFetchMock({ allMids: () => jsonResponse({ HYPE: "20" }) }));
    process.env.DEBANK_ACCESS_KEY = "test-access-key";
    const now = new Date().toISOString();
    const base = { exchange: "okx" as const, name: "OKX", status: "live" as const,
      capturedAt: now, bucketAt: now, valueUsd: 5205, itemCount: 1, accounts: [], errors: [],
      holdings: [{ exchange: "okx" as const, accountType: "Funding", symbol: "USDC", amount: 5205, valueUsd: 5205 }] };
    vi.mocked(readLatestCexSnapshots).mockResolvedValueOnce({ okx: base });
    const before = (await getLivePortfolioCandidate()).snapshot;
    const amount = 505.54067986;
    const increment = amount * 94;
    vi.mocked(readLatestCexSnapshots).mockResolvedValueOnce({ okx: { ...base, valueUsd: base.valueUsd + increment,
      itemCount: 2, holdings: [...base.holdings, { exchange: "okx", accountType: "Simple Earn flexible",
        symbol: "HYPE", amount, valueUsd: increment, priceUsd: 94, priceSource: "okx-spot", valuationState: "priced", assetClass: "crypto" }] } });
    const after = (await getLivePortfolioCandidate()).snapshot;
    for (const delta of [after.netWorthUsd - before.netWorthUsd, after.liveValueUsd - before.liveValueUsd,
      after.groups.exchangesUsd - before.groups.exchangesUsd,
      after.sources.find(s => s.id === "okx")!.valueUsd - before.sources.find(s => s.id === "okx")!.valueUsd,
      after.holdings.find(h => h.symbol === "HYPE")!.valueUsd - before.holdings.find(h => h.symbol === "HYPE")!.valueUsd]) {
      expect(Math.abs(delta - increment)).toBeLessThan(0.05);
    }
    const finance = buildAgentFinanceResponse({ snapshot: after, previousSnapshot: null, history: [], capturedAt: after.generatedAt,
      sync: null, fx: fallbackFxRate, expenses: { source: null, records: null }, now: new Date(now) });
    expect(finance.portfolio.totals.totalUsd).toBeCloseTo(after.netWorthUsd, 2);
    expect(finance.portfolio.allocation.assetBuckets.find(b => b.id === "hype")?.percent).toBeCloseTo(
      after.holdings.find(h => h.symbol === "HYPE")!.valueUsd / after.netWorthUsd * 100, 1);
    expect(JSON.stringify(finance)).not.toContain('"amount"');
  });
  it("reconciles each newly priced equity dollar through every portfolio total", async () => {
    const { readLatestCexSnapshots } = await import("./cex-snapshot-store");
    const read = vi.mocked(readLatestCexSnapshots);
    vi.stubGlobal("fetch", hyperliquidFetchMock({ allMids: () => jsonResponse({ HYPE: "20" }) }));
    process.env.DEBANK_ACCESS_KEY = "test-access-key";
    const now = new Date().toISOString();
    const base = { exchange: "binance" as const, name: "Binance", status: "live" as const,
      capturedAt: now, bucketAt: now, valueUsd: 1000, itemCount: 1, accounts: [], errors: [],
      pricingBasis: "binance-equities-v1",
      holdings: [{ exchange: "binance" as const, accountType: "Spot", symbol: "USDT", amount: 1000, valueUsd: 1000 }] };
    const correctedOkx = { exchange: "okx" as const, name: "OKX", status: "live" as const,
      capturedAt: now, bucketAt: now, valueUsd: 0, itemCount: 0, pricingBasis: "binance-equities-v1",
      accounts: [{ id: "okx-simple-earn", name: "Simple Earn flexible", status: "live" as const,
        valueUsd: 0, itemCount: 0, holdings: [] }], holdings: [], errors: [] };
    read.mockResolvedValueOnce({ binance: base });
    const before = (await getLivePortfolioCandidate()).snapshot;
    const increment = 2 * 371;
    read.mockResolvedValueOnce({ okx: correctedOkx, binance: { ...base, valueUsd: 1000 + increment, itemCount: 2,
      holdings: [...base.holdings, {
        exchange: "binance", accountType: "Funding", symbol: "EQ_TSLA", amount: 2,
        valueUsd: increment, assetClass: "equity", exposureSymbol: "TSLA", priceUsd: 371,
        priceSource: "binance-equity", valuationState: "priced"
      }] } });
    const after = (await getLivePortfolioCandidate()).snapshot;
    for (const difference of [after.netWorthUsd - before.netWorthUsd,
      after.liveValueUsd - before.liveValueUsd, after.groups.exchangesUsd - before.groups.exchangesUsd,
      after.sources.find((s) => s.id === "binance")!.valueUsd - before.sources.find((s) => s.id === "binance")!.valueUsd]) {
      expect(Math.abs(difference - increment)).toBeLessThan(0.05);
    }
    expect(before.valuationBasis).toBeUndefined();
    expect(after.valuationBasis).toBe("binance-equities-v1");
    expect(after.holdings.find((h) => h.symbol === "EQ_TSLA")).toMatchObject({ valueUsd: increment, assetClass: "equity", exposureSymbol: "TSLA" });
  });
  it("keeps directly valued equity but marks the source partial when allMids fails", async () => {
    const fetchMock = hyperliquidFetchMock({
      allMids: () => jsonResponse({ message: "Price service unavailable" }, 503)
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.DEBANK_ACCESS_KEY = "test-access-key";

    const candidate = await getLivePortfolioCandidate();
    const result = candidate.snapshot;
    const source = result.sources.find((item) => item.id === "hyperliquid");

    expect(source).toMatchObject({
      id: "hyperliquid",
      status: "partial",
      valueUsd: 100,
      itemCount: 1,
      detail: "2 of 2 addresses · staking + trading · HYPE price unavailable"
    });
    const error = result.errors.find((item) => item.source === "Hyperliquid");
    expect(error?.message).toContain("HYPE price unavailable from allMids");
    expect(error?.message).toContain("HTTP 503");
    expect(result.holdings.map((holding) => holding.symbol)).toEqual(["HL-PERP"]);
    expect(result.wallets[0].hyperliquidValueUsd).toBe(100);
    expect(fetchMock.mock.calls.filter(([, init]) => (
      JSON.parse(String(init?.body || "{}")) as { type?: string }
    ).type === "allMids")).toHaveLength(2);
  });

  it("marks the source partial with a clear error when allMids omits a positive HYPE price", async () => {
    vi.stubGlobal("fetch", hyperliquidFetchMock({ allMids: () => jsonResponse({ BTC: "65000" }) }));
    process.env.DEBANK_ACCESS_KEY = "test-access-key";

    const candidate = await getLivePortfolioCandidate();
    const result = candidate.snapshot;
    const source = result.sources.find((item) => item.id === "hyperliquid");

    expect(source?.status).toBe("partial");
    expect(result.errors).toContainEqual({
      source: "Hyperliquid",
      message: "HYPE price unavailable from allMids: response did not include a positive HYPE price"
    });
    expect(result.holdings.some((holding) => holding.symbol === "HYPE")).toBe(false);
  });

  it("stays live and values HYPE staking when allMids returns a positive price", async () => {
    vi.stubGlobal("fetch", hyperliquidFetchMock({ allMids: () => jsonResponse({ HYPE: "20" }) }));
    process.env.DEBANK_ACCESS_KEY = "test-access-key";

    const result = await getLivePortfolioSnapshot();
    const source = result.sources.find((item) => item.id === "hyperliquid");

    expect(source).toMatchObject({ status: "live", valueUsd: 140, itemCount: 2 });
    expect(result.errors.some((item) => item.source === "Hyperliquid")).toBe(false);
    expect(result.holdings.map((holding) => holding.symbol)).toEqual(["HL-PERP", "HYPE"]);
    expect(result.wallets[0].hyperliquidValueUsd).toBe(140);
  });

  it("limits current syncs to configured or recently active Hyperliquid addresses", async () => {
    const fetchMock = hyperliquidFetchMock({ allMids: () => jsonResponse({ HYPE: "20" }) });
    vi.stubGlobal("fetch", fetchMock);
    process.env.DEBANK_ACCESS_KEY = "test-access-key";
    readPortfolioSourcePayloads.mockResolvedValue(new Map([["hyperliquid", {
      lastGoodAt: "2026-09-06T16:45:00.000Z",
      source: {
        id: "hyperliquid",
        name: "Hyperliquid",
        kind: "wallet",
        status: "live",
        valueUsd: 140,
        itemCount: 2,
        updatedAt: "2026-09-06T16:45:00.000Z",
        detail: "1 of 2 active addresses"
      },
      holdings: [],
      wallets: [storedWallet("wallet-1", `0x${"1".repeat(40)}`, 140)]
    }]]));

    const result = (await getLivePortfolioCandidate({ mode: "current" })).snapshot;
    const source = result.sources.find((item) => item.id === "hyperliquid");
    const requestTypes = fetchMock.mock.calls
      .map(([, init]) => JSON.parse(String(init?.body || "{}")) as { type?: string })
      .map((body) => body.type);

    expect(requestTypes.filter((type) => type === "delegatorSummary")).toHaveLength(1);
    expect(requestTypes.filter((type) => type === "clearinghouseState")).toHaveLength(1);
    expect(requestTypes.filter((type) => type === "userVaultEquities")).toHaveLength(1);
    expect(source?.detail).toBe("1 of 1 active addresses · 2 scanned daily · staking + trading");
    expect(result.wallets).toHaveLength(2);
  });

  it("scans every address when current sync has no stored activity set", async () => {
    const fetchMock = hyperliquidFetchMock({ allMids: () => jsonResponse({ HYPE: "20" }) });
    vi.stubGlobal("fetch", fetchMock);
    process.env.DEBANK_ACCESS_KEY = "test-access-key";

    const result = (await getLivePortfolioCandidate({ mode: "current" })).snapshot;
    const requestTypes = fetchMock.mock.calls
      .map(([, init]) => JSON.parse(String(init?.body || "{}")) as { type?: string })
      .map((body) => body.type);

    expect(requestTypes.filter((type) => type === "delegatorSummary")).toHaveLength(2);
    expect(result.sources.find((item) => item.id === "hyperliquid")?.detail)
      .toBe("2 of 2 addresses · staking + trading");
    expect(fetchMock.mock.calls.filter(([input]) => (
      new URL(String(input)).hostname === "pro-openapi.debank.com"
    ))).toHaveLength(0);
  });

  it("preserves scoped observations and pending withdrawals across current sync and legacy source recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T10:00:00.000Z"));
    const fetchMock = hyperliquidFetchMock({ allMids: () => jsonResponse({ HYPE: "20" }) });
    vi.stubGlobal("fetch", fetchMock);
    const stored = storedDeBank("2026-09-20T09:00:00.000Z");
    const wallet = stored.wallets[0] as import("../live-portfolio").LiveWallet;
    wallet.chainRefreshes = { bob: { tokensAt: "2026-09-20T09:30:00.000Z" } };
    wallet.pendingMovements = [{ id: "withdrawal", label: "Redemption", amount: "0.01", asset: "BTC", status: "queued", recordedAt: "2026-09-19T00:00:00Z", expectedAt: "2026-09-19T12:00:00Z" }];
    readPortfolioSourcePayloads.mockResolvedValue(new Map([["debank", stored]]));
    try {
      const first = await getLivePortfolioCandidate({ mode: "current" });
      readPortfolioSourcePayloads.mockResolvedValue(new Map());
      const second = await getLivePortfolioCandidate({ mode: "current", baselineSnapshot: first.snapshot });
      for (const candidate of [first, second]) {
        expect(candidate.snapshot.wallets.find((w) => w.id === wallet.id)).toMatchObject({ chainRefreshes: wallet.chainRefreshes, pendingMovements: wallet.pendingMovements });
        expect(candidate.providerUsage.debank.requestCount).toBe(0);
      }
      expect(fetchMock.mock.calls.filter(([input]) => new URL(String(input)).hostname === "pro-openapi.debank.com")).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it("reuses the daily DeBank payload during current sync without provider requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:00:00.000Z"));
    const fetchMock = hyperliquidFetchMock({ allMids: () => jsonResponse({ HYPE: "20" }) });
    vi.stubGlobal("fetch", fetchMock);
    readPortfolioSourcePayloads.mockResolvedValue(new Map([["debank", storedDeBank(
      "2026-09-10T00:30:00.000Z"
    )]]));

    try {
      const candidate = await getLivePortfolioCandidate({ mode: "current" });
      const debank = candidate.snapshot.sources.find((source) => source.id === "debank");

      expect(debank).toMatchObject({
        status: "live",
        cadence: "daily",
        valueUpdatedAt: "2026-09-10T00:30:00.000Z",
        freshnessState: "fresh"
      });
      expect(candidate.providerUsage.debank).toEqual({
        scanAttempted: false,
        requestCount: 0,
        scanKind: "none",
        estimatedUnits: 0
      });
      expect(candidate.sourcePayloads.some((payload) => payload.source.id === "debank")).toBe(false);
      expect(fetchMock.mock.calls.filter(([input]) => (
        new URL(String(input)).hostname === "pro-openapi.debank.com"
      ))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reprices direct liquid tokens without changing quantities, DeFi detail, or daily reconciliation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:45:00.000Z"));
    const contract = `0x${"a".repeat(40)}`;
    const fetchMock = hyperliquidFetchMock({
      allMids: () => jsonResponse({ HYPE: "20" }),
      defillama: () => jsonResponse({
        coins: { [`ethereum:${contract}`]: marketRow(8) }
      })
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.DEBANK_ACCESS_KEY = "test-access-key";
    readPortfolioSourcePayloads.mockResolvedValue(new Map([[
      "debank",
      storedDeBankWithDetail("2026-09-11T00:30:00.000Z", contract)
    ]]));

    try {
      const candidate = await getLivePortfolioCandidate({ mode: "current" });
      const wallet = candidate.snapshot.wallets.find((item) => item.id === "wallet-1")!;
      const debank = candidate.snapshot.sources.find((source) => source.id === "debank");

      expect(wallet.tokens[0]).toMatchObject({
        amount: 2,
        priceUsd: 8,
        valueUsd: 16,
        priceSource: "defillama",
        priceState: "fresh",
        priceUpdatedAt: "2026-09-11T00:45:00.000Z"
      });
      expect(wallet.positions.find((position) => position.source === "debank")).toMatchObject({
        valueUsd: 30,
        assetValueUsd: 40,
        debtValueUsd: 10
      });
      expect(wallet.reconciliationUsd).toBe(4);
      expect(wallet.debankReportedValueUsd).toBe(50);
      expect(wallet.debankValueUsd).toBe(46);
      expect(debank?.pricing).toMatchObject({
        state: "fresh",
        eligibleTokenCount: 1,
        pricedTokenCount: 1,
        fallbackTokenCount: 0,
        coverageValuePercent: 100
      });
      expect(candidate.snapshot.holdings.some((holding) => (
        holding.symbol === "DEBANK-RECONCILIATION"
      ))).toBe(false);
      expect(fetchMock.mock.calls.filter(([input]) => (
        new URL(String(input)).hostname === "pro-openapi.debank.com"
      ))).toHaveLength(0);
      const priceRequests = fetchMock.mock.calls
        .map(([input]) => String(input))
        .filter((input) => new URL(input).hostname === "coins.llama.fi");
      expect(priceRequests.join(" ")).not.toContain(`0x${"1".repeat(40)}`);
      expect(priceRequests.join(" ")).not.toContain("test-access-key");
      expect(candidate.providerUsage.debank.requestCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the latest portfolio snapshot as the next market-price fallback without moving the daily anchor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:45:00.000Z"));
    const contract = `0x${"a".repeat(40)}`;
    let marketPrice = 8;
    const fetchMock = hyperliquidFetchMock({
      allMids: () => jsonResponse({ HYPE: "20" }),
      defillama: () => jsonResponse({
        coins: { [`ethereum:${contract}`]: marketRow(marketPrice) }
      })
    });
    vi.stubGlobal("fetch", fetchMock);
    readPortfolioSourcePayloads.mockResolvedValue(new Map([[
      "debank",
      storedDeBankWithDetail("2026-09-11T00:30:00.000Z", contract)
    ]]));

    try {
      const first = await getLivePortfolioCandidate({ mode: "current" });
      marketPrice = 9;
      vi.setSystemTime(new Date("2026-09-11T01:00:00.000Z"));
      const second = await getLivePortfolioCandidate({
        mode: "current",
        baselineSnapshot: first.snapshot
      });
      const wallet = second.snapshot.wallets.find((item) => item.id === "wallet-1")!;
      const source = second.snapshot.sources.find((item) => item.id === "debank")!;

      expect(wallet.tokens[0]).toMatchObject({ amount: 2, priceUsd: 9, valueUsd: 18 });
      expect(wallet.tokens[0]).toMatchObject({ snapshotPriceUsd: 5, snapshotValueUsd: 10 });
      expect(wallet.reconciliationUsd).toBe(2);
      expect(wallet.debankReportedAt).toBe("2026-09-11T00:30:00.000Z");
      expect(wallet.debankValueUsd).toBe(48);
      expect(source.valueUpdatedAt).toBe("2026-09-11T00:30:00.000Z");
      expect(source.pricing?.updatedAt).toBe("2026-09-11T01:00:00.000Z");
      expect(fetchMock.mock.calls.filter(([input]) => (
        new URL(String(input)).hostname === "pro-openapi.debank.com"
      ))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebuilds a signed reconciliation at the daily total checkpoint without scaling DeFi", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:30:00.000Z"));
    const contract = `0x${"a".repeat(40)}`;
    const fetchMock = hyperliquidFetchMock({
      allMids: () => jsonResponse({ HYPE: "20" }),
      debank: (url) => url.pathname === "/v1/user/total_balance"
        ? jsonResponse({ total_usd_value: 60 })
        : jsonResponse({ message: "unexpected detail request" }, 500),
      defillama: () => jsonResponse({
        coins: { [`ethereum:${contract}`]: marketRow(8) }
      })
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.DEBANK_ACCESS_KEY = "test-access-key";
    readPortfolioSourcePayloads.mockResolvedValue(new Map([[
      "debank",
      storedDeBankWithDetail("2026-09-10T00:30:00.000Z", contract)
    ]]));

    try {
      const candidate = await getLivePortfolioCandidate({ mode: "valuation" });
      const wallet = candidate.snapshot.wallets.find((item) => item.id === "wallet-1")!;
      const persisted = candidate.sourcePayloads
        .find((payload) => payload.source.id === "debank")?.wallets
        ?.find((item) => item.id === "wallet-1");

      expect(wallet.tokens[0]).toMatchObject({ amount: 2, priceUsd: 8, valueUsd: 16 });
      expect(wallet.positions.find((position) => position.source === "debank")).toMatchObject({
        valueUsd: 30,
        assetValueUsd: 40,
        debtValueUsd: 10
      });
      expect(wallet.reconciliationUsd).toBe(14);
      expect(wallet.debankReportedValueUsd).toBe(60);
      expect(wallet.debankValueUsd).toBe(46);
      expect(persisted).toMatchObject({
        debankReportedValueUsd: 60,
        reconciliationUsd: 14,
        reconciliationState: "diagnostic",
        debankValueUsd: 46
      });
      const debankRequests = fetchMock.mock.calls.filter(([input]) => (
        new URL(String(input)).hostname === "pro-openapi.debank.com"
      ));
      expect(debankRequests).toHaveLength(2);
      expect(debankRequests.every(([input]) => (
        new URL(String(input)).pathname === "/v1/user/total_balance"
      ))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not label an expired market quote timestamp as a fresh calibration price", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:45:00.000Z"));
    const contract = `0x${"a".repeat(40)}`;
    const stored = storedDeBankWithDetail("2026-09-11T00:30:00.000Z", contract);
    const token = stored.wallets[0].tokens[0] as import("@/lib/live-portfolio").LiveWalletToken;
    token.priceSource = "defillama";
    token.priceUpdatedAt = "2026-09-09T00:30:00.000Z";
    token.snapshotPriceUpdatedAt = "2026-09-01T00:30:00.000Z";
    token.priceUsd = 8;
    token.valueUsd = 16;
    readPortfolioSourcePayloads.mockResolvedValue(new Map([["debank", stored]]));
    const fetchMock = hyperliquidFetchMock({
      allMids: () => jsonResponse({ HYPE: "20" }),
      defillama: () => jsonResponse({ coins: {} })
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const candidate = await getLivePortfolioCandidate({ mode: "current" });
      expect(candidate.snapshot.wallets.find((wallet) => wallet.id === "wallet-1")?.tokens[0])
        .toMatchObject({
          amount: 2, priceUsd: 5, valueUsd: 10,
          priceSource: "debank-snapshot", priceState: "stale",
          priceUpdatedAt: "2026-09-01T00:30:00.000Z"
        });
      expect(fetchMock.mock.calls.filter(([input]) => new URL(String(input)).hostname === "pro-openapi.debank.com")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the last trusted token price when DefiLlama has no quote", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:45:00.000Z"));
    const contract = `0x${"a".repeat(40)}`;
    vi.stubGlobal("fetch", hyperliquidFetchMock({
      allMids: () => jsonResponse({ HYPE: "20" }),
      defillama: () => jsonResponse({ coins: {} })
    }));
    readPortfolioSourcePayloads.mockResolvedValue(new Map([[
      "debank",
      storedDeBankWithDetail("2026-09-11T00:30:00.000Z", contract)
    ]]));

    try {
      const candidate = await getLivePortfolioCandidate({ mode: "current" });
      const wallet = candidate.snapshot.wallets.find((item) => item.id === "wallet-1")!;

      expect(wallet.tokens[0]).toMatchObject({
        amount: 2,
        priceUsd: 5,
        valueUsd: 10,
        priceSource: "debank-snapshot",
        priceState: "stale",
        priceUpdatedAt: "2026-09-01T00:30:00.000Z"
      });
      expect(wallet.debankValueUsd).toBe(40);
      expect(candidate.snapshot.sources.find((source) => source.id === "debank")?.pricing)
        .toMatchObject({ state: "stale", pricedTokenCount: 0, fallbackTokenCount: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("quarantines a high-confidence quote when it is an implausible jump from the immutable snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:45:00.000Z"));
    const contract = `0x${"a".repeat(40)}`;
    vi.stubGlobal("fetch", hyperliquidFetchMock({
      allMids: () => jsonResponse({ HYPE: "20" }),
      defillama: () => jsonResponse({
        coins: { [`ethereum:${contract}`]: marketRow(733.596) }
      })
    }));
    readPortfolioSourcePayloads.mockResolvedValue(new Map([[
      "debank",
      storedDeBankWithDetail("2026-09-11T00:30:00.000Z", contract)
    ]]));

    try {
      const candidate = await getLivePortfolioCandidate({ mode: "current" });
      const wallet = candidate.snapshot.wallets.find((item) => item.id === "wallet-1")!;
      const token = wallet.tokens[0];

      expect(token).toMatchObject({
        valueUsd: 0,
        valuationState: "excluded",
        priceState: "excluded",
        exclusionReason: "price-anomaly"
      });
      expect(wallet.debankValueUsd).toBe(30);
      expect(wallet.reconciliationUsd).toBe(20);
      expect(candidate.snapshot.sources.find((source) => source.id === "debank")?.pricing)
        .toMatchObject({ state: "stale", excludedTokenCount: 1, anomalyTokenCount: 1 });
      expect(candidate.snapshot.holdings.some((holding) => holding.symbol === "TOKEN")).toBe(false);
      expect(candidate.snapshot.holdings.some((holding) => holding.symbol === "DEBANK-RECONCILIATION")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("excludes a DeBank payload after the 14-day rotating-check safety boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:30:01.000Z"));
    vi.stubGlobal("fetch", hyperliquidFetchMock({ allMids: () => jsonResponse({ HYPE: "20" }) }));
    readPortfolioSourcePayloads.mockResolvedValue(new Map([["debank", storedDeBank(
      "2026-08-27T00:30:00.000Z"
    )]]));

    try {
      const candidate = await getLivePortfolioCandidate({ mode: "current" });
      const debank = candidate.snapshot.sources.find((source) => source.id === "debank");

      expect(debank).toMatchObject({ status: "error", valueUsd: 0, freshnessState: "stale" });
      expect(candidate.snapshot.holdings.some((holding) => holding.symbol === "USDC")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an 8-to-14-day DeBank value only as a degraded fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:30:00.000Z"));
    vi.stubGlobal("fetch", hyperliquidFetchMock({ allMids: () => jsonResponse({ HYPE: "20" }) }));
    readPortfolioSourcePayloads.mockResolvedValue(new Map([["debank", storedDeBank(
      "2026-09-01T00:30:00.000Z"
    )]]));

    try {
      const candidate = await getLivePortfolioCandidate({ mode: "current" });
      const debank = candidate.snapshot.sources.find((source) => source.id === "debank");

      expect(debank).toMatchObject({
        status: "partial",
        freshnessState: "late",
        fallback: { lastGoodAt: "2026-09-01T00:30:00.000Z", attemptStatus: "partial" }
      });
      expect(candidate.snapshot.isPartial).toBe(true);
      expect(candidate.snapshot.holdings.some((holding) => (
        holding.symbol === "DEBANK-RECONCILIATION"
      ))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the daily DeBank scan after the first global 403", async () => {
    const fetchMock = hyperliquidFetchMock({
      allMids: () => jsonResponse({ HYPE: "20" }),
      debank: () => jsonResponse({ message: "insufficient units" }, 403)
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.DEBANK_ACCESS_KEY = "test-access-key";

    const candidate = await getLivePortfolioCandidate({ mode: "full" });
    const debankRequests = fetchMock.mock.calls.filter(([input]) => (
      new URL(String(input)).hostname === "pro-openapi.debank.com"
    ));

    expect(debankRequests).toHaveLength(4);
    expect(candidate.providerUsage.debank).toEqual({
      scanAttempted: true,
      requestCount: 4,
      scanKind: "full",
      estimatedUnits: 1_109
    });
    expect(candidate.snapshot.errors.filter((error) => error.source === "DeBank")).toHaveLength(1);
  });

  it("uses only one total_balance request per wallet for daily valuation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:30:00.000Z"));
    const fetchMock = hyperliquidFetchMock({
      allMids: () => jsonResponse({ HYPE: "20" }),
      debank: (url) => url.pathname === "/v1/user/total_balance"
        ? jsonResponse({ total_usd_value: 20 })
        : jsonResponse({ message: "unexpected detail request" }, 500)
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.DEBANK_ACCESS_KEY = "test-access-key";
    readPortfolioSourcePayloads.mockResolvedValue(new Map([["debank", storedDeBank(
      "2026-09-10T00:30:00.000Z"
    )]]));

    try {
      const candidate = await getLivePortfolioCandidate({ mode: "valuation" });
      const debankRequests = fetchMock.mock.calls
        .map(([input]) => new URL(String(input)))
        .filter((url) => url.hostname === "pro-openapi.debank.com");

      expect(debankRequests).toHaveLength(2);
      expect(debankRequests.every((url) => url.pathname === "/v1/user/total_balance")).toBe(true);
      expect(candidate.providerUsage.debank).toEqual({
        scanAttempted: true,
        requestCount: 2,
        scanKind: "total-balance",
        estimatedUnits: 60
      });
      expect(candidate.snapshot.sources.find((source) => source.id === "debank"))
        .toMatchObject({ status: "live", valueUsd: 10 });
      expect(candidate.sourcePayloads.find((payload) => payload.source.id === "debank")?.source)
        .toMatchObject({ status: "live", compositionUpdatedAt: "2026-09-10T00:30:00.000Z" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("revalues from the latest trusted snapshot without bootstrapping a full scan", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:30:00.000Z"));
    const fetchMock = hyperliquidFetchMock({
      allMids: () => jsonResponse({ HYPE: "20" }),
      debank: (url) => url.pathname === "/v1/user/total_balance"
        ? jsonResponse({ total_usd_value: 20 })
        : jsonResponse({ message: "detail endpoint must not be called" }, 500)
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.DEBANK_ACCESS_KEY = "test-access-key";

    try {
      const candidate = await getLivePortfolioCandidate({
        mode: "valuation",
        baselineSnapshot: baselineSnapshot()
      });
      const debankRequests = fetchMock.mock.calls
        .map(([input]) => new URL(String(input)))
        .filter((url) => url.hostname === "pro-openapi.debank.com");

      expect(debankRequests).toHaveLength(2);
      expect(debankRequests.every((url) => url.pathname === "/v1/user/total_balance")).toBe(true);
      expect(candidate.providerUsage.debank).toEqual({
        scanAttempted: true,
        requestCount: 2,
        scanKind: "total-balance",
        estimatedUnits: 60
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed with zero DeBank requests when valuation has no baseline", async () => {
    const fetchMock = hyperliquidFetchMock({ allMids: () => jsonResponse({ HYPE: "20" }) });
    vi.stubGlobal("fetch", fetchMock);
    process.env.DEBANK_ACCESS_KEY = "test-access-key";

    const candidate = await getLivePortfolioCandidate({ mode: "valuation" });

    expect(fetchMock.mock.calls.filter(([input]) => (
      new URL(String(input)).hostname === "pro-openapi.debank.com"
    ))).toHaveLength(0);
    expect(candidate.providerUsage.debank).toEqual({
      scanAttempted: false,
      requestCount: 0,
      scanKind: "none",
      estimatedUnits: 0
    });
  });

  it("uses a bounded source payload when the latest provider attempt is incomplete", async () => {
    readPortfolioSourcePayloads.mockResolvedValue(new Map([["hyperliquid", {
      lastGoodAt: "2026-09-06T16:45:00.000Z",
      source: {
        id: "hyperliquid",
        name: "Hyperliquid",
        kind: "wallet",
        status: "live",
        valueUsd: 140,
        itemCount: 2,
        updatedAt: "2026-09-06T16:45:00.000Z",
        detail: "1 of 1 addresses"
      },
      holdings: [{
        symbol: "HYPE",
        name: "Hyperliquid",
        amount: 7,
        valueUsd: 140,
        accountId: "wallet-1:hyperliquid-staking"
      }]
    }]]));
    vi.stubGlobal("fetch", hyperliquidFetchMock({ allMids: () => jsonResponse({ message: "Price service unavailable" }, 503) }));
    process.env.DEBANK_ACCESS_KEY = "test-access-key";

    const candidate = await getLivePortfolioCandidate();
    const result = candidate.snapshot;
    const source = result.sources.find((item) => item.id === "hyperliquid");

    expect(source).toMatchObject({
      status: "partial",
      valueUsd: 140,
      fallback: {
        lastGoodAt: "2026-09-06T16:45:00.000Z",
        attemptStatus: "partial"
      }
    });
    expect(result.netWorthUsd).toBe(140);
    expect(result.holdings).toContainEqual(expect.objectContaining({ symbol: "HYPE", valueUsd: 140 }));
    expect(result.isPartial).toBe(true);
    expect(candidate.sourcePayloads.find((payload) => payload.source.id === "hyperliquid")?.source)
      .toMatchObject({ status: "partial", valueUsd: 100 });
  });
});

describe("DeBank rotating valuation", () => {
  it("checks two wallets per day and covers twelve wallets in six Taipei days", () => {
    const wallets = Array.from({ length: 12 }, (_, index) => ({ id: `wallet-${index + 1}` }));
    const selected = Array.from({ length: 6 }, (_, day) => (
      selectRotatingDeBankWallets(
        wallets,
        new Date(Date.UTC(2026, 8, 12 + day, 0, 30)).toISOString()
      )
    ));

    expect(selected.every((group) => group.length === 2)).toBe(true);
    expect(new Set(selected.flat().map((wallet) => wallet.id))).toEqual(
      new Set(wallets.map((wallet) => wallet.id))
    );
  });
});

function hyperliquidFetchMock({
  allMids,
  debank,
  defillama
}: {
  allMids: () => Response;
  debank?: (url: URL) => Response;
  defillama?: (url: URL) => Response;
}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "pro-openapi.debank.com") {
      if (debank) return debank(url);
      if (url.pathname === "/v1/user/total_balance") return jsonResponse({ total_usd_value: 0 });
      return jsonResponse([]);
    }
    if (url.hostname === "coins.llama.fi") {
      return defillama ? defillama(url) : jsonResponse({ coins: {} });
    }
    const body = JSON.parse(String(init?.body || "{}")) as { type?: string };
    if (body.type === "allMids") return allMids();
    const inactiveWallet = String((body as { user?: string }).user || "").toLowerCase() === `0x${"2".repeat(40)}`;
    if (body.type === "delegatorSummary") {
      return jsonResponse({ delegated: inactiveWallet ? "0" : "2", undelegated: "0", totalPendingWithdrawal: "0" });
    }
    if (body.type === "clearinghouseState") {
      return jsonResponse({ marginSummary: { accountValue: inactiveWallet ? "0" : "100" } });
    }
    if (body.type === "userVaultEquities") return jsonResponse([]);
    return jsonResponse({ message: "Unexpected Hyperliquid request" }, 400);
  });
}

function storedDeBank(lastGoodAt: string) {
  const wallet = storedWallet("wallet-1", `0x${"1".repeat(40)}`, 0);
  return {
    lastGoodAt,
    source: {
      id: "debank",
      name: "DeBank",
      kind: "wallet" as const,
      status: "live" as const,
      valueUsd: 10,
      itemCount: 1,
      updatedAt: lastGoodAt,
      detail: "complete"
    },
    holdings: [{ symbol: "USDC", amount: 10, valueUsd: 10, accountId: "wallet-1" }],
    wallets: [{
      ...wallet,
      valueUsd: 10,
      debankValueUsd: 10,
      tokenCount: 1,
      tokens: [{
        id: "debank:eth:wallet:balance:eth:liquid:0",
        source: "debank" as const,
        symbol: "ETH",
        name: "ETH",
        chainId: "eth",
        chainName: "Ethereum",
        protocolId: null,
        protocolName: null,
        iconUrl: null,
        verificationState: "verified" as const,
        valuationState: "fallback" as const,
        amount: 0.005,
        priceUsd: 2_000,
        snapshotPriceUsd: 2_000,
        snapshotValueUsd: 10,
        priceSource: "debank-snapshot" as const,
        priceState: "fallback" as const,
        priceUpdatedAt: lastGoodAt,
        valueUsd: 10,
        state: "liquid" as const
      }],
      updatedAt: lastGoodAt
    }]
  };
}

function storedDeBankWithDetail(lastGoodAt: string, contractAddress: string) {
  const address = `0x${"1".repeat(40)}`;
  const wallet = storedWallet("wallet-1", address, 0);
  return {
    lastGoodAt,
    source: {
      id: "debank",
      name: "DeBank",
      kind: "wallet" as const,
      status: "live" as const,
      valueUsd: 50,
      itemCount: 1,
      updatedAt: lastGoodAt,
      valueUpdatedAt: lastGoodAt,
      compositionUpdatedAt: "2026-09-01T00:30:00.000Z",
      detail: "complete"
    },
    holdings: [
      { symbol: "TOKEN", amount: 2, valueUsd: 10, accountId: address },
      { symbol: "DEFI", amount: null, valueUsd: 30, accountId: address },
      { symbol: "DEBANK-RECONCILIATION", amount: null, valueUsd: 10, accountId: address }
    ],
    wallets: [{
      ...wallet,
      valueUsd: 50,
      debankValueUsd: 50,
      debankReportedValueUsd: 50,
      debankReportedAt: lastGoodAt,
      reconciliationUsd: 10,
      priceUpdatedAt: "2026-09-01T00:30:00.000Z",
      compositionUpdatedAt: "2026-09-01T00:30:00.000Z",
      tokenCount: 1,
      protocolCount: 1,
      tokens: [{
        id: `debank:eth:wallet:balance:${contractAddress}:liquid:0`,
        source: "debank" as const,
        symbol: "TOKEN",
        name: "Token",
        chainId: "eth",
        chainName: "Ethereum",
        protocolId: null,
        protocolName: null,
        iconUrl: null,
        contractAddress,
        verificationState: "verified" as const,
        valuationState: "fallback" as const,
        amount: 2,
        priceUsd: 5,
        snapshotPriceUsd: 5,
        snapshotValueUsd: 10,
        priceSource: "debank-snapshot" as const,
        priceUpdatedAt: "2026-09-01T00:30:00.000Z",
        valueUsd: 10,
        state: "liquid" as const
      }],
      positions: [{
        id: "debank:eth:protocol:position:0",
        source: "debank" as const,
        protocolId: "protocol",
        protocolName: "Protocol",
        protocolIconUrl: null,
        protocolUrl: null,
        chainId: "eth",
        chainName: "Ethereum",
        name: "Protocol position",
        state: "supplied" as const,
        valueUsd: 30,
        assetValueUsd: 40,
        debtValueUsd: 10,
        unlockAt: null,
        tokens: []
      }],
      updatedAt: lastGoodAt
    }]
  };
}

function marketRow(price: number) {
  return {
    price,
    confidence: 0.99,
    timestamp: Date.now() / 1_000
  };
}

function storedWallet(id: string, address: string, hyperliquidValueUsd: number) {
  return {
    id,
    name: id,
    address,
    debankUrl: `https://debank.com/profile/${address}`,
    valueUsd: hyperliquidValueUsd,
    debankValueUsd: 0,
    hyperliquidValueUsd,
    tokenCount: 0,
    protocolCount: 0,
    tokens: [],
    positions: [],
    status: "live" as const,
    updatedAt: "2026-09-06T16:45:00.000Z"
  };
}

function baselineSnapshot() {
  const capturedAt = "2026-09-10T00:30:00.000Z";
  const wallets = [
    storedWallet("wallet-1", `0x${"1".repeat(40)}`, 0),
    storedWallet("wallet-2", `0x${"2".repeat(40)}`, 0)
  ].map((wallet) => ({
    ...wallet,
    valueUsd: 10,
    debankValueUsd: 10,
    updatedAt: capturedAt
  }));
  return {
    generatedAt: capturedAt,
    netWorthUsd: 20,
    liveValueUsd: 20,
    previewValueUsd: 0,
    groups: { exchangesUsd: 0, walletsUsd: 20, banksUsd: 0 },
    sources: [{
      id: "debank",
      name: "DeBank",
      kind: "wallet" as const,
      status: "live" as const,
      valueUsd: 20,
      itemCount: 2,
      updatedAt: capturedAt,
      detail: "complete"
    }],
    holdings: [],
    wallets,
    connectedSourceCount: 1,
    expectedSourceCount: 1,
    isPartial: false,
    errors: []
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
