import { LiveExchangesView } from "@/components/dashboard/LiveExchangesView";
import { createPageMetadata } from "@/lib/site-metadata";
import { requireViewerPage } from "@/lib/server/viewer-auth";

export const metadata = createPageMetadata(
  "Exchanges",
  "Read only exchange balances with account coverage and freshness",
  "/exchanges"
);

export default async function ExchangesPage() {
  await requireViewerPage("/exchanges");
  return (
    <div className="mx-auto max-w-7xl">
      <LiveExchangesView />
    </div>
  );
}
