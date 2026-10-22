import { NextRequest, NextResponse } from "next/server";
import {
  authenticateViewerPassword,
  createViewerSessionToken,
  readViewerConfiguration,
  ViewerConfigurationError,
  VIEWER_SESSION_COOKIE
} from "@/lib/viewer-session";
import { privateNoStoreHeaders, requireSameOrigin, sanitizeReturnTo } from "@/lib/server/viewer-auth";
import { consumeDurableRateLimit, DurableRateLimitError } from "@/lib/server/request-rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!requireSameOrigin(request)) {
    return response({ error: "Request origin was not accepted" }, 403);
  }

  try {
    readViewerConfiguration();
  } catch (error) {
    if (error instanceof ViewerConfigurationError) {
      return response({ error: "Viewer access is not configured" }, 503);
    }
    throw error;
  }

  try {
    const limit = await consumeDurableRateLimit(request, {
      scope: "viewer-login",
      windowSeconds: 15 * 60,
      maxAttempts: 10
    });
    if (limit.rateLimited) {
      return response(
        { error: "Too many sign in attempts. Try again later" },
        429,
        { "Retry-After": String(limit.retryAfterSeconds) }
      );
    }
  } catch (error) {
    if (error instanceof DurableRateLimitError) {
      return response({ error: "Sign in protection is temporarily unavailable" }, 503);
    }
    throw error;
  }

  let body: { password?: unknown; returnTo?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return response({ error: "Invalid request" }, 400);
  }

  try {
    const role = await authenticateViewerPassword(body.password);
    if (!role) {
      await failedLoginDelay();
      return response({ error: "Password not accepted" }, 401);
    }

    const session = await createViewerSessionToken(role);
    const next = NextResponse.json(
      { authenticated: true, role, returnTo: sanitizeReturnTo(body.returnTo) },
      { headers: privateNoStoreHeaders }
    );
    next.cookies.set(VIEWER_SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      expires: session.expiresAt,
      maxAge: session.maxAge,
      priority: "high"
    });
    return next;
  } catch (error) {
    if (error instanceof ViewerConfigurationError) {
      return response({ error: "Viewer access is not configured" }, 503);
    }
    throw error;
  }
}

export async function DELETE(request: NextRequest) {
  if (!requireSameOrigin(request)) {
    return response({ error: "Request origin was not accepted" }, 403);
  }
  const next = NextResponse.json({ authenticated: false }, { headers: privateNoStoreHeaders });
  next.cookies.set(VIEWER_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    expires: new Date(0),
    maxAge: 0,
    priority: "high"
  });
  return next;
}

function response(body: Record<string, unknown>, status: number, headers?: Record<string, string>) {
  return NextResponse.json(body, {
    status,
    headers: { ...privateNoStoreHeaders, ...headers }
  });
}

async function failedLoginDelay() {
  await new Promise((resolve) => setTimeout(resolve, 450 + Math.floor(Math.random() * 200)));
}
