// server/services/photos/photo-renders.ts
//
// The INGEST RENDER LADDER — original bytes in, two WebP renders out.
// See planning-docs/aac-photos-plan.md §4.
//
// The original is NEVER stored. A 3-5MB phone photo becomes ~200KB at 1024px,
// a ~20x reduction in BOTH storage and egress, and that single step dominates
// every other cost lever for this feature.
//
// This module is deliberately free of S3 and database access so the ladder can
// be unit-tested without either.

import sharp from "sharp";
import { createHash } from "crypto";
import exifReader from "exif-reader";

/** Display render: what the viewer shows full-screen. */
export const DISPLAY_MAX_EDGE = 1024;
export const DISPLAY_QUALITY = 80;

/** Thumb render: what the browse board's buttons show. */
export const THUMB_MAX_EDGE = 256;
export const THUMB_QUALITY = 75;

/** Every render is WebP — ~25-35% smaller than JPEG at equal quality, and
 *  supported by every client we ship (Electron, Capacitor/iOS, Chrome webview). */
export const PHOTO_MIME_TYPE = "image/webp";

export interface RenderedImage {
  buffer: Buffer;
  width: number;
  height: number;
  byteSize: number;
}

export interface PhotoRenders {
  /** sha256 of the ORIGINAL bytes, hex — the dedup key. Hashed before any
   *  re-encoding so it stays stable if the ladder below ever changes. */
  contentHash: string;
  display: RenderedImage;
  thumb: RenderedImage;
  /** EXIF capture time, when the original carried one. */
  takenAt: Date | null;
  mimeType: typeof PHOTO_MIME_TYPE;
}

/** sha256 of a buffer, hex. */
export function hashOriginal(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Pull the capture time out of a raw EXIF block.
 *
 * Exported for its own tests because EXIF dates are a swamp: they are written
 * as `YYYY:MM:DD HH:mm:ss` with COLONS in the date part, which `new Date()`
 * refuses, and cameras emit partial or zeroed values freely. Anything we cannot
 * read confidently becomes null — a wrong date is worse than no date, since
 * this is the only thing ordering an uncaptioned library.
 */
export function parseExifTakenAt(exifBuffer: Buffer | undefined): Date | null {
  if (!exifBuffer || exifBuffer.length === 0) return null;
  try {
    const parsed: any = exifReader(exifBuffer);
    // Preference order: when the shutter fired, then when it was digitized,
    // then the file's own modify time.
    const raw =
      parsed?.Photo?.DateTimeOriginal ??
      parsed?.Photo?.DateTimeDigitized ??
      parsed?.Image?.DateTime ??
      null;
    if (!raw) return null;

    // exif-reader usually hands back a Date already.
    if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;

    if (typeof raw === "string") {
      // "2024:07:14 09:31:02" -> "2024-07-14T09:31:02"
      const normalized = raw
        .trim()
        .replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3")
        .replace(" ", "T");
      const date = new Date(normalized);
      if (isNaN(date.getTime())) return null;
      // Cameras with a dead clock emit 0000/1970 sentinels. Treat anything
      // before digital photography as unset rather than propagating a lie.
      if (date.getUTCFullYear() < 1990) return null;
      return date;
    }
    return null;
  } catch {
    // A malformed EXIF block must never fail an upload.
    return null;
  }
}

/** Downscale to fit `maxEdge` on the long side and encode WebP. */
async function renderOne(
  original: Buffer,
  maxEdge: number,
  quality: number,
): Promise<RenderedImage> {
  const output = await sharp(original)
    // MUST come before resize. Cameras record portrait shots as landscape
    // pixels plus an orientation tag; sharp strips metadata on output (which
    // is how EXIF removal is free), so without baking the rotation in first
    // every portrait photo would be served on its side.
    .rotate()
    .resize(maxEdge, maxEdge, {
      fit: "inside",          // preserve aspect ratio, no cropping
      withoutEnlargement: true, // never upscale a small original
    })
    .webp({ quality })
    // NOTE: do NOT add .withMetadata(). Its absence is what strips EXIF, and
    // GPS coordinates in a child's photo library are a liability we have no
    // use for. `takenAt` is lifted out separately, before this runs.
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: output.data,
    width: output.info.width,
    height: output.info.height,
    byteSize: output.data.length,
  };
}

/**
 * Run the full ladder. Throws if the buffer is not a decodable image, so the
 * caller can reject the upload before any row or S3 object is created.
 */
export async function renderPhoto(original: Buffer): Promise<PhotoRenders> {
  // Hash first: the dedup key describes what the caretaker actually gave us.
  const contentHash = hashOriginal(original);

  const metadata = await sharp(original).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Unreadable image: no dimensions");
  }
  const takenAt = parseExifTakenAt(metadata.exif);

  const [display, thumb] = await Promise.all([
    renderOne(original, DISPLAY_MAX_EDGE, DISPLAY_QUALITY),
    renderOne(original, THUMB_MAX_EDGE, THUMB_QUALITY),
  ]);

  return { contentHash, display, thumb, takenAt, mimeType: PHOTO_MIME_TYPE };
}

/** S3 keys for a photo's renders. Distinct prefix from `symbols/`. */
export function photoS3Keys(photoId: string): { display: string; thumb: string } {
  return {
    display: `photos/${photoId}/d.webp`,
    thumb: `photos/${photoId}/t.webp`,
  };
}
