"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, ReloadButton } from "@/components/shared/PageHeader";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, CircleAlert, ExternalLink, RefreshCw, ShieldAlert, WalletCards } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatCard } from "@/components/shared/StatCard";
import { formatEth, formatSignedUsdg, formatUsdg, isTradingSnapshotStale, shortAddress, type TradingDashboardSnapshot } from "@/lib/trading-dashboard";
import { cn } from "@/lib/utils";

export function TradingDashboardView() {
  const [snapshot,setSnapshot] = useState<TradingDashboardSnapshot|null>(null);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState<string|null>(null);
  const [clock,setClock] = useState(Date.now());
  const refresh = useCallback(async (announce=false) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/trading",{cache:"no-store"});
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Trading data is unavailable.");
      setSnapshot(body as TradingDashboardSnapshot);
      setClock(Date.now());
      if (announce) toast.success("Trading snapshot refreshed");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Trading data is unavailable.";
      setError(message);
      if (announce) toast.error("Refresh failed",{description:message});
    } finally { setLoading(false); }
  },[]);

  useEffect(()=>{
    void refresh();
    const poll = window.setInterval(()=>void refresh(),30_000);
    const tick = window.setInterval(()=>setClock(Date.now()),15_000);
    return ()=>{window.clearInterval(poll);window.clearInterval(tick);};
  },[refresh]);

  if (!snapshot && loading) return <div className="page-stack"><PageHeader title="Trading"/><TradingSkeleton/></div>;
  if (!snapshot) return <div className="page-stack"><PageHeader title="Trading"/><Unavailable message={error || "Trading data is unavailable."} onRetry={()=>void refresh(true)}/></div>;
  const stale = isTradingSnapshotStale(snapshot,clock);
  const degraded = snapshot.chain.status !== "healthy";

  return (
    <div className="page-stack">
      <PageHeader title="Trading" actions={<><Badge variant={snapshot.mode==="complete"?"success":"warning"}>Canary {snapshot.mode}</Badge><Badge variant={degraded?"destructive":"success"}>RPC {snapshot.chain.status}</Badge><ReloadButton onClick={()=>void refresh(true)} busy={loading}/></>}/>

      {(degraded||stale||error)&&<StatusNotice snapshot={snapshot} stale={stale} error={error}/>}

      <section className="card-grid grid sm:grid-cols-2 xl:grid-cols-4" aria-label="Trading summary">
        <StatCard label="USDG balance" value={formatUsdg(snapshot.wallet.usdgBalance)} detail={`Initial ${snapshot.performance.initialCapitalUsdg} USDG`}/>
        <StatCard label="Realized trading P&L" value={formatSignedUsdg(snapshot.performance.realizedGrossPnlUsdg)} detail="Gross USDG · ETH gas excluded" className={snapshot.performance.realizedGrossPnlUsdg!==null&&snapshot.performance.realizedGrossPnlUsdg<0?"border-red-400/25":""}/>
        <StatCard label="Execution gas" value={formatEth(snapshot.performance.confirmedExecutionGasEth)} detail="Confirmed approve + swap receipts"/>
        <StatCard label="Canary progress" value={`${snapshot.progress.completedRoundTrips}/${snapshot.progress.maximumRoundTrips}`} detail={`${snapshot.progress.openPositions} open · ${snapshot.progress.pendingOrders} pending`}/>
      </section>

      <section className="card-grid grid min-w-0 xl:grid-cols-[minmax(0,1.55fr)_minmax(300px,0.45fr)]">
        <PnlChart snapshot={snapshot}/>
        <DecisionCard snapshot={snapshot}/>
      </section>

      <TradeRecords snapshot={snapshot}/>
      <WalletCandidates snapshot={snapshot}/>

      <p className="text-xs text-muted-foreground">
        Updated {formatTime(snapshot.generatedAt)} · {shortAddress(snapshot.wallet.address)} · Net P&amp;L remains N/A until historical ETH gas can be valued in USDG without estimation.
      </p>
    </div>
  );
}

function StatusNotice({snapshot,stale,error}:{snapshot:TradingDashboardSnapshot;stale:boolean;error:string|null}) {
  const message = error || stale ? "The page is showing the last available snapshot." :
    `Primary and secondary RPC differ by ${snapshot.chain.blockDelta ?? "N/A"} blocks; the policy limit is ${snapshot.chain.maximumBlockDelta}.`;
  return <div role="status" className="flex items-start gap-3 rounded-xl border border-amber-400/25 bg-amber-400/8 px-4 py-3 text-sm text-amber-950 dark:text-amber-100">
    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300"/>
    <div><p className="font-semibold">{stale?"Trading data is stale":"RPC protection is degraded"}</p><p className="mt-1 text-xs text-amber-800/80 dark:text-amber-100/70">{message} No dashboard action can submit a transaction.</p></div>
  </div>;
}

function PnlChart({snapshot}:{snapshot:TradingDashboardSnapshot}) {
  const data = useMemo(()=>snapshot.equityCurve.map((point)=>({...point,label:`Cycle ${point.cycleNumber}`,cumulativeGrossPnlCents:Math.round(point.cumulativeGrossPnlUsdg*100)})),[snapshot.equityCurve]);
  return <Card className="min-w-0">
    <CardHeader><CardTitle>Realized P&amp;L</CardTitle><p className="text-sm text-muted-foreground">Cumulative USDG after each confirmed exit · excludes ETH gas</p></CardHeader>
    <CardContent>
      {data.length===0?<Empty icon={<Activity/>} title="No completed round trips" message="The curve appears only after a confirmed exit."/>:
      <div className="h-72" role="img" aria-label="Cumulative realized USDG profit and loss by canary cycle">
        <ResponsiveContainer><AreaChart data={data} margin={{top:12,right:8,left:0,bottom:0}}>
          <defs><linearGradient id="tradingPnlFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#ef4444" stopOpacity={0.28}/><stop offset="95%" stopColor="#ef4444" stopOpacity={0.01}/></linearGradient></defs>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.45}/>
          <XAxis dataKey="label" tick={{fontSize: 12,fill:"hsl(var(--muted-foreground))"}} tickLine={false} axisLine={false}/>
          <YAxis tickFormatter={(value:number)=>`${Math.round(value)}¢`} tick={{fontSize: 12,fill:"hsl(var(--muted-foreground))"}} tickLine={false} axisLine={false} width={48}/>
          <Tooltip formatter={(value:number)=>[`${Number(value)>0?"+":""}${Math.round(Number(value))}¢`,"Cumulative P&L"]}/>
          <Area type="monotone" dataKey="cumulativeGrossPnlCents" stroke="#ef4444" strokeWidth={2} fill="url(#tradingPnlFill)" dot={{r:3,fill:"#ef4444",strokeWidth:0}}/>
        </AreaChart></ResponsiveContainer>
      </div>}
    </CardContent>
  </Card>;
}

function DecisionCard({snapshot}:{snapshot:TradingDashboardSnapshot}) {
  const state = snapshot.decision.positionState;
  const good = state==="NONE"||state==="HOLD";
  return <Card><CardHeader><div className="flex items-center justify-between gap-3"><CardTitle>Position decision</CardTitle><Badge variant={good?"muted":"destructive"}>{state.replaceAll("_"," ")}</Badge></div></CardHeader>
    <CardContent className="space-y-5">
      <div><p className="text-sm font-semibold">{state==="NONE"?"No active position":"Existing deterministic policy only"}</p><p className="mt-1 text-sm text-muted-foreground">The five completed cycles validated execution, not token selection or a holding thesis.</p></div>
      <div className="rounded-md border border-border/70 bg-muted/25 p-3"><p className="text-xs font-semibold text-muted-foreground">Strategy pipeline</p><p className="mt-2 text-sm font-medium">Not connected</p><p className="mt-1 text-xs text-muted-foreground">LLM and social candidates cannot directly become orders.</p></div>
      <div className="flex items-start gap-2 text-xs text-muted-foreground"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0"/><span>{snapshot.decision.reasonCodes.join(" · ")}</span></div>
    </CardContent>
  </Card>;
}

function TradeRecords({snapshot}:{snapshot:TradingDashboardSnapshot}) {
  return <Card><CardHeader><CardTitle>Execution records</CardTitle><p className="text-sm text-muted-foreground">One row per reconciled canary round trip.</p></CardHeader><CardContent className="p-0">
    {snapshot.trades.length===0?<div className="p-6"><Empty icon={<Activity/>} title="No trades" message="Confirmed entries and exits will appear here."/></div>:
    <Table><TableHeader><TableRow><TableHead>Cycle</TableHead><TableHead>Trade</TableHead><TableHead>P&amp;L</TableHead><TableHead>Execution gas</TableHead><TableHead>Exit</TableHead><TableHead className="text-right">Chain</TableHead></TableRow></TableHeader>
      <TableBody>{snapshot.trades.map((trade)=><TableRow key={trade.cycleNumber}>
        <TableCell className="font-mono font-semibold">#{trade.cycleNumber}</TableCell>
        <TableCell><p className="font-medium">{formatUsdg(trade.entryUsdg)} → {trade.exitUsdg===null?"open":formatUsdg(trade.exitUsdg)}</p><p className="mt-1 text-xs text-muted-foreground">{trade.tokenSymbol} · {formatTime(trade.closedAt||trade.openedAt)}</p></TableCell>
        <TableCell className={cn("font-mono font-semibold",trade.realizedGrossPnlUsdg!==null&&trade.realizedGrossPnlUsdg<0?"text-red-600 dark:text-red-300":"text-emerald-700 dark:text-emerald-300")}>{formatSignedUsdg(trade.realizedGrossPnlUsdg)}</TableCell>
        <TableCell className="font-mono text-xs">{formatEth(trade.confirmedExecutionGasEth)}</TableCell>
        <TableCell className="max-w-52 text-xs text-muted-foreground">{trade.exitReasonCodes.join(" · ")||"Pending"}</TableCell>
        <TableCell className="text-right"><div className="flex justify-end gap-1">{trade.entryExplorerUrl&&<ExplorerLink href={trade.entryExplorerUrl} label="In"/>}{trade.exitExplorerUrl&&<ExplorerLink href={trade.exitExplorerUrl} label="Out"/>}</div></TableCell>
      </TableRow>)}</TableBody>
    </Table>}
  </CardContent>
  </Card>;
}

function WalletCandidates({snapshot}:{snapshot:TradingDashboardSnapshot}) {
  return <Card><CardHeader><div className="flex flex-wrap items-center justify-between gap-2"><div><CardTitle>Wallet candidates</CardTitle><p className="mt-1 text-sm text-muted-foreground">Robinhood Chain observations only. Candidates never trigger copy trades.</p></div><Badge variant="muted">Quarantined by default</Badge></div></CardHeader><CardContent className={snapshot.walletCandidates.length?"p-0":""}>
    {snapshot.walletCandidates.length===0?<Empty icon={<WalletCards/>} title="No reviewable wallets yet" message="Addresses appear only after finalized on-chain swaps are observed. No smart-money label is invented from one trade."/>:
    <Table><TableHeader><TableRow><TableHead>Wallet</TableHead><TableHead>Sample</TableHead><TableHead>Net P&amp;L</TableHead><TableHead>Coverage</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
      <TableBody>{snapshot.walletCandidates.map((wallet)=><TableRow key={wallet.address}>
        <TableCell><a href={wallet.explorerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-primary hover:underline">{shortAddress(wallet.address)}<ExternalLink className="h-3 w-3"/></a><p className="mt-1 text-xs text-muted-foreground">Last {formatTime(wallet.lastSeenAt)}</p></TableCell>
        <TableCell>{wallet.completeRoundTrips} trips · {wallet.activeDays} days</TableCell><TableCell className="font-mono">{formatSignedUsdg(wallet.netRealizedPnlUsdg)}</TableCell>
        <TableCell>{wallet.coveragePercent.toFixed(0)}%</TableCell><TableCell><Badge variant={wallet.performanceStatus==="reviewable"?"warning":"muted"}>{wallet.performanceStatus.replaceAll("_"," ")}</Badge></TableCell>
      </TableRow>)}</TableBody></Table>}
  </CardContent>
  </Card>;
}

function ExplorerLink({href,label}:{href:string;label:string}) { return <Button asChild variant="ghost" size="sm"><a href={href} target="_blank" rel="noreferrer">{label}<ExternalLink/></a></Button>; }
function Empty({icon,title,message}:{icon:React.ReactNode;title:string;message:string}) { return <div className="grid min-h-44 place-items-center rounded-md border border-dashed border-border/70 p-6 text-center"><div><div className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:h-5 [&_svg]:w-5">{icon}</div><p className="mt-3 font-semibold">{title}</p><p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{message}</p></div></div>; }
function Unavailable({message,onRetry}:{message:string;onRetry:()=>void}) { return <Card><CardContent className="grid min-h-96 place-items-center p-6 text-center"><div><CircleAlert className="mx-auto h-8 w-8 text-red-500"/><h1 className="mt-4 text-2xl font-semibold">Trading data unavailable</h1><p className="mt-2 text-sm text-muted-foreground">{message}</p><Button onClick={onRetry} className="mt-5"><RefreshCw/>Retry</Button></div></CardContent></Card>; }
function TradingSkeleton() { return <div className="space-y-6"><div className="flex justify-between"><Skeleton className="h-10 w-60"/><Skeleton className="h-10 w-28"/></div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{["trading-loading-1", "trading-loading-2", "trading-loading-3", "trading-loading-4"].map((key)=><Skeleton key={key} className="h-28 rounded-lg"/>)}</div><Skeleton className="h-96 rounded-lg"/><Skeleton className="h-80 rounded-lg"/></div>; }
function formatTime(value:string) { return new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Taipei",month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(value)); }
