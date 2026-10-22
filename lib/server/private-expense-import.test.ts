import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { Expenses, ExpenseMonth } from "../data";
import {
  buildPrivateExpenseLedger,
  forecastFutureExpenseMonths,
  parseAlipayPrivateTransactions,
  parseCostOverviewTransactions,
  replaceAlipayWindow,
  replaceCostOverviewMonth,
  updatePublicExpenseAggregates,
  type PrivateExpenseTransaction
} from "./private-expense-import";

describe("private expense imports", () => {
  it("parses every Alipay direction and replaces only its covered window", () => {
    const csv = [
      "特别提示：",
      "记录时间,分类,收支类型,金额,备注",
      "2026-08-01 10:00:00,餐饮,支出,12.50,咖啡",
      "2026-08-02 10:00:00,退款,不计收支,5.00,退款",
      "2026-08-03 10:00:00,转账,收入,100.00,转入"
    ].join("\n");
    const imported = parseAlipayPrivateTransactions(new TextEncoder().encode(csv));
    const existing = [
      transaction({ record: 1, source: "alipay", date: "2026-07-31" }),
      transaction({ record: 2, source: "alipay", date: "2026-08-02" }),
      transaction({ record: 3, source: "bank", date: "2026-08-02" })
    ];
    const replaced = replaceAlipayWindow(existing, imported.records, imported.dateMin, imported.dateMax);

    expect(imported.records.map((record) => record.direction)).toEqual(["expense", "neutral", "income"]);
    expect(imported.records[0]).toMatchObject({ currency: "CNY", category: "food", amount: 12.5 });
    expect(replaced).toHaveLength(5);
    expect(replaced).toContainEqual(expect.objectContaining({ record: 1 }));
    expect(replaced).toContainEqual(expect.objectContaining({ record: 3 }));
    expect(replaced).not.toContainEqual(expect.objectContaining({ record: 2 }));
  });

  it("selects numbered August rows plus every August subscription and excludes projections", async () => {
    const workbook = new ExcelJS.Workbook();
    const main = workbook.addWorksheet("2026");
    main.addRow([1, "Learning", new Date("2026-08-07T00:00:00Z"), "Learning", null, null, 5380]);
    main.addRow([2, "Rent paid", new Date("2026-08-16T00:00:00Z"), "Living", null, 23100, 105105]);
    main.addRow([null, "Rent projection", new Date("2026-08-07T00:00:00Z"), "Living", null, 7700, 35035]);
    main.addRow([3, "September", new Date("2026-09-01T00:00:00Z"), "Travel", null, null, 9000]);
    const subscriptions = workbook.addWorksheet("2026 | Subscription  Service");
    subscriptions.addRow([null, "Software", new Date("2026-08-03T00:00:00Z"), "AI App", null, 331]);
    subscriptions.getCell("B1").value = { text: "Software", hyperlink: "https://example.com/billing" };
    subscriptions.addRow([null, "Loan", new Date("2026-08-12T00:00:00Z"), "Loan", null, 4843]);
    subscriptions.addRow([null, "September Software", new Date("2026-09-03T00:00:00Z"), "AI App", null, 331]);
    const buffer = await workbook.xlsx.writeBuffer();

    const imported = await parseCostOverviewTransactions(
      Uint8Array.from(buffer as unknown as ArrayLike<number>),
      "2026-08"
    );

    expect(imported).toMatchObject({ mainRows: 2, subscriptionRows: 2, totalTwd: 115659 });
    expect(imported.records.map((record) => record.category)).toEqual([
      "subscription",
      "living",
      "subscription",
      "subscription"
    ]);
    expect(imported.records.find((record) => record.amount === 105105)).toMatchObject({
      nativeAmount: 23100,
      nativeCurrency: "CNY"
    });
  });

  it("replaces Cost Overview by source month and adds sources without cross-source matching", () => {
    const oldCost = transaction({ record: "old", source: "cost_overview", date: "2026-08-01", amount: 100 });
    const bank = transaction({ record: "bank", source: "bank", date: "2026-08-01", amount: 100 });
    const incoming = transaction({ record: "new", source: "cost_overview", date: "2026-08-01", amount: 100 });
    const records = replaceCostOverviewMonth([oldCost, bank], [incoming], "2026-08");
    const ledger = buildPrivateExpenseLedger(records);
    const updated = updatePublicExpenseAggregates(seedExpenses(), ledger, ["2026-08"]);

    expect(records).toHaveLength(2);
    expect(records).not.toContainEqual(expect.objectContaining({ record: "old" }));
    expect(updated.monthly["2026"][7]).toEqual({ month: "2026-08", total: 200, food: 200 });
    expect(updated.monthly["2026"][9]).toEqual({
      month: "2026-10",
      total: 56686,
      living: 35035,
      subscription: 21651
    });
  });

  it("forecasts future months from a trimmed average of recent complete months", () => {
    const rows = Array.from({ length: 12 }, (_, index): ExpenseMonth => {
      const month = `2026-${String(index + 1).padStart(2, "0")}`;
      const total = index < 8 ? (index + 1) * 100 : 50;
      return { month, total, food: total / 2, other: total / 2 };
    });

    const forecast = forecastFutureExpenseMonths(rows, "2026-09-02", 8, { subscription: 120 });

    expect(forecast.candidateMonths).toHaveLength(8);
    expect(forecast.excludedMonths).toEqual(["2026-01", "2026-08"]);
    expect(forecast.sampleMonths).toEqual([
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07"
    ]);
    expect(forecast.monthlyTotal).toBe(450);
    expect(forecast.partialActual).toEqual({ month: "2026-09", through: "2026-09-02", total: 50 });
    expect(forecast.rows[8]).toEqual({
      month: "2026-09",
      total: 450,
      food: 225,
      subscription: 120,
      other: 105
    });
    expect(forecast.rows.slice(9)).toEqual([
      { month: "2026-10", total: 450, food: 225, subscription: 120, other: 105 },
      { month: "2026-11", total: 450, food: 225, subscription: 120, other: 105 },
      { month: "2026-12", total: 450, food: 225, subscription: 120, other: 105 }
    ]);
  });
});

function transaction(overrides: Partial<PrivateExpenseTransaction>): PrivateExpenseTransaction {
  return {
    record: "record",
    source: "alipay",
    date: "2026-08-01",
    amount: 100,
    currency: "TWD",
    direction: "expense",
    category: "food",
    ...overrides
  };
}

function seedExpenses(): Expenses {
  const year = (value: string) => Array.from({ length: 12 }, (_, index): ExpenseMonth => ({
    month: `${value}-${String(index + 1).padStart(2, "0")}`,
    total: 0
  }));
  const current2026 = year("2026");
  current2026[9] = {
    month: "2026-10",
    total: 56686,
    dailyCost: 35035,
    living: 35035,
    subscription: 21651
  };
  return {
    meta: { currency: "TWD", note: "seed", actualThrough: "2026-07-31", yearTotals: { "2024": 0, "2025": 0, "2026": 56686 } },
    monthly: { "2024": year("2024"), "2025": year("2025"), "2026": current2026 }
  };
}
