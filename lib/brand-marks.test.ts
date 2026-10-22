import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalAssetSymbol,
  markInitials,
  resolveAssetMark,
  resolveLogoMark,
  resolveSourceMark
} from "./brand-marks";
import catalog from "./icon-catalog.json";
import sources from "./icon-sources.json";

describe("brand mark resolvers", () => {
  it("rejects unsafe logo URLs and never resolves object prototype properties", () => {
    for (const url of ["javascript:alert(1)", "https://untrusted.example/a.png", "//evil.test/a.png", "/brand/../secret", "https://static.debank.com@evil.test/a.png", "https://static.debank.com:444/a.png", "toString"]) {
      expect(resolveLogoMark(url)).toBeNull();
    }
    expect(resolveSourceMark("__proto__")).toBeNull();
  });

  it("allows new provider logos immediately and shares canonical marks across pages", () => {
    const url = "https://static.debank.com/image/new-token.png";
    expect(resolveAssetMark("NEW", url)).toBe(url);
    expect(resolveAssetMark("ETH", url)).toBe(resolveAssetMark("ETH"));
    expect(resolveAssetMark("UNI")).toContain("/brand/cache/");
    expect(resolveAssetMark("UNI")).toContain("/brand/cache/");
  });

  it("bundles every catalog entry as a valid content addressed PNG", () => {
    for (const [url, local] of Object.entries(catalog)) {
      expect(resolveLogoMark(url)).toBe(local);
      expect(local).toMatch(/^\/brand\/cache\/[a-f0-9]{24}\.png$/);
      const image = readFileSync(join(process.cwd(), "public", local));
      expect(image.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(local).toContain(createHash("sha256").update(image).digest("hex").slice(0, 24));
    }
    for (const symbol of Object.keys(sources.assets)) expect(resolveAssetMark(symbol)).toMatch(/^\/brand\//);
    for (const source of Object.keys(sources.sources)) expect(resolveSourceMark(source)).toMatch(/^\/brand\//);
  });
  it("resolves supported assets and their canonical aliases", () => {
    for (const symbol of ["USDT", "USDC", "BTC", "ETH", "BNB", "HYPE"]) {
      expect(resolveAssetMark(symbol), symbol).not.toBeNull();
    }
    expect(canonicalAssetSymbol("weth")).toBe("ETH");
    expect(resolveAssetMark("WETH")).toBe(resolveAssetMark("ETH"));
    expect(resolveAssetMark("wBTC")).toBe(resolveAssetMark("BTC"));
    expect(resolveAssetMark("USDC.E")).toBe(resolveAssetMark("USDC"));
  });

  it("resolves only whitelisted source brands", () => {
    expect(resolveSourceMark("Binance")).toContain("/sources/binance.svg");
    expect(resolveSourceMark("OKX")).toContain("/sources/okx.svg");
    expect(resolveSourceMark("Bitget")).toContain("/sources/bitget.svg");
    expect(resolveSourceMark("Hyperliquid")).toContain("hyper-evm.svg");
    expect(resolveSourceMark("HTX")).toContain("/brand/cache/");
    expect(resolveSourceMark("DeBank")).toContain("/brand/cache/");
    expect(resolveSourceMark("Gate")).toContain("/brand/cache/");
  });

  it("provides a stable fallback for unknown marks", () => {
    for (const symbol of ["UNKNOWN", "TWD", "DEFI", "OTHER"]) {
      expect(resolveAssetMark(symbol), symbol).toBeNull();
    }
    expect(resolveSourceMark("Bank CSV")).toBeNull();
    expect(markInitials("USDC.E")).toBe("US");
    expect(markInitials("---")).toBe("?");
  });

  it("points every supported mark to a bundled public asset", () => {
    const marks = [
      ...["USDT", "USDC", "BTC", "ETH", "BNB", "HYPE"].map(symbol => resolveAssetMark(symbol)),
      ...["Binance", "OKX", "Bitget", "Hyperliquid"].map(resolveSourceMark)
    ];

    for (const mark of marks) {
      expect(mark).not.toBeNull();
      expect(existsSync(join(process.cwd(), "public", mark!))).toBe(true);
    }
  });
});
