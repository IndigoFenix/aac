// The unified world-bubble channel: one entry point (showWorldBubble) for both a
// remote player's utterance (via setAvatarSpeech) and an in-game character/caption.
// Pure state logic, no GL — safe in the default `npm test`.

import { describe, it, expect } from "@jest/globals";
import {
  addLocalAvatar,
  clearWorldBubble,
  createWorldState,
  removeAvatar,
  setAvatarSpeech,
  showWorldBubble,
} from "@shared/world-engine/engine.js";
import { bubbleAlpha } from "@shared/world-engine/speech-bubble.js";
import type { WorldSpec } from "@shared/world-engine/types.js";

function spec(): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: 20, height: 20 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 5, y: 5 }],
    objects: [],
    multiplayer: { maxPlayers: 4, authority: "distributed" },
    content: { kind: "sandbox" },
  };
}

describe("world-engine unified bubbles", () => {
  it("starts with no bubbles", () => {
    expect(createWorldState(spec(), "me")).toMatchObject({ bubbles: {} });
  });

  it("shows a point-anchored bubble (an in-game character/caption)", () => {
    const s = createWorldState(spec(), "me");
    s.time = 3;
    showWorldBubble(s, "demo:caption", {
      anchor: { kind: "point", x: 8, y: 9 },
      text: "big",
      glyph: "big",
      ttl: 5,
    });
    expect(s.bubbles["demo:caption"]).toEqual({
      anchor: { kind: "point", x: 8, y: 9 },
      text: "big",
      glyph: "big",
      at: 3,
      ttl: 5,
    });
  });

  it("re-using a key replaces in place; blank text clears it", () => {
    const s = createWorldState(spec(), "me");
    showWorldBubble(s, "k", { anchor: { kind: "point", x: 0, y: 0 }, text: "one" });
    showWorldBubble(s, "k", { anchor: { kind: "point", x: 1, y: 1 }, text: "two" });
    expect(s.bubbles["k"].text).toBe("two");
    showWorldBubble(s, "k", { anchor: { kind: "point", x: 0, y: 0 }, text: "  " });
    expect(s.bubbles["k"]).toBeUndefined();
    showWorldBubble(s, "k", { anchor: { kind: "point", x: 0, y: 0 }, text: "again" });
    clearWorldBubble(s, "k");
    expect(s.bubbles["k"]).toBeUndefined();
  });

  it("routes avatar speech through the SAME channel (avatar anchor)", () => {
    const s = createWorldState(spec(), "me");
    addLocalAvatar(s, "peer", 4, 4);
    setAvatarSpeech(s, "peer", { text: "hi", glyph: "wave" });
    expect(s.bubbles["speech:peer"]).toMatchObject({
      anchor: { kind: "avatar", id: "peer" },
      text: "hi",
      glyph: "wave",
    });
    // Clearing speech removes the bubble; an unknown avatar is a no-op.
    setAvatarSpeech(s, "peer", null);
    expect(s.bubbles["speech:peer"]).toBeUndefined();
    setAvatarSpeech(s, "ghost", { text: "x" });
    expect(s.bubbles["speech:ghost"]).toBeUndefined();
  });

  it("removing an avatar drops its speech bubble", () => {
    const s = createWorldState(spec(), "me");
    addLocalAvatar(s, "peer", 4, 4);
    setAvatarSpeech(s, "peer", { text: "bye" });
    removeAvatar(s, "peer");
    expect(s.bubbles["speech:peer"]).toBeUndefined();
  });

  it("bubbleAlpha respects a custom ttl", () => {
    expect(bubbleAlpha(0, 0, 5)).toBe(1); // just shown
    expect(bubbleAlpha(0, 3.9, 5)).toBe(1); // before the 1s fade window
    expect(bubbleAlpha(0, 5, 5)).toBe(0); // expired
    expect(bubbleAlpha(0, 4.5, 5)).toBeCloseTo(0.5, 5); // mid fade
  });
});
