import { SignJWT, jwtVerify } from "jose";
import { VIEWER_SESSION_COOKIE } from "@/lib/viewer-session-constants";

export { VIEWER_SESSION_COOKIE };
export const VIEWER_SESSION_ISSUER = "portfolio-tracker";
export const VIEWER_SESSION_AUDIENCE = "portfolio-viewer";
export const VIEWER_SESSION_VERSION = 1;

const viewerSessionSeconds = 7 * 24 * 60 * 60;
const adminSessionSeconds = 12 * 60 * 60;

export type ViewerRole = "viewer" | "admin";

export type ViewerSession = {
  role: ViewerRole;
  expiresAt: string;
};

type ViewerEnvironment = {
  PORTFOLIO_VIEWER_PASSWORD?: string;
  PORTFOLIO_VIEWER_SESSION_SECRET?: string;
  PORTFOLIO_ACCESS_PASSWORD?: string;
};

type ViewerConfiguration = {
  viewerPassword: string;
  adminPassword: string;
  sessionSecret: string;
};

export class ViewerConfigurationError extends Error {
  constructor(message = "Viewer access is not configured") {
    super(message);
    this.name = "ViewerConfigurationError";
  }
}

export function readViewerConfiguration(
  environment: ViewerEnvironment = process.env as ViewerEnvironment
): ViewerConfiguration {
  const viewerPassword = environment.PORTFOLIO_VIEWER_PASSWORD?.trim() ?? "";
  const adminPassword = environment.PORTFOLIO_ACCESS_PASSWORD?.trim() ?? "";
  const sessionSecret = environment.PORTFOLIO_VIEWER_SESSION_SECRET?.trim() ?? "";

  if (viewerPassword.length < 12 || adminPassword.length < 12 || sessionSecret.length < 32) {
    throw new ViewerConfigurationError();
  }
  if (viewerPassword === adminPassword || sessionSecret === viewerPassword || sessionSecret === adminPassword) {
    throw new ViewerConfigurationError("Viewer access secrets must be independent");
  }

  return { viewerPassword, adminPassword, sessionSecret };
}

export async function authenticateViewerPassword(
  password: unknown,
  environment: ViewerEnvironment = process.env as ViewerEnvironment
): Promise<ViewerRole | null> {
  const config = readViewerConfiguration(environment);
  if (typeof password !== "string" || password.length === 0 || password.length > 512) return null;

  const [admin, viewer] = await Promise.all([
    constantTimeEqual(password, config.adminPassword),
    constantTimeEqual(password, config.viewerPassword)
  ]);
  if (admin) return "admin";
  if (viewer) return "viewer";
  return null;
}

export async function createViewerSessionToken(
  role: ViewerRole,
  environment: ViewerEnvironment = process.env as ViewerEnvironment,
  now = new Date()
) {
  const config = readViewerConfiguration(environment);
  const ttlSeconds = role === "admin" ? adminSessionSeconds : viewerSessionSeconds;
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  const key = await sessionKey(config);
  const token = await new SignJWT({ role, version: VIEWER_SESSION_VERSION })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(VIEWER_SESSION_ISSUER)
    .setAudience(VIEWER_SESSION_AUDIENCE)
    .setSubject("portfolio-viewer")
    .setJti(crypto.randomUUID())
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(key);

  return { token, expiresAt, maxAge: ttlSeconds };
}

export async function verifyViewerSessionToken(
  token: string | null | undefined,
  environment: ViewerEnvironment = process.env as ViewerEnvironment,
  now = new Date()
): Promise<ViewerSession | null> {
  if (!token) return null;
  const config = readViewerConfiguration(environment);
  try {
    const { payload } = await jwtVerify(token, await sessionKey(config), {
      issuer: VIEWER_SESSION_ISSUER,
      audience: VIEWER_SESSION_AUDIENCE,
      algorithms: ["HS256"],
      currentDate: now
    });
    if (payload.version !== VIEWER_SESSION_VERSION) return null;
    if (payload.role !== "viewer" && payload.role !== "admin") return null;
    if (typeof payload.exp !== "number") return null;
    return {
      role: payload.role,
      expiresAt: new Date(payload.exp * 1000).toISOString()
    };
  } catch {
    return null;
  }
}

export function roleAllows(actual: ViewerRole, required: ViewerRole) {
  return actual === "admin" || required === "viewer";
}

async function sessionKey(config: ViewerConfiguration) {
  const material = new TextEncoder().encode([
    config.sessionSecret,
    config.viewerPassword,
    config.adminPassword,
    String(VIEWER_SESSION_VERSION)
  ].join("\u0000"));
  return new Uint8Array(await crypto.subtle.digest("SHA-256", material));
}

async function constantTimeEqual(left: string, right: string) {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)]);
  let difference = leftDigest.length ^ rightDigest.length;
  const length = Math.max(leftDigest.length, rightDigest.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftDigest[index] ?? 0) ^ (rightDigest[index] ?? 0);
  }
  return difference === 0;
}

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
