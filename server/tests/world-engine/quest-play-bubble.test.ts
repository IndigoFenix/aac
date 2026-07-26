// The over-head activity bubble for PLAY must show the project's REGISTERED
// "play" glyph ARTWORK (imagePath actions/body/play) — routed through the
// bubble's composed-glyph channel — not a raw dice/emoji. The routing is
// general (any activity naming an art-bearing glyph uses it), with an emoji
// fallback for activities that have no registered art. See quest-host
// activityBubbleContent / restDoneBubble.
import { describe, it, expect } from "@jest/globals";
import { activityBubbleContent, restDoneBubble } from "@shared/world-engine/interaction/quest/activity-bubble";
import { getVocabularyItem } from "@shared/glyph-registry";

describe("play activity bubble", () => {
  it("the registered play glyph still carries its bundled artwork", () => {
    // The invariant the bubble routing depends on: strip the imagePath and the
    // bubble silently regresses to the emoji fallback.
    expect(getVocabularyItem("play")?.imagePath).toBe("actions/body/play");
  });

  it("routes an art-bearing activity through the glyph (no emoji)", () => {
    const c = activityBubbleContent("play", "🎮");
    expect(c.glyph).toBe("play"); // the composed-glyph image path
    expect(c.text).toBe(""); // no emoji row
  });

  it("falls back to the emoji when the activity names no glyph", () => {
    const c = activityBubbleContent(undefined, "💤");
    expect(c.glyph).toBeUndefined();
    expect(c.text).toBe("💤");
  });

  it("falls back to the emoji when the glyph has no artwork", () => {
    // "sleep" is registered but emoji-only (no imagePath) — must not route to a
    // blank/art-less glyph; it keeps its emoji.
    expect(getVocabularyItem("sleep")?.imagePath).toBeUndefined();
    const c = activityBubbleContent("sleep", "😴");
    expect(c.glyph).toBeUndefined();
    expect(c.text).toBe("😴");
  });

  it("the completed FUN rest shows the play glyph, not a dice emoji", () => {
    const done = restDoneBubble("fun");
    expect(done.glyph).toBe("play");
    expect(done.text).toBe("");
  });

  it("other completed rests keep their glanceable emoji", () => {
    expect(restDoneBubble("waste")).toEqual({ text: "🚽" });
    expect(restDoneBubble("hygiene")).toEqual({ text: "🫧" });
    expect(restDoneBubble("energy")).toEqual({ text: "💤" });
  });
});
