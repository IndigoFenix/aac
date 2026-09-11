/**
 * WebSocket upgrade origin gate — same-site rule.
 *
 * Seen live on Render staging, 2026-09-11: `ALLOWED_ORIGINS` unset, `APP_URL`
 * not the serving host, and every socket handshake from the staging page
 * refused ("[ws-auth] upgrade refused: origin not allowed") while every HTTP
 * call from the same page passed `validateCSRF`. The HTTP check has always
 * accepted an Origin equal to the request's own Host; the socket gate did not.
 *
 * DB-free: the gate is a pure function of two headers and the environment.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { isAllowedUpgradeOrigin } from "../middleware/security.js";

const STAGING = "https://aivota-staging-us.onrender.com";
const STAGING_HOST = "aivota-staging-us.onrender.com";

describe("isAllowedUpgradeOrigin", () => {
  const saved = {
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    APP_URL: process.env.APP_URL,
    NODE_ENV: process.env.NODE_ENV,
  };

  beforeEach(() => {
    // The Render-staging shape: production mode, no allowlist, APP_URL is a
    // different site.
    delete process.env.ALLOWED_ORIGINS;
    process.env.APP_URL = "https://aivota.ai";
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("accepts a handshake from the request's own host even with no allowlist", () => {
    expect(isAllowedUpgradeOrigin(STAGING, STAGING_HOST)).toBe(true);
  });

  it("host comparison is case-insensitive and ignores the scheme", () => {
    expect(isAllowedUpgradeOrigin("https://Aivota-Staging-US.onrender.com", STAGING_HOST)).toBe(true);
    expect(isAllowedUpgradeOrigin("http://aivota-staging-us.onrender.com", STAGING_HOST)).toBe(true);
  });

  it("still refuses a foreign origin — the cross-site hijack the gate exists for", () => {
    expect(isAllowedUpgradeOrigin("https://evil.example", STAGING_HOST)).toBe(false);
    // A look-alike with the host as a prefix or suffix is not the host.
    expect(isAllowedUpgradeOrigin("https://aivota-staging-us.onrender.com.evil.example", STAGING_HOST)).toBe(false);
    expect(isAllowedUpgradeOrigin("https://evil-aivota-staging-us.onrender.com", STAGING_HOST)).toBe(false);
  });

  it("refuses a foreign origin when no Host header is available to compare against", () => {
    expect(isAllowedUpgradeOrigin("https://evil.example", undefined)).toBe(false);
    expect(isAllowedUpgradeOrigin(STAGING, undefined)).toBe(false);
  });

  it("keeps the allowlist path: APP_URL and ALLOWED_ORIGINS entries pass regardless of host", () => {
    expect(isAllowedUpgradeOrigin("https://aivota.ai", "somewhere.else")).toBe(true);
    process.env.ALLOWED_ORIGINS = "https://a.example, https://b.example";
    expect(isAllowedUpgradeOrigin("https://b.example", "somewhere.else")).toBe(true);
    expect(isAllowedUpgradeOrigin("https://c.example", "somewhere.else")).toBe(false);
  });

  it("an absent Origin (non-browser client) is still allowed through to the credential check", () => {
    expect(isAllowedUpgradeOrigin(undefined, STAGING_HOST)).toBe(true);
    expect(isAllowedUpgradeOrigin("", STAGING_HOST)).toBe(true);
  });

  it("a malformed Origin is refused rather than crashing the upgrade", () => {
    expect(isAllowedUpgradeOrigin("not a url", STAGING_HOST)).toBe(false);
  });
});
