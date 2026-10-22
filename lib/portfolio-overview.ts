import type { LivePortfolioSnapshot, LiveWallet } from "./live-portfolio";
import { canonicalAssetSymbol, resolveLogoMark } from "./brand-marks";

export type PortfolioOverview = Omit<LivePortfolioSnapshot, "wallets">;

export function walletHoldingLogos(wallets: readonly LiveWallet[]) {
  // Preserve logo metadata before projecting away wallet details. Never fetch a
  // second snapshot or guess a contract from a ticker. Conflicting logos are ambiguous.
  const candidates = new Map<string, Set<string>>();
  for (const wallet of wallets) {
    const tokens = [...(wallet.tokens ?? []), ...(wallet.positions ?? []).flatMap(position => position.tokens ?? [])];
    for (const token of tokens) {
      if (!token?.symbol || token.valuationState === "excluded" || token.verificationState === "unverified") continue;
      const logo = resolveLogoMark(token.iconUrl);
      if (!logo) continue;
      const key = canonicalAssetSymbol(token.symbol);
      const urls = candidates.get(key) ?? new Set<string>();
      urls.add(logo);
      candidates.set(key, urls);
    }
  }
  return new Map([...candidates].flatMap(([symbol, urls]) => urls.size === 1 ? [[symbol, [...urls][0]] as const] : []));
}

export function portfolioOverview(snapshot: LivePortfolioSnapshot): PortfolioOverview {
  const { wallets: _wallets, ...overview } = snapshot;
  const logos = walletHoldingLogos(snapshot.wallets ?? []);
  return {
    ...overview,
    holdings: overview.holdings.map(holding => {
      const iconUrl = logos.get(canonicalAssetSymbol(holding.symbol));
      return iconUrl ? { ...holding, iconUrl } : holding;
    })
  };
}

// CDN and client caches must never make the displayed source age appear newer.
export function withCurrentDeliveryAge<T extends PortfolioOverview>(snapshot: T, now = Date.now()): T {
  if (!snapshot.delivery) return snapshot;
  const capturedAt = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(capturedAt)) return snapshot;
  const age = Math.max(0, Math.floor((now - capturedAt) / 1000));
  return {
    ...snapshot,
    delivery: {
      ...snapshot.delivery,
      cacheAgeSeconds: age,
      mode: age > snapshot.delivery.cacheTtlSeconds ? "stale-cache" : snapshot.delivery.mode
    }
  };
}
