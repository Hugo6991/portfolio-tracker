import { describe, expect, it } from "vitest";
import type { CexExchange, CexHistoryPoint, CexStatus } from "../../lib/cex";
import {
  buildCexHistoryUrl,
  buildCexTotalHistory,
  getCexHistoryRanges,
  summarizeCexTotalHistory
} from "./cex-summary-view-model";
import { summarizeCurrentCexSnapshot } from "../../lib/cex-history";

const exchanges = ["binance", "okx", "bitget", "htx", "gate"] as const;

function bucket(
  bucketAt: string,
  values: Partial<Record<CexExchange, number>> = {},
  statuses: Partial<Record<CexExchange, CexStatus>> = {}
): CexHistoryPoint[] {
  return exchanges.flatMap((exchange) => values[exchange] === undefined ? [] : [{
    exchange,
    bucket_at: bucketAt,
    captured_at: bucketAt,
    total_usd: values[exchange]!,
    status: statuses[exchange] ?? "live"
  }]);
}

describe("CEX summary view model", () => {
  it("uses bounded history ranges and coarser sampling for longer charts", () => {
    expect(getCexHistoryRanges()).toEqual([
      { id: "24H", days: 1, intervalMinutes: 15 },
      { id: "7D", days: 7, intervalMinutes: 60 },
      { id: "30D", days: 30, intervalMinutes: 240 }
    ]);
    expect(buildCexHistoryUrl("24H")).toBe("/api/cex/history?days=1&interval=15");
    expect(buildCexHistoryUrl("30D")).toBe("/api/cex/history?days=30&interval=240");
  });

  it("adds the five live exchanges into one total series", () => {
    const data = buildCexTotalHistory([
      ...bucket("2026-09-06T00:00:00.000Z", { binance: 100, okx: 50, bitget: 25, htx: 20, gate: 15 }),
      ...bucket("2026-09-06T01:00:00.000Z", { binance: 110, okx: 55, bitget: 25, htx: 20, gate: 20 })
    ], "7D");

    expect(data.map((point) => ({ totalUsd: point.totalUsd, gapReason: point.gapReason }))).toEqual([
      { totalUsd: 210, gapReason: null },
      { totalUsd: 230, gapReason: null }
    ]);
  });

  it("turns a partial or missing exchange into a chart gap instead of a false drop", () => {
    const data = buildCexTotalHistory([
      ...bucket("2026-09-06T00:00:00.000Z", { binance: 100, okx: 50, bitget: 25, htx: 20, gate: 15 }),
      ...bucket(
        "2026-09-06T01:00:00.000Z",
        { binance: 100, okx: 50, bitget: 25, htx: 20, gate: 0.6 },
        { gate: "partial" }
      ),
      ...bucket("2026-09-06T02:00:00.000Z", { binance: 100, okx: 50, bitget: 25, htx: 20 })
    ], "7D");

    expect(data.map((point) => ({
      totalUsd: point.totalUsd,
      completeSourceCount: point.completeSourceCount,
      gapReason: point.gapReason
    }))).toEqual([
      { totalUsd: 210, completeSourceCount: 5, gapReason: null },
      { totalUsd: null, completeSourceCount: 4, gapReason: "partial" },
      { totalUsd: null, completeSourceCount: 4, gapReason: "partial" }
    ]);
  });

  it("keeps a complete aligned run when a later exchange-only row exists in the same chart interval", () => {
    const data = buildCexTotalHistory([
      ...bucket("2026-09-06T01:00:00.000Z", { binance: 100, okx: 50, bitget: 25, htx: 20, gate: 15 }),
      {
        exchange: "gate",
        bucket_at: "2026-09-06T01:45:00.000Z",
        captured_at: "2026-09-06T01:46:00.000Z",
        total_usd: 30,
        status: "live"
      }
    ], "7D");

    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      capturedAt: "2026-09-06T01:00:00.000Z",
      totalUsd: 210,
      completeSourceCount: 5,
      gapReason: null
    });
  });

  it("never combines exchanges from different scheduled runs into one total", () => {
    const data = buildCexTotalHistory([
      ...bucket("2026-09-06T01:00:00.000Z", { binance: 100, okx: 50, bitget: 25 }),
      ...bucket("2026-09-06T01:15:00.000Z", { htx: 20, gate: 15 })
    ], "7D");

    expect(data).toEqual([{
      capturedAt: "2026-09-06T01:00:00.000Z",
      totalUsd: null,
      completeSourceCount: 3,
      expectedSourceCount: 5,
      gapReason: "partial",
      missingBucketCount: 0
    }]);
  });

  it("inserts a null point when scheduled history buckets are absent", () => {
    const data = buildCexTotalHistory([
      ...bucket("2026-09-06T00:00:00.000Z", { binance: 100, okx: 50, bitget: 25, htx: 20, gate: 15 }),
      ...bucket("2026-09-06T03:00:00.000Z", { binance: 110, okx: 55, bitget: 25, htx: 20, gate: 20 })
    ], "7D");

    expect(data.map((point) => ({ gapReason: point.gapReason, missingBucketCount: point.missingBucketCount }))).toEqual([
      { gapReason: null, missingBucketCount: 0 },
      { gapReason: "missing", missingBucketCount: 2 },
      { gapReason: null, missingBucketCount: 0 }
    ]);
  });

  it("compares the selected range start with the latest CEX total", () => {
    expect(summarizeCexTotalHistory([
      { capturedAt: "2026-09-06T00:00:00.000Z", totalUsd: 200, completeSourceCount: 5, expectedSourceCount: 5, gapReason: null, missingBucketCount: 0 },
      { capturedAt: "2026-09-06T01:00:00.000Z", totalUsd: null, completeSourceCount: 4, expectedSourceCount: 5, gapReason: "partial", missingBucketCount: 0 },
      { capturedAt: "2026-09-06T02:00:00.000Z", totalUsd: 220, completeSourceCount: 5, expectedSourceCount: 5, gapReason: null, missingBucketCount: 0 }
    ], 230)).toEqual({
      firstUsd: 200,
      lastUsd: 220,
      deltaUsd: 30,
      deltaPercent: 15,
      completePointCount: 2,
      gapCount: 1
    });
  });

  it("has no range return for a single corrected CEX baseline", () => {
    expect(summarizeCexTotalHistory([
      { capturedAt: "2026-09-22T00:00:00Z", totalUsd: 1000, completeSourceCount: 5, expectedSourceCount: 5, gapReason: null, missingBucketCount: 0 }
    ], 1000)).toMatchObject({ deltaUsd: null, deltaPercent: null });
  });

  it("counts every absent interval represented by a missing-history marker", () => {
    expect(summarizeCexTotalHistory([
      { capturedAt: "2026-09-06T00:00:00.000Z", totalUsd: 200, completeSourceCount: 5, expectedSourceCount: 5, gapReason: null, missingBucketCount: 0 },
      { capturedAt: "2026-09-06T02:00:00.000Z", totalUsd: null, completeSourceCount: 0, expectedSourceCount: 5, gapReason: "missing", missingBucketCount: 3 },
      { capturedAt: "2026-09-06T04:00:00.000Z", totalUsd: 220, completeSourceCount: 5, expectedSourceCount: 5, gapReason: null, missingBucketCount: 0 }
    ], 220).gapCount).toBe(3);
  });

  it("requires the current live sources to share the same scheduled bucket", () => {
    const sources = exchanges.map((exchange, index) => ({
      exchange,
      name: exchange,
      status: "live" as const,
      capturedAt: `2026-09-06T01:0${index}:00.000Z`,
      bucketAt: index === 4 ? "2026-09-06T01:15:00.000Z" : "2026-09-06T01:00:00.000Z",
      valueUsd: 100,
      itemCount: 0,
      accounts: [],
      holdings: [],
      errors: []
    }));

    expect(summarizeCurrentCexSnapshot(sources)).toMatchObject({
      complete: false,
      expectedSourceCount: 5,
      liveSourceCount: 5,
      capturedAtStart: "2026-09-06T01:00:00.000Z",
      capturedAtEnd: "2026-09-06T01:04:00.000Z"
    });

    sources[4].bucketAt = "2026-09-06T01:00:00.000Z";
    expect(summarizeCurrentCexSnapshot(sources).complete).toBe(true);
  });
});
