import type { PortfolioHistoryPoint, PortfolioReport } from "./portfolio-history";

export type PortfolioAssistantAnswer = {
  answer: string;
  highlights: string[];
  generatedBy: "rules" | "llm";
  model: string | null;
};

export function buildAssistantContext(
  points: PortfolioHistoryPoint[],
  latestReport: PortfolioReport | null
) {
  const completePoints = points.filter((point) => !point.isPartial);
  const latest = completePoints.at(-1) ?? null;
  const first = completePoints[0] ?? null;
  const periodPercent = latest && first && first.netWorthUsd !== 0
    ? ((latest.netWorthUsd - first.netWorthUsd) / first.netWorthUsd) * 100
    : null;
  const currentReport = latestReport?.date === latest?.date ? latestReport : null;
  return {
    latest,
    first,
    periodPercent,
    latestReport: currentReport,
    completePointCount: completePoints.length,
    latestObservedIsPartial: points.at(-1)?.isPartial === true
  };
}

export function answerPortfolioQuestion(
  question: string,
  points: PortfolioHistoryPoint[],
  latestReport: PortfolioReport | null
): PortfolioAssistantAnswer {
  const context = buildAssistantContext(points, latestReport);
  const latest = context.latest;
  if (!latest) {
    return {
      answer: "No complete daily snapshots are available yet. The first complete sync will establish the tracking baseline.",
      highlights: [],
      generatedBy: "rules",
      model: null
    };
  }

  const normalized = question.toLowerCase();
  const daily = latest.deltaPercent;
  const highlights = [
    `${context.completePointCount} complete of ${points.length} daily snapshots tracked`,
    `${latest.sourceCount} live data sources`,
    context.latestObservedIsPartial
      ? "Latest observed snapshot is partial; comparisons use the last complete snapshot"
      : "Latest snapshot has full coverage"
  ];

  if (/alert|attention|risk|注意|提醒|風險|风险/.test(normalized)) {
    const alerts = context.latestReport?.alerts || [];
    return {
      answer: alerts.length
        ? `Attention items: ${alerts.join(" ")}`
        : "No automated attention items were detected in the latest daily snapshot. This monitor reports data changes, not investment advice.",
      highlights,
      generatedBy: "rules",
      model: null
    };
  }

  if (/long|trend|history|month|period|長期|长期|趨勢|趋势|歷史|历史/.test(normalized)) {
    const period = context.periodPercent;
    return {
      answer: period === null
        ? "More daily snapshots are needed to describe a longer-term trend."
        : `Across ${context.completePointCount} complete daily snapshots, estimated net worth ${period >= 0 ? "increased" : "decreased"} ${Math.abs(period).toFixed(2)}%.`,
      highlights,
      generatedBy: "rules",
      model: null
    };
  }

  const dailySentence = daily === null
    ? "Today establishes the daily comparison baseline."
    : `The latest daily snapshot ${daily >= 0 ? "increased" : "decreased"} ${Math.abs(daily).toFixed(2)}% from the previous day.`;
  return {
    answer: context.latestReport?.summary || dailySentence,
    highlights,
    generatedBy: "rules",
    model: null
  };
}
