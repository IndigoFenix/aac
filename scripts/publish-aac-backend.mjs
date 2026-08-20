// scripts/publish-aac-backend.mjs
//
// Publish the runtime BACKEND MANIFEST the packaged AAC apps poll on launch:
//
//   https://updates.aivota.ai/<env prefix>/latest-backend.json
//   { "backendUrl": "https://api.aivota.ai", "env": "prod", "publishedAt": "..." }
//
// Every installed desktop/iPad build reads this (client-aac/src/lib/api-base.ts)
// and stores the URL as its last-known-good backend — so moving the fleet to a
// new host is this one upload, not a forced-update campaign. The key matches
// the CDN's `*latest*.json` no-cache behaviour (terraform/aac-updates.tf), so
// clients see the change on their next launch.
//
//   node scripts/publish-aac-backend.mjs prod                       # publish the env's configured backend
//   node scripts/publish-aac-backend.mjs prod --backend https://x   # publish an explicit URL (rollback / drill)
//   node scripts/publish-aac-backend.mjs staging --dry-run
//
// Env (same as publish-aac-release.mjs): AAC_UPDATE_BUCKET (required unless
// --dry-run), AAC_UPDATE_REGION (default us-east-1), AAC_UPDATE_DRY_RUN=1.
// Credentials come from the standard AWS chain.

import "dotenv/config";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { resolveAacEnv } from "./aac-release-config.mjs";

const argv = process.argv.slice(2);
const envName = argv.find((a) => !a.startsWith("-"));
const dryRun = argv.includes("--dry-run") || process.env.AAC_UPDATE_DRY_RUN === "1";
const backendFlag = argv.indexOf("--backend");
const backendOverride = backendFlag >= 0 ? argv[backendFlag + 1] : undefined;

let cfg;
try {
  cfg = resolveAacEnv(envName);
} catch (e) {
  console.error(`[backend-manifest] ${e.message}`);
  console.error(`[backend-manifest] usage: node scripts/publish-aac-backend.mjs <staging|prod> [--backend <url>] [--dry-run]`);
  process.exit(1);
}

if (!cfg.backendManifestKey) {
  console.error(`[backend-manifest] env "${cfg.name}" has no manifest (its builds are never re-pointed remotely).`);
  process.exit(1);
}

/** Mirror the client's acceptance rule so we never publish something it will reject. */
function normalizeBackendUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal)) return null;
  if (u.search || u.hash || u.username || u.password) return null;
  return (u.origin + (u.pathname === "/" ? "" : u.pathname)).replace(/\/+$/, "");
}

const backendUrl = normalizeBackendUrl(backendOverride ?? cfg.backendUrl);
if (!backendUrl) {
  console.error(`[backend-manifest] invalid backend URL: ${backendOverride ?? cfg.backendUrl} (https only, no query/credentials)`);
  process.exit(1);
}

const BUCKET = process.env.AAC_UPDATE_BUCKET;
const REGION = process.env.AAC_UPDATE_REGION ?? "us-east-1";
if (!BUCKET && !dryRun) {
  console.error("[backend-manifest] AAC_UPDATE_BUCKET is required (or pass --dry-run).");
  process.exit(1);
}

const manifest = {
  backendUrl,
  env: cfg.name,
  publishedAt: new Date().toISOString(),
};
const body = JSON.stringify(manifest, null, 2) + "\n";

console.log(`[backend-manifest] env=${cfg.name}  backend=${backendUrl}`);
console.log(`[backend-manifest] ${dryRun ? "(dry) " : ""}→ s3://${BUCKET ?? "(dry-run)"}/${cfg.backendManifestKey}`);
console.log(body);

if (!dryRun) {
  const s3 = new S3Client({ region: REGION });
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: cfg.backendManifestKey,
      Body: body,
      ContentType: "application/json; charset=utf-8",
      // Polled by every client on launch; must never sit in an edge cache.
      CacheControl: "public, max-age=0, must-revalidate",
    }),
  );
  console.log(`[backend-manifest] published. Clients pick it up on their next launch: ${cfg.backendManifestUrl}`);
}
