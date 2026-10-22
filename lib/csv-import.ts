import Papa from "papaparse";
import {
  inferExpenseCategory,
  normalizeExpenseDate,
  type ExpenseNativeCurrency,
  type ExpenseSourceName,
  type NormalizedExpense
} from "./expense-records";

export type CsvSourceKind = "bank" | "moneybook" | "alipay" | "wechat";
export type CsvDirection = "expense" | "income" | "neutral" | "unknown";
export type CsvEncoding = "UTF-8" | "GB18030" | "Big5";

export type CsvColumnMapping = {
  date: string;
  merchant: string;
  category: string;
  amount: string;
  debit: string;
  credit: string;
  direction: string;
  currency: string;
  note: string;
  transactionId: string;
};

export type ParsedCsvDocument = {
  headers: string[];
  rows: Array<Record<string, string>>;
  suggestedMapping: CsvColumnMapping;
  headerRow: number;
  delimiter: string;
  warnings: string[];
};

export type CsvPreviewRow = {
  rowNumber: number;
  date: string;
  merchant: string;
  amount: number | null;
  currency: ExpenseNativeCurrency;
  usdValue: number | null;
  category: ReturnType<typeof inferExpenseCategory>;
  direction: CsvDirection;
  note: string;
  transactionId: string;
  fingerprint: string;
  duplicate: boolean;
  included: boolean;
  errors: string[];
};

export type CsvFxRates = {
  twdPerUsd: number;
  cnyPerUsd: number;
};

const mappingKeys: Array<keyof CsvColumnMapping> = [
  "date",
  "merchant",
  "category",
  "debit",
  "credit",
  "amount",
  "direction",
  "currency",
  "note",
  "transactionId"
];

const aliases: Record<keyof CsvColumnMapping, string[]> = {
  date: [
    "交易日期", "交易時間", "交易时间", "付款時間", "付款时间", "消费日期", "消費日期",
    "记账时间", "記帳時間", "记录时间", "記錄時間", "入账日期", "入帳日期",
    "transactiondate", "datetime", "date", "time"
  ],
  merchant: [
    "交易對方", "交易对方", "商店名稱", "商店名称", "交易說明", "交易说明", "消費說明",
    "消费说明", "摘要", "名稱", "項目", "项目", "商品名稱", "商品名称", "description", "merchant", "payee", "counterparty"
  ],
  category: ["分類", "分类", "消費分類", "消费分类", "category", "expensecategory"],
  amount: [
    "交易金額", "交易金额", "金額", "金额", "金額元", "金额元", "實付金額", "实付金额",
    "臺幣金額", "台幣金額", "amount", "transactionamount", "paidamount"
  ],
  debit: [
    "支出金額", "支出金额", "提款金額", "提款金额", "扣款金額", "扣款金额", "debit", "withdrawal", "moneyout"
  ],
  credit: [
    "收入金額", "收入金额", "存入金額", "存入金额", "入帳金額", "入账金额", "credit", "deposit", "moneyin"
  ],
  direction: [
    "收支", "收支類型", "收支类型", "收支方向", "交易類型", "交易类型", "資金流向", "资金流向",
    "type", "direction", "inout"
  ],
  currency: ["幣別", "币别", "貨幣", "货币", "currency", "currencycode"],
  note: [
    "備註", "备注", "附言", "商品", "商品說明", "商品说明", "交易備註", "交易备注", "memo", "note", "remark"
  ],
  transactionId: [
    "交易序號", "交易编号", "交易編號", "訂單號", "订单号", "商戶訂單號", "商户订单号",
    "交易單號", "交易单号", "transactionid", "transactionno", "orderno", "id"
  ]
};

const sourceNames: Record<CsvSourceKind, ExpenseSourceName> = {
  bank: "Bank CSV",
  moneybook: "Money Book CSV",
  alipay: "Alipay CSV",
  wechat: "WeChat Pay CSV"
};

export function defaultCurrencyForSource(source: CsvSourceKind): ExpenseNativeCurrency {
  return source === "bank" || source === "moneybook" ? "TWD" : "CNY";
}

export function decodeCsvBuffer(buffer: ArrayBuffer): { text: string; encoding: CsvEncoding } {
  const utf8 = new TextDecoder("utf-8").decode(buffer).replace(/^\uFEFF/, "");
  const utf8Errors = replacementCharacterCount(utf8);
  if (utf8Errors === 0) return { text: utf8, encoding: "UTF-8" };

  const candidates: Array<{ text: string; encoding: CsvEncoding; score: number }> = [
    { text: utf8, encoding: "UTF-8", score: decodedCsvScore(utf8) }
  ];
  for (const [label, encoding] of [["gb18030", "GB18030"], ["big5", "Big5"]] as const) {
    try {
      const text = new TextDecoder(label).decode(buffer).replace(/^\uFEFF/, "");
      candidates.push({ text, encoding, score: decodedCsvScore(text) });
    } catch {
      // Legacy encodings are optional in older runtimes.
    }
  }

  const best = candidates.sort((a, b) => b.score - a.score)[0];
  return { text: best.text, encoding: best.encoding };
}

export function parseCsvDocument(text: string): ParsedCsvDocument {
  const parsed = Papa.parse<string[]>(text.replace(/\r\n|\r|\n/g, "\n"), {
    skipEmptyLines: "greedy",
    transform: (value) => value.trim()
  });
  const matrix = parsed.data.filter((row) => row.some(Boolean));
  if (!matrix.length) throw new Error("This file does not contain any rows");

  const candidateCount = Math.min(matrix.length, 25);
  let headerRow = 0;
  let highestScore = -1;

  for (let index = 0; index < candidateCount; index += 1) {
    const suggested = suggestCsvMapping(matrix[index]);
    const score = mappingScore(suggested) + Math.min(matrix[index].length, 8) * 0.05;
    if (score > highestScore) {
      highestScore = score;
      headerRow = index;
    }
  }

  const headers = uniqueHeaders(matrix[headerRow]);
  const suggestedMapping = suggestCsvMapping(headers);
  const rows = matrix.slice(headerRow + 1)
    .filter((row) => !looksLikeRepeatedHeader(row, headers))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
  const warnings = parsed.errors
    .filter((error) => error.code !== "UndetectableDelimiter")
    .slice(0, 3)
    .map((error) => `Row ${(error.row ?? 0) + 1}: ${error.message}`);

  if (!rows.length) throw new Error("No transaction rows were found below the detected header");

  return {
    headers,
    rows,
    suggestedMapping,
    headerRow,
    delimiter: parsed.meta.delimiter || ",",
    warnings
  };
}

export function suggestCsvMapping(headers: string[]): CsvColumnMapping {
  const mapping = emptyMapping();
  const used = new Set<string>();

  for (const key of mappingKeys) {
    const exact = headers.find((header) => aliasScore(header, aliases[key]) >= 100 && !used.has(header));
    if (exact) {
      mapping[key] = exact;
      used.add(exact);
    }
  }

  for (const key of mappingKeys) {
    if (mapping[key]) continue;
    const best = headers
      .map((header) => ({ header, score: aliasScore(header, aliases[key]) }))
      .filter((candidate) => candidate.score > 0 && !used.has(candidate.header))
      .sort((a, b) => b.score - a.score)[0];
    if (best) {
      mapping[key] = best.header;
      used.add(best.header);
    }
  }

  return mapping;
}

export function buildCsvPreview(
  document: ParsedCsvDocument,
  mapping: CsvColumnMapping,
  source: CsvSourceKind,
  existingRecords: NormalizedExpense[],
  defaultCurrency = defaultCurrencyForSource(source),
  fx: CsvFxRates = { twdPerUsd: 31, cnyPerUsd: 7.2 }
): CsvPreviewRow[] {
  const existingFingerprints = new Set(
    existingRecords.flatMap((record) => {
      const values = record.importFingerprint ? [record.importFingerprint] : [];
      if (record.sourceRecordId) {
        values.push(createCsvFingerprint(source, record.sourceRecordId, record.date, record.merchant, record.nativeAmount, record.nativeCurrency, record.note));
      }
      values.push(createCsvFingerprint(source, "", record.date, record.merchant, record.nativeAmount, record.nativeCurrency, record.note));
      return values;
    })
  );
  const seenInFile = new Set<string>();

  return document.rows.map((raw, index) => {
    const rawDate = read(raw, mapping.date);
    const date = normalizeExpenseDate(rawDate);
    const note = read(raw, mapping.note);
    const merchant = cleanMerchant(read(raw, mapping.merchant) || note);
    const category = mapCsvExpenseCategory(read(raw, mapping.category), `${merchant}\n${note}`);
    const transactionId = read(raw, mapping.transactionId);
    const debit = parseAmount(read(raw, mapping.debit));
    const credit = parseAmount(read(raw, mapping.credit));
    const generic = parseAmount(read(raw, mapping.amount));
    const amount = debit != null && debit !== 0
      ? Math.abs(debit)
      : credit != null && credit !== 0
        ? Math.abs(credit)
        : generic == null
          ? null
          : Math.abs(generic);
    const direction = detectDirection({
      explicit: read(raw, mapping.direction),
      debit,
      credit,
      generic,
      amountHeader: mapping.amount,
      debitHeader: mapping.debit
    });
    const currency = detectNativeCurrency(read(raw, mapping.currency), defaultCurrency);
    const fingerprintDate = transactionId ? date : rawDate || date;
    const fingerprint = createCsvFingerprint(source, transactionId, fingerprintDate, merchant, amount ?? 0, currency, note);
    const legacyFingerprint = createCsvFingerprint(source, transactionId, date, merchant, amount ?? 0, currency, note);
    const duplicate = existingFingerprints.has(fingerprint)
      || existingFingerprints.has(legacyFingerprint)
      || seenInFile.has(fingerprint);
    const errors: string[] = [];
    if (!date) errors.push("Missing or invalid date");
    if (!merchant) errors.push("Missing merchant");
    if (amount == null || amount <= 0) errors.push("Missing or invalid amount");
    if (direction === "unknown") errors.push("Direction needs review");
    if (!duplicate) seenInFile.add(fingerprint);

    return {
      rowNumber: document.headerRow + index + 2,
      date,
      merchant: merchant || "Unknown merchant",
      amount,
      currency,
      usdValue: amount == null ? null : toUsd(amount, currency, fx),
      category,
      direction,
      note,
      transactionId,
      fingerprint,
      duplicate,
      included: direction === "expense" && errors.length === 0 && !duplicate,
      errors
    };
  });
}

export function materializeCsvExpenses(
  rows: CsvPreviewRow[],
  source: CsvSourceKind,
  fx: CsvFxRates,
  fileName: string
): NormalizedExpense[] {
  const updatedAt = new Date().toISOString();
  return rows
    .filter((row) => row.included && !row.duplicate && !row.errors.length && row.amount != null)
    .map((row) => ({
      id: `csv-${row.fingerprint}`,
      sourceType: "expense" as const,
      sourceName: sourceNames[source],
      merchant: row.merchant,
      date: row.date,
      category: row.category,
      nativeAmount: row.amount as number,
      nativeCurrency: row.currency,
      usdValue: row.usdValue ?? toUsd(row.amount as number, row.currency, fx),
      note: row.note,
      attachmentName: fileName,
      inputMethod: "csv" as const,
      sourceRecordId: row.transactionId || undefined,
      importFingerprint: row.fingerprint,
      updatedAt,
      syncStatus: "updated_today" as const,
      isSeed: false as const
    }));
}

export function createCsvFingerprint(
  source: CsvSourceKind,
  transactionId: string,
  date: string,
  merchant: string,
  amount: number,
  currency: ExpenseNativeCurrency,
  note: string
) {
  const identity = transactionId.trim()
    ? `${source}|id|${transactionId.trim().toLowerCase()}`
    : [source, date, merchant, amount.toFixed(4), currency, note]
      .map((value) => String(value).trim().toLowerCase().replace(/\s+/g, " "))
      .join("|");
  return stableHash(identity);
}

function emptyMapping(): CsvColumnMapping {
  return {
    date: "",
    merchant: "",
    category: "",
    amount: "",
    debit: "",
    credit: "",
    direction: "",
    currency: "",
    note: "",
    transactionId: ""
  };
}

function normalizeHeader(value: string) {
  return value.replace(/^\uFEFF/, "").toLowerCase().replace(/[\s_\-./()[\]（）:：$]+/g, "");
}

function aliasScore(header: string, candidates: string[]) {
  const normalized = normalizeHeader(header);
  if (!normalized) return 0;
  let best = 0;
  for (const candidate of candidates) {
    const normalizedAlias = normalizeHeader(candidate);
    if (normalized === normalizedAlias) best = Math.max(best, 100 + normalizedAlias.length);
    else if (normalized.includes(normalizedAlias) || normalizedAlias.includes(normalized)) best = Math.max(best, 50 + normalizedAlias.length);
  }
  return best;
}

function mappingScore(mapping: CsvColumnMapping) {
  let score = 0;
  if (mapping.date) score += 5;
  if (mapping.merchant) score += 4;
  if (mapping.category) score += 1;
  if (mapping.amount || mapping.debit) score += 5;
  if (mapping.credit) score += 1;
  if (mapping.direction) score += 2;
  if (mapping.currency) score += 1;
  if (mapping.transactionId) score += 1;
  return score;
}

function uniqueHeaders(headers: string[]) {
  const counts = new Map<string, number>();
  return headers.map((raw, index) => {
    const base = raw.trim() || `Column ${index + 1}`;
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

function looksLikeRepeatedHeader(row: string[], headers: string[]) {
  if (row.length < 2) return false;
  const matches = row.filter((value, index) => normalizeHeader(value) === normalizeHeader(headers[index] ?? "")).length;
  return matches >= Math.min(3, row.length);
}

function read(row: Record<string, string>, column: string) {
  return column ? String(row[column] ?? "").trim() : "";
}

function parseAmount(raw: string) {
  if (!raw.trim()) return null;
  const negativeByParentheses = /^\s*\(.+\)\s*$/.test(raw);
  const normalized = raw
    .replace(/[,\s]/g, "")
    .replace(/[^\d.+-]/g, "");
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return negativeByParentheses ? -Math.abs(value) : value;
}

function detectDirection(values: {
  explicit: string;
  debit: number | null;
  credit: number | null;
  generic: number | null;
  amountHeader: string;
  debitHeader: string;
}): CsvDirection {
  const explicit = values.explicit.toLowerCase().replace(/\s+/g, "");
  if (/(不计收支|不計收支|neutral|ignored|excluded)/i.test(explicit)) return "neutral";
  if (/(收入|收款|退款|存入|入帳|入账|轉入|转入|credit|income|received|moneyin)/i.test(explicit)) return "income";
  if (/(支出|付款|消费|消費|扣款|提款|轉出|转出|debit|expense|paid|moneyout)/i.test(explicit)) return "expense";
  if (values.debit != null && values.debit !== 0) return "expense";
  if (values.credit != null && values.credit !== 0) return "income";
  if (values.generic != null && values.generic < 0) return "expense";
  if (/(支出|扣款|提款|debit|withdrawal)/i.test(values.amountHeader) || values.debitHeader) return "expense";
  if (values.generic != null && values.generic > 0) return "expense";
  return "unknown";
}

function detectNativeCurrency(raw: string, fallback: ExpenseNativeCurrency): ExpenseNativeCurrency {
  const normalized = raw.trim().toUpperCase();
  if (/(USD|US\$|美元)/i.test(normalized)) return "USD";
  if (/(TWD|NTD|NT\$|新台幣|新臺幣|台幣|臺幣)/i.test(normalized)) return "TWD";
  if (/(CNY|RMB|人民幣|人民币|¥|￥)/i.test(normalized)) return "CNY";
  return fallback;
}

function cleanMerchant(value: string) {
  return value.replace(/\s+/g, " ").replace(/^[-–—\s]+|[-–—\s]+$/g, "").slice(0, 120);
}

const importedCategoryAliases: Record<string, ReturnType<typeof inferExpenseCategory>> = {
  餐饮: "food",
  餐飲: "food",
  交通: "traffic",
  爱车: "traffic",
  愛車: "traffic",
  生活服务: "living",
  生活服務: "living",
  生活日用: "living",
  住房: "living",
  养娃: "living",
  養娃: "living",
  休闲玩乐: "entertainment",
  休閒玩樂: "entertainment",
  运动: "fitness",
  運動: "fitness",
  酒店旅行: "travel",
  醫療保健: "health",
  医疗保健: "health",
  购物: "shopping",
  購物: "shopping",
  穿搭美容: "shopping",
  其他: "other",
  转账: "other",
  轉帳: "other",
  退款: "other"
};

export function mapCsvExpenseCategory(rawCategory: string, fallbackText: string) {
  const normalized = rawCategory.trim().replace(/\s+/g, "");
  return importedCategoryAliases[normalized] ?? inferExpenseCategory(fallbackText);
}

function toUsd(amount: number, currency: ExpenseNativeCurrency, fx: CsvFxRates) {
  if (currency === "USD") return amount;
  if (currency === "CNY") return amount / fx.cnyPerUsd;
  return amount / fx.twdPerUsd;
}

function replacementCharacterCount(value: string) {
  return (value.match(/\uFFFD/g) ?? []).length;
}

function decodedCsvScore(value: string) {
  const replacements = replacementCharacterCount(value);
  const knownHeaders = value.match(/交易日期|交易時間|交易时间|记录时间|記錄時間|分類|分类|收支類型|收支类型|金額|金额|備註|备注/g)?.length ?? 0;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: CSV decoding quality intentionally counts invalid control bytes.
  const controls = value.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g)?.length ?? 0;
  return knownHeaders * 100 - replacements * 20 - controls * 5;
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
