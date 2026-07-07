// scripts/build-aac-installer.mjs
//
// Wrapper around `electron-builder --win --publish never` for the AAC
// desktop client. Its only job beyond the plain command is to support an
// OPTIONAL update-feed override without an env-with-default macro in
// electron-builder.yml.
//
// Why this exists: electron-builder's macro expander only matches `${...}`
// bodies of `[_a-zA-Z./*+]` — no `:` — so the inline `${env.VAR:default}`
// form silently fails to expand and gets baked verbatim into
// app-update.yml, breaking auto-update. There is no inline default syntax.
// So the URL is a hard literal in the yml, and a per-channel / per-tenant
// override is applied HERE, on the CLI, only when AAC_UPDATE_URL is set.
//
//   default build:   npm run release:aac:build
//   beta feed:       AAC_UPDATE_URL=https://updates.aivota.ai/aac/beta/ npm run release:aac:build
//
// Cross-platform (Node spawn, not a shell-ism) so it behaves the same on a
// dev box and the Windows CI runner.

import { spawnSync } from "node:child_process";

const args = ["--win", "--publish", "never"];

const overrideUrl = process.env.AAC_UPDATE_URL?.trim();
if (overrideUrl) {
  // -c.publish.url overrides the literal in electron-builder.yml for this
  // build only. Trailing slash matters — electron-updater joins `latest.yml`
  // onto it as a base URL.
  args.push(`-c.publish.url=${overrideUrl}`);
  console.log(`[build-aac] update feed overridden → ${overrideUrl}`);
} else {
  console.log("[build-aac] using default update feed from electron-builder.yml");
}

// npx-resolve electron-builder via the local bin. shell:true lets Windows
// find the .cmd shim; args are fixed/derived from our own env, not user input.
const result = spawnSync("electron-builder", args, { stdio: "inherit", shell: true });

if (result.error) {
  console.error("[build-aac] failed to launch electron-builder:", result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
