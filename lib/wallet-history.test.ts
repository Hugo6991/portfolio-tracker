import { describe, expect, it } from "vitest";
import type {
  LivePortfolioSnapshot,
  LiveSourceStatus,
  LiveWallet
} from "./live-portfolio";
import { canonicalizeDailyWalletSnapshots } from "./wallet-history";
import { buildWalletOverviewTrend } from "./wallet-trend";

const address = "0x0000000000000000000000000000000000000101";

function wallet(overrides: Partial<LiveWallet> = {}): LiveWallet {
  return {
    id: "wallet-1",
    name: "Treasury",
    address,
    debankUrl: `https://debank.com/profile/${address}`,
    valueUsd: 1_500,
    debankValueUsd: 1_000,
    hyperliquidValueUsd: 500,
    tokenCount: 1,
    protocolCount: 1,
    tokens: [],
    positions: [],
    status: "live",
    updatedAt: "2026-08-11T17:15:00.000Z",
    ...overrides
  };
}

function snapshot({
  generatedAt = "2026-08-11T17:15:00.000Z",
  wallets = [wallet()],
  walletSourceStatuses = ["live", "live"],
  walletsUsd = wallets.reduce((sum, item) => sum + item.valueUsd, 0)
}: {
  generatedAt?: string;
  wallets?: LiveWallet[];
  walletSourceStatuses?: LiveSourceStatus[];
  walletsUsd?: number;
} = {}): LivePortfolioSnapshot {
  return {
    generatedAt,
    netWorthUsd: walletsUsd,
    liveValueUsd: walletsUsd,
    previewValueUsd: 0,
    groups: { exchangesUsd: 0, walletsUsd, banksUsd: 0 },
    sources: walletSourceStatuses.map((status, index) => ({
      id: index === 0 ? "debank" : "hyperliquid",
      name: index === 0 ? "DeBank" : "Hyperliquid",
      kind: "wallet",
      status,
      valueUsd: status === "error" ? 0 : walletsUsd,
      itemCount: wallets.length,
      updatedAt: generatedAt,
      detail: status
    })),
    holdings: [],
    wallets,
    connectedSourceCount: walletSourceStatuses.filter((status) => status === "live" || status === "partial").length,
    expectedSourceCount: walletSourceStatuses.length,
    isPartial: walletSourceStatuses.some((status) => status !== "live"),
    errors: []
  };
}

describe("wallet history", () => {
  it("keeps the latest snapshot for each Taipei day without mutating the input", () => {
    const earlier = snapshot({ generatedAt: "2026-08-11T17:15:00.000Z" });
    const latest = snapshot({
      generatedAt: "2026-08-12T03:00:00.000Z",
      wallets: [wallet({ valueUsd: 1_800 })],
      walletsUsd: 1_800
    });
    const nextDay = snapshot({
      generatedAt: "2026-08-12T17:15:00.000Z",
      wallets: [wallet({ valueUsd: 2_000 })],
      walletsUsd: 2_000
    });
    const input = [nextDay, earlier, latest];
    const originalOrder = input.map((item) => item.generatedAt);

    const result = canonicalizeDailyWalletSnapshots(input);

    expect(input.map((item) => item.generatedAt)).toEqual(originalOrder);
    expect(result.overview.map((point) => [point.date, point.valueUsd])).toEqual([
      ["2026-08-12", 1_800],
      ["2026-08-13", 2_000]
    ]);
    expect(result.wallets[0].points.map((point) => point.valueUsd)).toEqual([1_800, 2_000]);
  });

  it("uses a lowercased address as stable identity across name and id changes", () => {
    const result = canonicalizeDailyWalletSnapshots([
      snapshot({
        generatedAt: "2026-08-10T16:00:00.000Z",
        wallets: [wallet({ id: "old-id", name: "Old name" })]
      }),
      snapshot({
        generatedAt: "2026-08-11T16:00:00.000Z",
        wallets: [wallet({ id: "new-id", name: "New name", address: address.toLowerCase() })]
      })
    ]);

    expect(result.wallets).toHaveLength(1);
    expect(result.wallets[0]).toMatchObject({
      walletId: "new-id",
      name: "New name",
      address: address.toLowerCase()
    });
    expect(result.wallets[0].points).toHaveLength(2);
  });

  it("emits null gaps for absent and failed wallets instead of false zeroes", () => {
    const result = canonicalizeDailyWalletSnapshots([
      snapshot({ generatedAt: "2026-08-10T16:00:00.000Z" }),
      snapshot({ generatedAt: "2026-08-11T16:00:00.000Z", wallets: [], walletsUsd: 0 }),
      snapshot({
        generatedAt: "2026-08-12T16:00:00.000Z",
        wallets: [wallet({ status: "error", valueUsd: 0, debankValueUsd: 0, hyperliquidValueUsd: 0 })],
        walletSourceStatuses: ["partial", "live"],
        walletsUsd: 0
      })
    ]);

    expect(result.wallets[0].points.map((point) => ({
      valueUsd: point.valueUsd,
      quality: point.quality,
      isTracked: point.isTracked
    }))).toEqual([
      { valueUsd: 1_500, quality: "complete", isTracked: true },
      { valueUsd: null, quality: "unavailable", isTracked: false },
      { valueUsd: null, quality: "unavailable", isTracked: true }
    ]);
  });

  it("marks partial wallet-source coverage and nulls an unavailable overview", () => {
    const result = canonicalizeDailyWalletSnapshots([
      snapshot({ walletSourceStatuses: ["live", "partial"] }),
      snapshot({
        generatedAt: "2026-08-12T17:15:00.000Z",
        walletSourceStatuses: ["error", "error"],
        wallets: [],
        walletsUsd: 0
      })
    ]);

    expect(result.overview[0]).toMatchObject({ quality: "partial", isPartial: true, valueUsd: 1_500 });
    expect(result.overview[1]).toMatchObject({ quality: "unavailable", isPartial: true, valueUsd: null });
  });

  it("does not mark a legacy snapshot complete when an expected wallet source is missing", () => {
    const result = canonicalizeDailyWalletSnapshots([
      snapshot({ walletSourceStatuses: ["live"] })
    ]);

    expect(result.overview[0]).toMatchObject({ quality: "partial", isPartial: true });
    expect(result.wallets[0].points[0]).toMatchObject({ quality: "partial" });
  });

  it("tolerates legacy wallet snapshots without token and position detail arrays", () => {
    const legacyWallet: Record<string, unknown> = { ...wallet() };
    delete legacyWallet.tokens;
    delete legacyWallet.positions;

    const result = canonicalizeDailyWalletSnapshots([
      snapshot({ wallets: [legacyWallet as LiveWallet] })
    ]);

    expect(result.wallets[0].points[0]).toMatchObject({ valueUsd: 1_500, quality: "complete" });
  });

  it("returns empty collections for empty history", () => {
    expect(canonicalizeDailyWalletSnapshots([])).toEqual({ overview: [], wallets: [] });
  });
});

describe("wallet overview trend", () => {
  const addedWallet = wallet({ id: "wallet-2", address: "0x2222", valueUsd: 2_000 });

  function history(snapshots: LivePortfolioSnapshot[]) {
    return { configured: true, ...canonicalizeDailyWalletSnapshots(snapshots) };
  }

  it("keeps August balances when the current view includes a wallet first recorded in September", () => {
    const data = history([
      snapshot({ generatedAt: "2026-08-05T01:15:00.000Z" }),
      snapshot({ generatedAt: "2026-09-07T01:15:00.000Z", wallets: [wallet(), addedWallet] })
    ]);

    expect(buildWalletOverviewTrend(data, ["wallet-1", "wallet-2"])).toEqual([
      { date: "2026-08-05", valueUsd: 1_500, trackedWalletCount: 1 },
      { date: "2026-09-07", valueUsd: 3_500, trackedWalletCount: 2 }
    ]);
    // An individual wallet still has no invented balance before it was recorded.
    expect(data.wallets.find((item) => item.walletId === "wallet-2")?.points[0]).toMatchObject({
      valueUsd: null, quality: "unavailable", isTracked: false
    });
  });

  it("uses snapshot membership on each day while retaining the current display selection", () => {
    const data = history([
      snapshot({ generatedAt: "2026-08-22T01:15:00.000Z", wallets: [wallet(), addedWallet] }),
      snapshot({ generatedAt: "2026-08-23T01:15:00.000Z", wallets: [wallet()] }),
      snapshot({ generatedAt: "2026-08-24T01:15:00.000Z", wallets: [wallet(), addedWallet] })
    ]);

    expect(buildWalletOverviewTrend(data, ["wallet-1", "wallet-2"]).map((point) => point.valueUsd))
      .toEqual([3_500, 1_500, 3_500]);
    expect(buildWalletOverviewTrend(data, ["wallet-1"]).map((point) => point.valueUsd))
      .toEqual([1_500, 1_500, 1_500]);
  });

  it("keeps failed and partial recorded wallets as gaps even if source status claims completeness", () => {
    const data = history([
      snapshot({ generatedAt: "2026-08-05T01:15:00.000Z", wallets: [wallet(), { ...addedWallet, status: "error" }] }),
      snapshot({ generatedAt: "2026-08-06T01:15:00.000Z", wallets: [wallet(), { ...addedWallet, status: "partial" } as unknown as LiveWallet] }),
      snapshot({ generatedAt: "2026-08-07T01:15:00.000Z", walletSourceStatuses: ["live", "partial"] })
    ]);

    expect(buildWalletOverviewTrend(data, ["wallet-1", "wallet-2"]).map((point) => point.valueUsd))
      .toEqual([null, null, null]);
  });

  it("does not turn an empty selection or an entirely absent selection into a zero balance", () => {
    const data = history([
      snapshot({ generatedAt: "2026-08-05T01:15:00.000Z" }),
      snapshot({ generatedAt: "2026-09-07T01:15:00.000Z", wallets: [wallet(), addedWallet] })
    ]);

    expect(buildWalletOverviewTrend(null, ["wallet-1"])).toEqual([]);
    expect(buildWalletOverviewTrend(data, []).map((point) => point.valueUsd)).toEqual([null, null]);
    expect(buildWalletOverviewTrend(data, ["wallet-2"]).map((point) => point.valueUsd)).toEqual([null, 2_000]);
  });

  it("keeps a recorded zero balance and fails closed for missing point metadata", () => {
    const data = history([snapshot({ wallets: [wallet({ valueUsd: 0 })] })]);
    expect(buildWalletOverviewTrend(data, ["wallet-1"])[0].valueUsd).toBe(0);

    const point = data.wallets[0].points[0];
    // A mixed deployment or malformed response must not turn unknown absence into zero.
    const legacyPoint = { ...point, valueUsd: null, quality: "unavailable" } as Record<string, unknown>;
    delete legacyPoint.isTracked;
    data.wallets[0].points[0] = legacyPoint as unknown as typeof point;
    expect(buildWalletOverviewTrend(data, ["wallet-1"])[0].valueUsd).toBeNull();

    data.wallets[0].points = [];
    expect(buildWalletOverviewTrend(data, ["wallet-1"])[0].valueUsd).toBeNull();
  });
});
