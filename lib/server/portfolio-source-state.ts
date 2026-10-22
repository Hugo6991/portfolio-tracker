import "server-only";
import type { AssetIdentity, HoldingValuation } from "../asset-identity";

import type { LiveSource, LiveWallet } from "../live-portfolio";

export type PortfolioSourceHolding = AssetIdentity & HoldingValuation & {
  symbol: string;
  name?: string;
  amount: number | null;
  valueUsd: number;
  accountId: string;
};

export type PortfolioSourcePayload = {
  source: LiveSource;
  holdings: PortfolioSourceHolding[];
  wallets?: LiveWallet[];
};

export type StoredPortfolioSourcePayload = PortfolioSourcePayload & {
  lastGoodAt: string;
};

type SourceStateRow = {
  source_id: string;
  last_good_at: string;
  last_good_payload: unknown;
};

const defaultMaxAgeSeconds = 86_400;
const defaultDeBankMaxAgeSeconds = 72 * 3_600;

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && serviceRoleKey ? { url, serviceRoleKey } : null;
}

function headers(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json"
  };
}

function getMaxAgeSeconds(sourceId: string) {
  const configured = Number(
    sourceId === "debank"
      ? process.env.DEBANK_SOURCE_LKG_MAX_AGE_SECONDS
      : process.env.PORTFOLIO_SOURCE_LKG_MAX_AGE_SECONDS
  );
  return Number.isFinite(configured) && configured >= 300
    ? Math.round(configured)
    : sourceId === "debank" ? defaultDeBankMaxAgeSeconds : defaultMaxAgeSeconds;
}

export async function readPortfolioSourcePayloads(
  now = Date.now()
): Promise<Map<string, StoredPortfolioSourcePayload>> {
  const config = getSupabaseConfig();
  if (!config) return new Map();
  const query = new URLSearchParams({
    select: "source_id,last_good_at,last_good_payload",
    last_good_payload: "not.is.null"
  });
  const response = await fetch(`${config.url}/rest/v1/portfolio_source_state?${query}`, {
    headers: headers(config.serviceRoleKey),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Portfolio source state read failed with HTTP ${response.status}`);

  const rows = await response.json() as SourceStateRow[];
  const payloads = new Map<string, StoredPortfolioSourcePayload>();
  for (const row of rows) {
    const lastGoodAt = Date.parse(row.last_good_at);
    const payload = parsePayload(row.last_good_payload, row.source_id);
    const maxAgeMs = getMaxAgeSeconds(row.source_id) * 1_000;
    if (!payload || !Number.isFinite(lastGoodAt) || now - lastGoodAt > maxAgeMs) continue;
    payloads.set(row.source_id, {
      ...payload,
      lastGoodAt: new Date(lastGoodAt).toISOString()
    });
  }
  return payloads;
}

function parsePayload(value: unknown, sourceId: string): PortfolioSourcePayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Partial<PortfolioSourcePayload>;
  const source = payload.source;
  if (
    !source ||
    source.id !== sourceId ||
    typeof source.name !== "string" ||
    !["exchange", "wallet", "bank"].includes(source.kind) ||
    !["live", "preview"].includes(source.status) ||
    !Number.isFinite(source.valueUsd) ||
    !Number.isFinite(source.itemCount) ||
    !Number.isFinite(Date.parse(source.updatedAt)) ||
    !Array.isArray(payload.holdings)
  ) return null;

  const holdings = payload.holdings.filter((holding): holding is PortfolioSourceHolding => (
    Boolean(holding) &&
    typeof holding.symbol === "string" &&
    (holding.name === undefined || typeof holding.name === "string") &&
    (holding.amount === null || Number.isFinite(holding.amount)) &&
    Number.isFinite(holding.valueUsd) &&
    typeof holding.accountId === "string"
  ));
  if (holdings.length !== payload.holdings.length) return null;
  if (payload.wallets !== undefined && !Array.isArray(payload.wallets)) return null;

  return {
    source,
    holdings,
    ...(payload.wallets ? { wallets: payload.wallets as LiveWallet[] } : {})
  };
}
