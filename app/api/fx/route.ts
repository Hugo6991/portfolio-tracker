import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo-mode";
import { demoFx, demoHeaders } from "@/lib/server/demo-fixtures";
import { fallbackFxRate, type FxRateSnapshot } from "@/lib/fx";
import { privateNoStoreHeaders, requireViewerJson } from "@/lib/server/viewer-auth";

export const dynamic = "force-dynamic";

let cached: FxRateSnapshot | null = null;

export async function GET(request: Request) {
  const denied = await requireViewerJson(request);
  if (denied) return denied;
  if (isDemoMode()) return NextResponse.json(demoFx(), { headers: demoHeaders });
  try {
    const response = await fetch("https://open.er-api.com/v6/latest/USD", {
      next: { revalidate: 3600 }
    });

    if (!response.ok) throw new Error(`ExchangeRate API responded with ${response.status}`);

    const payload = (await response.json()) as {
      result?: string;
      time_last_update_utc?: string;
      rates?: { TWD?: number; CNY?: number };
    };
    const rate = payload.rates?.TWD;
    const cnyPerUsd = payload.rates?.CNY;
    if (payload.result !== "success" || !rate || !cnyPerUsd) throw new Error("FX response did not include TWD and CNY");

    cached = {
      base: "USD",
      quote: "TWD",
      rate,
      cnyPerUsd,
      fetchedAt: payload.time_last_update_utc ?? new Date().toISOString(),
      source: "ExchangeRate API",
      status: "updated_today"
    };

    return NextResponse.json(cached, { headers: privateNoStoreHeaders });
  } catch (error) {
    if (cached) {
      return NextResponse.json(
        { ...cached, status: "cached" satisfies FxRateSnapshot["status"] },
        { headers: privateNoStoreHeaders }
      );
    }

    return NextResponse.json(
      {
        ...fallbackFxRate,
        status: "stale" satisfies FxRateSnapshot["status"],
        error: error instanceof Error ? error.message : "FX rate unavailable"
      },
      { headers: privateNoStoreHeaders }
    );
  }
}
