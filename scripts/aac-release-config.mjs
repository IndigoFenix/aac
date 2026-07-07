// scripts/aac-release-config.mjs
//
// Single source of truth for the AAC desktop app's release ENVIRONMENTS. Each
// environment produces the SAME app, differing only in:
//   - backendUrl  : which server the packaged app talks to (baked as
//                   VITE_API_URL — see client-aac/src/lib/api-base.ts)
//   - app identity: appId + productName, so dev/staging/prod install
//                   SIDE-BY-SIDE with isolated settings/login (Electron keys
//                   userData off the product name) and separate installers
//   - update feed : each build auto-updates only from its own channel
//                   (publish.url) and publishes to its own S3 prefix
//
// prod mirrors electron-builder.yml's defaults (isDefaultIdentity), so the
// orchestrator applies NO overrides for it and the yml stays authoritative.

export const AAC_ENVIRONMENTS = {
  dev: {
    // Talks to the developer's own local server. Only meaningful on that
    // machine, so a dev build is never published to a CDN. The "-dev" pkgName
    // suffix also disables auto-update (see electron/auto-update.ts) so a dev
    // build never polls a feed.
    backendUrl: "http://localhost:5000",
    appId: "com.aivota.aac.dev",
    productName: "Aivota AAC Dev",
    // Electron keys userData / logs / the updater-cache dir off the package
    // `name` (app.getName()), NOT productName — so each env needs a distinct
    // name to isolate its settings/login/update-cache from the others.
    pkgName: "aivota-aac-dev",
    updatePrefix: "aac-dev/win/",
    updateUrl: "https://updates.aivota.ai/aac-dev/win/",
    publishable: false,
    isDefaultIdentity: false,
  },
  staging: {
    // Staging server (Render). Same host pattern as demo, "staging" for "demo".
    backendUrl: "https://aivota-staging-us.onrender.com",
    appId: "com.aivota.aac.staging",
    productName: "Aivota AAC Staging",
    pkgName: "aivota-aac-staging",
    updatePrefix: "aac-staging/win/",
    updateUrl: "https://updates.aivota.ai/aac-staging/win/",
    publishable: true,
    isDefaultIdentity: false,
  },
  prod: {
    // Production feed. Backend is the demo server today (see api-base.ts).
    // Identity + update feed come from electron-builder.yml — do not override.
    // pkgName stays the default "aivota-aac" so existing prod installs keep
    // their userData (never migrate the production name).
    backendUrl: "https://aivota-demo-us.onrender.com",
    appId: "com.aivota.aac",
    productName: "Aivota AAC",
    pkgName: "aivota-aac",
    updatePrefix: "aac/win/",
    updateUrl: "https://updates.aivota.ai/aac/win/",
    publishable: true,
    isDefaultIdentity: true,
  },
};

/** Resolve an environment by name, or throw with the valid set. */
export function resolveAacEnv(name) {
  const key = String(name ?? "").trim().toLowerCase();
  const cfg = AAC_ENVIRONMENTS[key];
  if (!cfg) {
    throw new Error(
      `Unknown AAC release env "${name}". Valid: ${Object.keys(AAC_ENVIRONMENTS).join(", ")}`,
    );
  }
  return { name: key, ...cfg };
}
