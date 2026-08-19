// shared/photo-match.ts
//
// ONE definition of "which photo does this query mean", used by BOTH sides: the
// server resolves `show_photo(query)` here before opening anything, and the AAC
// app resolves a raw `open_app("photos", data)` query here. Two copies would
// drift, and the failure mode of drift is the assistant announcing one photo
// while the device shows another.
//
// Pure and dependency-free so it runs under the server jest config.
//
// See planning-docs/aac-photos-plan.md §6 and §8.

export interface MatchablePhoto {
  caption: string | null;
  aiDescription: string | null;
}

/**
 * The photo an AI-supplied query means, or null when nothing is a confident
 * match.
 *
 * Returning NULL IS A NORMAL, GOOD OUTCOME. When the assistant says
 * `open_app("photos", "grandma")` and no caption mentions grandma, opening the
 * nearest-looking photo would put the wrong relative on screen and invite the
 * assistant to talk about them as if they were right — to a student who has no
 * way to correct it. Falling back to the browser and letting the student choose
 * is strictly better. Everything here is therefore an exact or containment test;
 * there is deliberately no fuzzy scoring.
 *
 * Order: exact caption, then caption containment, then the AI description.
 * Captions win because a caretaker wrote them; `aiDescription` is a machine
 * guess and only ever a fallback.
 */
export function matchPhoto<T extends MatchablePhoto>(
  photos: readonly T[],
  query: string | undefined | null,
): T | null {
  const q = query?.trim().toLowerCase();
  if (!q) return null;

  return (
    photos.find((p) => p.caption?.trim().toLowerCase() === q) ??
    photos.find((p) => p.caption?.toLowerCase().includes(q)) ??
    photos.find((p) => p.aiDescription?.toLowerCase().includes(q)) ??
    null
  );
}
