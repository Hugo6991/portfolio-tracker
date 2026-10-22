import "server-only";

import type { PortfolioHistoryPoint, PortfolioReport } from "../portfolio-history";
import { buildRuleReport } from "../portfolio-history";

type ReportDraft = Pick<PortfolioReport, "summary" | "alerts" | "deltaUsd" | "deltaPercent">;

export async function generatePortfolioReport(
  current: PortfolioHistoryPoint,
  previous: PortfolioHistoryPoint | null
): Promise<Omit<PortfolioReport, "generatedAt">> {
  const fallback = buildRuleReport(current, previous);
  const llm = getLlmConfig();
  if (!llm) return toReport(current, fallback, "rules", null);

  try {
    const response = await fetch(llm.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${llm.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: llm.model,
        temperature: 0.1,
        max_tokens: 180,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "portfolio_daily_brief",
            strict: true,
            schema: {
              type: "object",
              properties: {
                summary: { type: "string" },
                alerts: {
                  type: "array",
                  items: { type: "string" },
                  maxItems: 3
                }
              },
              required: ["summary", "alerts"],
              additionalProperties: false
            }
          }
        },
        messages: [
          {
            role: "system",
            content: "You write private portfolio monitoring notes from percentage-only data. Be factual, calm, extremely concise, never infer absolute wealth, and never give trading advice. Return JSON only with summary (one sentence) and alerts (0-3 short strings)."
          },
          {
            role: "user",
            content: JSON.stringify(buildPrivacySafePrompt(current, fallback))
          }
        ]
      }),
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(`LLM report failed with HTTP ${response.status}`);
    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM report returned no content");
    const parsed = parseReportJson(content);
    return toReport(current, {
      ...fallback,
      summary: parsed.summary,
      alerts: parsed.alerts
    }, "llm", llm.model);
  } catch {
    return toReport(current, fallback, "rules", null);
  }
}

function buildPrivacySafePrompt(current: PortfolioHistoryPoint, fallback: ReportDraft) {
  const total = current.netWorthUsd;
  return {
    date: current.date,
    changePercent: fallback.deltaPercent === null ? null : round(fallback.deltaPercent),
    allocationPercent: {
      exchanges: percentOf(current.exchangesUsd, total),
      wallets: percentOf(current.walletsUsd, total),
      banks: percentOf(current.banksUsd, total)
    },
    liveSources: current.sourceCount,
    partial: current.isPartial,
    ruleAlerts: fallback.alerts
  };
}

function getLlmConfig() {
  if (process.env.LLM_DAILY_REPORT_ENABLED !== "true") return null;
  const customApiKey = process.env.LLM_REPORT_API_KEY;
  const gatewayToken = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;
  const apiKey = customApiKey || gatewayToken;
  if (!apiKey) return null;
  return {
    apiKey,
    model: process.env.LLM_REPORT_MODEL || "openai/gpt-5.4-mini",
    url: process.env.LLM_REPORT_API_URL || (
      customApiKey
        ? "https://api.openai.com/v1/chat/completions"
        : "https://ai-gateway.vercel.sh/v1/chat/completions"
    )
  };
}

function parseReportJson(content: string) {
  const json = content.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error("LLM report was not JSON");
  const parsed = JSON.parse(json) as { summary?: unknown; alerts?: unknown };
  if (typeof parsed.summary !== "string" || !parsed.summary.trim()) {
    throw new Error("LLM report summary is invalid");
  }
  const alerts = Array.isArray(parsed.alerts)
    ? parsed.alerts.filter((item): item is string => typeof item === "string").slice(0, 3)
    : [];
  return {
    summary: parsed.summary.trim().slice(0, 360),
    alerts: alerts.map((alert) => alert.trim().slice(0, 180)).filter(Boolean)
  };
}

function toReport(
  current: PortfolioHistoryPoint,
  draft: ReportDraft,
  generator: "rules" | "llm",
  model: string | null
): Omit<PortfolioReport, "generatedAt"> {
  return {
    date: current.date,
    currentUsd: current.netWorthUsd,
    ...draft,
    generator,
    model
  };
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function percentOf(value: number, total: number) {
  return total === 0 ? 0 : round((value / total) * 100);
}
