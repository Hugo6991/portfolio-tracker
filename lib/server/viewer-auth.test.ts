import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { requireSameOrigin, sanitizeReturnTo, requireViewerJson } from "./viewer-auth";

describe("viewer authentication helpers", () => {
  it("allows anonymous reads but rejects anonymous administration", async () => {
    expect(await requireViewerJson(request())).toBeNull();
    expect((await requireViewerJson(request(), "admin"))?.status).toBe(401);
  });

  it("does not let a malformed old session cookie block public reads", async () => {
    const response = await requireViewerJson(new Request("https://portfolio.test/api/portfolio", {
      headers: { cookie: "portfolio_viewer_session=%invalid" }
    }));
    expect(response).toBeNull();
  });

  it("keeps allowlisted dashboard destinations and their query or hash", () => {
    expect(sanitizeReturnTo("/expenses?month=2026-10#latest")).toBe("/expenses?month=2026-10#latest");
    expect(sanitizeReturnTo("/settings")).toBe("/settings");
  });

  it.each([
    "https://attacker.test/expenses",
    "//attacker.test/expenses",
    "/\\attacker.test/expenses",
    "/api/portfolio",
    "/unknown",
    "expenses"
  ])("falls back to the dashboard for unsafe returnTo value %s", (value) => {
    expect(sanitizeReturnTo(value)).toBe("/");
  });

  it("accepts only an exact request origin", () => {
    expect(requireSameOrigin(request("https://portfolio.test"))).toBe(true);
    expect(requireSameOrigin(request("https://portfolio.test:443"))).toBe(true);
    expect(requireSameOrigin(request("https://portfolio.test:444"))).toBe(false);
    expect(requireSameOrigin(request("http://portfolio.test"))).toBe(false);
    expect(requireSameOrigin(request("https://attacker.test"))).toBe(false);
  });

  it("rejects missing, opaque, and malformed origins", () => {
    expect(requireSameOrigin(request())).toBe(false);
    expect(requireSameOrigin(request("null"))).toBe(false);
    expect(requireSameOrigin(request("not a url"))).toBe(false);
  });
});

function request(origin?: string) {
  return new Request("https://portfolio.test/api/auth/viewer", {
    headers: origin ? { origin } : undefined
  });
}
