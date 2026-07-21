// The DOLLHOUSE family HUD (shared/world-engine/interaction/quest/family-hud.ts):
// the emoji priority ladder that turns one member's live signals into its ONE
// chip state — plus the spoken self-care commands ("you eat" / "you sleep")
// that compile to the `satisfy` goal the host routes into the need machinery.
//
// Pure logic — no DB / LLM / GL — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import { familyStateOf, type FamilySignals } from "@shared/world-engine/interaction/quest/family-hud.js";
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
      emoji: "⚽",
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
