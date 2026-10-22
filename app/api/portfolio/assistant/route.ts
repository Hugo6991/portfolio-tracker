import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo-mode";
import { demoPortfolioHistory } from "@/lib/server/demo-fixtures";
import { answerPortfolioQuestion } from "@/lib/portfolio-assistant";
import { generateAssistantAnswer } from "@/lib/server/portfolio-assistant";
import { readLatestPortfolioReport, readPortfolioHistory } from "@/lib/server/portfolio-snapshot-store";
import { privateNoStoreHeaders, requireSameOrigin, requireViewerJson } from "@/lib/server/viewer-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = await requireViewerJson(request);
  if (denied) return denied;
  if (!requireSameOrigin(request)) {
    return NextResponse.json({ error: "Request origin was not accepted" }, { status: 403, headers: privateNoStoreHeaders });
  }
  let question = "";
  try {
    const body = await request.json();
    question = typeof body.question === "string" ? body.question.trim() : "";
  } catch {
    return NextResponse.json({ error: "Enter a question" }, { status: 400, headers: privateNoStoreHeaders });
  }
  if (!question || question.length > 500) {
    return NextResponse.json({ error: "Enter a question up to 500 characters" }, { status: 400, headers: privateNoStoreHeaders });
  }

  if (isDemoMode()) {
    const demo = demoPortfolioHistory("daily", 365);
    return NextResponse.json(answerPortfolioQuestion(question, demo.points, demo.latestReport), { headers: privateNoStoreHeaders });
  }
  try {
    const [points, latestReport] = await Promise.all([
      readPortfolioHistory(365),
      readLatestPortfolioReport()
    ]);
    const answer = await generateAssistantAnswer(question, points, latestReport);
    return NextResponse.json(answer, {
      headers: privateNoStoreHeaders
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Portfolio assistant is unavailable";
    return NextResponse.json({ error: message.slice(0, 160) }, { status: 503, headers: privateNoStoreHeaders });
  }
}
