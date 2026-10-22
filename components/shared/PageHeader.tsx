"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * One header for every page: the title on the left, at most one action on the right.
 * Spacing below the header comes from the page stack (section gap), not from here.
 */
export function PageHeader({ title, actions }: { title: string; actions?: React.ReactNode; kicker?: string }) {
  return (
    <header className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 sm:px-0">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
    </header>
  );
}

/** The single reload control used by every page. Two words at most, same width everywhere. */
export function ReloadButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <Button variant="outline" onClick={onClick} disabled={busy} className="min-w-28 bg-card">
      <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} />
      Reload
    </Button>
  );
}
