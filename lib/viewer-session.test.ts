import { describe, expect, it } from "vitest";

import {
  authenticateViewerPassword,
  createViewerSessionToken,
  readViewerConfiguration,
  verifyViewerSessionToken,
  ViewerConfigurationError
} from "./viewer-session";

const environment = {
  PORTFOLIO_VIEWER_PASSWORD: "viewer-password-2026",
  PORTFOLIO_ACCESS_PASSWORD: "admin-password-2026",
  PORTFOLIO_VIEWER_SESSION_SECRET: "session-secret-with-at-least-thirty-two-characters"
};

describe("viewer session authentication", () => {
  it("distinguishes viewer and administrator passwords", async () => {
    await expect(authenticateViewerPassword(environment.PORTFOLIO_VIEWER_PASSWORD, environment)).resolves.toBe("viewer");
    await expect(authenticateViewerPassword(environment.PORTFOLIO_ACCESS_PASSWORD, environment)).resolves.toBe("admin");
    await expect(authenticateViewerPassword("not-the-password", environment)).resolves.toBeNull();
  });

  it("rejects invalid password input", async () => {
    await expect(authenticateViewerPassword(null, environment)).resolves.toBeNull();
    await expect(authenticateViewerPassword("", environment)).resolves.toBeNull();
    await expect(authenticateViewerPassword("x".repeat(513), environment)).resolves.toBeNull();
  });

  it("fails closed when required secrets are absent or too short", () => {
    expect(() => readViewerConfiguration({})).toThrow(ViewerConfigurationError);
    expect(() => readViewerConfiguration({
      ...environment,
      PORTFOLIO_VIEWER_SESSION_SECRET: "too-short"
    })).toThrow(ViewerConfigurationError);
  });

  it.each([
    {
      name: "viewer and administrator passwords",
      conflicting: {
        ...environment,
        PORTFOLIO_ACCESS_PASSWORD: environment.PORTFOLIO_VIEWER_PASSWORD
      }
    },
    {
      name: "session secret and viewer password",
      conflicting: {
        PORTFOLIO_VIEWER_PASSWORD: "shared-viewer-secret-with-thirty-two-characters",
        PORTFOLIO_ACCESS_PASSWORD: environment.PORTFOLIO_ACCESS_PASSWORD,
        PORTFOLIO_VIEWER_SESSION_SECRET: "shared-viewer-secret-with-thirty-two-characters"
      }
    },
    {
      name: "session secret and administrator password",
      conflicting: {
        PORTFOLIO_VIEWER_PASSWORD: environment.PORTFOLIO_VIEWER_PASSWORD,
        PORTFOLIO_ACCESS_PASSWORD: "shared-admin-secret-with-thirty-two-characters",
        PORTFOLIO_VIEWER_SESSION_SECRET: "shared-admin-secret-with-thirty-two-characters"
      }
    }
  ])("rejects matching $name", ({ conflicting }) => {
    expect(() => readViewerConfiguration(conflicting)).toThrow("Viewer access secrets must be independent");
  });

  it("signs and verifies viewer and administrator sessions with separate lifetimes", async () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const viewer = await createViewerSessionToken("viewer", environment, now);
    const admin = await createViewerSessionToken("admin", environment, now);

    await expect(verifyViewerSessionToken(viewer.token, environment, now)).resolves.toEqual({
      role: "viewer",
      expiresAt: "2026-10-10T12:00:00.000Z"
    });
    await expect(verifyViewerSessionToken(admin.token, environment, now)).resolves.toEqual({
      role: "admin",
      expiresAt: "2026-10-04T00:00:00.000Z"
    });
    expect(viewer.maxAge).toBe(7 * 24 * 60 * 60);
    expect(admin.maxAge).toBe(12 * 60 * 60);
  });

  it("rejects a token after its signed content is tampered with", async () => {
    const { token } = await createViewerSessionToken("viewer", environment);
    const [header, payload, signature] = token.split(".");
    const tamperedPayload = payload.endsWith("a")
      ? `${payload.slice(0, -1)}b`
      : `${payload.slice(0, -1)}a`;

    await expect(
      verifyViewerSessionToken(`${header}.${tamperedPayload}.${signature}`, environment)
    ).resolves.toBeNull();
  });

  it("invalidates existing tokens when any session secret changes", async () => {
    const { token } = await createViewerSessionToken("viewer", environment);

    await expect(verifyViewerSessionToken(token, {
      ...environment,
      PORTFOLIO_VIEWER_SESSION_SECRET: "rotated-session-secret-with-thirty-two-characters"
    })).resolves.toBeNull();
  });
});
