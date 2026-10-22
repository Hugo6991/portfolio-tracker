import type { LivePortfolioSnapshot } from "./live-portfolio";
import { getTaipeiDate } from "./portfolio-history";

export type WalletHistoryQuality = "complete" | "partial" | "unavailable";

export type WalletHistoryOverviewPoint = {
  date: string;
  capturedAt: string;
  valueUsd: number | null;
  quality: WalletHistoryQuality;
  isPartial: boolean;
};

export type WalletHistoryAddressPoint = {
  date: string;
  capturedAt: string;
  /** Whether this snapshot records the wallet, including unsuccessful reads. */
  isTracked: boolean;
  valueUsd: number | null;
  debankValueUsd: number | null;
  hyperliquidValueUsd: number | null;
  quality: WalletHistoryQuality;
};

export type WalletHistorySeries = {
  walletId: string;
  name: string;
  address: string;
  points: WalletHistoryAddressPoint[];
};

export type PublicWalletHistoryPoint = Pick<
  WalletHistoryAddressPoint,
  "date" | "capturedAt" | "isTracked" | "valueUsd" | "quality"
>;

export type PublicWalletHistorySeries = {
  walletId: string;
  points: PublicWalletHistoryPoint[];
};

export type WalletHistoryResponse = {
  configured: boolean;
  overview: WalletHistoryOverviewPoint[];
  wallets: PublicWalletHistorySeries[];
};

export type WalletHistoryData = {
  overview: WalletHistoryOverviewPoint[];
  wallets: WalletHistorySeries[];
};

type SnapshotRecord = Record<string, unknown>;
type WalletRecord = Record<string, unknown>;

type DailySnapshot = {
  date: string;
  capturedAt: string;
  snapshot: SnapshotRecord;
  quality: WalletHistoryQuality;
  wallets: Map<string, WalletRecord>;
};

type WalletMetadata = {
  walletId: string;
  name: string;
  address: string;
};

/**
 * Builds one latest-per-Taipei-day history from the immutable full snapshots.
 * Runtime guards are intentional: stored JSON may predate newer LiveWallet fields.
 */
export function canonicalizeDailyWalletSnapshots(
  snapshots: readonly LivePortfolioSnapshot[]
): WalletHistoryData {
  const dailySnapshots = latestDailySnapshots(snapshots);
  const metadata = new Map<string, WalletMetadata>();

  const days: DailySnapshot[] = dailySnapshots.map(({ date, capturedAt, snapshot }) => {
    const quality = getWalletSnapshotQuality(snapshot);
    const wallets = new Map<string, WalletRecord>();

    for (const wallet of recordArray(snapshot.wallets)) {
      const key = getWalletKey(wallet);
      if (!key) continue;
      wallets.set(key, wallet);
      const address = stringValue(wallet.address) ?? key;
      metadata.set(key, {
        walletId: stringValue(wallet.id) ?? key,
        name: stringValue(wallet.name) ?? address,
        address
      });
    }

    return { date, capturedAt, snapshot, quality, wallets };
  });

  const overview: WalletHistoryOverviewPoint[] = days.map((day) => {
    const configuredTotal = finiteNumber(asRecord(day.snapshot.groups)?.walletsUsd);
    const walletTotal = [...day.wallets.values()].reduce((sum, wallet) => {
      return sum + (finiteNumber(wallet.valueUsd) ?? 0);
    }, 0);
    const valueUsd = day.quality === "unavailable"
      ? null
      : configuredTotal ?? walletTotal;

    return {
      date: day.date,
      capturedAt: day.capturedAt,
      valueUsd,
      quality: day.quality,
      isPartial: day.quality !== "complete"
    };
  });

  const wallets = [...metadata.entries()].map(([key, wallet]) => ({
    ...wallet,
    points: days.map<WalletHistoryAddressPoint>((day) => {
      const storedWallet = day.wallets.get(key);
      const quality = getAddressPointQuality(storedWallet, day.quality);
      const hasUsableValue = quality !== "unavailable";
      return {
        date: day.date,
        capturedAt: day.capturedAt,
        isTracked: storedWallet !== undefined,
        valueUsd: hasUsableValue ? finiteNumber(storedWallet?.valueUsd) : null,
        debankValueUsd: hasUsableValue ? finiteNumber(storedWallet?.debankValueUsd) : null,
        hyperliquidValueUsd: hasUsableValue
          ? finiteNumber(storedWallet?.hyperliquidValueUsd)
          : null,
        quality
      };
    })
  }));

  wallets.sort((left, right) => {
    const rightValue = latestValue(right.points);
    const leftValue = latestValue(left.points);
    return rightValue - leftValue || left.name.localeCompare(right.name);
  });

  return { overview, wallets };
}

function latestDailySnapshots(snapshots: readonly LivePortfolioSnapshot[]) {
  const daily = new Map<string, { date: string; capturedAt: string; snapshot: SnapshotRecord }>();
  const sorted = snapshots
    .map((snapshot) => asRecord(snapshot))
    .filter((snapshot): snapshot is SnapshotRecord => Boolean(snapshot))
    .filter((snapshot) => isIsoTimestamp(snapshot.generatedAt))
    .slice()
    .sort((left, right) => String(left.generatedAt).localeCompare(String(right.generatedAt)));

  for (const snapshot of sorted) {
    const capturedAt = String(snapshot.generatedAt);
    const date = getTaipeiDate(capturedAt);
    daily.set(date, { date, capturedAt, snapshot });
  }

  return [...daily.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function getWalletSnapshotQuality(snapshot: SnapshotRecord): WalletHistoryQuality {
  const walletSources = recordArray(snapshot.sources).filter((source) => {
    const id = stringValue(source.id)?.toLowerCase();
    return source.kind === "wallet" || id === "debank" || id === "hyperliquid";
  });

  if (walletSources.length === 0) {
    const hasLegacyValue = finiteNumber(asRecord(snapshot.groups)?.walletsUsd) !== null;
    return hasLegacyValue ? "partial" : "unavailable";
  }

  const statuses = walletSources.map((source) => stringValue(source.status)?.toLowerCase());
  const sourceIds = new Set(walletSources.map((source) => stringValue(source.id)?.toLowerCase()));
  const hasExpectedSources = sourceIds.has("debank") && sourceIds.has("hyperliquid");
  if (hasExpectedSources && statuses.every((status) => status === "live")) return "complete";
  if (statuses.some((status) => status === "live" || status === "partial")) return "partial";
  return "unavailable";
}

function getAddressPointQuality(
  wallet: WalletRecord | undefined,
  snapshotQuality: WalletHistoryQuality
): WalletHistoryQuality {
  if (!wallet || finiteNumber(wallet.valueUsd) === null) return "unavailable";
  const status = stringValue(wallet.status)?.toLowerCase();
  if (status === "error") return "unavailable";
  if (status !== "live" || snapshotQuality !== "complete") return "partial";
  return "complete";
}

function getWalletKey(wallet: WalletRecord) {
  const address = stringValue(wallet.address);
  if (address) return address.toLowerCase();
  const id = stringValue(wallet.id);
  return id ? `id:${id.toLowerCase()}` : null;
}

function latestValue(points: WalletHistoryAddressPoint[]) {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = points[index]?.valueUsd;
    if (value !== null && value !== undefined) return value;
  }
  return 0;
}

function asRecord(value: unknown): SnapshotRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as SnapshotRecord
    : null;
}

function recordArray(value: unknown): WalletRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is WalletRecord => Boolean(item))
    : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isIsoTimestamp(value: unknown) {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}
