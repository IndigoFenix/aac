// Resolves which AAC backend this client talks to.
//
//   - packaged Electron app    -> the backend baked in at build time
//                                 (VITE_API_URL), falling back to the demo one
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

/** True when running inside the packaged Electron app (origin app://aac). */
function isPackagedDesktopApp(): boolean {
  return typeof window !== "undefined" && window.location.protocol === "app:";
}

/**
 * Base URL for the AAC backend, without a trailing slash.
 * An empty string means "same origin as the page".
 */
export function getApiBaseUrl(): string {
  // 1. The packaged desktop app talks to the backend baked in at build time
  //    (VITE_API_URL, injected per environment by the release pipeline),
  //    falling back to the demo backend when none was baked.
  if (isPackagedDesktopApp()) {
    const baked = ((import.meta.env.VITE_API_URL as string | undefined) ?? "").trim();
    return baked ? stripTrailingSlashes(baked) : DEMO_BACKEND;
  }

  // 2. Local dev / custom builds: honour an explicit VITE_API_URL.
  const explicit = (import.meta.env.VITE_API_URL as string | undefined) ?? "";
  if (explicit) return stripTrailingSlashes(explicit);

  // 3. Web (staging / demo / production): same origin as the page.
  return "";
}

/**
 * Resolved once at module load — the host/protocol can't change within a
 * session, so callers can import this directly instead of re-resolving.
 */
export const API_BASE_URL = getApiBaseUrl();
