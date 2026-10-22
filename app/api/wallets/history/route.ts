import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo-mode";
import { demoHeaders, demoWalletHistory } from "@/lib/server/demo-fixtures";
import { publicReadHeaders } from "@/lib/server/public-read-headers";
import { readWalletHistory } from "@/lib/server/portfolio-snapshot-store";
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
  if (isDemoMode()) return NextResponse.json(demoWalletHistory(days), { headers: demoHeaders });

  try {
    const history = await readWalletHistory(days);
    const wallets = history.wallets.map((wallet) => ({
      walletId: wallet.walletId,
      points: wallet.points.map((point) => ({
        date: point.date,
        capturedAt: point.capturedAt,
        isTracked: point.isTracked,
        valueUsd: point.valueUsd,
        quality: point.quality
      }))
    }));
    return NextResponse.json(
      { configured: true, overview: history.overview, wallets },
      { headers: publicReadHeaders(startedAt, 300) }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Wallet history is unavailable";
    return NextResponse.json({ error: message.slice(0, 160) }, { status: 503, headers: privateNoStoreHeaders });
  }
}
