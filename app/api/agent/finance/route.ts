import { NextResponse } from "next/server";
import { buildAgentFinanceResponse } from "@/lib/agent-finance";
import { authorizeAgentFinance } from "@/lib/server/agent-finance-auth";
import { readAgentFxRate } from "@/lib/server/agent-fx-rate";
import {
  getExpenseLedgerProvider,
  readConfiguredExpenseLedger
} from "@/lib/server/expense-ledger";
import {
  readLatestPortfolioSnapshot,
  readPortfolioHistory,
  readPortfolioSyncMonitor,
  readPreviousCompletePortfolioSnapshot
} from "@/lib/server/portfolio-snapshot-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Vary: "Authorization"
};

export async function GET(request: Request) {
  const auth = authorizeAgentFinance(request.headers.get("authorization"));
  if (auth === "misconfigured") {
    return NextResponse.json(
      { error: "Private finance API is not configured." },
      { status: 503, headers: privateHeaders }
    );
  }
  if (auth !== "authorized") {
    return NextResponse.json(
      { error: "Unauthorized" },
      {
        status: 401,
        headers: { ...privateHeaders, "WWW-Authenticate": "Bearer" }
      }
    );
  }

  try {
    const cached = await readLatestPortfolioSnapshot();
    if (!cached) {
      return NextResponse.json(
        { error: "Portfolio data is not ready yet." },
        { status: 503, headers: { ...privateHeaders, "Retry-After": "30" } }
      );
    }

    const [history, previous, sync, fx, expenses] = await Promise.all([
      readPortfolioHistory(365, "daily"),
      readPreviousCompletePortfolioSnapshot(cached.snapshot),
      readPortfolioSyncMonitor().catch(() => null),
      readAgentFxRate(),
      readExpenseFacts()
    ]);
    const response = buildAgentFinanceResponse({
      snapshot: cached.snapshot,
      previousSnapshot: previous?.snapshot ?? null,
      history,
      capturedAt: cached.captured_at,
      sync,
      fx,
      expenses
    });
    return NextResponse.json(response, { headers: privateHeaders });
  } catch {
    return NextResponse.json(
      { error: "Private finance data is temporarily unavailable." },
      { status: 503, headers: { ...privateHeaders, "Retry-After": "30" } }
    );
  }
}

async function readExpenseFacts() {
  const source = getExpenseLedgerProvider();
  if (!source) return { source: null, records: null } as const;
  try {
    const ledger = await readConfiguredExpenseLedger();
    return { source, records: ledger.records };
  } catch {
    return { source, records: null };
  }
}
