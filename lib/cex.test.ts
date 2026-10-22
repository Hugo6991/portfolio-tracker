import { describe, expect, it } from "vitest";
import {
  buildCexPublicResponse,
  createUnavailableCexSnapshot,
  finalizeCexSnapshot,
  getCexExchangeName,
  getCexHoldingPresentation,
  getCexBucketAt,
  mergeCexAccounts,
  OKX_SIMPLE_EARN_ACCOUNT_ID,
  type CexSourceSnapshot
} from "./cex";

function source(capturedAt = "2026-08-13T00:14:00.000Z"): CexSourceSnapshot {
  return finalizeCexSnapshot({
    exchange: "binance",
    name: "Binance",
    status: "error",
    capturedAt,
    bucketAt: getCexBucketAt(capturedAt),
    valueUsd: 0,
    itemCount: 0,
    accounts: [
      {
        id: "binance-spot",
        name: "Spot",
        status: "live",
        valueUsd: 0,
        itemCount: 1,
        holdings: [{ exchange: "binance", accountType: "Spot", symbol: "BTC", amount: 1, valueUsd: 100 }]
      }
    ],
    holdings: [],
    errors: []
  });
}

describe("CEX snapshots", () => {
  it("uses deterministic 15-minute buckets", () => {
    expect(getCexBucketAt("2026-08-13T00:29:59.999Z")).toBe("2026-08-13T00:15:00.000Z");
  });

  it("reuses a previous successful account when the same account fails", () => {
    const previous = source();
    const current = {
      ...source("2026-08-13T00:30:00.000Z"),
      accounts: [{ id: "binance-spot", name: "Spot", status: "error" as const, valueUsd: 0, itemCount: 0, holdings: [], error: "timeout" }]
    };
    const merged = mergeCexAccounts(current, previous);
    expect(merged.valueUsd).toBe(100);
    expect(merged.accounts[0].status).toBe("stale");
    expect(merged.status).toBe("partial");
  });

  it("clears the valuation basis when an account falls back across incompatible bases", () => {
    const previous = { ...source(), pricingBasis: null };
    const current = {
      ...source("2026-08-13T00:30:00.000Z"),
      pricingBasis: "binance-equities-v1",
      accounts: [{ id: "binance-spot", name: "Spot", status: "error" as const, valueUsd: 0, itemCount: 0, holdings: [], error: "timeout" }]
    };

    const merged = mergeCexAccounts(current, previous);

    expect(merged.accounts[0].status).toBe("stale");
    expect(merged.pricingBasis).toBeNull();
  });

  it("keeps the valuation basis when an account falls back within the same basis", () => {
    const previous = { ...source(), pricingBasis: "binance-equities-v1" };
    const current = {
      ...source("2026-08-13T00:30:00.000Z"),
      pricingBasis: "binance-equities-v1",
      accounts: [{ id: "binance-spot", name: "Spot", status: "error" as const, valueUsd: 0, itemCount: 0, holdings: [], error: "timeout" }]
    };

    expect(mergeCexAccounts(current, previous).pricingBasis).toBe("binance-equities-v1");
  });

  it("requires live or same-basis fallback coverage for OKX Simple Earn", () => {
    const trading = {
      id: "okx-trading",
      name: "Trading",
      status: "live" as const,
      valueUsd: 100,
      itemCount: 1,
      holdings: [{ exchange: "okx" as const, accountType: "Trading", symbol: "USDC", amount: 100, valueUsd: 100 }]
    };
    const failedEarn = {
      id: OKX_SIMPLE_EARN_ACCOUNT_ID,
      name: "Simple Earn flexible",
      status: "error" as const,
      valueUsd: 0,
      itemCount: 0,
      holdings: [],
      error: "timeout"
    };
    const current = finalizeCexSnapshot({
      pricingBasis: "binance-equities-v1",
      exchange: "okx",
      name: "OKX",
      status: "error",
      capturedAt: "2026-08-13T00:30:00.000Z",
      bucketAt: "2026-08-13T00:30:00.000Z",
      valueUsd: 0,
      itemCount: 0,
      accounts: [trading, failedEarn],
      holdings: [],
      errors: []
    });
    const legacy = { ...current, pricingBasis: null, accounts: [trading] };

    expect(mergeCexAccounts(current, legacy).pricingBasis).toBeNull();

    const corrected = {
      ...current,
      accounts: [trading, {
        ...failedEarn,
        status: "live" as const,
        valueUsd: 50,
        itemCount: 1,
        holdings: [{ exchange: "okx" as const, accountType: "Simple Earn flexible", symbol: "USDC", amount: 50, valueUsd: 50 }],
        error: undefined
      }]
    };
    const merged = mergeCexAccounts(current, corrected);
    expect(merged.accounts.find((account) => account.id === OKX_SIMPLE_EARN_ACCOUNT_ID)?.status).toBe("stale");
    expect(merged.pricingBasis).toBe("binance-equities-v1");
  });

  it("marks public results stale after 45 minutes", () => {
    const response = buildCexPublicResponse([source()], new Date("2026-08-13T01:00:01.000Z"));
    expect(response.sources[0].status).toBe("stale");
    expect(response.totalUsd).toBe(100);
  });

  it("keeps exchanges without a first successful snapshot visible", () => {
    const missing = createUnavailableCexSnapshot("bitget", "2026-08-13T00:30:00.000Z");
    expect(missing.name).toBe("Bitget");
    expect(missing.status).toBe("error");
    expect(missing.valueUsd).toBe(0);
    expect(missing.errors[0].message).toBe("No successful CEX snapshot is available");
  });

  it("uses the HTX brand name for Huobi API snapshots", () => {
    expect(getCexExchangeName("htx")).toBe("HTX");
    expect(createUnavailableCexSnapshot("htx").name).toBe("HTX");
  });

  it("uses the Gate brand name for Gate API snapshots", () => {
    expect(getCexExchangeName("gate")).toBe("Gate");
    expect(createUnavailableCexSnapshot("gate").name).toBe("Gate");
  });

  it("labels synthetic account estimates without presenting them as tokens", () => {
    expect(getCexHoldingPresentation({ symbol: "GATE-ESTIMATE" })).toEqual({
      isEstimate: true,
      label: "Gate unallocated account value"
    });
    expect(getCexHoldingPresentation({ symbol: "USDT" })).toEqual({
      isEstimate: false,
      label: "USDT"
    });
  });
});
