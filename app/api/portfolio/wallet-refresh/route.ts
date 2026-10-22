import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { authorizePortfolioAdmin } from "@/lib/server/portfolio-admin-auth";
import { readPortfolioSourcePayloads } from "@/lib/server/portfolio-source-state";
import { claimPortfolioSync, finishPortfolioSync, readLatestPortfolioSnapshot, type PortfolioSyncClaim } from "@/lib/server/portfolio-snapshot-store";
import { applyWalletCapture, validateCapture, validateMovements, type WalletRefreshCapture } from "@/lib/server/targeted-wallet-refresh";
import { evaluatePortfolioSnapshot } from "@/lib/portfolio-snapshot-policy";
import type { PendingWalletMovement } from "@/lib/live-portfolio";
import { privateNoStoreHeaders, requireSameOrigin } from "@/lib/server/viewer-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
const response = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: privateNoStoreHeaders });

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && !requireSameOrigin(request)) {
    return response({ error: "Request origin was not accepted" }, 403);
  }
  let body: { password?: unknown; capture: WalletRefreshCapture; movements?: PendingWalletMovement[]; publish?: boolean };
  try {
    const text = await request.text();
    if (text.length > 1_000_000) return response({ error: "Capture too large" }, 413);
    body = JSON.parse(text);
    if (!body || typeof body !== "object") return response({ error: "Invalid request" }, 400);
  } catch { return response({ error: "Invalid request" }, 400); }
  const auth = authorizePortfolioAdmin(body.password);
  if (auth !== "authorized") return response({ error: auth === "misconfigured" ? "Administration unavailable" : "Unauthorized" }, auth === "misconfigured" ? 503 : 401);
  try {
    validateCapture(body.capture);
    if (body.movements !== undefined) validateMovements(body.movements);
    if (body.publish !== undefined && typeof body.publish !== "boolean") throw new Error("Invalid publication flag");
    if ((body.capture as WalletRefreshCapture & { incomplete?: boolean }).incomplete) throw new Error("Incomplete collection");
  } catch { return response({ error: "Invalid or incomplete capture" }, 400); }
  const startedAt = new Date().toISOString();
  const digest = createHash("sha256").update(JSON.stringify({ capture: body.capture, movements: body.movements ?? null })).digest("hex");
  let claim: PortfolioSyncClaim | null = null;
  let completionAttempted = false;
  const providerUsage = { debank: { scanAttempted: false, scanKind: "none", requestCount: 0, estimatedUnits: 0 } };
  try {
    if (body.publish) {
      claim = await claimPortfolioSync({ jobKey: `targeted-wallet:${digest}`, syncKind: "value", trigger: "manual", startedAt, leaseSeconds: 90 });
      if (!claim.claimed) return response({ status: claim.reason }, claim.reason === "already_running" ? 202 : 200);
      if (claim.runId === null || !claim.leaseToken) throw new Error("Missing lease");
    }
    const [current, stored] = await Promise.all([readLatestPortfolioSnapshot(), readPortfolioSourcePayloads()]);
    if (!current || Date.now() - Date.parse(current.captured_at) > 20 * 60_000) throw new Error("Wait for the scheduled portfolio refresh before publishing");
    const sourcePayloads = [...stored.values()].map(({ lastGoodAt: _lastGoodAt, ...payload }) => payload);
    // DeBank can be recovered completely from current wallet detail; some legacy
    // current syncs leave only its source summary in the source-state table.
    const missingSources = current.snapshot.sources.filter((source) => source.id !== "debank" && !stored.has(source.id));
    if (missingSources.length) throw new Error(`Structured source baseline unavailable: ${missingSources.map((s) => s.id).join(", ")}`);
    const { snapshot, debankPayload } = applyWalletCapture(current.snapshot, body.capture, sourcePayloads, body.movements);
    const quality = evaluatePortfolioSnapshot(snapshot, current.snapshot);
    if (!quality.accepted || quality.status !== "complete") throw new Error("Candidate failed portfolio quality checks");
    const wallet = snapshot.wallets.find((w) => w.address.toLowerCase() === body.capture.address.toLowerCase())!;
    const summary = {
      capturedAt: body.capture.capturedAt,
      tokenChains: Object.keys(body.capture.tokens), protocolChains: Object.keys(body.capture.protocols),
      walletValueBefore: current.snapshot.wallets.find((w) => w.id === wallet.id)!.valueUsd, walletValueAfter: wallet.valueUsd,
      netWorthDelta: snapshot.netWorthUsd - current.snapshot.netWorthUsd, pendingMovements: wallet.pendingMovements?.length ?? 0,
      collectionUnits: body.capture.usage.unitsBefore - body.capture.usage.unitsAfter, publicationUnits: 0
    };
    if (!body.publish) return response({ status: "reviewed", summary, baseline: current.snapshot, candidate: snapshot });
    completionAttempted = true;
    const finished = await finishPortfolioSync({
      runId: claim!.runId!, leaseToken: claim!.leaseToken!, completedAt: new Date().toISOString(), status: "success",
      durationMs: Date.now() - Date.parse(startedAt), snapshot, qualityStatus: "complete",
      publishCurrent: true, writeValue: false, writeFull: false, requireSourcePayloads: true,
      sourcePayloads: [...sourcePayloads.filter((p) => p.source.id !== "debank"), debankPayload],
      detail: { mode: "targeted-wallet", captureDigest: digest, providerUsage, captureUsage: body.capture.usage,
        tokenChains: summary.tokenChains, protocolChains: summary.protocolChains }
    });
    if (!finished) throw new Error("Publication lease expired");
    return response({ status: "published", summary, runId: claim!.runId });
  } catch (error) {
    if (claim?.claimed && claim.runId !== null && claim.leaseToken && !completionAttempted) {
      await finishPortfolioSync({
        runId: claim.runId, leaseToken: claim.leaseToken, completedAt: new Date().toISOString(), status: "failed",
        durationMs: Date.now() - Date.parse(startedAt), snapshot: null, qualityStatus: "rejected", publishCurrent: false,
        writeValue: false, writeFull: false, requireSourcePayloads: true, sourcePayloads: [], detail: { mode: "targeted-wallet", providerUsage }
      }).catch(() => undefined);
    }
    return response({ error: error instanceof Error ? error.message.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]") : "Refresh failed" }, 409);
  }
}
