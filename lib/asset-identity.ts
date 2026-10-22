export type AssetIdentity = {
  assetClass?: "crypto" | "equity";
  exposureSymbol?: string;
};

export type HoldingValuation = {
  priceUsd?: number | null;
  priceSource?: string;
  valuationState?: "priced" | "excluded" | "unpriced";
  valuationReason?: string;
};

export type ValuationCounts = { priced: number; excluded: number; unpriced: number };

// Exact contracts already verified in the portfolio; never classify by suffix.
const equityContracts: Record<string, string> = {
  "bsc:0x8b6acf6041a81567f012ff6a4c6d96d5818d74bf": "MU",
  "bsc:0x2494b603319d4d9f9715c9f4496d9e0364b59d93": "TSLA"
};

export function walletAssetIdentity(token: { chainId: string; contractAddress?: string | null }): AssetIdentity {
  const exposureSymbol = equityContracts[`${token.chainId}:${token.contractAddress?.toLowerCase()}`];
  return exposureSymbol ? { assetClass: "equity", exposureSymbol } : {};
}

export function countValuations(holdings: readonly (HoldingValuation & { valueUsd: number | null })[]): ValuationCounts {
  return holdings.reduce<ValuationCounts>((counts, holding) => {
    const state = holding.valuationState ?? (holding.valueUsd === null ? "unpriced" : "priced");
    counts[state] += 1;
    return counts;
  }, { priced: 0, excluded: 0, unpriced: 0 });
}
