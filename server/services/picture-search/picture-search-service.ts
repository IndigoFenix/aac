// server/services/picture-search/picture-search-service.ts
//
// Policy → provider → proxy URLs, in that order, behind one call.
//
// The whole search runs SERVER-side before anything opens on the device, for the
// same reason `resolvePhotoRequest` does (photo-context.ts): the assistant must
// learn what is actually on screen BEFORE it starts talking about it. If the
// client searched, the Speaker would be free to narrate a giraffe while the
// device showed six pictures of a crane.
//
// Every outcome other than `ok` is a first-class result, not an error, and each
// one gets its own sentence injected into the Speaker's context. "I couldn't
// find that" said plainly is a good turn; a confident description of a picture
// that never loaded is not.

import {
  blockedTermFor,
  normalizeSearchQuery,
  type PictureSearchConfig,
  type PictureSearchResult,
} from "@shared/picture-search";
import { imageProxyPath } from "./image-proxy-token";
import { hitIsUsable, isPictureSearchConfigured, searchImages, type RawImageHit } from "./picture-search-provider";

export type PictureSearchOutcome =
  /** Pictures found and ready to show. */
  | { kind: "ok"; query: string; results: PictureSearchResult[] }
  /** The clinician has not enabled picture search for this student. */
  | { kind: "disabled" }
  /** Enabled, but the platform has no search credentials configured. */
  | { kind: "unavailable" }
  /** The query tripped a blocked term (baseline or clinician-authored). */
  | { kind: "blocked"; term: string }
  /** Nothing searchable was left after normalization. */
  | { kind: "bad_query" }
  /** The search ran and returned nothing we would show. */
  | { kind: "no_results"; query: string };

/** Hostname without a leading www., for showing a student where a picture came
 *  from. Falls back to the raw string rather than throwing on a malformed URL. */
export function sourceDomainOf(hit: RawImageHit): string {
  const raw = hit.contextLink || hit.link;
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Turn vetted hits into the client payload, dropping any whose URLs we cannot
 *  sign (over-length or non-http) rather than shipping a half-proxied result. */
export function toResults(hits: readonly RawImageHit[], now: number = Date.now()): PictureSearchResult[] {
  const results: PictureSearchResult[] = [];
  for (const [index, hit] of hits.entries()) {
    const displayPath = imageProxyPath(hit.link, now);
    if (!displayPath) continue;
    // Fall back to the full image when the provider gave no thumbnail — a
    // slightly heavy grid beats a broken tile.
    const thumbPath = (hit.thumbnailLink && imageProxyPath(hit.thumbnailLink, now)) || displayPath;
    results.push({
      id: `pic-${index}`,
      title: hit.title,
      sourceDomain: sourceDomainOf(hit),
      width: hit.width,
      height: hit.height,
      thumbPath,
      displayPath,
    });
  }
  return results;
}

/**
 * Run a picture search for a student, applying their settings.
 *
 * `language` is the session language, passed through to the provider so a
 * Hebrew or Arabic query is answered in kind.
 */
export async function runPictureSearch(input: {
  query: string | null | undefined;
  config: PictureSearchConfig;
  language?: string;
}): Promise<PictureSearchOutcome> {
  const { config, language } = input;

  if (!config.enabled) return { kind: "disabled" };
  if (!isPictureSearchConfigured()) return { kind: "unavailable" };

  const query = normalizeSearchQuery(input.query);
  if (!query) return { kind: "bad_query" };

  const blocked = blockedTermFor(query, config.blockedTerms);
  if (blocked) return { kind: "blocked", term: blocked };

  const hits = (await searchImages(query, config, language))
    .filter(hitIsUsable)
    .slice(0, config.maxResults);

  const results = toResults(hits);
  if (results.length === 0) return { kind: "no_results", query };
  return { kind: "ok", query, results };
}

/**
 * What the Speaker is told when a search did not put pictures on screen.
 *
 * One rule shapes all of these: say what happened, then hand the turn back.
 * The assistant must never fill the gap by describing the picture it expected,
 * because a student who cannot contradict it would be left believing they had
 * seen something they never saw.
 *
 * The `blocked` wording deliberately does NOT name the term that fired. Naming
 * it invites the assistant to repeat it back — "I can't show you pictures of
 * guns" — which is exactly the phrase a clinician blocked the word to avoid.
 * The term is logged server-side instead, where a clinician can find it.
 */
export function pictureSearchFailureNote(
  outcome: Exclude<PictureSearchOutcome, { kind: "ok" }>,
  requested?: string,
): string {
  switch (outcome.kind) {
    case "disabled":
      return `[APP OPEN FAILED] Picture search is turned off for this user — say you cannot look up pictures, warmly and briefly, and move on. Do NOT promise to enable it.`;
    case "unavailable":
      return `[APP OPEN FAILED] Picture search is not working right now — say you cannot look pictures up at the moment and suggest something else.`;
    case "blocked":
      return `[APP OPEN FAILED] That is not something you can show pictures of. Do not explain why, do not repeat the words back, and do not try a different wording. Acknowledge briefly and gently steer to something else.`;
    case "bad_query":
      return `[APP OPEN FAILED] No searchable words were given for the picture search — ask the user what they would like to see a picture of, then call open_app("picture_search", "<what they said>").`;
    case "no_results":
      return `[PICTURES] The web search for "${outcome.query}" found nothing to show. Say plainly that you could not find a picture of that — do NOT describe one — and offer to look for something else.`;
    default: {
      // Exhaustiveness: a new outcome kind must not silently reach the student
      // as a promise the search kept.
      const _never: never = outcome;
      return `[APP OPEN FAILED] The picture search did not work${requested ? ` for "${requested}"` : ""} — say so and suggest something else.`;
    }
  }
}
