/**
 * The photo INGEST RENDER LADDER.
 *
 * These guard the properties the plan actually relies on: originals are never
 * what we store, EXIF (and therefore GPS) does not survive, orientation is
 * baked in before the strip, and the content hash is stable enough to dedup on.
 *
 * See planning-docs/aac-photos-plan.md §4.
 */

import { describe, it, expect } from "@jest/globals";
import sharp from "sharp";
import {
  DISPLAY_MAX_EDGE,
  THUMB_MAX_EDGE,
  PHOTO_MIME_TYPE,
  hashOriginal,
  parseExifTakenAt,
  renderPhoto,
  photoS3Keys,
} from "../services/photos/photo-renders.js";

/** A JPEG of the given pixel size — stand-in for a camera original. */
async function makeJpeg(width: number, height: number, tint = 40): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: tint, g: 120, b: 200 },
    },
  })
    .jpeg()
    .toBuffer();
}

describe("hashOriginal", () => {
  it("is stable for identical bytes and distinct for different bytes", async () => {
    const a = await makeJpeg(64, 64, 10);
    const b = await makeJpeg(64, 64, 200);
    expect(hashOriginal(a)).toBe(hashOriginal(Buffer.from(a)));
    expect(hashOriginal(a)).not.toBe(hashOriginal(b));
    expect(hashOriginal(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("renderPhoto", () => {
  it("downscales a large original to the display and thumb edges", async () => {
    const original = await makeJpeg(4032, 3024); // a phone photo
    const renders = await renderPhoto(original);

    expect(Math.max(renders.display.width, renders.display.height)).toBe(DISPLAY_MAX_EDGE);
    expect(Math.max(renders.thumb.width, renders.thumb.height)).toBe(THUMB_MAX_EDGE);
    // Aspect ratio survives — `fit: inside` must not crop a family photo.
    expect(renders.display.width / renders.display.height).toBeCloseTo(4032 / 3024, 2);
  });

  it("encodes WebP, and the display render is far smaller than the original", async () => {
    const original = await makeJpeg(3000, 2000);
    const renders = await renderPhoto(original);

    expect(renders.mimeType).toBe(PHOTO_MIME_TYPE);
    const format = await sharp(renders.display.buffer).metadata();
    expect(format.format).toBe("webp");
    // The whole cost argument for this feature rests on this shrinking.
    expect(renders.display.byteSize).toBeLessThan(original.length);
    expect(renders.thumb.byteSize).toBeLessThan(renders.display.byteSize);
  });

  it("never upscales an original smaller than the target edge", async () => {
    // A 120px avatar must stay 120px rather than being blown up to 1024.
    const original = await makeJpeg(120, 90);
    const renders = await renderPhoto(original);
    expect(renders.display.width).toBe(120);
    expect(renders.display.height).toBe(90);
  });

  it("strips metadata, so EXIF (and any GPS in it) does not survive", async () => {
    const original = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .withExif({
        IFD0: { Software: "test-camera" },
        // If this survived into S3 we would be storing a child's location.
        IFD2: { GPSLatitudeRef: "N" },
      })
      .jpeg()
      .toBuffer();

    // Guard the fixture itself: if sharp stopped writing EXIF the assertion
    // below would pass for the wrong reason.
    expect((await sharp(original).metadata()).exif).toBeDefined();

    const renders = await renderPhoto(original);
    expect((await sharp(renders.display.buffer).metadata()).exif).toBeUndefined();
    expect((await sharp(renders.thumb.buffer).metadata()).exif).toBeUndefined();
  });

  it("bakes EXIF orientation in before stripping it", async () => {
    // Cameras store portrait shots as landscape pixels plus an orientation tag.
    // Since the tag is dropped on write, the rotation must already be applied —
    // otherwise every portrait photo is served on its side.
    const landscapePixels = await sharp({
      create: { width: 800, height: 400, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .withMetadata({ orientation: 6 }) // "rotate 90° clockwise to display"
      .jpeg()
      .toBuffer();

    const renders = await renderPhoto(landscapePixels);
    // After auto-orientation the image is taller than it is wide.
    expect(renders.display.height).toBeGreaterThan(renders.display.width);
  });

  it("rejects a buffer that is not a decodable image", async () => {
    await expect(renderPhoto(Buffer.from("this is not an image"))).rejects.toThrow();
  });
});

describe("parseExifTakenAt", () => {
  it("returns null for absent or empty EXIF", () => {
    expect(parseExifTakenAt(undefined)).toBeNull();
    expect(parseExifTakenAt(Buffer.alloc(0))).toBeNull();
  });

  it("returns null rather than throwing on a malformed block", () => {
    // A corrupt EXIF header must never fail an upload.
    expect(parseExifTakenAt(Buffer.from("garbage"))).toBeNull();
  });

  it("lifts the capture time out of a real EXIF block", async () => {
    const withDate = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .withExif({ IFD0: { DateTime: "2024:07:14 09:31:02" } })
      .jpeg()
      .toBuffer();

    const exif = (await sharp(withDate).metadata()).exif;
    const takenAt = parseExifTakenAt(exif);
    expect(takenAt).toBeInstanceOf(Date);
    expect(takenAt!.getFullYear()).toBe(2024);
    expect(takenAt!.getMonth()).toBe(6); // July, zero-indexed
    expect(takenAt!.getDate()).toBe(14);
  });
});

describe("photoS3Keys", () => {
  it("namespaces photos away from symbols", () => {
    const keys = photoS3Keys("abc-123");
    expect(keys.display).toBe("photos/abc-123/d.webp");
    expect(keys.thumb).toBe("photos/abc-123/t.webp");
    // A shared prefix would let a symbols-wide lifecycle or IAM rule reach
    // family photos by accident.
    expect(keys.display.startsWith("symbols/")).toBe(false);
  });
});
