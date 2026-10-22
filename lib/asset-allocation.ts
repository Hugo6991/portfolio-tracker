import type { LiveHolding } from "./live-portfolio";

export const assetAllocationOrder = [
  "stablecoins",
  "btc",
  "hype",
  "bnb",
  "eth",
  "uni",
  "equities",
  "other"
] as const;

export type AssetAllocationId = (typeof assetAllocationOrder)[number];

export type AssetAllocationGroup = {
  id: AssetAllocationId;
  label: string;
  detail: string;
  valueUsd: number;
  symbols: string[];
};

type AllocationHolding = Pick<LiveHolding, "symbol" | "valueUsd" | "assetClass">;

const fiatSymbols = new Set(["USD", "TWD", "JPY", "EUR", "GBP", "CNY"]);

const stablecoinSymbols = new Set([
  "BUSD",
  "DAI",
  "FDUSD",
  "SATUSD",
  "TUSD",
  "USDC",
  "USDC(BRIDGED)",
  "USDC.E",
  "USDP",
  "USDT",
  "USDT0",
  "USDZC",
  "USD1",
  "USD₮0",
  "BFUSD"
]);

const btcSymbols = new Set([
  "BTC",
  "BTCB",
  "CBBTC",
  "LBTC",
  "SOLVBTC",
  "STBTC",
  "WBTC",
  "XSOLVBTC"
]);

const ethSymbols = new Set(["ETH", "WETH", "WEETH"]);
const bnbSymbols = new Set(["BNB", "WBNB"]);

const labels: Record<AssetAllocationId, Pick<AssetAllocationGroup, "label" | "detail">> = {
  stablecoins: { label: "Stablecoins", detail: "USDT, USDC and dollar-linked assets" },
  btc: { label: "Bitcoin", detail: "BTC and wrapped BTC exposure" },
  hype: { label: "HYPE", detail: "Liquid, staked and protocol exposure" },
  bnb: { label: "BNB", detail: "BNB and wrapped BNB" },
  eth: { label: "Ethereum", detail: "ETH and liquid staking exposure" },
  uni: { label: "UNI", detail: "Liquid and protocol exposure" },
  equities: { label: "Stocks and ETFs", detail: "Direct stocks and tokenized equity exposure" },
  other: { label: "Other", detail: "Remaining crypto and DeFi positions" }
};

function normalizeSymbol(symbol: string) {
  return symbol.trim().toUpperCase();
}

export function getAssetAllocationId(symbol: string, assetClass?: LiveHolding["assetClass"]): AssetAllocationId | "fiat" {
  const normalized = normalizeSymbol(symbol);
  if (assetClass === "equity" || /^EQ_([A-Z0-9.]+)$/.test(normalized)) return "equities";
  if (fiatSymbols.has(normalized)) return "fiat";
  if (stablecoinSymbols.has(normalized)) return "stablecoins";
  if (btcSymbols.has(normalized)) return "btc";
  if (normalized === "HYPE") return "hype";
  if (bnbSymbols.has(normalized)) return "bnb";
  if (ethSymbols.has(normalized)) return "eth";
  if (normalized === "UNI") return "uni";
  return "other";
}

export function buildCryptoAssetAllocation(
  holdings: readonly AllocationHolding[]
): { groups: AssetAllocationGroup[]; totalUsd: number } {
  const values = new Map<AssetAllocationId, number>();
  const symbols = new Map<AssetAllocationId, Set<string>>();

  for (const holding of holdings) {
    if (!Number.isFinite(holding.valueUsd) || holding.valueUsd === 0) continue;
    const id = getAssetAllocationId(holding.symbol, holding.assetClass);
    if (id === "fiat") continue;
    values.set(id, (values.get(id) ?? 0) + holding.valueUsd);
    const groupSymbols = symbols.get(id) ?? new Set<string>();
    groupSymbols.add(normalizeSymbol(holding.symbol));
    symbols.set(id, groupSymbols);
  }

  const netTotalUsd = assetAllocationOrder.reduce((sum, id) => sum + (values.get(id) ?? 0), 0);
  const positiveTotalUsd = assetAllocationOrder.reduce(
    (sum, id) => sum + Math.max(0, values.get(id) ?? 0),
    0
  );
  const distributableTotalUsd = Math.max(0, netTotalUsd);
  const positiveScale = positiveTotalUsd > 0
    ? Math.min(1, distributableTotalUsd / positiveTotalUsd)
    : 0;
  const groups = assetAllocationOrder
    .map<AssetAllocationGroup>((id) => ({
      id,
      ...labels[id],
      valueUsd: Math.max(0, values.get(id) ?? 0) * positiveScale,
      symbols: [...(symbols.get(id) ?? [])].sort()
    }))
    .filter((group) => group.valueUsd > 0);

  return {
    groups,
    totalUsd: distributableTotalUsd
  };
}
