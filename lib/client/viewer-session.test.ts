import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expenseStorageKey } from "@/lib/expense-records";
import { signOutViewerSession } from "./viewer-session";

const deleteQueueKey = "portfolio.expense-delete-queue.v2";
const receiptKey = "portfolio.expense-receipts.v1";
let values: Map<string, string>;
let replaceLocation: ReturnType<typeof vi.fn>;

beforeEach(() => {
  values = new Map([
    [expenseStorageKey, "private records"],
    [deleteQueueKey, "pending deletes"],
    [receiptKey, "private receipts"]
  ]);
  replaceLocation = vi.fn();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) || null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    },
    dispatchEvent: () => {},
    location: { replace: replaceLocation }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("viewer session logout", () => {
  it("clears private expense storage after the server removes the session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await signOutViewerSession();

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/viewer", { method: "DELETE" });
    expect(values.size).toBe(0);
    expect(replaceLocation).toHaveBeenCalledWith("/login");
  });

  it("clears local state even when the server does not confirm logout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await expect(signOutViewerSession()).rejects.toThrow("Sign out failed");

    expect(values.size).toBe(0);
    expect(replaceLocation).not.toHaveBeenCalled();
  });
});
