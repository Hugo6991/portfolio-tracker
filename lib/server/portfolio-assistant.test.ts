import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PortfolioHistoryPoint, PortfolioReport } from "../portfolio-history";

vi.mock("server-only", () => ({}));

let generateAssistantAnswer: typeof import("./portfolio-assistant").generateAssistantAnswer;

const points: PortfolioHistoryPoint[] = [
  {
    date: "2026-08-11",
    capturedAt: "2026-08-11T01:15:00Z",
    netWorthUsd: 987_654.32,
    exchangesUsd: 592_592.592,
    walletsUsd: 296_296.296,
    banksUsd: 98_765.432,
    sourceCount: 5,
    isPartial: false,
    deltaUsd: null,
    deltaPercent: null
  },
  {
    date: "2026-08-12",
    capturedAt: "2026-08-12T01:15:00Z",
    netWorthUsd: 1_007_407.4064,
    exchangesUsd: 604_444.44384,
    walletsUsd: 302_222.22192,
    banksUsd: 100_740.74064,
    sourceCount: 5,
    isPartial: false,
    deltaUsd: 19_753.0864,
    deltaPercent: 2
  }
];

const report: PortfolioReport = {
  date: "2026-08-12",
  generatedAt: "2026-08-12T01:16:00Z",
  summary: "Estimated net worth increased 2.00% from the previous daily snapshot.",
  alerts: [],
  currentUsd: 1_007_407.4064,
  deltaUsd: 19_753.0864,
  deltaPercent: 2,
  generator: "rules",
  model: null
};

beforeAll(async () => {
  ({ generateAssistantAnswer } = await import("./portfolio-assistant"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;
  delete process.env.LLM_REPORT_API_KEY;
  delete process.env.LLM_REPORT_API_URL;
  delete process.env.LLM_REPORT_MODEL;
  delete process.env.PUBLIC_ASSISTANT_LLM_ENABLED;
});

describe("portfolio assistant generation", () => {
  it("sends only percentage-based portfolio context to the LLM", async () => {
    process.env.PUBLIC_ASSISTANT_LLM_ENABLED = "true";
    process.env.VERCEL_OIDC_TOKEN = "test-oidc-token";
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const serialized = String(init?.body);
      expect(serialized).not.toContain("987654");
      expect(serialized).not.toContain("1007407");
      expect(serialized).not.toContain("592592");
      expect(serialized).not.toContain("302222");

      const body = JSON.parse(serialized);
      expect(JSON.parse(body.messages[1].content)).toEqual({
        question: "Show the trend",
        availableDays: 2,
        latest: {
          date: "2026-08-12",
          changePercent: 2,
          allocationPercent: { exchanges: 60, wallets: 30, banks: 10 },
          liveSources: 5,
          partial: false
        },
        periodPercent: 2,
        attentionItems: []
      });

      return new Response(JSON.stringify({
        choices: [{ message: { content: "The available history increased 2%." } }]
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const answer = await generateAssistantAnswer("Show the trend", points, report);

    expect(answer.generatedBy).toBe("llm");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back to the deterministic answer when the LLM fails", async () => {
    process.env.PUBLIC_ASSISTANT_LLM_ENABLED = "true";
    process.env.VERCEL_OIDC_TOKEN = "test-oidc-token";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));

    const answer = await generateAssistantAnswer("Show the trend", points, report);

    expect(answer.generatedBy).toBe("rules");
    expect(answer.answer).toContain("2.00%");
  });

  it("does not call an LLM unless explicitly enabled", async () => {
    process.env.VERCEL_OIDC_TOKEN = "test-oidc-token";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const answer = await generateAssistantAnswer("Show the trend", points, report);

    expect(answer.generatedBy).toBe("rules");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
