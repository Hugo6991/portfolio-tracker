import { PageHeader } from "@/components/shared/PageHeader";
import { LiveAssetsView } from "@/components/dashboard/LiveAssetsView";
import { createPageMetadata } from "@/lib/site-metadata";
import { requireViewerPage } from "@/lib/server/viewer-auth";

export const metadata = createPageMetadata(
  "Assets",
  "Current holdings merged by symbol across every connected source",
  "/assets"
);

export default async function AssetsPage() {
  await requireViewerPage("/assets");
  return (
    <div className="page-stack mx-auto max-w-7xl">
      <PageHeader title="Assets" />
      <LiveAssetsView />
    </div>
  );
}
