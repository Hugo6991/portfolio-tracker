import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("private finance bearer authentication", () => {
  it("fails closed when the hash is missing or malformed", async () => {
    const { authorizeAgentFinance } = await import("./agent-finance-auth");
    expect(authorizeAgentFinance("Bearer secret", undefined)).toBe("misconfigured");
    expect(authorizeAgentFinance("Bearer secret", "not-a-hash")).toBe("misconfigured");
  });

  it("accepts only a bearer token matching the configured sha256 hash", async () => {
    const { authorizeAgentFinance } = await import("./agent-finance-auth");
    const hash = createHash("sha256").update("local-only-token").digest("hex");

    expect(authorizeAgentFinance(null, hash)).toBe("unauthorized");
    expect(authorizeAgentFinance("Basic local-only-token", hash)).toBe("unauthorized");
    expect(authorizeAgentFinance("Bearer wrong", hash)).toBe("unauthorized");
    expect(authorizeAgentFinance("Bearer local-only-token", hash)).toBe("authorized");
  });
});
