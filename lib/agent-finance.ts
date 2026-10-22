import { buildAgentPortfolioResponse, type AgentPortfolioResponse } from "./agent-portfolio";
import type { AssetIdentity } from "./asset-identity";
import type { ExpenseCategory, NormalizedExpense } from "./expense-records";
import { expenseToTwd } from "./expense-records";
import type { FxRateSnapshot } from "./fx";
import type { LivePortfolioSnapshot } from "./live-portfolio";
import type { PortfolioHistoryPoint } from "./portfolio-history";
import type { PortfolioSyncMonitor } from "./server/portfolio-snapshot-store";

const dayMs = 86_400_000;
const portfolioFreshnessSeconds = 86_400;
const expenseFreshnessHours = 72;

const categoryLabels: Record<ExpenseCategory, string> = {
  food: "餐飲",
  traffic: "交通",
  living: "居住與生活",
  subscription: "訂閱",
  work: "工作",
  entertainment: "娛樂",
  fitness: "健身",
  travel: "旅行",
  health: "健康",
  shopping: "購物",
  other: "Other／其他流出"
};

export type AgentFinanceResponse = {
  schemaVersion: "2026-09-22";
  generatedAt: string;
  privacy: {
    authenticated: true;
    aggregateValuesExposed: true;
    holdingQuantitiesExposed: false;
    sourceValuesExposed: false;
    merchantDetailsExposed: false;
    walletAddressesExposed: false;
    accountIdentifiersExposed: false;
  };
  portfolio: {
    dataQuality: AgentPortfolioResponse["dataQuality"] & {
      status: "fresh" | "stale" | "degraded";
    };
    totals: NonNullable<AgentPortfolioResponse["totals"]>;
    allocation: {
      custody: AgentPortfolioResponse["allocation"]["custody"];
      assetBuckets: AgentPortfolioResponse["allocation"]["assetBuckets"];
      topHoldings: Array<AssetIdentity & {
        symbol: string;
        name: string;
        percent: number;
        sourceCount: number;
      }>;
      bankValueStatus: "live" | "preview" | "unavailable";
    };
    performance: AgentPortfolioResponse["performance"];
    concentration: AgentPortfolioResponse["concentration"];
    positionChanges: Array<{
      symbol: string;
      deltaUsd: number;
      currentPercent: number;
      weightChangePp: number;
    }>;
    sync: PortfolioSyncMonitor | null;
  };
  expenses: AgentExpenseSummary;
  limitations: string[];
};

export type AgentExpenseSummary = {
  status: "fresh" | "stale" | "empty" | "unavailable";
  source: "supabase" | null;
  currency: "TWD";
  asOfDate: string | null;
  lastImportedAt: string | null;
  freshnessHours: number | null;
  currentSevenDays: ExpensePeriod | null;
  previousSevenDays: ExpensePeriod | null;
  deltaTwd: number | null;
  deltaPercent: number | null;
  monthToDate: {
    month: string;
    throughDate: string;
    totalTwd: number;
    elapsedDays: number;
    daysInMonth: number;
  } | null;
  topCategoriesSevenDays: Array<{
    id: ExpenseCategory;
    label: string;
    totalTwd: number;
    percent: number;
  }>;
};

type ExpensePeriod = {
  startDate: string;
  endDate: string;
  totalTwd: number;
};

export function buildAgentFinanceResponse(input: {
  snapshot: LivePortfolioSnapshot;
  previousSnapshot: LivePortfolioSnapshot | null;
  history: PortfolioHistoryPoint[];
  capturedAt: string;
  sync: PortfolioSyncMonitor | null;
  fx: FxRateSnapshot;
  expenses: {
    source: "supabase" | null;
    records: NormalizedExpense[] | null;
  };
  now?: Date;
}): AgentFinanceResponse {
  const now = input.now ?? new Date();
  const agentPortfolio = buildAgentPortfolioResponse({
    snapshot: input.snapshot,
    history: input.history,
    capturedAt: input.capturedAt,
    includeTotals: true,
    fx: input.fx,
    latestSync: input.sync?.latest ?? null
  });
  if (!agentPortfolio.totals) throw new Error("Aggregate portfolio totals are unavailable");

  const rejectedAfterSnapshot = Boolean(
    input.sync?.latest &&
    input.sync.latest.status !== "success" &&
    new Date(input.sync.latest.completedAt).getTime() >= new Date(input.capturedAt).getTime()
  );
  const portfolioStatus = agentPortfolio.dataQuality.isPartial ||
    agentPortfolio.dataQuality.connectedSources < agentPortfolio.dataQuality.expectedSources ||
    agentPortfolio.dataQuality.errorCount > 0 || rejectedAfterSnapshot
      ? "degraded"
      : agentPortfolio.dataQuality.cacheAgeSeconds !== null &&
          agentPortfolio.dataQuality.cacheAgeSeconds > portfolioFreshnessSeconds
        ? "stale"
        : "fresh";

  return {
    schemaVersion: "2026-09-22",
    generatedAt: now.toISOString(),
    privacy: {
      authenticated: true,
      aggregateValuesExposed: true,
      holdingQuantitiesExposed: false,
      sourceValuesExposed: false,
      merchantDetailsExposed: false,
      walletAddressesExposed: false,
      accountIdentifiersExposed: false
    },
    portfolio: {
      dataQuality: { ...agentPortfolio.dataQuality, status: portfolioStatus },
      totals: agentPortfolio.totals,
      allocation: {
        custody: agentPortfolio.allocation.custody,
        assetBuckets: agentPortfolio.allocation.assetBuckets,
        topHoldings: agentPortfolio.allocation.topHoldings,
        bankValueStatus: getBankValueStatus(input.snapshot)
      },
      performance: agentPortfolio.performance,
      concentration: agentPortfolio.concentration,
      positionChanges: buildPositionChanges(input.snapshot, input.previousSnapshot),
      sync: input.sync
    },
    expenses: buildExpenseSummary(input.expenses, input.fx.rate, now),
    limitations: [
      "Position value changes cannot distinguish market moves from deposits, withdrawals, or transfers.",
      "All normalized outgoing expense records count toward total outflow, including Other.",
      "Bank values marked preview are estimates and cannot confirm that a cash-buffer target is funded.",
      "The response contains factual monitoring data only and is not a trade instruction."
    ]
  };
}

export function buildExpenseSummary(
  input: { source: "supabase" | null; records: NormalizedExpense[] | null },
  fxTwdPerUsd: number,
  now = new Date()
): AgentExpenseSummary {
  if (input.records === null) return emptyExpenseSummary("unavailable", input.source);
  if (!input.records.length) return emptyExpenseSummary("empty", input.source);

  const records = input.records
    .filter((record) => /^\d{4}-\d{2}-\d{2}$/.test(record.date))
    .map((record) => ({ ...record, totalTwd: expenseToTwd(record, fxTwdPerUsd) }));
  if (!records.length) return emptyExpenseSummary("empty", input.source);

  const asOfDate = records.map((record) => record.date).sort().at(-1)!;
  const lastImportedAt = records
    .map((record) => record.updatedAt)
    .filter((value) => Number.isFinite(new Date(value).getTime()))
    .sort()
    .at(-1) ?? null;
  const freshnessBase = lastImportedAt ?? `${asOfDate}T23:59:59+08:00`;
  const freshness = Math.max(0, (now.getTime() - new Date(freshnessBase).getTime()) / 3_600_000);
  const currentStart = addDays(asOfDate, -6);
  const previousEnd = addDays(asOfDate, -7);
  const previousStart = addDays(asOfDate, -13);
  const currentRecords = records.filter((record) => inRange(record.date, currentStart, asOfDate));
  const previousRecords = records.filter((record) => inRange(record.date, previousStart, previousEnd));
  const currentTotal = sum(currentRecords.map((record) => record.totalTwd));
  const previousTotal = sum(previousRecords.map((record) => record.totalTwd));
  const deltaTwd = currentTotal - previousTotal;
  const month = asOfDate.slice(0, 7);
  const monthRecords = records.filter((record) => record.date.startsWith(`${month}-`));
  const categories = new Map<ExpenseCategory, number>();
  for (const record of currentRecords) {
    categories.set(record.category, (categories.get(record.category) ?? 0) + record.totalTwd);
  }

  return {
    status: freshness > expenseFreshnessHours ? "stale" : "fresh",
    source: input.source,
    currency: "TWD",
    asOfDate,
    lastImportedAt,
    freshnessHours: round(freshness, 1),
    currentSevenDays: { startDate: currentStart, endDate: asOfDate, totalTwd: roundMoney(currentTotal) },
    previousSevenDays: { startDate: previousStart, endDate: previousEnd, totalTwd: roundMoney(previousTotal) },
    deltaTwd: roundMoney(deltaTwd),
    deltaPercent: previousTotal > 0 ? round(deltaTwd / previousTotal * 100, 2) : null,
    monthToDate: {
      month,
      throughDate: asOfDate,
      totalTwd: roundMoney(sum(monthRecords.map((record) => record.totalTwd))),
      elapsedDays: Number(asOfDate.slice(8, 10)),
      daysInMonth: daysInMonth(asOfDate)
    },
    topCategoriesSevenDays: [...categories.entries()]
      .map(([id, totalTwd]) => ({
        id,
        label: categoryLabels[id],
        totalTwd: roundMoney(totalTwd),
        percent: currentTotal > 0 ? round(totalTwd / currentTotal * 100, 2) : 0
      }))
      .sort((left, right) => right.totalTwd - left.totalTwd)
      .slice(0, 5)
  };
}

function buildPositionChanges(current: LivePortfolioSnapshot, previous: LivePortfolioSnapshot | null) {
  if (!previous || previous.netWorthUsd <= 0 || current.netWorthUsd <= 0) return [];
  if (current.valuationBasis !== previous.valuationBasis) return [];
  const currentMap = new Map(current.holdings.map((holding) => [holding.symbol, holding.valueUsd]));
  const previousMap = new Map(previous.holdings.map((holding) => [holding.symbol, holding.valueUsd]));
  return [...new Set([...currentMap.keys(), ...previousMap.keys()])]
    .filter(isReportablePositionSymbol)
    .map((symbol) => {
      const currentValue = currentMap.get(symbol) ?? 0;
      const previousValue = previousMap.get(symbol) ?? 0;
      return {
        symbol: cleanSymbol(symbol),
        deltaUsd: roundMoney(currentValue - previousValue),
        currentPercent: round(currentValue / current.netWorthUsd * 100, 2),
        weightChangePp: round(
          currentValue / current.netWorthUsd * 100 - previousValue / previous.netWorthUsd * 100,
          2
        )
      };
    })
    .filter((item) => Math.abs(item.deltaUsd) >= 0.01)
    .sort((left, right) => Math.abs(right.deltaUsd) - Math.abs(left.deltaUsd))
    .slice(0, 3);
}

function isReportablePositionSymbol(value: string) {
  const symbol = cleanSymbol(value).toUpperCase();
  return symbol !== "UNKNOWN" && !symbol.endsWith("-ESTIMATE");
}

function getBankValueStatus(snapshot: LivePortfolioSnapshot) {
  const banks = snapshot.sources.filter((source) => source.kind === "bank");
  if (!banks.length || banks.every((source) => source.status === "error")) return "unavailable";
  return banks.some((source) => source.status === "preview") ? "preview" : "live";
}

function emptyExpenseSummary(
  status: "empty" | "unavailable",
  source: "supabase" | null
): AgentExpenseSummary {
  return {
    status,
    source,
    currency: "TWD",
    asOfDate: null,
    lastImportedAt: null,
    freshnessHours: null,
    currentSevenDays: null,
    previousSevenDays: null,
    deltaTwd: null,
    deltaPercent: null,
    monthToDate: null,
    topCategoriesSevenDays: []
  };
}

function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * dayMs).toISOString().slice(0, 10);
}

function inRange(value: string, start: string, end: string) {
  return value >= start && value <= end;
}

function daysInMonth(date: string) {
  const [year, month] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function roundMoney(value: number) {
  return round(value, 2);
}

function round(value: number, digits: number) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function cleanSymbol(value: string) {
  return value.normalize("NFKC").replace(/[^\p{L}\p{N}._-]/gu, "").slice(0, 20) || "UNKNOWN";
}
