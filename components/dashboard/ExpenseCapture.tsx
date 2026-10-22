"use client";

import { useRef, useState } from "react";
import { Camera, FileCheck2, FileUp, LoaderCircle, PenLine, ReceiptText, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  createBlankExpenseDraft,
  createNormalizedExpense,
  expenseCategories,
  formatExpenseCategory,
  parseReceiptText,
  type ExpenseDraft,
  type ExpenseInputMethod,
  type NormalizedExpense,
  type ReceiptParseResult
} from "@/lib/expense-records";
import { readReceiptFile, type ReceiptReadProgress } from "@/lib/client/receipt-reader";
import { expenseLedgerStorageLabel, type ExpenseLedgerStorage } from "@/lib/client/expense-ledger";
import { cn } from "@/lib/utils";

type ExpenseCaptureProps = {
  fxRate: number;
  storage: ExpenseLedgerStorage;
  onRecord: (record: NormalizedExpense) => Promise<{ status: "saved" | "duplicate" | "review" }>;
};

const initialProgress: ReceiptReadProgress = { stage: "loading", label: "Preparing document", progress: 0 };

export function ExpenseCapture({ fxRate, storage, onRecord }: ExpenseCaptureProps) {
  const uploadInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const pendingSubmission = useRef<{ key: string; record: NormalizedExpense } | null>(null);
  const [open, setOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isReading, setIsReading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [draft, setDraft] = useState<ExpenseDraft>(createBlankExpenseDraft);
  const [parseResult, setParseResult] = useState<ReceiptParseResult | null>(null);
  const [inputMethod, setInputMethod] = useState<ExpenseInputMethod>("manual");
  const [progress, setProgress] = useState<ReceiptReadProgress>(initialProgress);
  const [formError, setFormError] = useState<string | null>(null);

  function openManualEntry() {
    resetDraft();
    setInputMethod("manual");
    setOpen(true);
  }

  async function handleFile(nextFile: File, fromCamera = false) {
    resetDraft();
    setFile(nextFile);
    setOpen(true);
    setIsReading(true);
    setProgress(initialProgress);

    try {
      const result = await readReceiptFile(nextFile, setProgress);
      const parsed = parseReceiptText(result.text, nextFile.name);
      setDraft(parsed.draft);
      setParseResult(parsed);
      setInputMethod(fromCamera ? "camera" : result.inputMethod);
      if (parsed.detectedFields < 3) {
        toast.info("Receipt needs a quick review", { description: "Check the highlighted fields before recording" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "This receipt could not be read";
      setFormError(message);
      setInputMethod(fromCamera ? "camera" : "manual");
      toast.error("Receipt reading failed", { description: message });
    } finally {
      setIsReading(false);
    }
  }

  async function saveExpense() {
    setFormError(null);
    setIsSaving(true);
    try {
      const submissionKey = JSON.stringify({ draft, fxRate, attachmentName: file?.name ?? null, inputMethod });
      const record = pendingSubmission.current?.key === submissionKey
        ? pendingSubmission.current.record
        : createNormalizedExpense(draft, fxRate, {
            attachmentName: file?.name,
            inputMethod
          });
      pendingSubmission.current = { key: submissionKey, record };
      const result = await onRecord(record);
      if (result.status === "review") {
        toast.warning("Expense needs confirmation", { description: "Conflicting details were saved for review; spending was not changed" });
      } else if (result.status === "duplicate") {
        toast.info("Expense already recorded", {
          description: "The existing ledger entry was kept; no duplicate was added."
        });
      } else {
        toast.success("Expense recorded", {
          description: `${record.merchant} was added to ${record.date.slice(0, 7)}`
        });
      }
      pendingSubmission.current = null;
      setOpen(false);
      resetDraft();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Check the expense details and try again");
    } finally {
      setIsSaving(false);
    }
  }

  function resetDraft() {
    pendingSubmission.current = null;
    setFile(null);
    setDraft(createBlankExpenseDraft());
    setParseResult(null);
    setInputMethod("manual");
    setProgress(initialProgress);
    setFormError(null);
    if (uploadInput.current) uploadInput.current.value = "";
    if (cameraInput.current) cameraInput.current.value = "";
  }

  return (
    <>
      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>Record an expense</CardTitle>
              <Badge variant={storage === "device_fallback" || storage === "device" ? "warning" : "success"}>
                <ShieldCheck className="mr-1 h-3 w-3" />
                {expenseLedgerStorageLabel(storage)}
              </Badge>
            </div>
            <CardDescription className="mt-2 max-w-xl">
              Upload a receipt or invoice, confirm the detected details, and add it to spending in one step
            </CardDescription>
          </div>
          <Button variant="outline" onClick={openManualEntry}>
            <PenLine />
            Enter manually
          </Button>
        </CardHeader>
        <CardContent>
          <section
            aria-label="Receipt file drop zone"
            className={cn(
              "flex min-h-36 flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border bg-muted/20 px-5 py-7 text-center transition-colors",
              isDragging && "border-primary bg-primary/5"
            )}
            onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragging(false);
              const droppedFile = event.dataTransfer.files[0];
              if (droppedFile) void handleFile(droppedFile);
            }}
          >
            <div className="grid h-11 w-11 place-items-center rounded-lg border border-border bg-background text-primary">
              <ReceiptText className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">Drop a receipt here</p>
              <p className="mt-1 text-xs text-muted-foreground">JPG, PNG, WebP, PDF, CSV, or TXT up to 12 MB</p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => uploadInput.current?.click()}>
                <FileUp />
                Choose file
              </Button>
              <Button variant="outline" onClick={() => cameraInput.current?.click()}>
                <Camera />
                Use camera
              </Button>
            </div>
          </section>
          <input
            ref={uploadInput}
            hidden
            aria-hidden="true"
            tabIndex={-1}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/bmp,application/pdf,text/csv,text/plain,.csv,.txt,.pdf"
            onChange={(event) => {
              const selected = event.target.files?.[0];
              if (selected) void handleFile(selected);
            }}
          />
          <input
            ref={cameraInput}
            hidden
            aria-hidden="true"
            tabIndex={-1}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(event) => {
              const selected = event.target.files?.[0];
              if (selected) void handleFile(selected, true);
            }}
          />
        </CardContent>
      </Card>

      <Sheet open={open} onOpenChange={(nextOpen) => { setOpen(nextOpen); if (!nextOpen && !isReading) resetDraft(); }}>
        <SheetContent className="w-full overflow-y-auto p-0 sm:w-lg">
          <div className="border-b border-border px-6 py-5 pr-14">
            <p className="text-xs font-semibold text-primary">Expense capture</p>
            <SheetTitle className="mt-2 text-2xl font-semibold">{isReading ? "Reading receipt" : "Review expense"}</SheetTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {file ? file.name : "Manual entry"}
            </p>
          </div>

          {isReading ? (
            <div className="grid min-h-112 content-center px-6 py-10">
              <div className="mx-auto grid h-12 w-12 place-items-center rounded-lg border border-border bg-muted/30 text-primary">
                <LoaderCircle className="h-5 w-5 animate-spin" />
              </div>
              <p className="mt-5 text-center text-sm font-semibold">{progress.label}</p>
              <div className="mx-auto mt-4 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${Math.max(5, progress.progress * 100)}%` }} />
              </div>
              <p className="mt-4 text-center text-xs leading-5 text-muted-foreground">
                Text recognition runs in this browser. The file is not saved
              </p>
            </div>
          ) : (
            <div className="space-y-6 px-6 py-6">
              {file ? (
                <div className="flex items-center justify-between gap-3 border-b border-border pb-5">
                  <div className="flex min-w-0 items-center gap-3">
                    <FileCheck2 className="h-5 w-5 shrink-0 text-primary" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{file.name}</p>
                      <p className="text-xs text-muted-foreground">{formatFileSize(file.size)} · attachment not stored</p>
                    </div>
                  </div>
                  {parseResult ? (
                    <Badge variant={parseResult.confidence === "high" ? "success" : "warning"}>
                      {parseResult.detectedFields}/3 detected
                    </Badge>
                  ) : null}
                </div>
              ) : null}

              {formError ? (
                <div className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200" role="alert">
                  {formError}
                </div>
              ) : null}

              <Field label="Merchant or payee" required>
                <Input
                  value={draft.merchant}
                  autoComplete="organization"
                  onChange={(event) => setDraft((current) => ({ ...current, merchant: event.target.value }))}
                />
              </Field>

              <Field label="Transaction date" required>
                <Input
                  type="date"
                  value={draft.date}
                  onChange={(event) => setDraft((current) => ({ ...current, date: event.target.value }))}
                />
              </Field>

              <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] gap-3">
                <Field label="Amount" required>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    value={draft.amount}
                    onChange={(event) => setDraft((current) => ({ ...current, amount: event.target.value }))}
                  />
                </Field>
                <Field label="Currency" required>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-muted/30 px-3 text-sm text-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    value={draft.currency}
                    onChange={(event) => setDraft((current) => ({ ...current, currency: event.target.value as ExpenseDraft["currency"] }))}
                  >
                    <option value="TWD">TWD</option>
                    <option value="USD">USD</option>
                  </select>
                </Field>
              </div>

              <Field label="Category" required>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-muted/30 px-3 text-sm text-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  value={draft.category}
                  onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value as ExpenseDraft["category"] }))}
                >
                  {expenseCategories.map((category) => (
                    <option key={category} value={category}>{formatExpenseCategory(category)}</option>
                  ))}
                </select>
              </Field>

              <Field label="Note" optional>
                <Input
                  value={draft.note}
                  onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))}
                />
              </Field>

              <div className="flex flex-col-reverse gap-2 border-t border-border pt-5 sm:flex-row sm:justify-end">
                <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={() => void saveExpense()} disabled={isSaving}>
                  {isSaving ? <LoaderCircle className="animate-spin" /> : <FileCheck2 />}
                  Record expense
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function Field({
  label,
  required,
  optional,
  children
}: {
  label: string;
  required?: boolean;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: Every Field call nests its form control inside this reusable label.
    <label className="grid gap-1.5 text-sm font-medium">
      <span>
        {label}
        {required ? <span className="ml-1 text-muted-foreground">(required)</span> : null}
        {optional ? <span className="ml-1 text-muted-foreground">(optional)</span> : null}
      </span>
      {children}
    </label>
  );
}

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
