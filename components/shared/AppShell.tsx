"use client";

import Link from "next/link";
import { Portal as TooltipPortal } from "@radix-ui/react-tooltip";
import { useEffect, useState } from "react";
import { getPageReadUrls, preloadPageData, useApiQuery } from "@/lib/client/api-query";
import { usePathname } from "next/navigation";
import { Activity, Banknote, Building2, ChartNoAxesCombined, CircleDollarSign, LayoutDashboard, Menu, PanelLeftClose, PanelLeftOpen, Settings, WalletCards } from "lucide-react";
import { useUiPreference } from "@/lib/client/ui-preferences";
import { CurrencyToggle } from "./CurrencyToggle";
import { SourceLink } from "./SourceLink";
import { ThemeToggle } from "./ThemeToggle";


import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Sidebar, SidebarSection } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const items = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/assets", label: "Assets", icon: CircleDollarSign },
  { href: "/wallets", label: "Wallets", icon: WalletCards },
  { href: "/exchanges", label: "Exchanges", icon: ChartNoAxesCombined },
  { href: "/banks", label: "Banks", icon: Building2 },
  { href: "/expenses", label: "Expenses", icon: Banknote },
  { href: "/trading", label: "Trading", icon: Activity },
  { href: "/settings", label: "Settings", icon: Settings }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useUiPreference("sidebar-collapsed");

  // biome-ignore lint/correctness/useExhaustiveDependencies: A route change intentionally closes the mobile navigation.
  useEffect(() => setMobileNavOpen(false), [pathname]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeOnDesktop = () => {
      if (desktop.matches) setMobileNavOpen(false);
    };
    closeOnDesktop();
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, [mobileNavOpen]);

  return (
    <div className={cn("terminal-surface min-h-screen lg:grid", sidebarCollapsed ? "lg:grid-cols-[4.5rem_1fr]" : "lg:grid-cols-[248px_1fr]")}>
      {getPageReadUrls(pathname).map((url) => <PageReadAhead key={url} url={url} />)}
      <DesktopSidebar pathname={pathname} collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur-sm lg:hidden">
        <Brand />
        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" size="icon" className="h-11 w-11 bg-background">
              <Menu className="h-4 w-4" />
              <span className="sr-only">Open navigation</span>
            </Button>
          </SheetTrigger>
          <SheetContent
            side="right"
            className="mobile-navigation h-dvh w-80 max-w-[calc(100vw-3rem)] p-0 [&>button]:right-3 [&>button]:top-[calc(1rem+env(safe-area-inset-top))] [&>button]:flex [&>button]:h-11 [&>button]:w-11 [&>button]:items-center [&>button]:justify-center [&>button]:rounded-lg"
            overlayClassName="mobile-navigation-overlay"
          >
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <MobileNav pathname={pathname} onNavigate={() => setMobileNavOpen(false)} />
          </SheetContent>
        </Sheet>
      </header>
      <main className="page-main min-w-0">{children}</main>
    </div>
  );
}

// Mount reads together even when a chart waits for balances before it renders.
// Using the same SWR hooks also deduplicates requests already in flight.
function PageReadAhead({ url }: { url: string }) {
  useApiQuery(url);
  return null;
}

function DesktopSidebar({ pathname, collapsed, onToggle }: { pathname: string; collapsed: boolean; onToggle: () => void }) {
  return (
    <Sidebar aria-label="Sidebar" className="sticky top-0 hidden h-dvh border-r border-border lg:block">
      <div className={cn("flex h-full flex-col", collapsed ? "px-3 py-4" : "p-4")}>
        <div className={cn("flex gap-2", collapsed ? "flex-col items-center" : "items-center justify-between")}>
          <Brand compact={collapsed} />
          <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0" onClick={onToggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} aria-controls="desktop-navigation">
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </Button>
        </div>
        <Separator className="my-5" />
        <ScrollArea className="min-h-0 flex-1">
          <nav id="desktop-navigation" aria-label="Main navigation">
            <NavItems pathname={pathname} compact={collapsed} />
          </nav>
        </ScrollArea>
        <div className="mt-6 grid gap-3">
          <CurrencyToggle compact={collapsed} />
          <div className={cn("flex gap-3", collapsed ? "flex-col items-center" : "items-center justify-between")}>
            <SourceLink compact={collapsed} />
            <ThemeToggle />
          </div>

        </div>
      </div>
    </Sidebar>
  );
}

function MobileNav({ pathname, onNavigate }: { pathname: string; onNavigate: () => void }) {
  return (
    <div className="flex h-full flex-col px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-[calc(1.25rem+env(safe-area-inset-top))]">
      <div className="shrink-0 pr-10">
        <Brand onNavigate={onNavigate} />
      </div>
      <Separator className="my-5 shrink-0" />
      <nav aria-label="Main navigation" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <NavItems pathname={pathname} onNavigate={onNavigate} />
      </nav>
      <div className="mt-5 grid shrink-0 gap-3">
        <CurrencyToggle />
        <div className="flex items-center justify-between gap-3">
          <SourceLink />
          <ThemeToggle />
        </div>

      </div>
    </div>
  );
}

function Brand({ onNavigate, compact = false }: { onNavigate?: () => void; compact?: boolean }) {
  return (
    <Link href="/" onClick={onNavigate} className="flex items-center gap-3">
      <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand text-sm font-semibold text-brand-foreground shadow-xs">PT</span>
      <span className={compact ? "sr-only" : undefined}>
        <span className="block text-sm font-semibold leading-none tracking-tight text-foreground">Portfolio</span>
      </span>
    </Link>
  );
}

function NavItems({ pathname, onNavigate, compact = false }: { pathname: string; onNavigate?: () => void; compact?: boolean }) {
  return (
    <TooltipProvider delayDuration={150}>
    <SidebarSection>
      {items.map((item) => {
        const Icon = item.icon;
        const active = pathname === item.href;
        const link = (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            onMouseEnter={() => preloadPageData(item.href)}
            onFocus={() => preloadPageData(item.href)}
            onTouchStart={() => preloadPageData(item.href)}
            className={cn(
              "group flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              compact && "justify-center px-0",
              active && "bg-accent text-foreground"
            )}
          >
            <Icon aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground", active && "text-foreground")} />
            <span className={compact ? "sr-only" : undefined}>{item.label}</span>
          </Link>
        );
        return compact ? <Tooltip key={item.href}><TooltipTrigger asChild>{link}</TooltipTrigger><TooltipPortal><TooltipContent side="right">{item.label}</TooltipContent></TooltipPortal></Tooltip> : link;
      })}
    </SidebarSection>
    </TooltipProvider>
  );
}
