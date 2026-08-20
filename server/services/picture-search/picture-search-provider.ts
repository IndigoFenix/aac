// server/services/picture-search/picture-search-provider.ts
//
// The upstream image-search seam. PIXABAY since 2026-08-19 — Google removed
// "search the entire web" from new Programmable Search Engines on 2026-01-20
// (existing engines die 2027-01-01), and Bing's search APIs were retired in
// 2025, so the classic web image APIs are gone. Pixabay is the deliberate
// replacement, not a compromise: a moderated stock library with an all-ages
// SafeSearch flag is a BETTER source than the open web for a special-needs
// AAC — the student asks for "an owl", not for news photos.
//
// Provider contract kept from the CSE version so everything downstream
// (service, proxy, client) is untouched:
//   - `RawImageHit` is the neutral shape; `mapPixabayHit` produces it.
//   - `safesearch=true` on every request, always. No setting turns it off,
//     because there is no student for whom turning it off is correct.
//   - Queries are expected in ENGLISH — Pixabay's `lang` list has no Hebrew or
//     Arabic, so the registry queryHint tells the model to translate (which an
//     LLM does natively; the session language is irrelevant to the search).
//
// Pixabay terms, and how we meet them (pixabay.com/api/docs/):
//   - Hotlinking is prohibited → the student's device never touches a Pixabay
//     URL; the image proxy fetches server-side and re-serves from our origin.
//   - "Show your users where the images are from" → `contextLink` is the
//     Pixabay page, so the viewer's provenance line reads "From pixabay.com".
//   - API responses should be cached 24h → we run one search per app-open and
//     never poll; the proxy's 1h client cache keeps re-views off their CDN.

import type { PictureSearchConfig } from "@shared/picture-search";

/** One raw result, normalized off the provider's response shape. */
export interface RawImageHit {
  title: string;
  /** The image itself. */
  link: string;
  /** Provider-hosted smaller rendition for the grid. Absent on some results. */
  thumbnailLink: string | null;
  /** Page the image lives on — the source of the displayed domain. */
  contextLink: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
}

/** True when the provider credentials exist. When false the app is not offered
 *  at all — an enabled toggle that always fails is worse than no toggle. */
export function isPictureSearchConfigured(): boolean {
  return !!process.env.PIXABAY_API_KEY;
}

/** Formats we are willing to put in front of a student.
 *  SVG is excluded on purpose: it is a script-capable document, not a picture,
 *  and it would be rendered by the proxy's own origin. (Pixabay serves raster
 *  renditions even for vectors, so this is belt-and-braces here.) */
const ALLOWED_MIME = /^image\/(jpeg|png|gif|webp|bmp)$/i;

/** Below this a picture is a spacer, an icon or a tracking pixel. */
const MIN_DIMENSION = 120;

/**
 * Whether a raw hit is worth showing. Pure — the interesting cases here are
 * missing fields and hostile mime types, and those deserve millisecond tests.
 */
export function hitIsUsable(hit: RawImageHit): boolean {
  if (!hit.link || !/^https:\/\//i.test(hit.link)) return false; // https only: no mixed content, no plaintext leak
  if (hit.mime && !ALLOWED_MIME.test(hit.mime)) return false;
  if (/\.svgz?(\?|$)/i.test(hit.link)) return false;
  // Dimensions are advisory (providers omit them sometimes); only reject
  // when we KNOW the picture is too small to be looked at.
  if (hit.width !== null && hit.width < MIN_DIMENSION) return false;
  if (hit.height !== null && hit.height < MIN_DIMENSION) return false;
  return true;
}

/** Pixabay requires 3 ≤ per_page ≤ 200. */
const PROVIDER_MIN_PER_REQUEST = 3;
const PROVIDER_MAX_PER_REQUEST = 200;

/**
 * Ask for several times what we intend to show.
 *
 * The result-side tag screen (`blockedTagFor`) runs AFTER the provider call, so
 * a search whose popular results are mostly cocktails would otherwise return a
 * grid of two. One request either way — Pixabay bills nothing and `per_page` is
 * free — so the only cost is a slightly larger JSON body.
 */
const OVERFETCH_FACTOR = 4;

const REQUEST_TIMEOUT_MS = 8000;

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * One Pixabay hit → the neutral shape. Exported pure so the field mapping —
 * which rendition goes where — is pinned by tests, not by hope.
 *
 * Renditions: `largeImageURL` (≤1280px) is the viewer image; `webformatURL`
 * (≤640px) is the grid thumbnail — `previewURL` (150px) is too small for the
 * coarse dwell tiles the grid renders. `tags` ("owl, bird, wildlife") stands
 * in for a title; it is what the Speaker will hear quoted, so keep it as-is
 * rather than prettifying.
 */
export function mapPixabayHit(item: any): RawImageHit {
  const display = typeof item?.largeImageURL === "string" ? item.largeImageURL : "";
  const thumb = typeof item?.webformatURL === "string" ? item.webformatURL : null;
  return {
    title: typeof item?.tags === "string" ? item.tags.trim() : "",
    link: display || thumb || "",
    thumbnailLink: thumb,
    contextLink: typeof item?.pageURL === "string" ? item.pageURL : null,
    // Pixabay does not report a mime; URLs are raster renditions.
    mime: null,
    width: num(item?.imageWidth),
    height: num(item?.imageHeight),
  };
}

/**
 * Run one image search. Throws only on a genuinely unexpected failure; a
 * provider error or an empty result set resolves to an empty array, because
 * "nothing found" and "provider is sulking" lead to the same thing being said
 * to the student.
 *
 * `language` is accepted for interface stability but unused: queries arrive in
 * English by prompt contract (see header), which outperforms Pixabay's partial
 * `lang` coverage for our locales.
 */
export async function searchImages(
  query: string,
  config: Pick<PictureSearchConfig, "maxResults">,
  language?: string,
): Promise<RawImageHit[]> {
  void language;
  if (!isPictureSearchConfigured()) return [];

  const params = new URLSearchParams({
    key: process.env.PIXABAY_API_KEY!,
    q: query,
    safesearch: "true",
    per_page: String(
      Math.min(
        PROVIDER_MAX_PER_REQUEST,
        Math.max(PROVIDER_MIN_PER_REQUEST, config.maxResults * OVERFETCH_FACTOR),
      ),
    ),
    // Photos AND illustrations/vectors: clip-art answers "what does an owl
    // look like" just as well for this audience, and doubles the recall.
    image_type: "all",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`https://pixabay.com/api/?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[picture-search] provider returned ${res.status}`);
      return [];
    }
    const data = (await res.json()) as { hits?: any[] };
    return (data.hits ?? []).map(mapPixabayHit);
  } catch (error) {
    console.error("[picture-search] provider request failed:", error);
    return [];
  } finally {
    clearTimeout(timer);
  }
}
