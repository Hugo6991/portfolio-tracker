import { describe, expect, it } from "vitest";
import {
  WALLET_DISPLAY_THRESHOLD_USD,
  buildWalletAllocation,
  filterDisplayWallets,
  getWalletDetails,
  normalizeWalletAllocationForDonut,
  positionStateLabel
} from "./wallet-view-model";

const detailedWallet = {
  id: "wallet-a",
  name: "Treasury",
  valueUsd: 2_500,
  tokens: [
    {
      id: "ethereum-usdc",
      source: "debank",
      symbol: "USDC",
      name: "USD Coin",
      chainId: "eth",
      chainName: "Ethereum",
      protocolId: null,
      protocolName: null,
      iconUrl: "https://example.com/usdc.png",
      amount: 1_000,
      priceUsd: 1,
      valueUsd: 1_000,
      state: "liquid"
    }
  ],
  positions: [
    {
      id: "hyperliquid-staking",
      source: "hyperliquid",
      protocolId: "hyperliquid",
      protocolName: "Hyperliquid",
      protocolIconUrl: "https://example.com/hype.png",
      protocolUrl: "https://app.hyperliquid.xyz",
      chainId: "hyperliquid",
      chainName: "Hyperliquid",
      name: "Native staking",
      state: "staked",
      valueUsd: 1_500,
      assetValueUsd: 1_500,
      debtValueUsd: 0,
      unlockAt: null,
      tokens: [{
        id: "hype",
        source: "hyperliquid",
        symbol: "HYPE",
        name: "Hyperliquid",
        chainId: "hyperliquid",
        chainName: "Hyperliquid",
        protocolId: "hyperliquid",
        protocolName: "Hyperliquid",
        iconUrl: null,
        amount: 30,
        priceUsd: 50,
        valueUsd: 1_500,
        state: "staked"
      }]
    }
  ]
};

describe("wallet view model", () => {
  it("omits wallets below the $1,000 display threshold", () => {
    const wallets = filterDisplayWallets([
      detailedWallet,
      { id: "threshold", name: "Threshold", valueUsd: WALLET_DISPLAY_THRESHOLD_USD },
      { id: "small", name: "Small", valueUsd: 999.99 }
    ]);

    expect(wallets.map((wallet) => wallet.id)).toEqual(["wallet-a", "threshold"]);
  });

  it("normalizes backend token and position details for the expanded wallet", () => {
    const details = getWalletDetails(detailedWallet);

    expect(details.tokens[0]).toMatchObject({
      symbol: "USDC",
      chain: "eth",
      chainLabel: "Ethereum",
      state: "liquid",
      valueUsd: 1_000
    });
    expect(details.positions[0]).toMatchObject({
      protocolName: "Hyperliquid",
      state: "staked",
      valueUsd: 1_500,
      assetUsd: 1_500,
      debtUsd: 0
    });
    expect(details.positions[0].tokens[0].symbol).toBe("HYPE");
  });

  it("keeps zero-valued excluded tokens out of wallet detail and allocation", () => {
    const wallet = {
      ...detailedWallet,
      valueUsd: 1_500,
      tokens: [
        ...detailedWallet.tokens,
        {
          ...detailedWallet.tokens[0],
          id: "scam",
          symbol: "BNB",
          amount: 1084,
          priceUsd: 733,
          valueUsd: 0,
          valuationState: "excluded",
          priceState: "excluded"
        }
      ]
    };

    expect(getWalletDetails(wallet).tokens.map((token) => token.id)).toEqual(["ethereum-usdc"]);
    expect(buildWalletAllocation([wallet]).some((item) => item.symbol === "BNB")).toBe(false);
  });

  it("builds token-level allocation once every visible wallet has detail data", () => {
    expect(buildWalletAllocation([detailedWallet])).toEqual([
      { id: "HYPE", label: "HYPE", symbol: "HYPE", value: 1_500 },
      { id: "USDC", label: "USDC", symbol: "USDC", value: 1_000 }
    ]);
  });

  it("classifies supplied assets as positive and borrowed assets as negative", () => {
    const position = detailedWallet.positions[0];
    const allocation = buildWalletAllocation([{
      ...detailedWallet,
      valueUsd: 600,
      tokens: [],
      positions: [{
        ...position,
        valueUsd: 600,
        tokens: [
          { ...position.tokens[0], id: "eth", symbol: "ETH", valueUsd: 1_000, state: "supplied" },
          { ...position.tokens[0], id: "usdc", symbol: "USDC", valueUsd: 400, state: "borrowed" }
        ]
      }]
    }]);

    expect(allocation).toEqual([
      { id: "ETH", label: "ETH", symbol: "ETH", value: 1_000 },
      { id: "USDC", label: "USDC", symbol: "USDC", value: -400 }
    ]);
    expect(allocation.reduce((sum, item) => sum + item.value, 0)).toBe(600);

    expect(normalizeWalletAllocationForDonut(allocation, 600)).toEqual([
      { id: "ETH", label: "ETH", symbol: "ETH", value: 600 }
    ]);
  });

  it("puts an unclassified position difference in Other while preserving its authoritative net", () => {
    const position = detailedWallet.positions[0];
    const allocation = buildWalletAllocation([{
      ...detailedWallet,
      valueUsd: 650,
      tokens: [],
      positions: [{
        ...position,
        valueUsd: 650,
        tokens: [
          { ...position.tokens[0], id: "eth", symbol: "ETH", valueUsd: 1_000, state: "supplied" },
          { ...position.tokens[0], id: "usdc", symbol: "USDC", valueUsd: 400, state: "borrowed" }
        ]
      }]
    }]);

    expect(allocation).toEqual([
      { id: "ETH", label: "ETH", symbol: "ETH", value: 1_000 },
      { id: "OTHER", label: "Other", value: 50 },
      { id: "USDC", label: "USDC", symbol: "USDC", value: -400 }
    ]);
    expect(allocation.reduce((sum, item) => sum + item.value, 0)).toBe(650);
  });

  it("reconciles incomplete detail rows to the authoritative wallet total", () => {
    const allocation = buildWalletAllocation([{
      ...detailedWallet,
      valueUsd: 3_000
    }]);

    expect(allocation).toContainEqual({ id: "OTHER", label: "Other", value: 500 });
    expect(allocation.reduce((sum, item) => sum + item.value, 0)).toBe(3_000);
  });

  it("keeps exact claimable and collateral state labels", () => {
    const details = getWalletDetails({
      ...detailedWallet,
      tokens: [
        { ...detailedWallet.tokens[0], id: "reward", state: "claimable" },
        { ...detailedWallet.tokens[0], id: "collateral", state: "collateral" }
      ],
      positions: []
    });

    expect(details.tokens.map((token) => token.state)).toEqual(["claimable", "collateral"]);
    expect(positionStateLabel(details.tokens[0].state)).toBe("Claimable");
  });
});
