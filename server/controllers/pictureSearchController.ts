// server/controllers/pictureSearchController.ts
//
// The picture-search image proxy — the ONLY route in this feature. Searching
// itself has no endpoint: it happens inside the coordinator when the assistant
// calls open_app("picture_search", …), so the Speaker knows what is on screen
// before it speaks (see picture-search-service.ts).
//
// This route exists purely so the student's device never talks to a third-party
// image host directly. It takes a URL we signed, fetches the bytes ourselves,
// checks they really are an image, and hands them back from our own origin.

import type { Request, Response } from "express";
import { isSafeUpstreamHost, redeemImageToken } from "../services/picture-search/image-proxy-token";
import { allowImageProxyFetch } from "../services/picture-search/proxy-rate-limit";

/** Give up on a slow host rather than holding a Lambda invocation open. */
const FETCH_TIMEOUT_MS = 8000;

/** Refuse anything bigger.
 *
 *  4 MB, not 5: on Lambda a binary response is base64-encoded before it leaves
 *  the function, which inflates it by 4/3 against a HARD 6 MB response-payload
 *  limit. A 5 MB image encodes to ~6.7 MB and the invocation fails outright —
 *  the student would get a broken tile with no error we could explain. 4 MB
 *  encodes to ~5.3 MB and clears it. Pixabay's `largeImageURL` rendition is
 *  capped at 1280px and runs 200–500 KB, so this is a guard, not a limit
 *  anybody meets. */
const MAX_BYTES = 4 * 1024 * 1024;

const ALLOWED_CONTENT_TYPE = /^image\/(jpeg|png|gif|webp|bmp)\b/i;

export class PictureSearchController {
  /**
   * GET /api/aac/picture-search/img?u=…&e=…&s=…
   *
   * ⚠️ AUTH — deliberately unauthenticated, like the other AAC device routes
   * (`/api/aac/photos`, `/api/aac/spotify/token`): the AAC is a kiosk that does
   * not reliably carry a user session (see the iPad WS-cookie gap). What stands
   * in for auth here is the token itself — it is unforgeable, expires in an
   * hour, and names one specific URL that one of our own searches produced. An
   * attacker who obtains one gains the ability to fetch a public picture they
   * could already have fetched directly, so there is nothing behind the door.
   */
  async proxyImage(req: Request, res: Response) {
    const url = redeemImageToken(req.query as Record<string, unknown>);
    if (!url) return res.status(403).json({ error: "IMAGE_TOKEN_INVALID" });
    // A minted token is valid for an hour and is not single-use, so the token
    // alone does not bound how much egress one caller can spend. See
    // proxy-rate-limit.ts. `trust proxy` is set in routes.ts, so req.ip is the
    // real client rather than the gateway.
    if (!allowImageProxyFetch(req.ip || "anon")) {
      return res.status(429).json({ error: "IMAGE_RATE_LIMITED" });
    }
    if (!isSafeUpstreamHost(url)) return res.status(400).json({ error: "IMAGE_HOST_REFUSED" });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const upstream = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          // No Referer: the point of the proxy is that the student's session is
          // not announced to the host. A UA is sent because some CDNs 403
          // requests without one.
          "User-Agent": "Mozilla/5.0 (compatible; Aivota/1.0)",
          Accept: "image/*",
        },
      });

      if (!upstream.ok) return res.status(502).json({ error: "IMAGE_FETCH_FAILED" });

      const contentType = upstream.headers.get("content-type") || "";
      if (!ALLOWED_CONTENT_TYPE.test(contentType)) {
        // The host served something that is not a picture. Serving it onward
        // from our origin is exactly how a proxy becomes an XSS vector.
        return res.status(415).json({ error: "IMAGE_TYPE_REFUSED" });
      }

      const declared = Number(upstream.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_BYTES) {
        return res.status(413).json({ error: "IMAGE_TOO_LARGE" });
      }

      const buffer = Buffer.from(await upstream.arrayBuffer());
      // Re-check after the fact: content-length is a claim, not a guarantee.
      if (buffer.byteLength > MAX_BYTES) {
        return res.status(413).json({ error: "IMAGE_TOO_LARGE" });
      }

      res.setHeader("Content-Type", contentType.split(";")[0].trim());
      res.setHeader("Content-Length", String(buffer.byteLength));
      // Private: this is one student's screen, not shared content. The max-age
      // matches the token TTL so a cached tile never outlives its URL.
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.setHeader("X-Content-Type-Options", "nosniff");
      // Belt and braces against the "what if it is really an HTML document"
      // case the content-type check above already covers.
      res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      return res.send(buffer);
    } catch (error: any) {
      const aborted = error?.name === "AbortError";
      console.error("[PictureSearchController] proxy error:", aborted ? "timeout" : error);
      return res.status(504).json({ error: "IMAGE_FETCH_FAILED" });
    } finally {
      clearTimeout(timer);
    }
  }
}

export const pictureSearchController = new PictureSearchController();
