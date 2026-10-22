import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ViewerLoginForm } from "@/components/auth/ViewerLoginForm";
import { readViewerSessionFromCookies, sanitizeReturnTo } from "@/lib/server/viewer-auth";

export const metadata: Metadata = {
  title: "Access",
  description: "Owner tools for updating Portfolio Tracker"
};

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const { returnTo } = await searchParams;
  const destination = sanitizeReturnTo(returnTo);
  const session = await readViewerSessionFromCookies().catch(() => null);
  if (session) redirect(destination);
  return <ViewerLoginForm returnTo={destination} />;
}
