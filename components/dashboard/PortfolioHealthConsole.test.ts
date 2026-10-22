import { describe, expect, it } from "vitest";
import { sourceFreshnessLabel } from "./PortfolioHealthConsole";

describe("portfolio health source labels", () => {
  it("distinguishes a manual update from an actual fallback", () => {
    expect(sourceFreshnessLabel({
      freshnessState: "late",
      cadence: "manual",
      usingFallback: false
    })).toBe("Update due");
    expect(sourceFreshnessLabel({
      freshnessState: "late",
      cadence: "daily",
      usingFallback: true
    })).toBe("Using fallback");
  });
});
