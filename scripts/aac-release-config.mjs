// scripts/aac-release-config.mjs
//
// Single source of truth for the AAC desktop app's release ENVIRONMENTS. Each
// environment produces the SAME app, differing only in:
//   - backendUrl  : which server the packaged app talks to (baked as
//                   VITE_API_URL — see client-aac/src/lib/api-base.ts)
//   - backendManifestUrl : the runtime manifest the packaged app polls on
//                   launch (baked as VITE_BACKEND_MANIFEST_URL). Publishing a
//                   new `backendUrl` there re-points EXISTING installs without
//                   a new build — see publish-aac-backend.mjs.
//   - app identity: appId + productName, so dev/staging/prod install
//                   SIDE-BY-SIDE with isolated settings/login (Electron keys
//                   userData off the product name) and separate installers
//   - update feed : each build auto-updates only from its own channel
//                   (publish.url) and publishes to its own S3 prefix
//
// prod mirrors electron-builder.yml's defaults (isDefaultIdentity), so the
// orchestrator applies NO overrides for it and the yml stays authoritative.

const UPDATES_HOST = "https://updates.aivota.ai";

export const AAC_ENVIRONMENTS = {
  dev: {
    // Talks to the developer's own local server. Only meaningful on that
    // machine, so a dev build is never published to a CDN. The "-dev" pkgName
    // suffix also disables auto-update (see electron/auto-update.ts) so a dev
    // build never polls a feed. No manifest either: a dev build must never be
    // re-pointed remotely.
    backendUrl: "http://localhost:5000",
    backendManifestUrl: null,
    backendManifestKey: null,
    appId: "com.aivota.aac.dev",
    productName: "Aivota AAC Dev",
    // Electron keys userData / logs / the updater-cache dir off the package
    // `name` (app.getName()), NOT productName — so each env needs a distinct
    // name to isolate its settings/login/update-cache from the others.
    pkgName: "aivota-aac-dev",
    updatePrefix: "aac-dev/win/",
    updateUrl: `${UPDATES_HOST}/aac-dev/win/`,
    publishable: false,
    isDefaultIdentity: false,
  },
  "ecs-test": {
    // THE ECS CUTOVER REHEARSAL. Same app as prod and pointed at the same ECS
    // backend, but with its own install identity and NO update feed or runtime
    // manifest — so it installs beside a real prod app instead of taking over
    // its userData, can never be re-pointed remotely, and never auto-updates
    // out from under the test.
    //
    // It exists so that testing ECS costs the dev/staging/demo path nothing:
    // `staging` keeps pointing at Render, and no manifest publish is needed to
    // try ECS, so nothing about the Render fleet has to move first.
    //
    // NOTE: this backend uses the PRODUCTION database, not Render's. An account
    // that works in the staging app does not exist here.
    backendUrl: "https://api.aivota.ai",
    backendManifestUrl: null,
    backendManifestKey: null,
    appId: "com.aivota.aac.ecstest",
    productName: "Aivota AAC (ECS Test)",
    // Distinct pkgName ⇒ its own userData/logs/update-cache, so its login and
    // device id never mix with the prod app on the same machine.
    pkgName: "aivota-aac-ecstest",
    updatePrefix: "aac-ecstest/win/",
    updateUrl: `${UPDATES_HOST}/aac-ecstest/win/`,
    publishable: false,
    isDefaultIdentity: false,
  },
  staging: {
    // Staging server stays on Render (only `main` moved to AWS ECS).
    backendUrl: "https://aivota-staging-us.onrender.com",
    backendManifestUrl: `${UPDATES_HOST}/aac-staging/latest-backend.json`,
    backendManifestKey: "aac-staging/latest-backend.json",
    appId: "com.aivota.aac.staging",
    productName: "Aivota AAC Staging",
    pkgName: "aivota-aac-staging",
    updatePrefix: "aac-staging/win/",
    updateUrl: `${UPDATES_HOST}/aac-staging/win/`,
    publishable: true,
    isDefaultIdentity: false,
  },
  prod: {
    // Production backend: the ECS ALB reached directly (not through
    // CloudFront) so the app's WebSockets never traverse the CDN. See
    // terraform/ecs.tf (api_subdomain) and docs/INFRASTRUCTURE.md.
    // Identity + update feed come from electron-builder.yml — do not override.
    // pkgName stays the default "aivota-aac" so existing prod installs keep
    // their userData (never migrate the production name).
    backendUrl: "https://api.aivota.ai",
    backendManifestUrl: `${UPDATES_HOST}/aac/latest-backend.json`,
    backendManifestKey: "aac/latest-backend.json",
    appId: "com.aivota.aac",
    productName: "Aivota AAC",
    pkgName: "aivota-aac",
    updatePrefix: "aac/win/",
    updateUrl: `${UPDATES_HOST}/aac/win/`,
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

/** Vite env vars to bake into a client build for this environment. */
export function aacBuildEnv(cfg) {
  return {
    VITE_API_URL: cfg.backendUrl,
    ...(cfg.backendManifestUrl ? { VITE_BACKEND_MANIFEST_URL: cfg.backendManifestUrl } : {}),
  };
}
