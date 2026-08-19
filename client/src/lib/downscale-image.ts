// client/src/lib/downscale-image.ts
//
// Shrink an image in the browser before uploading it.
//
// WHY THIS EXISTS: the server's ingest ladder already renders every photo down
// to 1024px (server/services/photos/photo-renders.ts), so the full-resolution
// original is thrown away seconds after arriving. Sending it anyway means a
// 20-photo batch is ~80MB of upload that has to survive a Lambda request — slow
// on a clinic's connection and the most likely cause of a timeout. Shrinking
// here costs nothing the server was going to keep.
//
// The target below is deliberately LARGER than the server's display edge: this
// is a transport optimisation, not the render ladder, and re-encoding twice at
// the same size would compound the quality loss for no gain.

/** Long-edge cap for the uploaded copy. Comfortably above the server's 1024px
 *  display render, so the server still has headroom to work from. */
export const UPLOAD_MAX_EDGE = 1600;

/** JPEG quality for the transport copy. */
export const UPLOAD_QUALITY = 0.9;

export interface DownscaleResult {
  blob: Blob;
  width: number;
  height: number;
  /** True when the image was actually re-encoded; false when the original was
   *  already small enough and is passed through untouched. */
  resized: boolean;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      // Release the object URL as soon as the bitmap is decoded, or a batch of
      // 20 photos leaks 20 blobs for the life of the page.
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode image"));
    };
    img.src = url;
  });
}

/** Target dimensions for a long-edge cap, preserving aspect ratio and never
 *  enlarging. Exported for its own tests — the rounding is where this goes
 *  wrong, and a 1px drift produces visibly squashed photos. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number; resized: boolean } {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) return { width, height, resized: false };
  const scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resized: true,
  };
}

/**
 * Downscale `file` for upload.
 *
 * Falls back to the untouched original whenever anything goes wrong — an exotic
 * format the canvas cannot decode, a tainted canvas, a browser without the APIs.
 * The server can handle the full-size original; it just prefers not to. Failing
 * the upload here would be strictly worse than sending more bytes.
 */
export async function downscaleForUpload(
  file: File,
  maxEdge = UPLOAD_MAX_EDGE,
): Promise<DownscaleResult> {
  const passthrough = (): DownscaleResult => ({
    blob: file,
    width: 0,
    height: 0,
    resized: false,
  });

  if (typeof document === "undefined" || !file.type.startsWith("image/")) {
    return passthrough();
  }

  try {
    const img = await loadImage(file);
    const target = fitWithin(img.naturalWidth, img.naturalHeight, maxEdge);
    if (!target.resized) {
      return { blob: file, width: target.width, height: target.height, resized: false };
    }

    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return passthrough();
    ctx.drawImage(img, 0, 0, target.width, target.height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", UPLOAD_QUALITY),
    );
    if (!blob) return passthrough();

    return { blob, width: target.width, height: target.height, resized: true };
  } catch {
    return passthrough();
  }
}
