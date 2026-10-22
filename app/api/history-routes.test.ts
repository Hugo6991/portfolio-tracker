import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const readWalletHistory = vi.fn();
const readAssetHistory = vi.fn();
const requireViewerJson = vi.fn();

vi.mock("@/lib/server/portfolio-snapshot-store", () => ({
  readWalletHistory,
  readAssetHistory
}));
vi.mock("@/lib/server/viewer-auth", () => ({
  privateNoStoreHeaders: {
    "Cache-Control": "private, no-store, max-age=0",
    "Vercel-CDN-Cache-Control": "no-store"
  },
  requireViewerJson
}));

let getWalletHistory: typeof import("./wallets/history/route").GET;
let getAssetHistory: typeof import("./assets/history/route").GET;

beforeAll(async () => {
  ({ GET: getWalletHistory } = await import("./wallets/history/route"));
  ({ GET: getAssetHistory } = await import("./assets/history/route"));
});

beforeEach(() => {
  readWalletHistory.mockReset();
  readAssetHistory.mockReset();
  requireViewerJson.mockReset().mockResolvedValue(null);
});

describe("read-only history routes", () => {
  it("rejects an anonymous wallet request before reading storage", async () => {
    requireViewerJson.mockResolvedValueOnce(Response.json({ error: "Viewer access required" }, { status: 401 }));

    const response = await getWalletHistory(
      new Request("https://portfolio.test/api/wallets/history")
    );

    expect(response.status).toBe(401);
    expect(readWalletHistory).not.toHaveBeenCalled();
  });

  it("rejects an anonymous asset request before reading storage", async () => {
    requireViewerJson.mockResolvedValueOnce(Response.json({ error: "Viewer access required" }, { status: 401 }));

    const response = await getAssetHistory(
      new Request("https://portfolio.test/api/assets/history")
    );

    expect(response.status).toBe(401);
    expect(readAssetHistory).not.toHaveBeenCalled();
  });

  it("returns wallet history and clamps a too-small range", async () => {
    readWalletHistory.mockResolvedValue({ overview: [], wallets: [] });

    const response = await getWalletHistory(
      new Request("https://portfolio.test/api/wallets/history?days=1")
    );

    expect(readWalletHistory).toHaveBeenCalledWith(7);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      configured: true,
      overview: [],
      wallets: []
    });
  });

  it("minimizes public wallet history metadata", async () => {
    readWalletHistory.mockResolvedValue({
      overview: [],
      wallets: [{
        walletId: "wallet-1",
        name: "Identity revealing label",
        address: "0x1234567890abcdef1234567890abcdef12345678",
        points: [{
          date: "2026-08-22",
          capturedAt: "2026-08-21T16:00:00.000Z",
          valueUsd: 1_500,
          debankValueUsd: 1_000,
          hyperliquidValueUsd: 500,
          isTracked: true,
          quality: "complete"
        }]
      }]
    });

    const response = await getWalletHistory(
      new Request("https://portfolio.test/api/wallets/history")
    );

    await expect(response.json()).resolves.toEqual({
      configured: true,
      overview: [],
      wallets: [{
        walletId: "wallet-1",
        points: [{
          date: "2026-08-22",
          capturedAt: "2026-08-21T16:00:00.000Z",
          valueUsd: 1_500,
          isTracked: true,
          quality: "complete"
        }]
      }]
    });
  });

  it("returns asset history and clamps a too-large range", async () => {
    readAssetHistory.mockResolvedValue([]);

    const response = await getAssetHistory(
      new Request("https://portfolio.test/api/assets/history?days=9999")
    );

    expect(readAssetHistory).toHaveBeenCalledWith(730);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ configured: true, points: [] });
  });

  it("returns a bounded 503 error without leaking an oversized message", async () => {
    readWalletHistory.mockRejectedValue(new Error("x".repeat(300)));

    const response = await getWalletHistory(
      new Request("https://portfolio.test/api/wallets/history")
    );
    const body = await response.json() as { error: string };

    expect(readWalletHistory).toHaveBeenCalledWith(365);
    expect(response.status).toBe(503);
    expect(body.error).toHaveLength(160);
  });
});
