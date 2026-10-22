"use client";

import { clearExpenseLedgerLocalData } from "@/lib/client/expense-ledger";

export async function signOutViewerSession() {
  const response = await fetch("/api/auth/viewer", { method: "DELETE" }).finally(
    clearExpenseLedgerLocalData
  );
  if (!response.ok) throw new Error("Sign out failed");
  window.location.replace("/login");
}
