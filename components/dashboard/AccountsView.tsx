"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import { LastUpdateBadge } from "@/components/shared/LastUpdateBadge";
import { useCurrency } from "@/components/shared/Providers";
import { useFxRate } from "@/components/shared/useFxRate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Portfolio } from "@/lib/data";
import { getAccountCategory } from "@/lib/display";
import { toDisplayAmount } from "@/lib/fx";
import { compactAddress, formatMoney, formatNullableMoney, formatPercent } from "@/lib/format";

export function ExchangesView({ portfolio }: { portfolio: Portfolio }) {
  const { currency } = useCurrency();
  const fx = useFxRate(portfolio.meta.fxTwdUsd);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle>Exchange balances</CardTitle>
        <Badge variant="warning">Seed data</Badge>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader><TableRow><TableHead>Account</TableHead><TableHead>Assets</TableHead><TableHead className="text-right">Value</TableHead><TableHead className="text-right">Share</TableHead><TableHead className="text-right">Updated</TableHead></TableRow></TableHeader>
          <TableBody>
            {portfolio.cex.map((account) => (
              <TableRow key={account.id}>
                <TableCell><AccountCell name={account.name} /></TableCell>
                <TableCell><AssetBadges values={account.assets} /></TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatMoney(toDisplayAmount(account.valueUsd, currency, fx.rate), currency)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatPercent((account.valueUsd / portfolio.summary.cexUsd) * 100)}</TableCell>
                <TableCell className="text-right"><LastUpdateBadge date={account.lastUpdate} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function WalletsView({ portfolio }: { portfolio: Portfolio }) {
  const { currency } = useCurrency();
  const fx = useFxRate(portfolio.meta.fxTwdUsd);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle>Wallet balances</CardTitle>
        <Badge variant="warning">Seed data</Badge>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader><TableRow><TableHead>Account</TableHead><TableHead>Sync scope</TableHead><TableHead>Address</TableHead><TableHead>Assets</TableHead><TableHead className="text-right">Value</TableHead><TableHead className="text-right">Updated</TableHead></TableRow></TableHeader>
          <TableBody>
            {portfolio.wallets.map((wallet) => (
              <TableRow key={wallet.id}>
                <TableCell><AccountCell name={wallet.name} detail={getAccountCategory(wallet)} /></TableCell>
                <TableCell><Badge variant="outline">All EVM chains</Badge></TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-2 font-mono text-xs text-muted-foreground"
                    onClick={() => {
                      if (wallet.address) navigator.clipboard.writeText(wallet.address);
                      toast.success(wallet.address ? "Address copied" : "No address available");
                    }}
                  >
                    {compactAddress(wallet.address)}
                    <Copy className="h-3 w-3" />
                  </Button>
                </TableCell>
                <TableCell><AssetBadges values={wallet.assets} /></TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatMoney(toDisplayAmount(wallet.valueUsd, currency, fx.rate), currency)}</TableCell>
                <TableCell className="text-right"><LastUpdateBadge date={wallet.lastUpdate} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function BanksView({ portfolio }: { portfolio: Portfolio }) {
  const { currency } = useCurrency();
  const fx = useFxRate(portfolio.meta.fxTwdUsd);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle>Bank balances</CardTitle>
        <Badge variant="success">Sanitized CSV</Badge>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader><TableRow><TableHead>Balance group</TableHead><TableHead>Scope</TableHead><TableHead>Assets</TableHead><TableHead className="text-right">Value</TableHead><TableHead className="text-right">Updated</TableHead></TableRow></TableHeader>
          <TableBody>
            {portfolio.banks.map((bank) => (
              <TableRow key={bank.id}>
                <TableCell><AccountCell name={bank.name} detail={getAccountCategory(bank)} /></TableCell>
                <TableCell className="text-muted-foreground">All linked accounts</TableCell>
                <TableCell>{bank.assets.length ? <AssetBadges values={bank.assets} /> : <Badge variant="warning">Pending valuation</Badge>}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatNullableMoney(bank.valueUsd == null ? null : toDisplayAmount(bank.valueUsd, currency, fx.rate), currency)}</TableCell>
                <TableCell className="text-right"><LastUpdateBadge date={bank.lastUpdate} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function AssetBadges({ values }: { values: string[] }) {
  return <div className="flex flex-wrap gap-1.5">{values.map((asset) => <Badge key={asset} variant="muted">{asset}</Badge>)}</div>;
}

function AccountCell({ name, detail }: { name: string; detail?: string }) {
  return (
    <div className="min-w-48">
      <div className="font-semibold">{name}</div>
      {detail ? <div className="text-sm text-muted-foreground">{detail}</div> : null}
    </div>
  );
}
