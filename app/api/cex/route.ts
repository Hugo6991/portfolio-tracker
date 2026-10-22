import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo-mode";
import { demoCexResponse, demoHeaders } from "@/lib/server/demo-fixtures";
import {
  buildCexPublicResponse,
  CEX_EXCHANGES,
  createUnavailableCexSnapshot
} from "@/lib/cex";
import { readLatestCexSnapshots } from "@/lib/server/cex-snapshot-store";
import { privateNoStoreHeaders, requireViewerJson } from "@/lib/server/viewer-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = await requireViewerJson(request);
  if (denied) return denied;
  if (isDemoMode()) return NextResponse.json(demoCexResponse(), { headers: demoHeaders });
  try {
    const stored = await readLatestCexSnapshots();
    if (Object.keys(stored).length === 0) {
      return NextResponse.json(
        { error: "No scheduled CEX snapshot is available yet" },
        { status: 503, headers: { ...privateNoStoreHeaders, "Retry-After": "30" } }
      );
    }
    const sources = CEX_EXCHANGES.map(
      (exchange) => stored[exchange] || createUnavailableCexSnapshot(exchange)
    );
    const response = buildCexPublicResponse(sources);
    return NextResponse.json(response, {
      headers: privateNoStoreHeaders
    });
  } catch {
    return NextResponse.json({ error: "CEX data is unavailable" }, { status: 503, headers: privateNoStoreHeaders });
  }
}
