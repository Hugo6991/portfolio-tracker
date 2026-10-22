import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeCexAccounts, OKX_SIMPLE_EARN_ACCOUNT_ID } from "../cex";
vi.mock("server-only", () => ({}));
import { fetchOkxCex } from "./cex-sources";

const now = "2026-09-22T07:00:00.000Z";
const earnRow = { ccy: "HYPE", amt: "505.54067986", loanAmt: "505.54054742", pendingAmt: "0.00013244", earnings: "0.00039242" };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function mockOkx(options: { earn?: unknown; price?: string; failure?: "timeout" | "429" | "auth"; trading?: number; funding?: number } = {}) {
  vi.stubEnv("OKX_API_KEY", "test-key");
  vi.stubEnv("OKX_API_SECRET", "test-secret");
  vi.stubEnv("OKX_API_PASSPHRASE", "test-passphrase");
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (body: unknown) => new Response(JSON.stringify(body));
    expect(init?.method ?? "GET").toBe("GET");
    if (url.pathname === "/api/v5/market/tickers") return json({ code: "0", data: [{ instId: "HYPE-USDT", last: options.price ?? "94" }] });
    expect(new Headers(init?.headers).get("OK-ACCESS-KEY")).toBe("test-key");
    if (url.pathname === "/api/v5/account/balance") {
      const amount = options.trading ?? 0;
      return json({ code: "0", data: [{ details: [{ ccy: "HYPE", eq: String(amount), cashBal: String(amount), eqUsd: String(amount * 94) }] }] });
    }
    if (url.pathname === "/api/v5/asset/balances") return json({ code: "0", data: [{ ccy: "HYPE", bal: String(options.funding ?? 0) }, { ccy: "USDC", bal: "5205" }] });
    if (url.pathname === "/api/v5/finance/savings/balance") {
      expect(url.search).toBe("");
      if (options.failure === "timeout") throw new DOMException("timeout", "TimeoutError");
      if (options.failure === "429") return new Response("{}", { status: 429 });
      if (options.failure === "auth") return json({ code: "50113", data: [] });
      return json(options.earn ?? { code: "0", data: [earnRow] });
    }
    throw new Error(`Unexpected path ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("OKX Simple Earn coverage", () => {
  it("values amt once without adding earnings, loaned or pending components", async () => {
    mockOkx();
    const result = await fetchOkxCex(now);
    expect(result.status).toBe("live");
    expect(result.accounts).toHaveLength(3);
    const earn = result.accounts.find(a => a.id === OKX_SIMPLE_EARN_ACCOUNT_ID)!;
    expect(earn.holdings).toHaveLength(1);
    expect(earn.holdings[0]).toMatchObject({ symbol: "HYPE", amount: 505.54067986, assetClass: "crypto", priceSource: "okx-spot", priceUsd: 94, valuationState: "priced" });
    expect(earn.valueUsd).toBeCloseTo(505.54067986 * 94, 8);
    expect(result.valueUsd).toBeCloseTo(5205 + 505.54067986 * 94, 8);
  });
  it("keeps separate Trading, Funding and Earn quantities of the same asset", async () => {
    mockOkx({ trading: 2, funding: 3 });
    const result = await fetchOkxCex(now);
    expect(result.holdings.filter(h => h.symbol === "HYPE")).toHaveLength(3);
    expect(result.valueUsd).toBeCloseTo(5205 + (505.54067986 + 5) * 94, 8);
  });
  it("does not change total ownership when HYPE moves from Trading to Earn", async () => {
    mockOkx({ trading: 505.54067986, earn: { code: "0", data: [] } });
    const before = await fetchOkxCex(now);
    mockOkx();
    const after = await fetchOkxCex(now);
    expect(after.valueUsd).toBeCloseTo(before.valueUsd, 8);
  });
  it("accepts an explicitly empty account and ignores true zero rows", async () => {
    for (const data of [[], [{ ccy: "UNKNOWN", amt: "0" }]]) {
      mockOkx({ earn: { code: "0", data } });
      const result = await fetchOkxCex(now);
      expect(result.status).toBe("live");
      expect(result.valueUsd).toBe(5205);
    }
  });
  it("prices stablecoin savings without a market pair", async () => {
    mockOkx({ earn: { code: "0", data: [{ ccy: "USDT", amt: "12" }] } });
    const result = await fetchOkxCex(now);
    expect(result.holdings.find(h => h.accountType === "Simple Earn flexible")).toMatchObject({ valueUsd: 12, priceUsd: 1, priceSource: "usd-peg" });
  });
  it.each([
    { code: "0" }, { code: "0", data: {} },
    ...[undefined, "", " ", "NaN", "Infinity", "-1"].map(amt => ({ code: "0", data: [{ ccy: "HYPE", amt }] })),
    { code: "0", data: [{ ccy: "", amt: "1" }] },
    { code: "0", data: [earnRow, earnRow] }
  ])("fails closed on a malformed or duplicate savings response", async earn => {
    mockOkx({ earn });
    const result = await fetchOkxCex(now);
    expect(result.status).toBe("partial");
    expect(result.accounts.find(a => a.id === OKX_SIMPLE_EARN_ACCOUNT_ID)?.status).toBe("error");
    expect(mergeCexAccounts(result, undefined).pricingBasis).toBeNull();
  });
  it.each(["0", "-1", "NaN"])("rejects a nonzero holding with invalid price %s", async price => {
    mockOkx({ price });
    expect((await fetchOkxCex(now)).accounts.find(a => a.id === OKX_SIMPLE_EARN_ACCOUNT_ID)?.status).toBe("error");
  });
  it.each(["timeout", "429", "auth"] as const)("preserves prior savings as stale after %s, never healthy zero", async failure => {
    mockOkx();
    const previous = await fetchOkxCex(now);
    mockOkx({ failure });
    const result = mergeCexAccounts(await fetchOkxCex(now), previous);
    expect(result.status).toBe("partial");
    expect(result.valueUsd).toBeCloseTo(previous.valueUsd, 8);
    expect(result.accounts.find(a => a.id === OKX_SIMPLE_EARN_ACCOUNT_ID)?.status).toBe("stale");
    expect(result.pricingBasis).toBe("binance-equities-v1");
  });
});
