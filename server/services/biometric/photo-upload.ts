// server/services/biometric/photo-upload.ts
// Resize image, upload to S3, persist the URL onto the entity's biometric_data row.

import crypto from "crypto";
import sharp from "sharp";
import { s3Service } from "../storage/s3-service";
import {
  ensureBiometricData,
  updateBiometricData,
  getBiometricData,
  type EntityType,
  type FaceEmbedding,
} from "./recognition-service";

// 512×512 is the working resolution for face-api embeddings; no gain from larger
const TARGET_SIZE = 512;
const JPEG_QUALITY = 85;
const S3_PREFIX = "biometric";

export interface PhotoUploadResult {
  biometricDataId: string;
  faceImageUrl: string;
  faceImageQuality?: number;
}

/**
 * Resize + re-encode the uploaded image to a canonical JPEG. Uses `cover`
 * fitting so faces stay centered; caller is expected to pass a face-cropped
 * image already (extractFaceEmbedding on the client also crops) but this works
 * fine with full-frame input too.
 */
export async function resizeForBiometric(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .rotate() // honor EXIF
    .resize(TARGET_SIZE, TARGET_SIZE, { fit: "cover", position: "center" })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
}

/**
 * Upload a (already resized) JPEG to S3 under biometric/ and return the key.
 * Returns a public-style URL path; actual access is gated by the API layer.
 */
async function uploadToS3(buffer: Buffer): Promise<string> {
  const id = crypto.randomUUID();
  const key = `${S3_PREFIX}/${id}.jpg`;
  await s3Service.upload(key, buffer, "image/jpeg");
  return key;
}

/**
 * End-to-end: accept a raw image Buffer for an entity, resize, upload, and
 * update the shared biometric_data row. Returns the URL we stored.
 *
 * `embedding` is optional — when present, stored alongside the image. The
 * client extracts the 128D embedding via face-api.js and sends it with the
 * multipart upload, so the server doesn't need its own face detection.
 */
export async function uploadBiometricPhoto(
  target: { type: EntityType; id: string },
  imageBuffer: Buffer,
  opts: { embedding?: FaceEmbedding; quality?: number } = {},
): Promise<PhotoUploadResult> {
  const resized = await resizeForBiometric(imageBuffer);
  const key = await uploadToS3(resized);

  const biometricDataId = await ensureBiometricData(target);

  // Delete the previous image if one was stored (best-effort; don't block on it)
  const existing = await getBiometricData(biometricDataId);
  if (existing?.faceImageUrl && existing.faceImageUrl !== key) {
    void s3Service.delete(existing.faceImageUrl).catch((err) => {
      console.warn("[Biometric] failed to delete old face image:", err?.message);
    });
  }

  await updateBiometricData(biometricDataId, {
    faceImageUrl: key,
    faceImageQuality: opts.quality,
    ...(opts.embedding ? { faceEmbedding: opts.embedding } : {}),
  });

  return { biometricDataId, faceImageUrl: key, faceImageQuality: opts.quality };
}
