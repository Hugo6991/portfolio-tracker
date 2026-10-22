import type { Account, Bank, Portfolio, Wallet } from "@/lib/data";
import { getDisplayAccountName } from "@/lib/display";

export type { NormalizedExpense } from "@/lib/expense-records";

export type SourceType = "cex" | "wallet" | "bank" | "expense" | "fx";
export type SyncStatus = "live" | "updated_today" | "cached" | "stale" | "pending_setup" | "sync_failed" | "seed";

export type NormalizedAsset = {
  id: string;
  sourceType: SourceType;
  sourceName: string;
  accountId: string;
  accountName: string;
  nativeAmount: number | null;
  nativeCurrency: "USD" | "TWD" | "JPY";
  usdValue: number | null;
  updatedAt: string;
  syncStatus: SyncStatus;
  isSeed: boolean;
  symbols: string[];
};

export type NormalizedDataSource = {
  id: string;
  sourceType: SourceType;
  sourceName: string;
  status: SyncStatus;
  updatedAt: string | null;
  actionLabel: string;
  isSeed: boolean;
};

type Platform = Account | Wallet | Bank;

export function normalizePortfolio(portfolio: Portfolio) {
  return {
    ...portfolio,
    cex: portfolio.cex.map((item) => ({ ...item, name: getDisplayAccountName(item.name) })),
    wallets: portfolio.wallets.map((item) => ({ ...item, name: getDisplayAccountName(item.name) })),
    banks: portfolio.banks.map((item) => ({ ...item, name: getDisplayAccountName(item.name) }))
  } satisfies Portfolio;
}

export function normalizeAssetRows(portfolio: Portfolio): NormalizedAsset[] {
  return [...portfolio.cex, ...portfolio.wallets, ...portfolio.banks].map((platform) => normalizePlatform(platform));
}

export function normalizeDataSources(portfolio: Portfolio): NormalizedDataSource[] {
  return [
    {
      id: "fx-usd-twd",
      sourceType: "fx",
      sourceName: "USD/TWD FX rate",
      status: "seed",
      updatedAt: portfolio.meta.exportedAt,
      actionLabel: "Refresh FX rate",
      isSeed: true
    },
    ...normalizeAssetRows(portfolio).map((row) => ({
      id: row.id,
      sourceType: row.sourceType,
      sourceName: row.sourceName,
      status: row.syncStatus,
      updatedAt: row.updatedAt,
      actionLabel: row.sourceType === "bank" ? "Upload CSV" : row.sourceType === "wallet" ? "Test DeBank sync" : "Connect API",
      isSeed: row.isSeed
    }))
  ];
}

function normalizePlatform(platform: Platform): NormalizedAsset {
  const displayName = getDisplayAccountName(platform.name);
  const nativeCurrency = platform.type === "bank" ? platform.nativeCurrency ?? "TWD" : "USD";
  const nativeAmount = platform.type === "bank" ? platform.nativeAmount ?? platform.valueTwd : platform.valueUsd;

  return {
    id: platform.id,
    sourceType: platform.type,
    sourceName: platform.type === "cex" ? "CEX seed data" : platform.type === "wallet" ? "DeBank preview" : "Sanitized CSV",
    accountId: platform.id,
    accountName: displayName,
    nativeAmount,
    nativeCurrency,
    usdValue: platform.valueUsd,
    updatedAt: platform.lastUpdate,
    syncStatus: platform.valueUsd == null ? "pending_setup" : "seed",
    isSeed: true,
    symbols: platform.assets
  };
}
