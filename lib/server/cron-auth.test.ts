import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let isCronRequestAuthorized: typeof import("./cron-auth").isCronRequestAuthorized;

beforeAll(async () => {
  ({ isCronRequestAuthorized } = await import("./cron-auth"));
});

describe("cron authorization", () => {
  it("accepts only the exact bearer secret", () => {
    expect(isCronRequestAuthorized("Bearer test-secret-1234", "test-secret-1234")).toBe(true);
    expect(isCronRequestAuthorized("Bearer wrong-secret", "test-secret-1234")).toBe(false);
  });

  it("fails closed when the secret or header is missing", () => {
    expect(isCronRequestAuthorized(null, "test-secret-1234")).toBe(false);
    expect(isCronRequestAuthorized("Bearer test-secret-1234", undefined)).toBe(false);
  });
});
