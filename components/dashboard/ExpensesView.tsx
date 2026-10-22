"use client";

import { useEffect, useMemo, useState } from "react";
import { ReceiptText, Trash2 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { ExpenseCapture } from "@/components/dashboard/ExpenseCapture";
import { ExpenseMonthTooltip } from "@/components/dashboard/ExpenseMonthTooltip";
import { useCurrency, useViewerSession } from "@/components/shared/Providers";
import { useFxRate } from "@/components/shared/useFxRate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Expenses } from "@/lib/data";
import {
  attachExpenseLedgerSummary,
  formatExpenseCategory,
  getConfirmedExpenseRecords,
  isConfirmedExpenseRecord,
  loadExpenseRecords,
  type NormalizedExpense
} from "@/lib/expense-records";
import {
  deleteExpenseRecord,
  expenseLedgerStorageLabel,
  loadExpenseLedger,
  upsertExpenseRecords,
  type ExpenseLedgerStorage
} from "@/lib/client/expense-ledger";
import { toDisplayAmount, toDisplayFromTwd } from "@/lib/fx";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useChartMotion, useTooltipMotion } from "@/components/dashboard/chart-motion";

const categoryColors: Record<string, string> = {
  food: "#43d8c9",
  traffic: "#38bdf8",
  car: "#38bdf8",
  parking: "#38bdf8",
  living: "#84cc16",
  work: "#ef6b6b",
  lifeExpense: "#a855f7",
  subscription: "#ec4899",
  entertainment: "#f97365",
  fitness: "#22c55e",
  flight: "#0ea5e9",
  travel: "#0ea5e9",
  health: "#f59e0b",
  shopping: "#8b7cf6",
  other: "#64748b",
  dailyCost: "#64748b",
  ai: "#06b6d4"
};

export function ExpensesView({ expenses, initialFxRate }: { expenses: Expenses; initialFxRate: number }) {
  const chartMotion = useChartMotion();
  const tooltipMotion = useTooltipMotion();
  const { currency } = useCurrency();
  const canWrite = useViewerSession()?.role === "admin";
  const fx = useFxRate(initialFxRate);
  const [year, setYear] = useState<"2024" | "2025" | "2026">("2026");
  const [records, setRecords] = useState<NormalizedExpense[]>([]);
  const [ledgerStorage, setLedgerStorage] = useState<ExpenseLedgerStorage>("device");
  const [isLedgerLoading, setIsLedgerLoading] = useState(true);
  const [deletingIds, setDeletingIds] = useState<string[]>([]);
  const expenseReport = useMemo(() => attachExpenseLedgerSummary(expenses, records, fx.rate), [expenses, records, fx.rate]);
  const rows = expenseReport.monthly[year];
  const categories = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((row) => {
      Object.keys(row).forEach((key) => {
        if (key !== "month" && key !== "total" && Number(row[key]) > 0) set.add(key);
      });
    });
    return [...set];
  }, [rows]);
  const average = rows.reduce((sum, row) => sum + row.total, 0) / rows.length;
  const displayRows = rows.map((row) => {
    const partialActual = expenseReport.meta.partialActuals?.[row.month];
    const ledgerMonth = expenseReport.ledger?.monthly[row.month];
    const next: Record<string, string | number> = {
      month: row.month,
      total: toDisplayFromTwd(row.total, currency, fx.rate),
      baselineStatus: partialActual || isForecastMonth(row.month, expenses.meta.actualThrough) ? "forecast" : "historical"
    };
    if (partialActual) {
      next.historicalActualTotal = toDisplayFromTwd(partialActual.total, currency, fx.rate);
      next.historicalActualThrough = partialActual.through;
    }
    if (ledgerMonth) {
      next.ledgerTotal = toDisplayFromTwd(ledgerMonth.total, currency, fx.rate);
      next.ledgerThrough = ledgerMonth.through;
      next.ledgerRecordCount = ledgerMonth.recordCount;
    }
    categories.forEach((category) => {
      next[category] = toDisplayFromTwd(Number(row[category] ?? 0), currency, fx.rate);
    });
    return next;
  });
  const totals = categories.map((category) => ({
    category,
    total: rows.reduce((sum, row) => sum + Number(row[category] ?? 0), 0)
  }));
  const biggest = [...totals].sort((a, b) => b.total - a.total)[0];
  const ledgerYearMonths = Object.values(expenseReport.ledger?.monthly ?? {})
    .filter((summary) => summary.month.startsWith(`${year}-`));
  const ledgerYearTotal = expenseReport.ledger?.yearTotals[year] ?? 0;
  const ledgerYearRecordCount = ledgerYearMonths.reduce((sum, summary) => sum + summary.recordCount, 0);
  const ledgerYearThrough = ledgerYearMonths.reduce<string | undefined>(
    (latest, summary) => !latest || summary.through > latest ? summary.through : latest,
    undefined
  );
  const confirmedRecords = useMemo(() => getConfirmedExpenseRecords(records), [records]);
  const unverifiedRecordCount = useMemo(
    () => records.filter((record) => !isConfirmedExpenseRecord(record)).length,
    [records]
  );

  useEffect(() => {
    let cancelled = false;
    const refreshCloud = async () => {
      try {
        const snapshot = await loadExpenseLedger({ retryPendingWrite: canWrite });
        if (cancelled) return;
        setRecords(snapshot.records);
        setLedgerStorage(snapshot.storage);
        if (snapshot.message) {
          toast.warning("Expense ledger needs attention", { description: snapshot.message });
        }
      } catch {
        if (cancelled) return;
        setRecords([]);
      } finally {
        if (!cancelled) setIsLedgerLoading(false);
      }
    };
    const refreshLocal = () => setRecords(loadExpenseRecords());
    void refreshCloud();
    window.addEventListener("storage", refreshLocal);
    window.addEventListener("portfolio:expenses-updated", refreshLocal);
    return () => {
      cancelled = true;
      window.removeEventListener("storage", refreshLocal);
      window.removeEventListener("portfolio:expenses-updated", refreshLocal);
    };
  }, [canWrite]);

  async function addRecord(record: NormalizedExpense) {
    const result = await upsertExpenseRecords([record]);
    setRecords(loadExpenseRecords());
    setLedgerStorage(result.storage);
    if (result.pendingReview) return { status: "review" as const };
    if (!result.saved && result.duplicates) return { status: "duplicate" as const };
    const recordYear = record.date.slice(0, 4);
    if (recordYear === "2024" || recordYear === "2025" || recordYear === "2026") setYear(recordYear);
    return { status: "saved" as const };
  }

  async function removeRecord(record: NormalizedExpense) {
    setDeletingIds((current) => [...current, record.id]);
    try {
      const storage = await deleteExpenseRecord(record.id);
      setLedgerStorage(storage);
      setRecords(loadExpenseRecords());
      toast.success("Expense removed", {
        action: {
          label: "Undo",
          onClick: () => {
            void upsertExpenseRecords([record], { restoreRevision: (record.ledgerRevision ?? 1) + 1 }).then((result) => {
              setLedgerStorage(result.storage);
              setRecords(loadExpenseRecords());
              if (result.pendingReview) toast.warning("Expense needs confirmation", { description: "It changed elsewhere; reload before restoring" });
            }).catch(error => toast.error(error instanceof Error ? error.message : "Restore failed"));
          }
        }
      });
    } catch (error) {
      setRecords(loadExpenseRecords());
      toast.error(error instanceof Error ? error.message : "Could not remove expense");
    } finally {
      setDeletingIds((current) => current.filter((id) => id !== record.id));
    }
  }

  return (
    <div className="page-stack">
      {canWrite ? (
        <ExpenseCapture fxRate={fx.rate} storage={ledgerStorage} onRecord={addRecord} />
      ) : (
        <Card>
          <CardContent className="flex items-center justify-between gap-4 py-5">
            <div>
              <p className="text-sm font-semibold">Read only access</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Sign in with owner access to add, import, or remove expense records
              </p>
            </div>
            <Badge variant="muted">Viewer</Badge>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between sm:space-y-0">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <CardTitle>Monthly spending</CardTitle>
              <Badge variant={ledgerStorage === "supabase" ? "success" : "warning"}>
                {isLedgerLoading
                  ? "Syncing ledger"
                  : confirmedRecords.length
                    ? `${confirmedRecords.length} ${ledgerStorage === "supabase" ? "synced" : "cached"} ${confirmedRecords.length === 1 ? "record" : "records"}`
                    : unverifiedRecordCount
                      ? `${unverifiedRecordCount} device-only ${unverifiedRecordCount === 1 ? "record" : "records"}`
                    : "Seed data"}
              </Badge>
            </div>
          </div>
          <Tabs value={year} onValueChange={(value) => setYear(value as typeof year)}>
            <TabsList>
              {(["2024", "2025", "2026"] as const).map((item) => (
                <TabsTrigger key={item} value={item}>{item}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent>
          <div className="mt-3 grid border-y border-border sm:grid-cols-2 sm:divide-x sm:divide-border xl:grid-cols-4">
            <Summary
              label={year === "2026" ? "Historical + forecast" : "Historical total"}
              value={formatMoney(toDisplayFromTwd(expenseReport.meta.yearTotals[year], currency, fx.rate), currency)}
              detail={year === "2026" && expenses.meta.actualThrough ? `Historical through ${formatMonthDay(expenses.meta.actualThrough)}` : undefined}
            />
            <Summary
              label="Confirmed ledger"
              value={formatMoney(toDisplayFromTwd(ledgerYearTotal, currency, fx.rate), currency)}
              detail={ledgerYearRecordCount
                ? `${ledgerYearRecordCount} ${ledgerYearRecordCount === 1 ? "record" : "records"}${ledgerYearThrough ? ` through ${formatMonthDay(ledgerYearThrough)}` : ""}`
                : "No confirmed records"}
            />
            <Summary label="Baseline monthly average" value={formatMoney(toDisplayFromTwd(average, currency, fx.rate), currency)} />
            <Summary label="Biggest baseline category" value={biggest ? formatExpenseCategory(biggest.category) : "None"} />
          </div>
          <div className="mt-7 h-[320px] sm:h-[360px]">
            <ResponsiveContainer>
              <BarChart data={displayRows} margin={{ left: -12, right: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={formatAxisThousands} tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                <Tooltip
                  {...tooltipMotion}
                  content={<ExpenseMonthTooltip currency={currency} />}
                  cursor={{ fill: "hsl(var(--muted) / 0.35)" }}
                />
                {categories.map((category) => (
                  <Bar key={category} {...chartMotion} dataKey={category} stackId="spend" fill={categoryColors[category] ?? categoryColors.other} fillOpacity={year === "2026" ? 0.84 : 1} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Baseline total</TableHead>
                  <TableHead>Baseline categories</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const partialActual = expenseReport.meta.partialActuals?.[row.month];
                  const forecast = Boolean(partialActual) || isForecastMonth(row.month, expenses.meta.actualThrough);
                  const ledgerMonth = expenseReport.ledger?.monthly[row.month];
                  const top = categories
                    .map((category) => ({ category, value: Number(row[category] ?? 0) }))
                    .filter((item) => item.value > 0)
                    .sort((a, b) => b.value - a.value)
                    .slice(0, 3);
                  return (
                    <TableRow key={row.month}>
                      <TableCell className="whitespace-nowrap font-mono font-semibold">{row.month}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1.5">
                          <Badge variant={forecast ? "warning" : "muted"}>{forecast ? "Forecast" : "Historical"}</Badge>
                          {ledgerMonth ? <Badge variant="success">Ledger</Badge> : null}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right font-mono tabular-nums">
                        <div className={cn("font-semibold", forecast && "text-muted-foreground")}>
                          {formatMoney(toDisplayFromTwd(row.total, currency, fx.rate), currency)}
                        </div>
                        {partialActual ? (
                          <div className="mt-1 text-xs text-muted-foreground">
                            Historical actual {formatMoney(toDisplayFromTwd(partialActual.total, currency, fx.rate), currency)} through {formatMonthDay(partialActual.through)}
                          </div>
                        ) : null}
                        {ledgerMonth ? (
                          <div className="mt-1 text-xs font-medium text-foreground">
                            Confirmed ledger {formatMoney(toDisplayFromTwd(ledgerMonth.total, currency, fx.rate), currency)} through {formatMonthDay(ledgerMonth.through)}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="min-w-64 text-muted-foreground">{top.map((item) => formatExpenseCategory(item.category)).join(", ")}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
          <div>
            <CardTitle>Confirmed ledger records</CardTitle>
            <CardDescription className="mt-2">
              {ledgerStorage === "supabase"
                ? "Confirmed records synced through the private Supabase ledger"
                : "Only records previously confirmed by the canonical ledger appear below"}
            </CardDescription>
            {unverifiedRecordCount ? (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                {unverifiedRecordCount} device-only {unverifiedRecordCount === 1 ? "record is" : "records are"} excluded until the canonical ledger confirms {unverifiedRecordCount === 1 ? "it" : "them"}
              </p>
            ) : null}
          </div>
          <Badge variant={ledgerStorage === "device_fallback" ? "warning" : ledgerStorage === "supabase" ? "success" : "muted"}>
            {expenseLedgerStorageLabel(ledgerStorage)}
          </Badge>
        </CardHeader>
        <CardContent>
          {confirmedRecords.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Merchant</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  {canWrite ? <TableHead className="w-14"><span className="sr-only">Actions</span></TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {confirmedRecords.map((record) => (
                  <TableRow key={record.id}>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{record.date}</TableCell>
                    <TableCell className="min-w-44 font-medium">{record.merchant}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{formatExpenseCategory(record.category)}</TableCell>
                    <TableCell><Badge variant="muted">{sourceLabel(record)}</Badge></TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono font-semibold tabular-nums">
                      {formatMoney(toDisplayAmount(record.usdValue, currency, fx.rate), currency)}
                    </TableCell>
                    {canWrite ? (
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Delete expense"
                          disabled={deletingIds.includes(record.id)}
                          onClick={() => void removeRecord(record)}
                        >
                          <Trash2 />
                          <span className="sr-only">Delete {record.merchant}</span>
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="grid min-h-44 place-items-center border-y border-border py-8 text-center">
              <div>
                <ReceiptText className="mx-auto h-6 w-6 text-muted-foreground" />
                <p className="mt-3 text-sm font-semibold">No confirmed expenses yet</p>
                <p className="mt-1 text-xs text-muted-foreground">Your next confirmed receipt will appear here</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function isForecastMonth(month: string, actualThrough?: string) {
  return actualThrough ? month > actualThrough.slice(0, 7) : false;
}

function Summary({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 px-1 py-4 sm:px-5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate font-mono text-sm font-semibold tabular-nums" title={value}>{value}</p>
      {detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function formatMonthDay(date: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00Z`));
}

function sourceLabel(record: NormalizedExpense) {
  if (record.inputMethod === "manual") return "Manual";
  if (record.inputMethod === "camera") return "Camera";
  if (record.inputMethod.startsWith("pdf")) return "PDF";
  if (record.inputMethod === "csv") return record.sourceName;
  if (record.inputMethod === "text") return "Text";
  return "Receipt OCR";
}

function formatAxisThousands(value: number) {
  const thousands = Number(value) / 1000;
  if (thousands === 0) return "0";
  return `${Math.abs(thousands) < 10 ? Number(thousands.toFixed(1)) : Math.round(thousands)}k`;
}
