import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
let db: PGlite;
const record = (id: string, transaction = id, source = 'infini') => ({
  id, merchant: 'Example merchant', date: '2026-10-01', category: 'subscription', nativeAmount: 50,
  nativeCurrency: 'USD', usdValue: 50, sourceType: 'expense', sourceName: 'Bank CSV', inputMethod: 'csv',
  sourceRecordId: transaction, importFingerprint: `${source}:${transaction}`, note: '', updatedAt: '2026-10-01T00:00:00Z'
});
async function batch(id: string, items: unknown[]) {
  return (await db.query<{ result: any }>('select reconcile_expenses($1,$2,$3) as result', [id, 'test-publisher', JSON.stringify(items)])).rows[0].result;
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec('create role service_role; create role anon; create role authenticated;');
  await db.exec(readFileSync('supabase/migrations/202607240003_create_expense_events.sql','utf8'));
  await db.query("insert into expense_events(event_id,operation,record_id,record,updated_at) values(gen_random_uuid(),'upsert','legacy',$1,now())", [JSON.stringify(record('legacy'))]);
  await db.exec(readFileSync('supabase/migrations/20261001044339_expense_reconciliation_batches.sql','utf8'));
}, 20000);
afterAll(async () => { await db?.close(); });
describe('expense reconciliation database', () => {
  it('backfills real transaction identity without altering old events', async () => {
    expect((await db.query<any>("select identity_key, revision from expense_entries where record_id='legacy'")).rows[0]).toEqual({identity_key:'infini:legacy',revision:1});
  });
  it('has exactly one canonical transaction across competing batches', async () => {
    const result = await Promise.all([
      batch('race-a',[{action:'upsert',record:record('race-1','same-tx')}]),
      batch('race-b',[{action:'upsert',record:record('race-2','same-tx')}])
    ]);
    expect(result.map(r => r.results[0].status).sort()).toEqual(['added','exists']);
    expect((await db.query<any>("select count(*)::int as n from expense_entries where identity_key='infini:same-tx'")).rows[0].n).toBe(1);
  });
  it('replays an identical receipt and rejects reusing the batch ID for another payload', async () => {
    const items=[{action:'upsert',record:record('replay')}];
    expect(await batch('retry',items)).toEqual(await batch('retry',items));
    await expect(batch('retry',[{action:'upsert',record:record('changed')}])).rejects.toThrow('Batch ID already used');
  });
  it('keeps Infini and Plasma separate even for identical amount, merchant and ID', async () => {
    const result=await batch('two-cards',[{action:'upsert',record:record('card-a','card-tx')},{action:'upsert',record:record('card-b','card-tx','plasma')}]);
    expect(result.counts.added).toBe(2);
  });
  it('recognizes a Sheet copy by payment source and transaction ID', async () => {
    await batch('sheet-original',[{action:'upsert',record:record('sheet-orig','sheet-tx')}]);
    const r={...record('sheet-copy','sheet-tx'),importFingerprint:undefined,paymentSource:'infini',sourceName:'Manual entry'};
    expect((await batch('sheet-copy',[{action:'upsert',record:r}])).counts.exists).toBe(1);
  });
  it('stages missing IDs and conflicting details without changing totals', async () => {
    await batch('conflict-base',[{action:'upsert',record:record('conflict')}]);
    const result=await batch('conflict-review',[
      {action:'upsert',record:{...record('another-id','conflict'),nativeAmount:60}},
      {action:'upsert',record:{...record('no-id'),importFingerprint:undefined,sourceRecordId:undefined,paymentSource:'infini'}},
      {action:'review',record:record('authorized-hold'),reason:'Still authorized'}
    ]);
    expect(result.counts.review).toBe(3);
    expect((await db.query<any>("select record->>'nativeAmount' as amount from expense_entries where record_id='conflict'")).rows[0].amount).toBe('50');
  });
  it('requires the current revision for corrections and records before/after events', async () => {
    await batch('edit-base',[{action:'upsert',record:record('edit')}]);
    const changed={...record('edit'),nativeAmount:60,usdValue:60};
    expect((await batch('edit-ok',[{action:'correct',record:changed,expectedRevision:1,reason:'Receipt correction'}])).counts.corrected).toBe(1);
    expect((await batch('edit-stale',[{action:'correct',record:{...changed,nativeAmount:70},expectedRevision:1,reason:'Old bot view'}])).counts.review).toBe(1);
    expect((await db.query<any>("select count(*)::int as n from expense_events where record_id='edit'")).rows[0].n).toBe(2);
  });
  it('retains deleted identities and requires explicit restore', async () => {
    await batch('delete-base',[{action:'upsert',record:record('delete-me')}]);
    expect((await batch('delete',[{action:'delete',recordId:'delete-me',expectedRevision:1}])).counts.corrected).toBe(1);
    expect((await batch('deleted-reimport',[{action:'upsert',record:record('new-id','delete-me')}])).counts.review).toBe(1);
    expect((await batch('restore',[{action:'correct',record:record('delete-me'),expectedRevision:2,reason:'Undo'}])).counts.corrected).toBe(1);
  });
  it('protects identity against direct event inserts bypassing the API', async () => {
    await expect(db.query("insert into expense_events(event_id,operation,record_id,record,updated_at) values(gen_random_uuid(),'upsert','bypass',$1,now())",[JSON.stringify(record('bypass','same-tx'))])).rejects.toThrow('Expense transaction already exists');
  });
  it('rolls back an entire invalid batch and its receipt', async () => {
    await expect(batch('rollback',[{action:'upsert',record:record('rollback-first')},{action:'upsert',record:{id:'bad'}}])).rejects.toThrow();
    expect((await db.query<any>("select count(*)::int as n from expense_batches where batch_id='rollback'")).rows[0].n).toBe(0);
    expect((await db.query<any>("select count(*)::int as n from expense_entries where record_id='rollback-first'")).rows[0].n).toBe(0);
  });
  it('does not mistake a reused record ID for a different transaction', async () => {
    await batch('id-collision-base',[{action:'upsert',record:record('id-collision','original-tx')}]);
    expect((await batch('id-collision-new',[{action:'upsert',record:record('id-collision','different-tx')}])).counts.review).toBe(1);
  });
  it('keeps an authorization hold out of posted expenses', async () => {
    expect((await batch('hold',[{action:'upsert',record:{...record('hold'),settlementStatus:'authorized'}}])).counts.review).toBe(1);
    expect((await db.query<any>("select count(*)::int as n from expense_entries where record_id='hold'")).rows[0].n).toBe(0);
  });
  it('restricts RPC access and enables RLS on receipts and canonical entries', async () => {
    expect((await db.query<any>("select has_function_privilege('anon','reconcile_expenses(text,text,jsonb)','execute') as allowed")).rows[0].allowed).toBe(false);
    const rows=(await db.query<any>("select relrowsecurity from pg_class where relname in ('expense_entries','expense_batches')")).rows;
    expect(rows.every(r=>r.relrowsecurity)).toBe(true);
  });
});
