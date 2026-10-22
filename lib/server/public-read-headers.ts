// Kept under its original name so existing callers can migrate without a cache-policy gap.
// Portfolio responses are private and must never enter a shared CDN cache.
export function publicReadHeaders(startedAt: number, _maxAge = 30, _request?: Request) {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    "Vercel-CDN-Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Vary": "Cookie",
    "Server-Timing": `read;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}`
  };
}
