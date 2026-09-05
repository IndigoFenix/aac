/**
 * Tests for the shared SENTENCE BUILDER ops (server/../shared/glyph-builder-ops),
 * the common source the AAC and clinician builders both use for modifier
 * mutation, quality pole-cycling, and pending-join consumption.
 */

import { describe, it, expect } from "@jest/globals";
import {
  applyExclusiveModifier,
  autoComposeSlot,
  computeTargetSlot,
  cycleQualityPole,
  pushSlotWithJoin,
  resolveSlotItem,
  canonicalizeForEngine,
  slotKeyForSelection,
} from "../../shared/glyph-builder-ops.js";
import {
  parseGlyph,
  serializeGlyph,
  addModifier,
  EMPTY_GLYPH,
  MAX_SLOTS,
} from "../../shared/glyph-compositor.js";
import { getVocabularyItem, modifiersFor, type VocabularyItem } from "../../shared/glyph-registry.js";
import { placeArt } from "../../shared/glyph-place-art.js";
import { parseSentence } from "../../shared/world-engine/interaction/intent/parse-intent.js";

describe("applyExclusiveModifier", () => {
  it("keeps one member of a transform family at a time (amount/gauge)", () => {
    let g = parseGlyph("cookie");
    g = applyExclusiveModifier(g, 0, "some", "gauge");
    expect(g.slots[0].modifiers).toEqual(["some"]);
    // Picking another gauge value replaces the first.
    g = applyExclusiveModifier(g, 0, "all", "gauge");
    expect(g.slots[0].modifiers).toEqual(["all"]);
    // Tapping the active one again removes it.
    g = applyExclusiveModifier(g, 0, "all", "gauge");
    expect(g.slots[0].modifiers).toEqual([]);
  });
});

describe("cycleQualityPole", () => {
  it("cycles none → positive → negative → none", () => {
    let g = parseGlyph("dog");
    g = cycleQualityPole(g, 0, "good", "bad");
    expect(g.slots[0].modifiers).toEqual(["good"]);
    g = cycleQualityPole(g, 0, "good", "bad");
    expect(g.slots[0].modifiers).toEqual(["bad"]);
    g = cycleQualityPole(g, 0, "good", "bad");
    expect(g.slots[0].modifiers).toEqual([]);
  });
});

describe("pushSlotWithJoin", () => {
  it("pushes a slot and attaches an armed join", () => {
    const g0 = parseGlyph("apple");
    const g1 = pushSlotWithJoin(g0, "🍌", "or");
    expect(g1.slots.map((s) => s.key)).toEqual(["apple", "🍌"]);
    expect(g1.slots[1].join).toBe("or");
    expect(serializeGlyph(g1)).toBe("apple+or+🍌");
  });

  it("pushes without a join when none is armed", () => {
    const g1 = pushSlotWithJoin(parseGlyph("apple"), "🍌", null);
    expect(g1.slots[1].join).toBeUndefined();
    expect(serializeGlyph(g1)).toBe("apple+🍌");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PRESS ROUTING (moved here from client-aac/src/lib/builder-rules.test.ts when
// the rules stopped being the student builder's alone).
// ─────────────────────────────────────────────────────────────────────────────

describe("autoComposeSlot — the descriptor rule (the in-game SpeakMenu's tapWord)", () => {
  // The seam, stated as the two sentences it produces: `banana.hot` is a
  // request for a hot banana; `banana + hot` is the claim that the banana is
  // hot. Same two presses; the parser reads them differently.
  it("composes a descriptor onto the head it describes", () => {
    const glyph = parseGlyph("apple");
    const idx = autoComposeSlot(glyph, "hot");
    expect(idx).toBe(0);
    expect(serializeGlyph(addModifier(glyph, idx!, "hot"))).toBe("apple.hot");
  });

  it("composes onto the LAST head only — an earlier word is not re-described", () => {
    const glyph = parseGlyph("apple+ball");
    expect(autoComposeSlot(glyph, "big")).toBe(1);
  });

  it("pushes (returns null) when there is no head to describe", () => {
    expect(autoComposeSlot(EMPTY_GLYPH, "hot")).toBeNull();
    expect(autoComposeSlot(parseGlyph(""), "hot")).toBeNull();
  });

  it("pushes when the tapped word is NOT a modifier — a noun never composes", () => {
    expect(autoComposeSlot(parseGlyph("apple"), "ball")).toBeNull();
    expect(autoComposeSlot(parseGlyph("apple"), "want")).toBeNull();
    // A word neither registry knows (an engine-only key, a generated symbol)
    // pushes too — no registry facet, no rule.
    expect(autoComposeSlot(parseGlyph("apple"), "zzz_not_a_word")).toBeNull();
  });

  it("pushes when the modifier does not APPLY to that head's part of speech", () => {
    // The gate is the registry's own `appliesTo`, not a guess: a modifier that
    // has nothing to say about a head must not silently attach to it.
    const glyph = parseGlyph("apple");
    const idx = autoComposeSlot(glyph, "hot");
    expect(idx).not.toBeNull(); // control: `hot` does apply to a noun
    // ...and a head the registry doesn't know at all offers no pos to match.
    expect(autoComposeSlot(parseGlyph("zzz_unknown_head"), "hot")).toBeNull();
  });

  it("never applies the SAME modifier twice — a second tap pushes instead", () => {
    const once = addModifier(parseGlyph("apple"), 0, "hot");
    expect(autoComposeSlot(once, "hot")).toBeNull();
    // A DIFFERENT descriptor still composes onto the same head.
    expect(autoComposeSlot(once, "big")).toBe(0);
  });

  it("the composed sentence is what the ENGINE reads as a modified noun", () => {
    // END TO END, and the reason the rule exists: the two forms are two
    // different meanings, and only the composed one asks for a HOT apple.
    const composed = serializeGlyph(addModifier(parseGlyph("i_me+want+apple"), 2, "hot"));
    expect(composed).toBe("i_me+want+apple.hot");

    const together = parseSentence(composed);
    const objectOf = (f: ReturnType<typeof parseSentence>): string[] =>
      f.object && f.object.kind === "entity" ? [...f.object.modifiers] : [];
    expect(together.kind).toBe("request");
    expect(together.object).toMatchObject({ kind: "entity", symbol: "apple" });
    // "hot" describes the APPLE — it rides on the object ref.
    expect(objectOf(together)).toContain("hot");
    expect(together.modifiers).not.toContain("hot");

    // Pushed as its own word, "hot" becomes a PREDICATE attribute of the
    // utterance instead: the apple is not asked for hot, it is called hot.
    const apart = parseSentence("i_me+want+apple+hot");
    expect(objectOf(apart)).not.toContain("hot");
    expect(apart.modifiers).toContain("hot");
  });
});

describe("slotKeyForSelection — what a pressed word STORES", () => {
  const item = (key: string): VocabularyItem => {
    const v = getVocabularyItem(key);
    if (!v) throw new Error(`registry has no ${key}`);
    return v;
  };

  it("an AI-taught word keeps its snake_case key", () => {
    const want = item("want");
    expect(want.exposeToAi).toBe(true);
    expect(slotKeyForSelection(want)).toBe("want");
  });

  it("a PLACE word keeps its KEY, not its emoji — the picture is shell+fixture", () => {
    // THE CLINICIAN SEAM: without this branch a clinician picking "bedroom"
    // stored 🛌 and the student's board drew a bare bed with no room round it.
    // Every shipped room word is currently ALSO `exposeToAi`, so the branch is
    // exercised with a synthesised one — the point is that `placeArt` decides,
    // not the emoji, and a room word added without `exposeToAi` must not regress.
    const bedroom = item("bedroom");
    expect(placeArt(bedroom.key)).toBeTruthy();
    const roomOnly = { ...bedroom, exposeToAi: false, emoji: "🛌" } as VocabularyItem;
    expect(slotKeyForSelection(roomOnly)).toBe("bedroom");
  });

  it("an ordinary word stores its canonical emoji (the AI reads it visually)", () => {
    const apple = item("apple");
    expect(apple.exposeToAi).not.toBe(true);
    expect(slotKeyForSelection(apple)).toBe(apple.emoji);
  });

  it("a word with no emoji at all falls back to its key", () => {
    const bare = { key: "zzz_bare", tKey: "aac.glyph.zzz_bare", pos: "noun", categories: [], modeChips: {}, tone: "comment" } as unknown as VocabularyItem;
    expect(slotKeyForSelection(bare)).toBe("zzz_bare");
  });
});

describe("computeTargetSlot — where the next word is expected to land", () => {
  it("an explicitly selected slot IS the target", () => {
    expect(computeTargetSlot(parseGlyph("apple+ball"), 0)).toBe(0);
  });

  it("with no selection the target is the next empty position", () => {
    expect(computeTargetSlot(EMPTY_GLYPH, null)).toBe(0);
    expect(computeTargetSlot(parseGlyph("apple+ball"), null)).toBe(2);
  });

  it("clamps at the cap, so a full sentence re-suggests its last slot", () => {
    const full = parseGlyph(new Array(MAX_SLOTS).fill("apple").join("+"));
    expect(full.slots.length).toBe(MAX_SLOTS);
    expect(computeTargetSlot(full, null)).toBe(MAX_SLOTS - 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EMOJI-KEYED SLOTS. `slotKeyForSelection` stores the canonical EMOJI for items
// the AI isn't taught by name, and AI-authored glyphs are mostly emoji too
// (`i_me+want+💧`). The modifier band and the engine surfacer both reason over
// registry keys, so they need the emoji spelled back out.
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveSlotItem — the item a slot actually means", () => {
  it("a registry key resolves to itself", () => {
    expect(resolveSlotItem("water")?.key).toBe("water");
    expect(resolveSlotItem("i_me")?.key).toBe("i_me");
  });

  it("an emoji-stored head resolves back to its item", () => {
    const water = getVocabularyItem("water")!;
    expect(water.emoji).toBeTruthy();
    // Precondition: this is exactly what the builder would have stored.
    expect(slotKeyForSelection(water)).toBe(water.emoji);
    expect(resolveSlotItem(water.emoji!)?.key).toBe("water");
  });

  it("resolving the emoji gives the modifier families the raw lookup lost", () => {
    const water = getVocabularyItem("water")!;
    // The bug: getVocabularyItem(emoji) is undefined, so the band was empty.
    expect(getVocabularyItem(water.emoji!)).toBeUndefined();
    expect(modifiersFor(resolveSlotItem(water.emoji!)!.pos).length).toBeGreaterThan(0);
  });

  it("keys with no registry item stay unresolved", () => {
    expect(resolveSlotItem("face:abc123")).toBeUndefined();
    expect(resolveSlotItem("symbol:42")).toBeUndefined();
    expect(resolveSlotItem("\u{1FAB2}\u{1FAB2}")).toBeUndefined();  // a two-bug emoji nothing claims
  });
});

describe("canonicalizeForEngine — the string the surfacer and parser see", () => {
  const WATER_EMOJI = getVocabularyItem("water")!.emoji!;

  it("spells an emoji head back as its registry key", () => {
    expect(canonicalizeForEngine(parseGlyph(`i_me+want+${WATER_EMOJI}`))).toBe("i_me+want+water");
  });

  it("leaves an all-key glyph byte-identical to serializeGlyph", () => {
    const g = parseGlyph("i_me+want+water");
    expect(canonicalizeForEngine(g)).toBe(serializeGlyph(g));
  });

  it("passes face:/symbol:/unclaimed keys through unchanged", () => {
    const g = parseGlyph("face:abc123+symbol:42+\u{1FAB2}\u{1FAB2}");
    expect(canonicalizeForEngine(g)).toBe(serializeGlyph(g));
    expect(canonicalizeForEngine(g)).toContain("face:abc123");
    expect(canonicalizeForEngine(g)).toContain("symbol:42");
  });

  it("preserves modifiers on a rewritten head", () => {
    expect(canonicalizeForEngine(parseGlyph(`${WATER_EMOJI}.hot`))).toBe("water.hot");
    expect(canonicalizeForEngine(parseGlyph(`${WATER_EMOJI}.hot.big`))).toBe("water.hot.big");
  });

  it("preserves tone tags", () => {
    expect(canonicalizeForEngine(parseGlyph(`i_me+want+${WATER_EMOJI}#question`)))
      .toBe("i_me+want+water#question");
  });

  it("preserves joins", () => {
    expect(canonicalizeForEngine(parseGlyph(`${WATER_EMOJI}+and+cookie`))).toBe("water+and+cookie");
  });

  it("preserves a payload", () => {
    const g = parseGlyph(`want(${WATER_EMOJI})`);
    // The payload is not a head — it is left exactly as stored.
    expect(canonicalizeForEngine(g)).toBe(serializeGlyph(g));
  });

  it("is pure — the input glyph is untouched", () => {
    const g = parseGlyph(`i_me+want+${WATER_EMOJI}`);
    const before = JSON.stringify(g);
    canonicalizeForEngine(g);
    expect(JSON.stringify(g)).toBe(before);
  });

  it("an empty glyph serializes to an empty string", () => {
    expect(canonicalizeForEngine(EMPTY_GLYPH)).toBe("");
  });
});
