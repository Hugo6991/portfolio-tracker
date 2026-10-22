'use client';
import { dedupeExpenseRecords, expenseStorageKey, loadExpenseRecords, saveExpenseRecords, selectNewExpenseRecords, type NormalizedExpense } from '@/lib/expense-records';
import type { ExpenseBatchReceipt } from '@/lib/expense-reconciliation';
export type ExpenseLedgerStorage = 'supabase' | 'device' | 'device_fallback';
export type ExpenseLedgerWriteResult = {
  storage: ExpenseLedgerStorage; saved: number; duplicates: number; savedIds: string[]; duplicateIds: string[];
  pendingReview?: number; reviewIds?: string[]; receipt?: ExpenseBatchReceipt;
};
export type ExpenseLedgerClientSnapshot = {
  records: NormalizedExpense[]; configured: boolean; storage: ExpenseLedgerStorage; eventCount: number; message?: string;
};
type ApiSnapshot = ExpenseLedgerClientSnapshot & { deletedIds: string[]; error?: string };
type PendingDelete = { id: string; expectedRevision: number; batchId: string };
type PendingWrite = { batchId: string; records: NormalizedExpense[]; restoreRevision?: number };
const deleteKey = 'portfolio.expense-delete-queue.v2';
const writeKey = 'portfolio.expense-write-queue.v1';
const receiptKey = 'portfolio.expense-receipts.v1';

export class ExpenseLedgerAccessError extends Error {
  constructor(message: string, public readonly status: 401 | 403) {
    super(message);
    this.name = 'ExpenseLedgerAccessError';
  }
}

async function readCloud(): Promise<ApiSnapshot> {
  const response = await fetch('/api/expenses', { cache: 'no-store' });
  if (!response.ok) await throwResponseError(response);
  return response.json();
}
export async function loadExpenseLedger(options?: { retryPendingWrite?: boolean }): Promise<ExpenseLedgerClientSnapshot> {
  const local = loadExpenseRecords();
  try {
    let snapshot = await readCloud();
    let replayMessage: string | undefined;
    if (!snapshot.configured) return { ...snapshot, records: local, storage: 'device' };
    const pendingWrite = readPendingWrite();
    if (pendingWrite && options?.retryPendingWrite) {
      let result: ExpenseLedgerWriteResult;
      try {
        result = await writeCloud(
          pendingWrite.records,
          pendingWrite.restoreRevision === undefined
            ? undefined
            : { restoreRevision: pendingWrite.restoreRevision }
        );
      } catch (error) {
        if (error instanceof ExpenseLedgerAccessError) throw error;
        saveExpenseRecords(snapshot.records);
        return {
          ...snapshot,
          message: 'A previous write is unconfirmed and requires an owner retry'
        };
      }
      rememberReceipt(result.receipt);
      if (result.pendingReview) {
        replayMessage = `${result.pendingReview} ${result.pendingReview === 1 ? 'expense was' : 'expenses were'} held for review; spending was not changed`;
      }
      try {
        snapshot = await readCloud();
      } catch (error) {
        if (error instanceof ExpenseLedgerAccessError) throw error;
        saveExpenseRecords(snapshot.records);
        return {
          ...snapshot,
          message: replayMessage ?? 'The previous write was confirmed; reload the ledger to display the latest records'
        };
      }
    }
    saveExpenseRecords(snapshot.records);
    return {
      ...snapshot,
      message: pendingDeletes().length
        ? 'A previous removal is unconfirmed and requires an owner retry'
        : replayMessage ?? (readPendingWrite()
          ? 'A previous write is unconfirmed and requires an owner retry'
          : undefined)
    };
  } catch (error) {
    if (error instanceof ExpenseLedgerAccessError) {
      throw error;
    }
    return { records: local, configured: true,
      storage: 'device_fallback', eventCount: 0, message: error instanceof Error ? error.message : 'Cloud ledger unavailable' };
  }
}
export async function upsertExpenseRecords(records: NormalizedExpense[], options?: { restoreRevision: number }): Promise<ExpenseLedgerWriteResult> {
  const local = loadExpenseRecords();
  if (options && records.length === 1 && pendingDeletes().some(p => p.id === records[0].id)) {
    removePendingDelete(records[0].id);
    // The original request might have committed before a timeout, so still try the
    // versioned restore; never claim that canceling the local queue undoes a cloud write.
  }
  const selection = selectNewExpenseRecords(records, local);
  const localResult = { saved: selection.accepted.length, duplicates: selection.duplicateIds.length,
    savedIds: selection.accepted.map(r=>r.id), duplicateIds: selection.duplicateIds };
  try {
    const result = await writeCloud(records, options);
    if (!result.configured) {
      saveExpenseRecords(mergeExpenseRecordSets(selection.accepted,local));
      return { storage: 'device', ...localResult };
    }
    rememberReceipt(result.receipt);
    // Do not put rejected or pending records into spending totals.
    const savedIds = new Set(result.savedIds);
    const revisions = new Map(
      (result.receipt?.results ?? [])
        .filter(item => (item.status === 'added' || item.status === 'corrected')
          && Number.isInteger(item.revision) && (item.revision ?? 0) > 0)
        .map(item => [item.recordId, item.revision!] as const)
    );
    const next = mergeExpenseRecordSets(
      records
        .filter(r=>savedIds.has(r.id))
        .map(record => revisions.has(record.id)
          ? { ...record, ledgerRevision: revisions.get(record.id) }
          : record),
      local
    );
    saveExpenseRecords(next);
    try {
      saveExpenseRecords((await readCloud()).records);
    } catch (error) {
      if (error instanceof ExpenseLedgerAccessError) throw error;
      // Receipt already confirms the write; the next authorized load refreshes revisions.
    }
    return { ...result, storage: 'supabase' };
  } catch (error) {
    throw error;
  }
}
export async function deleteExpenseRecord(recordId: string): Promise<ExpenseLedgerStorage> {
  const local = loadExpenseRecords();
  const record = local.find(r => r.id === recordId);
  if (!record?.ledgerRevision) throw new Error('Reload the ledger before removing this expense');
  const pending = pendingDeletes().find(item => item.id === recordId) ?? {
    id: recordId,
    expectedRevision: record.ledgerRevision,
    batchId: crypto.randomUUID()
  };
  let result: ExpenseLedgerWriteResult & { configured: boolean };
  try {
    result = await sendDelete(pending);
  } catch (error) {
    if (error instanceof ExpenseLedgerAccessError) throw error;
    // Keep the exact version and batch for an explicit retry after an ambiguous failure.
    window.localStorage.setItem(deleteKey, JSON.stringify([...pendingDeletes().filter(p => p.id !== recordId), pending]));
    throw new Error('Removal could not be confirmed; retry with owner access');
  }
  rememberReceipt(result.receipt);
  if (result.pendingReview) {
    try {
      saveExpenseRecords((await readCloud()).records);
    } catch (error) {
      if (error instanceof ExpenseLedgerAccessError) throw error;
      // Preserve the original local record until an authorized refresh succeeds.
    }
    throw new Error('This expense changed elsewhere; reload before removing it');
  }
  removePendingDelete(recordId);
  saveExpenseRecords(local.filter(r => r.id !== recordId));
  return result.configured ? 'supabase' : 'device';
}
export function expenseLedgerStorageLabel(storage: ExpenseLedgerStorage) {
  return {supabase:'Supabase',device_fallback:'Device fallback',device:'Device only'}[storage];
}
export function mergeExpenseRecordSets(...sets: NormalizedExpense[][]) { return dedupeExpenseRecords(sets.flat()); }
export function loadExpenseReceipts(): ExpenseBatchReceipt[] {
  try { return JSON.parse(window.localStorage.getItem(receiptKey)||'[]'); } catch { return []; }
}
export function clearExpenseLedgerLocalData() {
  if (typeof window === 'undefined') return;
  // Private queued payloads must not survive logout or an authorization boundary.
  for (const key of [expenseStorageKey, deleteKey, writeKey, receiptKey]) window.localStorage.removeItem(key);
  window.dispatchEvent(new CustomEvent('portfolio:expenses-updated'));
}
function rememberReceipt(receipt?: ExpenseBatchReceipt) {
  if (receipt) window.localStorage.setItem(receiptKey,JSON.stringify([receipt,...loadExpenseReceipts().filter(r=>r.batchId!==receipt.batchId)].slice(0,30)));
}
async function writeCloud(records: NormalizedExpense[], options?: {restoreRevision:number}) {
  const pending = pendingWriteFor(records, options);
  const response=await fetch('/api/expenses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({records:pending.records,batchId:pending.batchId,...(pending.restoreRevision===undefined?{}:{restore:true,expectedRevision:pending.restoreRevision})})});
  if (!response.ok) {
    if (response.status < 500 && response.status !== 408) removePendingWrite(pending.batchId);
    await throwResponseError(response);
  }
  const result = await response.json() as ExpenseLedgerWriteResult & {configured:boolean};
  removePendingWrite(pending.batchId);
  return result;
}
async function sendDelete(pending: PendingDelete) {
  const response=await fetch('/api/expenses',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify(pending)});
  if (!response.ok) await throwResponseError(response);
  return response.json() as Promise<ExpenseLedgerWriteResult & {configured:boolean}>;
}
function pendingDeletes(): PendingDelete[] {
  try { return JSON.parse(window.localStorage.getItem(deleteKey)||'[]'); } catch { return []; }
}
function removePendingDelete(id:string) { window.localStorage.setItem(deleteKey,JSON.stringify(pendingDeletes().filter(p=>p.id!==id))); }
function pendingWriteFor(records: NormalizedExpense[], options?: {restoreRevision:number}): PendingWrite {
  const existing = readPendingWrite();
  const restoreRevision = options?.restoreRevision;
  if (existing) {
    const samePayload = JSON.stringify(existing.records) === JSON.stringify(records)
      && existing.restoreRevision === restoreRevision;
    if (!samePayload) {
      throw new Error('A previous expense write is unconfirmed; retry it with owner access before submitting another batch');
    }
    return existing;
  }
  const pending = { batchId: crypto.randomUUID(), records, ...(restoreRevision === undefined ? {} : { restoreRevision }) };
  window.localStorage.setItem(writeKey, JSON.stringify(pending));
  return pending;
}
function readPendingWrite(): PendingWrite | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(writeKey) || 'null') as Partial<PendingWrite> | null;
    return value && typeof value.batchId === 'string' && Array.isArray(value.records)
      ? value as PendingWrite
      : null;
  } catch {
    return null;
  }
}
function removePendingWrite(batchId: string) {
  if (readPendingWrite()?.batchId === batchId) window.localStorage.removeItem(writeKey);
}
function redirectToViewerLogin() {
  if (typeof window === 'undefined' || window.location.pathname === '/login') return;
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
}
async function throwResponseError(response: Response): Promise<never> {
  const message = await responseError(response);
  if (response.status === 401 || response.status === 403) {
    clearExpenseLedgerLocalData();
    redirectToViewerLogin();
    throw new ExpenseLedgerAccessError(message, response.status);
  }
  throw new Error(message);
}
async function responseError(response:Response) {
  try { return (await response.json()).error || `Expense ledger responded with ${response.status}`; } catch { return `Expense ledger responded with ${response.status}`; }
}
