import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getCexBucketAt, sanitizeCexError, type CexSourceSnapshot } from "../cex";

vi.mock("server-only", () => ({}));

let buildHtxSignedUrl: typeof import("./cex-sources").buildHtxSignedUrl;
let buildGateAuthHeaders: typeof import("./cex-sources").buildGateAuthHeaders;
let fetchBitgetCex: typeof import("./cex-sources").fetchBitgetCex;
let fetchGateCex: typeof import("./cex-sources").fetchGateCex;
let fetchHtxCex: typeof import("./cex-sources").fetchHtxCex;
let getRequiredUsdValue: typeof import("./cex-sources").getRequiredUsdValue;
let getOptionalUsdValue: typeof import("./cex-sources").getOptionalUsdValue;
let parseRequiredCexNumber: typeof import("./cex-sources").parseRequiredCexNumber;
let syncCexSources: typeof import("./cex-sources").syncCexSources;

beforeAll(async () => {
  ({
    buildHtxSignedUrl,
    buildGateAuthHeaders,
    fetchBitgetCex,
    fetchGateCex,
    fetchHtxCex,
    getOptionalUsdValue,
    getRequiredUsdValue,
    parseRequiredCexNumber,
    syncCexSources
  } = await import("./cex-sources"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.HTX_API_KEY;
  delete process.env.HTX_API_SECRET;
  delete process.env.BITGET_API_KEY;
  delete process.env.BITGET_API_SECRET;
  delete process.env.BITGET_API_PASSPHRASE;
  delete process.env.GATE_API_KEY;
  delete process.env.GATE_API_SECRET;
});

describe("CEX error sanitization", () => {
  it("redacts credentials and long tokens", () => {
    const value = sanitizeCexError(new Error("apiKey=abcdefghijklmnopqrstuvwxyz123 secret: abcdefghijklmnopqrstuvwxyz987"));
    expect(value).not.toContain("abcdefghijklmnopqrstuvwxyz123");
    expect(value).not.toContain("abcdefghijklmnopqrstuvwxyz987");
    expect(value).toContain("[redacted]");
  });

  it("redacts HTX authentication field names", () => {
    const value = sanitizeCexError(new Error("AccessKeyId=short-key Signature=short-signature secret=short-secret"));
    expect(value).toBe("AccessKeyId=[redacted] Signature=[redacted] secret=[redacted]");
  });
});

describe("CEX price quality", () => {
  it("fails closed when a nonzero asset has no USD price", () => {
    expect(() => getRequiredUsdValue("BTC", 0.1, new Map())).toThrow(
      "Ticker response did not include a USD price for BTC"
    );
  });

  it("allows zero balances and prices stablecoins without a ticker", () => {
    expect(getRequiredUsdValue("UNKNOWN", 0, new Map())).toBe(0);
    expect(getRequiredUsdValue("USDT", 25, new Map())).toBe(25);
  });

  it("keeps a valid balance visible when only its market ticker is unavailable", () => {
    expect(getOptionalUsdValue("DELISTED", 2, new Map())).toBeNull();
    expect(getOptionalUsdValue("USDT", 2, new Map())).toBe(2);
  });

  it("distinguishes a real zero balance from a missing or invalid field", () => {
    expect(parseRequiredCexNumber("0", "balance")).toBe(0);
    expect(() => parseRequiredCexNumber(undefined, "balance")).toThrow("balance is missing");
    expect(() => parseRequiredCexNumber("not-a-number", "balance")).toThrow("balance is invalid");
  });
});

describe("Bitget CEX source", () => {
  it("honors a 429 Retry-After response and retries with a fresh signed request", async () => {
    process.env.BITGET_API_KEY = "test-access-key";
    process.env.BITGET_API_SECRET = "test-secret";
    process.env.BITGET_API_PASSPHRASE = "test-passphrase";
    let unifiedAttempts = 0;
    const signedTimestamps: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v2/spot/market/tickers") {
        return jsonResponse({ code: "00000", data: [{ symbol: "USDT", lastPr: "1" }] });
      }
      if (url.pathname === "/api/v3/account/assets") {
        unifiedAttempts += 1;
        signedTimestamps.push(new Headers(init?.headers).get("ACCESS-TIMESTAMP") || "");
        if (unifiedAttempts === 1) {
          return new Response(JSON.stringify({ message: "rate limited" }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "0" }
          });
        }
        return jsonResponse({
          code: "00000",
          data: { assets: [{ coin: "USDT", equity: "100", usdValue: "100" }] }
        });
      }
      return jsonResponse({ code: "00000", data: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBitgetCex("2026-08-22T00:00:00.000Z");

    expect(result).toMatchObject({ status: "live", valueUsd: 100 });
    expect(unifiedAttempts).toBe(2);
    expect(signedTimestamps.every(Boolean)).toBe(true);
  });

  it("falls back to account-specific endpoints when Unified returns an empty payload", async () => {
    process.env.BITGET_API_KEY = "test-access-key";
    process.env.BITGET_API_SECRET = "test-secret";
    process.env.BITGET_API_PASSPHRASE = "test-passphrase";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v2/spot/market/tickers") {
        return jsonResponse({ code: "00000", data: [{ symbol: "USDT", lastPr: "1" }] });
      }
      if (url.pathname === "/api/v3/account/assets") {
        return jsonResponse({ code: "00000", data: { assets: [] } });
      }
      if (url.pathname === "/api/v2/spot/account/assets") {
        return jsonResponse({
          code: "00000",
          data: [{ coin: "USDT", available: "100", frozen: "0", locked: "0" }]
        });
      }
      return jsonResponse({ code: "00000", data: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBitgetCex("2026-08-22T00:00:00.000Z");

    expect(result).toMatchObject({ exchange: "bitget", status: "live", valueUsd: 100 });
    expect(result.holdings).toContainEqual(expect.objectContaining({ symbol: "USDT", valueUsd: 100 }));
    expect(fetchMock).toHaveBeenCalledTimes(9);
  });
});

describe("HTX CEX source", () => {
  it("builds a deterministic signed URL using the requested host and sorted query", () => {
    const url = buildHtxSignedUrl(
      "/v1/account/accounts",
      { apiKey: "test-access-key", secret: "test-secret" },
      "2026-08-13T01:02:03"
    );

    expect(url).toBe(
      "https://api.huobi.pro/v1/account/accounts?AccessKeyId=test-access-key&SignatureMethod=HmacSHA256&SignatureVersion=2&Timestamp=2026-08-13T01%3A02%3A03&Signature=eduzQe2un8bZDaLRPX7arsO%2BYjSlJLl4f9%2FhlnW5ZcE%3D"
    );
    expect(url).not.toContain("test-secret");
  });

  it("discovers the working Spot account and merges available and frozen balances", async () => {
    process.env.HTX_API_KEY = "test-access-key";
    process.env.HTX_API_SECRET = "test-secret";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/account/accounts") {
        return jsonResponse({
          status: "ok",
          data: [
            { id: "private-account-id", type: "spot", subtype: "", state: "working" },
            { id: "locked-account-id", type: "spot", subtype: "", state: "lock" }
          ]
        });
      }
      if (url.pathname === "/market/tickers") {
        return jsonResponse({ status: "ok", data: [{ symbol: "btcusdt", close: 50_000 }] });
      }
      if (url.pathname === "/v1/account/accounts/private-account-id/balance") {
        return jsonResponse({
          status: "ok",
          data: {
            id: "private-account-id",
            type: "spot",
            state: "working",
            list: [
              { currency: "btc", type: "trade", balance: "0.1" },
              { currency: "btc", type: "frozen", balance: "0.02" },
              { currency: "usdt", type: "trade", balance: "25" },
              { currency: "eth", type: "loan", balance: "10" },
              { currency: "eth", type: "trade", balance: "0" }
            ]
          }
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchHtxCex("2026-08-13T01:02:03.000Z");

    expect(result).toMatchObject({ exchange: "htx", name: "HTX", status: "live", itemCount: 2 });
    expect(result.valueUsd).toBeCloseTo(6025);
    expect(result.accounts[0].id).toBe("htx-spot-1");
    expect(result.holdings[0]).toMatchObject({ exchange: "htx", accountType: "Spot", symbol: "BTC" });
    expect(result.holdings[0].amount).toBeCloseTo(0.12);
    expect(result.holdings[0].valueUsd).toBeCloseTo(6000);
    expect(result.holdings[1]).toEqual({ exchange: "htx", accountType: "Spot", symbol: "USDT", amount: 25, valueUsd: 25 });
    expect(JSON.stringify(result)).not.toContain("private-account-id");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("marks the account and source errored when tickers fail and a non-stablecoin needs pricing", async () => {
    process.env.HTX_API_KEY = "test-access-key";
    process.env.HTX_API_SECRET = "test-secret";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/account/accounts") {
        return jsonResponse({
          status: "ok",
          data: [{ id: "private-account-id", type: "spot", subtype: "", state: "working" }]
        });
      }
      if (url.pathname === "/market/tickers") {
        return jsonResponse({ status: "error", "err-code": "upstream-unavailable", "err-msg": "Ticker service unavailable" }, 503);
      }
      if (url.pathname === "/v1/account/accounts/private-account-id/balance") {
        return jsonResponse({
          status: "ok",
          data: {
            id: "private-account-id",
            type: "spot",
            state: "working",
            list: [
              { currency: "btc", type: "trade", balance: "0.1" },
              { currency: "usdt", type: "trade", balance: "25" }
            ]
          }
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchHtxCex("2026-08-13T01:02:03.000Z");

    expect(result).toMatchObject({ exchange: "htx", status: "error", valueUsd: 0, itemCount: 0 });
    expect(result.accounts[0]).toMatchObject({ status: "error", valueUsd: 0, itemCount: 0 });
    expect(result.accounts[0].error).toContain("HTX ticker request failed; cannot value BTC");
    expect(result.accounts[0].error).toContain("HTTP 503");
    expect(result.errors).toEqual([{ accountType: "Spot", message: result.accounts[0].error }]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps an unpriced non-stablecoin visible when the ticker payload omits only its pair", async () => {
    process.env.HTX_API_KEY = "test-access-key";
    process.env.HTX_API_SECRET = "test-secret";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/account/accounts") {
        return jsonResponse({
          status: "ok",
          data: [{ id: "private-account-id", type: "spot", subtype: "", state: "working" }]
        });
      }
      if (url.pathname === "/market/tickers") {
        return jsonResponse({ status: "ok", data: [] });
      }
      if (url.pathname === "/v1/account/accounts/private-account-id/balance") {
        return jsonResponse({
          status: "ok",
          data: {
            id: "private-account-id",
            type: "spot",
            state: "working",
            list: [{ currency: "btc", type: "trade", balance: "0.1" }]
          }
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchHtxCex("2026-08-13T01:02:03.000Z");

    expect(result.status).toBe("live");
    expect(result.accounts[0].status).toBe("live");
    expect(result.holdings).toEqual([
      { exchange: "htx", accountType: "Spot", symbol: "BTC", amount: 0.1, valueUsd: null }
    ]);
    expect(result.errors).toEqual([]);
  });
});

describe("Gate CEX source", () => {
  it("builds a deterministic API v4 signature without exposing the secret", () => {
    const headers = buildGateAuthHeaders(
      "/spot/accounts",
      { apiKey: "test-access-key", secret: "test-secret" },
      "1724810400"
    );

    expect(headers).toMatchObject({
      KEY: "test-access-key",
      Timestamp: "1724810400"
    });
    expect(headers.SIGN).toBe(
      "ea499e636e1973f7206594e07eabb41cb728eccaf17ea3ca148dfe23332d2b6c137eba981ffe5a2ddd0cbd338a0e45a31aeb518cb77efdbd7eb52a499cfb50e5"
    );
    expect(JSON.stringify(headers)).not.toContain("test-secret");
  });

  it("reads available and locked Spot assets and values them from Gate tickers", async () => {
    process.env.GATE_API_KEY = "test-access-key";
    process.env.GATE_API_SECRET = "test-secret";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v4/spot/tickers") {
        return jsonResponse([
          { currency_pair: "BTC_USDT", last: "50000" },
          { currency_pair: "ETH_BTC", last: "0.05" }
        ]);
      }
      if (url.pathname === "/api/v4/wallet/total_balance") {
        expect(url.search).toBe("");
        return jsonResponse({
          total: { currency: "USDT", amount: "14136.37" },
          details: {
            spot: { currency: "USDT", amount: "6030" },
            finance: { currency: "USDT", amount: "8106.37" }
          }
        });
      }
      if (url.pathname === "/api/v4/spot/accounts") {
        const headers = new Headers(init?.headers);
        expect(headers.get("KEY")).toBe("test-access-key");
        expect(headers.get("SIGN")).toMatch(/^[a-f0-9]{128}$/);
        return jsonResponse([
          { currency: "BTC", available: "0.1", locked: "0.02" },
          { currency: "USDT", available: "25", locked: "5" },
          { currency: "ETH", available: "0", locked: "0" }
        ]);
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGateCex("2026-08-28T01:02:03.000Z");

    expect(result).toMatchObject({ exchange: "gate", name: "Gate", status: "live", itemCount: 3 });
    expect(result.valueUsd).toBeCloseTo(14136.37);
    expect(result.holdings).toHaveLength(3);
    expect(result.holdings[0]).toMatchObject({
      exchange: "gate",
      accountType: "Spot",
      symbol: "BTC"
    });
    expect(result.holdings[0].amount).toBeCloseTo(0.12);
    expect(result.holdings[0].valueUsd).toBeCloseTo(6000);
    expect(result.holdings[1]).toEqual({
      exchange: "gate",
      accountType: "Spot",
      symbol: "USDT",
      amount: 30,
      valueUsd: 30
    });
    expect(result.holdings[2]).toEqual({
      exchange: "gate",
      accountType: "Finance",
      symbol: "GATE-ESTIMATE",
      amount: null,
      valueUsd: 8106.37
    });
    expect(result.accounts[1]).toMatchObject({
      id: "gate-finance",
      name: "Finance",
      valueUsd: 8106.37
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps an unpriced asset visible without treating a successful balance read as failed", async () => {
    process.env.GATE_API_KEY = "test-access-key";
    process.env.GATE_API_SECRET = "test-secret";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v4/spot/tickers") return jsonResponse([]);
      if (url.pathname === "/api/v4/wallet/total_balance") {
        return jsonResponse({
          total: { currency: "USDT", amount: "6000" },
          details: { spot: { currency: "USDT", amount: "6000" } }
        });
      }
      if (url.pathname === "/api/v4/spot/accounts") {
        return jsonResponse([{ currency: "BTC", available: "0.1", locked: "0" }]);
      }
      return new Response(null, { status: 404 });
    }));

    const result = await fetchGateCex("2026-08-28T01:02:03.000Z");

    expect(result).toMatchObject({ exchange: "gate", status: "live", valueUsd: 6000, itemCount: 2 });
    expect(result.holdings).toEqual([
      { exchange: "gate", accountType: "Spot", symbol: "BTC", amount: 0.1, valueUsd: null },
      {
        exchange: "gate",
        accountType: "Spot estimate adjustment",
        symbol: "GATE-ESTIMATE",
        amount: null,
        valueUsd: 6000
      }
    ]);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({
      id: "gate-spot",
      status: "live",
      itemCount: 2,
      valueUsd: 6000
    });
    expect(result.errors).toEqual([]);
  });

  it("fails the Gate source instead of publishing Spot-only data when total coverage is unavailable", async () => {
    process.env.GATE_API_KEY = "test-access-key";
    process.env.GATE_API_SECRET = "test-secret";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v4/spot/tickers") return jsonResponse([]);
      if (url.pathname === "/api/v4/wallet/total_balance") {
        return jsonResponse({ label: "MISSING_REQUIRED_PERMISSION" }, 403);
      }
      if (url.pathname === "/api/v4/spot/accounts") {
        return jsonResponse([{ currency: "USDT", available: "630", locked: "0" }]);
      }
      return new Response(null, { status: 404 });
    }));

    await expect(fetchGateCex("2026-09-06T00:00:00.000Z"))
      .rejects.toThrow("HTTP 403");
  });

  it("rejects malformed totals rather than treating them as a complete Gate snapshot", async () => {
    process.env.GATE_API_KEY = "test-access-key";
    process.env.GATE_API_SECRET = "test-secret";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v4/spot/tickers") return jsonResponse([]);
      if (url.pathname === "/api/v4/wallet/total_balance") {
        return jsonResponse({ total: { currency: "BTC", amount: "0.2" }, details: {} });
      }
      if (url.pathname === "/api/v4/spot/accounts") return jsonResponse([]);
      return new Response(null, { status: 404 });
    }));

    await expect(fetchGateCex("2026-09-06T00:00:00.000Z"))
      .rejects.toThrow("currency must be USD or USDT");
  });

  it("keeps the last complete Gate value but marks the next failed attempt partial", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T01:15:00.000Z"));
    process.env.GATE_API_KEY = "test-access-key";
    process.env.GATE_API_SECRET = "test-secret";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "unavailable" }, 503)));
    const previous = gateSnapshot("2026-09-06T01:00:00.000Z", 13_212.84);

    try {
      const snapshots = await syncCexSources({ gate: previous });
      const gate = snapshots.find((snapshot) => snapshot.exchange === "gate");

      expect(gate).toMatchObject({
        status: "partial",
        capturedAt: "2026-09-06T01:15:00.000Z",
        bucketAt: getCexBucketAt("2026-09-06T01:15:00.000Z"),
        valueUsd: 13_212.84,
        accounts: [{ status: "stale", valueUsd: 13_212.84 }]
      });
      expect(gate?.errors).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

function gateSnapshot(capturedAt: string, valueUsd: number): CexSourceSnapshot {
  const holding = {
    exchange: "gate" as const,
    accountType: "Finance",
    symbol: "GATE-ESTIMATE",
    amount: null,
    valueUsd
  };
  return {
    exchange: "gate",
    name: "Gate",
    status: "live",
    capturedAt,
    bucketAt: getCexBucketAt(capturedAt),
    valueUsd,
    itemCount: 1,
    accounts: [{
      id: "gate-finance",
      name: "Finance",
      status: "live",
      valueUsd,
      itemCount: 1,
      holdings: [holding]
    }],
    holdings: [holding],
    errors: []
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
