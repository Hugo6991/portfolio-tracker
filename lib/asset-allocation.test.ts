import { describe, expect, it } from "vitest";
import { buildCryptoAssetAllocation, getAssetAllocationId } from "./asset-allocation";

describe("asset allocation", () => {
  it("groups stablecoins and wrapped majors while excluding fiat previews", () => {
    const result = buildCryptoAssetAllocation([
      { symbol: "USDT", valueUsd: 100 },
      { symbol: "USDC.E", valueUsd: 50 },
      { symbol: "WBTC", valueUsd: 80 },
      { symbol: "BTC", valueUsd: 20 },
      { symbol: "WBNB", valueUsd: 40 },
      { symbol: "WETH", valueUsd: 30 },
      { symbol: "USD", valueUsd: 2_000 },
      { symbol: "TWD", valueUsd: 1_000 }
    ]);

    expect(result.totalUsd).toBe(320);
    expect(result.groups.map((group) => [group.id, group.valueUsd])).toEqual([
      ["stablecoins", 150],
      ["btc", 100],
      ["bnb", 40],
      ["eth", 30]
    ]);
  });

  it("keeps HYPE and UNI distinct and sends unknown symbols to Other", () => {
    expect(getAssetAllocationId("HYPE")).toBe("hype");
    expect(getAssetAllocationId("uni")).toBe("uni");
    expect(getAssetAllocationId("ONDO")).toBe("other");
  });

  it("ignores invalid and non-positive values", () => {
    const result = buildCryptoAssetAllocation([
      { symbol: "BTC", valueUsd: Number.NaN },
      { symbol: "ETH", valueUsd: 0 },
      { symbol: "USDT", valueUsd: -1 }
    ]);

    expect(result).toEqual({ groups: [], totalUsd: 0 });
  });

  it("nets signed protocol debt without overstating the allocation total", () => {
    const result = buildCryptoAssetAllocation([
      { symbol: "USDC", valueUsd: 2_000 },
      { symbol: "WBTC", valueUsd: -500 },
      { symbol: "BNB", valueUsd: 500 }
    ]);

    expect(result.totalUsd).toBe(2_000);
    expect(result.groups.map((group) => [group.id, group.valueUsd])).toEqual([
      ["stablecoins", 1_600],
      ["bnb", 400]
    ]);
    expect(result.groups.reduce((sum, group) => sum + group.valueUsd, 0)).toBe(result.totalUsd);
  });

  it("subtracts borrowed wrapped assets from a positive holding in the same category", () => {
    const result = buildCryptoAssetAllocation([
      { symbol: "BTC", valueUsd: 1_000 },
      { symbol: "WBTC", valueUsd: -400 },
      { symbol: "USDT", valueUsd: 600 }
    ]);

    expect(result.totalUsd).toBe(1_200);
    expect(result.groups.map((group) => [group.id, group.valueUsd])).toEqual([
      ["stablecoins", 600],
      ["btc", 600]
    ]);
  });
});
