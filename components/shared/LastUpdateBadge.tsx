import { daysSince, relativeUpdate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function LastUpdateBadge({ date }: { date: string }) {
  const days = daysSince(date);
  return (
    <Badge
      variant={days > 7 ? "destructive" : days > 1 ? "warning" : "success"}
      className={cn("font-mono", days > 7 && "text-red-300")}
    >
      {relativeUpdate(date)}
    </Badge>
  );
}
