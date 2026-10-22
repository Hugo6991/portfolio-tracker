import "server-only";

import { createHash, createHmac } from "node:crypto";
import { VALUATION_BASIS } from "../valuation-basis";
import {
  CEX_EXCHANGES,
  OKX_SIMPLE_EARN_ACCOUNT_ID,
  finalizeCexSnapshot,
  getCexExchangeName,
  getCexBucketAt,
  mergeCexAccounts,
  sanitizeCexError,
  type CexAccount,
  type CexExchange,
  type CexHolding,
  type CexSourceSnapshot
} from "../cex";

const requestTimeoutMs = 20_000;
const stablecoins = new Set(["USD", "USDT", "USDC", "BUSD", "FDUSD", "TUSD", "USDP", "DAI", "USD1"]);
const htxBaseUrl = "https://api.huobi.pro";
const htxSpotBalanceTypes = new Set(["trade", "frozen"]);
const gateBaseUrl = "https://api.gateio.ws";
const gateApiPrefix = "/api/v4";

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
    body: unknown
  ) {
    super(`HTTP ${status}: ${JSON.stringify(body)}`);
  }
}

function getRetryAfterMs(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function getJson<T>(url: string | URL, init?: RequestInit, retries = 1): Promise<T> {
  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text.slice(0, 120) };
    }
    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && retries > 0) {
        return getJson<T>(url, init, retries - 1);
      }
      throw new HttpStatusError(
        response.status,
        getRetryAfterMs(response.headers.get("retry-after")),
        body
      );
    }
    return body as T;
  } catch (error) {
    if (retries > 0 && (error instanceof TypeError || error instanceof DOMException)) {
      return getJson<T>(url, init, retries - 1);
    }
    throw error;
  }
}

function priceFromPairs(asset: string, prices: Map<string, number>, separator = "") {
  const symbol = asset.toUpperCase();
  if (stablecoins.has(symbol)) return 1;
  for (const quote of ["USDT", "USDC", "FDUSD", "USD1"]) {
    const direct = prices.get(`${symbol}${separator}${quote}`);
    if (direct) return direct;
  }
  const btc = prices.get(`${symbol}${separator}BTC`);
  const btcUsd = prices.get(`BTC${separator}USDT`);
  return btc && btcUsd ? btc * btcUsd : null;
}

export function getRequiredUsdValue(
  asset: string,
  amount: number,
  prices: Map<string, number>,
  separator = ""
) {
  if (!Number.isFinite(amount)) throw new Error(`Invalid ${asset.toUpperCase()} amount`);
  if (amount === 0) return 0;
  const price = priceFromPairs(asset, prices, separator);
  if (price === null || !Number.isFinite(price) || price <= 0) {
    throw new Error(`Ticker response did not include a USD price for ${asset.toUpperCase()}`);
  }
  return amount * price;
}

export function getOptionalUsdValue(
  asset: string,
  amount: number,
  prices: Map<string, number>,
  separator = ""
) {
  if (!Number.isFinite(amount)) throw new Error(`Invalid ${asset.toUpperCase()} amount`);
  if (amount === 0) return 0;
  const price = priceFromPairs(asset, prices, separator);
  return price !== null && Number.isFinite(price) && price > 0 ? amount * price : null;
}

function getReportedUsdValue(asset: string, amount: number, rawValue: string) {
  const value = Number(rawValue);
  if (!Number.isFinite(amount)) throw new Error(`Invalid ${asset.toUpperCase()} amount`);
  if (amount !== 0 && (rawValue === "" || !Number.isFinite(value) || value <= 0)) {
    throw new Error(`Balance response did not include a USD value for ${asset.toUpperCase()}`);
  }
  return Number.isFinite(value) ? value : 0;
}

export function parseRequiredCexNumber(value: unknown, field: string) {
  if (value === null || value === undefined || value === "") {
    throw new Error(`${field} is missing`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} is invalid`);
  return parsed;
}

function holding(
  exchange: CexExchange,
  accountType: string,
  symbol: string,
  amount: number | null,
  valueUsd: number | null
): CexHolding {
  return { exchange, accountType, symbol: symbol.toUpperCase(), amount, valueUsd };
}

async function account(
  id: string,
  name: string,
  request: () => Promise<CexHolding[]>
): Promise<CexAccount> {
  try {
    const holdings = (await request()).filter((row) => row.amount !== 0 && (row.valueUsd === null || row.valueUsd >= 0.01));
    return {
      id,
      name,
      status: "live",
      valueUsd: holdings.reduce((sum, row) => sum + (row.valueUsd || 0), 0),
      itemCount: holdings.length,
      holdings
    };
  } catch (error) {
    return { id, name, status: "error", valueUsd: 0, itemCount: 0, holdings: [], error: sanitizeCexError(error) };
  }
}

function snapshot(exchange: CexExchange, name: string, now: string, accounts: CexAccount[]): CexSourceSnapshot {
  return finalizeCexSnapshot({
    pricingBasis: VALUATION_BASIS,
    exchange,
    name,
    status: "error",
    capturedAt: now,
    bucketAt: getCexBucketAt(now),
    valueUsd: 0,
    itemCount: 0,
    accounts,
    holdings: [],
    errors: accounts
      .filter((item) => item.error)
      .map((item) => ({ accountType: item.name, message: item.error || "Sync failed" }))
  });
}

async function binanceSigned<T>(
  path: string,
  options: {
    baseUrl?: string;
    method?: "GET" | "POST";
    params?: Record<string, string | number>;
    serverTime: number;
  }
) {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !secret) throw new Error("API credentials missing");
  const query = new URLSearchParams({
    ...Object.fromEntries(Object.entries(options.params || {}).map(([key, value]) => [key, String(value)])),
    timestamp: String(options.serverTime),
    recvWindow: "10000"
  }).toString();
  const signature = createHmac("sha256", secret).update(query).digest("hex");
  return getJson<T>(`${options.baseUrl || "https://api.binance.com"}${path}?${query}&signature=${signature}`, {
    method: options.method || "GET",
    headers: {
      "X-MBX-APIKEY": apiKey,
      ...((options.method || "GET") === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {})
    }
  });
}

export async function fetchBinanceCex(now: string): Promise<CexSourceSnapshot> {
  const marketHeaders = { "X-MBX-APIKEY": process.env.BINANCE_API_KEY || "" };
  const [server, tickers, tokenizedAssets] = await Promise.all([
    getJson<{ serverTime: number }>("https://api.binance.com/api/v3/time"),
    getJson<Array<{ symbol: string; price: string }>>("https://api.binance.com/api/v3/ticker/price"),
    getJson<BinanceTokenizedAsset[]>("https://api.binance.com/sapi/v1/equity/market/tokenized-assets", {
      headers: marketHeaders
    }, 0)
  ]);
  if (!Array.isArray(tokenizedAssets)) {
    throw new Error("Binance tokenized asset metadata is unavailable");
  }
  const mappings = tokenizedAssets;
  const assetsByCode = new Map(mappings.map((asset) => [asset.assetCode, asset]));
  const prices = new Map(tickers.map((ticker) => [ticker.symbol, Number(ticker.price)]));
  const priced = (accountType: string, symbol: string, amount: number): CexHolding => {
    const row = holding("binance", accountType, symbol, amount, getOptionalUsdValue(symbol, amount, prices));
    const mapping = assetsByCode.get(symbol);
    return {
      ...row,
      valuationState: row.valueUsd === null ? "unpriced" : "priced",
      ...(row.valueUsd === null ? { valuationReason: "market-price-unavailable" } : {}),
      assetClass: mapping ? "equity" : "crypto",
      ...(mapping ? { exposureSymbol: mapping.underlyingEquitySymbol, name: mapping.assetName } : {}),
      priceUsd: amount && row.valueUsd !== null ? row.valueUsd / amount : null,
      ...(row.valueUsd !== null ? { priceSource: "binance-spot" } : {})
    };
  };
  const quotes = new Map<string, Promise<BinanceEquityPrice | null>>();
  const equityPrice = (symbol: string) => {
    if (!quotes.has(symbol)) quotes.set(symbol, getJson<BinanceEquityQuote>(
      `https://api.binance.com/sapi/v1/equity/market/quote?symbol=${encodeURIComponent(symbol)}`,
      { headers: marketHeaders }, 0
    ).then((quote) => resolveBinanceEquityPrice(symbol, quote, mappings, prices))
      .catch(() => resolveBinanceEquityPrice(symbol, null, mappings, prices)));
    return quotes.get(symbol)!;
  };
  const signed = <T,>(path: string, options: Omit<Parameters<typeof binanceSigned<T>>[1], "serverTime"> = {}) =>
    binanceSigned<T>(path, { ...options, serverTime: server.serverTime });
  const accounts = await Promise.all([
    account("binance-spot", "Spot", async () => {
      const body = await signed<{ balances: Array<{ asset: string; free: string; locked: string }> }>("/api/v3/account");
      return body.balances.map((row) => priced("Spot", row.asset, Number(row.free) + Number(row.locked)));
    }),
    account("binance-funding", "Funding", async () => {
      const rows = await signed<Array<{ asset: string; free: string; locked: string; freeze: string; withdrawing: string }>>("/sapi/v1/asset/get-funding-asset", { method: "POST" });
      return Promise.all(rows.map(async (row) => {
        const amount = [row.free, row.locked, row.freeze, row.withdrawing]
          .reduce((sum, value) => sum + parseRequiredCexNumber(value, `Binance ${row.asset} balance`), 0);
        const match = /^EQ_([A-Z0-9.]+)$/.exec(row.asset);
        if (!match || amount === 0) return priced("Funding", row.asset, amount);
        const quote = await equityPrice(match[1]);
        if (!quote) throw new Error(`Stock price unavailable for ${row.asset}`);
        return {
          ...holding("binance", "Funding", row.asset, amount, amount * quote.priceUsd),
          assetClass: "equity" as const,
          valuationState: "priced" as const,
          exposureSymbol: match[1],
          ...quote
        };
      }));
    }),
    account("binance-earn-flexible", "Simple Earn flexible", async () => {
      const body = await signed<{ rows?: Array<{ asset: string; totalAmount: string }> }>("/sapi/v1/simple-earn/flexible/position", { params: { size: 100 } });
      return (body.rows || []).map((row) => priced("Simple Earn flexible", row.asset, Number(row.totalAmount)));
    }),
    account("binance-earn-locked", "Simple Earn locked", async () => {
      const body = await signed<{ rows?: Array<{ asset: string; amount: string }> }>("/sapi/v1/simple-earn/locked/position", { params: { size: 100 } });
      return (body.rows || []).map((row) => priced("Simple Earn locked", row.asset, Number(row.amount)));
    }),
    account("binance-usdm-futures", "USD-M Futures", async () => {
      const rows = await signed<Array<{ asset: string; balance: string; crossUnPnl?: string }>>("/fapi/v3/balance", { baseUrl: "https://fapi.binance.com" });
      return rows.map((row) => priced("USD-M Futures", row.asset, Number(row.balance) + (Number(row.crossUnPnl) || 0)));
    }),
    account("binance-coinm-futures", "COIN-M Futures", async () => {
      const rows = await signed<Array<{ asset: string; balance: string; crossUnPnl?: string }>>("/dapi/v1/balance", { baseUrl: "https://dapi.binance.com" });
      return rows.map((row) => priced("COIN-M Futures", row.asset, Number(row.balance) + (Number(row.crossUnPnl) || 0)));
    }),
    account("binance-cross-margin", "Cross Margin", async () => {
      const body = await signed<{ totalNetAssetOfBtc?: string }>("/sapi/v1/margin/account");
      const amount = parseRequiredCexNumber(body.totalNetAssetOfBtc, "Binance cross-margin BTC total");
      return [holding("binance", "Cross Margin", "MARGIN", null, getRequiredUsdValue("BTC", amount, prices))];
    })
  ]);
  const earnSymbols = new Set(accounts.filter((item) => item.id.startsWith("binance-earn-") && item.status === "live")
    .flatMap((item) => item.holdings.filter((row) => (row.amount ?? 0) > 0).map((row) => row.symbol)));
  for (const item of accounts) {
    if (item.id !== "binance-spot") continue;
    item.holdings = item.holdings.map((row) => row.symbol.startsWith("LD") && earnSymbols.has(row.symbol.slice(2))
      ? { ...row, valueUsd: null, priceUsd: null, priceSource: undefined,
          valuationState: "excluded", valuationReason: "represented-elsewhere" }
      : row);
    item.valueUsd = item.holdings.reduce((sum, row) => sum + (row.valueUsd ?? 0), 0);
  }
  return snapshot("binance", "Binance", now, accounts);
}

type BinanceTokenizedAsset = {
  assetCode: string;
  assetName?: string;
  underlyingEquitySymbol: string;
  multiplier: string;
  multiplierValid: boolean;
};
type BinanceEquityQuote = { symbol?: string; bidPrice?: string; askPrice?: string };
type BinanceEquityPrice = { priceUsd: number; priceSource: "binance-equity" | "binance-bstock" };

export function resolveBinanceEquityPrice(
  symbol: string, quote: BinanceEquityQuote | null,
  mappings: BinanceTokenizedAsset[], prices: Map<string, number>
): BinanceEquityPrice | null {
  const positive = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  if (quote?.symbol === symbol) {
    const bid = positive(quote.bidPrice);
    const ask = positive(quote.askPrice);
    const price = bid !== null && ask !== null ? (bid <= ask ? (bid + ask) / 2 : null) : bid ?? ask;
    if (price !== null) return { priceUsd: price, priceSource: "binance-equity" };
  }
  for (const asset of mappings) {
    if (asset.underlyingEquitySymbol !== symbol || !asset.multiplierValid || Number(asset.multiplier) !== 1) continue;
    const price = positive(prices.get(`${asset.assetCode}USDT`));
    if (price !== null) return { priceUsd: price, priceSource: "binance-bstock" };
  }
  return null;
}

async function okxSigned<T>(path: string) {
  const apiKey = process.env.OKX_API_KEY;
  const secret = process.env.OKX_API_SECRET;
  const passphrase = process.env.OKX_API_PASSPHRASE;
  if (!apiKey || !secret || !passphrase) throw new Error("API credentials missing");
  const timestamp = new Date().toISOString();
  const signature = createHmac("sha256", secret).update(`${timestamp}GET${path}`).digest("base64");
  return getJson<T>(`https://www.okx.com${path}`, {
    headers: {
      "OK-ACCESS-KEY": apiKey,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": passphrase
    }
  });
}

export async function fetchOkxCex(now: string): Promise<CexSourceSnapshot> {
  const tickers = await getJson<{ code: string; data?: Array<{ instId: string; last: string }> }>("https://www.okx.com/api/v5/market/tickers?instType=SPOT");
  const prices = new Map((tickers.data || []).map((ticker) => [ticker.instId, Number(ticker.last)]));
  const accounts = await Promise.all([
    account("okx-trading", "Trading", async () => {
      const body = await okxSigned<{ code: string; msg: string; data?: Array<{ details?: Array<{ ccy: string; eq: string; cashBal: string; eqUsd: string }> }> }>("/api/v5/account/balance");
      if (body.code !== "0") throw new Error(`${body.code}: ${body.msg}`);
      return (body.data?.[0]?.details || []).map((row) => {
        const amount = parseRequiredCexNumber(row.eq || row.cashBal, `OKX ${row.ccy} balance`);
        return holding("okx", "Trading", row.ccy, amount, getReportedUsdValue(row.ccy, amount, row.eqUsd));
      });
    }),
    account("okx-funding", "Funding", async () => {
      const body = await okxSigned<{ code: string; msg: string; data?: Array<{ ccy: string; bal: string }> }>("/api/v5/asset/balances");
      if (body.code !== "0") throw new Error(`${body.code}: ${body.msg}`);
      return (body.data || []).map((row) => {
        const amount = parseRequiredCexNumber(row.bal, `OKX ${row.ccy} funding balance`);
        return holding("okx", "Funding", row.ccy, amount, getOptionalUsdValue(row.ccy, amount, prices, "-"));
      });
    }),
    account(OKX_SIMPLE_EARN_ACCOUNT_ID, "Simple Earn flexible", async () => {
      const body = await okxSigned<{ code: string; data?: Array<{ ccy: string; amt: string }> }>("/api/v5/finance/savings/balance");
      if (body.code !== "0") throw new Error(`OKX Simple Earn request failed (${body.code})`);
      if (!Array.isArray(body.data)) throw new Error("OKX Simple Earn response is missing balances");
      const currencies = new Set<string>();
      return body.data.map((row) => {
        if (typeof row.ccy !== "string" || !/^[A-Z0-9.]+$/.test(row.ccy)) {
          throw new Error("OKX Simple Earn currency is invalid");
        }
        if (currencies.has(row.ccy)) throw new Error("OKX Simple Earn returned a duplicate currency");
        currencies.add(row.ccy);
        if (typeof row.amt !== "string" || row.amt.trim() === "") {
          throw new Error("OKX Simple Earn amount is missing");
        }
        const amount = parseRequiredCexNumber(row.amt, `OKX ${row.ccy} Simple Earn balance`);
        if (amount < 0) throw new Error("OKX Simple Earn amount is negative");
        // amt is the account balance. loanAmt/pendingAmt are its components;
        // earnings is cumulative, not an additional holding to add to amt.
        const valueUsd = getRequiredUsdValue(row.ccy, amount, prices, "-");
        return {
          ...holding("okx", "Simple Earn flexible", row.ccy, amount, valueUsd),
          assetClass: "crypto" as const,
          priceUsd: amount > 0 ? valueUsd / amount : undefined,
          priceSource: stablecoins.has(row.ccy) ? "usd-peg" : "okx-spot",
          valuationState: "priced" as const
        };
      });
    })
  ]);
  return snapshot("okx", "OKX", now, accounts);
}

async function bitgetSigned<T>(path: string, params: Record<string, string> = {}) {
  const apiKey = process.env.BITGET_API_KEY;
  const secret = process.env.BITGET_API_SECRET;
  const passphrase = process.env.BITGET_API_PASSPHRASE;
  if (!apiKey || !secret || !passphrase) throw new Error("API credentials missing");
  const query = new URLSearchParams(params).toString();
  const requestPath = query ? `${path}?${query}` : path;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const timestamp = String(Date.now());
    const signature = createHmac("sha256", secret).update(`${timestamp}GET${requestPath}`).digest("base64");
    try {
      return await getJson<T>(`https://api.bitget.com${requestPath}`, {
        headers: {
          "ACCESS-KEY": apiKey,
          "ACCESS-SIGN": signature,
          "ACCESS-PASSPHRASE": passphrase,
          "ACCESS-TIMESTAMP": timestamp,
          "Content-Type": "application/json",
          locale: "en-US"
        }
      }, 0);
    } catch (error) {
      const retryable = error instanceof HttpStatusError && (error.status === 429 || error.status >= 500);
      if (!retryable || attempt === 2) throw error;
      const exponentialBackoff = 500 * (2 ** attempt);
      await wait(error.retryAfterMs ?? exponentialBackoff + Math.round(Math.random() * 200));
    }
  }
  throw new Error("Bitget retry loop exhausted");
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number) {
  const results = new Array<T>(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]();
    }
  }));
  return results;
}

type BitgetResponse<T> = { code: string; msg?: string; message?: string; data: T };

function assertBitget<T>(response: BitgetResponse<T>) {
  if (response.code !== "00000") throw new Error(`${response.code}: ${response.msg || response.message || "Bitget request failed"}`);
  return response.data;
}

export async function fetchBitgetCex(now: string): Promise<CexSourceSnapshot> {
  const tickerBody = await getJson<BitgetResponse<Array<{ symbol: string; lastPr: string }>>>("https://api.bitget.com/api/v2/spot/market/tickers");
  const prices = new Map(assertBitget(tickerBody).map((ticker) => [ticker.symbol, Number(ticker.lastPr)]));

  const unified = await account("bitget-unified", "Unified", async () => {
    const data = assertBitget(await bitgetSigned<BitgetResponse<{ assets?: Array<{ coin: string; equity: string; usdValue: string }> }>>("/api/v3/account/assets"));
    return (data.assets || []).map((row) => {
      const amount = parseRequiredCexNumber(row.equity, `Bitget ${row.coin} unified equity`);
      return holding("bitget", "Unified", row.coin, amount, getReportedUsdValue(row.coin, amount, row.usdValue));
    });
  });
  if (unified.status === "live" && unified.itemCount > 0) {
    return snapshot("bitget", "Bitget", now, [unified]);
  }

  const accountTasks: Array<() => Promise<CexAccount>> = [
    () => account("bitget-spot", "Spot", async () => {
      const rows = assertBitget(await bitgetSigned<BitgetResponse<Array<{ coin: string; available: string; frozen: string; locked: string }>>>("/api/v2/spot/account/assets", { assetType: "hold_only" }));
      return rows.map((row) => {
        const amount = Number(row.available) + Number(row.frozen) + Number(row.locked);
        return holding("bitget", "Spot", row.coin, amount, getOptionalUsdValue(row.coin, amount, prices));
      });
    }),
    () => account("bitget-funding", "Funding", async () => {
      const rows = assertBitget(await bitgetSigned<BitgetResponse<Array<{ coin: string; available: string; frozen: string; usdtValue: string }>>>("/api/v2/account/funding-assets"));
      return rows.map((row) => {
        const amount = Number(row.available) + (Number(row.frozen) || 0);
        return holding("bitget", "Funding", row.coin, amount, getReportedUsdValue(row.coin, amount, row.usdtValue));
      });
    }),
    ...["USDT-FUTURES", "USDC-FUTURES", "COIN-FUTURES"].map((productType) =>
      () => account(`bitget-${productType.toLowerCase()}`, productType.replace("-", " "), async () => {
        const rows = assertBitget(await bitgetSigned<BitgetResponse<Array<{ marginCoin: string; accountEquity: string }>>>("/api/v2/mix/account/accounts", { productType }));
        return rows.map((row) => {
          const amount = parseRequiredCexNumber(row.accountEquity, `Bitget ${row.marginCoin} futures equity`);
          return holding("bitget", productType, row.marginCoin, amount, getOptionalUsdValue(row.marginCoin, amount, prices));
        });
      })
    ),
    ...["spot", "futures"].map((accountType) =>
      () => account(`bitget-bot-${accountType}`, `Bot ${accountType}`, async () => {
        const rows = assertBitget(await bitgetSigned<BitgetResponse<Array<{ coin: string; equity: string; usdtValue: string }>>>("/api/v2/account/bot-assets", { accountType }));
        return rows.map((row) => {
          const amount = parseRequiredCexNumber(row.equity, `Bitget ${row.coin} bot equity`);
          return holding("bitget", `Bot ${accountType}`, row.coin, amount, getReportedUsdValue(row.coin, amount, row.usdtValue));
        });
      })
    )
  ];
  const accounts = await runWithConcurrency(accountTasks, 2);
  return snapshot("bitget", "Bitget", now, accounts);
}

type HtxResponse<T> = {
  status: "ok" | "error";
  data?: T;
  "err-code"?: string;
  "err-msg"?: string;
};

type HtxCredentials = {
  apiKey: string;
  secret: string;
};

function getHtxCredentials(): HtxCredentials {
  const apiKey = process.env.HTX_API_KEY;
  const secret = process.env.HTX_API_SECRET;
  if (!apiKey || !secret) throw new Error("API credentials missing");
  return { apiKey, secret };
}

function encodeHtxQueryValue(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export function buildHtxSignedUrl(
  path: string,
  credentials: HtxCredentials,
  timestamp: string,
  params: Record<string, string> = {},
  baseUrl = htxBaseUrl
) {
  const endpoint = new URL(baseUrl);
  const signedParams = {
    ...params,
    AccessKeyId: credentials.apiKey,
    SignatureMethod: "HmacSHA256",
    SignatureVersion: "2",
    Timestamp: timestamp
  };
  const canonicalQuery = Object.entries(signedParams)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${encodeHtxQueryValue(key)}=${encodeHtxQueryValue(value)}`)
    .join("&");
  const payload = `GET\n${endpoint.host.toLowerCase()}\n${path}\n${canonicalQuery}`;
  const signature = createHmac("sha256", credentials.secret).update(payload, "utf8").digest("base64");
  return `${endpoint.origin}${path}?${canonicalQuery}&Signature=${encodeHtxQueryValue(signature)}`;
}

function htxTimestamp(date = new Date()) {
  return date.toISOString().slice(0, 19);
}

async function htxSigned<T>(
  path: string,
  credentials: HtxCredentials,
  params: Record<string, string> = {}
) {
  return getJson<HtxResponse<T>>(buildHtxSignedUrl(path, credentials, htxTimestamp(), params));
}

function assertHtx<T>(response: HtxResponse<T>) {
  if (response.status !== "ok" || response.data === undefined) {
    throw new Error(`${response["err-code"] || "htx-error"}: ${response["err-msg"] || "HTX request failed"}`);
  }
  return response.data;
}

function htxAccountName(type: string) {
  return type === "spot" ? "Spot" : type.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

export async function fetchHtxCex(now: string): Promise<CexSourceSnapshot> {
  const credentials = getHtxCredentials();
  const accountRows = assertHtx(await htxSigned<Array<{
    id: string | number;
    type: string;
    subtype?: string;
    state: string;
  }>>("/v1/account/accounts", credentials));
  const spotAccounts = accountRows.filter((row) => row.state === "working" && row.type === "spot");
  if (!spotAccounts.length) throw new Error("No working Spot account is available");

  let tickerError: string | null = null;
  const tickerBody = await getJson<HtxResponse<Array<{ symbol: string; close: number }>>>(`${htxBaseUrl}/market/tickers`)
    .then(assertHtx)
    .catch((error) => {
      tickerError = sanitizeCexError(error);
      return [];
    });
  const prices = new Map(
    tickerBody
      .map((ticker) => [ticker.symbol.toUpperCase(), Number(ticker.close)] as const)
      .filter(([, price]) => Number.isFinite(price) && price > 0)
  );
  const accounts = await Promise.all(spotAccounts.map((accountRow, index) => {
    const name = htxAccountName(accountRow.type);
    return account(`htx-${accountRow.type}-${index + 1}`, spotAccounts.length === 1 ? name : `${name} ${index + 1}`, async () => {
      const data = assertHtx(await htxSigned<{
        type: string;
        state: string;
        list?: Array<{ currency: string; type: string; balance: string }>;
      }>(`/v1/account/accounts/${encodeURIComponent(String(accountRow.id))}/balance`, credentials));
      const totals = new Map<string, number>();
      for (const row of data.list || []) {
        if (!htxSpotBalanceTypes.has(row.type)) continue;
        const amount = parseRequiredCexNumber(row.balance, `HTX ${row.currency.toUpperCase()} balance`);
        if (amount === 0) continue;
        const symbol = row.currency.toUpperCase();
        totals.set(symbol, (totals.get(symbol) || 0) + amount);
      }
      return [...totals].map(([symbol, amount]) => {
        const price = priceFromPairs(symbol, prices);
        if (!stablecoins.has(symbol) && (price === null || price <= 0) && tickerError) {
          throw new Error(
            `HTX ticker request failed; cannot value ${symbol}: ${tickerError}`
          );
        }
        return holding("htx", name, symbol, amount, price === null ? null : amount * price);
      });
    });
  }));
  return snapshot("htx", "HTX", now, accounts);
}

type GateCredentials = {
  apiKey: string;
  secret: string;
};

type GateTotalBalance = {
  total?: { amount?: string; currency?: string };
  details?: Record<string, { amount?: string; currency?: string }>;
};

const gateAccountNames: Record<string, string> = {
  cross_margin: "Cross Margin",
  spot: "Spot",
  finance: "Finance",
  margin: "Margin",
  quant: "Quant",
  futures: "Futures",
  delivery: "Delivery",
  warrant: "Warrant",
  cbbc: "CBBC",
  meme_box: "Alpha",
  options: "Options",
  payment: "Payment"
};

function gateAccountName(value: string) {
  return gateAccountNames[value] || value
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function gateEstimatedHolding(accountType: string, valueUsd: number): CexHolding {
  return holding("gate", accountType, "GATE-ESTIMATE", null, valueUsd);
}

function gateReportedUsdValue(
  balance: { amount?: string; currency?: string } | undefined,
  field: string
) {
  const currency = balance?.currency?.toUpperCase();
  if (currency !== "USD" && currency !== "USDT") {
    throw new Error(`${field} currency must be USD or USDT`);
  }
  const value = parseRequiredCexNumber(balance?.amount, field);
  if (value < 0) throw new Error(`${field} cannot be negative`);
  return value;
}

function getGateCredentials(): GateCredentials {
  const apiKey = process.env.GATE_API_KEY;
  const secret = process.env.GATE_API_SECRET;
  if (!apiKey || !secret) throw new Error("API credentials missing");
  return { apiKey, secret };
}

export function buildGateAuthHeaders(
  path: string,
  credentials: GateCredentials,
  timestamp: string,
  query = ""
) {
  const bodyHash = createHash("sha512").update("").digest("hex");
  const signaturePayload = `GET\n${gateApiPrefix}${path}\n${query}\n${bodyHash}\n${timestamp}`;
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    KEY: credentials.apiKey,
    Timestamp: timestamp,
    SIGN: createHmac("sha512", credentials.secret).update(signaturePayload).digest("hex")
  };
}

async function gateSigned<T>(path: string, query = "") {
  const credentials = getGateCredentials();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const suffix = query ? `?${query}` : "";
  return getJson<T>(`${gateBaseUrl}${gateApiPrefix}${path}${suffix}`, {
    headers: buildGateAuthHeaders(path, credentials, timestamp, query)
  });
}

export async function fetchGateCex(now: string): Promise<CexSourceSnapshot> {
  const [tickers, totalBalance] = await Promise.all([
    getJson<Array<{ currency_pair: string; last: string }>>(
      `${gateBaseUrl}${gateApiPrefix}/spot/tickers`
    ),
    // Gate defaults this endpoint to USDT. Keeping the query string empty also
    // keeps the signed request compatible with the production API response.
    gateSigned<GateTotalBalance>("/wallet/total_balance")
  ]);
  const prices = new Map(
    tickers
      .map((ticker) => [ticker.currency_pair.toUpperCase(), Number(ticker.last)] as const)
      .filter(([, price]) => Number.isFinite(price) && price > 0)
  );
  let spot = await account("gate-spot", "Spot", async () => {
    const rows = await gateSigned<Array<{
      currency: string;
      available: string;
      locked: string;
    }>>("/spot/accounts");
    return rows.map((row) => {
      const available = parseRequiredCexNumber(row.available, `Gate ${row.currency} available balance`);
      const locked = parseRequiredCexNumber(row.locked, `Gate ${row.currency} locked balance`);
      const amount = available + locked;
      const price = priceFromPairs(row.currency, prices, "_");
      return holding(
        "gate",
        "Spot",
        row.currency,
        amount,
        price === null ? null : amount * price
      );
    });
  });

  const reportedTotal = gateReportedUsdValue(totalBalance.total, "Gate total USD balance");
  const detailEntries = Object.entries(totalBalance.details || {})
    .map(([key, balance]) => ({
      key,
      name: gateAccountName(key),
      valueUsd: gateReportedUsdValue(balance, `Gate ${key} USD balance`)
    }))
    .filter((detail) => detail.valueUsd >= 0.01);
  const reportedSpot = detailEntries.find((detail) => detail.key === "spot")?.valueUsd;

  if (spot.status === "live" && reportedSpot !== undefined) {
    const adjustment = reportedSpot - spot.valueUsd;
    if (Math.abs(adjustment) >= 0.01) {
      spot = {
        ...spot,
        valueUsd: reportedSpot,
        itemCount: spot.itemCount + 1,
        holdings: [
          ...spot.holdings,
          gateEstimatedHolding("Spot estimate adjustment", adjustment)
        ]
      };
    }
  }

  const accounts: CexAccount[] = [spot];
  for (const detail of detailEntries) {
    if (detail.key === "spot") continue;
    accounts.push({
      id: `gate-${detail.key}`,
      name: detail.name,
      status: "live",
      valueUsd: detail.valueUsd,
      itemCount: 1,
      holdings: [gateEstimatedHolding(detail.name, detail.valueUsd)]
    });
  }

  const representedTotal = accounts.reduce((sum, item) => sum + item.valueUsd, 0);
  const unclassified = reportedTotal - representedTotal;
  if (unclassified < -Math.max(1, reportedTotal * 0.01)) {
    throw new Error("Gate account totals exceed the reported total balance");
  }
  if (Math.abs(unclassified) >= 0.01) {
    accounts.push({
      id: "gate-unclassified",
      name: "Unclassified account estimate",
      status: "live",
      valueUsd: unclassified,
      itemCount: 1,
      holdings: [gateEstimatedHolding("Unclassified account estimate", unclassified)]
    });
  }

  const result = snapshot("gate", "Gate", now, accounts);
  if (Math.abs(result.valueUsd - reportedTotal) > 0.05) {
    throw new Error("Gate account totals do not reconcile with the reported total balance");
  }
  return result;
}

export async function syncCexSources(previous: Partial<Record<CexExchange, CexSourceSnapshot>> = {}) {
  const now = new Date().toISOString();
  const fetchers = {
    binance: () => fetchBinanceCex(now),
    okx: () => fetchOkxCex(now),
    bitget: () => fetchBitgetCex(now),
    htx: () => fetchHtxCex(now),
    gate: () => fetchGateCex(now)
  } satisfies Record<CexExchange, () => Promise<CexSourceSnapshot>>;

  return Promise.all(CEX_EXCHANGES.map(async (exchange) => {
    try {
      const current = await fetchers[exchange]();
      return mergeCexAccounts(current, previous[exchange]);
    } catch (error) {
      const fallback = previous[exchange];
      if (fallback) {
        return {
          ...fallback,
          status: "partial" as const,
          capturedAt: now,
          bucketAt: getCexBucketAt(now),
          accounts: fallback.accounts.map((item) => ({ ...item, status: "stale" as const })),
          errors: [{ accountType: "Exchange", message: sanitizeCexError(error) }]
        };
      }
      return snapshot(exchange, getCexExchangeName(exchange), now, [
        { id: `${exchange}-exchange`, name: "Exchange", status: "error", valueUsd: 0, itemCount: 0, holdings: [], error: sanitizeCexError(error) }
      ]);
    }
  }));
}
