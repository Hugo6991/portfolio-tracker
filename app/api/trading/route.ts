import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo-mode";
import { demoHeaders, demoTrading } from "@/lib/server/demo-fixtures";
import type { TradingDashboardSnapshot } from "@/lib/trading-dashboard";
import { privateNoStoreHeaders, requireViewerJson } from "@/lib/server/viewer-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const defaultWorkerBaseUrl = "https://shadow-worker-production.up.railway.app";

export async function GET(request: Request) {
  const denied = await requireViewerJson(request);
  if (denied) return denied;
  if (isDemoMode()) return NextResponse.json(demoTrading(), { headers: demoHeaders });
  try {
    const baseUrl = (process.env.TRADING_WORKER_BASE_URL || defaultWorkerBaseUrl).replace(/\/$/, "");
    const upstream = await fetch(`${baseUrl}/dashboard/v1/snapshot`, {
      headers: { accept: "application/json" },
      next: { revalidate: 15 }
    });
    if (!upstream.ok) throw new Error("upstream unavailable");
    const body = await upstream.json() as unknown;
    if (!isSnapshot(body)) throw new Error("upstream schema mismatch");
    return NextResponse.json(body, {
      headers: {
        ...privateNoStoreHeaders,
        "X-Trading-Dashboard-Schema": body.schemaVersion
      }
    });
  } catch {
    return NextResponse.json(
      { error: "Trading data is temporarily unavailable." },
      { status: 503, headers: { ...privateNoStoreHeaders, "Retry-After": "30" } }
    );
  }
}

function isSnapshot(value: unknown): value is TradingDashboardSnapshot {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TradingDashboardSnapshot>;
  return item.schemaVersion === "1.1" && item.privacy?.publicReadOnly === true && item.privacy.containsSecrets === false &&
    Array.isArray(item.trades) && Array.isArray(item.equityCurve) && Array.isArray(item.walletCandidates);
}
