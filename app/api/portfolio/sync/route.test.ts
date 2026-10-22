import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const authorizePortfolioAdmin = vi.fn();
const runCexSync = vi.fn();
const runPortfolioCurrentSync = vi.fn();

vi.mock("@/lib/server/portfolio-admin-auth", () => ({ authorizePortfolioAdmin }));
vi.mock("@/app/api/cron/cex/route", () => ({ GET: runCexSync }));
vi.mock("@/app/api/cron/portfolio-value/route", () => ({ GET: runPortfolioCurrentSync }));

let syncPortfolio: typeof import("./route").POST;

beforeAll(async () => {
  ({ POST: syncPortfolio } = await import("./route"));
});

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-secret");
  authorizePortfolioAdmin.mockReset();
  runCexSync.mockReset();
  runPortfolioCurrentSync.mockReset();
  authorizePortfolioAdmin.mockReturnValue("authorized");
  runCexSync.mockResolvedValue(Response.json({ ok: true, status: "success" }));
  runPortfolioCurrentSync.mockResolvedValue(Response.json({ ok: true, status: "success" }));
});

describe("manual portfolio sync API", () => {
  it("rejects a wrong password before invoking the provider sync", async () => {
    authorizePortfolioAdmin.mockReturnValue("unauthorized");

    const response = await syncPortfolio(request({ action: "retry", password: "wrong" }));

    expect(response.status).toBe(401);
    expect(runCexSync).not.toHaveBeenCalled();
    expect(runPortfolioCurrentSync).not.toHaveBeenCalled();
  });

  it("fails closed when portfolio administration is not configured", async () => {
    authorizePortfolioAdmin.mockReturnValue("misconfigured");

    const response = await syncPortfolio(request({ action: "retry", password: "secret" }));

    expect(response.status).toBe(503);
    expect(runCexSync).not.toHaveBeenCalled();
    expect(runPortfolioCurrentSync).not.toHaveBeenCalled();
  });

  it("refreshes CEX through the protected cron implementation", async () => {
    const response = await syncPortfolio(request({ action: "refresh-cex", password: "secret" }));

    expect(response.status).toBe(200);
    const internal = runCexSync.mock.calls[0][0] as Request;
    expect(internal.url).toContain("/api/cron/cex?manual=1");
    expect(internal.headers.get("authorization")).toBe("Bearer cron-secret");
    expect(runPortfolioCurrentSync).not.toHaveBeenCalled();
  });

  it("runs an immediate retry through the protected cron implementation", async () => {
    const response = await syncPortfolio(request({ action: "retry", password: "secret" }));

    expect(response.status).toBe(200);
    const internal = runPortfolioCurrentSync.mock.calls[0][0] as Request;
    expect(internal.url).toContain("manual=1");
    expect(internal.headers.get("authorization")).toBe("Bearer cron-secret");
  });

  it("passes through a conflict when a collapse is not eligible for acceptance", async () => {
    runPortfolioCurrentSync.mockResolvedValue(Response.json(
      { ok: true, status: "skipped_degraded" },
      { status: 409 }
    ));

    const response = await syncPortfolio(request({ action: "accept-collapse", password: "secret" }));

    expect(response.status).toBe(409);
    const internal = runPortfolioCurrentSync.mock.calls[0][0] as Request;
    expect(internal.url).toContain("acceptCollapse=1");
  });
});

function request(body: Record<string, unknown>) {
  return new Request("https://portfolio.test/api/portfolio/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
