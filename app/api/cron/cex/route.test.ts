import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const isCronRequestAuthorized = vi.fn();
const syncCexSources = vi.fn();
const claimCexSync = vi.fn();
const finishCexSync = vi.fn();
const isCexSnapshotStorageConfigured = vi.fn();
const readLatestCexSnapshots = vi.fn();
const writeCexSnapshots = vi.fn();

vi.mock("@/lib/server/cron-auth", () => ({ isCronRequestAuthorized }));
vi.mock("@/lib/server/cex-sources", () => ({ syncCexSources }));
vi.mock("@/lib/server/cex-snapshot-store", () => ({
  CEX_SNAPSHOT_WRITER_VERSION: "cex-rpc-v2",
  claimCexSync,
  finishCexSync,
  isCexSnapshotStorageConfigured,
  readLatestCexSnapshots,
  writeCexSnapshots
}));

let runCexSync: typeof import("./route").GET;

beforeAll(async () => {
  ({ GET: runCexSync } = await import("./route"));
});

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-secret");
  isCronRequestAuthorized.mockReset().mockReturnValue(true);
  syncCexSources.mockReset().mockResolvedValue([snapshot()]);
  claimCexSync.mockReset().mockResolvedValue({
    claimed: true,
    runId: 7,
    leaseToken: "lease-token",
    reason: "claimed",
    mode: "lease"
  });
  finishCexSync.mockReset().mockResolvedValue(true);
  isCexSnapshotStorageConfigured.mockReset().mockReturnValue(true);
  readLatestCexSnapshots.mockReset().mockResolvedValue({});
  writeCexSnapshots.mockReset().mockResolvedValue({ written: 1, skipped: 0, failed: 0, errors: [] });
});

describe("CEX cron lease", () => {
  it("rejects unauthorized requests before claiming a lease", async () => {
    isCronRequestAuthorized.mockReturnValue(false);

    const response = await runCexSync(request());

    expect(response.status).toBe(401);
    expect(claimCexSync).not.toHaveBeenCalled();
  });

  it("does not run providers when another worker owns the lease", async () => {
    claimCexSync.mockResolvedValue({
      claimed: false,
      runId: 6,
      leaseToken: null,
      reason: "already_running",
      mode: "lease"
    });

    const response = await runCexSync(request());
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.status).toBe("already_running");
    expect(syncCexSources).not.toHaveBeenCalled();
    expect(finishCexSync).not.toHaveBeenCalled();
  });

  it("claims and completes a scheduled sync", async () => {
    const response = await runCexSync(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("success");
    expect(claimCexSync).toHaveBeenCalledWith(expect.objectContaining({
      trigger: "cron",
      leaseSeconds: 180
    }));
    expect(finishCexSync).toHaveBeenCalledWith(expect.objectContaining({
      status: "success",
      claim: expect.objectContaining({ leaseToken: "lease-token" })
    }));
  });

  it("uses a separate manual job bucket for an authenticated retry", async () => {
    await runCexSync(request("?manual=1"));

    expect(claimCexSync).toHaveBeenCalledWith(expect.objectContaining({
      trigger: "manual",
      jobKey: expect.stringContaining("cex:manual:")
    }));
  });
});

function request(query = "") {
  return new Request(`https://portfolio.test/api/cron/cex${query}`, {
    headers: { authorization: "Bearer cron-secret" }
  });
}

function snapshot() {
  const capturedAt = "2026-09-06T15:00:00.000Z";
  return {
    exchange: "gate",
    name: "Gate",
    status: "live",
    capturedAt,
    bucketAt: capturedAt,
    valueUsd: 100,
    itemCount: 1,
    accounts: [{
      id: "gate-spot",
      name: "Spot",
      status: "live",
      valueUsd: 100,
      itemCount: 1,
      holdings: []
    }],
    holdings: [],
    errors: []
  };
}
