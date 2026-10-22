import portfolio from "@/data/portfolio.json";
import expenses from "@/data/expenses.json";

export interface Portfolio {
  meta: { fxTwdUsd: number; baseCurrency: string; exportedAt: string; note: string };
  summary: { totalUsd: number; cexUsd: number; walletUsd: number; bankUsd: number; lastUpdate: string };
  cex: Account[];
  wallets: Wallet[];
  banks: Bank[];
}

export interface Account {
  id: string;
  name: string;
  type: "cex";
  assets: string[];
  valueUsd: number;
  lastUpdate: string;
}

export interface Wallet {
  id: string;
  name: string;
  type: "wallet";
  chain: string;
  address: string | null;
  assets: string[];
  valueUsd: number;
  lastUpdate: string;
}

export interface Bank {
  id: string;
  name: string;
  type: "bank";
  assets: string[];
  nativeAmount?: number | null;
  nativeCurrency?: "USD" | "TWD" | "JPY";
  valueTwd: number | null;
  valueUsd: number | null;
  lastUpdate: string;
}

export type ExpenseMonth = {
  month: string;
  total: number;
  [category: string]: string | number | undefined;
};

export type ExpenseLedgerMonth = {
  month: string;
  through: string;
  total: number;
  recordCount: number;
  categories: Record<string, number>;
};

export type ExpenseLedgerSummary = {
  latestTransactionDate?: string;
  total: number;
  recordCount: number;
  yearTotals: Record<string, number>;
  monthly: Record<string, ExpenseLedgerMonth>;
};

export interface Expenses {
  meta: {
    currency: "TWD";
    note: string;
    actualThrough?: string;
    partialActuals?: Record<string, { through: string; total: number }>;
    yearTotals: Record<string, number>;
  };
  monthly: Record<"2024" | "2025" | "2026", ExpenseMonth[]>;
  ledger?: ExpenseLedgerSummary;
}

export interface HoldingRow {
  symbol: string;
  platforms: string[];
  platformValueUsd: number;
}

export function getPortfolio(): Portfolio {
  return portfolio as Portfolio;
}

export function getExpenses(): Expenses {
  return expenses as Expenses;
}

export function getAllPlatforms() {
  const data = getPortfolio();
  return [...data.cex, ...data.wallets, ...data.banks];
}

export function getHoldingsBySymbol(): HoldingRow[] {
  const platforms = getAllPlatforms();
  const symbols = new Map<string, HoldingRow>();

  for (const platform of platforms) {
    for (const asset of platform.assets) {
      const row = symbols.get(asset) ?? { symbol: asset, platforms: [], platformValueUsd: 0 };
      row.platforms.push(platform.name);
      row.platformValueUsd += platform.valueUsd ?? 0;
      symbols.set(asset, row);
    }
  }

  return [...symbols.values()].sort((a, b) => b.platforms.length - a.platforms.length || a.symbol.localeCompare(b.symbol));
}

export function getExpenseCategories(year: "2024" | "2025" | "2026") {
  const data = getExpenses().monthly[year];
  const set = new Set<string>();
  data.forEach((row) => {
    Object.keys(row).forEach((key) => {
      if (key !== "month" && key !== "total" && Number(row[key]) > 0) set.add(key);
    });
  });
  return [...set];
}

export function isForecastMonth(month: string, actualThrough = getExpenses().meta.actualThrough) {
  return actualThrough ? month > actualThrough.slice(0, 7) : false;
}

export function getActual2026Months() {
  return getExpenses().monthly["2026"].filter((row) => !isForecastMonth(row.month));
}
