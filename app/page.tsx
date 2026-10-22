import { LiveDashboard } from "@/components/dashboard/LiveDashboard";
import { requireViewerPage } from "@/lib/server/viewer-auth";

export default async function DashboardPage() {
  await requireViewerPage("/");
  return <LiveDashboard />;
}
