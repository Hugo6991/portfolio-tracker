import type { ExpenseLedgerMonth, ExpenseLedgerSummary, Expenses } from "./data";
import type { Currency } from "./fx";
import { twdToUsd, usdToTwd } from "./fx";

export const expenseStorageKey = "portfolio.expense-records.v1";

export const expenseCategories = [
  "food",
  "traffic",
  "living",
  "subscription",
  "work",
  "entertainment",
  "fitness",
  "travel",
  "health",
  "shopping",
  "other"
] as const;

export type ExpenseCategory = (typeof expenseCategories)[number];
export type ExpenseInputMethod = "camera" | "image-ocr" | "pdf-text" | "pdf-ocr" | "csv" | "text" | "manual";
export type ExpenseNativeCurrency = Currency | "CNY";
export type ExpenseSourceName =
  | "Receipt capture"
  | "Manual entry"
  | "Bank CSV"
  | "Money Book CSV"
  | "Alipay CSV"
  | "WeChat Pay CSV";

const expenseSourceNames: ExpenseSourceName[] = [
  "Receipt capture",
  "Manual entry",
  "Bank CSV",
  "Money Book CSV",
  "Alipay CSV",
  "WeChat Pay CSV"
];

const expenseInputMethods: ExpenseInputMethod[] = [
  "camera",
  "image-ocr",
  "pdf-text",
  "pdf-ocr",
  "csv",
  "text",
  "manual"
];

export type NormalizedExpense = {
  id: string;
  sourceType: "expense";
  sourceName: ExpenseSourceName;
  merchant: string;
  date: string;
  category: ExpenseCategory;
  nativeAmount: number;
  nativeCurrency: ExpenseNativeCurrency;
  usdValue: number;
  note: string;
  attachmentName: string | null;
  inputMethod: ExpenseInputMethod;
  paymentSource?: 'infini' | 'plasma';
  settlementStatus?: 'settled' | 'authorized' | 'failed';
  cardLast4?: string;
  ledgerRevision?: number;
  sheetRefs?: Array<{ spreadsheetId: string; sheetId: string; rowKey: string }>;
  sourceRecordId?: string;
  importFingerprint?: string;
  updatedAt: string;
  syncStatus: "updated_today";
  isSeed: false;
};

export type ExpenseDraft = {
  merchant: string;
  date: string;
  amount: string;
  currency: Currency;
  category: ExpenseCategory;
  note: string;
};

export type ReceiptParseResult = {
  draft: ExpenseDraft;
  confidence: "high" | "medium" | "low";
  detectedFields: number;
};

const categoryLabels: Record<ExpenseCategory, string> = {
  food: "Food & dining",
  traffic: "Transport",
  living: "Home & utilities",
  subscription: "Subscriptions",
  work: "Work",
  entertainment: "Entertainment",
  fitness: "Fitness",
  travel: "Travel",
  health: "Health",
  shopping: "Shopping",
  other: "Other"
};

const categoryAliases: Record<string, ExpenseCategory> = {
  food: "food",
  traffic: "traffic",
  car: "traffic",
  parking: "traffic",
  living: "living",
  lifeExpense: "living",
  dailyCost: "living",
  subscription: "subscription",
  ai: "subscription",
  work: "work",
  entertainment: "entertainment",
  fitness: "fitness",
  flight: "travel"
};

export function formatExpenseCategory(category: string) {
  const normalized = categoryAliases[category] ?? (expenseCategories.includes(category as ExpenseCategory) ? category : "other");
  return categoryLabels[normalized as ExpenseCategory];
}

export function parseReceiptText(text: string, fileName = ""): ReceiptParseResult {
  const cleanText = text.replaceAll("\u0000", " ").replace(/[ \t]+/g, " ");
  const lines = cleanText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const currency = detectCurrency(cleanText);
  const amount = detectAmount(lines);
  const date = detectDate(cleanText);
  const merchant = detectMerchant(lines, fileName);
  const category = inferExpenseCategory(`${merchant}\n${cleanText}`);
  const detectedFields = [amount != null, Boolean(date), Boolean(merchant)].filter(Boolean).length;

  return {
    draft: {
      merchant: merchant || fileName.replace(/\.[^.]+$/, "") || "Unknown merchant",
      date: date || todayIso(),
      amount: amount == null ? "" : String(amount),
      currency,
      category,
      note: ""
    },
    confidence: detectedFields === 3 ? "high" : detectedFields === 2 ? "medium" : "low",
    detectedFields
  };
}

export function createBlankExpenseDraft(): ExpenseDraft {
  return {
    merchant: "",
    date: todayIso(),
    amount: "",
    currency: "TWD",
    category: "other",
    note: ""
  };
}

export function createNormalizedExpense(
  draft: ExpenseDraft,
  fxRate: number,
  options: { attachmentName?: string | null; inputMethod: ExpenseInputMethod }
): NormalizedExpense {
  const nativeAmount = Number(draft.amount);
  if (!Number.isFinite(nativeAmount) || nativeAmount <= 0) throw new Error("Enter an amount greater than 0");
  if (!draft.merchant.trim()) throw new Error("Enter a merchant or payee");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) throw new Error("Enter a valid transaction date");

  const updatedAt = new Date().toISOString();
  const sourceName = options.inputMethod === "manual" ? "Manual entry" : "Receipt capture";
  const importFingerprint = createExpenseFingerprint({
    sourceName,
    merchant: draft.merchant,
    date: draft.date,
    nativeAmount,
    nativeCurrency: draft.currency,
    note: draft.note
  });
  return {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `expense-${Date.now()}`,
    sourceType: "expense",
    sourceName,
    merchant: draft.merchant.trim(),
    date: draft.date,
    category: draft.category,
    nativeAmount,
    nativeCurrency: draft.currency,
    usdValue: draft.currency === "USD" ? nativeAmount : twdToUsd(nativeAmount, fxRate),
    note: draft.note.trim(),
    attachmentName: options.attachmentName || null,
    inputMethod: options.inputMethod,
    importFingerprint,
    updatedAt,
    syncStatus: "updated_today",
    isSeed: false
  };
}

export function createExpenseFingerprint(
  record: Pick<NormalizedExpense, "sourceName" | "merchant" | "date" | "nativeAmount" | "nativeCurrency" | "note">
) {
  const identity = [
    record.sourceName,
    record.date,
    record.merchant,
    Number(record.nativeAmount).toFixed(4),
    record.nativeCurrency,
    record.note
  ]
    .map((value) => String(value).trim().toLowerCase().replace(/\s+/g, " "))
    .join("|");
  return stableExpenseHash(identity);
}

export function getExpenseRecordIdentity(record: NormalizedExpense) {
  const cardFingerprint = record.importFingerprint?.trim().toLowerCase().match(/^(infini|plasma):(.+)$/);
  const paymentSource = record.paymentSource || cardFingerprint?.[1];
  const transactionId = record.sourceRecordId?.trim().toLowerCase() || cardFingerprint?.[2];
  if (paymentSource && transactionId) return `${paymentSource}:${transactionId}`;
  if (record.importFingerprint) return `import:${record.importFingerprint}`;
  if (record.sourceRecordId) {
    return `source:${record.sourceName.toLowerCase()}:${record.sourceRecordId.trim().toLowerCase()}`;
  }
  // Match the canonical ledger fallback. Records without a provider or import
  // identity are distinct transactions unless they reuse the same record ID.
  return `record:${record.id}`;
}

export function dedupeExpenseRecords(records: NormalizedExpense[]) {
  const ids = new Set<string>();
  const identities = new Set<string>();
  return [...records]
    .sort((a, b) => {
      const proofDifference = Number(isConfirmedExpenseRecord(b)) - Number(isConfirmedExpenseRecord(a));
      if (proofDifference) return proofDifference;
      const revisionDifference = (b.ledgerRevision ?? 0) - (a.ledgerRevision ?? 0);
      return revisionDifference || b.updatedAt.localeCompare(a.updatedAt);
    })
    .filter((record) => {
      const identity = getExpenseRecordIdentity(record);
      if (ids.has(record.id) || identities.has(identity)) return false;
      ids.add(record.id);
      identities.add(identity);
      return true;
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt));
}

export function selectNewExpenseRecords(
  incoming: NormalizedExpense[],
  existing: NormalizedExpense[]
) {
  const existingById = new Map(existing.map((record) => [record.id, record]));
  const existingIdentities = new Set(existing.map(getExpenseRecordIdentity));
  const batchIds = new Set<string>();
  const batchIdentities = new Set<string>();
  const accepted: NormalizedExpense[] = [];
  const duplicateIds: string[] = [];

  for (const record of incoming) {
    const identity = getExpenseRecordIdentity(record);
    const existingRecord = existingById.get(record.id);
    const repeatedInBatch = batchIds.has(record.id) || batchIdentities.has(identity);
    const unchangedExistingId = existingRecord && existingRecord.updatedAt >= record.updatedAt;
    const repeatedIdentity = !existingRecord && existingIdentities.has(identity);

    if (repeatedInBatch || unchangedExistingId || repeatedIdentity) {
      duplicateIds.push(record.id);
      continue;
    }

    accepted.push(record);
    batchIds.add(record.id);
    batchIdentities.add(identity);
  }

  return { accepted, duplicateIds };
}

export function loadExpenseRecords(): NormalizedExpense[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = JSON.parse(window.localStorage.getItem(expenseStorageKey) || "[]");
    if (!Array.isArray(stored)) return [];
    return stored.filter(isNormalizedExpense).sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

export function saveExpenseRecords(records: NormalizedExpense[]) {
  window.localStorage.setItem(expenseStorageKey, JSON.stringify(records));
  window.dispatchEvent(new CustomEvent("portfolio:expenses-updated"));
}

export function attachExpenseLedgerSummary(expenses: Expenses, records: NormalizedExpense[], fxRate: number): Expenses {
  const monthly = Object.fromEntries(
    Object.entries(expenses.monthly).map(([year, rows]) => [
      year,
      rows.map(normalizeExpenseMonth)
    ])
  ) as Expenses["monthly"];
  const ledgerMonths = new Map<string, ExpenseLedgerMonth>();
  const confirmedRecords = getConfirmedExpenseRecords(records);

  for (const record of confirmedRecords) {
    const month = record.date.slice(0, 7);
    const twdValue = expenseToTwd(record, fxRate);
    const current = ledgerMonths.get(month) ?? {
      month,
      through: record.date,
      total: 0,
      recordCount: 0,
      categories: {}
    };
    current.through = record.date > current.through ? record.date : current.through;
    current.total += twdValue;
    current.recordCount += 1;
    current.categories[record.category] = (current.categories[record.category] ?? 0) + twdValue;
    ledgerMonths.set(month, current);
  }

  const ledgerMonthly = Object.fromEntries(
    [...ledgerMonths].map(([month, summary]) => [month, {
      ...summary,
      total: roundExpenseAmount(summary.total),
      categories: Object.fromEntries(
        Object.entries(summary.categories).map(([category, total]) => [category, roundExpenseAmount(total)])
      )
    }])
  );
  const ledgerYearTotals = Object.values(ledgerMonthly).reduce<Record<string, number>>((totals, summary) => {
    const year = summary.month.slice(0, 4);
    totals[year] = roundExpenseAmount((totals[year] ?? 0) + summary.total);
    return totals;
  }, {});

  const ledger: ExpenseLedgerSummary = {
    latestTransactionDate: confirmedRecords.reduce<string | undefined>(
      (latest, record) => !latest || record.date > latest ? record.date : latest,
      undefined
    ),
    total: roundExpenseAmount(Object.values(ledgerMonthly).reduce((sum, summary) => sum + summary.total, 0)),
    recordCount: confirmedRecords.length,
    yearTotals: ledgerYearTotals,
    monthly: ledgerMonthly
  };

  return { ...expenses, meta: { ...expenses.meta }, monthly, ledger };
}

export function expenseToTwd(record: NormalizedExpense, fxRate: number) {
  return record.nativeCurrency === "TWD" ? record.nativeAmount : usdToTwd(record.usdValue, fxRate);
}

function detectCurrency(text: string): Currency {
  if (/\b(?:USD|US\$)\b/i.test(text)) return "USD";
  if (/(?:NT\$|TWD|NTD|新台幣|新臺幣|元)/i.test(text)) return "TWD";
  return "TWD";
}

function detectAmount(lines: string[]) {
  const totalPattern = /(grand total|amount due|balance due|total due|total|合計|總計|应付|應付|金額|实付|實付)/i;
  const subtotalPattern = /(subtotal|小計|税前|稅前)/i;
  const candidates: Array<{ value: number; score: number }> = [];

  lines.forEach((line, index) => {
    const normalized = line.replace(/\s/g, "");
    const values = extractNumbers(normalized);
    const hasTotal = totalPattern.test(line);
    const hasCurrency = /(?:NT\$|TWD|NTD|US\$|USD|\$|元)/i.test(line);
    const isSubtotal = subtotalPattern.test(line);
    for (const value of values) {
      if (value <= 0 || value > 100_000_000) continue;
      let score = 0;
      if (hasTotal) score += 8;
      if (hasCurrency) score += 3;
      if (isSubtotal) score -= 5;
      if (index >= lines.length - 6) score += 1;
      if (/\.\d{2}\b/.test(line)) score += 1;
      if (!hasTotal && !hasCurrency && values.length > 2) score -= 2;
      candidates.push({ value, score });
    }
  });

  const usable = candidates.filter((item) => item.score >= 2);
  if (!usable.length) return null;
  usable.sort((a, b) => b.score - a.score || b.value - a.value);
  return usable[0].value;
}

function extractNumbers(line: string) {
  const matches = line.match(/-?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?/g) ?? [];
  return matches
    .map((value) => Number(value.replaceAll(",", "")))
    .filter((value) => Number.isFinite(value));
}

export function normalizeExpenseDate(text: string) {
  const western = text.match(/\b(20\d{2})[/.-](\d{1,2})[/.-](\d{1,2})\b/);
  if (western) return toIsoDate(Number(western[1]), Number(western[2]), Number(western[3]));

  const roc = text.match(/\b(1\d{2})[/.-](\d{1,2})[/.-](\d{1,2})\b/);
  if (roc) return toIsoDate(Number(roc[1]) + 1911, Number(roc[2]), Number(roc[3]));

  const reversed = text.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](20\d{2})\b/);
  if (reversed) return toIsoDate(Number(reversed[3]), Number(reversed[1]), Number(reversed[2]));

  const chinese = text.match(/\b(20\d{2})年(\d{1,2})月(\d{1,2})日?/);
  if (chinese) return toIsoDate(Number(chinese[1]), Number(chinese[2]), Number(chinese[3]));

  return "";
}

const detectDate = normalizeExpenseDate;

function detectMerchant(lines: string[], fileName: string) {
  const ignored = /(invoice|receipt|tax|vat|發票|发票|收據|收据|統一編號|统一编号|電話|电话|tel|地址|date|日期|total|合計|總計)/i;
  const candidate = lines.slice(0, 12).find((line) => {
    if (line.length < 2 || line.length > 64 || ignored.test(line)) return false;
    const digits = (line.match(/\d/g) ?? []).length;
    return digits / line.length < 0.45 && /[A-Za-z\u3400-\u9fff]/.test(line);
  });
  return candidate?.replace(/^[^A-Za-z\u3400-\u9fff]+|[^A-Za-z0-9\u3400-\u9fff.&'\- ]+$/g, "").trim()
    || fileName.replace(/\.[^.]+$/, "").replaceAll(/[_-]+/g, " ").trim();
}

export function inferExpenseCategory(text: string): ExpenseCategory {
  const normalized = text.toLowerCase();
  const rules: Array<[ExpenseCategory, RegExp]> = [
    ["food", /(restaurant|cafe|coffee|food|meal|ubereats|foodpanda|餐廳|餐厅|咖啡|飲料|饮料|便當|便当|超商|便利商店)/i],
    ["traffic", /(uber|taxi|metro|train|bus|parking|fuel|gas station|捷運|捷运|計程車|计程车|停車|停车|加油)/i],
    ["subscription", /(subscription|netflix|spotify|youtube|icloud|google one|openai|anthropic|月費|月费|訂閱|订阅)/i],
    ["travel", /(hotel|airbnb|airline|flight|booking.com|agoda|飯店|饭店|旅館|旅馆|機票|机票)/i],
    ["health", /(hospital|clinic|pharmacy|doctor|dental|醫院|医院|診所|诊所|藥局|药局)/i],
    ["fitness", /(gym|fitness|yoga|運動|运动|健身)/i],
    ["entertainment", /(cinema|movie|game|concert|電影|电影|遊戲|游戏|演唱會|演唱会)/i],
    ["work", /(office|cowork|software|domain|hosting|辦公|办公|工作)/i],
    ["shopping", /(store|shop|mall|amazon|shopee|momo|百貨|百货|購物|购物)/i],
    ["living", /(electric|water bill|utility|rent|internet|電費|电费|水費|水费|房租|網路|网络)/i]
  ];
  return rules.find(([, pattern]) => pattern.test(normalized))?.[0] ?? "other";
}

function toIsoDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function todayIso() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function stableExpenseHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function isNormalizedExpense(value: unknown): value is NormalizedExpense {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<NormalizedExpense>;
  return typeof record.id === "string"
    && record.id.length > 0
    && typeof record.merchant === "string"
    && record.merchant.length > 0
    && typeof record.date === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(record.date)
    && typeof record.category === "string"
    && expenseCategories.includes(record.category as ExpenseCategory)
    && typeof record.nativeAmount === "number"
    && Number.isFinite(record.nativeAmount)
    && record.nativeAmount > 0
    && (record.nativeCurrency === "USD" || record.nativeCurrency === "TWD" || record.nativeCurrency === "CNY")
    && typeof record.usdValue === "number"
    && Number.isFinite(record.usdValue)
    && record.usdValue >= 0
    && typeof record.sourceName === "string"
    && expenseSourceNames.includes(record.sourceName as ExpenseSourceName)
    && typeof record.inputMethod === "string"
    && expenseInputMethods.includes(record.inputMethod as ExpenseInputMethod)
    && typeof record.updatedAt === "string"
    && (record.ledgerRevision === undefined
      || (Number.isInteger(record.ledgerRevision) && (record.ledgerRevision ?? 0) > 0))
    && (record.paymentSource === undefined || record.paymentSource === 'infini' || record.paymentSource === 'plasma')
    && (record.settlementStatus === undefined || ['settled', 'authorized', 'failed'].includes(record.settlementStatus))
    && (record.sourceRecordId === undefined || typeof record.sourceRecordId === 'string')
    && (record.importFingerprint === undefined || typeof record.importFingerprint === 'string')
    && (record.cardLast4 === undefined || (typeof record.cardLast4 === 'string' && /^\d{4}$/.test(record.cardLast4)))
    && (record.sheetRefs === undefined || (Array.isArray(record.sheetRefs) && record.sheetRefs.length <= 20
      && record.sheetRefs.every(ref => ref && ['spreadsheetId', 'sheetId', 'rowKey'].every(key =>
        typeof ref[key as keyof typeof ref] === 'string' && ref[key as keyof typeof ref].trim().length > 0))));
}

function normalizeExpenseMonth(row: Expenses["monthly"]["2026"][number]) {
  const normalized: Expenses["monthly"]["2026"][number] = { month: row.month, total: row.total };
  const canonicalCategories = new Set(
    expenseCategories.filter((category) => Number(row[category] ?? 0) > 0)
  );
  for (const [key, value] of Object.entries(row)) {
    if (key === "month" || key === "total" || Number(value) <= 0) continue;
    const category = categoryAliases[key] ?? key;
    if (key !== category && canonicalCategories.has(category as ExpenseCategory)) continue;
    normalized[category] = Number(normalized[category] ?? 0) + Number(value);
  }
  return normalized;
}

export function getConfirmedExpenseRecords(records: NormalizedExpense[]) {
  const byId = new Map<string, NormalizedExpense>();
  for (const record of records) {
    if (!isConfirmedExpenseRecord(record)) continue;
    const current = byId.get(record.id);
    if (!current
      || (record.ledgerRevision ?? 0) > (current.ledgerRevision ?? 0)
      || ((record.ledgerRevision ?? 0) === (current.ledgerRevision ?? 0)
        && record.updatedAt > current.updatedAt)) {
      byId.set(record.id, record);
    }
  }
  return [...byId.values()]
    .sort((left, right) => right.date.localeCompare(left.date) || right.updatedAt.localeCompare(left.updatedAt));
}

export function isConfirmedExpenseRecord(record: NormalizedExpense) {
  return Number.isInteger(record.ledgerRevision)
    && (record.ledgerRevision ?? 0) > 0
    && (record.settlementStatus === undefined || record.settlementStatus === "settled");
}

function roundExpenseAmount(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
