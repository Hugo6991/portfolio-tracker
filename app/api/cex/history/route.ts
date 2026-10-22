import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo-mode";
import { demoCexHistory, demoHeaders } from "@/lib/server/demo-fixtures";
import { readCexHistory } from "@/lib/server/cex-snapshot-store";
import { privateNoStoreHeaders, requireViewerJson } from "@/lib/server/viewer-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = await requireViewerJson(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days")) || 30));
  const interval = Math.max(15, Number(url.searchParams.get("interval")) || 15);
  if (isDemoMode()) return NextResponse.json(demoCexHistory(days, interval), { headers: demoHeaders });
  try {
    return NextResponse.json({ points: await readCexHistory(days, interval) }, { headers: privateNoStoreHeaders });
  } catch {
    return NextResponse.json({ error: "CEX history is unavailable" }, { status: 503, headers: privateNoStoreHeaders });
  }
}
