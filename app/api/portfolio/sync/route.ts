import { NextResponse } from "next/server";
import { GET as runCexSync } from "@/app/api/cron/cex/route";
import { GET as runPortfolioCurrentSync } from "@/app/api/cron/portfolio-value/route";
import { authorizePortfolioAdmin } from "@/lib/server/portfolio-admin-auth";
import {
  hasViewerRole,
  privateNoStoreHeaders,
  requireSameOrigin
} from "@/lib/server/viewer-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

type PortfolioSyncAction = "refresh-cex" | "retry" | "accept-collapse";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && !requireSameOrigin(request)) {
    return response({ error: "Request origin was not accepted" }, 403);
  }
  let body: { action?: unknown; password?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return response({ error: "Invalid request" }, 400);
  }

  const adminSession = origin ? await hasViewerRole(request, "admin") : false;
  const auth = authorizePortfolioAdmin(body.password);
  if (!adminSession && auth === "misconfigured") {
    return response({ error: "Portfolio administration is not configured" }, 503);
  }
  if (!adminSession && auth !== "authorized") return response({ error: "Unauthorized" }, 401);
  if (!isPortfolioSyncAction(body.action)) {
    return response({ error: "Unsupported sync action" }, 400);
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) return response({ error: "Portfolio sync is not configured" }, 503);
  const refreshesCex = body.action === "refresh-cex";
  const query = body.action === "accept-collapse" ? "acceptCollapse=1" : "manual=1";
  const path = refreshesCex ? "/api/cron/cex" : "/api/cron/portfolio-value";
  const handler = refreshesCex ? runCexSync : runPortfolioCurrentSync;
  const internal = await handler(new Request(
    `${new URL(request.url).origin}${path}?${query}`,
    { headers: { authorization: `Bearer ${secret}` } }
  ));
  const payload = await internal.text();
  return new NextResponse(payload, {
    status: internal.status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function isPortfolioSyncAction(value: unknown): value is PortfolioSyncAction {
  return value === "refresh-cex" || value === "retry" || value === "accept-collapse";
}

function response(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, {
    status,
    headers: privateNoStoreHeaders
  });
}
