import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo-mode";
import { demoAssetHistory, demoHeaders } from "@/lib/server/demo-fixtures";
import { publicReadHeaders } from "@/lib/server/public-read-headers";
import { readAssetHistory } from "@/lib/server/portfolio-snapshot-store";
import { privateNoStoreHeaders, requireViewerJson } from "@/lib/server/viewer-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = await requireViewerJson(request);
  if (denied) return denied;
  const startedAt = performance.now();
  const daysParam = new URL(request.url).searchParams.get("days");
  const requestedDays = daysParam === null ? Number.NaN : Number(daysParam);
  const days = Number.isFinite(requestedDays)
    ? Math.min(730, Math.max(7, Math.round(requestedDays)))
    : 365;
  if (isDemoMode()) return NextResponse.json(demoAssetHistory(days), { headers: demoHeaders });

  try {
    const points = await readAssetHistory(days);
    return NextResponse.json(
      { configured: true, points },
      { headers: publicReadHeaders(startedAt, 300) }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Asset history is unavailable";
    return NextResponse.json({ error: message.slice(0, 160) }, { status: 503, headers: privateNoStoreHeaders });
  }
}
