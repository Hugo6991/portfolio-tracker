import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NormalizedExpense } from '../expense-records';
vi.mock('server-only',()=>({}));
let ledger: typeof import('./supabase-expense-ledger');
beforeAll(async()=>{ ledger=await import('./supabase-expense-ledger'); });
afterEach(()=>{vi.unstubAllGlobals();delete process.env.SUPABASE_URL;delete process.env.SUPABASE_SERVICE_ROLE_KEY;});
const expense: NormalizedExpense = {id:'expense-1',sourceType:'expense',sourceName:'Bank CSV',merchant:'Example',date:'2026-10-01',category:'subscription',nativeAmount:50,nativeCurrency:'USD',usdValue:50,note:'',attachmentName:null,inputMethod:'csv',sourceRecordId:'tx',importFingerprint:'infini:tx',updatedAt:'2026-10-01T00:00:00Z',syncStatus:'updated_today',isSeed:false};
function configure(){process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='test-key';}
function json(value:unknown){return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});}
describe('Supabase canonical expense ledger',()=>{
  it('reads canonical rows with revisions and tombstones',async()=>{
    configure();vi.stubGlobal('fetch',vi.fn().mockResolvedValue(json([
      {record_id:expense.id,record:expense,revision:2,deleted:false},
      {record_id:'deleted',record:expense,revision:3,deleted:true}
    ])));
    expect(await ledger.readSupabaseExpenseLedger()).toEqual({records:[{...expense,ledgerRevision:2}],deletedIds:['deleted'],eventCount:5});
  });
  it('delegates duplicate decisions to one atomic RPC without reading before writing',async()=>{
    configure();const receipt={batchId:'retry',actor:'portfolio-app',createdAt:'now',counts:{added:0,exists:1,review:0,corrected:0},results:[{status:'exists',recordId:'original',submittedId:expense.id}]};
    const mock=vi.fn().mockResolvedValue(json(receipt));vi.stubGlobal('fetch',mock);
    expect(await ledger.appendSupabaseExpenseRecords([expense],'retry')).toMatchObject({saved:0,duplicates:1,duplicateIds:[expense.id],receipt});
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0]).toContain('/rpc/reconcile_expenses');
    expect(JSON.parse(mock.mock.calls[0][1].body)).toMatchObject({p_batch_id:'retry',p_items:[{action:'upsert',record:expense}]});
  });
  it('returns pending conflicts separately from accepted writes',async()=>{
    configure();vi.stubGlobal('fetch',vi.fn().mockResolvedValue(json({batchId:'pending',results:[{status:'review',recordId:expense.id,submittedId:expense.id}]})));
    expect(await ledger.appendSupabaseExpenseRecords([expense])).toMatchObject({saved:0,duplicates:0,pendingReview:1,reviewIds:[expense.id]});
  });
});
