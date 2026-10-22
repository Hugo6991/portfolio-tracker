import { describe, expect, it } from "vitest";
import {
  buildDeBankWalletHoldings,
  getDeBankTokenExclusion,
  getWalletChainName,
  normalizeDeBankProtocolPositions,
  normalizeDeBankWalletTokens,
  normalizeHyperliquidPositions
} from "./wallet-details";

describe("DeBank wallet details", () => {
  it("normalizes direct wallet balances with chain and token display metadata", () => {
    const tokens = normalizeDeBankWalletTokens([
      {
        id: `0x${"a".repeat(40)}`,
        chain: "eth",
        optimized_symbol: "WETH",
        name: "Wrapped Ether",
        logo_url: "https://cdn.example/weth.png",
        amount: "2",
        price: "1500",
        is_verified: true
      },
      { id: "0xdust", chain: "base", symbol: "DUST", amount: "0", price: "1" },
      { id: "0xclaim", chain: "arb", symbol: "CLAIM", amount: "4", usd_value: "12", is_verified: true }
    ], "2026-09-11T00:30:00.000Z");

    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toMatchObject({
      source: "debank",
      symbol: "WETH",
      name: "Wrapped Ether",
      chainId: "eth",
      chainName: "Ethereum",
      amount: 2,
      priceUsd: 1500,
      valueUsd: 3000,
      state: "liquid",
      iconUrl: "https://cdn.example/weth.png"
    });
    expect(tokens[0]).toMatchObject({
      contractAddress: `0x${"a".repeat(40)}`,
      verificationState: "verified",
      debankIsVerified: true,
      debankIsCore: null,
      priceSource: "debank-snapshot",
      priceState: "fallback",
      priceUpdatedAt: "2026-09-11T00:30:00.000Z"
    });
    expect(tokens[1]).toMatchObject({ symbol: "CLAIM", chainName: "Arbitrum", valueUsd: 12 });
    expect(getWalletChainName("some_new_chain")).toBe("Some New Chain");
  });

  it("keeps unverified and native-symbol impersonator metadata but excludes their value", () => {
    const tokens = normalizeDeBankWalletTokens([{
      id: "0x9335d29adc453201ccb1184b8842d7cb8d294444",
      chain: "bsc",
      symbol: "BNB",
      name: "BINANCE DIAMOND",
      amount: 1084,
      price: 733.596,
      is_verified: true,
      is_core: true
    }, {
      id: `0x${"b".repeat(40)}`,
      chain: "bsc",
      symbol: "UNKNOWN",
      amount: 10,
      price: 5
    }]);

    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toMatchObject({
      name: "BINANCE DIAMOND",
      snapshotValueUsd: 1084 * 733.596,
      valueUsd: 0,
      valuationState: "excluded",
      priceState: "excluded",
      exclusionReason: "denylisted"
    });
    expect(tokens[1]).toMatchObject({
      verificationState: "unknown",
      valueUsd: 0,
      exclusionReason: "legacy-unverified"
    });
  });

  it("fails legacy contract tokens closed while retaining exact native assets", () => {
    expect(getDeBankTokenExclusion({
      id: "debank:bsc:wallet:balance:bsc:liquid:0",
      source: "debank",
      symbol: "BNB",
      name: "BNB",
      chainId: "bsc",
      chainName: "BNB Chain",
      protocolId: null,
      protocolName: null,
      iconUrl: null,
      amount: 1,
      priceUsd: 700,
      valueUsd: 700,
      state: "liquid"
    })).toBeNull();
    expect(getDeBankTokenExclusion({
      id: `debank:eth:wallet:balance:0x${"c".repeat(40)}:liquid:0`,
      source: "debank",
      symbol: "TOKEN",
      name: "Legacy token",
      chainId: "eth",
      chainName: "Ethereum",
      protocolId: null,
      protocolName: null,
      iconUrl: null,
      amount: 1,
      priceUsd: 1,
      valueUsd: 1,
      state: "liquid"
    })).toBe("legacy-unverified");
  });

  it("lets an exact chain and contract allowlist restore a legacy token", () => {
    const contractAddress = `0x${"d".repeat(40)}`;
    const previousAllowlist = process.env.DEBANK_TOKEN_ALLOWLIST;
    process.env.DEBANK_TOKEN_ALLOWLIST = `bsc:${contractAddress}`;

    try {
      expect(getDeBankTokenExclusion({
        id: `debank:bsc:wallet:balance:${contractAddress}:liquid:0`,
        source: "debank",
        symbol: "TOKEN",
        name: "Manually approved token",
        chainId: "bsc",
        chainName: "BNB Chain",
        protocolId: null,
        protocolName: null,
        iconUrl: null,
        contractAddress,
        verificationState: "unknown",
        amount: 1,
        priceUsd: 1,
        valueUsd: 1,
        state: "liquid"
      })).toBeNull();
    } finally {
      if (previousAllowlist === undefined) delete process.env.DEBANK_TOKEN_ALLOWLIST;
      else process.env.DEBANK_TOKEN_ALLOWLIST = previousAllowlist;
    }
  });

  it("keeps protocol net value authoritative while exposing supplied, borrowed, and claimable tokens", () => {
    const complex = [{
      id: "aave3",
      chain: "eth",
      name: "Aave V3",
      logo_url: "https://cdn.example/aave.png",
      site_url: "https://app.aave.com",
      portfolio_item_list: [{
        name: "Lending",
        detail_types: ["common"],
        stats: { asset_usd_value: 2000, debt_usd_value: 500, net_usd_value: 1500 },
        detail: {
          supply_token_list: [{ id: "usdc", chain: "eth", symbol: "USDC", amount: 2000, price: 1, is_verified: true }],
          borrow_token_list: [{ id: "weth", chain: "eth", symbol: "WETH", amount: 0.25, price: 2000, is_verified: true }],
          reward_token_list: [{ id: "aave", chain: "eth", symbol: "AAVE", amount: 1, price: 100, is_verified: true }]
        }
      }]
    }];
    const simple = [
      { id: "aave3", chain: "eth", name: "Aave V3", net_usd_value: 1500 },
      { id: "curve", chain: "arb", name: "Curve", net_usd_value: 300, asset_usd_value: 300 }
    ];

    const positions = normalizeDeBankProtocolPositions(complex, simple);

    expect(positions).toHaveLength(2);
    const aave = positions.find((position) => position.protocolId === "aave3");
    expect(aave).toMatchObject({
      source: "debank",
      protocolName: "Aave V3",
      protocolIconUrl: "https://cdn.example/aave.png",
      protocolUrl: "https://app.aave.com",
      chainName: "Ethereum",
      name: "Lending",
      state: "supplied",
      valueUsd: 1500,
      assetValueUsd: 2000,
      debtValueUsd: 500
    });
    expect(aave?.tokens.map((token) => [token.symbol, token.state, token.valueUsd])).toEqual([
      ["USDC", "supplied", 2000],
      ["WETH", "borrowed", 500],
      ["AAVE", "claimable", 100]
    ]);
    expect(aave?.tokens.reduce((sum, token) => sum + token.valueUsd, 0)).toBe(2600);
    expect(aave?.valueUsd).toBe(1500);
    expect(positions.find((position) => position.protocolId === "curve")).toMatchObject({
      name: "Curve position",
      chainName: "Arbitrum",
      valueUsd: 300,
      tokens: []
    });
  });

  it("retains lock timing when DeBank includes it", () => {
    const [position] = normalizeDeBankProtocolPositions([{
      id: "vote-lock",
      chain: "bsc",
      name: "Vote Lock",
      portfolio_item_list: [{
        name: "Locked",
        stats: { net_usd_value: 1200 },
        detail: {
          unlock_at: 1_800_000_000,
          supply_token_list: [{ id: "uni", symbol: "UNI", amount: 100, price: 12, is_verified: true }]
        }
      }]
    }]);

    expect(position).toMatchObject({ state: "locked", chainName: "BNB Chain" });
    expect(position.unlockAt).toBe("2027-01-15T08:00:00.000Z");
    expect(position.tokens[0]).toMatchObject({ symbol: "UNI", state: "locked", valueUsd: 1200 });
  });

  it("builds signed underlying holdings that reconcile to authoritative protocol and wallet totals", () => {
    const tokens = normalizeDeBankWalletTokens([
      { id: "bsc", chain: "bsc", symbol: "BNB", name: "BNB", amount: 1, price: 500 }
    ]);
    const positions = normalizeDeBankProtocolPositions([{
      id: "aave3",
      chain: "eth",
      name: "Aave V3",
      portfolio_item_list: [{
        name: "Lending",
        stats: { asset_usd_value: 2_000, debt_usd_value: 500, net_usd_value: 1_500 },
        detail: {
          supply_token_list: [{ id: "usdc", symbol: "USDC", name: "USD Coin", amount: 2_000, price: 1, is_verified: true }],
          borrow_token_list: [{ id: "wbtc", symbol: "WBTC", name: "Wrapped Bitcoin", amount: 0.005, price: 100_000, is_verified: true }]
        }
      }]
    }]);

    const holdings = buildDeBankWalletHoldings({
      tokens,
      positions,
      protocolValueUsd: 1_500,
      walletValueUsd: 2_000
    });

    expect(holdings.map((holding) => [holding.symbol, holding.valueUsd])).toEqual([
      ["BNB", 500],
      ["USDC", 2_000],
      ["WBTC", -500]
    ]);
    expect(holdings.reduce((sum, holding) => sum + holding.valueUsd, 0)).toBe(2_000);
  });

  it("uses signed reconciliation rows without counting position net value twice", () => {
    const positions = normalizeDeBankProtocolPositions([{
      id: "vault",
      chain: "eth",
      name: "Vault",
      portfolio_item_list: [{
        name: "Vault deposit",
        stats: { net_usd_value: 900 },
        detail: {
          supply_token_list: [{ id: "usdc", symbol: "USDC", amount: 1_000, price: 1, is_verified: true }]
        }
      }]
    }]);

    const holdings = buildDeBankWalletHoldings({
      tokens: [],
      positions,
      protocolValueUsd: 850,
      walletValueUsd: 800
    });

    expect(holdings.map((holding) => [holding.symbol, holding.valueUsd])).toEqual([
      ["USDC", 1_000],
      ["DEFI", -100],
      ["DEFI", -50],
      ["DEBANK-RECONCILIATION", -50]
    ]);
    expect(holdings.reduce((sum, holding) => sum + holding.valueUsd, 0)).toBe(800);
  });
});

describe("Hyperliquid wallet details", () => {
  it("separates delegated, available, pending, trading, and vault states without changing the source total", () => {
    const nowMs = Date.UTC(2026, 7, 22);
    const positions = normalizeHyperliquidPositions({
      address: "0xABC",
      hypePriceUsd: 20,
      staking: { delegated: "10", undelegated: "2", totalPendingWithdrawal: "3" },
      perps: { marginSummary: { accountValue: "400" } },
      vaults: [
        { vaultAddress: "0xLOCKED", name: "Locked vault", equity: "500", lockupUntil: 1_800_000_000_000 },
        { vaultAddress: "0xOPEN", name: "Open vault", equity: "200", lockupUntil: 1_700_000_000_000 }
      ],
      nowMs
    });

    expect(positions.reduce((sum, position) => sum + position.valueUsd, 0)).toBe(1400);
    const staking = positions.find((position) => position.protocolId === "hyperliquid-staking");
    expect(staking).toMatchObject({ state: "staked", valueUsd: 300, assetValueUsd: 300 });
    expect(staking?.tokens.map((token) => [token.amount, token.state, token.valueUsd])).toEqual([
      [10, "staked", 200],
      [3, "locked", 60],
      [2, "liquid", 40]
    ]);
    expect(positions.find((position) => position.protocolId === "hyperliquid-perps")).toMatchObject({
      state: "trading",
      valueUsd: 400
    });
    expect(positions.find((position) => position.name === "Locked vault")).toMatchObject({
      state: "locked",
      unlockAt: "2027-01-15T08:00:00.000Z"
    });
    expect(positions.find((position) => position.name === "Open vault")).toMatchObject({
      state: "vault",
      unlockAt: null
    });
  });
});
