"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  FileSpreadsheet,
  FileUp,
  LoaderCircle,
  RotateCcw,
  ShieldCheck
} from "lucide-react";
import { toast } from "sonner";
import { useCurrency } from "@/components/shared/Providers";
import { useFxRate } from "@/components/shared/useFxRate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  buildCsvPreview,
  decodeCsvBuffer,
  defaultCurrencyForSource,
  materializeCsvExpenses,
  parseCsvDocument,
  type CsvColumnMapping,
  type CsvPreviewRow,
  type CsvSourceKind,
  type ParsedCsvDocument
} from "@/lib/csv-import";
import {
  type ExpenseNativeCurrency,
  loadExpenseRecords,
  type NormalizedExpense
} from "@/lib/expense-records";
import {
  expenseLedgerStorageLabel,
  loadExpenseLedger,
  upsertExpenseRecords,
  type ExpenseLedgerStorage
} from "@/lib/client/expense-ledger";
import { toDisplayAmount } from "@/lib/fx";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

const sourceOptions: Array<{ value: CsvSourceKind; label: string; description: string }> = [
  { value: "bank", label: "Bank", description: "Statements and card exports" },
  { value: "moneybook", label: "Money Book", description: "Bookkeeping app exports with linked bank accounts" },
  { value: "alipay", label: "Alipay", description: "Transaction history exports" },
  { value: "wechat", label: "WeChat Pay", description: "Payment history exports" }
];

const mappingFields: Array<{ key: keyof CsvColumnMapping; label: string; optional?: boolean }> = [
  { key: "date", label: "Transaction date" },
  { key: "merchant", label: "Merchant / payee" },
  { key: "category", label: "Category", optional: true },
  { key: "amount", label: "Single amount", optional: true },
  { key: "debit", label: "Money out", optional: true },
  { key: "credit", label: "Money in", optional: true },
  { key: "direction", label: "Direction", optional: true },
  { key: "currency", label: "Currency", optional: true },
  { key: "note", label: "Note", optional: true },
  { key: "transactionId", label: "Transaction ID", optional: true }
];

export function CsvImportConsole({ initialFxRate }: { initialFxRate: number }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingImport = useRef<{ key: string; records: NormalizedExpense[] } | null>(null);
  const { currency: displayCurrency } = useCurrency();
  const fx = useFxRate(initialFxRate);
  const [source, setSource] = useState<CsvSourceKind>("bank");
  const [defaultCurrency, setDefaultCurrency] = useState<ExpenseNativeCurrency>("TWD");
  const [file, setFile] = useState<File | null>(null);
  const [encoding, setEncoding] = useState<"UTF-8" | "GB18030" | "Big5" | null>(null);
  const [csvDocument, setCsvDocument] = useState<ParsedCsvDocument | null>(null);
  const [mapping, setMapping] = useState<CsvColumnMapping | null>(null);
  const [records, setRecords] = useState<NormalizedExpense[]>([]);
  const [ledgerStorage, setLedgerStorage] = useState<ExpenseLedgerStorage>("device");
  const [inclusionOverrides, setInclusionOverrides] = useState<Record<string, boolean>>({});
  const [isReading, setIsReading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadExpenseLedger({ retryPendingWrite: true }).then((snapshot) => {
      if (cancelled) return;
      setRecords(snapshot.records);
      setLedgerStorage(snapshot.storage);
      if (snapshot.message) {
        toast.warning("Expense ledger needs attention", { description: snapshot.message });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const generatedPreview = useMemo(() => {
    if (!csvDocument || !mapping) return [];
    return buildCsvPreview(csvDocument, mapping, source, records, defaultCurrency, {
      twdPerUsd: fx.rate,
      cnyPerUsd: fx.cnyPerUsd
    });
  }, [csvDocument, mapping, source, records, defaultCurrency, fx.rate, fx.cnyPerUsd]);

  const preview = useMemo(() => generatedPreview.map((row) => ({
    ...row,
    included: inclusionOverrides[row.fingerprint] ?? row.included
  })), [generatedPreview, inclusionOverrides]);

  const stats = useMemo(() => ({
    ready: preview.filter((row) => row.included && !row.duplicate && !row.errors.length).length,
    expenses: preview.filter((row) => row.direction === "expense").length,
    skipped: preview.filter((row) => row.direction === "income" || row.direction === "neutral").length,
    duplicates: preview.filter((row) => row.duplicate).length,
    review: preview.filter((row) => row.errors.length > 0).length
  }), [preview]);

  const sourceRecords = records.filter((record) => record.sourceName === sourceName(source));
  const latestSourceRecord = [...sourceRecords].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

  async function readFile(nextFile: File) {
    if (nextFile.size > 12 * 1024 * 1024) {
      setError("Choose a CSV smaller than 12 MB");
      return;
    }

    setIsReading(true);
    setError(null);
    setInclusionOverrides({});
    try {
      const decoded = decodeCsvBuffer(await nextFile.arrayBuffer());
      const nextDocument = parseCsvDocument(decoded.text);
      setFile(nextFile);
      setEncoding(decoded.encoding);
      setCsvDocument(nextDocument);
      setMapping(nextDocument.suggestedMapping);
      toast.success("Statement ready for review", {
        description: `${nextDocument.rows.length} rows detected`
      });
    } catch (nextError) {
      setFile(null);
      setEncoding(null);
      setCsvDocument(null);
      setMapping(null);
      setError(nextError instanceof Error ? nextError.message : "This statement could not be read");
    } finally {
      setIsReading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function changeSource(nextSource: CsvSourceKind) {
    setSource(nextSource);
    setDefaultCurrency(defaultCurrencyForSource(nextSource));
    resetFile();
  }

  function resetFile() {
    pendingImport.current = null;
    setFile(null);
    setEncoding(null);
    setCsvDocument(null);
    setMapping(null);
    setInclusionOverrides({});
    setError(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  function toggleRow(row: CsvPreviewRow) {
    if (row.duplicate || row.errors.length || row.direction !== "expense") return;
    setInclusionOverrides((current) => ({ ...current, [row.fingerprint]: !row.included }));
  }

  async function importRows() {
    if (!file || !stats.ready) return;
    setIsImporting(true);
    try {
      const importKey = JSON.stringify({ fileName: file.name, source, preview, twdPerUsd: fx.rate, cnyPerUsd: fx.cnyPerUsd });
      const imported = pendingImport.current?.key === importKey
        ? pendingImport.current.records
        : materializeCsvExpenses(preview, source, {
            twdPerUsd: fx.rate,
            cnyPerUsd: fx.cnyPerUsd
          }, file.name);
      pendingImport.current = { key: importKey, records: imported };
      const result = await upsertExpenseRecords(imported);
      pendingImport.current = null;
      setRecords(loadExpenseRecords());
      setLedgerStorage(result.storage);
      toast.success(`${result.saved} expenses imported`, {
        description: result.storage === "supabase"
          ? `Expenses and ${expenseLedgerStorageLabel(result.storage)} are now updated`
          : result.storage === "device_fallback"
            ? "Saved on this device; cloud sync will retry automatically"
            : "Expenses now include these transactions"
      });
      if (result.pendingReview) {
        toast.warning(`${result.pendingReview} expenses need confirmation`, {
          description: `Not added to spending; batch ${result.receipt?.batchId}`
        });
      }
      if (result.duplicates) {
        toast.info(`${result.duplicates} duplicates skipped`, {
          description: "Existing ledger entries were kept."
        });
      }
      resetFile();
    } catch (nextError) {
      toast.error("Import failed", {
        description: nextError instanceof Error ? nextError.message : "Try this file again"
      });
    } finally {
      setIsImporting(false);
    }
  }

  return (
    <div className="space-y-5">
      <Tabs value={source} onValueChange={(value) => changeSource(value as CsvSourceKind)}>
        <TabsList className="grid h-auto w-full grid-cols-3">
          {sourceOptions.map((option) => (
            <TabsTrigger key={option.value} value={option.value} className="min-h-10 px-2 text-xs sm:text-sm">
              {option.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="flex flex-wrap items-center justify-between gap-3 border-y border-border py-3">
        <div>
          <p className="text-sm font-medium">{sourceOptions.find((option) => option.value === source)?.description}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {sourceRecords.length
              ? `${sourceRecords.length} imported records${latestSourceRecord ? ` · last import ${formatShortDate(latestSourceRecord.updatedAt)}` : ""}`
              : "No imported records on this device"}
          </p>
        </div>
        <Badge variant={sourceRecords.length && ledgerStorage === "supabase" ? "success" : "warning"}>
          {sourceRecords.length ? expenseLedgerStorageLabel(ledgerStorage) : "Pending import"}
        </Badge>
      </div>

      {!csvDocument ? (
        <section
          aria-label="Statement file drop zone"
          className={cn(
            "grid min-h-44 place-items-center rounded-lg border border-dashed border-border bg-muted/20 px-5 py-8 text-center transition-colors",
            isDragging && "border-primary bg-primary/5"
          )}
          onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            const dropped = event.dataTransfer.files[0];
            if (dropped) void readFile(dropped);
          }}
        >
          <div>
            <div className="mx-auto grid h-10 w-10 place-items-center rounded-md border border-border bg-background text-primary">
              {isReading ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <FileSpreadsheet className="h-5 w-5" />}
            </div>
            <p className="mt-4 text-sm font-semibold">{isReading ? "Reading statement" : `Drop a ${sourceName(source)} here`}</p>
            <p className="mt-1 text-xs text-muted-foreground">CSV or TSV · UTF-8 and Big5 supported · up to 12 MB</p>
            <Button className="mt-4" onClick={() => fileInput.current?.click()} disabled={isReading}>
              <FileUp />
              Choose statement
            </Button>
          </div>
        </section>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
            <div className="flex min-w-0 items-center gap-3">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{file?.name}</p>
                <p className="text-xs text-muted-foreground">
                  {csvDocument.rows.length} rows · header row {csvDocument.headerRow + 1} · {encoding} · {delimiterLabel(csvDocument.delimiter)}
                </p>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={resetFile}>
              <RotateCcw />
              Choose another
            </Button>
          </div>

          <div>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-sm font-semibold">Column mapping</p>
                <p className="mt-1 text-xs text-muted-foreground">Review the detected columns before importing</p>
              </div>
              <label className="grid gap-1 text-xs text-muted-foreground">
                Default currency
                <select
                  className="h-9 rounded-md border border-input bg-muted/30 px-3 text-sm text-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  value={defaultCurrency}
                  onChange={(event) => setDefaultCurrency(event.target.value as ExpenseNativeCurrency)}
                >
                  <option value="TWD">TWD</option>
                  <option value="USD">USD</option>
                  <option value="CNY">CNY</option>
                </select>
              </label>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {mappingFields.map((field) => (
                <label key={field.key} className="grid gap-1.5 text-xs text-muted-foreground">
                  <span>{field.label}{field.optional ? " · optional" : ""}</span>
                  <select
                    className="h-9 min-w-0 rounded-md border border-input bg-muted/30 px-3 text-sm text-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    value={mapping?.[field.key] ?? ""}
                    onChange={(event) => setMapping((current) => current ? { ...current, [field.key]: event.target.value } : current)}
                  >
                    <option value="">Not mapped</option>
                    {csvDocument.headers.map((header) => <option key={header} value={header}>{header}</option>)}
                  </select>
                </label>
              ))}
            </div>
          </div>

          {csvDocument.warnings.length ? (
            <div className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
              {csvDocument.warnings.join(" · ")}
            </div>
          ) : null}

          <div className="grid grid-cols-2 border-y border-border sm:grid-cols-5 sm:divide-x sm:divide-border">
            <Metric label="Ready" value={stats.ready} />
            <Metric label="Expenses" value={stats.expenses} />
            <Metric label="Non-expenses skipped" value={stats.skipped} />
            <Metric label="Duplicates" value={stats.duplicates} />
            <Metric label="Needs review" value={stats.review} />
          </div>

          <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold">Transaction preview</p>
                <p className="mt-1 text-xs text-muted-foreground">Only checked expense rows will be imported</p>
              </div>
              <Badge variant={fx.status === "stale" || fx.status === "seed" ? "warning" : "success"}>
                FX {fx.status === "updated_today" || fx.status === "live" ? "live" : fx.status}
              </Badge>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12"><span className="sr-only">Include</span></TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Merchant</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.slice(0, 100).map((row) => (
                  <TableRow key={`${row.rowNumber}-${row.fingerprint}`} className={cn(!row.included && "opacity-55")}>
                    <TableCell>
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[hsl(var(--primary))]"
                        checked={row.included}
                        disabled={row.duplicate || Boolean(row.errors.length) || row.direction !== "expense"}
                        aria-label={`Include row ${row.rowNumber}`}
                        onChange={() => toggleRow(row)}
                      />
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{row.date || `Row ${row.rowNumber}`}</TableCell>
                    <TableCell className="min-w-48">
                      <p className="font-medium">{row.merchant}</p>
                      {row.note ? <p className="mt-1 max-w-80 truncate text-xs text-muted-foreground">{row.note}</p> : null}
                    </TableCell>
                    <TableCell>{rowStatus(row)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono font-semibold tabular-nums">
                      {row.usdValue == null ? "—" : formatMoney(toDisplayAmount(row.usdValue, displayCurrency, fx.rate), displayCurrency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {preview.length > 100 ? (
              <p className="mt-3 text-xs text-muted-foreground">Showing the first 100 of {preview.length} rows. All checked valid rows will be imported.</p>
            ) : null}
          </div>

          <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Processed in this browser; the original file is not stored
            </div>
            <Button onClick={() => void importRows()} disabled={!stats.ready || isImporting}>
              {isImporting ? <LoaderCircle className="animate-spin" /> : <Check />}
              Import {stats.ready || ""} {stats.ready === 1 ? "expense" : "expenses"}
            </Button>
          </div>
        </div>
      )}

      <input
        ref={fileInput}
        hidden
        aria-hidden="true"
        tabIndex={-1}
        type="file"
        accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
        onChange={(event) => {
          const selected = event.target.files?.[0];
          if (selected) void readFile(selected);
        }}
      />

      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200" role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 px-3 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function rowStatus(row: CsvPreviewRow) {
  if (row.duplicate) return <Badge variant="muted">Duplicate</Badge>;
  if (row.direction === "income") return <Badge variant="muted">Income</Badge>;
  if (row.direction === "neutral") return <Badge variant="muted">Skipped</Badge>;
  if (row.errors.length) return <Badge variant="destructive" title={row.errors.join(", ")}>Review</Badge>;
  return <Badge variant="success">Ready</Badge>;
}

function sourceName(source: CsvSourceKind) {
  if (source === "bank") return "Bank CSV";
  if (source === "moneybook") return "Money Book CSV";
  if (source === "alipay") return "Alipay CSV";
  return "WeChat Pay CSV";
}

function delimiterLabel(delimiter: string) {
  if (delimiter === "\t") return "tab-delimited";
  if (delimiter === ";") return "semicolon-delimited";
  return "comma-delimited";
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(value));
}
