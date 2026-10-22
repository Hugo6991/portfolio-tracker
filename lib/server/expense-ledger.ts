import 'server-only';
import type { NormalizedExpense } from '../expense-records';
import {
  appendSupabaseExpenseDeletion, appendSupabaseExpenseRecords,
  isSupabaseExpenseLedgerConfigured, readSupabaseExpenseLedger
} from './supabase-expense-ledger';

export type ExpenseLedgerProvider = 'supabase';
export function getExpenseLedgerProvider(): ExpenseLedgerProvider | null {
  return isSupabaseExpenseLedgerConfigured() ? 'supabase' : null;
}
export async function readConfiguredExpenseLedger() { return readSupabaseExpenseLedger(); }
export async function appendConfiguredExpenseRecords(records: NormalizedExpense[], batchId?: string) {
  return appendSupabaseExpenseRecords(records, batchId);
}
export async function appendConfiguredExpenseDeletion(recordId: string, revision: number, batchId?: string) {
  return appendSupabaseExpenseDeletion(recordId, revision, batchId);
}
