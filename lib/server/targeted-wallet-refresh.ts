import type { LivePortfolioSnapshot, LiveWallet, PendingWalletMovement } from "../live-portfolio";
import type { PortfolioSourcePayload } from "./portfolio-source-state";
import { buildDeBankWalletHoldings, normalizeDeBankProtocolPositions, normalizeDeBankWalletTokens } from "./wallet-details";

type Row = Record<string, unknown>;
export type WalletRefreshCapture = {
  version: 1;
  address: string;
  capturedAt: string;
  tokens: Record<string, Row[]>;
  protocols: Record<string, Row[]>;
  usage: { requests: number; unitsBefore: number; unitsAfter: number };
};

/** Reject error objects, cross-chain responses and malformed rows before replacing anything. */
export function validateCapture(capture: WalletRefreshCapture) {
  if (capture.version !== 1 || !/^0x[a-fA-F0-9]{40}$/.test(capture.address) || !Number.isFinite(Date.parse(capture.capturedAt))) {
    throw new Error("Invalid wallet capture");
  }
  let requests = 0;
  for (const [kind, chains] of Object.entries({ tokens: capture.tokens, protocols: capture.protocols })) {
    if (!chains || typeof chains !== "object" || Array.isArray(chains)) throw new Error("Invalid capture scopes");
    for (const [chain, rows] of Object.entries(chains)) {
      requests++;
      if (!/^[a-z0-9_]{1,20}$/.test(chain) || !Array.isArray(rows)) throw new Error("Invalid chain response");
      for (const row of rows) {
        if (!row || row.chain !== chain || typeof row.id !== "string") throw new Error("Unexpected chain or missing identity");
        if (kind === "tokens" && (typeof row.amount !== "number" || !Number.isFinite(row.amount) || row.amount < 0 || typeof row.price !== "number" || !Number.isFinite(row.price) || row.price < 0)) {
          throw new Error("Invalid token balance or price");
        }
        if (kind === "protocols" && (!Array.isArray(row.portfolio_item_list) || row.portfolio_item_list.some((item: Row) => {
          const stats = item?.stats as Row | undefined;
          return !stats || ![stats.net_usd_value, stats.asset_usd_value, stats.debt_usd_value].every((n) => typeof n === "number" && Number.isFinite(n));
        }))) throw new Error("Invalid protocol valuation");
      }
    }
  }
  if (requests < 1 || requests > 6 || capture.usage?.requests !== requests) throw new Error("Capture exceeds the six-request limit or has incomplete scope");
}

export function validateMovements(rows: PendingWalletMovement[]) {
  if (!Array.isArray(rows) || rows.length > 20) throw new Error("Invalid pending movements");
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row || !row.id || ids.has(row.id) || !row.label || row.label.length > 80 || !row.asset || row.asset.length > 30 ||
      !/^\d+(\.\d+)?$/.test(row.amount) || !["queued", "awaiting-claim"].includes(row.status) ||
      !Number.isFinite(Date.parse(row.recordedAt)) || (row.expectedAt !== null && !Number.isFinite(Date.parse(row.expectedAt)))) {
      throw new Error("Invalid pending movement record");
    }
    ids.add(row.id);
  }
}

function walletHoldings(wallet: LiveWallet) {
  const positions = wallet.positions.filter((p) => p.source === "debank");
  return buildDeBankWalletHoldings({
    tokens: wallet.tokens.filter((t) => t.source === "debank"), positions,
    protocolValueUsd: positions.reduce((sum, p) => sum + p.valueUsd, 0), walletValueUsd: wallet.debankValueUsd
  });
}

function grouped(wallet: LiveWallet) {
  const rows = new Map<string, { name: string; amount: number | null; valueUsd: number }>();
  for (const holding of walletHoldings(wallet)) {
    const key = holding.symbol.toUpperCase();
    const previous = rows.get(key);
    rows.set(key, {
      name: holding.name,
      amount: holding.amount === null || previous?.amount === null ? null : (previous?.amount ?? 0) + holding.amount,
      valueUsd: (previous?.valueUsd ?? 0) + holding.valueUsd
    });
  }
  return rows;
}

/** Replace only captured chain/type pairs. Empty successful responses remove closed positions. */
export function applyWalletCapture(
  baseline: LivePortfolioSnapshot,
  capture: WalletRefreshCapture,
  otherPayloads: PortfolioSourcePayload[],
  movements?: PendingWalletMovement[],
  now = new Date().toISOString()
): { snapshot: LivePortfolioSnapshot; debankPayload: PortfolioSourcePayload } {
  validateCapture(capture);
  if (movements !== undefined) validateMovements(movements);
  const age = Date.parse(now) - Date.parse(capture.capturedAt);
  if (!Number.isFinite(age) || age < -60_000 || age > 24 * 3_600_000) throw new Error("Capture must be less than 24 hours old");
  const wallet = baseline.wallets.find((w) => w.address.toLowerCase() === capture.address.toLowerCase());
  const source = baseline.sources.find((s) => s.id === "debank");
  if (!wallet || !source || source.status !== "live" || wallet.status !== "live") throw new Error("A healthy tracked wallet baseline is required");
  const chainRefreshes = structuredClone(wallet.chainRefreshes ?? {});
  for (const [kind, chains] of Object.entries({ tokensAt: capture.tokens, protocolsAt: capture.protocols })) {
    for (const chain of Object.keys(chains)) {
      const oldAt = chainRefreshes[chain]?.[kind as "tokensAt" | "protocolsAt"] ?? wallet.compositionUpdatedAt;
      if (oldAt && Date.parse(oldAt) > Date.parse(capture.capturedAt)) throw new Error("Capture is older than the stored chain observation");
      chainRefreshes[chain] = { ...chainRefreshes[chain], [kind]: capture.capturedAt };
    }
  }
  const tokens = [
    ...wallet.tokens.filter((t) => t.source !== "debank" || !(t.chainId in capture.tokens)),
    ...Object.values(capture.tokens).flatMap((rows) => normalizeDeBankWalletTokens(rows, capture.capturedAt))
  ];
  const positions = [
    ...wallet.positions.filter((p) => p.source !== "debank" || !(p.chainId in capture.protocols)),
    ...Object.values(capture.protocols).flatMap((rows) => normalizeDeBankProtocolPositions(rows, [], capture.capturedAt))
  ];
  const debankValueUsd = tokens.filter((t) => t.source === "debank").reduce((s, t) => s + t.valueUsd, 0)
    + positions.filter((p) => p.source === "debank").reduce((s, p) => s + p.valueUsd, 0);
  const reported = wallet.rawDeBankReportedValueUsd ?? wallet.debankReportedValueUsd;
  const reconciliationUsd = reported === undefined ? 0 : reported - debankValueUsd;
  const updated: LiveWallet = {
    ...wallet, tokens, positions, chainRefreshes,
    ...(movements !== undefined ? { pendingMovements: movements } : {}),
    valueUsd: debankValueUsd + wallet.hyperliquidValueUsd, debankValueUsd,
    reconciliationUsd,
    reconciliationState: Math.abs(reconciliationUsd) > 100 && reported && Math.abs(reconciliationUsd) / reported > 0.02 ? "review-required" : "diagnostic",
    excludedTokenCount: tokens.filter((t) => t.valuationState === "excluded").length,
    tokenCount: tokens.filter((t) => t.valuationState !== "excluded").length,
    protocolCount: new Set(positions.map((p) => `${p.source}:${p.chainId}:${p.protocolId}`)).size,
    updatedAt: now
  };
  const previousRows = grouped(wallet);
  const nextRows = grouped(updated);
  const holdings = new Map(baseline.holdings.map((h) => [h.symbol, { ...h, sources: [...h.sources] }]));
  const otherAccountsWithSymbol = new Set(otherPayloads.filter((p) => p.source.id !== "debank")
    .flatMap((p) => p.holdings.filter((h) => h.accountId.toLowerCase() === wallet.address.toLowerCase()).map((h) => h.symbol.toUpperCase())));
  const wallets = baseline.wallets.map((w) => w.id === wallet.id ? updated : w);
  const otherDeBankSymbols = new Set(wallets.filter((w) => w.id !== wallet.id).flatMap((w) => [...grouped(w).keys()]));
  for (const symbol of new Set([...previousRows.keys(), ...nextRows.keys()])) {
    const old = previousRows.get(symbol);
    const next = nextRows.get(symbol);
    const current = holdings.get(symbol);
    const valueUsd = (current?.valueUsd ?? 0) - (old?.valueUsd ?? 0) + (next?.valueUsd ?? 0);
    const shared = otherAccountsWithSymbol.has(symbol);
    const accountCount = (current?.accountCount ?? 0) + (shared ? 0 : Number(Boolean(next)) - Number(Boolean(old)));
    const sources = new Set(current?.sources ?? []);
    if (next || otherDeBankSymbols.has(symbol)) sources.add(source.name);
    else sources.delete(source.name);
    // Null aggregate quantities cannot safely be recovered by subtracting one account.
    const amount = current?.amount === null || old?.amount === null || next?.amount === null
      ? null : (current?.amount ?? 0) - (old?.amount ?? 0) + (next?.amount ?? 0);
    if (Math.abs(valueUsd) < 0.01) holdings.delete(symbol);
    else holdings.set(symbol, { symbol, name: current?.name ?? next?.name ?? symbol, valueUsd, amount, accountCount: Math.max(1, accountCount), sources: [...sources] });
  }
  const delta = updated.debankValueUsd - wallet.debankValueUsd;
  // Retain global freshness dates: unqueried chains and wallets did not get a new observation.
  const updatedSource = { ...source, valueUsd: source.valueUsd + delta, pricing: undefined };
  const snapshot: LivePortfolioSnapshot = {
    ...baseline, generatedAt: now, delivery: undefined,
    netWorthUsd: baseline.netWorthUsd + delta, liveValueUsd: baseline.liveValueUsd + delta,
    groups: { ...baseline.groups, walletsUsd: baseline.groups.walletsUsd + delta },
    sources: baseline.sources.map((s) => s.id === source.id ? updatedSource : s),
    wallets, holdings: [...holdings.values()].sort((a, b) => b.valueUsd - a.valueUsd)
  };
  const debankWallets = wallets.map((w) => ({
    ...w, valueUsd: w.debankValueUsd, hyperliquidValueUsd: 0,
    tokens: w.tokens.filter((t) => t.source === "debank"), positions: w.positions.filter((p) => p.source === "debank")
  }));
  return { snapshot, debankPayload: {
    source: { ...updatedSource, updatedAt: now },
    wallets: debankWallets,
    holdings: debankWallets.flatMap((w) => walletHoldings(w).map((h) => ({ ...h, accountId: w.address })))
  } };
}
