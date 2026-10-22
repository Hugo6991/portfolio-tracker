import "server-only";

import type { PortfolioHistoryPoint, PortfolioReport } from "../portfolio-history";
import type { PortfolioAssistantAnswer } from "../portfolio-assistant";
import { answerPortfolioQuestion, buildAssistantContext } from "../portfolio-assistant";

export async function generateAssistantAnswer(
  question: string,
  points: PortfolioHistoryPoint[],
  latestReport: PortfolioReport | null
): Promise<PortfolioAssistantAnswer> {
  const fallback = answerPortfolioQuestion(question, points, latestReport);
  const llm = getAssistantLlmConfig();
  if (!llm) return fallback;

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
        max_tokens: 260,
        messages: [
          {
            role: "system",
            content: "You are a private personal asset tracking assistant. Answer only from the supplied percentage-only portfolio context. Be concise, factual, calm, mention data limitations, never infer absolute wealth, and never give trading instructions."
          },
          {
            role: "user",
            content: JSON.stringify(buildPrivacySafeAssistantPrompt(question, points, latestReport))
          }
        ]
      }),
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(`Assistant LLM failed with HTTP ${response.status}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const answer = body.choices?.[0]?.message?.content?.trim();
    if (!answer) throw new Error("Assistant LLM returned no answer");
    return { ...fallback, answer: answer.slice(0, 1200), generatedBy: "llm", model: llm.model };
  } catch {
    return fallback;
  }
}

function buildPrivacySafeAssistantPrompt(
  question: string,
  points: PortfolioHistoryPoint[],
  latestReport: PortfolioReport | null
) {
  const context = buildAssistantContext(points, latestReport);
  const latest = context.latest;
  const total = latest?.netWorthUsd ?? 0;

  return {
    question,
    availableDays: context.completePointCount,
    latest: latest ? {
      date: latest.date,
      changePercent: roundOrNull(latest.deltaPercent),
      allocationPercent: {
        exchanges: percentOf(latest.exchangesUsd, total),
        wallets: percentOf(latest.walletsUsd, total),
        banks: percentOf(latest.banksUsd, total)
      },
      liveSources: latest.sourceCount,
      partial: context.latestObservedIsPartial
    } : null,
    periodPercent: roundOrNull(context.periodPercent),
    attentionItems: context.latestReport?.alerts.slice(0, 3) ?? []
  };
}

function getAssistantLlmConfig() {
  if (process.env.PUBLIC_ASSISTANT_LLM_ENABLED !== "true") return null;
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

function roundOrNull(value: number | null) {
  return value === null ? null : Math.round(value * 100) / 100;
}

function percentOf(value: number, total: number) {
  return total === 0 ? 0 : Math.round((value / total) * 10_000) / 100;
}
