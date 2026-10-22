import { resolveAssetMark } from "../brand-marks";
import { walletAssetIdentity, type AssetIdentity } from "../asset-identity";
import type {
  LiveWalletAssetState,
  LiveWalletPosition,
  LiveWalletToken
} from "../live-portfolio";

type UnknownRecord = Record<string, unknown>;

const deniedTokenIds = new Set([
  "bsc:0x9335d29adc453201ccb1184b8842d7cb8d294444"
]);

const nativeSymbols: Record<string, string[]> = {
  arb: ["ETH"],
  avax: ["AVAX"],
  base: ["ETH"],
  blast: ["ETH"],
  bsc: ["BNB"],
  celo: ["CELO"],
  cro: ["CRO"],
  era: ["ETH"],
  eth: ["ETH"],
  ftm: ["FTM"],
  gnosis: ["XDAI"],
  linea: ["ETH"],
  manta: ["ETH"],
  matic: ["MATIC", "POL"],
  mode: ["ETH"],
  op: ["ETH"],
  opbnb: ["BNB"],
  polygon: ["MATIC", "POL"],
  scroll: ["ETH"],
  sonic: ["S"],
  xdai: ["XDAI"],
  zksyncera: ["ETH"],
  zora: ["ETH"]
};

type DeBankTokenContext = {
  chainId?: string;
  protocolId?: string | null;
  protocolName?: string | null;
  state: LiveWalletAssetState;
  scope: string;
  index: number;
  priceUpdatedAt?: string;
};

export type HyperliquidDetailsInput = {
  address: string;
  hypePriceUsd: number;
  staking: {
    delegated?: string;
    undelegated?: string;
    totalPendingWithdrawal?: string;
  };
  perps: { marginSummary?: { accountValue?: string } };
  vaults: Array<{
    vaultAddress?: string;
    name?: string;
    equity?: string;
    lockupUntil?: number | string;
    lockedUntilTimestamp?: number | string;
    lockedUntil?: number | string;
  }>;
  nowMs?: number;
};

export type DeBankWalletHolding = AssetIdentity & {
  symbol: string;
  name: string;
  amount: number | null;
  valueUsd: number;
};

export type DeBankWalletHoldingsInput = {
  tokens: LiveWalletToken[];
  positions: LiveWalletPosition[];
  protocolValueUsd: number;
  walletValueUsd: number;
};

const chainNames: Record<string, string> = {
  arb: "Arbitrum",
  avax: "Avalanche",
  base: "Base",
  bsc: "BNB Chain",
  celo: "Celo",
  cro: "Cronos",
  eth: "Ethereum",
  era: "zkSync Era",
  ftm: "Fantom",
  gnosis: "Gnosis",
  linea: "Linea",
  mantle: "Mantle",
  mode: "Mode",
  op: "Optimism",
  opbnb: "opBNB",
  polygon: "Polygon",
  scroll: "Scroll",
  sonic: "Sonic",
  zksyncera: "zkSync Era"
};

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function asRecords(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((row): row is UnknownRecord => row !== null)
    : [];
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstString(record: UnknownRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = nonEmptyString(record[key]);
    if (value) return value;
  }
  return null;
}

function normalizedChainId(value: unknown) {
  return nonEmptyString(value)?.toLowerCase() || "unknown";
}

export function getWalletChainName(chainId: string) {
  const normalized = normalizedChainId(chainId);
  if (chainNames[normalized]) return chainNames[normalized];
  if (normalized === "unknown") return "Unknown chain";
  return normalized
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeUrl(value: unknown) {
  const url = nonEmptyString(value);
  return url && /^(?:https?:\/\/|\/)/i.test(url) ? url : null;
}

function tokenValueUsd(token: UnknownRecord, amount: number | null, priceUsd: number | null) {
  const explicit = finiteNumber(token.usd_value) ?? finiteNumber(token.value_usd);
  if (explicit !== null) return Math.abs(explicit);
  return amount !== null && priceUsd !== null ? Math.abs(amount * priceUsd) : 0;
}

function allowlistedTokenIds() {
  return new Set(
    (process.env.DEBANK_TOKEN_ALLOWLIST || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => /^[a-z0-9_-]+:0x[a-f0-9]{40}$/.test(value))
  );
}

export function resolveDeBankContractAddress(token: Pick<LiveWalletToken, "contractAddress" | "id">) {
  if (token.contractAddress && /^0x[a-fA-F0-9]{40}$/.test(token.contractAddress)) {
    return token.contractAddress.toLowerCase();
  }
  return token.id.match(/:balance:(0x[a-fA-F0-9]{40}):/)?.[1]?.toLowerCase() ?? null;
}

function isNativeTokenId(chainId: string, tokenKey: string, contractAddress: string | null) {
  return contractAddress === null && tokenKey.toLowerCase() === chainId;
}

function nativeSymbolIsImpersonated(chainId: string, symbol: string, contractAddress: string | null) {
  return contractAddress !== null && (nativeSymbols[chainId] ?? []).includes(symbol.toUpperCase());
}

export function getDeBankTokenExclusion(token: LiveWalletToken): LiveWalletToken["exclusionReason"] | null {
  if (token.source !== "debank") return null;
  const contractAddress = resolveDeBankContractAddress(token);
  const tokenId = contractAddress ? `${token.chainId.toLowerCase()}:${contractAddress}` : null;
  if (tokenId && deniedTokenIds.has(tokenId)) return "denylisted";
  if (nativeSymbolIsImpersonated(token.chainId.toLowerCase(), token.symbol, contractAddress)) {
    return "native-symbol-impersonation";
  }
  if (tokenId && allowlistedTokenIds().has(tokenId)) return null;
  if (token.verificationState === "unverified") return "unverified";
  if (token.verificationState === "unknown") return "legacy-unverified";
  if (token.verificationState === "verified") return null;

  const legacyNative = token.id.match(/^debank:([^:]+):wallet:balance:([^:]+):liquid:/);
  if (
    contractAddress === null &&
    legacyNative?.[1]?.toLowerCase() === token.chainId.toLowerCase() &&
    legacyNative?.[2]?.toLowerCase() === token.chainId.toLowerCase()
  ) return null;
  return "legacy-unverified";
}

function normalizeDeBankToken(token: UnknownRecord, context: DeBankTokenContext): LiveWalletToken {
  const chainId = normalizedChainId(token.chain ?? context.chainId);
  const symbol = firstString(token, ["optimized_symbol", "display_symbol", "symbol"]) || "UNKNOWN";
  const name = nonEmptyString(token.name) || symbol;
  const amount = finiteNumber(token.amount);
  const priceUsd = finiteNumber(token.price);
  const tokenKey = firstString(token, ["id", "address"]) || symbol;
  const contractAddress = /^0x[a-fA-F0-9]{40}$/.test(tokenKey) ? tokenKey.toLowerCase() : null;
  const protocolId = context.protocolId || null;
  const tokenId = contractAddress ? `${chainId}:${contractAddress}` : null;
  const explicitlyAllowlisted = tokenId !== null && allowlistedTokenIds().has(tokenId);
  const debankIsVerified = typeof token.is_verified === "boolean" ? token.is_verified : null;
  const debankIsCore = typeof token.is_core === "boolean" ? token.is_core : null;
  const verified = isNativeTokenId(chainId, tokenKey, contractAddress) ||
    debankIsVerified === true || debankIsCore === true || explicitlyAllowlisted;
  const verificationState = verified
    ? "verified"
    : debankIsVerified === false || debankIsCore === false
      ? "unverified"
      : "unknown";
  const snapshotValueUsd = tokenValueUsd(token, amount, priceUsd);
  const baseToken: LiveWalletToken = {
    id: ["debank", chainId, protocolId || "wallet", context.scope, tokenKey, context.state, context.index].join(":"),
    source: "debank",
    symbol,
    name,
    chainId,
    chainName: getWalletChainName(chainId),
    protocolId,
    protocolName: context.protocolName || null,
    iconUrl: normalizeUrl(token.logo_url) || resolveAssetMark(symbol),
    contractAddress,
    verificationState,
    debankIsVerified,
    debankIsCore,
    valuationState: verified ? "fallback" : "excluded",
    amount,
    priceUsd,
    snapshotPriceUsd: priceUsd,
    snapshotPriceUpdatedAt: context.priceUpdatedAt ?? null,
    snapshotValueUsd,
    priceSource: "debank-snapshot",
    priceState: verified ? "fallback" : "excluded",
    priceUpdatedAt: context.priceUpdatedAt ?? null,
    valueUsd: snapshotValueUsd,
    state: context.state
  };
  const exclusionReason = getDeBankTokenExclusion(baseToken);

  return {
    ...baseToken,
    ...(exclusionReason ? {
      valuationState: "excluded",
      exclusionReason,
      priceState: "excluded",
      valueUsd: 0
    } : {})
  };
}

export function normalizeDeBankWalletTokens(
  tokens: Array<Record<string, unknown>>,
  priceUpdatedAt?: string
): LiveWalletToken[] {
  return tokens
    .map((token, index) => normalizeDeBankToken(token, {
      state: "liquid",
      scope: "balance",
      index,
      priceUpdatedAt
    }))
    .filter((token) => token.amount !== 0 && (token.amount !== null || token.valueUsd !== 0))
    .sort((left, right) => right.valueUsd - left.valueUsd);
}

function inferState(value: string, fallback: LiveWalletAssetState = "unknown"): LiveWalletAssetState {
  const label = value.toLowerCase();
  if (/reward|claim|earned|airdrop/.test(label)) return "claimable";
  if (/borrow|debt|loan/.test(label)) return "borrowed";
  if (/collateral/.test(label)) return "collateral";
  if (/lock|vesting|pending.?withdraw/.test(label)) return "locked";
  if (/stake|delegat/.test(label)) return "staked";
  if (/perpetual|trading|margin/.test(label)) return "trading";
  if (/vault/.test(label)) return "vault";
  if (/supply|deposit|lend|liquidity|liquidit|farm|pool|yield|lp_/.test(label)) return "supplied";
  return fallback;
}

function inferTokenState(value: string, fallback: LiveWalletAssetState) {
  const inferred = inferState(value, fallback);
  if (
    inferred === "supplied" &&
    (fallback === "staked" || fallback === "locked" || fallback === "collateral")
  ) {
    return fallback;
  }
  return inferred;
}

function looksLikeToken(value: UnknownRecord) {
  return Boolean(
    nonEmptyString(value.symbol) ||
    nonEmptyString(value.display_symbol) ||
    nonEmptyString(value.optimized_symbol)
  ) && (value.amount !== undefined || value.price !== undefined || value.usd_value !== undefined);
}

function extractPositionTokens(
  detail: UnknownRecord,
  context: Omit<DeBankTokenContext, "state" | "index">,
  fallbackState: LiveWalletAssetState
) {
  const result: LiveWalletToken[] = [];
  const seenObjects = new Set<UnknownRecord>();

  const visit = (record: UnknownRecord, path: string) => {
    if (seenObjects.has(record)) return;
    seenObjects.add(record);

    for (const [key, value] of Object.entries(record)) {
      const state = inferTokenState(`${path} ${key}`, fallbackState);
      if (Array.isArray(value)) {
        const tokenRecords = asRecords(value).filter(looksLikeToken);
        tokenRecords.forEach((token, index) => {
          result.push(normalizeDeBankToken(token, {
            ...context,
            state,
            scope: `${context.scope}:${path}:${key}`,
            index
          }));
        });
        asRecords(value)
          .filter((row) => !looksLikeToken(row))
          .forEach((row, index) => {
            visit(row, `${path}:${key}:${index}`);
          });
      } else {
        const nested = asRecord(value);
        if (!nested) continue;
        if (looksLikeToken(nested)) {
          result.push(normalizeDeBankToken(nested, {
            ...context,
            state,
            scope: `${context.scope}:${path}:${key}`,
            index: 0
          }));
        } else {
          visit(nested, `${path}:${key}`);
        }
      }
    }
  };

  visit(detail, "detail");
  return result.sort((left, right) => right.valueUsd - left.valueUsd);
}

function unixOrIsoDate(value: unknown): string | null {
  const text = nonEmptyString(value);
  if (text && Number.isNaN(Number(text))) {
    const timestamp = Date.parse(text);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  }
  const numeric = finiteNumber(value);
  if (numeric === null || numeric <= 0) return null;
  const timestamp = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function findUnlockAt(detail: UnknownRecord) {
  for (const key of ["unlock_at", "unlock_time", "locked_until", "end_at"]) {
    const value = unixOrIsoDate(detail[key]);
    if (value) return value;
  }
  return null;
}

function protocolIdentity(protocol: UnknownRecord) {
  const chainId = normalizedChainId(protocol.chain);
  const protocolId = firstString(protocol, ["id", "protocol_id"]) || "unknown-protocol";
  return { chainId, protocolId, key: `${chainId}:${protocolId}` };
}

export function normalizeDeBankProtocolPositions(
  complexProtocols: Array<Record<string, unknown>>,
  simpleProtocols: Array<Record<string, unknown>> = [],
  priceUpdatedAt?: string
): LiveWalletPosition[] {
  const positions: LiveWalletPosition[] = [];
  const detailedProtocols = new Set<string>();

  complexProtocols.forEach((protocol, protocolIndex) => {
    const { chainId, protocolId, key } = protocolIdentity(protocol);
    const protocolName = nonEmptyString(protocol.name) || protocolId;
    const protocolIconUrl = normalizeUrl(protocol.logo_url);
    const protocolUrl = normalizeUrl(protocol.site_url);
    const items = asRecords(protocol.portfolio_item_list);
    if (items.length) detailedProtocols.add(key);

    items.forEach((item, itemIndex) => {
      const detail = asRecord(item.detail) || {};
      const stats = asRecord(item.stats) || {};
      const name = firstString(item, ["name", "display_name"]) || `${protocolName} position`;
      const detailTypes = Array.isArray(item.detail_types)
        ? item.detail_types.filter((value): value is string => typeof value === "string").join(" ")
        : "";
      const state = inferState(`${name} ${detailTypes}`);
      const tokens = extractPositionTokens(detail, {
        chainId,
        protocolId,
        protocolName,
        scope: `position-${protocolIndex}-${itemIndex}`,
        priceUpdatedAt
      }, state);
      const assetValueUsd = Math.abs(finiteNumber(stats.asset_usd_value) ?? 0);
      const debtValueUsd = Math.abs(finiteNumber(stats.debt_usd_value) ?? 0);
      const explicitNetValueUsd = finiteNumber(stats.net_usd_value);
      const tokenNetValueUsd = tokens.reduce(
        (sum, token) => sum + (token.state === "borrowed" ? -token.valueUsd : token.valueUsd),
        0
      );
      const valueUsd = explicitNetValueUsd ?? (assetValueUsd || debtValueUsd
        ? assetValueUsd - debtValueUsd
        : tokenNetValueUsd);

      positions.push({
        id: `debank:${chainId}:${protocolId}:position:${itemIndex}`,
        source: "debank",
        protocolId,
        protocolName,
        protocolIconUrl,
        protocolUrl,
        chainId,
        chainName: getWalletChainName(chainId),
        name,
        state,
        valueUsd,
        assetValueUsd,
        debtValueUsd,
        unlockAt: findUnlockAt(detail),
        tokens
      });
    });
  });

  simpleProtocols.forEach((protocol, index) => {
    const { chainId, protocolId, key } = protocolIdentity(protocol);
    if (detailedProtocols.has(key)) return;
    const protocolName = nonEmptyString(protocol.name) || protocolId;
    const assetValueUsd = Math.abs(finiteNumber(protocol.asset_usd_value) ?? 0);
    const debtValueUsd = Math.abs(finiteNumber(protocol.debt_usd_value) ?? 0);
    const valueUsd = finiteNumber(protocol.net_usd_value) ?? assetValueUsd - debtValueUsd;
    positions.push({
      id: `debank:${chainId}:${protocolId}:summary:${index}`,
      source: "debank",
      protocolId,
      protocolName,
      protocolIconUrl: normalizeUrl(protocol.logo_url),
      protocolUrl: normalizeUrl(protocol.site_url),
      chainId,
      chainName: getWalletChainName(chainId),
      name: `${protocolName} position`,
      state: "unknown",
      valueUsd,
      assetValueUsd,
      debtValueUsd,
      unlockAt: null,
      tokens: []
    });
  });

  return positions.sort((left, right) => right.valueUsd - left.valueUsd);
}

/**
 * Converts trusted DeBank detail rows into one signed holding ledger. Nested
 * position tokens explain a position; their signed values plus an internal
 * DeFi residual equal the position net value, so the position is never counted
 * again as a second asset. `walletValueUsd` is the trusted detail estimate,
 * never the raw `total_balance` diagnostic.
 */
export function buildDeBankWalletHoldings({
  tokens,
  positions,
  protocolValueUsd,
  walletValueUsd
}: DeBankWalletHoldingsInput): DeBankWalletHolding[] {
  const holdings: DeBankWalletHolding[] = tokens.map((token) => ({
    ...walletAssetIdentity(token),
    symbol: token.symbol,
    name: token.name,
    amount: token.amount,
    valueUsd: token.valueUsd
  }));

  let detailedProtocolValueUsd = 0;
  for (const position of positions) {
    const nested = position.tokens.map<DeBankWalletHolding>((token) => {
      const direction = token.state === "borrowed" ? -1 : 1;
      return {
        ...walletAssetIdentity(token),
        symbol: token.symbol,
        name: token.name,
        amount: token.amount === null ? null : Math.abs(token.amount) * direction,
        valueUsd: Math.abs(token.valueUsd) * direction
      };
    });
    const nestedValueUsd = nested.reduce((sum, holding) => sum + holding.valueUsd, 0);
    holdings.push(...nested);
    pushReconciliationHolding(
      holdings,
      position.valueUsd - nestedValueUsd,
      `${position.protocolName} position reconciliation`
    );
    detailedProtocolValueUsd += position.valueUsd;
  }

  pushReconciliationHolding(
    holdings,
    protocolValueUsd - detailedProtocolValueUsd,
    "DeBank protocol reconciliation"
  );

  const detailedWalletValueUsd = holdings.reduce((sum, holding) => sum + holding.valueUsd, 0);
  pushReconciliationHolding(
    holdings,
    walletValueUsd - detailedWalletValueUsd,
    "DeBank total reconciliation",
    "DEBANK-RECONCILIATION"
  );

  return holdings.filter((holding) => Math.abs(holding.valueUsd) >= 0.01);
}

function pushReconciliationHolding(
  holdings: DeBankWalletHolding[],
  valueUsd: number,
  name: string,
  symbol = "DEFI"
) {
  if (!Number.isFinite(valueUsd) || Math.abs(valueUsd) < 0.01) return;
  holdings.push({ symbol, name, amount: null, valueUsd });
}

function hyperliquidToken(
  address: string,
  scope: string,
  amount: number,
  priceUsd: number,
  state: LiveWalletAssetState
): LiveWalletToken {
  return {
    id: `hyperliquid:${address.toLowerCase()}:staking:${scope}`,
    source: "hyperliquid",
    symbol: "HYPE",
    name: "Hyperliquid",
    chainId: "hyperliquid",
    chainName: "Hyperliquid",
    protocolId: "hyperliquid-staking",
    protocolName: "Hyperliquid Staking",
    iconUrl: resolveAssetMark("HYPE"),
    amount,
    priceUsd,
    valueUsd: amount * priceUsd,
    state
  };
}

export function normalizeHyperliquidPositions(input: HyperliquidDetailsInput): LiveWalletPosition[] {
  const positions: LiveWalletPosition[] = [];
  const delegated = finiteNumber(input.staking.delegated) ?? 0;
  const undelegated = finiteNumber(input.staking.undelegated) ?? 0;
  const pendingWithdrawal = finiteNumber(input.staking.totalPendingWithdrawal) ?? 0;
  const stakingTokens = [
    delegated > 0 ? hyperliquidToken(input.address, "delegated", delegated, input.hypePriceUsd, "staked") : null,
    undelegated > 0 ? hyperliquidToken(input.address, "undelegated", undelegated, input.hypePriceUsd, "liquid") : null,
    pendingWithdrawal > 0
      ? hyperliquidToken(input.address, "pending-withdrawal", pendingWithdrawal, input.hypePriceUsd, "locked")
      : null
  ]
    .filter((token): token is LiveWalletToken => token !== null)
    .sort((left, right) => right.valueUsd - left.valueUsd);
  const stakingValueUsd = stakingTokens.reduce((sum, token) => sum + token.valueUsd, 0);

  if (stakingValueUsd >= 0.01) {
    positions.push({
      id: `hyperliquid:${input.address.toLowerCase()}:staking`,
      source: "hyperliquid",
      protocolId: "hyperliquid-staking",
      protocolName: "Hyperliquid Staking",
      protocolIconUrl: resolveAssetMark("HYPE"),
      protocolUrl: "https://app.hyperliquid.xyz/staking",
      chainId: "hyperliquid",
      chainName: "Hyperliquid",
      name: "HYPE staking",
      state: delegated > 0 ? "staked" : pendingWithdrawal > 0 ? "locked" : "liquid",
      valueUsd: stakingValueUsd,
      assetValueUsd: stakingValueUsd,
      debtValueUsd: 0,
      unlockAt: null,
      tokens: stakingTokens
    });
  }

  const tradingValueUsd = finiteNumber(input.perps.marginSummary?.accountValue) ?? 0;
  if (tradingValueUsd >= 0.01) {
    positions.push({
      id: `hyperliquid:${input.address.toLowerCase()}:perps`,
      source: "hyperliquid",
      protocolId: "hyperliquid-perps",
      protocolName: "Hyperliquid Perps",
      protocolIconUrl: resolveAssetMark("HYPE"),
      protocolUrl: "https://app.hyperliquid.xyz/trade",
      chainId: "hyperliquid",
      chainName: "Hyperliquid",
      name: "Trading account equity",
      state: "trading",
      valueUsd: tradingValueUsd,
      assetValueUsd: tradingValueUsd,
      debtValueUsd: 0,
      unlockAt: null,
      tokens: []
    });
  }

  const nowMs = input.nowMs ?? Date.now();
  input.vaults.forEach((vault, index) => {
    const valueUsd = finiteNumber(vault.equity) ?? 0;
    if (valueUsd < 0.01) return;
    const vaultAddress = nonEmptyString(vault.vaultAddress) || `vault-${index}`;
    const unlockAt = unixOrIsoDate(vault.lockupUntil ?? vault.lockedUntilTimestamp ?? vault.lockedUntil);
    const isLocked = unlockAt !== null && new Date(unlockAt).getTime() > nowMs;
    positions.push({
      id: `hyperliquid:${input.address.toLowerCase()}:vault:${vaultAddress.toLowerCase()}`,
      source: "hyperliquid",
      protocolId: "hyperliquid-vaults",
      protocolName: "Hyperliquid Vaults",
      protocolIconUrl: resolveAssetMark("HYPE"),
      protocolUrl: "https://app.hyperliquid.xyz/vaults",
      chainId: "hyperliquid",
      chainName: "Hyperliquid",
      name: nonEmptyString(vault.name) || `Vault ${vaultAddress.slice(0, 6)}…${vaultAddress.slice(-4)}`,
      state: isLocked ? "locked" : "vault",
      valueUsd,
      assetValueUsd: valueUsd,
      debtValueUsd: 0,
      unlockAt: isLocked ? unlockAt : null,
      tokens: []
    });
  });

  return positions.sort((left, right) => right.valueUsd - left.valueUsd);
}
