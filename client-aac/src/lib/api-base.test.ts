// client-aac/src/lib/api-base.test.ts
//
// Backend resolution is a silent-failure surface: if a packaged client falls
// through to "same origin", every API call goes to app://aac or
// capacitor://localhost — where nothing is listening — and the app looks like
// a network outage rather than a misconfiguration. These tests pin the branch
// taken for each host, and the decision table of the runtime-manifest sync
// that can move an installed fleet to a new backend without a new build.
//
// Tests target `resolveApiBaseUrl` / `syncBackendManifest`, the pure forms,
// because the real inputs (`window.location.protocol`, Vite's per-module
// `import.meta.env`, localStorage) cannot be stubbed from outside the module.

import {
  resolveApiBaseUrl,
  normalizeBackendUrl,
  syncBackendManifest,
  BACKEND_OVERRIDE_KEY,
  type BackendSyncDeps,
} from "./api-base";

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

  it("prefers the stored manifest override over the baked URL for packaged apps", () => {
    for (const protocol of PACKAGED_PROTOCOLS) {
      expect(
        resolveApiBaseUrl(protocol, "https://aivota-demo-us.onrender.com", "https://api.aivota.ai/"),
      ).toBe("https://api.aivota.ai");
    }
  });

  it("ignores a blank override", () => {
    expect(resolveApiBaseUrl("app:", "https://baked.example.com", "   ")).toBe(
      "https://baked.example.com",
    );
  });

  it("never lets the override touch web or dev builds", () => {
    expect(resolveApiBaseUrl("https:", undefined, "https://api.aivota.ai")).toBe("");
    expect(resolveApiBaseUrl("http:", "http://localhost:5000", "https://api.aivota.ai")).toBe(
      "http://localhost:5000",
    );
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

describe("normalizeBackendUrl", () => {
  it("accepts https origins and strips trailing slashes", () => {
    expect(normalizeBackendUrl("https://api.aivota.ai/")).toBe("https://api.aivota.ai");
    expect(normalizeBackendUrl(" https://api.aivota.ai/v2/ ")).toBe("https://api.aivota.ai/v2");
  });

  it("allows plain http only for localhost", () => {
    expect(normalizeBackendUrl("http://localhost:5000")).toBe("http://localhost:5000");
    expect(normalizeBackendUrl("http://api.aivota.ai")).toBeNull();
  });

  it("rejects garbage, credentials, query strings and non-strings", () => {
    expect(normalizeBackendUrl("not a url")).toBeNull();
    expect(normalizeBackendUrl("https://u:p@api.aivota.ai")).toBeNull();
    expect(normalizeBackendUrl("https://api.aivota.ai/?x=1")).toBeNull();
    expect(normalizeBackendUrl(42)).toBeNull();
    expect(normalizeBackendUrl(undefined)).toBeNull();
  });
});

describe("syncBackendManifest", () => {
  const MANIFEST = "https://updates.aivota.ai/aac/latest-backend.json";
  const BAKED = "https://aivota-demo-us.onrender.com";
  const NEW = "https://api.aivota.ai";

  type Responses = Record<string, { ok: boolean; status?: number; body?: unknown } | "throw">;

  function makeDeps(responses: Responses, stored: Record<string, string> = {}) {
    const store = { ...stored };
    const calls: string[] = [];
    const logs: string[] = [];
    let reloaded = 0;
    const deps: BackendSyncDeps = {
      fetch: async (url) => {
        calls.push(url);
        const r = responses[url];
        if (!r) throw new Error(`unexpected fetch ${url}`);
        if (r === "throw") throw new Error("network down");
        return { ok: r.ok, status: r.status, json: async () => r.body } as never;
      },
      storage: {
        get: (k) => store[k] ?? null,
        set: (k, v) => { store[k] = v; },
        remove: (k) => { delete store[k]; },
      },
      reload: () => { reloaded++; },
      log: (m) => logs.push(m),
      timeoutMs: 1000,
    };
    return { deps, store, calls, logs, reloads: () => reloaded };
  }

  it("does nothing for web builds or when no manifest URL was baked", async () => {
    const t = makeDeps({});
    expect(await syncBackendManifest({ manifestUrl: MANIFEST, current: "", packaged: false }, t.deps)).toBe("skipped");
    expect(await syncBackendManifest({ manifestUrl: undefined, current: BAKED, packaged: true }, t.deps)).toBe("skipped");
    expect(t.calls).toEqual([]);
  });

  it("records the override but defers the switch while the current backend is healthy", async () => {
    const t = makeDeps({
      [MANIFEST]: { ok: true, body: { backendUrl: `${NEW}/` } },
      [`${BAKED}/health`]: { ok: true },
    });
    expect(await syncBackendManifest({ manifestUrl: MANIFEST, current: BAKED, packaged: true }, t.deps)).toBe("deferred");
    expect(t.store[BACKEND_OVERRIDE_KEY]).toBe(NEW);
    expect(t.reloads()).toBe(0);
  });

  it("switches immediately when the current backend is already dead", async () => {
    const t = makeDeps({
      [MANIFEST]: { ok: true, body: { backendUrl: NEW } },
      [`${BAKED}/health`]: "throw",
    });
    expect(await syncBackendManifest({ manifestUrl: MANIFEST, current: BAKED, packaged: true }, t.deps)).toBe("reloading");
    expect(t.store[BACKEND_OVERRIDE_KEY]).toBe(NEW);
    expect(t.reloads()).toBe(1);
  });

  it("is a no-op when the manifest names the backend already in use", async () => {
    const t = makeDeps({ [MANIFEST]: { ok: true, body: { backendUrl: NEW } } }, { [BACKEND_OVERRIDE_KEY]: NEW });
    expect(await syncBackendManifest({ manifestUrl: MANIFEST, current: NEW, packaged: true }, t.deps)).toBe("unchanged");
    expect(t.calls).toEqual([MANIFEST]); // no health probe needed
    expect(t.reloads()).toBe(0);
  });

  it("keeps everything as-is when the manifest is unreachable and the backend works", async () => {
    const t = makeDeps({ [MANIFEST]: "throw", [`${NEW}/health`]: { ok: true } }, { [BACKEND_OVERRIDE_KEY]: NEW });
    expect(await syncBackendManifest({ manifestUrl: MANIFEST, current: NEW, packaged: true }, t.deps)).toBe("error");
    expect(t.store[BACKEND_OVERRIDE_KEY]).toBe(NEW);
    expect(t.reloads()).toBe(0);
  });

  it("drops a dead override when the manifest can't correct it (falls back to the baked backend)", async () => {
    const t = makeDeps({ [MANIFEST]: { ok: false, status: 503 }, [`${NEW}/health`]: "throw" }, { [BACKEND_OVERRIDE_KEY]: NEW });
    expect(await syncBackendManifest({ manifestUrl: MANIFEST, current: NEW, packaged: true }, t.deps)).toBe("reverted");
    expect(t.store[BACKEND_OVERRIDE_KEY]).toBeUndefined();
    expect(t.reloads()).toBe(1);
  });

  it("never reverts when no override is in play — a dead baked backend is not ours to fix", async () => {
    const t = makeDeps({ [MANIFEST]: "throw" });
    expect(await syncBackendManifest({ manifestUrl: MANIFEST, current: BAKED, packaged: true }, t.deps)).toBe("error");
    expect(t.calls).toEqual([MANIFEST]);
    expect(t.reloads()).toBe(0);
  });

  it("treats an invalid manifest payload as unavailable", async () => {
    const t = makeDeps({
      [MANIFEST]: { ok: true, body: { backendUrl: "http://evil.example.com" } },
    });
    expect(await syncBackendManifest({ manifestUrl: MANIFEST, current: BAKED, packaged: true }, t.deps)).toBe("error");
    expect(t.store[BACKEND_OVERRIDE_KEY]).toBeUndefined();
  });
});
