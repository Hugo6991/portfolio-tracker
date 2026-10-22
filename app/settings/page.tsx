import { FxRateConsole } from "@/components/dashboard/DataAccessConsole";
import { PortfolioHealthConsole } from "@/components/dashboard/PortfolioHealthConsole";
import { CsvImportConsole } from "@/components/dashboard/CsvImportConsole";
import { PageHeader } from "@/components/shared/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getPortfolio } from "@/lib/data";
import { getExpenseLedgerProvider } from "@/lib/server/expense-ledger";
import { createPageMetadata } from "@/lib/site-metadata";
import { requireViewerPage } from "@/lib/server/viewer-auth";
import { ViewerSessionControl } from "@/components/shared/ViewerSessionControl";

export const metadata = createPageMetadata(
  "Settings",
  "Portfolio source health and sync cadence",
  "/settings"
);

export default async function SettingsPage() {
  const session = await requireViewerPage("/settings");
  const portfolio = getPortfolio();
  const expenseLedgerProvider = getExpenseLedgerProvider();
  const expenseLedgerConfigured = expenseLedgerProvider !== null;
  const debankConfigured = Boolean(process.env.DEBANK_ACCESS_KEY);

  return (
    <div className="page-stack mx-auto max-w-7xl">
      <PageHeader title="Settings" />
      {session?.role === "admin" ? <ViewerSessionControl /> : null}
      <div className="card-grid grid xl:grid-cols-[1.1fr_0.9fr]">
        <Card className="min-w-0">
          <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
            <div>
              <CardTitle>On-chain wallet sync</CardTitle>
              <p className="mt-2 text-sm text-muted-foreground">
                DeBank covers supported EVM chains. Hyperliquid staking and trading equity are reconciled directly by address.
              </p>
            </div>
            <Badge variant={debankConfigured ? "success" : "warning"}>{debankConfigured ? "Connected" : "Pending setup"}</Badge>
          </CardHeader>
          <CardContent className="grid gap-4">
            <ConnectionRow label="Credentials" value="Managed server-side" />
            <ConnectionRow label="DeBank value cadence" value="2 wallets daily · full rotation every 6 days" />
            <ConnectionRow label="DeBank detail cadence" value="Monthly · first day" />
            <ConnectionRow label="Liquid-token prices" value="DefiLlama · every 15 minutes" />
            <ConnectionRow label="Hyperliquid cadence" value="Every 15 minutes" />
            <ConnectionRow label="Configured wallets" value={String(portfolio.wallets.filter((wallet) => wallet.address?.startsWith("0x")).length)} />
            <p className="text-xs leading-5 text-muted-foreground">
              Settings are intentionally read-only here. Updating a provider key requires rotating the server environment secret so credentials never enter browser state.
            </p>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader><CardTitle>FX rate</CardTitle></CardHeader>
          <CardContent>
            <FxRateConsole portfolio={portfolio} />
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
            <div>
              <CardTitle>
                Cloud expense ledger
              </CardTitle>
              <p className="mt-2 text-sm text-muted-foreground">
                Receipt and statement records share one append-only Supabase ledger. Device storage is a local cache, not a second ledger
              </p>
            </div>
            <Badge variant={expenseLedgerConfigured ? "success" : "warning"}>
              {expenseLedgerConfigured ? "Connected" : "Pending setup"}
            </Badge>
          </CardHeader>
          <CardContent className="grid gap-2">
            <ConnectionRow
              label="Storage"
              value={expenseLedgerProvider === "supabase"
                ? "Supabase + device cache"
                : "Device cache only"}
            />
            <ConnectionRow label="Provider priority" value="Supabase, then device cache" />
            <ConnectionRow label="Write model" value="Append-only audit log" />
            {!expenseLedgerConfigured ? (
              <p className="pt-2 text-xs leading-5 text-muted-foreground">
                Add one Supabase project to enable portfolio snapshots, history, receipt records, and statement imports. Until then, the device cache remains local only
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
            <div>
              <CardTitle>CEX read-only APIs</CardTitle>
              <p className="mt-2 text-sm text-muted-foreground">Add read-only keys only. Trading and withdrawal permissions should stay disabled.</p>
            </div>
            <Badge variant="muted">Credentials</Badge>
          </CardHeader>
          <CardContent className="grid gap-3">
            {portfolio.cex.map((account) => (
              <div key={account.id} className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/25 p-4">
                <div>
                  <p className="font-semibold">{account.name}</p>
                  <p className="text-xs text-muted-foreground">Read-only sync</p>
                </div>
                <Badge variant="muted">Server-managed</Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
            <div>
              <CardTitle>CSV imports</CardTitle>
              <p className="mt-2 text-sm text-muted-foreground">Bank, Alipay, and WeChat files can feed fiat balance and expense adapters.</p>
            </div>
            <Badge variant="success">Ready</Badge>
          </CardHeader>
          <CardContent>
            {session?.role === "admin" ? (
              <CsvImportConsole initialFxRate={portfolio.meta.fxTwdUsd} />
            ) : (
              <p className="text-sm leading-6 text-muted-foreground">
                <a href="/login?returnTo=/settings" className="underline">Sign in with owner access</a> to import CSV records
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Live source health</CardTitle>
          <p className="mt-2 text-sm text-muted-foreground">Read-only timing and budget telemetry. No balances, addresses, account IDs, or raw provider responses are returned.</p>
        </CardHeader>
        <CardContent>
          <PortfolioHealthConsole />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Data priority</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-border/70 bg-muted/25 p-4">
            <p className="font-semibold">1. On-chain truth</p>
            <p className="mt-2 text-sm text-muted-foreground">DeBank address sync replaces static wallet values and aggregates EVM assets across chains.</p>
          </div>
          <div className="rounded-xl border border-border/70 bg-muted/25 p-4">
            <p className="font-semibold">2. Exchange truth</p>
            <p className="mt-2 text-sm text-muted-foreground">CEX read-only APIs replace manual exchange totals once keys are configured.</p>
          </div>
          <div className="rounded-xl border border-border/70 bg-muted/25 p-4">
            <p className="font-semibold">3. Fiat import truth</p>
            <p className="mt-2 text-sm text-muted-foreground">Bank, Alipay, and WeChat CSVs become the source for cash and expense views.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Security rules</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          API keys are stored as server-side environment variables and never rendered into browser forms. DeBank keys exposed in screenshots or logs must be rotated before purchasing units.
        </CardContent>
      </Card>
    </div>
  );
}

function ConnectionRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/70 py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}
