import "server-only";

import type { LiveWalletToken } from "@/lib/live-portfolio";
import {
  getDeBankTokenExclusion,
  resolveDeBankContractAddress
} from "./wallet-details";

export const DEBANK_MARKET_PRICE_MIN_VALUE_USD = 1;
const batchSize = 50;
const requestTimeoutMs = 6_000;

type PriceRow = {
  price?: unknown;
  confidence?: unknown;
  timestamp?: unknown;
};

type DefiLlamaResponse = {
  coins?: Record<string, PriceRow>;
};

export type DefiLlamaPriceQuote = {
  priceUsd: number;
  fetchedAt: string;
  providerUpdatedAt: string | null;
  confidence: number | null;
};

export type DefiLlamaPriceResult = {
  quotes: Map<string, DefiLlamaPriceQuote>;
  eligibleKeys: Set<string>;
  fetchedAt: string;
  requestCount: number;
  successfulBatchCount: number;
  failedBatchCount: number;
  errors: string[];
};

const chainAdapters: Record<string, string> = {
  arb: "arbitrum",
  avax: "avax",
  base: "base",
  bsc: "bsc",
  celo: "celo",
  cro: "cronos",
  era: "era",
  eth: "ethereum",
  ftm: "fantom",
  gnosis: "xdai",
  linea: "linea",
  mantle: "mantle",
  mode: "mode",
  op: "optimism",
  opbnb: "opbnb",
  polygon: "polygon",
  matic: "polygon",
  scroll: "scroll",
  sonic: "sonic",
  xdai: "xdai",
  zksyncera: "era",
  blast: "blast",
  manta: "manta",
  zora: "zora"
};

const nativeAssets: Record<string, { symbols: string[]; priceKey: string }> = {
  arb: { symbols: ["ETH"], priceKey: "coingecko:ethereum" },
  base: { symbols: ["ETH"], priceKey: "coingecko:ethereum" },
  blast: { symbols: ["ETH"], priceKey: "coingecko:ethereum" },
  eth: { symbols: ["ETH"], priceKey: "coingecko:ethereum" },
  era: { symbols: ["ETH"], priceKey: "coingecko:ethereum" },
  linea: { symbols: ["ETH"], priceKey: "coingecko:ethereum" },
  manta: { symbols: ["ETH"], priceKey: "coingecko:ethereum" },
  mode: { symbols: ["ETH"], priceKey: "coingecko:ethereum" },
  op: { symbols: ["ETH"], priceKey: "coingecko:ethereum" },
  scroll: { symbols: ["ETH"], priceKey: "coingecko:ethereum" },
  zksyncera: { symbols: ["ETH"], priceKey: "coingecko:ethereum" },
  zora: { symbols: ["ETH"], priceKey: "coingecko:ethereum" },
  bsc: { symbols: ["BNB"], priceKey: "coingecko:binancecoin" },
  opbnb: { symbols: ["BNB"], priceKey: "coingecko:binancecoin" },
  polygon: { symbols: ["POL", "MATIC"], priceKey: "coingecko:matic-network" },
  matic: { symbols: ["POL", "MATIC"], priceKey: "coingecko:matic-network" },
  avax: { symbols: ["AVAX"], priceKey: "coingecko:avalanche-2" },
  celo: { symbols: ["CELO"], priceKey: "coingecko:celo" },
  cro: { symbols: ["CRO"], priceKey: "coingecko:crypto-com-chain" },
  ftm: { symbols: ["FTM"], priceKey: "coingecko:fantom" },
  gnosis: { symbols: ["XDAI"], priceKey: "coingecko:xdai" },
  xdai: { symbols: ["XDAI"], priceKey: "coingecko:xdai" }
};

export function getDefiLlamaPriceKey(token: LiveWalletToken) {
  if (
    token.source !== "debank" ||
    token.protocolId !== null ||
    token.state !== "liquid" ||
    token.amount === null ||
    !Number.isFinite(token.amount) ||
    token.amount === 0 ||
    getDeBankTokenExclusion(token) !== null
  ) return null;

  const chainId = token.chainId.toLowerCase();
  const contractAddress = resolveDeBankContractAddress(token);
  const snapshotValueUsd = token.snapshotValueUsd ?? token.valueUsd;
  if (contractAddress && Math.abs(snapshotValueUsd) >= DEBANK_MARKET_PRICE_MIN_VALUE_USD) {
    const adapter = chainAdapters[chainId];
    return adapter ? `${adapter}:${contractAddress}`.toLowerCase() : null;
  }

  const native = nativeAssets[chainId];
  return native?.symbols.includes(token.symbol.toUpperCase()) ? native.priceKey : null;
}

export async function fetchDefiLlamaPrices(
  tokens: LiveWalletToken[],
  now = new Date().toISOString()
): Promise<DefiLlamaPriceResult> {
  const eligibleKeys = new Set(
    tokens.map(getDefiLlamaPriceKey).filter((key): key is string => Boolean(key))
  );
  const quotes = new Map<string, DefiLlamaPriceQuote>();
  const errors: string[] = [];
  let requestCount = 0;
  let successfulBatchCount = 0;
  let failedBatchCount = 0;
  const keys = [...eligibleKeys];

  for (let index = 0; index < keys.length; index += batchSize) {
    const batch = keys.slice(index, index + batchSize);
    requestCount += 1;
    try {
      const body = await fetchBatch(batch);
      successfulBatchCount += 1;
      for (const [rawKey, row] of Object.entries(body.coins ?? {})) {
        const priceUsd = Number(row.price);
        if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;
        const timestamp = Number(row.timestamp);
        const providerUpdatedAt = Number.isFinite(timestamp) && timestamp > 0
          ? new Date(timestamp * 1_000).toISOString()
          : null;
        const confidence = Number(row.confidence);
        quotes.set(rawKey.toLowerCase(), {
          priceUsd,
          fetchedAt: now,
          providerUpdatedAt,
          confidence: Number.isFinite(confidence) ? confidence : null
        });
      }
    } catch (error) {
      failedBatchCount += 1;
      errors.push(error instanceof Error ? error.message : "DefiLlama price batch failed");
    }
  }

  return {
    quotes,
    eligibleKeys,
    fetchedAt: now,
    requestCount,
    successfulBatchCount,
    failedBatchCount,
    errors
  };
}

async function fetchBatch(keys: string[]) {
  const baseUrl = (process.env.DEFILLAMA_PRICE_BASE_URL || "https://coins.llama.fi").replace(/\/+$/, "");
  const encodedKeys = keys.map((key) => encodeURIComponent(key)).join(",");
  const url = `${baseUrl}/prices/current/${encodedKeys}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(requestTimeoutMs),
        headers: { accept: "application/json" }
      });
      if (response.ok) return await response.json() as DefiLlamaResponse;
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
        await waitBeforeRetry(response.headers.get("retry-after"));
        continue;
      }
      throw new Error(`DefiLlama price batch failed with HTTP ${response.status}`);
    } catch (error) {
      if (attempt === 0 && (error instanceof TypeError || error instanceof DOMException)) {
        await waitBeforeRetry(null);
        continue;
      }
      throw error;
    }
  }
  throw new Error("DefiLlama price batch failed");
}

function waitBeforeRetry(retryAfter: string | null) {
  const retryAfterSeconds = Number(retryAfter);
  const delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
    ? Math.min(1_000, retryAfterSeconds * 1_000)
    : 200;
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
