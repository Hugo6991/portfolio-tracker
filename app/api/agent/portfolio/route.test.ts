import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const readLatestPortfolioSnapshot = vi.fn();
const readPortfolioHistory = vi.fn();
const readLatestPortfolioSyncSummary = vi.fn();
const readAgentFxRate = vi.fn();
const consumeDurableRateLimit = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent-portfolio", () => ({
  buildAgentPortfolioResponse: vi.fn((input: { includeTotals?: boolean; fx?: { rate: number } }) => ({
    schemaVersion: "2026-09-01",
    privacy: { absoluteValuesExposed: input.includeTotals === true },
    ...(input.includeTotals
      ? { totals: { totalUsd: 100, totalTwd: 100 * (input.fx?.rate ?? 31) } }
      : {}),
    brief: { language: "zh-Hant", text: "• Portfolio brief" }
  }))
}));
vi.mock("@/lib/server/agent-fx-rate", () => ({ readAgentFxRate }));
vi.mock("@/lib/server/request-rate-limit", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/server/request-rate-limit")>();
  return { ...original, consumeDurableRateLimit };
});
vi.mock("@/lib/server/portfolio-snapshot-store", () => ({
  readLatestPortfolioSnapshot,
  readLatestPortfolioSyncSummary,
  readPortfolioHistory
}));

let getAgentPortfolio: typeof import("./route").GET;

beforeAll(async () => {
  ({ GET: getAgentPortfolio } = await import("./route"));
});

beforeEach(() => {
  delete process.env.AGENT_PORTFOLIO_EXPOSE_TOTAL;
  readLatestPortfolioSnapshot.mockReset();
  readPortfolioHistory.mockReset();
  readLatestPortfolioSyncSummary.mockReset();
  readAgentFxRate.mockReset();
  consumeDurableRateLimit.mockReset();
  consumeDurableRateLimit.mockResolvedValue({ rateLimited: false, retryAfterSeconds: 0 });
  readPortfolioHistory.mockResolvedValue([]);
  readLatestPortfolioSyncSummary.mockResolvedValue(null);
  readAgentFxRate.mockResolvedValue({ rate: 32, status: "updated_today" });
});

describe("Agent portfolio API", () => {
  it("returns a percentage-only agent view without shared caching", async () => {
    readLatestPortfolioSnapshot.mockResolvedValue({
      captured_at: "2026-09-01T00:00:00.000Z",
      snapshot: snapshot()
    });
    const response = await getAgentPortfolio(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("Vercel-CDN-Cache-Control")).toBe("no-store");
    expect(body.privacy.absoluteValuesExposed).toBe(false);
    expect(body.absoluteValues).toBeUndefined();
    expect(readPortfolioHistory).toHaveBeenCalledWith(365, "daily");
    expect(readAgentFxRate).not.toHaveBeenCalled();
    expect(readLatestPortfolioSyncSummary).not.toHaveBeenCalled();
  });

  it("fails closed when aggregated totals are not enabled", async () => {
    const response = await getAgentPortfolio(request("?include=total"));

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(readLatestPortfolioSnapshot).not.toHaveBeenCalled();
    expect(consumeDurableRateLimit).not.toHaveBeenCalled();
  });

  it("rate limits the anonymous response before reading portfolio storage", async () => {
    consumeDurableRateLimit.mockResolvedValue({ rateLimited: true, retryAfterSeconds: 45 });

    const response = await getAgentPortfolio(request());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("45");
    expect(readLatestPortfolioSnapshot).not.toHaveBeenCalled();
    expect(readPortfolioHistory).not.toHaveBeenCalled();
  });

  it("returns only aggregated totals with no shared caching when enabled", async () => {
    process.env.AGENT_PORTFOLIO_EXPOSE_TOTAL = "true";
    readLatestPortfolioSnapshot.mockResolvedValue({
      captured_at: "2026-09-01T00:00:00.000Z",
      snapshot: snapshot()
    });
    readLatestPortfolioSyncSummary.mockResolvedValue({
      completedAt: "2026-09-02T00:00:00.000Z",
      status: "skipped_degraded",
      rejectedSources: ["debank"],
      reasonCodes: ["value-collapse"]
    });

    const response = await getAgentPortfolio(request("?include=total"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Cache-Control")).not.toContain("s-maxage");
    expect(body.privacy.absoluteValuesExposed).toBe(true);
    expect(body.totals).toEqual({ totalUsd: 100, totalTwd: 3200 });
    expect(body.absoluteValues).toBeUndefined();
    expect(readAgentFxRate).toHaveBeenCalledOnce();
    expect(readLatestPortfolioSyncSummary).toHaveBeenCalledOnce();
  });

  it("keeps totals available with the FX fallback result", async () => {
    process.env.AGENT_PORTFOLIO_EXPOSE_TOTAL = "true";
    readLatestPortfolioSnapshot.mockResolvedValue({
      captured_at: "2026-09-01T00:00:00.000Z",
      snapshot: snapshot()
    });
    readAgentFxRate.mockResolvedValue({ rate: 31, status: "stale" });

    const response = await getAgentPortfolio(request("?include=total"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.totals.totalTwd).toBe(3100);
  });

  it("returns a ready-to-forward Traditional Chinese text brief", async () => {
    readLatestPortfolioSnapshot.mockResolvedValue({
      captured_at: "2026-09-01T00:00:00.000Z",
      snapshot: snapshot()
    });

    const response = await getAgentPortfolio(request("?format=text"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    expect(await response.text()).toBe("• Portfolio brief");
  });
});

function request(query = "") {
  return new Request(`https://portfolio.test/api/agent/portfolio${query}`);
}

function snapshot() {
  return {
    generatedAt: "2026-09-01T00:00:00.000Z",
    netWorthUsd: 100,
    liveValueUsd: 100,
    previewValueUsd: 0,
    groups: { exchangesUsd: 100, walletsUsd: 0, banksUsd: 0 },
    sources: [],
    holdings: [],
    wallets: [],
    connectedSourceCount: 1,
    expectedSourceCount: 1,
    isPartial: false,
    errors: []
  };
}
