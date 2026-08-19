/**
 * Query → photo matching (shared/photo-match.ts) — used by the server to
 * resolve `show_photo(query)` and by the AAC app for a raw query.
 *
 * The stakes here are not "did we find the best photo" — they are "did we put
 * the WRONG relative on screen". When the assistant calls
 * `open_app("photos", "grandma")` and nothing matches, opening a near-miss lets
 * the assistant talk confidently about the wrong person to a student who cannot
 * correct it. So the behaviour these lock in is: match exactly, or not at all.
 *
 * See planning-docs/aac-photos-plan.md §6 and §8.
 */

import { describe, it, expect } from "@jest/globals";
import { matchPhoto, type MatchablePhoto } from "@shared/photo-match";

const photo = (caption: string | null, aiDescription: string | null = null): MatchablePhoto => ({
  caption,
  aiDescription,
});

describe("matchPhoto", () => {
  const library = [
    photo("Grandma at my birthday"),
    photo("Rex the dog"),
    photo(null, "a beach with waves"),
    photo("Dad"),
  ];

  it("returns null for an absent query, so the student browses instead", () => {
    expect(matchPhoto(library, undefined)).toBeNull();
    expect(matchPhoto(library, null)).toBeNull();
    expect(matchPhoto(library, "")).toBeNull();
    expect(matchPhoto(library, "   ")).toBeNull();
  });

  it("returns null when nothing matches rather than guessing a near-miss", () => {
    // The whole point: no fuzzy fallback. "grandpa" must NOT open "Grandma".
    expect(matchPhoto(library, "grandpa")).toBeNull();
    expect(matchPhoto(library, "the cat")).toBeNull();
  });

  it("matches a caption case-insensitively", () => {
    expect(matchPhoto(library, "REX THE DOG")?.caption).toBe("Rex the dog");
  });

  it("matches a fragment of a caption", () => {
    expect(matchPhoto(library, "grandma")?.caption).toBe("Grandma at my birthday");
  });

  it("prefers an exact caption over a containment match elsewhere", () => {
    const photos = [
      photo("Dad and Rex at the park"), // contains "dad"
      photo("Dad"),                     // exactly "dad"
    ];
    expect(matchPhoto(photos, "Dad")?.caption).toBe("Dad");
  });

  it("prefers a caption over an AI description", () => {
    // A caretaker wrote the caption; aiDescription is a machine guess.
    const photos = [
      photo(null, "a birthday party with grandma"),
      photo("Grandma"),
    ];
    expect(matchPhoto(photos, "grandma")?.caption).toBe("Grandma");
  });

  it("falls back to the AI description only when no caption matches", () => {
    expect(matchPhoto(library, "beach")?.aiDescription).toBe("a beach with waves");
  });

  it("tolerates a library where everything is uncaptioned", () => {
    const photos = [photo(null), photo(null)];
    expect(matchPhoto(photos, "grandma")).toBeNull();
  });

  it("trims surrounding whitespace on both sides of the comparison", () => {
    const photos = [photo("  Dad  ")];
    expect(matchPhoto(photos, " dad ")?.caption).toBe("  Dad  ");
  });

  it("returns null for an empty library", () => {
    expect(matchPhoto([], "grandma")).toBeNull();
  });
});
