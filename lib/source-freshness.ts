import type { LiveSourceStatus } from "./live-portfolio";

export const manualSourceFreshHours = 7 * 24;
export const manualSourceUsableHours = 30 * 24;

export function getManualSourceFreshness(
  status: LiveSourceStatus,
  ageHours: number | null
): "fresh" | "late" | "stale" {
  if (status === "error" || ageHours === null || !Number.isFinite(ageHours)) return "stale";
  if (ageHours <= manualSourceFreshHours) return "fresh";
  return ageHours <= manualSourceUsableHours ? "late" : "stale";
}
