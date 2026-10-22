import { describe, expect, it } from "vitest";
import {
  buildPortfolioHistoryChartData,
  buildPortfolioHistoryUrl,
  findPortfolioHistoryGaps,
  getDefaultPortfolioHistoryRange,
  getPortfolioHistoryRanges,
  getPortfolioHistoryViewState,
  normalizePortfolioHistoryPoints,
  summarizePortfolioHistory
} from "./portfolio-history-view-model";

describe("portfolio history view model", () => {
  it("keeps range change unknown for the first corrected baseline", () => {
    expect(summarizePortfolioHistory([{ capturedAt: "2026-09-22T00:00:00Z", netWorthUsd: 399870, isPartial: false }]))
      .toMatchObject({ deltaUsd: null, deltaPercent: null, completePointCount: 1 });
  });
  it("uses interval-specific ranges and query parameters", () => {
    expect(getPortfolioHistoryRanges("hourly").map((range) => range.id)).toEqual(["24H", "7D", "30D"]);
    expect(getPortfolioHistoryRanges("daily").map((range) => range.id)).toEqual(["1M", "3M", "1Y", "2Y"]);
    expect(getDefaultPortfolioHistoryRange("hourly")).toBe("7D");
    expect(getDefaultPortfolioHistoryRange("daily")).toBe("3M");
    expect(buildPortfolioHistoryUrl("hourly", "24H")).toBe("/api/portfolio/history?interval=hourly&days=1");
    expect(buildPortfolioHistoryUrl("daily", "1Y")).toBe("/api/portfolio/history?interval=daily&days=365");
  });

  it("falls back to a valid range when the selected range belongs to another interval", () => {
    expect(buildPortfolioHistoryUrl("hourly", "1Y")).toBe("/api/portfolio/history?interval=hourly&days=1");
    expect(buildPortfolioHistoryUrl("daily", "24H")).toBe("/api/portfolio/history?interval=daily&days=30");
  });

  it("sorts, deduplicates, and rejects unusable chart points", () => {
    const points = normalizePortfolioHistoryPoints([
      { capturedAt: "2026-08-22T03:00:00Z", netWorthUsd: 120, isPartial: false },
      { capturedAt: "invalid", netWorthUsd: 500, isPartial: false },
      { capturedAt: "2026-08-22T01:00:00Z", netWorthUsd: 100, isPartial: false },
      { capturedAt: "2026-08-22T03:00:00Z", netWorthUsd: 125, isPartial: true },
      { capturedAt: "2026-08-22T02:00:00Z", netWorthUsd: Number.NaN, isPartial: false }
    ]);

    expect(points).toEqual([
      { capturedAt: "2026-08-22T01:00:00Z", netWorthUsd: 100, isPartial: false },
      { capturedAt: "2026-08-22T03:00:00Z", netWorthUsd: 125, isPartial: true }
    ]);
  });

  it("calculates headline change from complete points and excludes partial valuations", () => {
    expect(summarizePortfolioHistory([
      { capturedAt: "2026-08-22T00:00:00Z", netWorthUsd: 1, isPartial: true },
      { capturedAt: "2026-08-22T01:00:00Z", netWorthUsd: 100, isPartial: false },
      { capturedAt: "2026-08-22T02:00:00Z", netWorthUsd: 20, isPartial: true },
      { capturedAt: "2026-08-22T03:00:00Z", netWorthUsd: 125, isPartial: false },
      { capturedAt: "2026-08-22T04:00:00Z", netWorthUsd: 5, isPartial: true }
    ])).toEqual({
      firstUsd: 100,
      lastUsd: 125,
      deltaUsd: 25,
      deltaPercent: 25,
      partialCount: 3,
      pointCount: 5,
      completePointCount: 2
    });
  });

  it("carries the last complete value across partial and missing buckets", () => {
    const data = buildPortfolioHistoryChartData([
      { capturedAt: "2026-08-22T01:05:00Z", netWorthUsd: 100, isPartial: false },
      { capturedAt: "2026-08-22T02:10:00Z", netWorthUsd: 30, isPartial: true },
      { capturedAt: "2026-08-22T05:02:00Z", netWorthUsd: 120, isPartial: false }
    ], "hourly");

    expect(data.map((point) => ({
      valueUsd: point.valueUsd,
      gapReason: point.gapReason,
      missingBucketCount: point.missingBucketCount
    }))).toEqual([
      { valueUsd: 100, gapReason: null, missingBucketCount: 0 },
      { valueUsd: 100, gapReason: "partial", missingBucketCount: 0 },
      { valueUsd: 100, gapReason: "missing", missingBucketCount: 1 },
      { valueUsd: 100, gapReason: "missing", missingBucketCount: 1 },
      { valueUsd: 120, gapReason: null, missingBucketCount: 0 }
    ]);
  });

  it("fills the missing Taipei day without changing source records", () => {
    const points = [
      { date: "2026-10-01", capturedAt: "2026-10-01T03:37:00Z", netWorthUsd: 100, isPartial: false },
      { date: "2026-10-03", capturedAt: "2026-10-03T15:52:00Z", netWorthUsd: 110, isPartial: false }
    ];
    const before = structuredClone(points);
    const data = buildPortfolioHistoryChartData(points, "daily");
    expect(data.map((point) => point.valueUsd)).toEqual([100, 100, 110]);
    expect(data[1]).toMatchObject({
      capturedAt: "2026-10-01T16:00:00.000Z",
      carriedFrom: points[0].capturedAt
    });
    expect(points).toEqual(before);
    expect(summarizePortfolioHistory(points).pointCount).toBe(2);
  });

  it("extends a single trusted observation through missing trailing hours", () => {
    const points = [{ capturedAt: "2026-10-04T01:52:00Z", netWorthUsd: 100, isPartial: false }];
    const data = buildPortfolioHistoryChartData(points, "hourly", "2026-10-04T04:10:00Z");
    expect(data.map((point) => point.valueUsd)).toEqual([100, 100, 100, 100]);
    expect(data.at(-1)).toMatchObject({
      capturedAt: "2026-10-04T04:00:00.000Z", carriedFrom: points[0].capturedAt
    });
  });

  it("uses Taipei midnight for trailing daily buckets", () => {
    const points = [{ capturedAt: "2026-10-01T15:52:00Z", netWorthUsd: 100, isPartial: false }];
    expect(buildPortfolioHistoryChartData(points, "daily", "2026-10-03T16:10:00Z").map((p) => p.capturedAt))
      .toEqual(["2026-10-01T15:52:00Z", "2026-10-01T16:00:00.000Z", "2026-10-02T16:00:00.000Z", "2026-10-03T16:00:00.000Z"]);
  });

  it("never invents a baseline before the first complete observation", () => {
    const partial = { capturedAt: "2026-10-01T02:00:00Z", netWorthUsd: 1, isPartial: true };
    expect(buildPortfolioHistoryChartData([], "daily", "2026-10-04T02:00:00Z")).toEqual([]);
    expect(buildPortfolioHistoryChartData([partial], "daily", "2026-10-04T02:00:00Z")).toEqual([]);
    expect(buildPortfolioHistoryChartData([
      partial,
      { capturedAt: "2026-10-03T02:00:00Z", netWorthUsd: 100, isPartial: false }
    ], "daily")).toHaveLength(1);
  });

  it("replaces a carried value when a real observation arrives", () => {
    const first = { capturedAt: "2026-10-01T02:00:00Z", netWorthUsd: 100, isPartial: false };
    const next = { capturedAt: "2026-10-02T02:00:00Z", netWorthUsd: 105, isPartial: false };
    const data = buildPortfolioHistoryChartData([first, next], "daily", next.capturedAt);
    expect(data.map((point) => point.valueUsd)).toEqual([100, 105]);
    expect(data.every((point) => point.carriedFrom === null)).toBe(true);
  });

  it("detects missing hourly buckets without inventing values", () => {
    expect(findPortfolioHistoryGaps([
      { capturedAt: "2026-08-22T01:05:00Z", netWorthUsd: 100, isPartial: false },
      { capturedAt: "2026-08-22T02:59:00Z", netWorthUsd: 105, isPartial: false },
      { capturedAt: "2026-08-22T05:02:00Z", netWorthUsd: 110, isPartial: false }
    ], "hourly")).toEqual([{
      afterCapturedAt: "2026-08-22T02:59:00Z",
      beforeCapturedAt: "2026-08-22T05:02:00Z",
      missingBucketCount: 2
    }]);
  });

  it("uses calendar dates for daily gaps even when capture times vary", () => {
    expect(findPortfolioHistoryGaps([
      { date: "2026-08-20", capturedAt: "2026-08-20T01:00:00Z", netWorthUsd: 100, isPartial: false },
      { date: "2026-08-21", capturedAt: "2026-08-21T20:00:00Z", netWorthUsd: 105, isPartial: false },
      { date: "2026-08-23", capturedAt: "2026-08-23T01:00:00Z", netWorthUsd: 110, isPartial: false }
    ], "daily")).toEqual([{
      afterCapturedAt: "2026-08-21T20:00:00Z",
      beforeCapturedAt: "2026-08-23T01:00:00Z",
      missingBucketCount: 1
    }]);
  });

  it("distinguishes loading, error, empty, single-point, and ready states", () => {
    expect(getPortfolioHistoryViewState({ loading: true, error: null, pointCount: 3, completePointCount: 3 })).toBe("loading");
    expect(getPortfolioHistoryViewState({ loading: false, error: "Unavailable", pointCount: 3, completePointCount: 3 })).toBe("error");
    expect(getPortfolioHistoryViewState({ loading: false, error: null, pointCount: 0, completePointCount: 0 })).toBe("empty");
    expect(getPortfolioHistoryViewState({ loading: false, error: null, pointCount: 2, completePointCount: 0 })).toBe("partial");
    expect(getPortfolioHistoryViewState({ loading: false, error: null, pointCount: 3, completePointCount: 1 })).toBe("single");
    expect(getPortfolioHistoryViewState({ loading: false, error: null, pointCount: 3, completePointCount: 2 })).toBe("ready");
  });
});
