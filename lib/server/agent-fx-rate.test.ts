import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agent FX rate", () => {
  it("returns the bounded seed fallback when the live FX service fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { readAgentFxRate } = await import("./agent-fx-rate");

    await expect(readAgentFxRate()).resolves.toMatchObject({
      base: "USD",
      quote: "TWD",
      rate: 31,
      status: "stale"
    });
  });

  it("returns a validated live TWD rate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      result: "success",
      time_last_update_utc: "2026-09-05T00:00:00.000Z",
      rates: { TWD: 32.25, CNY: 7.2 }
    }), { status: 200 })));
    const { readAgentFxRate } = await import("./agent-fx-rate");

    await expect(readAgentFxRate()).resolves.toMatchObject({
      rate: 32.25,
      fetchedAt: "2026-09-05T00:00:00.000Z",
      status: "updated_today"
    });
  });
});
