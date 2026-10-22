import { describe, expect, it } from "vitest";
import { daysSince, relativeUpdate } from "./format";

describe("update date formatting", () => {
  const now = new Date("2026-10-03T12:00:00+08:00");

  it("uses the current clock instead of a fixed build date", () => {
    expect(daysSince("2026-10-01", now)).toBe(2);
    expect(relativeUpdate("2026-10-01", now)).toBe("updated 2 days ago");
  });

  it("does not report a future dated import as stale", () => {
    expect(daysSince("2026-10-04", now)).toBe(0);
    expect(relativeUpdate("2026-10-04", now)).toBe("updated today");
  });

  it("accepts a full timestamp instead of rendering NaN", () => {
    expect(daysSince("2026-10-01T09:30:00.000Z", now)).toBe(2);
    expect(relativeUpdate("2026-10-03T01:00:00.000Z", now)).toBe("updated today");
  });
});
