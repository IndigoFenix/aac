// scripts/publish-aac-release.mjs
//
// Upload a packaged AAC release to the auto-update bucket. Run after
// `npm run release:aac:build` has populated `release/` with the NSIS
// installer (.exe), the differential block-map, and the manifest
// (`latest.yml`) that electron-updater fetches.
//
// What gets uploaded:
//   - <ProductName> Setup <version>.exe   ← the installer payload
//   - <ProductName> Setup <version>.exe.blockmap   ← diff-update chunks
//   - latest.yml                           ← electron-updater manifest
//
// The manifest is what electron-updater polls; it carries the version
// number, the installer URL, and SHA-512 hashes. Until latest.yml is
// updated, installed clients won't see the new version — so we upload
// the .exe + .blockmap FIRST, then the manifest LAST. That ordering
// matters: a client polling mid-upload should never see a manifest
// pointing at a half-uploaded .exe.
//
// Configuration (env vars):
//   AAC_UPDATE_BUCKET    S3 bucket name (e.g. "aivota-updates")        — required
//   AAC_UPDATE_PREFIX    Key prefix inside the bucket (default "aac/win/")
//   AAC_UPDATE_REGION    AWS region (default us-east-1)
//   AAC_UPDATE_CACHE     Cache-Control for installer assets (default "public, max-age=3600")
//   AAC_UPDATE_DRY_RUN   "1" to log what would upload without sending
//
// AWS credentials are resolved via the standard chain (env vars, ~/.aws/
// credentials, IAM role on EC2/CI). No credentials are embedded here.

// Load .env (repo root) so AAC_UPDATE_* (and AWS_PROFILE) can live in a file
// for local publishes instead of being typed inline. In CI these come from the
// workflow env; dotenv simply no-ops when no .env is present.
import "dotenv/config";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..");
const releaseDir = join(repoRoot, "release");

const BUCKET = process.env.AAC_UPDATE_BUCKET;
const PREFIX = (process.env.AAC_UPDATE_PREFIX ?? "aac/win/").replace(/^\/+|\/+$/g, "") + "/";
const REGION = process.env.AAC_UPDATE_REGION ?? "us-east-1";
const CACHE = process.env.AAC_UPDATE_CACHE ?? "public, max-age=3600";
const DRY = process.env.AAC_UPDATE_DRY_RUN === "1";

if (!BUCKET && !DRY) {
  console.error("[release] AAC_UPDATE_BUCKET is required (or set AAC_UPDATE_DRY_RUN=1).");
  process.exit(1);
}

// Read the version stamp from package.json so the script's logs line up
// with the manifest content — and so a stale `release/` from an earlier
// version is loud rather than silent.
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
console.log(`[release] product version = ${pkg.version}`);
console.log(`[release] target           = s3://${BUCKET ?? "(dry-run)"}/${PREFIX}`);

// electron-builder writes the manifest + installer at the top of release/.
// Other byproducts (.yaml metadata, unpacked dir, builder-effective-config.yml)
// are NOT uploaded — only the three files the updater needs.
const entries = readdirSync(releaseDir);
const manifest = "latest.yml";

if (!entries.includes(manifest)) {
  console.error(`[release] ${manifest} not found in ${releaseDir} — did 'npm run release:aac:build' run?`);
  process.exit(1);
}

const manifestText = readFileSync(join(releaseDir, manifest), "utf8");

// Sanity: the manifest's `version` field must match package.json. Catches the
// "forgot to npm version" trap before clients ever poll.
const manifestVersionMatch = manifestText.match(/^version:\s*(\S+)/m);
if (manifestVersionMatch && manifestVersionMatch[1] !== pkg.version) {
  console.error(
    `[release] manifest version (${manifestVersionMatch[1]}) ≠ package.json version (${pkg.version}). ` +
    `Run \`npm version <patch|minor|major>\` and rebuild before publishing.`,
  );
  process.exit(1);
}

// Pick the installer the manifest ITSELF references (its `path:` field) — the
// exact filename clients will request. release/ accumulates installers from
// every prior build (electron-builder doesn't prune them), so the old "first
// *.exe in the directory" match could upload a STALE older version while the
// manifest pointed at the current one. Driving the choice from the manifest
// makes the uploaded .exe and latest.yml impossible to mismatch.
const installerMatch = manifestText.match(/^path:\s*(.+\.exe)\s*$/m);
const installer = installerMatch ? installerMatch[1].trim() : null;
const blockmap = installer ? `${installer}.blockmap` : null;

if (!installer) {
  console.error(`[release] could not read the installer filename from ${manifest}'s 'path:' field.`);
  process.exit(1);
}
if (!entries.includes(installer)) {
  console.error(
    `[release] manifest references "${installer}" but it is not in ${releaseDir} — ` +
    `stale or incomplete build. Re-run 'npm run release:aac:build'.`,
  );
  process.exit(1);
}

const s3 = DRY ? null : new S3Client({ region: REGION });

/**
 * Upload one file from release/ to S3 at PREFIX + filename.
 * Returns the upload promise; caller can serialize / parallelize.
 */
async function upload(filename, contentType) {
  const filePath = join(releaseDir, filename);
  const size = statSync(filePath).size;
  const key = `${PREFIX}${basename(filename)}`;
  console.log(`[release] ${DRY ? "(dry) " : ""}→ ${key} (${(size / 1_000_000).toFixed(1)} MB, ${contentType})`);
  if (DRY || !s3) return;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: readFileSync(filePath),
      ContentType: contentType,
      // Installer + blockmap: cache for an hour (CDN serves the same file
      // for the same version). The manifest gets no-cache below so a
      // client polling right after publish doesn't wait for TTL.
      CacheControl: CACHE,
    }),
  );
}

async function uploadManifest() {
  const filePath = join(releaseDir, manifest);
  const key = `${PREFIX}${manifest}`;
  console.log(`[release] ${DRY ? "(dry) " : ""}→ ${key} (manifest, no-cache)`);
  if (DRY || !s3) return;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: readFileSync(filePath),
      ContentType: "text/yaml; charset=utf-8",
      // Manifest must NOT be cached — installed clients poll it for
      // "is there a new version?" and a stale CDN copy delays rollout.
      CacheControl: "public, max-age=0, must-revalidate",
    }),
  );
}

// Order matters: installer + blockmap FIRST, manifest LAST. A client
// fetching `latest.yml` mid-upload should never see a manifest that
// points at a not-yet-uploaded .exe.
await upload(installer, "application/x-msdownload");
if (blockmap && entries.includes(blockmap)) {
  await upload(blockmap, "application/octet-stream");
} else {
  console.log(`[release] no blockmap (delta-update unavailable for this build).`);
}
await uploadManifest();

console.log("[release] done. Installed clients will pick up the update on their next poll (≤ 4h).");
