// The DOLLHOUSE family HUD (shared/world-engine/interaction/quest/family-hud.ts):
// the emoji priority ladder that turns one member's live signals into its ONE
// chip state — plus the spoken self-care commands ("you eat" / "you sleep")
// that compile to the `satisfy` goal the host routes into the need machinery.
//
// Pure logic — no DB / LLM / GL — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import { familyStateOf, familyStateGlyph, type FamilySignals } from "@shared/world-engine/interaction/quest/family-hud.js";
import { iconGlyph } from "@shared/world-engine/interaction/quest/activity-bubble.js";
import { wellbeingGlyph, wellbeingEmoji } from "@shared/world-engine/interaction/quest/city-hud.js";
import { getVocabularyItem } from "@shared/glyph-registry.js";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import { compileIntent, defaultBinder } from "@shared/world-engine/interaction/intent/intent-compile.js";

const sig = (over: Partial<FamilySignals>): FamilySignals => ({
  commanded: false,
  step: null,
  hungry: false,
  thirsty: false,
  toilet: false,
  tired: false,
  lonely: false,
  dirty: false,
  scruffy: false,
  bored: false,
  away: null,
  ...over,
});

describe("family HUD — the emoji priority ladder", () => {
  it("is content when nothing fires", () => {
    expect(familyStateOf(sig({}))).toEqual({ emoji: "😊", state: "content" });
  });

  it("shows a running spoken command above everything", () => {
    expect(familyStateOf(sig({ commanded: true, hungry: true, away: "shift" })).state).toBe("commanded");
  });

  it("names the motive an active need step is serving", () => {
    expect(familyStateOf(sig({ step: { tplKey: "hunger:food", resting: false } })).state).toBe("hungry");
    expect(familyStateOf(sig({ step: { tplKey: "energy", resting: false } })).state).toBe("tired");
    expect(familyStateOf(sig({ step: { tplKey: "energy", resting: true } }))).toEqual({
      emoji: "💤",
      state: "asleep",
    });
    expect(familyStateOf(sig({ step: { tplKey: "social", resting: false } })).state).toBe("lonely");
    expect(familyStateOf(sig({ step: { tplKey: "fun", resting: false } })).state).toBe("bored");
    expect(familyStateOf(sig({ step: { tplKey: "fun", resting: true } }))).toEqual({
      emoji: "🎮", // the project's registered "play" glyph icon (not the ⚽ ball item)
      state: "playing",
    });
    expect(familyStateOf(sig({ step: { tplKey: "provision:food", resting: false } })).state).toBe("errand");
  });

  it("orders firing meters hunger > energy > social > fun (the walker's own order)", () => {
    expect(familyStateOf(sig({ hungry: true, tired: true, lonely: true, bored: true })).state).toBe("hungry");
    expect(familyStateOf(sig({ tired: true, lonely: true, bored: true })).state).toBe("tired");
    expect(familyStateOf(sig({ lonely: true, bored: true })).state).toBe("lonely");
    expect(familyStateOf(sig({ bored: true }))).toEqual({ emoji: "🧸", state: "bored" });
  });

  it("shows clock absences only when no need fires", () => {
    expect(familyStateOf(sig({ away: "shift" })).state).toBe("working");
    expect(familyStateOf(sig({ away: "shopping" })).state).toBe("errand");
    expect(familyStateOf(sig({ hungry: true, away: "shift" })).state).toBe("hungry");
  });
});

// Every chip renders through the GLYPH system (the compositor), never a raw
// text-node emoji: a state with bundled ARTWORK resolves to that glyph's KEY
// (its image shows); a state without art passes its emoji through unchanged so
// the compositor still draws it. `familyStateGlyph(state, emoji)` is the shared
// resolver the presenter hands to the GlyphCompositor.
describe("family HUD — state → glyph resolution (every icon through the symbol system)", () => {
  it("routes art-bearing states to their REGISTERED glyph key (the art shows)", () => {
    // These keys carry `imagePath` artwork — resolving to the key makes the chip
    // draw the composed glyph image, exactly like the over-head bubbles.
    for (const [state, key] of [
      ["commanded", "run"],
      ["hungry", "eat"],
      ["playing", "play"],
      ["lonely", "lonely"],
      ["dirty", "dirty"],
      ["tidying", "clean"],
      // `go`, not `walk` — walk left the registry 2026-08-20 as a synonym of
      // go, which still wears its artwork. The second assertion below is the
      // one that caught it: an unregistered key here does not throw, it
      // silently falls back to the entry's emoji and the chip loses its art.
      ["away", "go"],
    ] as const) {
      const { emoji } = familyStateOf(sig({})); // emoji unused for mapped states
      expect(familyStateGlyph(state, emoji)).toBe(key);
      expect(getVocabularyItem(key)?.imagePath).toBeTruthy();
    }
  });

  it("maps art-less states to a registered key so a future icon auto-upgrades", () => {
    for (const [state, key] of [
      ["thirsty", "drink"],
      ["toilet", "bathroom"],
      ["tired", "tired"],
      ["dressing", "wear"],
      ["content", "happy"],
    ] as const) {
      expect(familyStateGlyph(state, "🙂")).toBe(key);
      expect(getVocabularyItem(key)).toBeTruthy();
    }
  });

  it("passes an unmapped state's own emoji THROUGH the compositor (no bare text node)", () => {
    // No registered glyph → the resolver returns the entry emoji, which the
    // compositor still renders through its own image/text path (not a <span>).
    expect(familyStateGlyph("asleep", "💤")).toBe("💤");
    expect(familyStateGlyph("bored", "🧸")).toBe("🧸");
    expect(familyStateGlyph("errand", "🧺")).toBe("🧺");
    // A per-entry emoji the state ladder never sets (founding ⛺, commanded 🏃
    // guest) survives — the resolver keys off the state, never overrides it.
    expect(familyStateGlyph("guest", "⛺")).toBe("⛺");
    expect(familyStateGlyph("guest", "🏃")).toBe("🏃");
  });

  it("iconGlyph prefers a registered key, else the raw emoji", () => {
    expect(iconGlyph("play", "🎮")).toBe("play"); // registered → key
    expect(iconGlyph("not_a_glyph", "🎈")).toBe("🎈"); // unregistered → emoji
    expect(iconGlyph(undefined, "🎈")).toBe("🎈");
  });

  it("the city wellbeing face resolves the same way (content → happy glyph, else emoji)", () => {
    expect(iconGlyph(wellbeingGlyph(0.9), wellbeingEmoji(0.9))).toBe("happy");
    expect(iconGlyph(wellbeingGlyph(0.5), wellbeingEmoji(0.5))).toBe("😐");
    expect(iconGlyph(wellbeingGlyph(0.1), wellbeingEmoji(0.1))).toBe("😫");
  });
});

describe("self-care commands — 'you eat' / 'you sleep' compile to satisfy goals", () => {
  const binder = defaultBinder({ player: "player", listener: "resident_3_1" });
  const compile = (sentence: string) =>
    compileIntent(parseSentence(sentence), binder, { id: "t" });

  it("compiles the bare self-need verbs to satisfy goals on the listener", () => {
    for (const [sentence, need] of [
      ["you + eat", "eat"],
      ["you + sleep", "sleep"],
      ["you + play", "play"],
      ["you + talk", "talk"],
      ["eat", "eat"],
    ] as const) {
      const out = compile(sentence);
      expect(out.kind).toBe("goal");
      if (out.kind === "goal") {
        expect(out.goal).toEqual({ kind: "satisfy", need });
        expect(out.actor).toBe("resident_3_1");
      }
    }
  });
});

describe("family HUD — round-2 states (thirst / waste / hygiene / tidy / adoption / stress)", () => {
  it("names the new motives an active step serves", () => {
    expect(familyStateOf(sig({ step: { tplKey: "thirst:water", resting: false } }))).toEqual({
      emoji: "🥤",
      state: "thirsty",
    });
    expect(familyStateOf(sig({ step: { tplKey: "waste", resting: false } }))).toEqual({
      emoji: "🚽",
      state: "toilet",
    });
    expect(familyStateOf(sig({ step: { tplKey: "hygiene", resting: false } })).state).toBe("dirty");
    expect(familyStateOf(sig({ step: { tplKey: "hygiene", resting: true } }))).toEqual({
      emoji: "🫧",
      state: "washing",
    });
    expect(familyStateOf(sig({ step: { tplKey: "tidy", resting: false } }))).toEqual({
      emoji: "🧹",
      state: "tidying",
    });
    expect(familyStateOf(sig({ step: { tplKey: "adopt:pet_0_0|hunger:food", resting: false } }))).toEqual({
      emoji: "🤝",
      state: "helping",
    });
  });

  it("orders firing meters hunger > thirst > toilet > energy > social > hygiene > fun", () => {
    const all = { hungry: true, thirsty: true, toilet: true, tired: true, lonely: true, dirty: true, bored: true };
    expect(familyStateOf(sig(all)).state).toBe("hungry");
    expect(familyStateOf(sig({ ...all, hungry: false })).state).toBe("thirsty");
    expect(familyStateOf(sig({ ...all, hungry: false, thirsty: false })).state).toBe("toilet");
    expect(familyStateOf(sig({ ...all, hungry: false, thirsty: false, toilet: false })).state).toBe("tired");
    expect(familyStateOf(sig({ tired: false, lonely: false, dirty: true, bored: true })).state).toBe("dirty");
  });

  it("derived stress shows only when NOTHING else claims the chip", () => {
    expect(familyStateOf(sig({ stressed: true }))).toEqual({ emoji: "😟", state: "stressed" });
    expect(familyStateOf(sig({ stressed: true, hungry: true })).state).toBe("hungry");
    expect(familyStateOf(sig({ stressed: true, away: "shift" })).state).toBe("working");
  });
});

describe("family HUD — round-3 clothing states (dress / laundry)", () => {
  it("names the clothing steps: dressing to the wardrobe, laundering to the tub", () => {
    expect(familyStateOf(sig({ step: { tplKey: "dress", resting: false } }))).toEqual({
      emoji: "👕",
      state: "dressing",
    });
    expect(familyStateOf(sig({ step: { tplKey: "laundry", resting: false } }))).toEqual({
      emoji: "🧼",
      state: "laundering",
    });
    // The put-away trip (stow) reads as the generic supply errand.
    expect(familyStateOf(sig({ step: { tplKey: "stow:clothing", resting: false } })).state).toBe("errand");
  });

  it("a fired dress meter (scruffy) slots between tired and lonely — the walker's order", () => {
    expect(familyStateOf(sig({ tired: true, scruffy: true, lonely: true })).state).toBe("tired");
    expect(familyStateOf(sig({ scruffy: true, lonely: true, dirty: true }))).toEqual({
      emoji: "👕",
      state: "dressing",
    });
    expect(familyStateOf(sig({ lonely: true, dirty: true })).state).toBe("lonely");
  });

  it("'you wear' compiles to a satisfy goal like the other self-care verbs", () => {
    const binder = defaultBinder({ player: "player", listener: "resident_3_1" });
    const out = compileIntent(parseSentence("you + wear"), binder, { id: "t" });
    expect(out.kind).toBe("goal");
    if (out.kind === "goal") {
      expect(out.goal).toEqual({ kind: "satisfy", need: "wear" });
      expect(out.actor).toBe("resident_3_1");
    }
  });
});
