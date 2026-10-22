import { describe, expect, it } from "vitest";
import { buildDashboardHoldingBreakdown } from "./portfolio-dashboard";

function holding(symbol: string, valueUsd: number) {
  return { symbol, name: `${symbol} asset`, valueUsd };
}

describe("dashboard holding breakdown", () => {
  it("keeps US$50 as an individual holding and groups US$49.99 into Other", () => {
    const result = buildDashboardHoldingBreakdown([
      holding("FIFTY", 50),
      holding("SMALL", 49.99)
    ]);

    expect(result.slices.map((slice) => slice.label)).toEqual(["FIFTY", "Other"]);
    expect(result.slices[1]).toMatchObject({ valueUsd: 49.99, holdingCount: 1, isOther: true });
    expect(result.totalUsd).toBeCloseTo(99.99);
  });

  it("shows the six largest eligible holdings and groups the rest with small holdings", () => {
    const result = buildDashboardHoldingBreakdown([
      holding("G", 70),
      holding("A", 130),
      holding("H", 49),
      holding("D", 100),
      holding("B", 120),
      holding("F", 80),
      holding("C", 110),
      holding("E", 90)
    ]);

    expect(result.slices.map((slice) => slice.label)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "Other"
    ]);
    expect(result.slices.at(-1)).toMatchObject({ valueUsd: 119, holdingCount: 2 });
    expect(result.otherHoldingCount).toBe(2);
    expect(result.totalUsd).toBe(749);
  });

  it("returns an empty breakdown when there is no positive holding value", () => {
    const result = buildDashboardHoldingBreakdown([
      holding("ZERO", 0),
      holding("NEGATIVE", -10),
      holding("INVALID", Number.NaN)
    ]);

    expect(result).toEqual({ slices: [], totalUsd: 0, otherHoldingCount: 0 });
  });

  it("uses a human label for an account estimate instead of a token-like symbol", () => {
    const result = buildDashboardHoldingBreakdown([{
      symbol: "GATE-ESTIMATE",
      name: "Gate unallocated account value",
      valueUsd: 400
    }]);

    expect(result.slices[0]).toMatchObject({
      id: "GATE-ESTIMATE",
      label: "Gate unallocated account value",
      detail: "Estimated account total · not an asset position"
    });
  });
});
