// ⚖️ THE CUT — ONE ACT, TWO OUTCOMES.
//
// User ruling, 2026-09-02, verbatim: *"Cutting IS removal, and also a
// harvesting method for kill products. It applies to trees, which should
// produce wood when cut, as well as any other plants that have kill products.
// If there are no kill products, it simply removes them. It's the same action
// for both."*
//
// And its other half, the same day: *"harvesting kill products WITHOUT killing
// the plant/animal should not be possible (that's the definition of a kill
// product) — the whole 'harvest it and it shrinks' path is incorrect for this
// (might still be relevant for other product types, like stone sources)"*, plus
// *"A destroyed tree should create a pile of wood which can be carried."*
//
// WHAT THIS FILE REPLACED. An earlier round shipped `cut` as REMOVAL ONLY,
// written deliberately as felling's exact complement (`sourceIsRemovable` =
// substantial AND NOT consumable). So `cut + bush` worked and `cut + oak` was a
// refusal — a child pressing the board's own button on a tree was told "that
// one can't be cleared". The partition is gone; these tests pin its absence.
//
// WHAT IS PINNED, and ③ is the one to read twice:
//
//   ① ONE ACT. Every substantial plant is cuttable, whatever it yields. What
//      DIFFERS is the outcome, and the outcome is read off the products: a
//      source made of something gives it up (the trunk stays as a heap of its
//      own timber); a source made of nothing is simply gone.
//   ② A KILL PRODUCT REQUIRES THE KILL. A standing tree's wood is not a stack
//      anyone can withdraw from, and an outcrop — the `deplete` method — is the
//      one thing that still wears away unit by unit.
//   ③ 🚨 `fight` DOES NOT EAT COMBAT. `fight` is a real verb with a real future
//      and it is TODAY the word the absolute taboo is written in ("we do not
//      fight"). A wholesale redirect would have made "fight the wolf" mean
//      "uproot the wolf" — silently, and in a way nobody would notice until
//      combat landed. The gate is the binder's `isFeature`, and the wilderness
//      keeps its creatures in a DIFFERENT LIST from the things rooted in its
//      ground, so no body can answer yes to it at any price.
//   ④ CONSERVATION, ACROSS BOTH OUTCOMES. Felling a tree moves NOTHING (the
//      strongest form of the law: what never moved cannot be lost or doubled);
//      removing a bush moves what it bore into a hand, else onto the ground
//      where it grew. No new good is invented to balance the books.
//
// ①–③ are pure. ④ and the acceptance checks boot the REAL host over the shipped
// frontier world (the same `bootTextQuest` harness `frontier-conservation` uses)
// — the only place the wilderness, the binder and the order dispatch meet.
//
// Run:  npm run test:engine -- removal

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  glyphTakeableFrom,
  isBodyProduct,
  naturalSourceOf,
  naturalSources,
  sourceDepletes,
  sourceIsConsumable,
  sourceIsCuttable,
  sourceIsSubstantial,
  takeUnitsOf,
} from "@shared/world-engine/products.js";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import {
  compileIntent,
  defaultBinder,
  type IntentBinder,
} from "@shared/world-engine/interaction/intent/intent-compile.js";
import { asIntent, goalIntentLine, type IntentLineSyms } from "@shared/world-engine/interaction/dialogue/intent-lines.js";
import { compileGoal } from "@shared/world-engine/interaction/behavior/goal-selection.js";
import { translateGlyph } from "@shared/world-engine/interaction/lang/index.js";
import { cutFirstLine, sourceKindWord } from "@shared/world-engine/interaction/dialogue/host-lines.js";
import {
  wildFeatureContainerId,
  type WildMixEntry,
} from "@shared/world-engine/interaction/quest/wilderness.js";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";

// ── ① ONE ACT ──────────────────────────────────────────────────────────────

describe("cut is one act — the yield is a consequence, never a gate on the verb", () => {
  it("EVERY substantial plant is cuttable, whatever it yields", () => {
    // 🚨 THE REGRESSION THIS FILE EXISTS FOR. The first three used to be FALSE
    // — `cut + oak` was a deliberate refusal — and that is the design the user
    // corrected: *"it's the same action for both"*.
    expect(sourceIsCuttable("oak", undefined)).toBe(true); // wood:kill
    expect(sourceIsCuttable("apple_tree", undefined)).toBe(true); // apple:harvest + wood:kill
    expect(sourceIsCuttable("grape_vine", undefined)).toBe(true); // grape:harvest only
    expect(sourceIsCuttable("banana_plant", undefined)).toBe(true);
    expect(sourceIsCuttable("carrot_plant", undefined)).toBe(true);
  });

  it("a DEPLETING source is not cut — it already has an ending", () => {
    // The one thing the act does not own, and the reason is the ONE-ENDING law,
    // not a fact about minerals: an outcrop is worn away stone by stone until
    // it is spent, so a cut would be a second way for one thing to stop being
    // there. A moss patch would land on this side of the line too.
    expect(sourceDepletes(naturalSourceOf("rock")!)).toBe(true);
    expect(sourceIsCuttable("rock", undefined)).toBe(false);
  });

  it("every substantial ROOTED source has exactly ONE ending — cut, or worn away", () => {
    // ⚠️ ROOTED. A creature is in the wilderness's OTHER list and no act reaches
    // it from the cut at any price, so it is not on this ladder at all — its
    // ending is its kill stock running out (`sourceSpent` retires the body).
    // Asserting `!sourceDepletes` over a sheep is what made the predicate claim
    // an act that cannot happen.
    for (const src of naturalSources()) {
      if (src.kind === "animal") continue;
      if (!sourceIsSubstantial(src.species, undefined)) continue;
      // Substance to give up outranks also wearing away; only a PURE-deplete
      // source keeps the outcrop's ending.
      const pureDeplete = sourceDepletes(src) && !src.products.some((p) => p.method === "kill");
      expect(sourceIsCuttable(src.species, undefined)).toBe(!pureDeplete);
    }
  });

  it("🚨 an ANIMAL is never cuttable — 'fight the sheep' is not 'uproot the sheep'", () => {
    for (const src of naturalSources()) {
      if (src.kind !== "animal") continue;
      expect(sourceIsCuttable(src.species, undefined)).toBe(false);
    }
    expect(sourceIsCuttable("sheep", undefined)).toBe(false); // named, so a rename shows
  });

  it("a seedling is IN NOBODY'S WAY — but the act is still offered on it", () => {
    // ⚠️ PIN MOVED 2026-09-06 (PLANTS GROW LIKE PLANTS, R6). This read
    // `sourceIsCuttable("apple_tree", 0) === false`, on the reasoning that a
    // seedling below the bearing floor is "neither" — neither substantial nor
    // cuttable. The user ruled the second half the other way, verbatim:
    // *"technically the player should be given the option to cut saplings if
    // needed, they'll just be deprioritized by automatic designation because
    // they produce less wood."*
    //
    // So "cuttable" (the ACT) and "substantial" (the WOOD, the collision, the
    // lot) came apart, and this file's own ① — *the yield is a consequence,
    // never a gate on the verb* — now holds one rung further down: it was
    // written for BUSHES and it turns out to be the same argument for saplings.
    // The floor is unmoved; only which question it answers.
    expect(sourceIsCuttable("apple_tree", 0)).toBe(true);
    expect(sourceIsSubstantial("apple_tree", 0)).toBe(false);
    expect(naturalSourceOf("apple_tree")!.growth!.classes[0]!.yieldMul).toBe(0);
    // The full matrix, the 0-yield cut's honest ending and the automatic
    // chooser's deprioritisation live in `plant-growth-stage.test.ts`.
  });

  it("nothing the catalogue never heard of is cuttable", () => {
    expect(sourceIsCuttable("teapot", undefined)).toBe(false);
  });
});

// ── ② A KILL PRODUCT REQUIRES THE KILL ─────────────────────────────────────

describe("the three acquisition methods", () => {
  it("a STANDING body will not give up its substance; a DOWNED one will", () => {
    const oak = naturalSourceOf("oak")!;
    expect(glyphTakeableFrom(oak, "wood", false)).toBe(false); // ← the whole ruling
    expect(glyphTakeableFrom(oak, "wood", true)).toBe(true);
    // Its BEARING is untouched by any of this: an apple comes off a living
    // apple tree, and off a felled one.
    const apple = naturalSourceOf("apple_tree")!;
    expect(glyphTakeableFrom(apple, "apple", false)).toBe(true);
    expect(glyphTakeableFrom(apple, "apple", true)).toBe(true);
  });

  it("a DEPLETING source gives up stone standing — that path is preserved by name", () => {
    expect(glyphTakeableFrom(naturalSourceOf("rock")!, "stone", false)).toBe(true);
  });

  it("🚨 a living animal shears, milks AND gives meat — the gate is for FEATURES", () => {
    // ⚠️ THIS ASSERTED THE OPPOSITE FOR ONE DAY, and the opposite was a dead
    // end: `downed` is a state only a wilderness FEATURE can reach (the cut is
    // features-only, deliberately — "'fight the sheep' must never mean 'uproot
    // the sheep'"), so gating a sheep's meat on it meant no cut button, a
    // nonsense "cut it down first" at the player, and meat unreachable forever
    // — while the automated draw, whose cut on a creature is a silent no-op,
    // kept drawing it. The kill is still real: emptying the kill stock IS the
    // kill and `sourceSpent` retires the body on the last unit.
    const sheep = naturalSourceOf("sheep")!;
    expect(glyphTakeableFrom(sheep, "wool", false)).toBe(true);
    expect(glyphTakeableFrom(sheep, "meat", false)).toBe(true);
    expect(glyphTakeableFrom(naturalSourceOf("cow")!, "milk", false)).toBe(true);
    expect(glyphTakeableFrom(naturalSourceOf("cow")!, "meat", false)).toBe(true);
  });

  it("`isBodyProduct` is the two-vs-three seam, and stone is on the body side", () => {
    // Everything that used to ask `method === "kill"` meant THIS. Had the sites
    // been left as they were, the outcrop's stone would have silently dropped
    // out of every one of them the day `deplete` landed.
    expect(naturalSourceOf("rock")!.products.every(isBodyProduct)).toBe(true);
    expect(naturalSourceOf("oak")!.products.filter(isBodyProduct).map((p) => p.glyph)).toEqual(["wood"]);
    expect(naturalSourceOf("banana_plant")!.products.some(isBodyProduct)).toBe(false);
    // …and "consumable" still means "has an ending", which both methods are.
    expect(sourceIsConsumable(naturalSourceOf("rock")!)).toBe(true);
    expect(sourceIsConsumable(naturalSourceOf("oak")!)).toBe(true);
    expect(sourceIsConsumable(naturalSourceOf("banana_plant")!)).toBe(false);
  });

  it("a DOWNED source is cheaper to collect from — through the tool dial, not a new one", () => {
    // *"should be treated as less costly to collect than wood that is still in
    // a tree"*. The factor is the product row's OWN declared multiplier: a
    // source that declares no tool is unaffected either way.
    const oak = naturalSourceOf("oak")!;
    const bare = () => false;
    const axe = (g: string) => g === "axe";
    expect(takeUnitsOf(oak, "wood", bare)).toBe(1);
    expect(takeUnitsOf(oak, "wood", axe)).toBe(2);
    // Down: bare hands move what the axe moved on the standing trunk, and the
    // axe still helps. Strictly cheaper in BOTH cases, which is what was asked.
    expect(takeUnitsOf(oak, "wood", bare, { downed: true })).toBe(2);
    // ⚠️ AND THE TWO COMPOSE, WHICH IS THE MULTIPLIER SQUARED — said out loud
    // because the doc once claimed "NO NEW NUMBER" while shipping mul².
    const mul = oak.products.find((p) => p.glyph === "wood")!.tool!.multiplier;
    expect(takeUnitsOf(oak, "wood", axe, { downed: true })).toBe(mul * mul);
    expect(takeUnitsOf(oak, "wood", axe, { downed: true })).toBe(4);
    // No tool declared ⇒ nothing changes. A fallen bush's berries do not come
    // off it any faster.
    expect(takeUnitsOf(naturalSourceOf("banana_plant")!, "banana", bare, { downed: true })).toBe(1);
  });
});

// ── ②/③ THE REDIRECT, AND ITS GATE ─────────────────────────────────────────

/** A binder for whom exactly one word — `bush` — names a standing feature.
 *  Everything else is what the default binder makes of it. */
const base = defaultBinder({ player: "child", listener: "bear" });
const withFeature: IntentBinder = { ...base, isFeature: (ref) => ref?.kind === "entity" && ref.symbol === "bush" };
const compile = (s: string, b: IntentBinder = withFeature) => compileIntent(parseSentence(s), b, { id: "r1" });
const goalOf = (s: string, b: IntentBinder = withFeature) => {
  const c = compile(s, b);
  return c.kind === "goal" ? c.goal : null;
};

describe("break / cut / fight redirect — WITH a feature as the object", () => {
  it("all three reach the same act, and the SPOKEN WORD rides the goal", () => {
    for (const verb of ["break", "cut", "fight"]) {
      expect(goalOf(`${verb} + bush`)).toEqual({ kind: "clearFeature", feature: "bush" });
    }
  });

  it("🚨 fight keeps combat — a body is never a feature", () => {
    // THE TEST THIS FILE EXISTS FOR. The binder above says yes to `bush` and to
    // nothing else, which is the world's own answer in miniature: the
    // wilderness's creature list is not its feature list. Every one of these
    // must stay exactly what it was before the cut act existed.
    expect(compile("fight + bear").kind).toBe("unbound");
    expect(compile("fight + dog").kind).toBe("unbound");
    expect(compile("fight + wolf").kind).toBe("unbound");
    // …and a BARE fight, the word a taboo is written about, is untouched too.
    expect(compile("fight").kind).toBe("unbound");
  });

  it("a binder that knows nothing about features leaves all three verbs alone", () => {
    // The legacy session (no `isFeature` bound at all) — the compiler may not
    // start guessing that a plant word means a plant that is standing there.
    expect(compile("cut + bush", base).kind).toBe("unbound");
    expect(compile("fight + bush", base).kind).toBe("unbound");
    expect(compile("break + bush", base).kind).toBe("unbound");
  });

  it("`break` keeps furniture and rooms, and tries them FIRST", () => {
    // A word that is genuinely both loses the clearing reading, never the
    // other one: a piece can be rebuilt and a room re-raised, a felled bush
    // cannot. Both readings are checked with `isFeature` saying yes to the
    // same word, so the ORDER is what is being pinned.
    const both: IntentBinder = {
      ...base,
      isFeature: () => true,
      isFurniture: (ref) => ref?.kind === "entity" && ref.symbol === "bed",
      isStructure: (ref) => ref?.kind === "entity" && ref.symbol === "bedroom",
    };
    expect(goalOf("break + bed", both)).toEqual({ kind: "breakPiece", item: { match: { kind: "bed" } } });
    expect(goalOf("break + bedroom", both)).toEqual({ kind: "demolish", room: "bedroom" });
  });

  it("is never a TRANSFORM — cut and fight name no state a thing arrives at", () => {
    // The lazy way to wire this would have been `TRANSFORM_STATE`, which would
    // have given "cut the cup" a silent, meaningless state edit.
    expect(compile("cut + cup", base).kind).toBe("unbound");
    expect(compile("fight + cup", base).kind).toBe("unbound");
  });

  it("is host-routed, never a body errand", () => {
    // Like the room verbs: the host resolves the word against the standing
    // wilderness and works the cut. A compiled errand would have to know world
    // ids, and a goal never carries one.
    const resolver = { positionOf: () => null, itemPosition: () => null, resolveItem: () => null } as never;
    expect(compileGoal({ kind: "clearFeature", feature: "bush" }, "bear", resolver)).toBeNull();
  });
});

// ── THE ACKNOWLEDGEMENT, IN ALL FOUR SHIPPED RULESETS ──────────────────────

describe("what the creature says back", () => {
  const syms: IntentLineSyms = {
    item: (ref) => ("id" in ref ? ref.id : (ref.match.kind ?? "thing")),
    place: (p) => (p.kind === "named" ? p.id : "there"),
    creature: (id) => id,
  };

  it("says CUT whichever of the three verbs was said", () => {
    // A creature saying what it is about to do uses the word that fits the
    // act — you cut a plant down, you do not fight one. (`craft`'s rule: the
    // order may say "build", the announcement says "make".)
    const line = goalIntentLine({ kind: "clearFeature", feature: "tree" }, syms)!;
    expect(line.c).toBe("i_me + cut + tree");
  });

  it("renders with NO raw English keys in Hebrew, Spanish or Portuguese", () => {
    // 🚨 The silent-lexicon trap: `baseWord` falls back to the raw head and a
    // head IS an English word, so English always looks perfect. `cut` is a
    // lexeme in all four rulesets and `tree` rides ITEM_WORDS, so the whole
    // line is sayable — which is only true because the goal carries the
    // CHILD'S word and never a species id (`grape_vine` is a lexeme nowhere).
    const b = asIntent(goalIntentLine({ kind: "clearFeature", feature: "tree" }, syms)!).b;
    expect(translateGlyph(b, "en")).toContain("cut");
    for (const loc of ["he-IL", "es", "pt-BR"] as const) {
      const said = translateGlyph(b, loc);
      expect(said.length).toBeGreaterThan(0);
      expect(said).not.toMatch(/\bcut\b|\btree\b/);
    }
  });
});

// ── THE TAKE REFUSAL — THE LINE A CHILD MEETS MOST ─────────────────────────
//
// 🚨 IT SHIPPED AS BARE ENGLISH. `takeFromContainer`'s fell-first arm toasted
// `"💬 cut it down first"` — the one refusal on that board that never reached
// the lexicon, on a board whose every other press speaks. It now takes the
// leveled-glyph channel every sibling refusal takes.

describe("what the creature says when the timber is still in the tree", () => {
  it("names the standing thing in the causal shape — clearFirstLine's take-side twin", () => {
    const line = cutFirstLine("wood", "plants");
    expect(line.a).toBe("here");
    expect(line.b).toBe("because + plants + here");
    expect(line.c).toBe("i_me + take.not + wood + because + plants + here");
    // The EFFECT is the take that cannot happen and the CAUSE is what is in the
    // way — never a bare refusal token, because the act IS available (the `cut`
    // button is on the very board this refuses from).
    expect(line.c.split(" + ")).not.toContain("no");
  });

  it("the blocker word is the source's KIND, never its species", () => {
    // A species id has a lexeme in no ruleset on earth; `plants`/`animal` have
    // one in all four. ONE OWNER, shared with the builder's blocked-lot line.
    expect(sourceKindWord("plant")).toBe("plants");
    expect(sourceKindWord("animal")).toBe("animal");
    expect(sourceKindWord("mineral")).toBeNull(); // no word ⇒ the caller says CANT_HERE
    expect(sourceKindWord(undefined)).toBeNull();
  });

  it("renders with NO raw English and NO raw glyph keys in all four rulesets", () => {
    const line = cutFirstLine("wood", "plants");
    for (const lvl of ["a", "b", "c"] as const) {
      expect(translateGlyph(line[lvl], "en").length).toBeGreaterThan(0);
      for (const loc of ["he-IL", "es", "pt-BR"] as const) {
        const said = translateGlyph(line[lvl], loc);
        expect(said.length).toBeGreaterThan(0);
        // The silent-lexicon tell: an untranslated head comes back as itself.
        expect(said).not.toMatch(/\bwood\b|\bplants?\b|\bhere\b|\btake\b/);
      }
    }
  });
});

// ── ④ THE ACT ITSELF, ON THE REAL HOST ─────────────────────────────────────
//
// The shipped frontier document over an AUTHORED wilderness: the whole chain —
// board word → binder → compiler → order dispatch → wilderness — is real, and
// the ground it runs over is this fixture's own.
//
// 🌲 WHY THE MIX IS AUTHORED HERE (2026-09-04). These cases need exactly four
// things standing — a tree to fell, ONE pure-harvest plant (the removal
// outcome's twin), an outcrop to be refused, and a product animal for the
// endpoint sweep — and every one of them used to be inherited from
// `homesteadWildMix`, i.e. from a CONTENT lane. The day the wild larder landed
// (`forageLines` — berry bush, hazel, wild onion, at six a species) that
// inheritance stood 19 pure-harvest plants where there had been two, and the
// clearing below silently changed meaning. The counts are the fixture's
// premise, so the fixture states them; the content lane may stand whatever it
// likes on the frontier without moving this file.
//
// ⚠️ ONE LINE PER SPECIES (`buildWilderness` ids are `wild:<species>_<i>`, so
// two lines naming one species would mint duplicate container ids), and a count
// is an ASK, not a guarantee: the keep-clear disc drops whatever lands in the
// settlement footprint (6 oaks asked, 5 stand). Each line therefore carries a
// little headroom, and the PRECONDITION case below reads back what really did.

const doc = JSON.parse(readFileSync(join(process.cwd(), "scripts", "worlds", "frontier.spec.json"), "utf8"));

/** The ground these cases need, and nothing else. */
const CUT_MIX: WildMixEntry[] = [
  { species: "oak", count: 6 }, // the felling outcome — several, so the acceptance can spend one
  { species: "bush", count: 1 }, // the REMOVAL outcome: a pure-harvest plant, no kill product
  { species: "rock", count: 4 }, // the one-ending refusal
  { species: "sheep", count: 2 }, // …and the walking half, for the endpoint sweep
  { species: "cow", count: 1 },
];

describe("frontier — a child presses `cut`", () => {
  let run: TextQuestRun;

  beforeAll(() => {
    run = bootTextQuest({ world: doc, seed: 11, dt: 0.5, wildMix: CUT_MIX });
    run.advance(20); // let the streamer stand the residents up
  }, 600_000);

  afterAll(() => run?.dispose());

  const standing = () =>
    run.session.wilderness!.features.filter((f) => !f.downed && sourceIsCuttable(f.species, f.sizeClass));
  /** The cuttable plants that have NOTHING to become — the removal outcome. */
  const bushes = () => standing().filter((f) => !sourceIsConsumable(naturalSourceOf(f.species)!));
  /**
   * 🌲 THE GENERIC WORD AND THE SHAPE IT NAMES (lane W's finding, closed at
   * task #51 item 1d(e)).
   *
   * `cut + tree` takes `spokenFeatureId`'s GENERIC arm — `tree` names no
   * species row, so it matches every PLANT — and it used to pick the nearest
   * standing cuttable one, which is a berry bush as often as it is an oak.
   * This fixture had to clear every bush by SPECIES first to make the oaks the
   * only candidates, and that loop is gone: a generic `tree` now ranks
   * TREE-SHAPED sources (one with a body product to give) ahead of the
   * nearest-plant tiebreak, so the bush below is a CONTROL rather than an
   * obstacle. `plants` stays generic on purpose — it is the board's KIND chip
   * and means the whole category.
   */
  const oaks = () => run.session.wilderness!.features.filter((f) => f.species === "oak");
  const epOf = (f: { species: string; id: string }) => `flora:${f.species}:${f.id}`;
  const propCount = () => Object.keys(run.state.objects).filter((k) => k.startsWith("small:")).length;
  /** Every glyph a `char:` bubble is currently showing — what was SAID. */
  const said = () =>
    Object.entries((run.state as { bubbles?: Record<string, { glyph?: string }> }).bubbles ?? {})
      .filter(([k]) => k.startsWith("char:"))
      .map(([, v]) => v.glyph);

  it("PRECONDITION — the world stands both kinds of plant", () => {
    // A broken fixture, not a finding, if either is missing.
    expect(bushes().length).toBeGreaterThan(0);
    expect(oaks().length).toBeGreaterThan(0);
  }, 600_000);

  it("🐑 NO ENDPOINT IN THE LIVE SESSION REFUSES WITHOUT A REMEDY", () => {
    // 🚨 THE ASYMMETRY THAT BROKE MEAT, checked against the session's OWN two
    // lists. `wildGlyphTakeable` asks `glyphTakeableFrom` over `wildSourceOf`,
    // which covers FEATURES *and* PRODUCT ANIMALS; the cut that clears the
    // refusal is features-only (`w.features.findIndex`), and `downed` is only
    // ever set on a feature — so every endpoint that can be refused here must
    // be one the cut can actually reach. Anything else is a button-less
    // "cut it down first" at a walking animal.
    const w = run.session.wilderness!;
    const animals = w.creatures.filter((c) => c.species);
    expect(animals.length).toBeGreaterThan(0); // fixture: the homestead grazes stock
    for (const c of animals) {
      const src = naturalSourceOf(c.species!)!;
      const ep = `fauna:${c.species}:${c.id}`;
      const stock = run.session.containerRecords.get(ep)?.stock ?? {};
      expect(Object.keys(stock).length).toBeGreaterThan(0);
      for (const glyph of Object.keys(stock)) {
        // A creature is never `downed` (the host reads `wildFeatureDowned`,
        // which is false for anything not in the feature list) — so this is
        // EXACTLY the argument the session reader makes.
        expect(glyphTakeableFrom(src, glyph, false)).toBe(true);
      }
      // …and no cut exists for it, which is why the above must hold.
      expect(w.features.some((f) => wildFeatureContainerId(f) === ep)).toBe(false);
      expect(sourceIsCuttable(c.species!, undefined)).toBe(false);
    }
    // The FEATURE side keeps the gate, and keeps its remedy: a standing oak's
    // wood is refused and the same oak is cuttable. (`wildFeatureContainerId`,
    // not the `flora:` shorthand — a rock is a BOX and keeps its own id.)
    for (const f of w.features) {
      const src = naturalSourceOf(f.species)!;
      const stock = run.session.containerRecords.get(wildFeatureContainerId(f))?.stock ?? {};
      for (const glyph of Object.keys(stock)) {
        if (glyphTakeableFrom(src, glyph, f.downed === true)) continue;
        expect(f.downed).not.toBe(true);
        expect(sourceIsCuttable(f.species, f.sizeClass)).toBe(true);
      }
    }
  }, 600_000);

  it("🌳 ACCEPTANCE — `cut + tree` DESIGNATES an oak, and a body fells it", () => {
    // ⚖️ RE-SHAPED, NOT WEAKENED, for task #51 item 1d (user ruling 2026-09-04:
    // *"the 'cut command' for trees isn't supposed to destroy the tree when the
    // button is pressed. It should issue a COMMAND to cut that tree. Or,
    // alternatively, DESIGNATE the tree to be cut when available as a task."*).
    // This world is the frontier — a town WITH a wilderness scatter — so
    // `pullLaborOn` is TRUE and the sentence MARKS the tree. Every outcome the
    // old acceptance pinned is still pinned; it now happens at the END of a
    // body's walk and chop instead of in the frame the word was said.
    //
    // 🌲 …AND THE BUSHES NO LONGER HAVE TO BE CLEARED FIRST (1d(e)): a generic
    // `tree` prefers a TREE-SHAPED source — one with a body product to give —
    // before the nearest-plant tiebreak, which is the lane-W finding closed.
    // The bush standing in this fixture is the control: it is still there at
    // the end.
    const woodEverywhere = () =>
      run.session.wilderness!.features.reduce(
        (n, f) => n + (run.session.containerRecords.get(epOf(f))?.stock?.["wood"] ?? 0),
        0,
      );
    const downedOaks = () => oaks().filter((f) => f.downed).length;
    expect(oaks().some((f) => !f.downed)).toBe(true);
    expect(bushes().length).toBeGreaterThan(0); // the 1d(e) control stands
    const wood = woodEverywhere();
    expect(wood).toBeGreaterThan(0);
    const fallen = downedOaks();
    const audit = run.host.stockAudit()["wood"] ?? 0;
    const props = propCount();
    const book = run.session.town!.deltas;

    run.speak("cut + tree");

    // ① NOTHING FELL WHEN THE WORD WAS SAID. The tree is still standing, which
    //    is the whole of the ruling.
    expect(downedOaks()).toBe(fallen);
    // ② …AND THE WORK EXISTS: either a MARK any idle body may take, or a
    //    COMMAND on a body that was attending (both are the ruling; which one
    //    depends on whether anybody was near enough to be asked).
    const marked = book.fellOrders();
    const commanded = [...run.session.pursuits.values()].filter((p) => p.bill?.link === "fell");
    expect(marked.length + commanded.length).toBeGreaterThan(0);
    // 🌲 1d(e) — AND IT IS AN OAK, not the berry bush standing nearer.
    const targetId = marked[0]?.featureId ?? commanded[0]?.bill?.objId;
    expect(targetId).toContain("oak");

    // ③ A BODY WALKS OUT AND FELLS IT. `CHOP_DWELL_S` plus the walk, so this
    //    drives real time — the arc IS the assertion.
    for (let i = 0; i < 40 && downedOaks() === fallen; i++) run.advanceS(10);
    expect(downedOaks()).toBe(fallen + 1);
    // ④ ⚖️ CONSERVATION — THE STRONGEST FORM: nothing moved at all. Same
    //    containers, same keys, same counts; no prop minted, no unit invented,
    //    and every reservation and in-flight haul aimed at that endpoint
    //    survived the felling. (Measured across the whole walk, which is a
    //    wider window than the old single-frame check.)
    expect(woodEverywhere()).toBe(wood);
    expect(run.host.stockAudit()["wood"] ?? 0).toBe(audit);
    expect(propCount()).toBe(props);
    // ⑤ AND THE WOOD IS REACHABLE NOW, which it was not before the chop.
    expect(glyphTakeableFrom(naturalSourceOf("oak")!, "wood", false)).toBe(false);
    expect(glyphTakeableFrom(naturalSourceOf("oak")!, "wood", true)).toBe(true);
    // ⑥ THE MARK RETIRES WITH THE THING — a felled tree is not still owed.
    expect(book.fellOrders().some((r) => r.featureId === targetId)).toBe(false);
    // ⑦ …AND IT WAS SPOKEN. `ok` is the reserved confirmation of an accepted
    //    order (the designation), `cut.will` the taker's own announcement —
    //    never a silent success, whichever branch ran.
    expect(said().some((g) => g === "ok" || g?.startsWith("cut.will"))).toBe(true);
  }, 600_000);

  it("🌿 ACCEPTANCE — `cut` on a BUSH takes it out and CONSERVES what it bore", () => {
    // The other outcome of the same act, driven the same way as the oak above
    // (task #51 item 1d): the word MARKS the bush and a body comes and takes it
    // out. `plants` is the board's KIND chip and stays generic, so the nearest
    // standing plant is what it reaches — which is this probe, beside the
    // spirit.
    const c = run.session.town!.stage.center;
    const bush = {
      id: "probe:cut_bush",
      species: "banana_plant",
      x: c.x + 6,
      y: c.y + 6,
      stock: { banana: 3 },
    };
    if (!run.host.addWildFeature(bush)) throw new Error("the probe feature would not spawn — fixture broken, not a finding");
    const bearing = Object.values(run.session.containerRecords.get(epOf(bush))?.stock ?? {}).reduce((s, n) => s + n, 0);
    expect(bearing).toBe(3); // it is carrying fruit — the case that matters
    const props = propCount();
    const bananas = run.host.stockAudit()["banana"] ?? 0;

    run.speak("cut + plants");

    // ① IT IS STILL STANDING at the word — the mark is not the deed.
    expect(run.session.wilderness!.features.some((f) => f.id === bush.id)).toBe(true);
    // ② …AND A BODY COMES AND TAKES IT OUT.
    for (let i = 0; i < 40 && run.session.wilderness!.features.some((f) => f.id === bush.id); i++) {
      run.advanceS(10);
    }
    expect(run.session.wilderness!.features.some((f) => f.id === bush.id)).toBe(false);
    // ③ …AND EVERY UNIT IT BORE IS STILL A THING IN THE WORLD. One unit per
    //    prop on the ground where it grew, or into the CHOPPER's own hands —
    //    what a take yields goes to the taker, and a bagless body takes one
    //    whole thing. Nothing was destroyed and no "brush" was invented to
    //    balance the books. (The audit counts what is SCOPED; a banana dropped
    //    on open ground counts for nobody — the recorded census residual — so
    //    the two sinks are counted together and the bound is what a pair of
    //    hands can hold.)
    const dropped = propCount() - props;
    const carried = (run.host.stockAudit()["banana"] ?? 0) - bananas;
    expect(dropped).toBeGreaterThan(0);
    expect(dropped + Math.max(0, carried)).toBeGreaterThanOrEqual(bearing);
    expect(dropped).toBeLessThanOrEqual(bearing);
  }, 600_000);

  it("🪨 an OUTCROP is refused OUT LOUD — it ends by being worn away, not cut", () => {
    // The one-ending law, spoken. Silence would have been the bug.
    const rock = run.session.wilderness!.features.find((f) => f.species === "rock");
    if (!rock) throw new Error("no outcrop in the frontier world — fixture broken, not a finding");
    const before = run.session.wilderness!.features.length;
    run.speak("cut + rock");
    expect(run.session.wilderness!.features.length).toBe(before);
    expect(said()).toContain("place + good.not");
  }, 600_000);

  // ── THE OTHER CALLER: THE BUILDERS' OWN PREREQUISITE ─────────────────────
  //
  // ⚖️ ONE ACT, THEN ONE HAUL. The clearing sweep used to have TWO arms — a
  // removal arm and a felling arm — which is the partition the ruling denies.
  // It now CUTS whatever is in the way and carries off whatever the cut left,
  // and these two cases are the two things a cut can leave.

  /** Stake a lot far enough out to be UNOBSERVED (> 120 m), which is what makes
   *  this deterministic in a handful of frames: the sweep's abstract twin does
   *  the clearing by ledger arithmetic instead of waiting on a porter to walk.
   *  The observed arm posts a real haul and is the same two steps behind it. */
  const stakedLotOver = (
    probe: { id: string; species: string; stock: Record<string, number> },
    off: { dx: number; dy: number },
    glyph: string,
  ) => {
    const c = run.session.town!.stage.center;
    const book = run.session.town!.deltas;
    const f = { ...probe, x: c.x + off.dx + 4.5, y: c.y + off.dy + 4 };
    if (!run.host.addWildFeature(f)) throw new Error("the probe feature would not spawn — fixture broken, not a finding");
    const before = run.host.stockAudit()[glyph] ?? 0;
    const row = book.foundBuilding(
      { type: "house", slot: 91, dx: off.dx, dy: off.dy, w: 9, h: 8, door: "south" },
      0,
      4,
      { block: 6 },
    );
    return { f, book, row, before, alive: () => run.session.wilderness!.features.find((g) => g.id === f.id) };
  };

  it("🌳 a TREE in the builders' way is CUT, then carried off — and the wood is conserved", () => {
    const t = stakedLotOver({ id: "probe:lot_oak", species: "oak", stock: { wood: 6 } }, { dx: -40, dy: 160 }, "wood");
    try {
      // ① 🚨 THE STATE THE SWEEP MAY NEVER LEAVE BEHIND is a tree STILL
      //    STANDING MATURE with less wood in it than it had. That is the
      //    retired model in one sentence — timber withdrawn from a living body
      //    — and it is the only outcome this assertion rules out. Whatever one
      //    sweep manages, the tree is down, or already re-seeded, or untouched.
      //    (This lot is unobserved, so the clearing runs as the abstract twin —
      //    cut, haul and re-seed inside a single sweep, by design. The DOWNED
      //    state is a long visible one on a watched lot, where a porter has to
      //    walk; here it is real but not sampleable from outside.)
      run.advance(10);
      const mid = t.alive();
      const woodLeft = (g: { species: string; id: string }) =>
        run.session.containerRecords.get(epOf(g))?.stock?.["wood"] ?? 0;
      expect(
        mid === undefined || mid.downed === true || mid.sizeClass === 0 || woodLeft(mid) === 6,
      ).toBe(true);
      // ② THE STAKE TERMINATES. The heap empties, and a growth-bearing species
      //    re-seeds where it stood — a sapling, below the obstruction floor, so
      //    the lot reads free. (S3 H2, untouched by this round.)
      for (let i = 0; i < 12 && t.alive()?.sizeClass !== 0 && t.alive(); i++) run.advance(10);
      const end = t.alive();
      expect(end === undefined || (end.downed !== true && end.sizeClass === 0)).toBe(true);
      // ④ ⚖️ CONSERVATION ACROSS THE WHOLE SEQUENCE. Every unit of timber that
      //    stood in that tree is still somewhere countable — on the shelf now
      //    rather than in the trunk. A re-seeded sapling bears NOTHING (class 0
      //    yields zero), so nothing was minted by the re-seed either.
      expect(run.host.stockAudit()["wood"] ?? 0).toBe(t.before);
    } finally {
      t.book.removeOrder(t.row.ord);
    }
  }, 600_000);

  it("🪨 an OUTCROP in the way is worn away instead — the same stake, the other ending", () => {
    // No cut here at any point: the sweep hauls stone off the standing rock,
    // the rock shrinks as it goes, and the LAST stone is what retires it. That
    // is the path the user preserved by name, and it must still terminate a
    // staked lot.
    const t = stakedLotOver({ id: "probe:lot_rock", species: "rock", stock: { stone: 5 } }, { dx: 160, dy: -40 }, "stone");
    try {
      for (let i = 0; i < 16 && t.alive(); i++) run.advance(10);
      expect(t.alive()).toBeUndefined(); // spent, and gone — no growth ladder to re-seed
      expect(t.alive()?.downed).toBeUndefined(); // never went through the cut
      expect(run.host.stockAudit()["stone"] ?? 0).toBe(t.before);
    } finally {
      t.book.removeOrder(t.row.ord);
    }
  }, 600_000);
});
