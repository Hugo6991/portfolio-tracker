import { describe, expect, it } from "vitest";
import type { LivePortfolioSnapshot, LiveSourceStatus } from "../live-portfolio";
import {
  evaluatePortfolioSnapshot,
  getPortfolioCollapseConfirmation,
  getPortfolioSnapshotQuality,
  summarizePortfolioCandidate,
  shouldUseCachedPortfolioSnapshot
} from "../portfolio-snapshot-policy";

function snapshot(statuses: LiveSourceStatus[]): LivePortfolioSnapshot {
  return {
    generatedAt: "2026-07-24T00:00:00.000Z",
    netWorthUsd: 1,
    liveValueUsd: 1,
    previewValueUsd: 0,
    groups: { exchangesUsd: 1, walletsUsd: 0, banksUsd: 0 },
    sources: statuses.map((status, index) => ({
      id: `source-${index}`,
      name: `Source ${index}`,
      kind: "exchange",
      status,
      valueUsd: status === "error" ? 0 : 1,
      itemCount: status === "error" ? 0 : 1,
      updatedAt: "2026-07-24T00:00:00.000Z",
      detail: status
    })),
    holdings: [],
    wallets: [],
    connectedSourceCount: statuses.filter((status) => status === "live" || status === "partial").length,
    expectedSourceCount: statuses.length,
    isPartial: statuses.some((status) => status === "partial" || status === "error"),
    errors: []
  };
}

describe("portfolio snapshot quality", () => {
  it("prefers a cached snapshot with healthier source coverage", () => {
    const live = snapshot(["live", "error", "preview"]);
    const cached = snapshot(["live", "live", "preview"]);

    expect(getPortfolioSnapshotQuality(cached)).toBeGreaterThan(getPortfolioSnapshotQuality(live));
    expect(shouldUseCachedPortfolioSnapshot(live, cached, 60, 86_400)).toBe(true);
  });

  it("keeps a newer live result when its source quality is equal", () => {
    const live = snapshot(["live", "partial", "preview"]);
    const cached = snapshot(["live", "partial", "preview"]);

    expect(shouldUseCachedPortfolioSnapshot(live, cached, 60, 86_400)).toBe(false);
  });

  it("does not reuse a snapshot past the stale safety window", () => {
    const live = snapshot(["error"]);
    const cached = snapshot(["live"]);

    expect(shouldUseCachedPortfolioSnapshot(live, cached, 601, 600)).toBe(false);
  });

  it("accepts a fully reconciled aggregate", () => {
    const candidate = completeSnapshot();

    expect(evaluatePortfolioSnapshot(candidate)).toEqual({
      accepted: true,
      status: "complete",
      reasons: []
    });
  });

  it("rejects a partial source so it cannot replace last-known-good", () => {
    const candidate = completeSnapshot();
    candidate.sources[0].status = "partial";
    candidate.isPartial = true;
    candidate.errors = [{ source: "Exchange", message: "rate limited" }];

    const result = evaluatePortfolioSnapshot(candidate);

    expect(result.accepted).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      { code: "incomplete-source", sourceId: "exchange" },
      { code: "reported-partial" },
      { code: "reported-errors" }
    ]));
  });

  it("accepts a reconciled aggregate when every incomplete source has a fresh fallback", () => {
    const candidate = completeSnapshot();
    candidate.sources[0].status = "partial";
    candidate.sources[0].fallback = {
      lastGoodAt: "2026-08-21T23:45:00.000Z",
      attemptStatus: "error"
    };
    candidate.isPartial = true;
    candidate.errors = [{ source: "Exchange", message: "rate limited" }];

    expect(evaluatePortfolioSnapshot(candidate)).toEqual({
      accepted: true,
      status: "degraded",
      reasons: []
    });
  });

  it("rejects a source that disappears relative to the previous aggregate", () => {
    const previous = completeSnapshot();
    const candidate = completeSnapshot();
    candidate.sources = candidate.sources.filter((source) => source.id !== "wallet");
    candidate.groups.walletsUsd = 0;
    candidate.liveValueUsd = 60;
    candidate.netWorthUsd = 70;
    candidate.connectedSourceCount = 1;
    candidate.expectedSourceCount = 1;

    const result = evaluatePortfolioSnapshot(candidate, previous);

    expect(result.reasons).toContainEqual({ code: "missing-source", sourceId: "wallet" });
  });

  it("rejects totals that do not reconcile even when every source says live", () => {
    const candidate = completeSnapshot();
    candidate.netWorthUsd = 1;

    const result = evaluatePortfolioSnapshot(candidate);

    expect(result.reasons).toEqual(expect.arrayContaining([
      { code: "group-total-mismatch" },
      { code: "source-total-mismatch" }
    ]));
  });

  it("rejects an internally consistent live source that collapses to zero", () => {
    const previous = completeSnapshot();
    const candidate = completeSnapshot();
    candidate.sources[0].valueUsd = 0;
    candidate.sources[0].itemCount = 0;
    candidate.groups.exchangesUsd = 0;
    candidate.liveValueUsd = 40;
    candidate.netWorthUsd = 50;

    const result = evaluatePortfolioSnapshot(candidate, previous);

    expect(result.reasons).toContainEqual({ code: "value-collapse", sourceId: "exchange" });
  });

  it("rejects a severe but nonzero source drop that is not recovered elsewhere", () => {
    const previous = completeSnapshot();
    const candidate = completeSnapshot();
    candidate.sources[0].valueUsd = 6;
    candidate.sources[0].itemCount = 1;
    candidate.groups.exchangesUsd = 6;
    candidate.liveValueUsd = 46;
    candidate.netWorthUsd = 56;

    const result = evaluatePortfolioSnapshot(candidate, previous);

    expect(result.reasons).toContainEqual({ code: "value-collapse", sourceId: "exchange" });
    expect(result.accepted).toBe(false);
  });

  it("allows a tracked transfer when one source empties but aggregate value is preserved", () => {
    const previous = completeSnapshot();
    const candidate = completeSnapshot();
    candidate.sources[0].valueUsd = 0;
    candidate.sources[0].itemCount = 0;
    candidate.sources[1].valueUsd = 100;
    candidate.groups.exchangesUsd = 0;
    candidate.groups.walletsUsd = 100;

    expect(evaluatePortfolioSnapshot(candidate, previous).accepted).toBe(true);
  });

  it("rejects an all-zero bootstrap even when every empty source reports live", () => {
    const candidate = completeSnapshot();
    candidate.netWorthUsd = 0;
    candidate.liveValueUsd = 0;
    candidate.previewValueUsd = 0;
    candidate.groups = { exchangesUsd: 0, walletsUsd: 0, banksUsd: 0 };
    candidate.sources.forEach((source) => {
      source.valueUsd = 0;
      source.itemCount = 0;
    });

    expect(evaluatePortfolioSnapshot(candidate).reasons).toContainEqual({ code: "empty-bootstrap" });
  });

  it("confirms a consistent collapse only after three separated attempts", () => {
    const previous = completeSnapshot();
    const candidate = completeSnapshot();
    candidate.sources[0].valueUsd = 0;
    candidate.sources[0].itemCount = 0;
    candidate.groups.exchangesUsd = 0;
    candidate.liveValueUsd = 40;
    candidate.netWorthUsd = 50;
    const evaluation = evaluatePortfolioSnapshot(candidate, previous);
    const summary = summarizePortfolioCandidate(candidate);
    const first = getPortfolioCollapseConfirmation({
      evaluation,
      candidate: summary,
      previous: null,
      now: Date.parse("2026-08-22T00:00:00.000Z")
    });
    const second = getPortfolioCollapseConfirmation({
      evaluation,
      candidate: summary,
      previous: {
        completedAt: "2026-08-22T00:00:00.000Z",
        candidate: summary,
        confirmationCount: first.count
      },
      now: Date.parse("2026-08-22T00:15:00.000Z")
    });
    const third = getPortfolioCollapseConfirmation({
      evaluation,
      candidate: summary,
      previous: {
        completedAt: "2026-08-22T00:15:00.000Z",
        candidate: summary,
        confirmationCount: second.count
      },
      now: Date.parse("2026-08-22T00:30:00.000Z")
    });

    expect(first).toEqual({ confirmed: false, count: 1 });
    expect(second).toEqual({ confirmed: false, count: 2 });
    expect(third).toEqual({ confirmed: true, count: 3 });
  });
});

function completeSnapshot(): LivePortfolioSnapshot {
  const generatedAt = "2026-08-22T00:00:00.000Z";
  return {
    generatedAt,
    netWorthUsd: 110,
    liveValueUsd: 100,
    previewValueUsd: 10,
    groups: { exchangesUsd: 60, walletsUsd: 40, banksUsd: 10 },
    sources: [
      {
        id: "exchange",
        name: "Exchange",
        kind: "exchange",
        status: "live",
        valueUsd: 60,
        itemCount: 2,
        updatedAt: generatedAt,
        detail: "live"
      },
      {
        id: "wallet",
        name: "Wallet",
        kind: "wallet",
        status: "live",
        valueUsd: 40,
        itemCount: 2,
        updatedAt: generatedAt,
        detail: "live"
      },
      {
        id: "bank",
        name: "Bank",
        kind: "bank",
        status: "preview",
        valueUsd: 10,
        itemCount: 1,
        updatedAt: generatedAt,
        detail: "preview"
      }
    ],
    holdings: [],
    wallets: [],
    connectedSourceCount: 2,
    expectedSourceCount: 2,
    isPartial: false,
    errors: []
  };
}
