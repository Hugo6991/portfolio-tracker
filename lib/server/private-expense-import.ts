import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import type { Expenses, ExpenseMonth } from "../data";
import {
  decodeCsvBuffer,
  mapCsvExpenseCategory,
  parseCsvDocument,
  type ParsedCsvDocument
} from "../csv-import";
import { expenseCategories, normalizeExpenseDate, type ExpenseCategory } from "../expense-records";

export const CNY_TWD_SNAPSHOT_RATE = 4.7655317;
export const CNY_TWD_SNAPSHOT_DATE = "2026-08-13";

export type PrivateExpenseSource = "bank" | "alipay" | "cost_overview";
export type PrivateExpenseDirection = "expense" | "income" | "neutral" | "transfer";
export type PrivateExpenseCurrency = "TWD" | "CNY" | "USD" | "JPY";

export type PrivateExpenseTransaction = {
  record: number | string;
  source: PrivateExpenseSource;
  date: string;
  amount: number;
  currency: PrivateExpenseCurrency;
  direction: PrivateExpenseDirection;
  category: ExpenseCategory;
  fingerprint?: string;
  nativeAmount?: number;
  nativeCurrency?: "CNY" | "USD";
};

export type PrivateExpenseLedger = {
  meta: {
    asOf: string;
    recordCount: number;
    fields: string[];
    privacy: string;
  };
  records: PrivateExpenseTransaction[];
};

export type AlipayImportResult = {
  encoding: ReturnType<typeof decodeCsvBuffer>["encoding"];
  headerRow: number;
  dateMin: string;
  dateMax: string;
  records: PrivateExpenseTransaction[];
};

export type CostOverviewImportResult = {
  month: string;
  mainRows: number;
  subscriptionRows: number;
  totalTwd: number;
  records: PrivateExpenseTransaction[];
};

export type ExpenseForecastResult = {
  rows: ExpenseMonth[];
  candidateMonths: string[];
  excludedMonths: string[];
  sampleMonths: string[];
  monthlyTotal: number | null;
  partialActual: { month: string; through: string; total: number } | null;
};

export function parseAlipayPrivateTransactions(bytes: Uint8Array): AlipayImportResult {
  const decoded = decodeCsvBuffer(toArrayBuffer(bytes));
  const document = parseCsvDocument(decoded.text);
  const mapping = document.suggestedMapping;
  const required = [mapping.date, mapping.category, mapping.direction, mapping.amount, mapping.note];
  if (required.some((column) => !column)) {
    throw new Error("Alipay export is missing one or more required columns: date, category, direction, amount, note");
  }

  const records = document.rows.map((row, index) => alipayRow(document, row, index));
  const dates = records.map((record) => record.date).sort();
  return {
    encoding: decoded.encoding,
    headerRow: document.headerRow,
    dateMin: dates[0],
    dateMax: dates.at(-1)!,
    records
  };
}

export async function parseCostOverviewTransactions(
  bytes: Uint8Array,
  month: string
): Promise<CostOverviewImportResult> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Cost Overview month must use YYYY-MM");

  const workbook = new ExcelJS.Workbook();
  const workbookBytes = Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0];
  await workbook.xlsx.load(workbookBytes);
  const mainSheet = workbook.getWorksheet("2026");
  const subscriptionSheet = workbook.getWorksheet("2026 | Subscription  Service");
  if (!mainSheet || !subscriptionSheet) {
    throw new Error("Cost Overview must contain the 2026 and 2026 | Subscription  Service sheets");
  }

  const workbookDigest = digest(bytes);
  const mainRecords: PrivateExpenseTransaction[] = [];
  mainSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const sequence = cellNumber(row.getCell(1).value);
    const item = cellText(row.getCell(2).value);
    const date = cellDate(row.getCell(3).value);
    const categoryText = cellText(row.getCell(4).value);
    const cny = cellNumber(row.getCell(6).value);
    const twd = cellNumber(row.getCell(7).value);
    const usd = cellNumber(row.getCell(8).value);
    if (!Number.isInteger(sequence) || sequence <= 0 || !date.startsWith(month) || twd <= 0) return;

    mainRecords.push(costOverviewRecord({
      workbookDigest,
      sheet: "2026",
      rowNumber,
      item,
      date,
      twd,
      category: mapCostOverviewCategory(categoryText),
      cny,
      usd
    }));
  });

  const subscriptionRecords: PrivateExpenseTransaction[] = [];
  subscriptionSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const item = cellText(row.getCell(2).value);
    const date = cellDate(row.getCell(3).value);
    const twd = cellNumber(row.getCell(6).value);
    const cny = cellNumber(row.getCell(7).value);
    const usd = cellNumber(row.getCell(8).value);
    if (!item || !date.startsWith(month) || twd <= 0) return;

    subscriptionRecords.push(costOverviewRecord({
      workbookDigest,
      sheet: "2026 | Subscription  Service",
      rowNumber,
      item,
      date,
      twd,
      category: "subscription",
      cny,
      usd
    }));
  });

  const records = [...mainRecords, ...subscriptionRecords];
  return {
    month,
    mainRows: mainRecords.length,
    subscriptionRows: subscriptionRecords.length,
    totalTwd: roundMoney(records.reduce((sum, record) => sum + record.amount, 0)),
    records
  };
}

export function replaceAlipayWindow(
  existing: PrivateExpenseTransaction[],
  incoming: PrivateExpenseTransaction[],
  dateMin: string,
  dateMax: string
) {
  return sortTransactions([
    ...existing.filter((record) => !(record.source === "alipay" && record.date >= dateMin && record.date <= dateMax)),
    ...incoming
  ]);
}

export function replaceCostOverviewMonth(
  existing: PrivateExpenseTransaction[],
  incoming: PrivateExpenseTransaction[],
  month: string
) {
  return sortTransactions([
    ...existing.filter((record) => !(record.source === "cost_overview" && record.date.startsWith(month))),
    ...incoming
  ]);
}

export function buildPrivateExpenseLedger(records: PrivateExpenseTransaction[]): PrivateExpenseLedger {
  const sorted = sortTransactions(records);
  return {
    meta: {
      asOf: sorted.reduce((latest, record) => record.date > latest ? record.date : latest, ""),
      recordCount: sorted.length,
      fields: [
        "record",
        "source",
        "date",
        "amount",
        "currency",
        "direction",
        "category",
        "fingerprint",
        "nativeAmount",
        "nativeCurrency"
      ],
      privacy: "Account, institution, identity, counterparty, description, note, source filename, and transaction identifiers are excluded."
    },
    records: sorted
  };
}

export function updatePublicExpenseAggregates(
  current: Expenses,
  ledger: PrivateExpenseLedger,
  targetMonths: string[]
): Expenses {
  const next = JSON.parse(JSON.stringify(current)) as Expenses;
  const targets = new Set(targetMonths);
  const sums = new Map<string, Map<ExpenseCategory, number>>();

  for (const record of ledger.records) {
    const month = record.date.slice(0, 7);
    if (record.direction !== "expense" || !targets.has(month)) continue;
    const twd = toTwd(record);
    const monthSums = sums.get(month) ?? new Map<ExpenseCategory, number>();
    monthSums.set(record.category, (monthSums.get(record.category) ?? 0) + twd);
    sums.set(month, monthSums);
  }

  for (const [year, rows] of Object.entries(next.monthly)) {
    next.monthly[year as keyof Expenses["monthly"]] = rows.map((row) => {
      if (!targets.has(row.month)) return canonicalizeExpenseMonth(row);
      const monthSums = sums.get(row.month) ?? new Map<ExpenseCategory, number>();
      return aggregateMonth(row.month, monthSums);
    });
  }

  const forecastYear = ledger.meta.asOf.slice(0, 4) as keyof Expenses["monthly"];
  const forecast = forecastFutureExpenseMonths(
    next.monthly[forecastYear] ?? [],
    ledger.meta.asOf,
    8,
    costOverviewForecastFloors(ledger)
  );
  if (next.monthly[forecastYear] && forecast.monthlyTotal !== null) {
    next.monthly[forecastYear] = forecast.rows;
  }

  const alipayAsOf = latestDate(ledger.records.filter((record) => record.source === "alipay"));
  const costOverviewMonths = [...new Set(
    ledger.records
      .filter((record) => record.source === "cost_overview")
      .map((record) => record.date.slice(0, 7))
  )].sort();
  next.meta.actualThrough = ledger.meta.asOf;
  next.meta.partialActuals = forecast.partialActual
    ? { [forecast.partialActual.month]: { through: forecast.partialActual.through, total: forecast.partialActual.total } }
    : {};
  next.meta.note = [
    "Privacy-safe monthly totals from bank, Alipay, and Cost Overview records.",
    `Alipay actuals run through ${alipayAsOf}; Cost Overview includes numbered and recurring-cost rows for ${costOverviewMonths.join(", ")}.`,
    forecast.monthlyTotal === null
      ? "Future-month forecasts retain their existing baseline until enough complete actual months are available."
      : forecast.excludedMonths.length
        ? `Future-month forecasts use the average category mix from the latest ${forecast.candidateMonths.length} complete months, excluding the highest and lowest monthly totals.`
        : `Future-month forecasts use the average category mix from the latest ${forecast.candidateMonths.length} complete months.`,
    forecast.partialActual
      ? `The ${forecast.partialActual.month} total is a full-month projection; actual spending through ${forecast.partialActual.through} is retained separately.`
      : "",
    `CNY is normalized at ${CNY_TWD_SNAPSHOT_RATE} TWD per CNY from the ${CNY_TWD_SNAPSHOT_DATE} snapshot; raw descriptions and account identifiers are excluded.`
  ].filter(Boolean).join(" ");
  next.meta.yearTotals = Object.fromEntries(
    Object.entries(next.monthly).map(([year, rows]) => [
      year,
      roundMoney(rows.reduce((sum, row) => sum + row.total, 0))
    ])
  );
  return next;
}

export function forecastFutureExpenseMonths(
  rows: ExpenseMonth[],
  actualThrough: string,
  lookbackMonths = 8,
  categoryFloors: Partial<Record<ExpenseCategory, number>> = {}
): ExpenseForecastResult {
  const actualMonth = actualThrough.slice(0, 7);
  const partialCurrentMonth = isPartialCalendarMonth(actualThrough);
  const candidateRows = rows
    .filter((row) => (partialCurrentMonth ? row.month < actualMonth : row.month <= actualMonth) && row.total > 0)
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-lookbackMonths);
  const ranked = [...candidateRows].sort((a, b) => a.total - b.total || a.month.localeCompare(b.month));
  const excludedRows = candidateRows.length >= 5 ? [ranked[0], ranked.at(-1)!] : [];
  const excludedMonths = new Set(excludedRows.map((row) => row.month));
  const sampleRows = candidateRows.filter((row) => !excludedMonths.has(row.month));

  if (sampleRows.length < 3) {
    return {
      rows: rows.map(canonicalizeExpenseMonth),
      candidateMonths: candidateRows.map((row) => row.month),
      excludedMonths: [...excludedMonths].sort(),
      sampleMonths: sampleRows.map((row) => row.month),
      monthlyTotal: null,
      partialActual: null
    };
  }

  const categoryAverages = new Map<ExpenseCategory, number>();
  for (const category of expenseCategories) {
    categoryAverages.set(
      category,
      sampleRows.reduce((sum, row) => sum + Number(row[category] ?? 0), 0) / sampleRows.length
    );
  }
  applyCategoryFloors(categoryAverages, categoryFloors);

  const forecastRow = (month: string) => aggregateMonth(month, categoryAverages);
  const actualCurrentRow = rows.find((row) => row.month === actualMonth);
  const partialActual = partialCurrentMonth && actualCurrentRow
    ? { month: actualMonth, through: actualThrough, total: actualCurrentRow.total }
    : null;
  const forecastRows = rows.map((row) => (
    row.month > actualMonth
      ? forecastRow(row.month)
      : row.month === actualMonth && partialActual
        ? projectPartialMonth(row, forecastRow(row.month))
        : canonicalizeExpenseMonth(row)
  ));

  return {
    rows: forecastRows,
    candidateMonths: candidateRows.map((row) => row.month),
    excludedMonths: [...excludedMonths].sort(),
    sampleMonths: sampleRows.map((row) => row.month),
    monthlyTotal: forecastRow(actualMonth).total,
    partialActual
  };
}

function costOverviewForecastFloors(ledger: PrivateExpenseLedger): Partial<Record<ExpenseCategory, number>> {
  const costOverviewExpenses = ledger.records.filter((record) => (
    record.source === "cost_overview" && record.direction === "expense"
  ));
  const latestMonth = costOverviewExpenses.reduce((latest, record) => {
    const month = record.date.slice(0, 7);
    return month > latest ? month : latest;
  }, "");
  const subscription = roundMoney(costOverviewExpenses.reduce((sum, record) => (
    record.date.startsWith(latestMonth) && record.category === "subscription"
      ? sum + toTwd(record)
      : sum
  ), 0));
  return subscription > 0 ? { subscription } : {};
}

function applyCategoryFloors(
  averages: Map<ExpenseCategory, number>,
  floors: Partial<Record<ExpenseCategory, number>>
) {
  let increase = 0;
  for (const category of expenseCategories) {
    if (category === "other") continue;
    const floor = Number(floors[category] ?? 0);
    const current = averages.get(category) ?? 0;
    if (floor <= current) continue;
    averages.set(category, floor);
    increase += floor - current;
  }
  averages.set("other", Math.max(0, (averages.get("other") ?? 0) - increase));
}

function projectPartialMonth(actual: ExpenseMonth, forecast: ExpenseMonth) {
  const sums = new Map<ExpenseCategory, number>();
  for (const category of expenseCategories) {
    sums.set(category, Math.max(Number(actual[category] ?? 0), Number(forecast[category] ?? 0)));
  }
  return aggregateMonth(actual.month, sums);
}

function isPartialCalendarMonth(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return false;
  return day < new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function sha256(bytes: Uint8Array) {
  return digest(bytes);
}

function alipayRow(
  document: ParsedCsvDocument,
  row: Record<string, string>,
  index: number
): PrivateExpenseTransaction {
  const mapping = document.suggestedMapping;
  const rawDate = read(row, mapping.date);
  const date = normalizeExpenseDate(rawDate);
  const amount = parseAmount(read(row, mapping.amount));
  const rawCategory = read(row, mapping.category);
  const rawDirection = read(row, mapping.direction);
  const note = read(row, mapping.note);
  if (!date || amount == null || amount <= 0) {
    throw new Error(`Invalid Alipay transaction at source row ${document.headerRow + index + 2}`);
  }

  const fingerprint = digest([
    "alipay",
    String(document.headerRow + index + 2),
    ...document.headers.map((header) => row[header] ?? "")
  ].join("\u001f"));
  return {
    record: `alipay:${fingerprint.slice(0, 24)}`,
    source: "alipay",
    date,
    amount,
    currency: "CNY",
    direction: mapAlipayDirection(rawDirection, rawCategory),
    category: mapCsvExpenseCategory(rawCategory, note),
    fingerprint
  };
}

function costOverviewRecord(input: {
  workbookDigest: string;
  sheet: string;
  rowNumber: number;
  item: string;
  date: string;
  twd: number;
  category: ExpenseCategory;
  cny: number;
  usd: number;
}): PrivateExpenseTransaction {
  const fingerprint = digest([
    "cost_overview",
    input.workbookDigest,
    input.sheet,
    String(input.rowNumber),
    input.item,
    input.date,
    String(input.twd),
    input.category
  ].join("\u001f"));
  const native = input.cny > 0
    ? { nativeAmount: input.cny, nativeCurrency: "CNY" as const }
    : input.usd > 0
      ? { nativeAmount: input.usd, nativeCurrency: "USD" as const }
      : {};
  return {
    record: `cost-overview:${fingerprint.slice(0, 24)}`,
    source: "cost_overview",
    date: input.date,
    amount: roundMoney(input.twd),
    currency: "TWD",
    direction: "expense",
    category: input.category,
    fingerprint,
    ...native
  };
}

function mapAlipayDirection(rawDirection: string, rawCategory: string): PrivateExpenseDirection {
  const direction = rawDirection.replace(/\s+/g, "");
  if (direction.includes("支出")) return "expense";
  if (direction.includes("收入")) return "income";
  if (direction.includes("不计收支") || direction.includes("不計收支")) {
    return /转账|轉帳/.test(rawCategory) ? "transfer" : "neutral";
  }
  throw new Error(`Unsupported Alipay direction: ${rawDirection || "blank"}`);
}

function mapCostOverviewCategory(raw: string): ExpenseCategory {
  const normalized = raw.toLowerCase();
  if (/learning/.test(normalized)) return "subscription";
  if (/living|life/.test(normalized)) return "living";
  if (/flight|travel/.test(normalized)) return "travel";
  if (/entertainment/.test(normalized)) return "entertainment";
  if (/work|business/.test(normalized)) return "work";
  if (/traffic|car/.test(normalized)) return "traffic";
  if (/shopping|clothe|electronic/.test(normalized)) return "shopping";
  if (/health/.test(normalized)) return "health";
  if (/fitness|sport/.test(normalized)) return "fitness";
  if (/food/.test(normalized)) return "food";
  if (/ai|app|internet|blog|apple|loan/.test(normalized)) return "subscription";
  return "other";
}

function aggregateMonth(month: string, sums: Map<ExpenseCategory, number>): ExpenseMonth {
  const rawTotal = [...sums.values()].reduce((sum, value) => sum + value, 0);
  const total = roundMoney(rawTotal);
  const rounded = new Map<ExpenseCategory, number>();
  for (const category of expenseCategories) {
    const value = roundMoney(sums.get(category) ?? 0);
    if (value > 0) rounded.set(category, value);
  }
  const roundedCategoryTotal = [...rounded.values()].reduce((sum, value) => sum + value, 0);
  const residual = roundMoney(total - roundedCategoryTotal);
  if (residual !== 0) rounded.set("other", roundMoney((rounded.get("other") ?? 0) + residual));

  const row: ExpenseMonth = { month, total };
  for (const category of expenseCategories) {
    const value = rounded.get(category) ?? 0;
    if (value > 0) row[category] = value;
  }
  return row;
}

const legacyCategoryAliases: Record<string, ExpenseCategory> = {
  car: "traffic",
  parking: "traffic",
  lifeExpense: "living",
  dailyCost: "living",
  ai: "subscription",
  flight: "travel"
};

function canonicalizeExpenseMonth(row: ExpenseMonth): ExpenseMonth {
  const next: ExpenseMonth = { month: row.month, total: row.total };
  for (const category of expenseCategories) {
    const value = Number(row[category] ?? 0);
    if (value > 0) next[category] = value;
  }
  for (const [legacy, category] of Object.entries(legacyCategoryAliases)) {
    if (Number(next[category] ?? 0) > 0) continue;
    const value = Number(row[legacy] ?? 0);
    if (value > 0) next[category] = value;
  }
  return next;
}

function toTwd(record: PrivateExpenseTransaction) {
  if (record.currency === "TWD") return record.amount;
  if (record.currency === "CNY") return record.amount * CNY_TWD_SNAPSHOT_RATE;
  throw new Error(`Unsupported expense currency in private ledger: ${record.currency}`);
}

function sortTransactions(records: PrivateExpenseTransaction[]) {
  return [...records].sort((a, b) => (
    b.date.localeCompare(a.date)
    || a.source.localeCompare(b.source)
    || String(a.record).localeCompare(String(b.record))
  ));
}

function latestDate(records: PrivateExpenseTransaction[]) {
  return records.reduce((latest, record) => record.date > latest ? record.date : latest, "") || "unknown";
}

function read(row: Record<string, string>, column: string) {
  return String(row[column] ?? "").trim();
}

function parseAmount(raw: string) {
  const normalized = raw.replace(/[，,\s]/g, "").replace(/[^\d.+-]/g, "");
  if (!normalized) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? Math.abs(value) : null;
}

function cellNumber(value: unknown): number {
  const unwrapped = unwrapCellValue(value);
  if (typeof unwrapped === "number" && Number.isFinite(unwrapped)) return unwrapped;
  if (typeof unwrapped === "string") {
    const parsed = parseAmount(unwrapped);
    return parsed ?? 0;
  }
  return 0;
}

function cellText(value: unknown) {
  const unwrapped = unwrapCellValue(value);
  if (typeof unwrapped === "string") return unwrapped.trim();
  if (typeof unwrapped === "number") return String(unwrapped);
  if (unwrapped && typeof unwrapped === "object" && "text" in unwrapped) {
    return String((unwrapped as { text?: unknown }).text ?? "").trim();
  }
  if (unwrapped && typeof unwrapped === "object" && "richText" in unwrapped) {
    const rich = (unwrapped as { richText?: Array<{ text?: string }> }).richText ?? [];
    return rich.map((part) => part.text ?? "").join("").trim();
  }
  return "";
}

function cellDate(value: unknown) {
  const unwrapped = unwrapCellValue(value);
  if (unwrapped instanceof Date) return unwrapped.toISOString().slice(0, 10);
  if (typeof unwrapped === "number" && Number.isFinite(unwrapped)) {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(unwrapped) * 86_400_000).toISOString().slice(0, 10);
  }
  if (typeof unwrapped === "string") return normalizeExpenseDate(unwrapped);
  return "";
}

function unwrapCellValue(value: unknown): unknown {
  if (value && typeof value === "object" && "result" in value) {
    return (value as { result?: unknown }).result;
  }
  return value;
}

function toArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function digest(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
