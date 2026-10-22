import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({ read: vi.fn(), reconcile: vi.fn(), receipt: vi.fn() }));

vi.mock('@/lib/server/expense-ledger', () => ({
  getExpenseLedgerProvider: () => 'supabase',
  readConfiguredExpenseLedger: mocks.read
}));
vi.mock('@/lib/server/supabase-expense-ledger', () => ({
  reconcileExpenseBatch: mocks.reconcile,
  readExpenseBatchReceipt: mocks.receipt
}));

import { GET, POST, DELETE } from './route';
import { createViewerSessionToken, VIEWER_SESSION_COOKIE } from '@/lib/viewer-session';

const adminPassword = 'publisher-test-admin-2026';
const viewerPassword = 'viewer-test-password-2026';
const sessionSecret = 'viewer-test-session-secret-with-at-least-thirty-two-characters';
const record = {
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
  sourceRecordId: 'tx',
  importFingerprint: 'infini:tx',
  updatedAt: 'now',
  syncStatus: 'updated_today',
  isSeed: false
};
const receipt = {
  batchId: 'batch',
  actor: 'bot',
  results: [{ status: 'exists', submittedId: 'r', recordId: 'canonical' }],
  counts: { added: 0, exists: 1, review: 0, corrected: 0 }
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PORTFOLIO_ACCESS_PASSWORD = adminPassword;
  process.env.PORTFOLIO_VIEWER_PASSWORD = viewerPassword;
  process.env.PORTFOLIO_VIEWER_SESSION_SECRET = sessionSecret;
  mocks.read.mockResolvedValue({ records: [record], deletedIds: [], eventCount: 1 });
  mocks.reconcile.mockResolvedValue(receipt);
});

afterEach(() => {
  delete process.env.PORTFOLIO_ACCESS_PASSWORD;
  delete process.env.PORTFOLIO_VIEWER_PASSWORD;
  delete process.env.PORTFOLIO_VIEWER_SESSION_SECRET;
});

describe('expense gateway', () => {
  it('allows an ordinary ledger read without a viewer session', async () => {
    const response = await GET(request(undefined, { method: 'GET' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      configured: true,
      storage: 'supabase',
      records: [record]
    });
    expect(mocks.read).toHaveBeenCalledOnce();
  });

  it('allows an administrator header to read the canonical ledger headlessly', async () => {
    const response = await GET(request(undefined, {
      method: 'GET',
      password: adminPassword
    }));

    expect(response.status).toBe(200);
    expect(mocks.read).toHaveBeenCalledOnce();
  });

  it('allows a viewer session to read but not to publish or delete', async () => {
    const publish = await POST(await sessionRequest('viewer', batchBody(), {
      method: 'POST',
      origin: 'http://localhost'
    }));
    const remove = await DELETE(await sessionRequest('viewer', {
      id: 'r',
      expectedRevision: 1,
      batchId: 'delete-batch'
    }, {
      method: 'DELETE',
      origin: 'http://localhost'
    }));

    expect(publish.status).toBe(401);
    expect(remove.status).toBe(401);
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('allows an administrator session to write only from the same origin', async () => {
    const response = await POST(await sessionRequest('admin', batchBody(), {
      method: 'POST',
      origin: 'http://localhost'
    }));

    expect(response.status).toBe(200);
    expect(mocks.reconcile).toHaveBeenCalledWith(batchBody());
  });

  it('allows an administrator header to publish without a browser origin', async () => {
    const response = await POST(request(batchBody(), {
      method: 'POST',
      password: adminPassword
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ saved: 0, duplicates: 1, receipt });
  });

  it.each(['session', 'header'])('rejects a cross-origin administrator write using %s access', async (access) => {
    const response = access === 'session'
      ? await POST(await sessionRequest('admin', batchBody(), {
          method: 'POST',
          origin: 'https://attacker.test'
        }))
      : await POST(request(batchBody(), {
          method: 'POST',
          origin: 'https://attacker.test',
          password: adminPassword
        }));

    expect(response.status).toBe(403);
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('returns 409 for a batch ID reused with changed contents', async () => {
    mocks.reconcile.mockRejectedValue(new Error('Batch ID already used with different content'));

    const response = await POST(request({ records: [record], batchId: 'batch' }, {
      method: 'POST',
      password: adminPassword
    }));

    expect(response.status).toBe(409);
  });

  it('rejects a deletion without its current revision after authorization', async () => {
    const response = await DELETE(request({ id: 'r' }, {
      method: 'DELETE',
      password: adminPassword
    }));

    expect(response.status).toBe(400);
  });

  it('reserves receipt and reconciliation export reads for administrators', async () => {
    expect((await GET(await sessionRequest('viewer', undefined, {
      method: 'GET',
      query: '?batchId=batch'
    }))).status).toBe(401);
    expect((await GET(await sessionRequest('viewer', undefined, {
      method: 'GET',
      query: '?format=reconciliation'
    }))).status).toBe(401);

    mocks.receipt.mockResolvedValue(receipt);
    const response = await GET(request(undefined, {
      method: 'GET',
      password: adminPassword,
      query: '?batchId=batch'
    }));

    expect(await response.json()).toEqual({ receipt });
  });
});

function batchBody() {
  return { batchId: 'batch', actor: 'bot', items: [{ action: 'upsert', record }] };
}

function request(
  body?: unknown,
  options: {
    method?: string;
    origin?: string;
    password?: string;
    cookie?: string;
    query?: string;
  } = {}
) {
  const headers = new Headers();
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (options.origin) headers.set('origin', options.origin);
  if (options.password) headers.set('x-portfolio-password', options.password);
  if (options.cookie) headers.set('cookie', options.cookie);

  return new NextRequest(`http://localhost/api/expenses${options.query ?? ''}`, {
    method: options.method ?? 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function sessionRequest(
  role: 'viewer' | 'admin',
  body?: unknown,
  options: Parameters<typeof request>[1] = {}
) {
  const { token } = await createViewerSessionToken(role);
  return request(body, {
    ...options,
    cookie: `${VIEWER_SESSION_COOKIE}=${token}`
  });
}
