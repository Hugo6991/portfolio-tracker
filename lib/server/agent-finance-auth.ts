import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

export type AgentFinanceAuthResult = "authorized" | "unauthorized" | "misconfigured";

export function authorizeAgentFinance(
  authorization: string | null,
  expectedHash = process.env.AGENT_FINANCE_API_TOKEN_SHA256
): AgentFinanceAuthResult {
  if (!expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash)) return "misconfigured";
  if (!authorization?.startsWith("Bearer ")) return "unauthorized";

  const token = authorization.slice("Bearer ".length).trim();
  if (!token) return "unauthorized";

  const actual = Buffer.from(createHash("sha256").update(token).digest("hex"), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? "authorized"
    : "unauthorized";
}
