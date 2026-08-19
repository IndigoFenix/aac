// server/services/photos/photo-context.ts
//
// What the AI is allowed to know about a student's photo library, and how a
// query becomes a specific photo. See planning-docs/aac-photos-plan.md §8.
//
// Two jobs, deliberately together:
//   1. A COMPACT session-prompt line, so the assistant knows which photos exist
//      without the whole library being pasted into every session.
//   2. Server-side RESOLUTION of `open_app("photos", query)`, so the assistant
//      learns whether the photo it named actually exists BEFORE it starts
//      talking about it.
//
// Why the prompt carries captions rather than a vague "subjects" summary: the
// assistant can only sensibly ask for a photo it knows about. A line reading
// "47 photos" and nothing else makes the query path unusable; the captions ARE
// the subjects, and a caretaker already wrote them for exactly this purpose.

import { photoRepository, type LibraryPhoto } from "../../repositories/photoRepository";
import { instituteRepository } from "../../repositories/instituteRepository";
import { matchPhoto } from "@shared/photo-match";

/** How many captions reach the system prompt. The cap is a token budget, not a
 *  display limit — a student at the 200-photo ceiling would otherwise add ~1500
 *  tokens to every single session. */
const MAX_PROMPT_CAPTIONS = 12;

/** Longest caption fragment quoted in the prompt. */
const MAX_CAPTION_CHARS = 48;

export interface PhotoLibrarySummary {
  /** Total photos the student can actually see (hidden ones already excluded). */
  count: number;
  /** Captions, truncated, in display order. May be shorter than `count`. */
  captions: string[];
  /** True when `captions` does not cover the whole library. */
  truncated: boolean;
  /** Photos with no caption at all — the assistant must not name what is in these. */
  uncaptionedCount: number;
}

/** Every photo the student's device would show, in display order. */
export async function loadStudentPhotos(studentId: string): Promise<LibraryPhoto[]> {
  const enrollments = await instituteRepository.getInstitutesByStudentId(studentId);
  const instituteIds = enrollments
    .map((e: any) => e.institute?.id)
    .filter((id: string | undefined): id is string => !!id);
  return photoRepository.listForStudentView(studentId, instituteIds);
}

/** Condense a library into what the prompt should carry. Pure, so the token
 *  shape is testable without a database. */
export function summarizePhotos(photos: readonly LibraryPhoto[]): PhotoLibrarySummary {
  const captioned = photos.filter((p) => !!p.caption?.trim());
  const captions = captioned
    .slice(0, MAX_PROMPT_CAPTIONS)
    .map((p) => {
      const caption = p.caption!.trim();
      return caption.length > MAX_CAPTION_CHARS
        ? `${caption.slice(0, MAX_CAPTION_CHARS - 1)}…`
        : caption;
    });

  return {
    count: photos.length,
    captions,
    truncated: captioned.length > captions.length,
    uncaptionedCount: photos.length - captioned.length,
  };
}

/** Load and summarize in one step — what session startup calls. */
export async function buildPhotoLibrarySummary(
  studentId: string,
): Promise<PhotoLibrarySummary | undefined> {
  try {
    const photos = await loadStudentPhotos(studentId);
    if (photos.length === 0) return undefined;
    return summarizePhotos(photos);
  } catch (error) {
    // A photo-library failure must never block a session from starting.
    console.error("[photos] could not build library summary:", error);
    return undefined;
  }
}

export type PhotoResolution =
  | { kind: "match"; photoId: string; caption: string | null }
  | { kind: "no_match"; libraryCount: number }
  | { kind: "browse"; libraryCount: number }
  | { kind: "empty" };

/**
 * Resolve what `open_app("photos", query)` should actually put on screen.
 *
 * `no_match` is a first-class outcome, not an error: the app still opens in
 * browse mode, but the assistant is told plainly that the photo it asked for was
 * not found, so it cannot narrate a photo that is not there. Silently opening
 * the nearest-looking picture would let it describe the wrong relative with full
 * confidence to a student who has no way to object.
 */
export async function resolvePhotoRequest(
  studentId: string,
  query: string | undefined,
): Promise<PhotoResolution> {
  const photos = await loadStudentPhotos(studentId);
  if (photos.length === 0) return { kind: "empty" };
  if (!query?.trim()) return { kind: "browse", libraryCount: photos.length };

  const match = matchPhoto(photos, query);
  if (!match) return { kind: "no_match", libraryCount: photos.length };
  return { kind: "match", photoId: match.photoId, caption: match.caption };
}
