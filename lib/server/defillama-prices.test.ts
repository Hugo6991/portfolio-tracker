import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveWalletToken } from "@/lib/live-portfolio";

vi.mock("server-only", () => ({}));

import {
  fetchDefiLlamaPrices,
  getDefiLlamaPriceKey
} from "./defillama-prices";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("DefiLlama price lookup", () => {
  it("uses exact chain and contract identifiers and excludes dust", () => {
    const contract = `0x${"a".repeat(40)}`;

    expect(getDefiLlamaPriceKey(token({ contractAddress: contract, valueUsd: 10 })))
      .toBe(`ethereum:${contract}`);
    expect(getDefiLlamaPriceKey(token({ contractAddress: contract, valueUsd: 0.99, snapshotValueUsd: 0.99 })))
      .toBeNull();
    expect(getDefiLlamaPriceKey(token({ contractAddress: null, symbol: "ETH", valueUsd: 0.1 })))
      .toBe("coingecko:ethereum");
    expect(getDefiLlamaPriceKey(token({ contractAddress: null, symbol: "USDC", valueUsd: 10_000 })))
      .toBeNull();
    expect(getDefiLlamaPriceKey(token({
      chainId: "bsc",
      symbol: "BNB",
      contractAddress: "0x9335d29adc453201ccb1184b8842d7cb8d294444",
      snapshotValueUsd: 795_218
    }))).toBeNull();
  });

  it("batches at 50 identifiers and sends no wallet, amount, or provider credential", async () => {
    const timestamp = Date.parse("2026-09-11T01:00:00.000Z") / 1_000;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const decoded = decodeURIComponent(String(input));
      const keys = decoded.split("/prices/current/")[1].split(",");
      return response({
        coins: Object.fromEntries(keys.map((key) => [key, { price: 2, confidence: 0.99, timestamp }]))
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const tokens = Array.from({ length: 51 }, (_, index) => token({
      contractAddress: `0x${index.toString(16).padStart(40, "0")}`,
      amount: 123.456,
      valueUsd: 10
    }));

    const result = await fetchDefiLlamaPrices(tokens, "2026-09-11T01:00:00.000Z");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.quotes.size).toBe(51);
    expect(result.quotes.values().next().value).toMatchObject({
      confidence: 0.99,
      providerUpdatedAt: "2026-09-11T01:00:00.000Z"
    });
    const requests = fetchMock.mock.calls.map(([input]) => decodeURIComponent(String(input))).join(" ");
    expect(requests).not.toContain("123.456");
    expect(requests).not.toContain("AccessKey");
    expect(requests).not.toContain(`0x${"f".repeat(40)}`);
  });

  it("honors a retryable 429 and succeeds without duplicating a batch result", async () => {
    const contract = `0x${"b".repeat(40)}`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ message: "slow down" }, 429, { "retry-after": "0" }))
      .mockResolvedValueOnce(response({
        coins: {
          [`ethereum:${contract}`]: {
            price: 3,
            confidence: 0.99,
            timestamp: Date.parse("2026-09-11T01:00:00.000Z") / 1_000
          }
        }
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchDefiLlamaPrices([
      token({ contractAddress: contract, valueUsd: 10 })
    ], "2026-09-11T01:00:00.000Z");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.requestCount).toBe(1);
    expect(result.failedBatchCount).toBe(0);
    expect(result.quotes.get(`ethereum:${contract}`)?.priceUsd).toBe(3);
  });
});

function token(overrides: Partial<LiveWalletToken> = {}): LiveWalletToken {
  const contractAddress = overrides.contractAddress === undefined
    ? `0x${"a".repeat(40)}`
    : overrides.contractAddress;
  return {
    id: `debank:eth:wallet:balance:${contractAddress ?? "eth"}:liquid:0`,
    source: "debank",
    symbol: "TOKEN",
    name: "Token",
    chainId: "eth",
    chainName: "Ethereum",
    protocolId: null,
    protocolName: null,
    iconUrl: null,
    contractAddress,
    verificationState: "verified",
    valuationState: "fallback",
    amount: 5,
    priceUsd: 2,
    snapshotPriceUsd: 2,
    snapshotValueUsd: 10,
    valueUsd: 10,
    state: "liquid",
    ...overrides
  };
}

function response(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}
