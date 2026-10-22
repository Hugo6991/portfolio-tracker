"use client";

import { defaultPortfolioHistoryUrl, useApiQuery } from "@/lib/client/api-query";

import { FormEvent, useState } from "react";
import { Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { PortfolioAssistantAnswer } from "@/lib/portfolio-assistant";
import type { PortfolioHistoryResponse } from "@/lib/portfolio-history";

const prompts = ["What changed?", "Any alerts?", "Trend"] as const;

export function PortfolioAssistant() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<PortfolioAssistantAnswer | null>(null);
  const { data: history, loading: summaryLoading, error: summaryError } = useApiQuery<PortfolioHistoryResponse>(defaultPortfolioHistoryUrl);
  const latestSummary = history?.latestReport?.summary ?? null;
  const [askError, setAskError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function ask(prompt: string) {
    const trimmed = prompt.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setAskError(null);
    try {
      const response = await fetch("/api/portfolio/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed })
      });
      const body = await response.json() as PortfolioAssistantAnswer & { error?: string };
      if (!response.ok) throw new Error(body.error || "Assistant unavailable");
      setAnswer(body);
      setQuestion("");
    } catch {
      setAskError("AI insights are unavailable right now.");
    } finally {
      setLoading(false);
    }
  }

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(question);
  }

  return (
    <Card className="h-full overflow-hidden">
      <CardHeader className="p-5 pb-3 sm:p-6 sm:pb-3">
        <CardTitle>AI insights</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 p-5 pt-0 sm:p-6 sm:pt-0">
        <div
          className="min-h-24"
          aria-busy={summaryLoading || loading}
          aria-live="polite"
        >
          {loading ? (
            <div className="space-y-2" role="status" aria-label="Generating portfolio answer">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
            </div>
          ) : answer ? (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <Badge
                  variant={answer.generatedBy === "llm" ? "success" : "muted"}
                  className={answer.generatedBy === "llm" ? "text-emerald-700 dark:text-emerald-300" : undefined}
                >
                  {answer.generatedBy === "llm" ? "AI" : "Data"}
                </Badge>
              </div>
              <p className="text-sm leading-6">{answer.answer}</p>
            </div>
          ) : summaryLoading ? (
            <div className="space-y-2" role="status" aria-label="Loading latest portfolio brief">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
            </div>
          ) : latestSummary ? (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Latest brief</p>
              <p className="mt-2 text-sm leading-6">{latestSummary}</p>
            </div>
          ) : (
            <p className="text-sm leading-6 text-muted-foreground" role={summaryError ? "status" : undefined}>
              {summaryError ? "Latest brief is unavailable. Ask again when history is connected." : "Ask what changed or how your portfolio is trending."}
            </p>
          )}
        </div>

        <fieldset className="flex gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible" aria-label="Suggested questions">
          {prompts.map((prompt) => (
            <Button
              key={prompt}
              type="button"
              size="sm"
              variant="outline"
              className="shrink-0"
              disabled={loading}
              onClick={() => void ask(prompt)}
            >
              {prompt}
            </Button>
          ))}
        </fieldset>

        <form onSubmit={submitQuestion} className="flex gap-2">
          <label htmlFor="portfolio-assistant-question" className="sr-only">Ask about your portfolio</label>
          <Input
            id="portfolio-assistant-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask about your portfolio…"
            maxLength={500}
            disabled={loading}
          />
          <Button type="submit" size="icon" disabled={!question.trim() || loading} aria-label="Ask portfolio assistant">
            <Send aria-hidden="true" />
          </Button>
        </form>
        {askError ? <p className="text-sm text-red-700 dark:text-red-300" role="alert">{askError}</p> : null}
      </CardContent>
    </Card>
  );
}
