import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  roleAllows,
  verifyViewerSessionToken,
  ViewerConfigurationError,
  VIEWER_SESSION_COOKIE,
  type ViewerRole,
  type ViewerSession
} from "@/lib/viewer-session";

export const privateNoStoreHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "Vercel-CDN-Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Vary": "Cookie"
};

const dashboardPaths = new Set([
  "/",
  "/assets",
  "/wallets",
  "/exchanges",
  "/banks",
  "/expenses",
  "/trading",
  "/settings"
]);

export async function readViewerSessionFromRequest(request: Request) {
  return readSession(cookieValue(request.headers.get("cookie"), VIEWER_SESSION_COOKIE));
}

export async function readViewerSessionFromCookies() {
  const store = await cookies();
  return readSession(store.get(VIEWER_SESSION_COOKIE)?.value);
}

export async function requireViewerPage(returnTo: string, requiredRole: ViewerRole = "viewer") {
  // Public browsing is independent of owner credentials and session availability.
  if (requiredRole === "viewer") return readViewerSessionFromCookies().catch(() => null);
  const session = await readViewerSessionFromCookies();
  if (!session || !roleAllows(session.role, requiredRole)) {
    redirect(`/login?returnTo=${encodeURIComponent(sanitizeReturnTo(returnTo))}`);
  }
  return session;
}

export async function requireViewerJson(request: Request, requiredRole: ViewerRole = "viewer") {
  if (requiredRole === "viewer") return null;
  try {
    const session = await readViewerSessionFromRequest(request);
    if (session && roleAllows(session.role, requiredRole)) return null;
    return Response.json(
      { error: requiredRole === "admin" ? "Admin access required" : "Viewer access required" },
      { status: 401, headers: privateNoStoreHeaders }
    );
  } catch (error) {
    if (error instanceof ViewerConfigurationError) {
      return Response.json(
        { error: "Viewer access is not configured" },
        { status: 503, headers: privateNoStoreHeaders }
      );
    }
    throw error;
  }
}

export async function hasViewerRole(request: Request, requiredRole: ViewerRole = "viewer") {
  try {
    const session = await readViewerSessionFromRequest(request);
    return Boolean(session && roleAllows(session.role, requiredRole));
  } catch (error) {
    if (error instanceof ViewerConfigurationError) return false;
    throw error;
  }
}

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function sanitizeReturnTo(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/";
  }
  let url: URL;
  try {
    url = new URL(value, "https://portfolio.invalid");
  } catch {
    return "/";
  }
  if (!dashboardPaths.has(url.pathname)) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

function cookieValue(header: string | null, name: string) {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

async function readSession(token: string | undefined): Promise<ViewerSession | null> {
  return verifyViewerSessionToken(token);
}
