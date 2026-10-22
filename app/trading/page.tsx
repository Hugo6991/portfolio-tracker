import { TradingDashboardView } from "@/components/dashboard/TradingDashboardView";
import { createPageMetadata } from "@/lib/site-metadata";
import { requireViewerPage } from "@/lib/server/viewer-auth";

export const metadata = createPageMetadata(
  "Trading",
  "Read only trading activity from the connected canary account",
  "/trading"
);

export default async function TradingPage() {
  await requireViewerPage("/trading");
  return <div className="mx-auto max-w-7xl"><TradingDashboardView/></div>;
}
