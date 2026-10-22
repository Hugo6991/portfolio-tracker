type PortfolioLogLevel = "info" | "warn" | "error";

export function logPortfolioSync(
  level: PortfolioLogLevel,
  event: string,
  detail: Record<string, unknown> = {}
) {
  const record = JSON.stringify({
    scope: "portfolio-sync",
    event,
    at: new Date().toISOString(),
    ...detail
  });
  if (level === "error") console.error(record);
  else if (level === "warn") console.warn(record);
  else console.info(record);
}

export function sanitizePortfolioSyncError(error: unknown, fallback: string) {
  return (error instanceof Error ? error.message : fallback)
    .replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]")
    .slice(0, 180);
}
