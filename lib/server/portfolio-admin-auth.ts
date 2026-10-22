import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

export type PortfolioAdminAuthResult = "authorized" | "unauthorized" | "misconfigured";

export function authorizePortfolioAdmin(
  password: unknown,
  expectedPassword = process.env.PORTFOLIO_ACCESS_PASSWORD
): PortfolioAdminAuthResult {
  if (!expectedPassword) return "misconfigured";
  if (typeof password !== "string" || password.length === 0 || password.length > 512) {
    return "unauthorized";
  }

  const actual = createHash("sha256").update(password).digest();
  const expected = createHash("sha256").update(expectedPassword).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? "authorized"
    : "unauthorized";
}
