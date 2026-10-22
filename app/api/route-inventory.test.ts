import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

type AccessClass = "public" | "public-read" | "admin" | "agent" | "cron";

const routeAccess = {
  "/api/agent/finance": "agent",
  "/api/agent/portfolio": "public",
  "/api/assets/history": "public-read",
  "/api/auth/viewer": "public",
  "/api/cex": "public-read",
  "/api/cex/history": "public-read",
  "/api/cron/cex": "cron",
  "/api/cron/portfolio": "cron",
  "/api/cron/portfolio-value": "cron",
  "/api/expenses": "admin",
  "/api/fx": "public-read",
  "/api/portfolio": "public-read",
  "/api/portfolio/assistant": "public-read",
  "/api/portfolio/health": "public-read",
  "/api/portfolio/history": "public-read",
  "/api/portfolio/sync": "admin",
  "/api/portfolio/wallet-refresh": "admin",
  "/api/trading": "public-read",
  "/api/wallets/history": "public-read"
} satisfies Record<string, AccessClass>;

const apiRoot = join(process.cwd(), "app", "api");

describe("API route access inventory", () => {
  it("requires every API route to have an explicit access classification", () => {
    expect(findRoutePaths(apiRoot)).toEqual(Object.keys(routeAccess).sort());
    expect(new Set(Object.values(routeAccess))).toEqual(
      new Set<AccessClass>(["public", "public-read", "admin", "agent", "cron"])
    );
  });

  it.each(Object.entries(routeAccess))("keeps %s in its declared %s access class", (route, access) => {
    const source = readFileSync(routeFile(route), "utf8");

    if (access === "public-read") expect(source).toMatch(/requireViewerJson\s*\(/);
    if (access === "admin") expect(source).toMatch(/authorizePortfolioAdmin\s*\(/);
    if (access === "agent") expect(source).toMatch(/authorizeAgentFinance\s*\(/);
    if (access === "cron") expect(source).toMatch(/isCronRequestAuthorized\s*\(/);
    if (access === "public") {
      expect(source).not.toMatch(/requireViewerJson\s*\(/);
      expect(source).not.toMatch(/authorizePortfolioAdmin\s*\(/);
      expect(source).not.toMatch(/authorizeAgentFinance\s*\(/);
      expect(source).not.toMatch(/isCronRequestAuthorized\s*\(/);
    }
  });
});

function findRoutePaths(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findRoutePaths(path);
    if (entry.name !== "route.ts") return [];
    const route = relative(apiRoot, path)
      .split(sep)
      .slice(0, -1)
      .join("/");
    return [`/api/${route}`];
  }).sort();
}

function routeFile(route: string) {
  return join(apiRoot, route.replace(/^\/api\//, ""), "route.ts");
}
