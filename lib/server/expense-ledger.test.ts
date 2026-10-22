import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let getExpenseLedgerProvider: typeof import("./expense-ledger").getExpenseLedgerProvider;

beforeAll(async () => {
  ({ getExpenseLedgerProvider } = await import("./expense-ledger"));
});

afterEach(() => {
  for (const key of [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "GOOGLE_SHEETS_SPREADSHEET_ID",
    "GOOGLE_SERVICE_ACCOUNT_EMAIL",
    "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"
  ]) {
    delete process.env[key];
  }
});

describe("expense ledger provider", () => {
  it("uses Supabase even when retired Google environment variables remain", () => {
    configureSupabase();
    configureRetiredGoogleEnvironment();
    expect(getExpenseLedgerProvider()).toBe("supabase");
  });

  it("does not activate a second ledger from retired Google environment variables", () => {
    configureRetiredGoogleEnvironment();
    expect(getExpenseLedgerProvider()).toBeNull();
  });

  it("returns null when no cloud ledger is configured", () => {
    expect(getExpenseLedgerProvider()).toBeNull();
  });
});

function configureSupabase() {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
}

function configureRetiredGoogleEnvironment() {
  process.env.GOOGLE_SHEETS_SPREADSHEET_ID = "sheet-id";
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "service@example.com";
  process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = "private-key";
}
