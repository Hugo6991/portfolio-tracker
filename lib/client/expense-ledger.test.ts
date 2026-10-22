import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteExpenseRecord, loadExpenseLedger, upsertExpenseRecords } from './expense-ledger';
import { expenseStorageKey, loadExpenseRecords, type NormalizedExpense } from '../expense-records';

const record: NormalizedExpense = {
  id: 'r',
  sourceType: 'expense',
  sourceName: 'Bank CSV',
  merchant: 'Example',
  date: '2026-10-01',
  category: 'subscription',
  nativeAmount: 50,
  nativeCurrency: 'USD',
  usdValue: 50,
  note: '',
  attachmentName: null,
  inputMethod: 'csv',
  importFingerprint: 'infini:tx',
  sourceRecordId: 'tx',
  updatedAt: 'now',
  syncStatus: 'updated_today',
  isSeed: false
};
const deleteQueueKey = 'portfolio.expense-delete-queue.v2';
const writeQueueKey = 'portfolio.expense-write-queue.v1';
const receiptKey = 'portfolio.expense-receipts.v1';
let values: Map<string, string>;
let replaceLocation: ReturnType<typeof vi.fn>;

beforeEach(() => {
  values = new Map();
  replaceLocation = vi.fn();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => values.get(key) || null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    },
    dispatchEvent: () => {},
    location: {
      pathname: '/expenses',
      search: '?month=2026-10',
      replace: replaceLocation
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('expense client receipt handling', () => {
  it('keeps pending proposals out of local spending', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({
        configured: true,
        storage: 'supabase',
        saved: 0,
        savedIds: [],
        duplicates: 0,
        duplicateIds: [],
        pendingReview: 1,
        reviewIds: ['r']
      }))
      .mockResolvedValueOnce(json(cloud([]))));

    expect((await upsertExpenseRecords([record])).pendingReview).toBe(1);
    expect(loadExpenseRecords()).toEqual([]);
  });

  it('keeps the existing canonical record when an import is a duplicate', async () => {
    const canonical = { ...record, id: 'original', ledgerRevision: 1 };
    values.set(expenseStorageKey, JSON.stringify([canonical]));
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({
        configured: true,
        storage: 'supabase',
        saved: 0,
        savedIds: [],
        duplicates: 1,
        duplicateIds: ['r']
      }))
      .mockResolvedValueOnce(json(cloud([canonical]))));

    await upsertExpenseRecords([record]);

    expect(loadExpenseRecords()).toEqual([canonical]);
  });

  it('retains receipt proof when the canonical refresh fails after a saved write', async () => {
    values.set(expenseStorageKey, JSON.stringify([{
      ...record,
      id: 'device-copy',
      ledgerRevision: undefined,
      updatedAt: '9999-01-01T00:00:00.000Z'
    }]));
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({
        configured: true,
        storage: 'supabase',
        saved: 1,
        savedIds: ['r'],
        duplicates: 0,
        duplicateIds: [],
        receipt: {
          batchId: 'save-batch',
          actor: 'portfolio-app',
          createdAt: '2026-10-01T00:00:00.000Z',
          results: [{ status: 'added', submittedId: 'r', recordId: 'r', revision: 1, action: 'upsert' }],
          counts: { added: 1, exists: 0, review: 0, corrected: 0 }
        }
      }))
      .mockResolvedValueOnce(json({ error: 'Expense gateway unavailable' }, { status: 503 })));

    await upsertExpenseRecords([record]);

    expect(loadExpenseRecords()).toEqual([{ ...record, ledgerRevision: 1 }]);
  });

  it('clears local proof instead of masking an authorization failure after a saved write', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({
        configured: true,
        storage: 'supabase',
        saved: 1,
        savedIds: ['r'],
        duplicates: 0,
        duplicateIds: [],
        receipt: {
          batchId: 'save-batch',
          actor: 'portfolio-app',
          createdAt: '2026-10-01T00:00:00.000Z',
          results: [{ status: 'added', submittedId: 'r', recordId: 'r', revision: 1, action: 'upsert' }],
          counts: { added: 1, exists: 0, review: 0, corrected: 0 }
        }
      }))
      .mockResolvedValueOnce(json({ error: 'Viewer access required' }, { status: 401 })));

    await expect(upsertExpenseRecords([record])).rejects.toMatchObject({
      name: 'ExpenseLedgerAccessError',
      status: 401
    });

    expect(values.size).toBe(0);
    expect(replaceLocation).toHaveBeenCalledOnce();
  });

  it('never publishes local rows or queued deletions while loading', async () => {
    values.set(expenseStorageKey, JSON.stringify([record]));
    values.set(deleteQueueKey, JSON.stringify([{ id: 'r', expectedRevision: 1, batchId: 'delete-batch' }]));
    values.set(writeQueueKey, JSON.stringify({ batchId: 'write-batch', records: [record] }));
    const fetchMock = vi.fn().mockResolvedValue(json(cloud([])));
    vi.stubGlobal('fetch', fetchMock);

    await loadExpenseLedger();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/expenses', { cache: 'no-store' });
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    expect(values.has(writeQueueKey)).toBe(true);
  });

  it('reuses the same batch and payload after an ambiguous write failure', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Connection closed before a response'))
      .mockImplementationOnce((_url, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return Promise.resolve(json({
          configured: true,
          storage: 'supabase',
          saved: 1,
          savedIds: ['r'],
          duplicates: 0,
          duplicateIds: [],
          receipt: receipt(body.batchId)
        }));
      })
      .mockResolvedValueOnce(json(cloud([{ ...record, ledgerRevision: 1 }])));
    vi.stubGlobal('fetch', fetchMock);

    await expect(upsertExpenseRecords([record])).rejects.toThrow('Connection closed');
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(values.has(writeQueueKey)).toBe(true);

    await upsertExpenseRecords([record]);

    const retryBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(retryBody).toEqual(firstBody);
    expect(values.has(writeQueueKey)).toBe(false);
  });

  it('lets an owner resume a queued write with its original batch ID', async () => {
    values.set(writeQueueKey, JSON.stringify({ batchId: 'write-batch', records: [record] }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(cloud([])))
      .mockResolvedValueOnce(json({
        configured: true,
        storage: 'supabase',
        saved: 1,
        savedIds: ['r'],
        duplicates: 0,
        duplicateIds: [],
        receipt: receipt('write-batch')
      }))
      .mockResolvedValueOnce(json(cloud([{ ...record, ledgerRevision: 1 }])));
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await loadExpenseLedger({ retryPendingWrite: true });

    expect(snapshot.records).toEqual([{ ...record, ledgerRevision: 1 }]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      batchId: 'write-batch',
      records: [record]
    });
    expect(values.has(writeQueueKey)).toBe(false);
    expect(JSON.parse(values.get(receiptKey) ?? '[]')[0].batchId).toBe('write-batch');
  });

  it('does not call a confirmed replay unconfirmed when the refresh fails', async () => {
    values.set(writeQueueKey, JSON.stringify({ batchId: 'write-batch', records: [record] }));
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json(cloud([])))
      .mockResolvedValueOnce(json({
        configured: true,
        storage: 'supabase',
        saved: 1,
        savedIds: ['r'],
        duplicates: 0,
        duplicateIds: [],
        receipt: receipt('write-batch')
      }))
      .mockResolvedValueOnce(json({ error: 'Expense gateway unavailable' }, { status: 503 })));

    const snapshot = await loadExpenseLedger({ retryPendingWrite: true });

    expect(snapshot.message).toContain('confirmed');
    expect(snapshot.message).not.toContain('unconfirmed');
    expect(values.has(writeQueueKey)).toBe(false);
    expect(JSON.parse(values.get(receiptKey) ?? '[]')[0].batchId).toBe('write-batch');
  });

  it('keeps a definitive review result visible after replay', async () => {
    values.set(writeQueueKey, JSON.stringify({ batchId: 'review-batch', records: [record] }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(cloud([])))
      .mockResolvedValueOnce(json({
        configured: true,
        storage: 'supabase',
        saved: 0,
        savedIds: [],
        duplicates: 0,
        duplicateIds: [],
        pendingReview: 1,
        reviewIds: ['r'],
        receipt: {
          ...receipt('review-batch'),
          results: [{ status: 'review', submittedId: 'r', recordId: 'r', revision: null, action: 'review' }],
          counts: { added: 0, exists: 0, review: 1, corrected: 0 }
        }
      }))
      .mockResolvedValueOnce(json(cloud([])));
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await loadExpenseLedger({ retryPendingWrite: true });

    expect(snapshot.records).toEqual([]);
    expect(snapshot.message).toContain('held for review');
    expect(values.has(writeQueueKey)).toBe(false);
    expect(JSON.parse(values.get(receiptKey) ?? '[]')[0].batchId).toBe('review-batch');
  });

  it('surfaces an explicit import failure without saving a local success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(
      { error: 'Expense gateway unavailable' },
      { status: 503 }
    )));

    await expect(upsertExpenseRecords([record])).rejects.toThrow('Expense gateway unavailable');
    expect(loadExpenseRecords()).toEqual([]);
  });

  it('surfaces an explicit deletion failure and preserves the local row', async () => {
    const canonical = { ...record, ledgerRevision: 2 };
    values.set(expenseStorageKey, JSON.stringify([canonical]));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(
      { error: 'Expense gateway unavailable' },
      { status: 503 }
    )));

    await expect(deleteExpenseRecord('r')).rejects.toThrow('could not be confirmed');
    expect(loadExpenseRecords()).toEqual([canonical]);
    expect(JSON.parse(values.get(deleteQueueKey) ?? '[]')).toEqual([
      expect.objectContaining({ id: 'r', expectedRevision: 2 })
    ]);
  });

  it('keeps an unconfirmed deletion visible when the ledger is unavailable on reload', async () => {
    const canonical = { ...record, ledgerRevision: 2 };
    values.set(expenseStorageKey, JSON.stringify([canonical]));
    values.set(deleteQueueKey, JSON.stringify([{ id: 'r', expectedRevision: 2, batchId: 'delete-batch' }]));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(
      { error: 'Expense gateway unavailable' },
      { status: 503 }
    )));

    const snapshot = await loadExpenseLedger();

    expect(snapshot.storage).toBe('device_fallback');
    expect(snapshot.records).toEqual([canonical]);
  });

  it.each([401, 403])('clears private local data and refuses fallback after a %s response', async (status) => {
    const canonical = { ...record, ledgerRevision: 2 };
    values.set(expenseStorageKey, JSON.stringify([canonical]));
    values.set(deleteQueueKey, JSON.stringify([{ id: 'r', expectedRevision: 2, batchId: 'delete-batch' }]));
    values.set(writeQueueKey, JSON.stringify({ batchId: 'write-batch', records: [record] }));
    values.set(receiptKey, JSON.stringify([{ batchId: 'receipt-batch' }]));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(
      { error: 'Viewer access required' },
      { status }
    )));

    await expect(loadExpenseLedger()).rejects.toMatchObject({
      name: 'ExpenseLedgerAccessError',
      status
    });

    expect(values.has(expenseStorageKey)).toBe(false);
    expect(values.has(deleteQueueKey)).toBe(false);
    expect(values.has(receiptKey)).toBe(false);
    expect(replaceLocation).toHaveBeenCalledWith('/login?returnTo=%2Fexpenses%3Fmonth%3D2026-10');
  });

  it('does not recreate a deletion queue after an authorization failure', async () => {
    const canonical = { ...record, ledgerRevision: 2 };
    values.set(expenseStorageKey, JSON.stringify([canonical]));
    values.set(receiptKey, JSON.stringify([{ batchId: 'receipt-batch' }]));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(
      { error: 'Owner access required' },
      { status: 401 }
    )));

    await expect(deleteExpenseRecord('r')).rejects.toMatchObject({
      name: 'ExpenseLedgerAccessError',
      status: 401
    });

    expect(values.size).toBe(0);
    expect(replaceLocation).toHaveBeenCalledOnce();
  });

  it('does not hide a row when a concurrent correction blocks deletion', async () => {
    const canonical = { ...record, ledgerRevision: 2 };
    values.set(expenseStorageKey, JSON.stringify([canonical]));
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ configured: true, pendingReview: 1 }))
      .mockResolvedValueOnce(json(cloud([{ ...canonical, ledgerRevision: 3 }]))));

    await expect(deleteExpenseRecord('r')).rejects.toThrow('changed elsewhere');

    expect(loadExpenseRecords()[0].ledgerRevision).toBe(3);
  });
});

function json(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers }
  });
}

function cloud(records: NormalizedExpense[]) {
  return {
    configured: true,
    storage: 'supabase',
    records,
    deletedIds: [],
    eventCount: records.length
  };
}

function receipt(batchId: string) {
  return {
    batchId,
    actor: 'portfolio-app',
    createdAt: '2026-10-01T00:00:00.000Z',
    results: [{ status: 'added', submittedId: 'r', recordId: 'r', revision: 1, action: 'upsert' }],
    counts: { added: 1, exists: 0, review: 0, corrected: 0 }
  };
}
