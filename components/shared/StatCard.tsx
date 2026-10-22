import { Card, CardContent } from "@/components/ui/card";

export function StatCard({ label, value, detail, className }: { label: string; value: string; detail?: string; className?: string }) {
  return (
    <Card className={className}>
      <CardContent className="p-5 sm:p-6">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="mt-2 font-mono text-2xl font-semibold tabular-nums">{value}</p>
        {detail ? <p className="mt-1 text-sm text-muted-foreground">{detail}</p> : null}
      </CardContent>
    </Card>
  );
}
