// scripts/publish-aac-ios.mjs
//
// Upload a built iPad .ipa to the AAC download feed — the same S3 bucket +
// CloudFront distribution the Windows auto-updater uses, under `aac/ios/`.
//
// Counterpart to publish-aac-release.mjs. The iOS app has NO auto-updater
// (Capacitor + sideloading can't self-update), so nothing polls this feed
// automatically; it exists so the clinician dashboard's Downloads panel can
// hand out the current .ipa instead of it being emailed by hand.
//
// What gets uploaded:
//   - <ipa filename>.ipa   ← the payload (versioned filename)
//   - latest.json          ← the manifest the server reads
//
// The .ipa goes up FIRST and the manifest LAST, for the same reason as the
// Windows publisher: nobody should ever read a manifest pointing at a
// half-uploaded payload.
//
// Configuration (env vars):
//   AAC_UPDATE_BUCKET    S3 bucket name                                — required
//   AAC_IOS_PREFIX       Key prefix inside the bucket (default "aac/ios/")
//   AAC_UPDATE_REGION    AWS region (default us-east-1)
//   AAC_IOS_SIGNED       "1" if the .ipa is signed (TestFlight-grade); default unsigned
//   AAC_UPDATE_DRY_RUN   "1" to log what would upload without sending
//
// Usage:
//   node scripts/publish-aac-ios.mjs <path-to-ipa> [buildNumber]
//
// AWS credentials come from the standard chain (env vars, ~/.aws, IAM role).

import "dotenv/config";
import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..");

const BUCKET = process.env.AAC_UPDATE_BUCKET;
const PREFIX = (process.env.AAC_IOS_PREFIX ?? "aac/ios/").replace(/^\/+|\/+$/g, "") + "/";
const REGION = process.env.AAC_UPDATE_REGION ?? "us-east-1";
const SIGNED = process.env.AAC_IOS_SIGNED === "1";
const DRY = process.env.AAC_UPDATE_DRY_RUN === "1";

const ipaArg = process.argv[2];
const buildNumber = process.argv[3] ?? null;

if (!ipaArg) {
  console.error("[ios-release] usage: node scripts/publish-aac-ios.mjs <path-to-ipa> [buildNumber]");
  process.exit(1);
}
if (!BUCKET && !DRY) {
  console.error("[ios-release] AAC_UPDATE_BUCKET is required (or set AAC_UPDATE_DRY_RUN=1).");
  process.exit(1);
}

const ipaPath = resolve(ipaArg);
if (!existsSync(ipaPath)) {
  console.error(`[ios-release] .ipa not found: ${ipaPath}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const ipaName = basename(ipaPath);
const size = statSync(ipaPath).size;

console.log(`[ios-release] product version = ${pkg.version}${buildNumber ? ` (build ${buildNumber})` : ""}`);
console.log(`[ios-release] payload          = ${ipaName} (${(size / 1_000_000).toFixed(1)} MB)`);
console.log(`[ios-release] target           = s3://${BUCKET ?? "(dry-run)"}/${PREFIX}`);

// The manifest the server's appDownloadService parses. Keep these field names
// in sync with parseIosManifest() in server/services/appDownloadService.ts.
const manifest = {
  version: pkg.version,
  build: buildNumber,
  path: ipaName,
  size,
  // Stamped at publish time — there is no equivalent of electron-builder's
  // releaseDate for a hand-packaged .ipa.
  releaseDate: new Date().toISOString(),
  // Unsigned builds must be re-signed by the installer (Sideloadly). The UI
  // shows the Sideloadly walkthrough either way, but this records which
  // pipeline produced the file.
  signed: SIGNED,
};

const s3 = DRY ? null : new S3Client({ region: REGION });

async function put(key, body, contentType, cacheControl) {
  console.log(`[ios-release] ${DRY ? "(dry) " : ""}→ ${key} (${contentType})`);
  if (DRY || !s3) return;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: cacheControl,
    }),
  );
}

// Payload first, manifest last.
await put(
  `${PREFIX}${ipaName}`,
  readFileSync(ipaPath),
  "application/octet-stream",
  "public, max-age=3600",
);
await put(
  `${PREFIX}latest.json`,
  JSON.stringify(manifest, null, 2),
  "application/json; charset=utf-8",
  // Must not be cached — it's the pointer to the current build. CloudFront has
  // a matching `*latest*.json` zero-TTL behavior (terraform/aac-updates.tf).
  "public, max-age=0, must-revalidate",
);

console.log("[ios-release] done. The clinician Downloads panel will serve this build.");
