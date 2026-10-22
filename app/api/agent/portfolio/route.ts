import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo-mode";
import { demoAgentBrief } from "@/lib/server/demo-fixtures";
import { buildAgentPortfolioResponse } from "@/lib/agent-portfolio";
import { readAgentFxRate } from "@/lib/server/agent-fx-rate";
import { consumeDurableRateLimit, DurableRateLimitError } from "@/lib/server/request-rate-limit";
import {
  readLatestPortfolioSnapshot,
  readLatestPortfolioSyncSummary,
  readPortfolioHistory
} from "@/lib/server/portfolio-snapshot-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (isDemoMode()) return demoAgentBrief(url.searchParams.get("format") === "text");
  const includeTotals = url.searchParams.get("include") === "total";
  if (includeTotals && process.env.AGENT_PORTFOLIO_EXPOSE_TOTAL !== "true") {
    return NextResponse.json(
      { error: "Aggregated portfolio totals are disabled." },
      { status: 403, headers: noStoreHeaders() }
    );
  }

  try {
    const limit = await consumeDurableRateLimit(request, {
      scope: "agent-portfolio",
      windowSeconds: 60,
      maxAttempts: 120
    });
    if (limit.rateLimited) {
      return NextResponse.json(
        { error: "Too many requests." },
        {
          status: 429,
          headers: { ...noStoreHeaders(), "Retry-After": String(limit.retryAfterSeconds) }
        }
      );
    }
  } catch (error) {
    if (!(error instanceof DurableRateLimitError)) throw error;
    return NextResponse.json(
      { error: "Agent portfolio access is temporarily unavailable." },
      { status: 503, headers: { ...noStoreHeaders(), "Retry-After": "30" } }
    );
  }

  try {
    const [cached, history, latestSync, fx] = await Promise.all([
      readLatestPortfolioSnapshot(),
      readPortfolioHistory(365, "daily"),
      includeTotals ? readLatestPortfolioSyncSummary().catch(() => null) : Promise.resolve(null),
      includeTotals ? readAgentFxRate() : Promise.resolve(null)
    ]);
    if (!cached) {
      return NextResponse.json(
        { error: "Portfolio data is not ready yet." },
        {
          status: 503,
          headers: {
            ...(includeTotals ? noStoreHeaders() : publicHeaders()),
            "Retry-After": "30"
          }
        }
      );
    }
    const response = buildAgentPortfolioResponse({
      snapshot: cached.snapshot,
      history,
      capturedAt: cached.captured_at,
      includeTotals,
      fx,
      latestSync
    });
    const headers = includeTotals ? noStoreHeaders() : publicHeaders();
    if (url.searchParams.get("format") === "text") {
      return new NextResponse(response.brief.text, {
        headers: {
          ...headers,
          "Content-Type": "text/plain; charset=utf-8"
        }
      });
    }
    return NextResponse.json(response, { headers });
  } catch {
    return NextResponse.json(
      { error: "Agent portfolio data is temporarily unavailable." },
      {
        status: 503,
        headers: {
          ...(includeTotals ? noStoreHeaders() : publicHeaders()),
          "Retry-After": "30"
        }
      }
    );
  }
}

function publicHeaders() {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    "Vercel-CDN-Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow, noarchive"
  };
}

function noStoreHeaders() {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    "Vercel-CDN-Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow, noarchive"
  };
}
