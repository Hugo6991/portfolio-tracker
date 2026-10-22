import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("portfolio administrator authentication", () => {
  it("fails closed without a configured password", async () => {
    const { authorizePortfolioAdmin } = await import("./portfolio-admin-auth");

    expect(authorizePortfolioAdmin("secret", undefined)).toBe("misconfigured");
  });

  it("uses a constant-length digest comparison and rejects invalid input", async () => {
    const { authorizePortfolioAdmin } = await import("./portfolio-admin-auth");

    expect(authorizePortfolioAdmin("correct", "correct")).toBe("authorized");
    expect(authorizePortfolioAdmin("wrong", "correct")).toBe("unauthorized");
    expect(authorizePortfolioAdmin(null, "correct")).toBe("unauthorized");
    expect(authorizePortfolioAdmin("x".repeat(513), "correct")).toBe("unauthorized");
  });
});
