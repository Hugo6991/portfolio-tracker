import { describe, expect, it } from "vitest";
import type { Expenses } from "./data";
import {
  attachExpenseLedgerSummary,
  createExpenseFingerprint,
  dedupeExpenseRecords,
  parseReceiptText,
  selectNewExpenseRecords,
  type NormalizedExpense
} from "./expense-records";

describe("parseReceiptText", () => {
  it("extracts a TWD receipt with a western date", () => {
    const result = parseReceiptText([
      "全家便利商店",
      "電子發票",
      "日期 2026/07/22",
      "總計 NT$ 1,280"
    ].join("\n"), "receipt.txt");

    expect(result.draft).toMatchObject({
      merchant: "全家便利商店",
      date: "2026-07-22",
      amount: "1280",
      currency: "TWD",
      category: "food"
    });
    expect(result.confidence).toBe("high");
  });

  it("extracts a USD subscription invoice", () => {
    const result = parseReceiptText([
      "OpenAI, LLC",
      "Invoice",
      "Date 2026-07-20",
      "Amount due USD 20.00"
    ].join("\n"), "openai-invoice.pdf");

    expect(result.draft).toMatchObject({
      merchant: "OpenAI, LLC",
      date: "2026-07-20",
      amount: "20",
      currency: "USD",
      category: "subscription"
    });
  });

  it("converts a Taiwan calendar date", () => {
    const result = parseReceiptText("咖啡店\n日期 115/07/21\n合計 480元", "receipt.txt");
    expect(result.draft.date).toBe("2026-07-21");
    expect(result.draft.amount).toBe("480");
  });
});

describe("attachExpenseLedgerSummary", () => {
  it("keeps a forecast unchanged and reports confirmed records separately", () => {
    const summarized = attachExpenseLedgerSummary(seedExpenses, [record({ date: "2026-07-22", nativeAmount: 480, usdValue: 15.48 })], 31);

    expect(summarized.monthly["2026"][1]).toEqual({ month: "2026-07", total: 1000, living: 1000 });
    expect(summarized.ledger?.monthly["2026-07"]).toEqual({
      month: "2026-07",
      through: "2026-07-22",
      total: 480,
      recordCount: 1,
      categories: { food: 480 }
    });
  });

  it("does not replace a forecast category with the larger of forecast and ledger totals", () => {
    const summarized = attachExpenseLedgerSummary(seedExpenses, [record({
      date: "2026-07-22",
      category: "living",
      nativeAmount: 1480,
      usdValue: 47.74
    })], 31);

    expect(summarized.monthly["2026"][1]).toEqual({ month: "2026-07", total: 1000, living: 1000 });
    expect(summarized.ledger?.monthly["2026-07"]).toMatchObject({ total: 1480, categories: { living: 1480 } });
  });

  it("does not add a ledger record to a historical baseline that may already contain it", () => {
    const summarized = attachExpenseLedgerSummary(seedExpenses, [record({ date: "2026-06-22", nativeAmount: 480, usdValue: 15.48 })], 31);

    expect(summarized.monthly["2026"][0]).toEqual({ month: "2026-06", total: 1000, living: 1000 });
    expect(summarized.meta.yearTotals["2026"]).toBe(2000);
    expect(summarized.ledger?.yearTotals["2026"]).toBe(480);
  });

  it("prefers canonical forecast categories over duplicate legacy aliases", () => {
    const expenses: Expenses = {
      ...seedExpenses,
      monthly: {
        ...seedExpenses.monthly,
        "2026": [{ month: "2026-09", total: 56686, dailyCost: 35035, living: 35035, subscription: 21651 }]
      }
    };
    const summarized = attachExpenseLedgerSummary(expenses, [], 31);

    expect(summarized.monthly["2026"][0]).toEqual({
      month: "2026-09",
      total: 56686,
      living: 35035,
      subscription: 21651
    });
  });

  it("excludes unsettled records from confirmed ledger totals", () => {
    const summarized = attachExpenseLedgerSummary(seedExpenses, [
      record({ id: "settled", merchant: "Settled", settlementStatus: "settled" }),
      record({ id: "authorized", merchant: "Authorized", settlementStatus: "authorized" }),
      record({ id: "failed", merchant: "Failed", settlementStatus: "failed" })
    ], 31);

    expect(summarized.ledger).toMatchObject({
      latestTransactionDate: "2026-07-22",
      total: 480,
      recordCount: 1,
      yearTotals: { "2026": 480 }
    });
  });

  it("keeps distinct canonical rows even when their contents are identical", () => {
    const first = record({ id: "first" });
    const second = record({ id: "second" });
    const summarized = attachExpenseLedgerSummary(seedExpenses, [first, second], 31);

    expect(summarized.ledger).toMatchObject({ total: 960, recordCount: 2 });
  });

  it("keeps records without canonical proof out of confirmed totals", () => {
    const summarized = attachExpenseLedgerSummary(seedExpenses, [
      record({ id: "canonical", ledgerRevision: 2 }),
      record({ id: "local-only", ledgerRevision: undefined })
    ], 31);

    expect(summarized.ledger).toMatchObject({ total: 480, recordCount: 1 });
  });

  it("uses only the newest canonical revision for one record ID", () => {
    const summarized = attachExpenseLedgerSummary(seedExpenses, [
      record({ id: "same", ledgerRevision: 1, nativeAmount: 400 }),
      record({ id: "same", ledgerRevision: 2, nativeAmount: 480 })
    ], 31);

    expect(summarized.ledger).toMatchObject({ total: 480, recordCount: 1 });
  });
});

describe("expense idempotency", () => {
  it("creates the same fingerprint for an unchanged expense", () => {
    const first = record({});
    const second = record({ id: "another-id", updatedAt: "2026-07-22T13:00:00.000Z" });

    expect(createExpenseFingerprint(first)).toBe(createExpenseFingerprint(second));
  });

  it("keeps only the newest record with the same import fingerprint", () => {
    const original = record({ id: "original", importFingerprint: "invoice-123" });
    const retry = record({
      id: "retry",
      importFingerprint: "invoice-123",
      updatedAt: "2026-07-22T13:00:00.000Z"
    });

    expect(dedupeExpenseRecords([original, retry])).toEqual([retry]);
  });

  it("prefers canonical proof over a newer device-only duplicate", () => {
    const canonical = record({ id: "canonical", importFingerprint: "invoice-123", ledgerRevision: 1 });
    const local = record({
      id: "local",
      importFingerprint: "invoice-123",
      ledgerRevision: undefined,
      updatedAt: "2026-07-23T13:00:00.000Z"
    });

    expect(dedupeExpenseRecords([local, canonical])).toEqual([canonical]);
  });

  it("rejects a retry but accepts a newer correction to the same record id", () => {
    const existing = record({ id: "expense-1", importFingerprint: "invoice-123" });
    const retry = record({ id: "expense-2", importFingerprint: "invoice-123" });
    const correction = record({
      id: "expense-1",
      merchant: "Corrected merchant",
      importFingerprint: "invoice-456",
      updatedAt: "2026-07-22T13:00:00.000Z"
    });

    const result = selectNewExpenseRecords([retry, correction], [existing]);
    expect(result.accepted).toEqual([correction]);
    expect(result.duplicateIds).toEqual(["expense-2"]);
  });
});

const seedExpenses: Expenses = {
  meta: {
    currency: "TWD",
    note: "test",
    actualThrough: "2026-06-30",
    yearTotals: { "2024": 0, "2025": 0, "2026": 2000 }
  },
  monthly: {
    "2024": [],
    "2025": [],
    "2026": [
      { month: "2026-06", total: 1000, living: 1000 },
      { month: "2026-07", total: 1000, living: 1000 }
    ]
  }
};

function record(overrides: Partial<NormalizedExpense>): NormalizedExpense {
  return {
    id: "test-expense",
    sourceType: "expense",
    sourceName: "Receipt capture",
    merchant: "Test merchant",
    date: "2026-07-22",
    category: "food",
    nativeAmount: 480,
    nativeCurrency: "TWD",
    usdValue: 15.48,
    note: "",
    attachmentName: "receipt.txt",
    inputMethod: "text",
    ledgerRevision: 1,
    updatedAt: "2026-07-22T12:00:00.000Z",
    syncStatus: "updated_today",
    isSeed: false,
    ...overrides
  };
}
