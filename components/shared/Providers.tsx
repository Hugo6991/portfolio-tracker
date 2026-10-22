"use client";

import { ThemeProvider } from "next-themes";
import { SWRConfig } from "swr";
import { apiQueryOptions } from "@/lib/client/api-query";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Currency } from "@/lib/fx";
import type { ViewerSession } from "@/lib/viewer-session";

type CurrencyContextValue = {
  currency: Currency;
  setCurrency: (currency: Currency) => void;
};

const CurrencyContext = createContext<CurrencyContextValue | null>(null);
const ViewerSessionContext = createContext<ViewerSession | null>(null);

export function Providers({
  children,
  viewerSession
}: {
  children: React.ReactNode;
  viewerSession: ViewerSession | null;
}) {
  const [currency, setCurrencyState] = useState<Currency>("USD");

  useEffect(() => {
    const match = document.cookie.match(/(?:^|; )currency=(USD|TWD)/);
    if (match?.[1]) setCurrencyState(match[1] as Currency);
  }, []);

  const value = useMemo(
    () => ({
      currency,
      setCurrency: (next: Currency) => {
        setCurrencyState(next);
        document.cookie = `currency=${next}; path=/; max-age=31536000; SameSite=Lax`;
      }
    }),
    [currency]
  );

  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
      <SWRConfig value={apiQueryOptions}>
        <ViewerSessionContext.Provider value={viewerSession}>
          <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>
        </ViewerSessionContext.Provider>
      </SWRConfig>
    </ThemeProvider>
  );
}

export function useCurrency() {
  const context = useContext(CurrencyContext);
  if (!context) throw new Error("useCurrency must be used inside Providers");
  return context;
}

export function useViewerSession() {
  return useContext(ViewerSessionContext);
}
