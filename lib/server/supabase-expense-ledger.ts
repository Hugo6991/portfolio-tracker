import 'server-only';
import { randomUUID } from 'node:crypto';
import { isNormalizedExpense, type NormalizedExpense } from '../expense-records';
import { isExpenseBatch, receiptSummary, type ExpenseBatch, type ExpenseBatchReceipt } from '../expense-reconciliation';
import type { ExpenseLedgerSnapshot } from '../expense-ledger-events';

function getConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase expense ledger is not configured');
  return { url, key };
}
export function isSupabaseExpenseLedgerConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
async function request(path: string, init: RequestInit = {}) {
  const { url, key } = getConfig();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init, cache: 'no-store', signal: AbortSignal.timeout(20_000),
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...init.headers }
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { message?: string };
    if (error.message?.includes('Batch ID already used')) throw new Error('Batch ID already used with different content');
    throw new Error(`Supabase expense request failed (${response.status})`);
  }
  return response.json();
}
export async function readSupabaseExpenseLedger(): Promise<ExpenseLedgerSnapshot> {
  const records: NormalizedExpense[] = [];
  const deletedIds: string[] = [];
  let eventCount = 0;
  for (let offset = 0; ; offset += 1000) {
    const query = new URLSearchParams({ select: 'record_id,record,revision,deleted', order: 'record_id.asc', limit: '1000', offset: String(offset) });
    const rows = await request(`expense_entries?${query}`) as Array<{ record_id: string; record: NormalizedExpense; revision: number; deleted: boolean }>;
    for (const row of rows) {
      eventCount += row.revision;
      if (row.deleted) deletedIds.push(row.record_id);
      else if (isNormalizedExpense(row.record)) records.push({ ...row.record, ledgerRevision: row.revision });
    }
    if (rows.length < 1000) break;
  }
  records.sort((a,b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt));
  return { records, deletedIds, eventCount };
}
export async function reconcileExpenseBatch(batch: ExpenseBatch) {
  if (!isExpenseBatch(batch)) throw new Error('Invalid expense batch');
  return await request('rpc/reconcile_expenses', {
    method: 'POST', body: JSON.stringify({ p_batch_id: batch.batchId, p_actor: batch.actor, p_items: batch.items })
  }) as ExpenseBatchReceipt;
}
export async function readExpenseBatchReceipt(batchId: string): Promise<ExpenseBatchReceipt | null> {
  const query = new URLSearchParams({ select: 'receipt', batch_id: `eq.${batchId}`, limit: '1' });
  const rows = await request(`expense_batches?${query}`) as Array<{ receipt: ExpenseBatchReceipt }>;
  return rows[0]?.receipt ?? null;
}
export async function appendSupabaseExpenseRecords(records: NormalizedExpense[], batchId: string = randomUUID()) {
  const receipt = await reconcileExpenseBatch({ batchId, actor: 'portfolio-app', items: records.map(record => ({ action: 'upsert', record })) });
  return receiptSummary(receipt);
}
export async function appendSupabaseExpenseDeletion(recordId: string, revision: number, batchId: string = randomUUID()) {
  return receiptSummary(await reconcileExpenseBatch({ batchId, actor: 'portfolio-app', items: [{ action: 'delete', recordId, expectedRevision: revision, reason: 'User removed expense' }] }));
}
