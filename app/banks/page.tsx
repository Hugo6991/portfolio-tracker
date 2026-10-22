import { BanksView } from "@/components/dashboard/AccountsView";
import { PageHeader } from "@/components/shared/PageHeader";
import { getPortfolio } from "@/lib/data";
import { normalizePortfolio } from "@/lib/normalized";
import { createPageMetadata } from "@/lib/site-metadata";
import { requireViewerPage } from "@/lib/server/viewer-auth";

export const metadata = createPageMetadata(
  "Banks",
  "Privacy safe fiat balances from the latest imported records",
  "/banks"
);

export default async function BanksPage() {
  await requireViewerPage("/banks");
  const portfolio = getPortfolio();
  return (
    <div className="page-stack mx-auto max-w-7xl">
      <PageHeader title="Banks" />
      <BanksView portfolio={normalizePortfolio(portfolio)} />
    </div>
  );
}
