import {
  dedupeExpenseRecords,
  type NormalizedExpense
} from "./expense-records";

export type ExpenseLedgerOperation = "upsert" | "delete";

export type ExpenseLedgerEvent = {
  eventId: string;
  operation: ExpenseLedgerOperation;
  recordId: string;
  record: NormalizedExpense | null;
  updatedAt: string;
};

export type ExpenseLedgerSnapshot = {
  records: NormalizedExpense[];
  deletedIds: string[];
  eventCount: number;
};

export type ExpenseLedgerWriteSummary = {
  saved: number;
  duplicates: number;
  savedIds: string[];
  duplicateIds: string[];
};

export function foldExpenseLedgerEvents(
  events: ExpenseLedgerEvent[]
): ExpenseLedgerSnapshot {
  const records = new Map<string, NormalizedExpense>();
  const deletedIds = new Set<string>();

  for (const event of events) {
    if (event.operation === "delete") {
      records.delete(event.recordId);
      deletedIds.add(event.recordId);
      continue;
    }
    if (!event.record) continue;
    const existing = records.get(event.recordId);
    if (!existing || existing.updatedAt <= event.record.updatedAt) {
      records.set(event.recordId, event.record);
      deletedIds.delete(event.recordId);
    }
  }

  return {
    records: dedupeExpenseRecords([...records.values()]),
    deletedIds: [...deletedIds],
    eventCount: events.length
  };
}
