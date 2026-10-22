import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateAssistantAnswer: vi.fn(),
  readLatestPortfolioReport: vi.fn(),
  readPortfolioHistory: vi.fn(),
  requireSameOrigin: vi.fn(),
  requireViewerJson: vi.fn()
}));

vi.mock("@/lib/server/portfolio-assistant", () => ({
  generateAssistantAnswer: mocks.generateAssistantAnswer
}));
vi.mock("@/lib/server/portfolio-snapshot-store", () => ({
  readLatestPortfolioReport: mocks.readLatestPortfolioReport,
  readPortfolioHistory: mocks.readPortfolioHistory
}));
vi.mock("@/lib/server/viewer-auth", () => ({
  privateNoStoreHeaders: {
    "Cache-Control": "private, no-store, max-age=0",
    "Vercel-CDN-Cache-Control": "no-store"
  },
  requireSameOrigin: mocks.requireSameOrigin,
  requireViewerJson: mocks.requireViewerJson
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireViewerJson.mockResolvedValue(null);
  mocks.requireSameOrigin.mockReturnValue(true);
  mocks.readPortfolioHistory.mockResolvedValue([]);
  mocks.readLatestPortfolioReport.mockResolvedValue(null);
  mocks.generateAssistantAnswer.mockResolvedValue({ answer: "Portfolio remains within its saved allocation" });
});

describe("portfolio assistant API", () => {
  it("rejects an anonymous request before reading portfolio storage", async () => {
    mocks.requireViewerJson.mockResolvedValueOnce(Response.json({ error: "Viewer access required" }, { status: 401 }));

    const response = await POST(request("What changed?"));

    expect(response.status).toBe(401);
    expect(mocks.readPortfolioHistory).not.toHaveBeenCalled();
    expect(mocks.readLatestPortfolioReport).not.toHaveBeenCalled();
    expect(mocks.generateAssistantAnswer).not.toHaveBeenCalled();
  });

  it("answers an authorized same origin request", async () => {
    const response = await POST(request("What changed?"));

    expect(response.status).toBe(200);
    expect(mocks.readPortfolioHistory).toHaveBeenCalledWith(365);
    expect(mocks.generateAssistantAnswer).toHaveBeenCalledWith("What changed?", [], null);
    await expect(response.json()).resolves.toEqual({
      answer: "Portfolio remains within its saved allocation"
    });
  });

  it("rejects a cross origin request before reading portfolio storage", async () => {
    mocks.requireSameOrigin.mockReturnValue(false);

    const response = await POST(request("What changed?", "https://attacker.test"));

    expect(response.status).toBe(403);
    expect(mocks.readPortfolioHistory).not.toHaveBeenCalled();
    expect(mocks.generateAssistantAnswer).not.toHaveBeenCalled();
  });
});

function request(question: string, origin = "https://portfolio.test") {
  return new Request("https://portfolio.test/api/portfolio/assistant", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin
    },
    body: JSON.stringify({ question })
  });
}
