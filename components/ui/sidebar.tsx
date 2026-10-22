import * as React from "react";
import { cn } from "@/lib/utils";

export function Sidebar({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return <aside className={cn("border-border bg-sidebar text-sidebar-foreground", className)} {...props} />;
}

export function SidebarSection({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("grid gap-1", className)} {...props} />;
}
