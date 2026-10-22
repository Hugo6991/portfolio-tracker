import "server-only";

import { timingSafeEqual } from "node:crypto";

export function isCronRequestAuthorized(
  authorization: string | null,
  secret: string | undefined
) {
  if (!secret || !authorization) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const provided = Buffer.from(authorization);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
