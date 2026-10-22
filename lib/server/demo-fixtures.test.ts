import { afterEach, describe, expect, it } from "vitest";
import { isDemoMode } from "@/lib/demo-mode";
import {
  demoAssetHistory,
  demoCexHistory,
  demoCexResponse,
  demoPortfolioHistory,
  demoPortfolioSnapshot,
  demoWalletHistory
} from "./demo-fixtures";

const at = new Date("2026-10-18T00:00:00.000Z");

describe("demo mode", () => {
  const original = process.env.PORTFOLIO_DEMO_MODE;
  afterEach(() => {
    if (original === undefined) delete process.env.PORTFOLIO_DEMO_MODE;
    else process.env.PORTFOLIO_DEMO_MODE = original;
  });

  it("is off unless the variable is exactly 1", () => {
    delete process.env.PORTFOLIO_DEMO_MODE;
    expect(isDemoMode()).toBe(false);
    process.env.PORTFOLIO_DEMO_MODE = "true";
    expect(isDemoMode()).toBe(false);
    process.env.PORTFOLIO_DEMO_MODE = "1";
    expect(isDemoMode()).toBe(true);
  });

  it("builds a snapshot whose groups add up and whose wallets are placeholder addresses", () => {
    const snapshot = demoPortfolioSnapshot(at);
    expect(snapshot.netWorthUsd).toBe(snapshot.groups.exchangesUsd + snapshot.groups.walletsUsd + snapshot.groups.banksUsd);
    expect(snapshot.netWorthUsd).toBeLessThan(100_000);
    for (const wallet of snapshot.wallets) expect(wallet.address).toMatch(/^0x0{36}[0-9a-f]{4}$/);
    expect(snapshot.sources.map((s) => s.name)).not.toContain("Binance");
    expect(snapshot.isPartial).toBe(false);
  });

  it("spreads well known assets over many venues, with DeFi deposits and stocks", () => {
    const snapshot = demoPortfolioSnapshot(at);
    const symbols = snapshot.holdings.map((h) => h.symbol);
    // Only well known large caps, stocks and bank cash: no project token from the private portfolio.
    const allowed = new Set(["BTC", "ETH", "USDC", "USDT", "BNB", "SOL", "UNI", "AAVE", "LINK", "ARB", "HYPE", "SUI", "AVAX", "EQ_TSLA", "EQ_SPCX", "USD"]);
    expect(symbols.filter((s) => !allowed.has(s))).toEqual([]);
    expect(snapshot.wallets).toHaveLength(5);
    expect(new Set(snapshot.wallets.flatMap((w) => w.tokens.map((t) => t.symbol))).size).toBe(10);
    expect(snapshot.wallets.flatMap((w) => w.positions.map((p) => p.protocolName))).toEqual(expect.arrayContaining(["Aave V3", "Morpho"]));
    expect(snapshot.holdings.filter((h) => h.assetClass === "equity").map((h) => h.exposureSymbol).sort()).toEqual(["SPCX", "TSLA"]);
    expect(snapshot.holdings.find((h) => h.symbol === "USDT")?.sources.length).toBeGreaterThanOrEqual(4);
    for (const w of snapshot.wallets) {
      const sum = w.tokens.reduce((s, t) => s + t.valueUsd, 0) + w.positions.reduce((s, p) => s + p.valueUsd, 0);
      expect(w.valueUsd).toBe(sum);
    }
  });

  it("keeps the CEX response consistent with the snapshot", () => {
    const snapshot = demoPortfolioSnapshot(at);
    const cex = demoCexResponse(at);
    expect(cex.totalUsd).toBe(snapshot.groups.exchangesUsd);
    expect(cex.holdings.length).toBe(cex.sources.reduce((s, x) => s + x.holdings.length, 0));
  });

  it("produces the requested number of history points ending at the snapshot", () => {
    const history = demoPortfolioHistory("daily", 30, at);
    expect(history.points).toHaveLength(30);
    expect(history.points.at(-1)?.netWorthUsd).toBe(demoPortfolioSnapshot(at).netWorthUsd);
    expect(history.points.at(-1)?.capturedAt).toBe(at.toISOString());
    expect(demoAssetHistory(14, at).points).toHaveLength(14);
    expect(demoWalletHistory(14, at).wallets).toHaveLength(5);
    expect(demoCexHistory(1, 60, at).points.length).toBeGreaterThan(0);
  });
});
