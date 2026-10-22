import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeCexAccounts } from "../cex";
vi.mock("server-only", () => ({}));
import { fetchBinanceCex, resolveBinanceEquityPrice } from "./cex-sources";

const mapping = { assetCode: "TSLAB", underlyingEquitySymbol: "TSLA", multiplier: "1", multiplierValid: true };
const now = "2026-09-22T00:00:00.000Z";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Binance equity prices", () => {
  it.each([
    [{ symbol: "TSLA", bidPrice: "370", askPrice: "372" }, 371],
    [{ symbol: "TSLA", bidPrice: "370" }, 370],
    [{ symbol: "TSLA", askPrice: "372", bidPrice: "NaN" }, 372]
  ])("uses valid quoted sides", (quote, expected) => {
    expect(resolveBinanceEquityPrice("TSLA", quote, [], new Map())?.priceUsd).toBe(expected);
  });
  it.each([null, {}, { symbol: "TSLA", bidPrice: "0", askPrice: "-1" }, { symbol: "TSLA", bidPrice: "380", askPrice: "370" }])(
    "uses only an official one to one fallback", (quote) => {
      const prices = new Map([["TSLABUSDT", 375]]);
      expect(resolveBinanceEquityPrice("TSLA", quote, [mapping], prices)).toEqual({ priceUsd: 375, priceSource: "binance-bstock" });
      expect(resolveBinanceEquityPrice("TSLA", quote, [{ ...mapping, multiplierValid: false }], prices)).toBeNull();
      expect(resolveBinanceEquityPrice("TSLA", quote, [{ ...mapping, multiplier: "2" }], prices)).toBeNull();
      expect(resolveBinanceEquityPrice("TSLA", quote, [], prices)).toBeNull();
    }
  );
  it.each([0, -1, NaN, Infinity])("rejects invalid fallback %s", (value) => {
    expect(resolveBinanceEquityPrice("TSLA", null, [mapping], new Map([["TSLABUSDT", value]]))).toBeNull();
  });
  it("counts direct stocks and bStocks separately and excludes matched Earn receipts", async () => {
    mockBinance();
    const result = await fetchBinanceCex(now);
    expect(result.status).toBe("live");
    expect(result.holdings.find((h) => h.symbol === "EQ_TSLA")).toMatchObject({ amount: 2, valueUsd: 742, assetClass: "equity", exposureSymbol: "TSLA", priceSource: "binance-equity" });
    expect(result.holdings.find((h) => h.symbol === "TSLAB")).toMatchObject({ valueUsd: 375, assetClass: "equity" });
    expect(result.holdings.find((h) => h.symbol === "LDBTC")).toMatchObject({ valueUsd: null, valuationState: "excluded" });
    expect(result.holdings.find((h) => h.symbol === "LDUNKNOWN")).toMatchObject({ valuationState: "unpriced" });
    expect(result.valueUsd).toBe(742 + 375 + 50000);
    expect(result.valuation).toEqual({ priced: 3, excluded: 1, unpriced: 1 });
  });
  it.each(["empty", "timeout", "429"])("falls back after %s quote", async (failure) => {
    mockBinance(failure);
    const result = await fetchBinanceCex(now);
    expect(result.holdings.find((h) => h.symbol === "EQ_TSLA")).toMatchObject({ valueUsd: 750, priceSource: "binance-bstock" });
  });
  it("fails closed when tokenized asset metadata is unavailable", async () => {
    mockBinance("metadata");
    await expect(fetchBinanceCex(now)).rejects.toThrow("HTTP 503");
  });
  it("preserves a priced account on failure, but refuses a legacy missing-price fallback", async () => {
    mockBinance();
    const good = await fetchBinanceCex(now);
    mockBinance("empty", false);
    const failed = await fetchBinanceCex(now);
    expect(failed.accounts.find((a) => a.name === "Funding")?.status).toBe("error");
    const merged = mergeCexAccounts(failed, good);
    expect(merged.status).toBe("partial");
    expect(merged.holdings.find((h) => h.symbol === "EQ_TSLA")?.valueUsd).toBe(742);
    good.accounts.find((a) => a.name === "Funding")!.holdings[0].valueUsd = null;
    expect(mergeCexAccounts(failed, good).accounts.find((a) => a.name === "Funding")?.status).toBe("error");
  });
});

function mockBinance(failure?: string, fallback = true) {
  vi.stubEnv("BINANCE_API_KEY", "test-key");
  vi.stubEnv("BINANCE_API_SECRET", "test-secret");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (value: unknown) => new Response(JSON.stringify(value));
    if (url.pathname === "/api/v3/time") return json({ serverTime: 1 });
    if (url.pathname === "/api/v3/ticker/price") return json([{ symbol: "BTCUSDT", price: "50000" }, ...(fallback ? [{ symbol: "TSLABUSDT", price: "375" }] : [])]);
    if (url.pathname.endsWith("tokenized-assets")) {
      return failure === "metadata" ? new Response("{}", { status: 503 }) : json([mapping]);
    }
    if (url.pathname.endsWith("market/quote")) {
      expect(new Headers(init?.headers).get("X-MBX-APIKEY")).toBe("test-key");
      if (failure === "timeout") throw new DOMException("timeout", "TimeoutError");
      if (failure === "429") return new Response("", { status: 429 });
      if (failure === "empty") return new Response("");
      return json({ symbol: "TSLA", bidPrice: "370", askPrice: "372" });
    }
    if (url.pathname === "/api/v3/account") return json({ balances: ["TSLAB", "LDBTC", "LDUNKNOWN"].map((asset) => ({ asset, free: "1", locked: "0" })) });
    if (url.pathname.endsWith("get-funding-asset")) return json([{ asset: "EQ_TSLA", free: "2", locked: "0", freeze: "0", withdrawing: "0" }]);
    if (url.pathname.endsWith("flexible/position")) return json({ rows: [{ asset: "BTC", totalAmount: "1" }] });
    if (url.pathname.endsWith("locked/position")) return json({ rows: [] });
    if (url.pathname.endsWith("margin/account")) return json({ totalNetAssetOfBtc: "0" });
    return json([]);
  }));
}
