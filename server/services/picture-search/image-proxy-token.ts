// server/services/picture-search/image-proxy-token.ts
//
// Signed, expiring capability tokens for the picture-search image proxy.
//
// WHY A PROXY AT ALL — the student's device must never fetch bytes directly from
// whatever host an image search returned. A raw <img src="https://stranger.example/…">
// hands that stranger the student's IP address and a referrer, on a device used
// by a child with a disability, for a picture nobody at our end ever looked at.
// Routing through our own origin also means the whole feature keeps working the
// day we finally turn CSP on (moe-status.md §CSP), instead of going dark.
//
// WHY A TOKEN — the proxy takes a URL as a parameter, so without a signature it
// is an open relay: anyone could point it at anything and borrow our egress. The
// token says "this exact URL was produced by one of OUR searches, recently".
//
// Mirrors server/services/realtime/ws-ticket.ts: same SESSION_SECRET-derived-key
// pattern, same base64url payload shape. Deliberately NOT single-use — one
// picture is fetched by the grid and again by the viewer, and browsers retry.

import { createHmac, timingSafeEqual } from "crypto";

/** How long a minted image URL keeps working. Long enough that a student can
 *  leave the app open and come back to it; short enough that a URL leaking into
 *  a log is worthless by the time anyone reads it. */
export const IMAGE_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Longest upstream URL we will sign. Image URLs are occasionally enormous
 *  (signed CDN links); this is a sanity bound, not a spec limit. */
const MAX_URL_CHARS = 2000;

/** Derived, not SESSION_SECRET itself, so a leaked image signature can never be
 *  replayed against session cookies or WS tickets. */
function proxyKey(): Buffer {
  const base = process.env.SESSION_SECRET || "fallback-secret-key-for-dev";
  return createHmac("sha256", base).update("aivota:picture-proxy:v1").digest();
}

function sign(payload: string): string {
  return createHmac("sha256", proxyKey()).update(payload).digest("base64url");
}

export interface ImageProxyToken {
  /** base64url of the upstream URL. */
  u: string;
  /** Expiry, epoch ms. */
  e: number;
  /** Signature over `${u}.${e}`. */
  s: string;
}

/** Sign an upstream image URL, or null if it is not something we should sign. */
export function mintImageToken(url: string, now: number = Date.now()): ImageProxyToken | null {
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_URL_CHARS) return null;
  if (!/^https?:\/\//i.test(url)) return null;

  const u = Buffer.from(url, "utf8").toString("base64url");
  const e = now + IMAGE_TOKEN_TTL_MS;
  return { u, e, s: sign(`${u}.${e}`) };
}

/** The server-relative proxy path for an upstream URL, or null when unsignable. */
export function imageProxyPath(url: string, now: number = Date.now()): string | null {
  const token = mintImageToken(url, now);
  if (!token) return null;
  const q = new URLSearchParams({ u: token.u, e: String(token.e), s: token.s });
  return `/api/aac/picture-search/img?${q.toString()}`;
}

/**
 * Verify a presented token and recover the upstream URL, or null if it is
 * malformed, forged or expired.
 *
 * Signature comparison is constant-time; length is checked first because
 * timingSafeEqual throws on a mismatch rather than returning false.
 */
export function redeemImageToken(
  params: { u?: unknown; e?: unknown; s?: unknown },
  now: number = Date.now(),
): string | null {
  const u = typeof params.u === "string" ? params.u : "";
  const s = typeof params.s === "string" ? params.s : "";
  if (!u || !s) return null;
  if (u.length > MAX_URL_CHARS * 2) return null;

  // `e` arrives as a string off the query string and as a number from a minted
  // token object. Both are legitimate callers, so accept either — but sign over
  // the CANONICAL numeric form, or the two shapes would produce different
  // payloads and one of them would never verify.
  const e = typeof params.e === "number" ? params.e : Number(params.e);
  if (!Number.isFinite(e) || !Number.isInteger(e) || e <= now) return null;

  const expected = Buffer.from(sign(`${u}.${e}`), "utf8");
  const presented = Buffer.from(s, "utf8");
  if (expected.length !== presented.length) return null;
  if (!timingSafeEqual(expected, presented)) return null;

  let url: string;
  try {
    url = Buffer.from(u, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}

/**
 * Reject URLs that point back inside our own network.
 *
 * The signature already proves WE minted this URL from a search result, so this
 * is belt-and-braces — but the cost of being wrong is an SSRF into the VPC, and
 * the check is four lines.
 */
export function isSafeUpstreamHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return false;
  // IPv6 loopback and unique-local. Gated on "is this an address at all" —
  // an unguarded fc/fd prefix test would also reject fd-cdn.example.com.
  if (host.includes(":") && (host === "::1" || /^f[cd]/.test(host))) return false;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false; // link-local, incl. cloud metadata
  if (host === "0.0.0.0") return false;
  return true;
}
