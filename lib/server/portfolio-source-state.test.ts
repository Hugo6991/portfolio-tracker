import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let readPortfolioSourcePayloads: typeof import("./portfolio-source-state").readPortfolioSourcePayloads;
const fetchMock = vi.fn<typeof fetch>();

beforeAll(async () => {
  ({ readPortfolioSourcePayloads } = await import("./portfolio-source-state"));
});

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://portfolio.supabase.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
  vi.stubEnv("PORTFOLIO_SOURCE_LKG_MAX_AGE_SECONDS", "3600");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("portfolio source last-known-good reads", () => {
  it("returns only structured source payloads inside the safety window", async () => {
    fetchMock.mockResolvedValue(Response.json([
      row("debank", "2026-09-06T16:30:00.000Z"),
      row("hyperliquid", "2026-09-06T14:00:00.000Z"),
      {
        source_id: "gate",
        last_good_at: "2026-09-06T16:45:00.000Z",
        last_good_payload: source("gate", "exchange")
      }
    ]));

    const payloads = await readPortfolioSourcePayloads(Date.parse("2026-09-06T17:00:00.000Z"));

    expect([...payloads.keys()]).toEqual(["debank"]);
    expect(payloads.get("debank")).toMatchObject({
      lastGoodAt: "2026-09-06T16:30:00.000Z",
      source: { id: "debank", status: "live" }
    });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toContain("/portfolio_source_state");
    expect(url.searchParams.get("last_good_payload")).toBe("not.is.null");
  });

  it("returns no fallbacks when storage is not configured", async () => {
    vi.stubEnv("SUPABASE_URL", "");

    await expect(readPortfolioSourcePayloads()).resolves.toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves equity identity and valuation provenance in last-known-good payloads", async () => {
    const base = row("binance", "2026-09-06T16:30:00.000Z");
    const payload = {
      ...base,
      last_good_payload: {
        ...base.last_good_payload,
        source: {
          ...base.last_good_payload.source,
          kind: "exchange",
          pricingBasis: "binance-equities-v1"
        },
        holdings: [{
          symbol: "EQ_TSLA",
          amount: 2,
          valueUsd: 742,
          accountId: "binance-funding",
          assetClass: "equity",
          exposureSymbol: "TSLA",
          priceUsd: 371,
          priceSource: "binance-equity",
          valuationState: "priced"
        }]
      }
    };
    fetchMock.mockResolvedValue(Response.json([payload]));

    const stored = await readPortfolioSourcePayloads(Date.parse("2026-09-06T17:00:00.000Z"));

    expect(stored.get("binance")?.source.pricingBasis).toBe("binance-equities-v1");
    expect(stored.get("binance")?.holdings[0]).toMatchObject({
      assetClass: "equity",
      exposureSymbol: "TSLA",
      priceSource: "binance-equity",
      valuationState: "priced"
    });
  });
});

function row(id: string, lastGoodAt: string) {
  return {
    source_id: id,
    last_good_at: lastGoodAt,
    last_good_payload: {
      source: source(id, "wallet"),
      holdings: [{ symbol: "USDC", amount: 10, valueUsd: 10, accountId: "account" }]
    }
  };
}

function source(id: string, kind: "exchange" | "wallet") {
  return {
    id,
    name: id,
    kind,
    status: "live",
    valueUsd: 10,
    itemCount: 1,
    updatedAt: "2026-09-06T16:30:00.000Z",
    detail: "complete"
  };
}
