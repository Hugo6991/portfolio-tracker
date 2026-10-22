import { describe, expect, it } from "vitest";
import { portfolioOverview, withCurrentDeliveryAge } from "./portfolio-overview";
import type { LivePortfolioSnapshot } from "./live-portfolio";

describe("portfolio overview delivery", () => {
  it("preserves an exact observed token logo without changing balances or input data", () => {
    const input = {
      holdings: [{ symbol: "币安人生", valueUsd: 10, amount: 2 }],
      wallets: [{ tokens: [{ symbol: "币安人生", chainId: "bsc", contractAddress: "0x123", iconUrl: "https://static.debank.com/image/test.png" }] }]
    } as unknown as LivePortfolioSnapshot;
    const original = structuredClone(input);
    expect(portfolioOverview(input).holdings).toEqual([{ ...input.holdings[0], iconUrl: "https://static.debank.com/image/test.png" }]);
    expect(input).toEqual(original);
    expect(portfolioOverview(input)).not.toHaveProperty("wallets");
  });

  it("does not guess across contracts with the same symbol but conflicting logos", () => {
    const input = {
      holdings: [{ symbol: "SAME" }],
      wallets: [{ tokens: [
        { symbol: "SAME", chainId: "eth", contractAddress: "0x111", iconUrl: "https://static.debank.com/image/one.png" },
        { symbol: "SAME", chainId: "bsc", contractAddress: "0x222", iconUrl: "https://static.debank.com/image/two.png" }
      ] }]
    } as unknown as LivePortfolioSnapshot;
    expect(portfolioOverview(input).holdings).toEqual(input.holdings);
  });

  it("ignores excluded and unverified tokens, while retaining protocol token metadata", () => {
    const logo = "https://static.debank.com/image/trusted.png";
    const input = {
      holdings: [{ symbol: "TOKEN" }],
      wallets: [{ tokens: [
        { symbol: "TOKEN", iconUrl: "https://static.debank.com/image/spam.png", valuationState: "excluded" },
        { symbol: "TOKEN", iconUrl: "https://static.debank.com/image/fake.png", verificationState: "unverified" }
      ], positions: [{ tokens: [{ symbol: "TOKEN", iconUrl: logo }] }] }]
    } as unknown as LivePortfolioSnapshot;
    expect(portfolioOverview(input).holdings[0].iconUrl).toBe(logo);
  });
  it("removes only the wallet detail and preserves balances and diagnoses", () => {
    const input = { netWorthUsd: 12, holdings: [{ symbol: "BTC" }], wallets: [{ tokens: [1] }], delivery: { latestAttempt: { status: "failed" } } } as unknown as LivePortfolioSnapshot;
    expect(portfolioOverview(input)).toEqual({ netWorthUsd: 12, holdings: input.holdings, delivery: input.delivery });
    expect(input.wallets).toHaveLength(1);
  });
  it("recomputes stale state from the observation time rather than a cached response age", () => {
    const input = { generatedAt: "2026-09-18T00:00:00Z", delivery: { mode: "cache", cacheAgeSeconds: 5, cacheTtlSeconds: 1200, persisted: true } } as LivePortfolioSnapshot;
    expect(withCurrentDeliveryAge(input, Date.parse("2026-09-18T00:30:00Z")).delivery).toMatchObject({ mode: "stale-cache", cacheAgeSeconds: 1800 });
    expect(input.delivery?.cacheAgeSeconds).toBe(5);
  });
});
