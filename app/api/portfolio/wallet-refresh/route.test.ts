import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn(), sources: vi.fn(), claim: vi.fn(), finish: vi.fn(), apply: vi.fn(), quality: vi.fn() }));
vi.mock("@/lib/server/portfolio-admin-auth", () => ({ authorizePortfolioAdmin: mocks.auth }));
vi.mock("@/lib/server/portfolio-source-state", () => ({ readPortfolioSourcePayloads: mocks.sources }));
vi.mock("@/lib/server/portfolio-snapshot-store", () => ({ readLatestPortfolioSnapshot: mocks.read, claimPortfolioSync: mocks.claim, finishPortfolioSync: mocks.finish }));
vi.mock("@/lib/server/targeted-wallet-refresh", async (original) => ({ ...await original<object>(), applyWalletCapture: mocks.apply }));
vi.mock("@/lib/portfolio-snapshot-policy", () => ({ evaluatePortfolioSnapshot: mocks.quality }));
import { POST } from "./route";

const address = `0x${"1".repeat(40)}`;
const capture = { version: 1, address, capturedAt: new Date().toISOString(), tokens: { bob: [] }, protocols: {}, usage: { requests: 1, unitsBefore: 100, unitsAfter: 95 } };
const request = (publish = false) => new Request("https://example.com/api/portfolio/wallet-refresh", { method: "POST", body: JSON.stringify({ password: "test", capture, publish }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockReturnValue("authorized");
  const wallet = { id: "one", address, valueUsd: 100, pendingMovements: [] };
  const source = { id: "debank", status: "live" };
  const snapshot = { netWorthUsd: 100, connectedSourceCount: 1, errors: [], sources: [source], wallets: [wallet] };
  mocks.read.mockResolvedValue({ captured_at: new Date().toISOString(), snapshot });
  mocks.sources.mockResolvedValue(new Map([["debank", { source, holdings: [], wallets: [wallet], lastGoodAt: new Date().toISOString() }]]));
  mocks.apply.mockReturnValue({ snapshot, debankPayload: { source, holdings: [], wallets: [wallet] } });
  mocks.quality.mockReturnValue({ accepted: true, status: "complete", reasons: [] });
  mocks.claim.mockResolvedValue({ claimed: true, runId: 7, leaseToken: "lease", reason: "claimed" });
  mocks.finish.mockResolvedValue(true);
});

describe("protected scoped publication", () => {
  it("rejects unauthenticated input before reading or modifying data", async () => {
    mocks.auth.mockReturnValue("unauthorized");
    expect((await POST(request(true))).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it("returns a review without acquiring a lease or publishing", async () => {
    const result = await POST(request());
    expect((await result.json()).status).toBe("reviewed");
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
  });
  it("publishes both current and structured source data atomically without rewriting history or consuming credits", async () => {
    const result = await POST(request(true));
    expect((await result.json()).status).toBe("published");
    expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({ publishCurrent: true, writeValue: false, writeFull: false, requireSourcePayloads: true, sourcePayloads: [expect.objectContaining({ source: { id: "debank", status: "live" } })], detail: expect.objectContaining({ providerUsage: { debank: { scanAttempted: false, scanKind: "none", requestCount: 0, estimatedUnits: 0 } } }) }));
  });
  it("stops duplicate or concurrent publication before reading provider state", async () => {
    mocks.claim.mockResolvedValue({ claimed: false, reason: "already_completed" });
    expect((await (await POST(request(true))).json()).status).toBe("already_completed");
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
  });
  it("does not publish rejected candidates or incomplete structured baselines", async () => {
    mocks.sources.mockResolvedValue(new Map());
    mocks.read.mockResolvedValue({ captured_at: new Date().toISOString(), snapshot: { sources: [{ id: "binance" }] } });
    expect((await POST(request(true))).status).toBe(409);
    expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({ publishCurrent: false, status: "failed", sourcePayloads: [] }));
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("recovers a legacy DeBank source from current wallet details and persists its replacement", async () => {
    mocks.sources.mockResolvedValue(new Map());
    expect((await (await POST(request(true))).json()).status).toBe("published");
    expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({ sourcePayloads: [expect.objectContaining({ source: { id: "debank", status: "live" } })] }));
  });
  it("does not retry an uncertain database completion", async () => {
    mocks.finish.mockRejectedValue(new Error("timeout"));
    expect((await POST(request(true))).status).toBe(409);
    expect(mocks.finish).toHaveBeenCalledTimes(1);
  });
});
