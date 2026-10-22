import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

import { DELETE, POST } from "./route";
import { VIEWER_SESSION_COOKIE, verifyViewerSessionToken } from "@/lib/viewer-session";

const viewerPassword = "viewer-password-2026";
const adminPassword = "admin-password-2026";
const sessionSecret = "session-secret-with-at-least-thirty-two-characters";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("PORTFOLIO_VIEWER_PASSWORD", viewerPassword);
  vi.stubEnv("PORTFOLIO_ACCESS_PASSWORD", adminPassword);
  vi.stubEnv("PORTFOLIO_VIEWER_SESSION_SECRET", sessionSecret);
  vi.stubEnv("SUPABASE_URL", "https://portfolio.supabase.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
    allowed: true,
    attemptCount: 1,
    retryAfterSeconds: 0
  })));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("viewer authentication API", () => {
  it("creates a read only viewer session with hardened cookie flags", async () => {
    const response = await POST(loginRequest({
      password: viewerPassword,
      returnTo: "/expenses?month=2026-10"
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      authenticated: true,
      role: "viewer",
      returnTo: "/expenses?month=2026-10"
    });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${VIEWER_SESSION_COOKIE}=`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=strict");
    expect(cookie).toContain("Max-Age=604800");
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("no-store");

    const token = cookieValue(cookie);
    await expect(verifyViewerSessionToken(token)).resolves.toMatchObject({ role: "viewer" });
  });

  it("creates a shorter administrator session", async () => {
    const response = await POST(loginRequest({
      password: adminPassword,
      returnTo: "https://attacker.test/expenses"
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      authenticated: true,
      role: "admin",
      returnTo: "/"
    });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("Max-Age=43200");
    await expect(verifyViewerSessionToken(cookieValue(cookie))).resolves.toMatchObject({ role: "admin" });
  });

  it("rejects a wrong password without issuing a cookie", async () => {
    const response = await POST(loginRequest({ password: "wrong-password" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Password not accepted" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("returns a durable rate-limit response before checking another password", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      allowed: false,
      attemptCount: 11,
      retryAfterSeconds: 701
    })));

    const response = await POST(loginRequest({ password: "wrong-password" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("701");
    await expect(response.json()).resolves.toEqual({
      error: "Too many sign in attempts. Try again later"
    });
  });

  it("fails closed when durable sign in protection is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 404 })));

    const response = await POST(loginRequest({ password: viewerPassword }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Sign in protection is temporarily unavailable"
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("fails closed when viewer access is not configured", async () => {
    vi.stubEnv("PORTFOLIO_VIEWER_SESSION_SECRET", "");

    const response = await POST(loginRequest({ password: viewerPassword }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Viewer access is not configured" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects cross origin login and logout requests", async () => {
    const login = await POST(loginRequest({ password: viewerPassword }, "https://attacker.test"));
    const logout = await DELETE(logoutRequest("https://attacker.test"));

    expect(login.status).toBe(403);
    expect(logout.status).toBe(403);
  });

  it("clears the session cookie on logout", async () => {
    const response = await DELETE(logoutRequest("https://portfolio.test"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authenticated: false });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${VIEWER_SESSION_COOKIE}=`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=strict");
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  });
});

function loginRequest(body: Record<string, unknown>, origin = "https://portfolio.test") {
  return new NextRequest("https://portfolio.test/api/auth/viewer", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin
    },
    body: JSON.stringify(body)
  });
}

function logoutRequest(origin: string) {
  return new NextRequest("https://portfolio.test/api/auth/viewer", {
    method: "DELETE",
    headers: { origin }
  });
}

function cookieValue(setCookie: string) {
  const pair = setCookie.split(";", 1)[0];
  return decodeURIComponent(pair.slice(pair.indexOf("=") + 1));
}
