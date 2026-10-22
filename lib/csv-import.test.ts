import { describe, expect, it } from "vitest";
import {
  buildCsvPreview,
  createCsvFingerprint,
  decodeCsvBuffer,
  materializeCsvExpenses,
  parseCsvDocument,
  type CsvColumnMapping
} from "./csv-import";

const fx = { twdPerUsd: 32, cnyPerUsd: 7.2 };

describe("CSV import", () => {
  it("detects a Taiwan bank statement with separate debit and credit columns", () => {
    const document = parseCsvDocument([
      "帳戶交易明細",
      "交易日期,交易說明,支出金額,收入金額,幣別,交易序號",
      "2026/07/02,台灣高鐵,\"1,490\",,TWD,TX-100",
      "2026/07/03,薪資入帳,,\"80,000\",TWD,TX-101"
    ].join("\n"));
    const preview = buildCsvPreview(document, document.suggestedMapping, "bank", [], "TWD", fx);

    expect(document.headerRow).toBe(1);
    expect(document.suggestedMapping).toMatchObject({
      date: "交易日期",
      merchant: "交易說明",
      debit: "支出金額",
      credit: "收入金額",
      currency: "幣別",
      transactionId: "交易序號"
    });
    expect(preview[0]).toMatchObject({
      date: "2026-07-02",
      merchant: "台灣高鐵",
      amount: 1490,
      direction: "expense",
      included: true
    });
    expect(preview[1]).toMatchObject({
      amount: 80000,
      direction: "income",
      included: false
    });
  });

  it("normalizes Alipay expenses in CNY and skips income", () => {
    const document = parseCsvDocument([
      "交易时间,交易对方,收/支,金额(元),交易状态,交易订单号,备注",
      "2026-07-10 12:30:00,盒马鲜生,支出,128.50,交易成功,A-001,groceries",
      "2026-07-11 08:20:00,退款,收入,30.00,退款成功,A-002,refund"
    ].join("\n"));
    const preview = buildCsvPreview(document, document.suggestedMapping, "alipay", [], "CNY", fx);
    const records = materializeCsvExpenses(preview, "alipay", fx, "alipay.csv");

    expect(preview[0]).toMatchObject({
      currency: "CNY",
      amount: 128.5,
      direction: "expense",
      included: true
    });
    expect(preview[1]).toMatchObject({ direction: "income", included: false });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sourceName: "Alipay CSV",
      nativeCurrency: "CNY",
      sourceRecordId: "A-001",
      usdValue: 128.5 / 7.2
    });
  });

  it("decodes a GB18030 Alipay cashbook and uses its category column", () => {
    const bytes = Buffer.from(
      "zNix8Mzhyr6jug0KvMfCvMqxvOQst9bA4CzK1danwODQzSy98LbuLLG416IsDQoyMDI2LTA4LTAxIDEwOjAwOjAwLLLN0vss1qez9iwxMi41MCy/p7fILA0K",
      "base64"
    );
    const decoded = decodeCsvBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const document = parseCsvDocument(decoded.text);
    const preview = buildCsvPreview(document, document.suggestedMapping, "alipay", [], "CNY", fx);

    expect(decoded.encoding).toBe("GB18030");
    expect(document.suggestedMapping).toMatchObject({
      date: "记录时间",
      category: "分类",
      direction: "收支类型",
      amount: "金额",
      note: "备注"
    });
    expect(preview[0]).toMatchObject({
      date: "2026-08-01",
      category: "food",
      direction: "expense",
      amount: 12.5,
      included: true
    });
  });

  it("keeps same-day same-amount Alipay rows when their source times differ", () => {
    const document = parseCsvDocument([
      "记录时间,分类,收支类型,金额,备注",
      "2026-08-06 20:56:12,餐饮,支出,25.00,同一商户",
      "2026-08-06 22:08:36,餐饮,支出,25.00,同一商户",
      "2026-08-07 09:00:00,退款,不计收支,25.00,退款"
    ].join("\n"));
    const preview = buildCsvPreview(document, document.suggestedMapping, "alipay", [], "CNY", fx);

    expect(preview.slice(0, 2).every((row) => row.included)).toBe(true);
    expect(preview[0].fingerprint).not.toBe(preview[1].fingerprint);
    expect(preview[2]).toMatchObject({ direction: "neutral", included: false, errors: [] });
  });

  it("accepts a manual mapping override for a WeChat export", () => {
    const document = parseCsvDocument([
      "When,Who,Flow,Money,Order",
      "2026-07-12,滴滴出行,支出,¥45.20,W-001"
    ].join("\n"));
    const mapping: CsvColumnMapping = {
      ...document.suggestedMapping,
      date: "When",
      merchant: "Who",
      direction: "Flow",
      amount: "Money",
      transactionId: "Order"
    };
    const preview = buildCsvPreview(document, mapping, "wechat", [], "CNY", fx);

    expect(preview[0]).toMatchObject({
      date: "2026-07-12",
      merchant: "滴滴出行",
      amount: 45.2,
      direction: "expense",
      included: true
    });
  });

  it("marks a previously imported transaction as a duplicate", () => {
    const text = [
      "交易日期,交易說明,支出金額,交易序號",
      "2026-07-02,台灣高鐵,1490,TX-100"
    ].join("\n");
    const document = parseCsvDocument(text);
    const firstPreview = buildCsvPreview(document, document.suggestedMapping, "bank", [], "TWD", fx);
    const existing = materializeCsvExpenses(firstPreview, "bank", fx, "bank.csv");
    const secondPreview = buildCsvPreview(document, document.suggestedMapping, "bank", existing, "TWD", fx);

    expect(secondPreview[0]).toMatchObject({ duplicate: true, included: false });
  });

  it("creates a stable fallback fingerprint without a transaction ID", () => {
    const first = createCsvFingerprint("bank", "", "2026-07-01", "Coffee", 120, "TWD", "");
    const second = createCsvFingerprint("bank", "", "2026-07-01", "  coffee ", 120, "TWD", "");

    expect(first).toBe(second);
  });
});
