import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PortfolioHistoryPoint } from "../portfolio-history";

vi.mock("server-only", () => ({}));

let generatePortfolioReport: typeof import("./portfolio-report").generatePortfolioReport;

const current: PortfolioHistoryPoint = {
  date: "2026-08-12",
  capturedAt: "2026-08-12T01:15:00Z",
  netWorthUsd: 102,
  exchangesUsd: 62,
  walletsUsd: 40,
  banksUsd: 0,
  sourceCount: 4,
  isPartial: false,
  deltaUsd: 2,
  deltaPercent: 2
};

const previous: PortfolioHistoryPoint = {
  ...current,
  date: "2026-08-11",
  capturedAt: "2026-08-11T01:15:00Z",
  netWorthUsd: 100,
  deltaUsd: null,
  deltaPercent: null
};

beforeAll(async () => {
  ({ generatePortfolioReport } = await import("./portfolio-report"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;
  delete process.env.LLM_REPORT_API_KEY;
  delete process.env.LLM_REPORT_API_URL;
  delete process.env.LLM_REPORT_MODEL;
  delete process.env.LLM_DAILY_REPORT_ENABLED;
});

describe("portfolio report generation", () => {
  it("uses Vercel AI Gateway with OIDC when no provider key is configured", async () => {
    process.env.LLM_DAILY_REPORT_ENABLED = "true";
    process.env.VERCEL_OIDC_TOKEN = "test-oidc-token";
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const headers = init?.headers as Record<string, string> | undefined;
      expect(String(url)).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
      expect(headers?.Authorization).toBe("Bearer test-oidc-token");
      expect(body.model).toBe("openai/gpt-5.4-mini");
      expect(body.response_format.type).toBe("json_schema");
      const prompt = JSON.parse(body.messages[1].content);
      expect(prompt).toEqual({
        date: "2026-08-12",
        changePercent: 2,
        allocationPercent: { exchanges: 60.78, wallets: 39.22, banks: 0 },
        liveSources: 4,
        partial: false,
        ruleAlerts: []
      });
      expect(body.messages[1].content).not.toContain("102");
      expect(body.messages[1].content).not.toContain("100");
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          summary: "Portfolio increased modestly today.",
          alerts: []
        }) } }]
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const report = await generatePortfolioReport(current, previous);

    expect(report.generator).toBe("llm");
    expect(report.model).toBe("openai/gpt-5.4-mini");
    expect(report.summary).toBe("Portfolio increased modestly today.");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("never sends absolute portfolio amounts in the LLM payload", async () => {
    process.env.LLM_DAILY_REPORT_ENABLED = "true";
    process.env.VERCEL_OIDC_TOKEN = "test-oidc-token";
    const sensitiveCurrent = {
      ...current,
      netWorthUsd: 987_654.32,
      exchangesUsd: 592_592.592,
      walletsUsd: 296_296.296,
      banksUsd: 98_765.432
    };
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const serialized = String(init?.body);
      expect(serialized).not.toContain("987654");
      expect(serialized).not.toContain("592592");
      expect(serialized).not.toContain("296296");
      expect(serialized).not.toContain("98765");
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ summary: "Stable allocation.", alerts: [] }) } }]
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const report = await generatePortfolioReport(sensitiveCurrent, previous);

    expect(report.generator).toBe("llm");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back to a deterministic report when the LLM request fails", async () => {
    process.env.LLM_DAILY_REPORT_ENABLED = "true";
    process.env.VERCEL_OIDC_TOKEN = "test-oidc-token";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));

    const report = await generatePortfolioReport(current, previous);

    expect(report.generator).toBe("rules");
    expect(report.model).toBeNull();
    expect(report.summary).toContain("2.00%");
  });

  it("does not send financial data without an explicit production opt-in", async () => {
    process.env.VERCEL_OIDC_TOKEN = "test-oidc-token";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const report = await generatePortfolioReport(current, previous);

    expect(report.generator).toBe("rules");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
