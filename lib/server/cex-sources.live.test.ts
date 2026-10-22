import { describe, expect, it, vi } from "vitest";
import { sanitizeCexError } from "../cex";

vi.mock("server-only", () => ({}));

const binanceLiveTest = process.env.RUN_BINANCE_LIVE_TEST === "1" ? it : it.skip;
const okxLiveTest = process.env.RUN_OKX_LIVE_TEST === "1" ? it : it.skip;
const bitgetLiveTest = process.env.RUN_BITGET_LIVE_TEST === "1" ? it : it.skip;
const htxLiveTest = process.env.RUN_HTX_LIVE_TEST === "1" ? it : it.skip;
const gateLiveTest = process.env.RUN_GATE_LIVE_TEST === "1" ? it : it.skip;

describe("Binance live contract", () => {
  binanceLiveTest("retrieves normalized read-only account snapshots", async () => {
    try {
      const { fetchBinanceCex } = await import("./cex-sources");
      const snapshot = await fetchBinanceCex(new Date().toISOString());

      expectHealthySnapshot(snapshot, "binance", "Binance");
    } catch (error) {
      throw new Error(`Binance live contract failed: ${sanitizeCexError(error)}`);
    }
  }, 60_000);
});

describe("OKX live contract", () => {
  okxLiveTest("retrieves normalized read-only account snapshots", async () => {
    try {
      const { fetchOkxCex } = await import("./cex-sources");
      const snapshot = await fetchOkxCex(new Date().toISOString());

      expectHealthySnapshot(snapshot, "okx", "OKX");
      expect(snapshot.status).toBe("live");
      expect(snapshot.accounts.find(account => account.id === "okx-simple-earn")?.status).toBe("live");
    } catch (error) {
      throw new Error(`OKX live contract failed: ${sanitizeCexError(error)}`);
    }
  }, 60_000);
});

describe("Bitget live contract", () => {
  bitgetLiveTest("retrieves normalized read-only account snapshots", async () => {
    try {
      const { fetchBitgetCex } = await import("./cex-sources");
      const snapshot = await fetchBitgetCex(new Date().toISOString());

      expectHealthySnapshot(snapshot, "bitget", "Bitget");
    } catch (error) {
      throw new Error(`Bitget live contract failed: ${sanitizeCexError(error)}`);
    }
  }, 60_000);
});

describe("HTX live contract", () => {
  htxLiveTest("retrieves a normalized read-only Spot snapshot", async () => {
    try {
      const { fetchHtxCex } = await import("./cex-sources");
      const snapshot = await fetchHtxCex(new Date().toISOString());

      expect(snapshot.exchange).toBe("htx");
      expect(snapshot.name).toBe("HTX");
      expect(snapshot.accounts.some((account) => account.status === "live")).toBe(true);
      expect(snapshot.itemCount).toBeGreaterThan(0);
      expect(snapshot.valueUsd).toBeGreaterThanOrEqual(0);
    } catch (error) {
      throw new Error(`HTX live contract failed: ${sanitizeCexError(error)}`);
    }
  }, 30_000);
});

describe("Gate live contract", () => {
  gateLiveTest("retrieves a normalized read-only Spot snapshot", async () => {
    try {
      const { fetchGateCex } = await import("./cex-sources");
      const snapshot = await fetchGateCex(new Date().toISOString());

      expect(snapshot.exchange).toBe("gate");
      expect(snapshot.name).toBe("Gate");
      expect(snapshot.accounts.length).toBeGreaterThanOrEqual(1);
      expect(snapshot.accounts[0].name).toBe("Spot");
      expect(snapshot.accounts[0].status).toBe("live");
      expect(snapshot.valueUsd).toBeGreaterThanOrEqual(0);
    } catch (error) {
      throw new Error(`Gate live contract failed: ${sanitizeCexError(error)}`);
    }
  }, 30_000);
});

function expectHealthySnapshot(
  snapshot: Awaited<ReturnType<typeof import("./cex-sources").fetchBinanceCex>>,
  exchange: "binance" | "okx" | "bitget",
  name: string
) {
  expect(snapshot.exchange).toBe(exchange);
  expect(snapshot.name).toBe(name);
  if (!snapshot.accounts.some((account) => account.status === "live")) {
    const accounts = snapshot.accounts.map((account) => (
      `${account.name}=${account.status}${account.error ? ` (${account.error})` : ""}`
    )).join(", ");
    throw new Error(`${name} returned no live accounts: ${accounts || "no accounts"}`);
  }
  expect(snapshot.valueUsd).toBeGreaterThanOrEqual(0);
  expect(snapshot.itemCount).toBeGreaterThanOrEqual(0);
}
