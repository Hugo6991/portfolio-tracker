import { describe, expect, it } from "vitest";
import { SMALL_BALANCE_THRESHOLD_USD, partitionSmallBalances } from "./small-balances";

describe("partitionSmallBalances", () => {
  it("hides balances below $50 while keeping $50 and above visible", () => {
    const result = partitionSmallBalances([
      { symbol: "ABOVE", valueUsd: 50.01 },
      { symbol: "BOUNDARY", valueUsd: 50 },
      { symbol: "BELOW", valueUsd: 49.99 }
    ]);

    expect(SMALL_BALANCE_THRESHOLD_USD).toBe(50);
    expect(result.visible.map((balance) => balance.symbol)).toEqual(["ABOVE", "BOUNDARY"]);
    expect(result.hidden.map((balance) => balance.symbol)).toEqual(["BELOW"]);
  });

  it("preserves input order and reports the hidden count and total", () => {
    const result = partitionSmallBalances([
      { symbol: "FIRST", valueUsd: 100 },
      { symbol: "SECOND", valueUsd: 50.01 },
      { symbol: "THIRD", valueUsd: 50 },
      { symbol: "FOURTH", valueUsd: 49.99 },
      { symbol: "FIFTH", valueUsd: 25 }
    ]);

    expect(result.visible.map((balance) => balance.symbol)).toEqual(["FIRST", "SECOND", "THIRD"]);
    expect(result.hidden.map((balance) => balance.symbol)).toEqual(["FOURTH", "FIFTH"]);
    expect(result.hiddenCount).toBe(2);
    expect(result.hiddenTotalUsd).toBeCloseTo(74.99);
  });

  it("keeps material liabilities visible while hiding only small absolute values", () => {
    const result = partitionSmallBalances([
      { symbol: "BORROWED", valueUsd: -500 },
      { symbol: "SMALL_DEBT", valueUsd: -25 }
    ]);

    expect(result.visible.map((balance) => balance.symbol)).toEqual(["BORROWED"]);
    expect(result.hidden.map((balance) => balance.symbol)).toEqual(["SMALL_DEBT"]);
    expect(result.hiddenTotalUsd).toBe(-25);
  });
});
