import { isNormalizedExpense, type NormalizedExpense } from './expense-records';

export type ExpenseBatchItem = {
  action: 'upsert' | 'correct' | 'delete' | 'review';
  record?: NormalizedExpense;
  recordId?: string;
  expectedRevision?: number;
  reason?: string;
};
export type ExpenseBatch = { batchId: string; actor: string; items: ExpenseBatchItem[] };
export type ExpenseBatchResult = {
  status: 'added' | 'exists' | 'review' | 'corrected';
  submittedId: string;
  recordId: string;
  identity?: string;
  revision?: number;
  reason?: string;
  action: ExpenseBatchItem['action'];
};
export type ExpenseBatchReceipt = {
  batchId: string;
  actor: string;
  createdAt: string;
  results: ExpenseBatchResult[];
  counts: Record<ExpenseBatchResult['status'], number>;
};

export function isExpenseBatch(value: unknown): value is ExpenseBatch {
  if (!value || typeof value !== 'object') return false;
  const b = value as ExpenseBatch;
  return typeof b.batchId === 'string' && b.batchId.trim().length > 0 && b.batchId.length <= 200
    && typeof b.actor === 'string' && b.actor.trim().length > 0 && b.actor.length <= 100
    && Array.isArray(b.items) && b.items.length > 0 && b.items.length <= 1000
    && b.items.every(item => {
      if (!item || !['upsert', 'correct', 'delete', 'review'].includes(item.action)) return false;
      if (item.reason !== undefined && (typeof item.reason !== 'string' || item.reason.length > 2000)) return false;
      if (item.expectedRevision !== undefined && (!Number.isInteger(item.expectedRevision) || item.expectedRevision < 1)) return false;
      if (item.action === 'delete') return typeof item.recordId === 'string' && item.recordId.length > 0 && item.expectedRevision !== undefined;
      return isNormalizedExpense(item.record)
        && (item.action !== 'correct' || (item.expectedRevision !== undefined && !!item.reason?.trim()));
    });
}

export function receiptSummary(receipt: ExpenseBatchReceipt) {
  const saved = receipt.results.filter(r => r.status === 'added' || r.status === 'corrected');
  const duplicates = receipt.results.filter(r => r.status === 'exists');
  const review = receipt.results.filter(r => r.status === 'review');
  return {
    saved: saved.length, duplicates: duplicates.length, pendingReview: review.length,
    savedIds: saved.map(r => r.recordId), duplicateIds: duplicates.map(r => r.submittedId),
    reviewIds: review.map(r => r.submittedId), receipt
  };
}

// A transport file for the other account, never a claim that its Sheet was updated.
export function expenseReconciliationCsv(records: NormalizedExpense[]) {
  const rows: unknown[][] = [[
    'ledger_record_id', 'payment_source', 'source_transaction_id', 'import_fingerprint',
    'card_last4', 'date', 'merchant', 'native_amount', 'native_currency', 'usd_value',
    'revision', 'sheet_refs', 'sheet_sync_status'
  ]];
  for (const r of records) {
    const cardSource = r.paymentSource || r.importFingerprint?.match(/^(infini|plasma):/i)?.[1].toLowerCase() || '';
    rows.push([r.id, cardSource, r.sourceRecordId || (cardSource ? r.importFingerprint?.slice(cardSource.length + 1) : '') || '',
      r.importFingerprint || '', r.cardLast4 || '', r.date, r.merchant, r.nativeAmount, r.nativeCurrency,
      r.usdValue, r.ledgerRevision || 1, JSON.stringify(r.sheetRefs || []), 'not_verified']);
  }
  return '\uFEFF' + rows.map(row => row.map(value => {
    let s = String(value ?? '');
    if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  }).join(',')).join('\r\n');
}
