import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const authorizeAgentFinance = vi.fn();
const readAgentFxRate = vi.fn();
const getExpenseLedgerProvider = vi.fn();
const readConfiguredExpenseLedger = vi.fn();
const readLatestPortfolioSnapshot = vi.fn();
const readPortfolioHistory = vi.fn();
const readPortfolioSyncMonitor = vi.fn();
const readPreviousCompletePortfolioSnapshot = vi.fn();
const buildAgentFinanceResponse = vi.fn(() => ({ schemaVersion: "2026-09-06", privacy: { authenticated: true } }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent-finance", () => ({ buildAgentFinanceResponse }));
vi.mock("@/lib/server/agent-finance-auth", () => ({ authorizeAgentFinance }));
vi.mock("@/lib/server/agent-fx-rate", () => ({ readAgentFxRate }));
vi.mock("@/lib/server/expense-ledger", () => ({ getExpenseLedgerProvider, readConfiguredExpenseLedger }));
vi.mock("@/lib/server/portfolio-snapshot-store", () => ({
  readLatestPortfolioSnapshot,
  readPortfolioHistory,
  readPortfolioSyncMonitor,
  readPreviousCompletePortfolioSnapshot
}));

let getFinance: typeof import("./route").GET;

beforeAll(async () => {
  ({ GET: getFinance } = await import("./route"));
});

beforeEach(() => {
  vi.clearAllMocks();
  authorizeAgentFinance.mockReturnValue("authorized");
  readLatestPortfolioSnapshot.mockResolvedValue({ captured_at: "2026-09-06T00:00:00.000Z", snapshot: { generatedAt: "2026-09-06T00:00:00.000Z" } });
  readPortfolioHistory.mockResolvedValue([]);
  readPreviousCompletePortfolioSnapshot.mockResolvedValue(null);
  readPortfolioSyncMonitor.mockResolvedValue(null);
  readAgentFxRate.mockResolvedValue({ rate: 32 });
  getExpenseLedgerProvider.mockReturnValue("supabase");
  readConfiguredExpenseLedger.mockResolvedValue({ records: [] });
});

describe("private finance API", () => {
  it("returns 503 before reading data when the bearer hash is not configured", async () => {
    authorizeAgentFinance.mockReturnValue("misconfigured");
    const response = await getFinance(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(readLatestPortfolioSnapshot).not.toHaveBeenCalled();
  });

  it("returns a bearer challenge for missing or invalid credentials", async () => {
    authorizeAgentFinance.mockReturnValue("unauthorized");
    const response = await getFinance(request());
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(readLatestPortfolioSnapshot).not.toHaveBeenCalled();
  });

  it("returns private no-store finance facts after authorization", async () => {
    const response = await getFinance(request("Bearer secret"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("private");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Vary")).toBe("Authorization");
    expect(readPortfolioHistory).toHaveBeenCalledWith(365, "daily");
    expect(buildAgentFinanceResponse).toHaveBeenCalledWith(expect.objectContaining({
      expenses: { source: "supabase", records: [] }
    }));
  });

  it("degrades only the expense section when the ledger read fails", async () => {
    readConfiguredExpenseLedger.mockRejectedValue(new Error("private provider failure"));
    const response = await getFinance(request("Bearer secret"));
    expect(response.status).toBe(200);
    expect(buildAgentFinanceResponse).toHaveBeenCalledWith(expect.objectContaining({
      expenses: { source: "supabase", records: null }
    }));
  });
});

function request(authorization?: string) {
  return new Request("https://portfolio.test/api/agent/finance", {
    headers: authorization ? { authorization } : undefined
  });
}
