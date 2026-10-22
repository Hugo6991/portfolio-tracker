import type { WalletHistoryResponse } from "./wallet-history";

export type WalletOverviewTrendPoint = {
  date: string;
  valueUsd: number | null;
  trackedWalletCount: number;
};

/** Keep the current wallet selection, using only wallets recorded on each day. */
export function buildWalletOverviewTrend(
  data: WalletHistoryResponse | null,
  walletIds: readonly string[]
): WalletOverviewTrendPoint[] {
  if (!data) return [];
  const allowedIds = new Set(walletIds);
  const series = data.wallets
    .filter((wallet) => allowedIds.has(wallet.walletId))
    .map((wallet) => new Map(wallet.points.map((point) => [point.date, point])));

  return data.overview.map((overviewPoint) => {
    const dayPoints = series.map((points) => points.get(overviewPoint.date));
    // Only explicit absence is safe to exclude. Missing or failed reads stay gaps.
    const trackedPoints = dayPoints.filter((point) => point?.isTracked !== false);
    const complete = overviewPoint.quality === "complete"
      && trackedPoints.length > 0
      && trackedPoints.every((point) => point?.quality === "complete"
        && point.valueUsd !== null && Number.isFinite(point.valueUsd));

    return {
      date: overviewPoint.date,
      valueUsd: complete
        ? trackedPoints.reduce((sum, point) => sum + (point?.valueUsd ?? 0), 0)
        : null,
      trackedWalletCount: trackedPoints.filter((point) => point !== undefined).length
    };
  });
}
