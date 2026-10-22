import { LiveWalletsView } from "@/components/dashboard/LiveWalletsView";
import { createPageMetadata } from "@/lib/site-metadata";
import { requireViewerPage } from "@/lib/server/viewer-auth";

export const metadata = createPageMetadata(
  "Wallets",
  "Onchain balances and source freshness across tracked wallets",
  "/wallets"
);

export default async function WalletsPage() {
  await requireViewerPage("/wallets");
  return (
    <div className="mx-auto max-w-7xl">
      <LiveWalletsView />
    </div>
  );
}
