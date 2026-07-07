// scripts/release-aac.mjs
//
// One entrypoint to build (and optionally publish) an AAC desktop release for a
// given environment. Same app everywhere — only the backend it connects to and
// its install identity / update feed change (see aac-release-config.mjs).
//
//   node scripts/release-aac.mjs dev                  # build installer → localhost server
//   node scripts/release-aac.mjs staging --publish    # build + upload to the staging feed
//   node scripts/release-aac.mjs prod --publish       # build + upload to the production feed
//   node scripts/release-aac.mjs staging --publish --dry-run   # build + log the upload, no S3
//
// Steps: (1) build the client bundle + electron main with the env's backend URL
// baked in (VITE_API_URL, injected via process env — it overrides
// client-aac/.env.electron); (2) assemble the gaze sidecar; (3) package the
// Windows installer, overriding app identity + update feed for non-prod;
// (4) optionally upload to S3 via publish-aac-release.mjs.
//
// Publish env vars (see publish-aac-release.mjs): AAC_UPDATE_BUCKET (required
// to actually upload), AAC_UPDATE_REGION, AAC_UPDATE_DRY_RUN. This script fills
// AAC_UPDATE_PREFIX from the env config so the caller doesn't have to.

import { spawnSync } from "node:child_process";
import { resolveAacEnv } from "./aac-release-config.mjs";

const argv = process.argv.slice(2);
const envName = argv.find((a) => !a.startsWith("-"));
const doPublish = argv.includes("--publish");
const dryRun = argv.includes("--dry-run");

let cfg;
try {
  cfg = resolveAacEnv(envName);
} catch (e) {
  console.error(`[release-aac] ${e.message}`);
  console.error(`[release-aac] usage: node scripts/release-aac.mjs <dev|staging|prod> [--publish] [--dry-run]`);
  process.exit(1);
}

if (doPublish && !cfg.publishable) {
  console.error(
    `[release-aac] env "${cfg.name}" is not publishable (its backend is ${cfg.backendUrl}). ` +
    `Build it without --publish and install locally.`,
  );
  process.exit(1);
}

console.log(
  `[release-aac] env=${cfg.name}  backend=${cfg.backendUrl}  appId=${cfg.appId}  product="${cfg.productName}"` +
  `  publish=${doPublish ? (dryRun ? "dry-run" : "yes") : "no"}`,
);

/** Run a shell command string; abort the release on non-zero exit. Command
 *  strings (not arg arrays) so that quoted values with spaces — e.g.
 *  -c.productName="Aivota AAC Staging" — parse correctly under the shell on
 *  both Windows (cmd) and POSIX. */
function run(commandString, extraEnv = {}) {
  console.log(`\n[release-aac] $ ${commandString}`);
  const r = spawnSync(commandString, {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...extraEnv },
  });
  if (r.status !== 0) {
    console.error(`[release-aac] step failed (exit ${r.status ?? "?"}): ${commandString}`);
    process.exit(r.status ?? 1);
  }
}

// 1. Build client bundle + electron main with this env's backend baked in.
run("npm run electron:build", { VITE_API_URL: cfg.backendUrl });

// 2. Assemble the gaze sidecar (32-bit node + koffi win32 prebuilds).
run("npm run build:sidecar");

// 3. Package the Windows installer. For non-prod, override app identity + the
//    update feed so builds install side-by-side and self-update from their own
//    channel. Prod uses electron-builder.yml as-is.
let ebCmd = "npx electron-builder --win --publish never";
if (!cfg.isDefaultIdentity) {
  ebCmd +=
    ` -c.appId=${cfg.appId}` +
    ` -c.productName="${cfg.productName}"` +
    ` -c.nsis.shortcutName="${cfg.productName}"` +
    // extraMetadata.name overrides the app's package.json `name`, which is what
    // Electron uses for userData / logs / the updater-cache dir — so each env
    // gets isolated storage and update cache (productName alone does NOT do this).
    ` -c.extraMetadata.name=${cfg.pkgName}` +
    ` -c.publish.url=${cfg.updateUrl}`;
}
run(ebCmd);

// 4. Optionally upload the installer + manifest to the env's update feed.
if (doPublish) {
  run("node scripts/publish-aac-release.mjs", {
    AAC_UPDATE_PREFIX: cfg.updatePrefix,
    ...(dryRun ? { AAC_UPDATE_DRY_RUN: "1" } : {}),
  });
} else {
  console.log(`\n[release-aac] build complete — installer is in release/ (not published).`);
}

console.log(`\n[release-aac] done (${cfg.name}).`);
