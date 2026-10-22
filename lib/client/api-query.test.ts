import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson, apiQueryOptions } from "./api-query";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("bounded public data requests", () => {
  it("reads a response without requiring AbortSignal.timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"value":12}')));
    expect(await fetchJson("/api/example")).toEqual({ value: 12 });
  });

  it("ends loading even if the transport ignores cancellation", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    const result = expect(fetchJson("/api/example", 100)).rejects.toThrow("took too long");
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("also bounds a response body that stops arriving", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: () => new Promise(() => undefined) })));
    const result = expect(fetchJson("/api/example", 100)).rejects.toThrow("took too long");
    await vi.advanceTimersByTimeAsync(100);
    await result;
  });

  it("shows an actionable error for HTML or invalid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Service unavailable</html>", { status: 503 })));
    await expect(fetchJson("/api/example")).rejects.toThrow("unreadable response");
  });

  it("does not retry authorization failures indefinitely", () => {
    expect(apiQueryOptions.shouldRetryOnError({ status: 401 } as never)).toBe(false);
    expect(apiQueryOptions.shouldRetryOnError({ status: 503 } as never)).toBe(true);
    expect(apiQueryOptions.errorRetryCount).toBe(2);
  });

  it("clears private cache on auth failure without interrupting public browsing", async () => {
    const replace = vi.fn();
    const removeItem = vi.fn();
    vi.stubGlobal("window", {
      location: { pathname: "/wallets", search: "?days=90", replace },
      localStorage: { removeItem },
      dispatchEvent: vi.fn()
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"Viewer access required"}', { status: 401 })));

    await expect(fetchJson("/api/portfolio")).rejects.toThrow("Viewer access required");
    expect(removeItem.mock.calls.map(([key]) => key)).toEqual([
      "portfolio.expense-records.v1",
      "portfolio.expense-delete-queue.v2",
      "portfolio.expense-write-queue.v1",
      "portfolio.expense-receipts.v1"
    ]);
    expect(replace).not.toHaveBeenCalled();
  });
});
