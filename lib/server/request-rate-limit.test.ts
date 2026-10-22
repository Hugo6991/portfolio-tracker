import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { consumeDurableRateLimit, DurableRateLimitError } from "./request-rate-limit";

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://portfolio.supabase.test/");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
  vi.stubEnv("PORTFOLIO_VIEWER_SESSION_SECRET", "session-secret-with-at-least-thirty-two-characters");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("durable request rate limiting", () => {
  it("stores only a keyed digest of the trusted Vercel client address", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      allowed: true,
      attemptCount: 1,
      retryAfterSeconds: 0
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await consumeDurableRateLimit(request("203.0.113.42"), {
      scope: "viewer-login",
      windowSeconds: 900,
      maxAttempts: 10
    });

    expect(result).toEqual({ rateLimited: false, retryAfterSeconds: 0 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://portfolio.supabase.test/rest/v1/rpc/consume_request_rate_limit");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ p_window_seconds: 900, p_max_attempts: 10 });
    expect(body.p_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(body)).not.toContain("203.0.113.42");
  });

  it("returns the durable retry window", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      allowed: false,
      attemptCount: 11,
      retryAfterSeconds: 812.2
    })));

    await expect(consumeDurableRateLimit(request("203.0.113.42"), {
      scope: "viewer-login",
      windowSeconds: 900,
      maxAttempts: 10
    })).resolves.toEqual({ rateLimited: true, retryAfterSeconds: 813 });
  });

  it("fails closed when durable storage is unavailable or malformed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 404 })));
    await expect(consumeDurableRateLimit(request("203.0.113.42"), {
      scope: "viewer-login",
      windowSeconds: 900,
      maxAttempts: 10
    })).rejects.toBeInstanceOf(DurableRateLimitError);
  });
});

function request(address: string) {
  return new Request("https://portfolio.test/api/auth/viewer", {
    headers: { "x-vercel-forwarded-for": address }
  });
}
