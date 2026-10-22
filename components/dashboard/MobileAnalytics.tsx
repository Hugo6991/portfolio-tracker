"use client";

import { useId, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useUiPreference } from "@/lib/client/ui-preferences";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export function MobileAnalytics({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [expanded, setExpanded] = useUiPreference(`analytics:${pathname}`);
  const id = useId();
  return (
    <section className="min-w-0">
      <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}
        className="flex min-h-11 w-full items-center justify-between text-sm font-semibold sm:hidden">
        Charts <ChevronDown aria-hidden="true" className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} />
      </button>
      <div id={id} className={cn("min-w-0 sm:block", !expanded && "hidden")}>{children}</div>
    </section>
  );
}
