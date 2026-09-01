/**
 * publish-voice-models.mjs — Upload the on-device voice models to the AAC
 * distribution bucket so DEVICES can download them at runtime.
 *
 * WHY THIS EXISTS
 * The Kokoro neural voice is ~94 MB. Bundling it in the installer would charge
 * every user for a voice most of them never enable, and would not scale at all
 * once there is a model per locale. So the weights live on the CDN and a device
 * fetches them only when a student on THAT DEVICE has the local voice switched
 * on (aac_settings.localVoiceEnabled).
 *
 * WHERE THEY GO
 * The same bucket + CloudFront distribution as the desktop auto-update feed
 * (terraform/aac-updates.tf) — public, non-PHI, already fronted by
 * updates.aivota.ai. That file has a `models/*` cache behavior carrying the
 * CORS policy the packaged apps need (they fetch from app://aac and
 * capacitor://localhost, which are cross-origin) and a long edge TTL.
 *
 * PATHS ARE VERSIONED AND IMMUTABLE:
 *     models/kokoro/v1.0/onnx/model_quantized.onnx
 *     models/kokoro/v1.0/voices/af_heart.bin
 * A published file NEVER changes. Shipping a different model means publishing a
 * NEW version prefix and pointing the client at it — never overwriting, because
 * devices cache aggressively (that's the point) and a silently-swapped file
 * would leave the fleet on mixed weights with no way to tell.
 *
 * Reads whatever `npm run kokoro:model` staged into client-aac/public/models/,
 * so the bytes published are the exact bytes tested locally.
 *
 * Usage:
 *   AAC_UPDATE_BUCKET=<bucket> node scripts/publish-voice-models.mjs
 *   node scripts/publish-voice-models.mjs --dry-run
 *
 * Env (same as publish-aac-backend.mjs):
 *   AAC_UPDATE_BUCKET  (required unless --dry-run)
 *   AAC_UPDATE_REGION  (default us-east-1)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");

/** Bump the version when the WEIGHTS change. Must match MODEL_VERSION in
 *  client-aac/src/services/kokoroTts.ts — the client builds its fetch URL from
 *  it, so a mismatch means every device 404s and silently keeps
 *  speechSynthesis. */
const MODEL_VERSION = "v1.0";
const MODEL_NAME = "kokoro";

const SOURCE_DIR = path.join(
  root, "client-aac", "public", "models", "onnx-community", "Kokoro-82M-v1.0-ONNX",
);
const KEY_PREFIX = `models/${MODEL_NAME}/${MODEL_VERSION}`;

/** Must match FILES in scripts/fetch-kokoro-model.mjs — anything the client
 *  asks for and we didn't publish is a 404 mid-download. */
const FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/model_quantized.onnx",
  "voices/af_heart.bin",
  "voices/af_bella.bin",
  "voices/am_puck.bin",
  "voices/am_michael.bin",
];

const CONTENT_TYPES = {
  ".json": "application/json; charset=utf-8",
  ".onnx": "application/octet-stream",
  ".bin": "application/octet-stream",
};

const BUCKET = process.env.AAC_UPDATE_BUCKET;
const REGION = process.env.AAC_UPDATE_REGION ?? "us-east-1";
if (!BUCKET && !dryRun) {
  console.error("[voice-models] AAC_UPDATE_BUCKET is required (or pass --dry-run).");
  process.exit(1);
}

// Fail before uploading anything if the staging step wasn't run — a partial
// publish is worse than none, because the fleet would download a broken set.
const missing = FILES.filter((f) => !fs.existsSync(path.join(SOURCE_DIR, f)));
if (missing.length) {
  console.error(`[voice-models] missing staged files (run \`npm run kokoro:model\` first):`);
  for (const f of missing) console.error(`  - ${f}`);
  process.exit(1);
}

const s3 = dryRun ? null : new S3Client({ region: REGION });

/** Immutable paths mean a key that already exists should NOT be rewritten:
 *  either it's the same bytes (no-op) or someone changed a model without
 *  bumping the version, which must be loud rather than silent. */
async function alreadyPublished(key) {
  if (!s3) return false;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound") return false;
    throw err;
  }
}

let published = 0;
let skipped = 0;
let total = 0;

console.log(`[voice-models] ${MODEL_NAME} ${MODEL_VERSION} → s3://${BUCKET ?? "(dry-run)"}/${KEY_PREFIX}/`);

for (const rel of FILES) {
  const file = path.join(SOURCE_DIR, rel);
  const key = `${KEY_PREFIX}/${rel}`;
  const size = fs.statSync(file).size;
  total += size;

  if (!force && (await alreadyPublished(key))) {
    console.log(`[voice-models] skip (already published): ${rel}`);
    skipped++;
    continue;
  }

  if (dryRun) {
    console.log(`[voice-models] (dry) would upload ${rel} (${(size / 1e6).toFixed(1)} MB) → ${key}`);
    published++;
    continue;
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: fs.createReadStream(file),
      ContentLength: size,
      ContentType: CONTENT_TYPES[path.extname(rel)] ?? "application/octet-stream",
      // Versioned path ⇒ the object can never change ⇒ cache it forever. This
      // is what keeps a 94 MB download a once-per-device event.
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
  console.log(`[voice-models] uploaded ${rel} (${(size / 1e6).toFixed(1)} MB)`);
  published++;
}

console.log(
  `[voice-models] done — ${published} uploaded, ${skipped} already present, ${(total / 1e6).toFixed(1)} MB total.`,
);
if (!dryRun && published > 0) {
  console.log(`[voice-models] devices fetch from: https://updates.aivota.ai/${KEY_PREFIX}/`);
}
if (skipped > 0 && !force) {
  console.log("[voice-models] NOTE: existing keys were left alone (paths are immutable). To replace weights, bump MODEL_VERSION here AND in kokoroTts.ts.");
}
