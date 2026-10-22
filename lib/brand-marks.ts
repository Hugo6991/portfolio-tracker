import iconCatalog from "./icon-catalog.json";
import iconSources from "./icon-sources.json";

function own(map: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

const assetAliases: Record<string, string> = {
  WETH: "ETH",
  WBTC: "BTC",
  "USDC.E": "USDC"
};

const assetMarks: Record<string, string> = {
  USDT: "/brand/web3icons/assets/usdt.svg",
  USDC: "/brand/web3icons/assets/usdc.svg",
  BTC: "/brand/web3icons/assets/btc.svg",
  ETH: "/brand/web3icons/assets/eth.svg",
  BNB: "/brand/web3icons/assets/bnb.svg",
  HYPE: "/brand/web3icons/shared/hyper-evm.svg"
};

const sourceMarks: Record<string, string> = {
  binance: "/brand/web3icons/sources/binance.svg",
  okx: "/brand/web3icons/sources/okx.svg",
  bitget: "/brand/web3icons/sources/bitget.svg",
  hyperliquid: "/brand/web3icons/shared/hyper-evm.svg"
};

export function canonicalAssetSymbol(symbol: string) {
  const normalized = symbol.trim().toUpperCase();
  return own(assetAliases, normalized) ?? normalized;
}

export function resolveLogoMark(url?: string | null): string | null {
  if (!url) return null;
  const bundled = own(iconCatalog, url);
  if (bundled) return bundled;
  if (/^\/brand\/[a-zA-Z0-9/_.-]+$/.test(url) && !url.includes("..")) return url;
  // Newly observed provider logos can render immediately, before the next cache sync.
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "static.debank.com" && !parsed.port && !parsed.username && !parsed.password ? url : null;
  } catch { return null; }
}

export function resolveAssetMark(symbol: string, iconUrl?: string | null) {
  const canonical = canonicalAssetSymbol(symbol);
  const curated = own(iconSources.assets, canonical);
  return own(assetMarks, canonical) ?? resolveLogoMark(curated) ?? resolveLogoMark(iconUrl);
}

export function resolveSourceMark(source: string) {
  const key = source.trim().toLowerCase();
  return own(sourceMarks, key) ?? resolveLogoMark(own(iconSources.sources, key));
}

export function markInitials(label: string) {
  const normalized = label.trim().replace(/[^a-z0-9]/gi, "");
  return (normalized || "?").slice(0, 2).toUpperCase();
}
