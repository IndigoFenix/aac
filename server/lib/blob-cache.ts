// server/lib/blob-cache.ts
// Conditional-GET support for endpoints that stream a stored blob from an
// ENTITY-keyed URL — `/api/biometric-data/:id/photo`, `/…/people/:id/photo`.
//
// The URL identifies the person, not the file, so it stays byte-identical when
// the blob behind it is replaced. Under a plain `max-age` the browser therefore
// keeps serving the PREVIOUS image for the whole window, which to the person
// who just uploaded a new one is indistinguishable from the upload not saving.
//
// The storage key is the version — each upload writes a fresh uuid — so publish
// it as an ETag and make the client revalidate. A replaced blob is visible on
// the next render; an unchanged one costs a 304 and no storage read at all.

import crypto from "crypto";
import type { Request, Response } from "express";

/** Version token for a stored blob. Hashed so the storage key stays server-side. */
export function blobETag(storageKey: string): string {
  return `"${crypto.createHash("sha256").update(storageKey).digest("hex").slice(0, 32)}"`;
}

/**
 * Set the revalidation headers, and answer 304 when the client already holds
 * this exact blob. Returns true when the response is finished — the caller must
 * return immediately and skip the (expensive) storage download.
 */
export function sendNotModified(req: Request, res: Response, storageKey: string): boolean {
  const etag = blobETag(storageKey);
  res.setHeader("ETag", etag);
  // "no-cache" = keep it, but revalidate before every use. Private: these blobs
  // are PHI-adjacent and must never sit in a shared cache.
  res.setHeader("Cache-Control", "private, no-cache");

  const ifNoneMatch = req.headers["if-none-match"];
  if (!ifNoneMatch) return false;
  // May be a list, and may carry weak validators — compare weakly.
  const tags = ifNoneMatch.split(",").map((t) => t.trim().replace(/^W\//, ""));
  if (!tags.includes(etag) && !tags.includes("*")) return false;

  res.status(304).end();
  return true;
}
