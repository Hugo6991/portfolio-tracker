import { canonicalAssetSymbol } from "../../lib/brand-marks";

export const WALLET_DISPLAY_THRESHOLD_USD = 1_000;

export type WalletPositionState =
  | "liquid"
  | "staked"
  | "unstaking"
  | "locked"
  | "supplied"
  | "borrowed"
  | "liquidity"
  | "vault"
  | "trading"
  | "rewards"
  | "claimable"
  | "collateral"
  | "unknown";

export type WalletDetailToken = {
  id: string;
  symbol: string;
  name: string;
  amount: number | null;
  priceUsd: number | null;
  priceSource: "defillama" | "debank-snapshot" | null;
  priceState: "fresh" | "fallback" | "stale" | "excluded" | null;
  priceUpdatedAt: string | null;
  valueUsd: number;
  chain: string | null;
  chainLabel: string | null;
  protocolName: string | null;
  iconUrl: string | null;
  state: WalletPositionState;
  source: string | null;
};

export type WalletDetailPosition = {
  id: string;
  name: string;
  protocolName: string;
  protocolIconUrl: string | null;
  protocolUrl: string | null;
  chain: string | null;
  chainLabel: string | null;
  valueUsd: number;
  assetUsd: number | null;
  debtUsd: number | null;
  state: WalletPositionState;
  source: string | null;
  apr: number | null;
  unlockAt: string | null;
  tokens: WalletDetailToken[];
};

export type WalletAllocationItem = {
  id: string;
  label: string;
  value: number;
  symbol?: string;
};

type UnknownRecord = Record<string, unknown>;

export function filterDisplayWallets<T extends { valueUsd: number }>(wallets: T[]) {
  return wallets
    .filter((wallet) => Number.isFinite(wallet.valueUsd) && wallet.valueUsd >= WALLET_DISPLAY_THRESHOLD_USD)
    .sort((a, b) => b.valueUsd - a.valueUsd);
}

export function getWalletDetails(wallet: unknown) {
  const record = asRecord(wallet);
  const details = asRecord(record?.details);
  const tokenCandidates = firstArray(record?.tokens, details?.tokens, record?.assets, record?.holdings);
  const directPositionCandidates = firstArray(
    record?.positions,
    details?.positions,
    record?.protocolPositions,
    record?.stakingPositions
  );
  const protocolCandidates = firstArray(record?.protocols, details?.protocols);
  const expandedProtocols = protocolCandidates.flatMap((protocol, protocolIndex) => {
    const protocolRecord = asRecord(protocol);
    if (!protocolRecord) return [];
    const nested = firstArray(
      protocolRecord.positions,
      protocolRecord.items,
      protocolRecord.portfolioItems,
      protocolRecord.portfolio_item_list
    );
    if (!nested.length) return [{ ...protocolRecord, id: stringValue(protocolRecord.id) || `protocol-${protocolIndex}` }];
    return nested.map((item, itemIndex) => ({
      ...asRecord(item),
      id: stringValue(asRecord(item)?.id) || `${stringValue(protocolRecord.id) || "protocol"}-${itemIndex}`,
      protocolName: stringValue(protocolRecord.name) || stringValue(protocolRecord.protocolName),
      protocolIconUrl: stringValue(protocolRecord.iconUrl) || stringValue(protocolRecord.logoUrl) || stringValue(protocolRecord.logo_url),
      chain: stringValue(asRecord(item)?.chain) || stringValue(protocolRecord.chain),
      chainLabel: stringValue(asRecord(item)?.chainLabel) || stringValue(protocolRecord.chainLabel)
    }));
  });

  const tokens = tokenCandidates
    .map((token, index) => normalizeToken(token, index, "token"))
    .filter((token): token is WalletDetailToken => Boolean(token && token.valueUsd >= 0.01))
    .sort((a, b) => b.valueUsd - a.valueUsd);
  const positions = [...directPositionCandidates, ...expandedProtocols]
    .map((position, index) => normalizePosition(position, index))
    .filter((position): position is WalletDetailPosition => Boolean(position && Math.abs(position.valueUsd) >= 0.01))
    .sort((a, b) => b.valueUsd - a.valueUsd);

  return { tokens, positions };
}

export function buildWalletAllocation<T extends { id: string; name: string; valueUsd: number }>(wallets: T[]): WalletAllocationItem[] {
  const grouped = new Map<string, WalletAllocationItem>();
  let detailedWalletCount = 0;

  for (const wallet of wallets) {
    const details = getWalletDetails(wallet);
    if ((!details.tokens.length && !details.positions.length) || !Number.isFinite(wallet.valueUsd)) continue;
    detailedWalletCount += 1;

    const walletItems: Array<{ symbol: string | null; valueUsd: number }> = details.tokens.map((token) => ({
      symbol: token.symbol,
      valueUsd: signedTokenExposure(token)
    }));

    for (const position of details.positions) {
      const positionItems = position.tokens
        .filter((token) => Number.isFinite(token.valueUsd))
        .map((token) => ({ symbol: token.symbol, valueUsd: signedTokenExposure(token) }));
      const classifiedPositionValue = positionItems.reduce((sum, item) => sum + item.valueUsd, 0);
      walletItems.push(...positionItems);
      walletItems.push({ symbol: null, valueUsd: position.valueUsd - classifiedPositionValue });
    }

    const classifiedWalletValue = walletItems.reduce((sum, item) => sum + item.valueUsd, 0);
    walletItems.push({ symbol: null, valueUsd: wallet.valueUsd - classifiedWalletValue });

    for (const item of walletItems) {
      if (!Number.isFinite(item.valueUsd) || item.valueUsd === 0) continue;
      addAllocationValue(grouped, item.symbol, item.valueUsd);
    }
  }

  if (grouped.size > 0 && detailedWalletCount === wallets.length) {
    return Array.from(grouped.values())
      .filter((item) => item.value !== 0)
      .sort((a, b) => b.value - a.value);
  }

  return wallets
    .filter((wallet) => wallet.valueUsd > 0)
    .map((wallet) => ({ id: wallet.id, label: wallet.name, value: wallet.valueUsd }))
    .sort((a, b) => b.value - a.value);
}

/**
 * Pie charts cannot render negative wedges. Net borrowed exposure first, then
 * proportionally compress the remaining positive wedges to the authoritative
 * wallet total so visible percentages never exceed 100%.
 */
export function normalizeWalletAllocationForDonut(
  items: WalletAllocationItem[],
  authoritativeTotalUsd: number
) {
  const positiveItems = items.filter((item) => Number.isFinite(item.value) && item.value > 0);
  const positiveTotal = positiveItems.reduce((sum, item) => sum + item.value, 0);
  const targetTotal = Number.isFinite(authoritativeTotalUsd) ? Math.max(0, authoritativeTotalUsd) : 0;
  const scale = positiveTotal > 0 ? Math.min(1, targetTotal / positiveTotal) : 0;

  return positiveItems
    .map((item) => ({ ...item, value: item.value * scale }))
    .filter((item) => item.value > 0.01)
    .sort((left, right) => right.value - left.value);
}

function signedTokenExposure(token: WalletDetailToken) {
  const valueUsd = Math.abs(token.valueUsd);
  return token.state === "borrowed" ? -valueUsd : valueUsd;
}

function addAllocationValue(grouped: Map<string, WalletAllocationItem>, rawSymbol: string | null, valueUsd: number) {
  if (rawSymbol) {
    const symbol = canonicalAssetSymbol(rawSymbol);
    const current = grouped.get(symbol);
    grouped.set(symbol, {
      id: symbol,
      label: symbol,
      symbol,
      value: (current?.value || 0) + valueUsd
    });
    return;
  }

  const current = grouped.get("OTHER");
  grouped.set("OTHER", {
    id: "OTHER",
    label: "Other",
    value: (current?.value || 0) + valueUsd
  });
}

export function positionStateLabel(state: WalletPositionState) {
  const labels: Record<WalletPositionState, string> = {
    liquid: "Liquid",
    staked: "Staked",
    unstaking: "Unstaking",
    locked: "Locked",
    supplied: "Supplied",
    borrowed: "Borrowed",
    liquidity: "Liquidity pool",
    vault: "Vault",
    trading: "Trading",
    rewards: "Rewards",
    claimable: "Claimable",
    collateral: "Collateral",
    unknown: "Position"
  };
  return labels[state];
}

function normalizeToken(value: unknown, index: number, fallbackKind: "token" | "position"): WalletDetailToken | null {
  const record = asRecord(value);
  if (!record) return null;
  const amount = finiteNumber(record.amount, record.balance, record.quantity, record.tokenAmount, record.token_amount);
  const priceUsd = finiteNumber(record.priceUsd, record.price_usd, record.price);
  const valueUsd = finiteNumber(record.valueUsd, record.value_usd, record.usdValue, record.usd_value)
    ?? ((amount ?? 0) * (priceUsd ?? 0));
  const rawSymbol = stringValue(record.symbol)
    || stringValue(record.optimized_symbol)
    || stringValue(record.display_symbol)
    || stringValue(record.tokenSymbol)
    || "TOKEN";
  const symbol = canonicalAssetSymbol(rawSymbol);
  const name = stringValue(record.name) || stringValue(record.tokenName) || symbol;
  const state = normalizeState(
    stringValue(record.state) || stringValue(record.status) || stringValue(record.positionType) || stringValue(record.type),
    fallbackKind
  );

  return {
    id: stringValue(record.id) || stringValue(record.tokenId) || `${symbol}-${index}`,
    symbol,
    name,
    amount,
    priceUsd,
    priceSource: record.priceSource === "defillama" || record.priceSource === "debank-snapshot"
      ? record.priceSource
      : null,
    priceState: record.priceState === "fresh" ||
      record.priceState === "fallback" ||
      record.priceState === "stale" ||
      record.priceState === "excluded"
      ? record.priceState
      : null,
    priceUpdatedAt: stringValue(record.priceUpdatedAt),
    valueUsd,
    chain: stringValue(record.chain) || stringValue(record.chainId) || stringValue(record.chain_id),
    chainLabel: stringValue(record.chainLabel) || stringValue(record.chainName) || stringValue(record.chain_name),
    protocolName: stringValue(record.protocolName) || stringValue(record.protocolLabel) || stringValue(record.protocol),
    iconUrl: stringValue(record.iconUrl) || stringValue(record.logoUrl) || stringValue(record.logo_url),
    state,
    source: stringValue(record.source)
  };
}

function normalizePosition(value: unknown, index: number): WalletDetailPosition | null {
  const record = asRecord(value);
  if (!record) return null;
  const nestedTokens = firstArray(record.tokens, record.positionTokens, record.tokenList, record.token_list)
    .map((token, tokenIndex) => normalizeToken(token, tokenIndex, "position"))
    .filter((token): token is WalletDetailToken => Boolean(token));
  const assetUsd = finiteNumber(record.assetUsd, record.asset_usd, record.assetValueUsd, record.asset_value_usd);
  const debtUsd = finiteNumber(record.debtUsd, record.debt_usd, record.debtValueUsd, record.debt_value_usd);
  const nestedNet = nestedTokens.reduce((sum, token) => {
    return sum + (token.state === "borrowed" ? -Math.abs(token.valueUsd) : token.valueUsd);
  }, 0);
  const valueUsd = finiteNumber(record.valueUsd, record.value_usd, record.netUsdValue, record.net_usd_value, record.equity)
    ?? (assetUsd !== null || debtUsd !== null ? (assetUsd || 0) - (debtUsd || 0) : nestedNet);
  const rawState = stringValue(record.state) || stringValue(record.status) || stringValue(record.positionType) || stringValue(record.type) || stringValue(record.detailType);
  const state = normalizeState(rawState, "position");
  const protocolName = stringValue(record.protocolName)
    || stringValue(record.protocolLabel)
    || stringValue(record.protocol)
    || stringValue(record.name)
    || "DeFi protocol";

  return {
    id: stringValue(record.id) || stringValue(record.positionId) || `${protocolName}-${index}`,
    name: stringValue(record.name) || positionStateLabel(state),
    protocolName,
    protocolIconUrl: stringValue(record.protocolIconUrl) || stringValue(record.iconUrl) || stringValue(record.logoUrl) || stringValue(record.logo_url),
    protocolUrl: stringValue(record.protocolUrl) || stringValue(record.url),
    chain: stringValue(record.chain) || stringValue(record.chainId) || stringValue(record.chain_id),
    chainLabel: stringValue(record.chainLabel) || stringValue(record.chainName) || stringValue(record.chain_name),
    valueUsd,
    assetUsd,
    debtUsd,
    state,
    source: stringValue(record.source),
    apr: finiteNumber(record.apr, record.apy),
    unlockAt: stringValue(record.unlockAt) || stringValue(record.unlock_at),
    tokens: nestedTokens
  };
}

function normalizeState(value: string | null, fallbackKind: "token" | "position"): WalletPositionState {
  const normalized = (value || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (/unstak|pending withdraw|unbond/.test(normalized)) return "unstaking";
  if (/stake|delegat/.test(normalized)) return "staked";
  if (/lock|vesting/.test(normalized)) return "locked";
  if (/borrow|debt|loan/.test(normalized)) return "borrowed";
  if (/supply|lend|deposit/.test(normalized)) return "supplied";
  if (/liquidity|pool|\blp\b/.test(normalized)) return "liquidity";
  if (/vault/.test(normalized)) return "vault";
  if (/perp|margin|trading/.test(normalized)) return "trading";
  if (/claimable/.test(normalized)) return "claimable";
  if (/collateral/.test(normalized)) return "collateral";
  if (/reward|claim/.test(normalized)) return "rewards";
  if (/liquid|wallet|balance|available|spot/.test(normalized)) return "liquid";
  return fallbackKind === "token" ? "liquid" : "unknown";
}

function firstArray(...values: unknown[]) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(...values: unknown[]) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}
