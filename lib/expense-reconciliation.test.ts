import { describe,it,expect } from 'vitest';
import { expenseReconciliationCsv, isExpenseBatch } from './expense-reconciliation';
import type { NormalizedExpense } from './expense-records';
const record: NormalizedExpense={id:'r',sourceType:'expense',sourceName:'Bank CSV',merchant:'=DANGEROUS()',date:'2026-10-01',category:'subscription',nativeAmount:50,nativeCurrency:'USD',usdValue:50,note:'',attachmentName:null,inputMethod:'csv',paymentSource:'infini',sourceRecordId:'tx',importFingerprint:'infini:tx',updatedAt:'now',syncStatus:'updated_today',isSeed:false};
describe('expense proposal transport',()=>{
  it('does not allow correction without a revision and reason',()=>{
    expect(isExpenseBatch({batchId:'b',actor:'bot',items:[{action:'correct',record}]})).toBe(false);
    expect(isExpenseBatch({batchId:'b',actor:'bot',items:[{action:'correct',record,expectedRevision:1,reason:'Verified receipt'}]})).toBe(true);
  });
  it('retains source transaction identity and does not claim Sheet synchronization',()=>{
    const csv=expenseReconciliationCsv([record]);
    expect(csv).toContain('"infini","tx","infini:tx"');
    expect(csv).toContain('not_verified');
    expect(csv).toContain('"\'=DANGEROUS()"');
  });
});
