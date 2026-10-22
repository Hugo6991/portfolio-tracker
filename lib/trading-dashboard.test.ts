import { describe, expect, it } from "vitest";
import { formatEth, formatSignedUsdg, formatUsdg, isTradingSnapshotStale, shortAddress, type TradingDashboardSnapshot } from "./trading-dashboard";

describe("trading dashboard view model", () => {
  it("marks snapshots stale only after two minutes", () => {
    const snapshot = {generatedAt:"2026-09-05T00:00:00.000Z"} as TradingDashboardSnapshot;
    expect(isTradingSnapshotStale(snapshot,new Date("2026-09-05T00:01:59.000Z").getTime())).toBe(false);
    expect(isTradingSnapshotStale(snapshot,new Date("2026-09-05T00:02:01.000Z").getTime())).toBe(true);
  });

  it("formats public trading values without implying unavailable net P&L is zero", () => {
    expect(formatUsdg(99.70372)).toBe("100 USDG");
    expect(formatSignedUsdg(-0.29628)).toBe("-30¢");
    expect(formatSignedUsdg(0.004)).toBe("+<1¢");
    expect(formatSignedUsdg(null)).toBe("N/A");
    expect(formatEth(0.000521039)).toBe("521,039 gwei");
    expect(shortAddress("0x1F71974b8e71834E1f75843B08682F789A1D3285")).toBe("0x1F7197…1D3285");
  });
});
