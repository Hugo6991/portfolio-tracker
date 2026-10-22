import { randomUUID } from 'node:crypto';
import { isDemoMode } from "@/lib/demo-mode";
import { demoExpenseLedger, demoHeaders } from "@/lib/server/demo-fixtures";
import { NextRequest, NextResponse } from 'next/server';
import { isNormalizedExpense } from '@/lib/expense-records';
import { expenseReconciliationCsv, isExpenseBatch, receiptSummary, type ExpenseBatch } from '@/lib/expense-reconciliation';
import { getExpenseLedgerProvider, readConfiguredExpenseLedger } from '@/lib/server/expense-ledger';
import { reconcileExpenseBatch, readExpenseBatchReceipt } from '@/lib/server/supabase-expense-ledger';
import { authorizePortfolioAdmin } from '@/lib/server/portfolio-admin-auth';
import {
  hasViewerRole,
  privateNoStoreHeaders,
  requireSameOrigin,
  requireViewerJson
} from '@/lib/server/viewer-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const noStore = privateNoStoreHeaders;

async function publisherAuth(request: NextRequest, requireOrigin: boolean) {
  const auth = authorizePortfolioAdmin(request.headers.get('x-portfolio-password'));
  if (auth === 'authorized') {
    const origin = request.headers.get('origin');
    if (origin && !requireSameOrigin(request)) {
      return NextResponse.json({ error: 'Request origin was not accepted' }, { status: 403, headers: noStore });
    }
    return null;
  }
  if (!await hasViewerRole(request, 'admin')) {
    return NextResponse.json(
      { error: auth === 'misconfigured' ? 'Publisher access is not configured' : 'Owner access required' },
      { status: auth === 'misconfigured' ? 503 : 401, headers: noStore }
    );
  }
  if (requireOrigin && !requireSameOrigin(request)) {
    return NextResponse.json({ error: 'Request origin was not accepted' }, { status: 403, headers: noStore });
  }
  return null;
}

async function readerAuth(request: NextRequest) {
  if (authorizePortfolioAdmin(request.headers.get('x-portfolio-password')) === 'authorized') {
    const origin = request.headers.get('origin');
    if (origin && !requireSameOrigin(request)) {
      return NextResponse.json({ error: 'Request origin was not accepted' }, { status: 403, headers: noStore });
    }
    return null;
  }
  return requireViewerJson(request);
}

export async function GET(request: NextRequest) {
  if (isDemoMode()) return NextResponse.json(demoExpenseLedger(), { headers: demoHeaders });
  const batchId = request.nextUrl.searchParams.get('batchId');
  const exportCsv = request.nextUrl.searchParams.get('format') === 'reconciliation';
  if (batchId || exportCsv) {
    const denied = await publisherAuth(request, false);
    if (denied) return denied;
  } else {
    const denied = await readerAuth(request);
    if (denied) return denied;
  }
  const provider = getExpenseLedgerProvider();
  if (!provider) return NextResponse.json(
    { configured: false, storage: 'device', records: [], deletedIds: [], eventCount: 0 },
    { headers: noStore }
  );
  try {
    if (batchId) {
      const receipt = await readExpenseBatchReceipt(batchId);
      return NextResponse.json(receipt ? { receipt } : { error: 'Batch not found' }, { status: receipt ? 200 : 404, headers: noStore });
    }
    const snapshot = await readConfiguredExpenseLedger();
    if (exportCsv) return new NextResponse(expenseReconciliationCsv(snapshot.records), {
      headers: { ...noStore, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="expense-reconciliation.csv"' }
    });
    return NextResponse.json({ configured: true, storage: provider, ...snapshot }, { headers: noStore });
  } catch (error) {
    return NextResponse.json(
      { configured: true, storage: 'device_fallback', records: [], deletedIds: [], eventCount: 0, error: safeError(error) },
      { status: 503, headers: noStore }
    );
  }
}
export async function POST(request: NextRequest) {
  const denied = await publisherAuth(request, true);
  if (denied) return denied;
  if (!getExpenseLedgerProvider()) return NextResponse.json({ configured: false, storage: 'device' }, { headers: noStore });
  try {
    const body = await request.json();
    let batch: ExpenseBatch;
    if (body.items !== undefined) {
      if (!isExpenseBatch(body)) return NextResponse.json({ error: 'A valid expense batch is required' }, { status: 400, headers: noStore });
      batch = body;
    } else {
      if (!Array.isArray(body.records) || !body.records.length || !body.records.every(isNormalizedExpense))
        return NextResponse.json({ error: 'A valid expense batch is required' }, { status: 400, headers: noStore });
      if (body.records.length > 1000) return NextResponse.json({ error: 'Import batches are limited to 1,000 expenses' }, { status: 413, headers: noStore });
      // Undo is an explicit user correction, never an automatic CSV re-import.
      batch = { batchId: body.batchId ?? randomUUID(), actor: 'portfolio-app', items: body.records.map((record: import('@/lib/expense-records').NormalizedExpense) =>
        body.restore === true ? { action: 'correct' as const, record, expectedRevision: body.expectedRevision, reason: 'User restored deleted expense' }
          : { action: 'upsert' as const, record }) };
      if (!isExpenseBatch(batch)) return NextResponse.json({ error: 'A valid expense batch is required' }, { status: 400, headers: noStore });
    }
    const receipt = await reconcileExpenseBatch(batch);
    return NextResponse.json({ configured: true, storage: 'supabase', ...receiptSummary(receipt) }, { headers: noStore });
  } catch (error) {
    const message = safeError(error);
    return NextResponse.json({ error: message }, { status: message.startsWith('Batch ID already used') ? 409 : 503, headers: noStore });
  }
}
export async function DELETE(request: NextRequest) {
  const denied = await publisherAuth(request, true);
  if (denied) return denied;
  if (!getExpenseLedgerProvider()) return NextResponse.json({ configured: false, storage: 'device' }, { headers: noStore });
  try {
    const body = await request.json();
    const batch = { batchId: body.batchId ?? randomUUID(), actor: 'portfolio-app', items: [{ action: 'delete' as const, recordId: body.id, expectedRevision: body.expectedRevision, reason: 'User removed expense' }] };
    if (!isExpenseBatch(batch)) return NextResponse.json({ error: 'Expense ID and current revision required' }, { status: 400, headers: noStore });
    const receipt = await reconcileExpenseBatch(batch);
    return NextResponse.json({ configured: true, storage: 'supabase', ...receiptSummary(receipt) }, { headers: noStore });
  } catch (error) { return NextResponse.json({ error: safeError(error) }, { status: 503, headers: noStore }); }
}
function safeError(error: unknown) {
  return (error instanceof Error ? error.message : 'Expense ledger request failed').replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]').slice(0, 180);
}
