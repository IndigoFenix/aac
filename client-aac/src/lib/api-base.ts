// Resolves which AAC backend this client talks to.
//
//   - packaged app (Electron   -> the backend named by the LAST-KNOWN-GOOD
//     desktop or Capacitor        runtime manifest, else the one baked in at
//     iPad)                       build time (VITE_API_URL), else the demo one
//   - local dev / custom builds -> VITE_API_URL (e.g. http://localhost:5000)
//   - everything else (web)    -> same origin
//
// The web clients (aivota-staging, aivota-demo, and production aivota.ai) are
// each served from the same host as their backend, so same-origin already
// routes each one to the correct backend — no per-host logic needed. The
// packaged desktop app is served from the app://aac origin (see
// electron/main.ts) and has nothing to be "same origin" with, so its backend is
// chosen at BUILD time: the release pipeline injects VITE_API_URL per
// environment (dev → localhost, staging → the staging server, prod →
// api.aivota.ai) — see scripts/aac-release-config.mjs. A build with no
// VITE_API_URL (or a bare `npm run electron:build`, which loads
// client-aac/.env.electron = demo) falls back to the demo backend. Dev-electron
// loads http://localhost:5174, which deliberately falls through to the
// VITE_API_URL dev flow below.
//
// RUNTIME MANIFEST (packaged apps only). A baked URL can only be changed by
// shipping a new build — which on the iPad means an App Store release. So each
// release also bakes VITE_BACKEND_MANIFEST_URL, a tiny JSON document on the
// (public, no-cache) update CDN naming the CURRENT backend:
//   https://updates.aivota.ai/aac/latest-backend.json  → { "backendUrl": "https://api.aivota.ai" }
// On every launch `syncBackendManifest()` fetches it. A changed backend is
// stored as the last-known-good override and takes effect on the next launch
// — or immediately (reload) if the backend we are currently using is already
// unreachable. Moving the fleet to a new host is therefore a one-file publish
// (`npm run publish:aac:backend prod`), not a forced-update campaign. If the
// manifest is unreachable AND the stored override is dead, the override is
// dropped so the app falls back to the baked backend rather than bricking.

const DEMO_BACKEND = "https://aivota-demo-us.onrender.com";

/** localStorage key holding the last-known-good backend from the manifest. */
export const BACKEND_OVERRIDE_KEY = "aac.backendUrl";

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Protocols served by a PACKAGED client rather than a web server:
 *   app:        Electron, origin app://aac (electron/main.ts)
 *   capacitor:  Capacitor/iPad, origin capacitor://localhost (capacitor.config.ts)
 *
 * These are matched on PROTOCOL, not via lib/platform's host detection,
 * because the question here is specifically "is there a same-origin backend to
 * fall through to?" — and for both of these the answer is no, whatever bridge
 * happens to be present on `window`.
 */
const PACKAGED_APP_PROTOCOLS = ["app:", "capacitor:"];

/**
 * The resolution itself, as a pure function of its inputs.
 *
 * Kept separate from `getApiBaseUrl()` so it can be tested directly: the real
 * inputs are `window.location.protocol`, Vite's build-time `import.meta.env`
 * and localStorage, and `import.meta` is per-module — a test cannot reach
 * into this module's copy to stub it. See api-base.test.ts.
 *
 * @param protocol    `window.location.protocol`, e.g. "https:" / "capacitor:"
 * @param bakedApiUrl `VITE_API_URL` as baked at build time, if any
 * @param overrideUrl last-known-good backend from the runtime manifest, if any.
 *                    Honoured ONLY for packaged apps — a web page always stays
 *                    same-origin and dev builds always follow VITE_API_URL.
 */
export function resolveApiBaseUrl(
  protocol: string | undefined,
  bakedApiUrl: string | undefined,
  overrideUrl?: string | null,
): string {
  const explicit = (bakedApiUrl ?? "").trim();
  const override = (overrideUrl ?? "").trim();

  // 1. A packaged app (desktop or iPad) talks to the backend the runtime
  //    manifest last named, else the one baked in at build time (VITE_API_URL,
  //    injected per environment by the release pipeline), falling back to the
  //    demo backend when none was baked. It has no same-origin server, so
  //    falling through to (3) would be fatal.
  if (protocol !== undefined && PACKAGED_APP_PROTOCOLS.includes(protocol)) {
    if (override) return stripTrailingSlashes(override);
    return explicit ? stripTrailingSlashes(explicit) : DEMO_BACKEND;
  }

  // 2. Local dev / custom builds: honour an explicit VITE_API_URL.
  if (explicit) return stripTrailingSlashes(explicit);

  // 3. Web (staging / demo / production): same origin as the page.
  return "";
}

function viteEnv(): Record<string, string | undefined> | undefined {
  // `import.meta.env` is substituted by Vite at build time; guard it so this
  // module is also importable outside a Vite build (tests, SSR, tooling).
  return (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
}

function readStoredOverride(): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(BACKEND_OVERRIDE_KEY) : null;
  } catch {
    return null;
  }
}

/**
 * Base URL for the AAC backend, without a trailing slash.
 * An empty string means "same origin as the page".
 */
export function getApiBaseUrl(): string {
  return resolveApiBaseUrl(
    typeof window !== "undefined" ? window.location.protocol : undefined,
    viteEnv()?.VITE_API_URL,
    readStoredOverride(),
  );
}

/**
 * Resolved once at module load — the host/protocol can't change within a
 * session, so callers can import this directly instead of re-resolving. A
 * manifest change is applied by reloading (see syncBackendManifest), never by
 * mutating this value under live callers.
 */
export const API_BASE_URL = getApiBaseUrl();

/**
 * True when running inside a packaged shell (Electron `app://`, Capacitor
 * iPad `capacitor://`) rather than a web page. These origins are not http(s),
 * which matters for anything that must present a real https origin/referrer to
 * a third party — e.g. the YouTube IFrame player, which rejects the app://
 * origin (error 152/153) and must be framed via the https backend relay
 * instead. See client-aac/src/components/YouTubePlayer.tsx.
 */
export const IS_PACKAGED_APP =
  typeof window !== "undefined" &&
  PACKAGED_APP_PROTOCOLS.includes(window.location.protocol);

// ---------------------------------------------------------------------------
// Runtime backend manifest
// ---------------------------------------------------------------------------

/** Shape of latest-backend.json (written by scripts/publish-aac-backend.mjs). */
export interface BackendManifest {
  backendUrl: string;
  /** Informational — which release env published it and when. */
  env?: string;
  publishedAt?: string;
}

/**
 * Accept only an absolute http(s) URL with no query/hash; http is allowed
 * solely for localhost so a dev manifest can point at a local server. Returns
 * the normalised origin+path without a trailing slash, or null if rejected.
 */
export function normalizeBackendUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal)) return null;
  if (u.search || u.hash || u.username || u.password) return null;
  return stripTrailingSlashes(u.origin + (u.pathname === "/" ? "" : u.pathname));
}

export type BackendSyncOutcome =
  | "skipped"     // not a packaged app, or no manifest URL baked
  | "unchanged"   // manifest names the backend we are already using
  | "deferred"    // new backend stored; current one still works → applies next launch
  | "reloading"   // new backend stored and current one is dead → reloading now
  | "reverted"    // manifest unreachable AND stored override dead → override dropped, reloading
  | "error";      // manifest unreachable/invalid; nothing changed

export interface BackendSyncDeps {
  fetch: (url: string, init?: { signal?: AbortSignal; cache?: RequestCache }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  storage: {
    get(key: string): string | null;
    set(key: string, value: string): void;
    remove(key: string): void;
  };
  reload: () => void;
  log: (message: string) => void;
  /** Per-request timeout in ms (manifest fetch and health probe). */
  timeoutMs?: number;
}

export interface BackendSyncInput {
  /** Baked VITE_BACKEND_MANIFEST_URL, if any. */
  manifestUrl: string | undefined;
  /** The backend this process is using (API_BASE_URL). */
  current: string;
  /** Whether this is a packaged app (IS_PACKAGED_APP). */
  packaged: boolean;
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await run(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function isHealthy(base: string, deps: BackendSyncDeps, timeoutMs: number): Promise<boolean> {
  try {
    const res = await withTimeout(timeoutMs, (signal) =>
      deps.fetch(`${base}/health`, { signal, cache: "no-store" }),
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Reconcile the stored backend override with the published manifest. Pure in
 * its dependencies so the decision table is unit-testable; the app calls
 * `startBackendManifestSync()` which wires the real fetch/localStorage/reload.
 */
export async function syncBackendManifest(
  input: BackendSyncInput,
  deps: BackendSyncDeps,
): Promise<BackendSyncOutcome> {
  const timeoutMs = deps.timeoutMs ?? 8000;
  const manifestUrl = (input.manifestUrl ?? "").trim();
  if (!input.packaged || !manifestUrl) return "skipped";

  const stored = normalizeBackendUrl(deps.storage.get(BACKEND_OVERRIDE_KEY));

  let published: string | null = null;
  try {
    const res = await withTimeout(timeoutMs, (signal) =>
      deps.fetch(manifestUrl, { signal, cache: "no-store" }),
    );
    if (!res.ok) throw new Error(`HTTP ${String((res as { status?: number }).status ?? "error")}`);
    const body = (await res.json()) as Partial<BackendManifest> | null;
    published = normalizeBackendUrl(body?.backendUrl);
    if (!published) throw new Error("manifest has no valid backendUrl");
  } catch (err) {
    deps.log(`[backend] manifest unavailable (${(err as Error).message}); keeping ${input.current}`);
    // Self-heal: an override that no longer answers, with no manifest to
    // correct it, would strand the app. Fall back to the baked backend.
    if (stored && stored === input.current && !(await isHealthy(input.current, deps, timeoutMs))) {
      deps.log(`[backend] stored override ${stored} is unreachable — reverting to the baked backend`);
      deps.storage.remove(BACKEND_OVERRIDE_KEY);
      deps.reload();
      return "reverted";
    }
    return "error";
  }

  if (published === input.current) {
    // Keep the override in step even when it equals the baked value, so a
    // later manifest rollback to the baked URL is still recorded.
    if (stored !== published) deps.storage.set(BACKEND_OVERRIDE_KEY, published);
    return "unchanged";
  }

  deps.storage.set(BACKEND_OVERRIDE_KEY, published);
  if (await isHealthy(input.current, deps, timeoutMs)) {
    deps.log(`[backend] manifest now names ${published}; current ${input.current} still healthy — switching on next launch`);
    return "deferred";
  }
  deps.log(`[backend] manifest names ${published} and current ${input.current} is unreachable — switching now`);
  deps.reload();
  return "reloading";
}

/**
 * Fire-and-forget: call once at app start. Never throws, never blocks render.
 */
export function startBackendManifestSync(): void {
  if (typeof window === "undefined") return;
  const deps: BackendSyncDeps = {
    fetch: (url, init) => fetch(url, { ...init, credentials: "omit" }),
    storage: {
      get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
      set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* quota / private mode */ } },
      remove: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
    },
    reload: () => window.location.reload(),
    log: (m) => console.info(m),
  };
  void syncBackendManifest(
    {
      manifestUrl: viteEnv()?.VITE_BACKEND_MANIFEST_URL,
      current: API_BASE_URL,
      packaged: IS_PACKAGED_APP,
    },
    deps,
  ).catch((err) => console.warn("[backend] manifest sync failed", err));
}
