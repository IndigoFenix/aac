// Resolves which AAC backend this client talks to.
//
//   - packaged app (Electron   -> the backend baked in at build time
//     desktop or Capacitor        (VITE_API_URL), falling back to the demo one
//     iPad)
//   - local dev / custom builds -> VITE_API_URL (e.g. http://localhost:5000)
//   - everything else (web)    -> same origin
//
// The web clients (aivota-staging, aivota-demo, and production aivota.ai) are
// each served from the same host as their backend, so same-origin already
// routes each one to the correct backend — no per-host logic needed. The
// packaged desktop app is served from the app://aac origin (see
// electron/main.ts) and has nothing to be "same origin" with, so its backend is
// chosen at BUILD time: the release pipeline injects VITE_API_URL per
// environment (dev → localhost, staging → the staging server, prod → demo) —
// see scripts/aac-release-config.mjs. A build with no VITE_API_URL (or a bare
// `npm run electron:build`, which loads client-aac/.env.electron = demo) falls
// back to the demo backend. Dev-electron loads http://localhost:5174, which
// deliberately falls through to the VITE_API_URL dev flow below.

const DEMO_BACKEND = "https://aivota-demo-us.onrender.com";

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
 * The resolution itself, as a pure function of its two inputs.
 *
 * Kept separate from `getApiBaseUrl()` so it can be tested directly: the real
 * inputs are `window.location.protocol` and Vite's build-time
 * `import.meta.env`, and `import.meta` is per-module — a test cannot reach
 * into this module's copy to stub it. See api-base.test.ts.
 *
 * @param protocol   `window.location.protocol`, e.g. "https:" / "capacitor:"
 * @param bakedApiUrl `VITE_API_URL` as baked at build time, if any
 */
export function resolveApiBaseUrl(
  protocol: string | undefined,
  bakedApiUrl: string | undefined,
): string {
  const explicit = (bakedApiUrl ?? "").trim();

  // 1. A packaged app (desktop or iPad) talks to the backend baked in at build
  //    time (VITE_API_URL, injected per environment by the release pipeline),
  //    falling back to the demo backend when none was baked. It has no
  //    same-origin server, so falling through to (3) would be fatal.
  if (protocol !== undefined && PACKAGED_APP_PROTOCOLS.includes(protocol)) {
    return explicit ? stripTrailingSlashes(explicit) : DEMO_BACKEND;
  }

  // 2. Local dev / custom builds: honour an explicit VITE_API_URL.
  if (explicit) return stripTrailingSlashes(explicit);

  // 3. Web (staging / demo / production): same origin as the page.
  return "";
}

/**
 * Base URL for the AAC backend, without a trailing slash.
 * An empty string means "same origin as the page".
 */
export function getApiBaseUrl(): string {
  // `import.meta.env` is substituted by Vite at build time; guard it so this
  // module is also importable outside a Vite build (tests, SSR, tooling).
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return resolveApiBaseUrl(
    typeof window !== "undefined" ? window.location.protocol : undefined,
    env?.VITE_API_URL,
  );
}

/**
 * Resolved once at module load — the host/protocol can't change within a
 * session, so callers can import this directly instead of re-resolving.
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
