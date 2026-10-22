import { describe, expect, it } from "vitest";
import type { PortfolioHistoryPoint } from "./portfolio-history";
import { answerPortfolioQuestion } from "./portfolio-assistant";

const points: PortfolioHistoryPoint[] = [
  { date: "2026-08-11", capturedAt: "2026-08-11T01:15:00Z", netWorthUsd: 100, exchangesUsd: 60, walletsUsd: 40, banksUsd: 0, sourceCount: 4, isPartial: false, deltaUsd: null, deltaPercent: null },
  { date: "2026-08-12", capturedAt: "2026-08-12T01:15:00Z", netWorthUsd: 102, exchangesUsd: 61, walletsUsd: 41, banksUsd: 0, sourceCount: 4, isPartial: false, deltaUsd: 2, deltaPercent: 2 }
];

describe("portfolio assistant", () => {
  it("answers daily change questions from history", () => {
    expect(answerPortfolioQuestion("What changed today?", points, null).answer).toContain("2.00%");
  });

  it("answers trend questions across the available range", () => {
    expect(answerPortfolioQuestion("long term trend", points, null).answer).toContain("2.00%");
  });

  it("excludes partial endpoints from period trends", () => {
    const history: PortfolioHistoryPoint[] = [
      { ...points[0], capturedAt: "2026-08-10T01:15:00Z", netWorthUsd: 10, isPartial: true },
      points[0],
      points[1],
      { ...points[1], capturedAt: "2026-08-13T01:15:00Z", netWorthUsd: 5, isPartial: true, deltaUsd: null, deltaPercent: null }
    ];

    const answer = answerPortfolioQuestion("long term trend", history, null);

    expect(answer.answer).toContain("2.00%");
    expect(answer.answer).toContain("2 complete daily snapshots");
    expect(answer.highlights).toContain(
      "Latest observed snapshot is partial; comparisons use the last complete snapshot"
    );
  });

  it("returns saved attention items", () => {
    const answer = answerPortfolioQuestion("any alerts?", points, {
      date: "2026-08-12", generatedAt: "2026-08-12T01:16:00Z", summary: "Summary", alerts: ["Coverage changed."], currentUsd: 102, deltaUsd: 2, deltaPercent: 2, generator: "rules", model: null
    });
    expect(answer.answer).toContain("Coverage changed");
  });

  it("does not present a stale report as the latest daily change", () => {
    const answer = answerPortfolioQuestion("What changed?", points, {
      date: "2026-08-11", generatedAt: "2026-08-11T01:16:00Z", summary: "Old summary", alerts: [], currentUsd: 100, deltaUsd: null, deltaPercent: null, generator: "rules", model: null
    });

    expect(answer.answer).toContain("2.00%");
    expect(answer.answer).not.toContain("Old summary");
  });

  it("does not repeat the saved daily summary", () => {
    const answer = answerPortfolioQuestion("What changed?", points, {
      date: "2026-08-12", generatedAt: "2026-08-12T01:16:00Z", summary: "Estimated net worth increased 2.00% from the previous daily snapshot.", alerts: [], currentUsd: 102, deltaUsd: 2, deltaPercent: 2, generator: "rules", model: null
    });

    expect(answer.answer).toBe("Estimated net worth increased 2.00% from the previous daily snapshot.");
  });
});
