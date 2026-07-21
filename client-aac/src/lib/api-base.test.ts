// client-aac/src/lib/api-base.test.ts
//
// Backend resolution is a silent-failure surface: if a packaged client falls
// through to "same origin", every API call goes to app://aac or
// capacitor://localhost — where nothing is listening — and the app looks like
// a network outage rather than a misconfiguration. These tests pin the branch
// taken for each host.
//
// Tests target `resolveApiBaseUrl`, the pure form, because the real inputs
// (`window.location.protocol` and Vite's per-module `import.meta.env`) cannot
// be stubbed from outside the module.

import { resolveApiBaseUrl } from "./api-base";

const DEMO_BACKEND = "https://aivota-demo-us.onrender.com";
const PACKAGED_PROTOCOLS = ["app:", "capacitor:"];

describe("resolveApiBaseUrl", () => {
  it("uses the baked backend for the Electron app (app://)", () => {
    expect(resolveApiBaseUrl("app:", "https://staging.example.com")).toBe(
      "https://staging.example.com",
    );
  });

  it("uses the baked backend for the iPad app (capacitor://)", () => {
    // The regression this guards: capacitor:// used to fall through to
    // "same origin", pointing every request at capacitor://localhost.
    expect(resolveApiBaseUrl("capacitor:", "https://staging.example.com")).toBe(
      "https://staging.example.com",
    );
  });

  it("falls back to the demo backend when a packaged app baked no URL", () => {
    for (const protocol of PACKAGED_PROTOCOLS) {
      expect(resolveApiBaseUrl(protocol, undefined)).toBe(DEMO_BACKEND);
    }
  });

  it("never returns same-origin for a packaged app", () => {
    // Same-origin ("") is unreachable from a packaged client on either host,
    // whether the baked value is missing, empty, or whitespace.
    for (const protocol of PACKAGED_PROTOCOLS) {
      for (const baked of [undefined, "", "   "]) {
        expect(resolveApiBaseUrl(protocol, baked)).not.toBe("");
      }
    }
  });

  it("uses same origin for the web build", () => {
    expect(resolveApiBaseUrl("https:", undefined)).toBe("");
  });

  it("honours an explicit VITE_API_URL in local dev over same-origin", () => {
    expect(resolveApiBaseUrl("http:", "http://localhost:5000")).toBe("http://localhost:5000");
  });

  it("treats dev-Electron (http://localhost:5174) as a dev build, not a packaged one", () => {
    // Electron in dev loads the Vite server over http, so it must follow the
    // VITE_API_URL dev flow rather than the baked-backend branch.
    expect(resolveApiBaseUrl("http:", "http://localhost:5000")).toBe("http://localhost:5000");
    expect(resolveApiBaseUrl("http:", undefined)).toBe("");
  });

  it("strips trailing slashes so callers can concatenate paths", () => {
    expect(resolveApiBaseUrl("capacitor:", "https://staging.example.com///")).toBe(
      "https://staging.example.com",
    );
  });

  it("falls back to same origin when there is no window (SSR / prerender)", () => {
    expect(resolveApiBaseUrl(undefined, undefined)).toBe("");
  });
});
