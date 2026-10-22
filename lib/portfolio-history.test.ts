import { describe, expect, it } from "vitest";
import type { LivePortfolioSnapshot } from "./live-portfolio";
import {
  buildRuleReport,
  canonicalizeDailySnapshots,
  canonicalizeHourlySnapshots,
  calculateChange,
  getTaipeiDate,
  getTaipeiHourBucket,
  snapshotToHistoryPoint
} from "./portfolio-history";

function snapshot(overrides: Partial<LivePortfolioSnapshot> = {}): LivePortfolioSnapshot {
  return {
    generatedAt: "2026-08-11T17:15:00.000Z",
    netWorthUsd: 100_000,
    liveValueUsd: 100_000,
    previewValueUsd: 0,
    groups: { exchangesUsd: 50_000, walletsUsd: 50_000, banksUsd: 0 },
    sources: [],
    holdings: [],
    wallets: [],
    connectedSourceCount: 4,
    expectedSourceCount: 4,
    isPartial: false,
    errors: [],
    ...overrides
  };
}

describe("portfolio history", () => {
  it("uses the Asia/Taipei calendar date for a daily snapshot", () => {
    expect(getTaipeiDate("2026-08-11T17:15:00.000Z")).toBe("2026-08-12");
    expect(snapshotToHistoryPoint(snapshot()).date).toBe("2026-08-12");
    expect(snapshotToHistoryPoint(snapshot()).deltaPercent).toBeNull();
  });

  it("calculates daily value and percentage changes", () => {
    expect(calculateChange(105, 100)).toEqual({ deltaUsd: 5, deltaPercent: 5 });
    expect(calculateChange(105, null)).toEqual({ deltaUsd: null, deltaPercent: null });
  });

  it("keeps the latest snapshot for each Taipei calendar day", () => {
    const points = canonicalizeDailySnapshots([
      snapshot({ generatedAt: "2026-08-11T17:15:00.000Z", netWorthUsd: 100 }),
      snapshot({ generatedAt: "2026-08-12T03:00:00.000Z", netWorthUsd: 110 }),
      snapshot({ generatedAt: "2026-08-12T17:15:00.000Z", netWorthUsd: 121 })
    ]);

    expect(points).toHaveLength(2);
    expect(points[0].netWorthUsd).toBe(110);
    expect(points[1].deltaPercent).toBe(10);
  });

  it("keeps the latest real snapshot per Taipei hour without filling missing hours", () => {
    const points = canonicalizeHourlySnapshots([
      snapshot({ generatedAt: "2026-08-11T16:05:00.000Z", netWorthUsd: 100 }),
      snapshot({ generatedAt: "2026-08-11T16:55:00.000Z", netWorthUsd: 110 }),
      snapshot({ generatedAt: "2026-08-11T19:05:00.000Z", netWorthUsd: 121 })
    ]);

    expect(getTaipeiHourBucket("2026-08-11T16:55:00.000Z")).toBe("2026-08-12T00");
    expect(points).toHaveLength(2);
    expect(points.map((point) => point.capturedAt)).toEqual([
      "2026-08-11T16:55:00.000Z",
      "2026-08-11T19:05:00.000Z"
    ]);
    expect(points[1].deltaPercent).toBe(10);
  });

  it("drops malformed stored rows instead of synthesizing a zero value", () => {
    const malformed = snapshot({
      generatedAt: "2026-08-11T18:00:00.000Z",
      netWorthUsd: Number.NaN
    });
    const partial = snapshot({
      generatedAt: "2026-08-11T19:00:00.000Z",
      netWorthUsd: 90,
      isPartial: true
    });

    const points = canonicalizeHourlySnapshots([malformed, partial]);

    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ netWorthUsd: 90, isPartial: true });
  });

  it("keeps the latest complete point when a later partial arrives in the same bucket", () => {
    const points = canonicalizeHourlySnapshots([
      snapshot({ generatedAt: "2026-08-11T16:07:00.000Z", netWorthUsd: 100 }),
      snapshot({
        generatedAt: "2026-08-11T16:47:00.000Z",
        netWorthUsd: 40,
        isPartial: true
      }),
      snapshot({ generatedAt: "2026-08-11T17:07:00.000Z", netWorthUsd: 110 })
    ]);

    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({
      capturedAt: "2026-08-11T16:07:00.000Z",
      netWorthUsd: 100,
      isPartial: false
    });
    expect(points[1].deltaPercent).toBe(10);
  });

  it("nulls partial deltas and compares the next complete point with the previous complete point", () => {
    const points = canonicalizeHourlySnapshots([
      snapshot({ generatedAt: "2026-08-11T16:07:00.000Z", netWorthUsd: 100 }),
      snapshot({
        generatedAt: "2026-08-11T17:07:00.000Z",
        netWorthUsd: 40,
        isPartial: true
      }),
      snapshot({ generatedAt: "2026-08-11T18:07:00.000Z", netWorthUsd: 110 })
    ]);

    expect(points.map((point) => point.deltaPercent)).toEqual([null, null, 10]);
    expect(points[1].deltaUsd).toBeNull();
    expect(points[2].deltaUsd).toBe(10);
  });

  it("flags large moves, reduced coverage, and partial snapshots", () => {
    const previous = snapshotToHistoryPoint(snapshot({
      generatedAt: "2026-08-10T17:15:00.000Z",
      connectedSourceCount: 5
    }));
    const current = snapshotToHistoryPoint(snapshot({
      netWorthUsd: 90_000,
      connectedSourceCount: 4,
      isPartial: true
    }));
    const report = buildRuleReport(current, previous);

    expect(report.deltaPercent).toBe(-10);
    expect(report.alerts).toHaveLength(3);
    expect(report.alerts.join(" ")).toContain("Large daily move");
    expect(report.alerts.join(" ")).toContain("coverage fell");
    expect(report.alerts.join(" ")).toContain("incomplete");
  });
});
