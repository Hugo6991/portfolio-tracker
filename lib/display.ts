import type { Account, Bank, Wallet } from "./data";
import type { Currency } from "./fx";
import { formatNullableMoney as formatNullableDisplayMoney } from "./format";

type Platform = Account | Wallet | Bank;

const bankNames: Record<string, { displayName: string; institution: string; category: string }> = {
  "Bank A": { displayName: "Bank A", institution: "Bank A", category: "Cash account" },
  "Bank B": { displayName: "Bank B", institution: "Bank B", category: "Multi-currency cash" }
};

const bankDisplayNames = new Map(Object.values(bankNames).map((item) => [item.displayName, item]));

const walletNames: Record<string, string> = {
  "Main wallet": "Main wallet",
  "Cold wallet": "Cold wallet",
  "DeFi wallet": "DeFi wallet",
  "Arbitrum wallet": "Arbitrum wallet",
  "Hot wallet": "Hot wallet"
};

export function getDisplayAccountName(rawName: string) {
  return bankNames[rawName]?.displayName ?? walletNames[rawName] ?? rawName;
}

export function getAccountInstitution(rawName: string) {
  return bankNames[rawName]?.institution ?? bankDisplayNames.get(rawName)?.institution ?? getDisplayAccountName(rawName);
}

export function getAccountCategory(platform: Platform) {
  if (platform.type === "bank") return bankNames[platform.name]?.category ?? bankDisplayNames.get(platform.name)?.category ?? "Cash account";
  if (platform.type === "wallet") return `${platform.chain.charAt(0).toUpperCase()}${platform.chain.slice(1)} wallet`;
  return "Exchange account";
}

export function getPlatformKind(platform: Platform) {
  if (platform.type === "cex") return "CEX";
  if (platform.type === "wallet") return "Wallet";
  return "Bank";
}

export function formatNullableMoney(value: number | null | undefined, currency: Currency) {
  return formatNullableDisplayMoney(value, currency);
}

export function assetLabel(symbol: string) {
  const labels: Record<string, string> = {
    USDT: "Tether",
    USDC: "USD Coin",
    BTC: "Bitcoin",
    wBTC: "Wrapped Bitcoin",
    BNB: "BNB",
    HYPE: "Hyperliquid",
    "Staked HYPE": "Hyperliquid Staked",
    UNI: "Uniswap",
    "Staked UNI": "Uniswap Staked",
    TWD: "New Taiwan Dollar",
    JPY: "Japanese Yen",
    ONDO: "Ondo",
    Virtual: "Virtuals",
    MU: "Micron Technology",
    Tesla: "Tesla",
    PRL: "Pearl",
    "GATE-ESTIMATE": "Gate unallocated account value"
  };
  return labels[symbol] ?? symbol;
}
