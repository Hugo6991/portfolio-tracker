import { describe, expect, it } from "vitest";
import { applyWalletCapture, type WalletRefreshCapture } from "./targeted-wallet-refresh";
import { normalizeDeBankWalletTokens, normalizeDeBankProtocolPositions } from "./wallet-details";
import type { LivePortfolioSnapshot, LiveWallet, PendingWalletMovement } from "../live-portfolio";

const before = "2026-09-19T00:00:00.000Z";
const now = "2026-09-20T00:00:00.000Z";
const address = `0x${"1".repeat(40)}`;
const rawToken = (chain: string, amount: number) => ({ id: chain, chain, symbol: "ETH", name: "Ethereum", amount, price: 100, is_verified: true });
function fixture() {
  const wallet: LiveWallet = {
    id: "one", name: "Wallet", address, debankUrl: "https://debank.com", valueUsd: 250, debankValueUsd: 250, hyperliquidValueUsd: 0,
    tokens: normalizeDeBankWalletTokens([rawToken("bob", 1), rawToken("eth", 1)], before),
    positions: normalizeDeBankProtocolPositions([{
      id: "bob_uni", chain: "bob", name: "Uniswap", portfolio_item_list: [{ name: "Liquidity Pool", stats: { asset_usd_value: 50, debt_usd_value: 0, net_usd_value: 50 }, detail: { supply_token_list: [rawToken("bob", 0.5)] } }]
    }], [], before),
    tokenCount: 2, protocolCount: 1, status: "live", updatedAt: before, compositionUpdatedAt: before
  };
  const other = { ...wallet, id: "two", address: `0x${"2".repeat(40)}`, valueUsd: 100, debankValueUsd: 100, tokens: normalizeDeBankWalletTokens([rawToken("base", 1)], before), positions: [], protocolCount: 0 };
  const baseline: LivePortfolioSnapshot = {
    generatedAt: before, netWorthUsd: 1350, liveValueUsd: 1350, previewValueUsd: 0,
    groups: { exchangesUsd: 1000, walletsUsd: 350, banksUsd: 0 },
    wallets: [wallet, other], sources: [
      { id: "debank", name: "DeBank", kind: "wallet", status: "live", valueUsd: 350, itemCount: 2, updatedAt: before, compositionUpdatedAt: before, detail: "" },
      { id: "binance", name: "Binance", kind: "exchange", status: "live", valueUsd: 1000, itemCount: 1, updatedAt: before, detail: "" }
    ],
    holdings: [
      { symbol: "ETH", name: "Ethereum", amount: 3.5, valueUsd: 350, sources: ["DeBank"], accountCount: 2 },
      { symbol: "USDT", name: "Tether", amount: 1000, valueUsd: 1000, sources: ["Binance"], accountCount: 1 }
    ], connectedSourceCount: 2, expectedSourceCount: 2, isPartial: false, errors: []
  };
  const capture: WalletRefreshCapture = { version: 1, address, capturedAt: now, tokens: { bob: [rawToken("bob", 2)] }, protocols: { bob: [] }, usage: { requests: 2, unitsBefore: 100, unitsAfter: 90 } };
  return { baseline, capture };
}

describe("targeted wallet publication", () => {
  it("replaces closed positions and selected tokens while preserving other wallets, chains, sources and timestamps", () => {
    const { baseline, capture } = fixture();
    const original = structuredClone(baseline);
    const { snapshot, debankPayload } = applyWalletCapture(baseline, capture, [], undefined, now);
    expect(baseline).toEqual(original);
    expect(snapshot.wallets[1]).toEqual(baseline.wallets[1]);
    expect(snapshot.sources[1]).toEqual(baseline.sources[1]);
    expect(snapshot.wallets[0].tokens.find((t) => t.chainId === "eth")).toEqual(baseline.wallets[0].tokens[1]);
    expect(snapshot.wallets[0].positions).toEqual([]);
    expect(snapshot.wallets[0].compositionUpdatedAt).toBe(before);
    expect(snapshot.sources[0].compositionUpdatedAt).toBe(before);
    expect(snapshot.wallets[0].chainRefreshes).toEqual({ bob: { tokensAt: now, protocolsAt: now } });
    expect(snapshot.netWorthUsd).toBe(1400);
    expect(snapshot.groups.walletsUsd).toBe(400);
    expect(snapshot.holdings.find((h) => h.symbol === "ETH")).toMatchObject({ valueUsd: 400, amount: 4, accountCount: 2 });
    expect(debankPayload.wallets![0].positions).toEqual([]);
    expect(debankPayload.holdings.reduce((sum, h) => sum + h.valueUsd, 0)).toBe(400);
  });
  it("keeps pending withdrawals outside the balance and never infers arrival from an elapsed estimate", () => {
    const { baseline, capture } = fixture();
    const movements: PendingWalletMovement[] = [{ id: "one", label: "Withdrawal", amount: "999", asset: "BTC", status: "queued", recordedAt: before, expectedAt: before }];
    const { snapshot, debankPayload } = applyWalletCapture(baseline, capture, [], movements, now);
    expect(snapshot.netWorthUsd).toBe(1400);
    expect(snapshot.wallets[0].pendingMovements).toEqual(movements);
    expect(debankPayload.wallets![0].pendingMovements).toEqual(movements);
  });
  it("retains protocol positions on token-only refreshes and applies the same capture idempotently", () => {
    const { baseline, capture } = fixture();
    capture.protocols = {}; capture.usage.requests = 1;
    const once = applyWalletCapture(baseline, capture, [], undefined, now).snapshot;
    expect(once.wallets[0].positions).toEqual(baseline.wallets[0].positions);
    const twice = applyWalletCapture(once, capture, [], undefined, now).snapshot;
    expect(twice).toEqual(once);
  });
  it("rejects cross-chain or malformed responses and captures older than stored observations", () => {
    const { baseline, capture } = fixture();
    capture.tokens.bob[0].chain = "bsc";
    expect(() => applyWalletCapture(baseline, capture, [], undefined, now)).toThrow("Unexpected chain");
    capture.tokens.bob[0].chain = "bob";
    capture.tokens.bob[0].amount = "error";
    expect(() => applyWalletCapture(baseline, capture, [], undefined, now)).toThrow("Invalid token");
    capture.tokens.bob[0].amount = 2;
    baseline.wallets[0].chainRefreshes = { bob: { tokensAt: "2026-09-20T01:00:00Z" } };
    expect(() => applyWalletCapture(baseline, capture, [], undefined, now)).toThrow("older than");
  });
  it("does not delete shared holdings or lose the remaining account count", () => {
    const { baseline, capture } = fixture();
    capture.tokens.eth = []; capture.tokens.bob = []; capture.usage.requests++;
    const { snapshot } = applyWalletCapture(baseline, capture, [], undefined, now);
    expect(snapshot.holdings.find((h) => h.symbol === "ETH")).toMatchObject({ valueUsd: 100, accountCount: 1 });
    expect(snapshot.netWorthUsd).toBe(1100);
  });
  it("excludes unverified balances from portfolio value", () => {
    const { baseline, capture } = fixture();
    capture.tokens.bob = [{ ...rawToken("bob", 100000), id: `0x${"9".repeat(40)}`, symbol: "SPAM", is_verified: false }];
    const { snapshot } = applyWalletCapture(baseline, capture, [], undefined, now);
    expect(snapshot.wallets[0].debankValueUsd).toBe(100);
    expect(snapshot.wallets[0].excludedTokenCount).toBe(1);
    expect(snapshot.holdings.some((h) => h.symbol === "SPAM")).toBe(false);
  });
});
