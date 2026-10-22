import { ExpensesView } from "@/components/dashboard/ExpensesView";
import { PageHeader } from "@/components/shared/PageHeader";
import { getExpenses, getPortfolio } from "@/lib/data";
import { createPageMetadata } from "@/lib/site-metadata";
import { requireViewerPage } from "@/lib/server/viewer-auth";

export const metadata = createPageMetadata(
  "Expenses",
  "Monthly spending and forecasts from captured expense records",
  "/expenses"
);

export default async function ExpensesPage() {
  await requireViewerPage("/expenses");
  const portfolio = getPortfolio();

  return (
    <div className="page-stack mx-auto max-w-7xl">
      <PageHeader title="Expenses" />
      <ExpensesView expenses={getExpenses()} initialFxRate={portfolio.meta.fxTwdUsd} />
    </div>
  );
}
