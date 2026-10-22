import "server-only";

import { createHmac } from "node:crypto";

export type DurableRateLimitOptions = {
  scope: string;
  windowSeconds: number;
  maxAttempts: number;
};

export type DurableRateLimitResult = {
  rateLimited: boolean;
  retryAfterSeconds: number;
};

export class DurableRateLimitError extends Error {
  constructor(message = "Durable rate limiting is unavailable") {
    super(message);
    this.name = "DurableRateLimitError";
  }
}

export async function consumeDurableRateLimit(
  request: Request,
  options: DurableRateLimitOptions
): Promise<DurableRateLimitResult> {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const hashSecret = process.env.PORTFOLIO_VIEWER_SESSION_SECRET;
  if (!url || !serviceRoleKey || !hashSecret || hashSecret.length < 32) {
    throw new DurableRateLimitError();
  }

  const clientAddress = request.headers.get("x-vercel-forwarded-for")
    ?? request.headers.get("x-forwarded-for")
    ?? "unknown";
  const normalizedAddress = clientAddress.split(",", 1)[0]?.trim() || "unknown";
  const keyHash = createHmac("sha256", hashSecret)
    .update(`${options.scope}\u0000${normalizedAddress}`)
    .digest("hex");

  let response: Response;
  try {
    response = await fetch(`${url}/rest/v1/rpc/consume_request_rate_limit`, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        p_key_hash: keyHash,
        p_window_seconds: options.windowSeconds,
        p_max_attempts: options.maxAttempts
      })
    });
  } catch {
    throw new DurableRateLimitError();
  }

  if (!response.ok) throw new DurableRateLimitError();
  const result = await response.json().catch(() => null) as {
    allowed?: unknown;
    retryAfterSeconds?: unknown;
  } | null;
  if (!result || typeof result.allowed !== "boolean" || typeof result.retryAfterSeconds !== "number") {
    throw new DurableRateLimitError();
  }

  return {
    rateLimited: !result.allowed,
    retryAfterSeconds: Math.max(0, Math.ceil(result.retryAfterSeconds))
  };
}
