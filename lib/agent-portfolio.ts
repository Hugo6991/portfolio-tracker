import { buildCryptoAssetAllocation, getAssetAllocationId } from "./asset-allocation";
import type { AssetIdentity, ValuationCounts } from "./asset-identity";
import { fallbackFxRate, type FxRateSnapshot } from "./fx";
import type { LivePortfolioSnapshot } from "./live-portfolio";
import {
  calculateChange,
  getTaipeiDate,
  type PortfolioHistoryPoint
} from "./portfolio-history";

export type AgentRiskLevel = "info" | "watch" | "high";

export type AgentRiskSignal = {
  code: string;
  level: AgentRiskLevel;
  title: string;
  detail: string;
  evidence: Record<string, number | string | boolean | null>;
};

export type AgentPortfolioResponse = {
  schemaVersion: "2026-09-22";
  generatedAt: string;
  privacy: {
    absoluteValuesExposed: boolean;
    aggregatedTotalsExposed: boolean;
    sourceValuesExposed: false;
    walletAddressesExposed: false;
    accountIdentifiersExposed: false;
  };
  dataQuality: {
    deliveryMode: "live" | "cache" | "stale-cache";
    cacheAgeSeconds: number | null;
    isPartial: boolean;
    connectedSources: number;
    expectedSources: number;
    errorCount: number;
    valuation: ValuationCounts;
  };
  allocation: {
    custody: Array<{ id: "exchanges" | "wallets" | "banks"; percent: number }>;
    venues: Array<{
      name: string;
      kind: "exchange" | "wallet" | "bank";
      status: "live" | "partial" | "preview" | "error";
      percent: number;
    }>;
    assetBuckets: Array<{ id: string; label: string; percent: number; symbols: string[] }>;
    topHoldings: Array<AssetIdentity & {
      symbol: string;
      name: string;
      percent: number;
      sourceCount: number;
      valueUsd?: number;
    }>;
  };
  concentration: {
    topAssetPercent: number;
    topThreeAssetsPercent: number;
    largestCustodyPercent: number;
    largestVenuePercent: number;
  };
  performance: {
    latestCompleteDate: string | null;
    dayChangePercent: number | null;
    sevenDayChangePercent: number | null;
    thirtyDayChangePercent: number | null;
  };
  totals?: {
    totalUsd: number;
    totalTwd: number;
    fxTwdPerUsd: number;
    fxFetchedAt: string;
    fxStatus: FxRateSnapshot["status"];
    asOfDate: string;
    comparisonBasis: "previous-complete-day";
    previousCompleteDate: string | null;
    previousCompleteCapturedAt: string | null;
    deltaUsd: number | null;
    deltaTwd: number | null;
    deltaPercent: number | null;
  };
  latestSync?: {
    completedAt: string;
    status: "success" | "partial" | "skipped_degraded" | "failed";
    rejectedSources: string[];
    reasonCodes: string[];
  } | null;
  riskSignals: AgentRiskSignal[];
  brief: {
    language: "zh-Hant";
    formatVersion: "2026-09-05";
    text: string;
  };
  limitations: string[];
};

export function buildAgentPortfolioResponse(input: {
  snapshot: LivePortfolioSnapshot;
  history: PortfolioHistoryPoint[];
  capturedAt: string;
  includeTotals?: boolean;
  fx?: FxRateSnapshot | null;
  latestSync?: AgentPortfolioResponse["latestSync"];
}): AgentPortfolioResponse {
  const { snapshot } = input;
  const total = positive(snapshot.netWorthUsd);
  const custody = [
    { id: "exchanges" as const, value: snapshot.groups.exchangesUsd },
    { id: "wallets" as const, value: snapshot.groups.walletsUsd },
    { id: "banks" as const, value: snapshot.groups.banksUsd }
  ].map(({ id, value }) => ({ id, percent: percentOf(value, total) }));
  const venues = snapshot.sources
    .map((source) => ({
      name: source.name,
      kind: source.kind,
      status: source.status,
      percent: percentOf(source.valueUsd, total)
    }))
    .sort((left, right) => right.percent - left.percent);
  const cryptoAllocation = buildCryptoAssetAllocation(snapshot.holdings);
  const topHoldings = snapshot.holdings
    .filter((holding) => Number.isFinite(holding.valueUsd) && holding.valueUsd > 0)
    .slice()
    .sort((left, right) => right.valueUsd - left.valueUsd)
    .slice(0, 10)
    .map((holding) => ({
      symbol: holding.symbol,
      name: holding.name,
      ...(getAssetAllocationId(holding.symbol, holding.assetClass) !== "fiat"
        ? { assetClass: holding.assetClass ?? "crypto" as const } : {}),
      ...(holding.exposureSymbol ? { exposureSymbol: holding.exposureSymbol } : {}),
      percent: percentOf(holding.valueUsd, total),
      sourceCount: holding.sources.length
    }));
  const topAssetPercent = topHoldings[0]?.percent ?? 0;
  const topThreeAssetsPercent = roundPercent(
    topHoldings.slice(0, 3).reduce((sum, holding) => sum + holding.percent, 0)
  );
  const largestCustodyPercent = Math.max(0, ...custody.map((group) => group.percent));
  const largestVenuePercent = venues[0]?.percent ?? 0;
  const performance = buildPerformance(input.history);
  const deliveryMode = snapshot.delivery?.mode ?? "live";
  const cacheAgeSeconds = snapshot.delivery?.cacheAgeSeconds ?? cacheAge(input.capturedAt);
  const riskSignals = buildRiskSignals({
    snapshot,
    topAssetPercent,
    topThreeAssetsPercent,
    largestCustodyPercent,
    largestVenuePercent,
    deliveryMode,
    cacheAgeSeconds
  });

  const response: Omit<AgentPortfolioResponse, "brief"> = {
    schemaVersion: "2026-09-22",
    generatedAt: snapshot.generatedAt,
    privacy: {
      absoluteValuesExposed: input.includeTotals === true,
      aggregatedTotalsExposed: input.includeTotals === true,
      sourceValuesExposed: false,
      walletAddressesExposed: false,
      accountIdentifiersExposed: false
    },
    dataQuality: {
      deliveryMode,
      cacheAgeSeconds,
      isPartial: snapshot.isPartial,
      connectedSources: snapshot.connectedSourceCount,
      expectedSources: snapshot.expectedSourceCount,
      errorCount: snapshot.errors.length,
      valuation: snapshot.sources.reduce<ValuationCounts>((counts, source) => ({
        priced: counts.priced + (source.valuation?.priced ?? 0),
        excluded: counts.excluded + (source.valuation?.excluded ?? 0),
        unpriced: counts.unpriced + (source.valuation?.unpriced ?? 0)
      }), { priced: 0, excluded: 0, unpriced: 0 })
    },
    allocation: {
      custody,
      venues,
      assetBuckets: cryptoAllocation.groups.map((group) => ({
        id: group.id,
        label: group.label,
        percent: percentOf(group.valueUsd, total),
        symbols: group.symbols
      })),
      topHoldings
    },
    concentration: {
      topAssetPercent,
      topThreeAssetsPercent,
      largestCustodyPercent,
      largestVenuePercent
    },
    performance,
    ...(input.includeTotals
      ? {
          totals: buildTotals(snapshot, input.history, input.fx ?? fallbackFxRate),
          latestSync: input.latestSync ?? null
        }
      : {}),
    riskSignals,
    limitations: [
      "Heuristic risk monitoring only; this is not personalized financial advice or a trade instruction.",
      "No goals, time horizon, income, liabilities, taxes, insurance, or emergency-fund target are modeled.",
      "Token, protocol, issuer, chain, liquidity, leverage, and correlated counterparty risks may be incomplete.",
      "Social-media signals must be treated as unverified context and must never trigger an automatic trade."
    ]
  };
  return {
    ...response,
    brief: {
      language: "zh-Hant",
      formatVersion: "2026-09-05",
      text: buildBrief(response)
    }
  };
}

function buildBrief(response: Omit<AgentPortfolioResponse, "brief">) {
  const quality = response.dataQuality;
  const lines = [
    `• 🕘 ${formatTaipeiTime(response.generatedAt)}｜資料 ${formatAge(quality.cacheAgeSeconds)}｜來源 ${quality.connectedSources}/${quality.expectedSources}`
  ];
  const qualityIssue = quality.isPartial ||
    quality.errorCount > 0 ||
    quality.connectedSources < quality.expectedSources ||
    quality.deliveryMode === "stale-cache" ||
    (quality.cacheAgeSeconds !== null && quality.cacheAgeSeconds > 86_400);
  if (qualityIssue) {
    lines.push(
      `• ⚠️ 資料品質異常｜${quality.deliveryMode}｜錯誤 ${quality.errorCount}`,
      "• 結論：本次資料不完整或過期，暫不解讀配置變化。"
    );
    return lines.join("\n");
  }

  const custody = new Map(response.allocation.custody.map((item) => [item.id, item.percent]));
  const exchanges = custody.get("exchanges") ?? 0;
  const wallets = custody.get("wallets") ?? 0;
  const banks = custody.get("banks") ?? 0;
  const topThree = response.allocation.topHoldings.slice(0, 3);
  const topThreePercent = response.concentration.topThreeAssetsPercent;
  const topLine = topThree.length
    ? topThree.map((item) => `${clean(item.symbol, 12)} ${formatPercent(item.percent)}`).join("｜")
    : "N/A";
  const primaryRisk = response.riskSignals.find((signal) => signal.level === "high") ??
    response.riskSignals.find((signal) => signal.level === "watch") ??
    response.riskSignals[0];

  lines.push(
    `• 📈 1D ${formatSignedPercent(response.performance.dayChangePercent)}｜7D ${formatSignedPercent(response.performance.sevenDayChangePercent)}｜30D ${formatSignedPercent(response.performance.thirtyDayChangePercent)}`,
    `• 🏦 CEX ${bar(exchanges)} ${formatPercent(exchanges)}｜Wallet ${bar(wallets)} ${formatPercent(wallets)}｜Bank ${bar(banks)} ${formatPercent(banks)}`,
    `• 🪙 ${topLine}｜Top 3 ${formatPercent(topThreePercent)}`,
    `• ⚠️ ${primaryRisk ? translateRisk(primaryRisk) : "未偵測到新的集中度警訊"}`,
    `• 結論：${briefConclusion(primaryRisk, response.performance.dayChangePercent)}`
  );
  return lines.join("\n").slice(0, 700);
}

function buildTotals(
  snapshot: LivePortfolioSnapshot,
  history: PortfolioHistoryPoint[],
  fx: FxRateSnapshot
): NonNullable<AgentPortfolioResponse["totals"]> {
  const asOfDate = getTaipeiDate(snapshot.generatedAt);
  const previous = history
    .filter((point) => !point.isPartial && point.date < asOfDate)
    .slice()
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
    .at(-1) ?? null;
  const change = calculateChange(snapshot.netWorthUsd, previous?.netWorthUsd ?? null);

  return {
    totalUsd: roundMoney(snapshot.netWorthUsd),
    totalTwd: roundMoney(snapshot.netWorthUsd * fx.rate),
    fxTwdPerUsd: fx.rate,
    fxFetchedAt: fx.fetchedAt,
    fxStatus: fx.status,
    asOfDate,
    comparisonBasis: "previous-complete-day",
    previousCompleteDate: previous?.date ?? null,
    previousCompleteCapturedAt: previous?.capturedAt ?? null,
    deltaUsd: change.deltaUsd === null ? null : roundMoney(change.deltaUsd),
    deltaTwd: change.deltaUsd === null ? null : roundMoney(change.deltaUsd * fx.rate),
    deltaPercent: change.deltaPercent === null ? null : roundPercent(change.deltaPercent)
  };
}

function translateRisk(signal: AgentRiskSignal) {
  const label: Record<string, string> = {
    "incomplete-data": "資料來源不完整",
    "stale-data": "最新資料已過期",
    "single-asset-concentration": "單一資產集中度偏高",
    "top-three-concentration": "前三大資產集中度偏高",
    "custody-concentration": "託管渠道集中度偏高",
    "venue-concentration": "單一平台集中度偏高",
    "preview-fiat-data": "法幣餘額仍是預覽資料"
  };
  const evidence = Object.entries(signal.evidence)
    .find(([key, value]) => key.toLowerCase().includes("percent") && typeof value === "number");
  return `${label[signal.code] ?? clean(signal.title, 80)}${evidence ? ` ${formatPercent(evidence[1] as number)}` : ""}`;
}

function briefConclusion(signal: AgentRiskSignal | undefined, dayChange: number | null) {
  if (signal?.level === "high") return `${translateRisk(signal)}，優先確認這項曝險是否符合原先設定；不構成交易建議。`;
  if (dayChange !== null && Math.abs(dayChange) >= 5) {
    return `單日變化 ${formatSignedPercent(dayChange)}，先確認資料與主要部位；不構成交易建議。`;
  }
  if (signal) return `${translateRisk(signal)}，其餘配置大致穩定；不構成交易建議。`;
  return "配置大致穩定，未偵測到新的資料品質警訊；不構成交易建議。";
}

function formatTaipeiTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "時間未知";
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(date);
}

function formatAge(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return "時間未知";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} 秒前`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)} 分鐘前`;
  return `${Math.round(seconds / 3_600)} 小時前`;
}

function formatSignedPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "N/A";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatPercent(value: number) {
  return `${(Number.isFinite(value) ? value : 0).toFixed(1)}%`;
}

function bar(percent: number) {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
}

function clean(value: string, maxLength: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function buildRiskSignals(input: {
  snapshot: LivePortfolioSnapshot;
  topAssetPercent: number;
  topThreeAssetsPercent: number;
  largestCustodyPercent: number;
  largestVenuePercent: number;
  deliveryMode: "live" | "cache" | "stale-cache";
  cacheAgeSeconds: number | null;
}) {
  const signals: AgentRiskSignal[] = [];
  if (input.snapshot.isPartial || input.snapshot.errors.length > 0) {
    signals.push({
      code: "incomplete-data",
      level: "high",
      title: "Portfolio coverage is incomplete",
      detail: "Treat allocation and performance conclusions as provisional until all expected sources are healthy.",
      evidence: {
        connectedSources: input.snapshot.connectedSourceCount,
        expectedSources: input.snapshot.expectedSourceCount,
        errorCount: input.snapshot.errors.length
      }
    });
  }
  if (input.deliveryMode === "stale-cache") {
    signals.push({
      code: "stale-data",
      level: "watch",
      title: "The latest trusted snapshot is stale",
      detail: "Do not use this snapshot for time-sensitive decisions until a fresh sync succeeds.",
      evidence: { cacheAgeSeconds: input.cacheAgeSeconds }
    });
  }
  if (input.topAssetPercent >= 30) {
    signals.push({
      code: "single-asset-concentration",
      level: input.topAssetPercent >= 50 ? "high" : "watch",
      title: "Single-asset concentration",
      detail: "One asset represents a large share of the tracked portfolio; review whether that exposure is intentional and consistent with your loss tolerance.",
      evidence: { topAssetPercent: input.topAssetPercent, heuristicThresholdPercent: 30 }
    });
  }
  if (input.topThreeAssetsPercent >= 70) {
    signals.push({
      code: "top-three-concentration",
      level: "watch",
      title: "Top-three concentration",
      detail: "Most tracked value is concentrated in three assets, so nominal asset count may overstate diversification.",
      evidence: { topThreeAssetsPercent: input.topThreeAssetsPercent, heuristicThresholdPercent: 70 }
    });
  }
  if (input.largestCustodyPercent >= 60) {
    signals.push({
      code: "custody-concentration",
      level: input.largestCustodyPercent >= 80 ? "high" : "watch",
      title: "Custody-channel concentration",
      detail: "A large share is held through one custody channel. Review operational, access, and counterparty failure scenarios.",
      evidence: { largestCustodyPercent: input.largestCustodyPercent, heuristicThresholdPercent: 60 }
    });
  }
  if (input.largestVenuePercent >= 30) {
    signals.push({
      code: "venue-concentration",
      level: input.largestVenuePercent >= 50 ? "high" : "watch",
      title: "Single-venue concentration",
      detail: "One provider holds a large share of tracked value. Review access, withdrawal, solvency, jurisdiction, and incident-response scenarios for that provider.",
      evidence: { largestVenuePercent: input.largestVenuePercent, heuristicThresholdPercent: 30 }
    });
  }
  if (input.snapshot.groups.banksUsd > 0 && input.snapshot.previewValueUsd > 0) {
    signals.push({
      code: "preview-fiat-data",
      level: "info",
      title: "Fiat balances are preview data",
      detail: "Bank balances are not yet a continuously reconciled live source.",
      evidence: { includesPreviewValue: true }
    });
  }
  return signals;
}

function buildPerformance(points: PortfolioHistoryPoint[]) {
  const complete = points
    .filter((point) => !point.isPartial && Number.isFinite(point.netWorthUsd))
    .slice()
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
  const latest = complete.at(-1) ?? null;
  return {
    latestCompleteDate: latest?.date ?? null,
    dayChangePercent: latest?.deltaPercent == null ? null : roundPercent(latest.deltaPercent),
    sevenDayChangePercent: changeOverDays(complete, 7),
    thirtyDayChangePercent: changeOverDays(complete, 30)
  };
}

function changeOverDays(points: PortfolioHistoryPoint[], days: number) {
  const latest = points.at(-1);
  if (!latest) return null;
  const target = new Date(latest.capturedAt).getTime() - days * 86_400_000;
  const baseline = points.filter((point) => new Date(point.capturedAt).getTime() <= target).at(-1);
  if (!baseline || baseline.netWorthUsd === 0) return null;
  return roundPercent(((latest.netWorthUsd - baseline.netWorthUsd) / baseline.netWorthUsd) * 100);
}

function percentOf(value: number, total: number) {
  return total <= 0 || !Number.isFinite(value) ? 0 : roundPercent((value / total) * 100);
}

function positive(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function roundPercent(value: number) {
  return Math.round(value * 100) / 100;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function cacheAge(capturedAt: string) {
  const value = Math.round((Date.now() - new Date(capturedAt).getTime()) / 1000);
  return Number.isFinite(value) ? Math.max(0, value) : null;
}
