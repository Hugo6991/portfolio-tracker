"use client";

import useSWR, { preload } from "swr";
import { useState } from "react";
import { clearExpenseLedgerLocalData } from "@/lib/client/expense-ledger";

export class ApiReadError extends Error {
  constructor(message: string, public readonly status = 0) {
    super(message);
    this.name = "ApiReadError";
  }
}

// AbortController + a timer also works on Safari versions without AbortSignal.timeout.
// Race the entire operation, including body decoding, so a stalled response cannot
// leave the UI in a permanent loading state.
export async function fetchJson<T>(url: string, timeoutMs = 12_000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ApiReadError("The connection took too long. Please try again"));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { signal: controller.signal });
        const body = await response.json().catch(() => {
          throw new ApiReadError("The server returned an unreadable response. Please reload", response.status);
        });
        if (response.status === 401 && typeof window !== "undefined" && window.location.pathname !== "/login") {
          clearExpenseLedgerLocalData();

        }
        if (!response.ok || body?.configured === false) {
          throw new ApiReadError(body?.error || "Data is temporarily unavailable", response.status);
        }
        return body as T;
      })(),
      timeout
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const apiQueryOptions = {
  fetcher: fetchJson,
  dedupingInterval: 30_000,
  focusThrottleInterval: 60_000,
  refreshInterval: 300_000,
  errorRetryCount: 2,
  errorRetryInterval: 3_000,
  shouldRetryOnError: (error: ApiReadError) => !error.status || error.status >= 500
};

export function useApiQuery<T>(url: string) {
  const query = useSWR<T, ApiReadError>(url, fetchJson<T>);
  const [manualRefresh, setManualRefresh] = useState(false);
  return {
    data: query.data,
    error: query.error?.message ?? null,
    loading: !query.data && query.isLoading,
    refreshing: query.isValidating || manualRefresh,
    refresh: async (fresh = false) => {
      setManualRefresh(true);
      try {
        return await (fresh
          ? query.mutate(fetchJson<T>(`${url}${url.includes("?") ? "&" : "?"}_fresh=${Date.now()}`), { revalidate: false })
          : query.mutate());
      } finally {
        setManualRefresh(false);
      }
    }
  };
}

export const portfolioOverviewUrl = "/api/portfolio?view=overview";
export const defaultPortfolioHistoryUrl = "/api/portfolio/history?interval=daily&days=90";

const pageReads: Record<string, string[]> = {
  "/": [portfolioOverviewUrl, defaultPortfolioHistoryUrl],
  "/assets": [portfolioOverviewUrl, "/api/assets/history?days=30"],
  "/wallets": ["/api/portfolio", "/api/wallets/history?days=90"],
  "/exchanges": ["/api/cex", "/api/cex/history?days=7&interval=60"]
};

export function getPageReadUrls(pathname: string) {
  return pageReads[pathname] ?? [];
}

export function preloadPageData(pathname: string) {
  for (const url of getPageReadUrls(pathname)) {
    // A failed prefetch is retried by the mounted hook and shown in its error UI.
    void preload(url, fetchJson).catch(() => undefined);
  }
}
