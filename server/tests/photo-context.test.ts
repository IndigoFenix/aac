/**
 * The photo digest that reaches the Speaker's system prompt
 * (server/services/photos/photo-context.ts).
 *
 * Two things are being protected here, and they pull against each other:
 *
 *  • TOKEN COST. This block is built for every session of every student who has
 *    photos. A student at the 200-photo ceiling must not add a thousand tokens
 *    to every prompt, so the caption list is capped and each caption truncated.
 *  • USABILITY. The assistant can only ask for a photo it knows exists, because
 *    `open_app("photos", query)` matches against exactly these caption strings.
 *    Summarising them away would make the query path dead on arrival.
 *
 * Plus the safety property: uncaptioned photos are COUNTED, never described, so
 * the prompt can warn the assistant off naming who is in them.
 *
 * See planning-docs/aac-photos-plan.md §8.
 */

import { describe, it, expect } from "@jest/globals";
import { summarizePhotos } from "../services/photos/photo-context.js";
import type { LibraryPhoto } from "../repositories/photoRepository.js";

function photo(caption: string | null, i = 0): LibraryPhoto {
  return {
    assignmentId: `a${i}`,
    photoId: `p${i}`,
    caption,
    sortOrder: i,
    hiddenFromStudent: false,
    s3Key: `photos/p${i}/d.webp`,
    thumbS3Key: `photos/p${i}/t.webp`,
    width: 1024,
    height: 768,
    aiDescription: null,
    takenAt: null,
    scope: "student",
  };
}

describe("summarizePhotos", () => {
  it("counts every photo, captioned or not", () => {
    const out = summarizePhotos([photo("Mum", 0), photo(null, 1), photo("Rex", 2)]);
    expect(out.count).toBe(3);
    expect(out.uncaptionedCount).toBe(1);
  });

  it("lists captions verbatim so the query path can match them", () => {
    // The assistant calls open_app("photos", "<words from a caption>"), which is
    // matched against these exact strings. Paraphrasing here would break it.
    const out = summarizePhotos([photo("Grandma at my birthday", 0), photo("Rex the dog", 1)]);
    expect(out.captions).toEqual(["Grandma at my birthday", "Rex the dog"]);
  });

  it("caps the caption list and flags the truncation", () => {
    const many = Array.from({ length: 40 }, (_, i) => photo(`Photo ${i}`, i));
    const out = summarizePhotos(many);
    expect(out.count).toBe(40);
    expect(out.captions).toHaveLength(12);
    expect(out.truncated).toBe(true);
  });

  it("does not flag truncation when everything fits", () => {
    const out = summarizePhotos([photo("Mum", 0), photo("Dad", 1)]);
    expect(out.truncated).toBe(false);
  });

  it("truncates a very long caption rather than letting it run", () => {
    const long = "A".repeat(200);
    const out = summarizePhotos([photo(long, 0)]);
    expect(out.captions[0].length).toBeLessThanOrEqual(48);
    expect(out.captions[0].endsWith("…")).toBe(true);
  });

  it("keeps the prompt cost bounded even at the 200-photo ceiling", () => {
    // Both scope caps full, every caption at the truncation limit.
    const worst = Array.from({ length: 200 }, (_, i) => photo("X".repeat(80), i));
    const out = summarizePhotos(worst);
    const rendered = out.captions.join(", ");
    // 12 captions x ~48 chars — a few hundred characters, not thousands.
    expect(rendered.length).toBeLessThan(700);
  });

  it("never puts an uncaptioned photo's placeholder in the caption list", () => {
    // Uncaptioned photos must be counted only. Emitting a stand-in like
    // "(no caption)" would let the assistant match a query against it and then
    // talk about a photo nobody described.
    const out = summarizePhotos([photo(null, 0), photo(null, 1), photo("Dad", 2)]);
    expect(out.captions).toEqual(["Dad"]);
    expect(out.uncaptionedCount).toBe(2);
  });

  it("treats a whitespace-only caption as no caption", () => {
    const out = summarizePhotos([photo("   ", 0)]);
    expect(out.captions).toEqual([]);
    expect(out.uncaptionedCount).toBe(1);
  });

  it("handles an empty library", () => {
    const out = summarizePhotos([]);
    expect(out).toEqual({ count: 0, captions: [], truncated: false, uncaptionedCount: 0 });
  });
});
