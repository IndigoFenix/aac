// ⚖️ PLANTS GROW LIKE PLANTS — PART 2: the STAGED TWIN, the cut on a sapling,
// and no body under a building.
//
// User, 2026-09-06 (verbatim): *"trees don't really grow visually, they appear
// fully-grown"* … and, mid-round: *"any tree that was previously cut has a new,
// full-sized tree appear in its place after a few minutes (including inside the
// building before it's completed) and the new tree does not have a cut option.
// I assumed that it was a sapling being rendered at full-size … (though
// technically the player should be given the option to cut saplings if needed,
// they'll just be deprioritized by automatic designation because they produce
// less wood.)"*
//
// PART 1 (`plant-growth-age.test.ts`) landed the AGE FUNCTION — a pure
// blueprint→blueprint schedule, `age = 1` an identity — and `growthAgeOf`, the
// one owner of "how old is this tree". It could not be SEEN: the twin stood one
// per-species body at the registry's adult `bodyHeightM` whatever the sim's
// class said. This file pins the three rulings that close that:
//
//   R5 THE NEAR TWIN DRAWS THE STAGE. The stage is in the ASSET KEY (it cannot
//      ride `look` — `assetKey` keys only a look's effective `toon`, so a
//      smuggled age would hand every oak whichever stage baked first), the
//      stage set IS the class ladder, and a class advance is a BODY SWAP
//      through the one drain (`standWildFeature`) under a container key that
//      never moves.
//   R6 THE BOARD OFFERS `cut` ON A SAPLING. "Cuttable" (the act) came apart
//      from "substantial" (the wood): a sapling is cuttable, yields nothing,
//      obstructs nobody, and is ranked LAST by every automatic chooser.
//   R7 A RE-SEED UNDER A BUILT FOOTPRINT STANDS NO BODY — and stands again
//      when the ground reads clear.
//
// The first two blocks are PURE (no boot, no DB). The third boots the real host
// over the shipped frontier world, the same `bootTextQuest` harness
// `feature-removal` uses.
//
// Run:  npm run test:engine -- plant-growth

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import {
  AGE_TORSO_MIN_M,
  ageGrowths,
  agePlantBody,
} from "@shared/world-engine/creatures/growth.js";
import { SPINE_RANGES } from "@shared/world-engine/creatures/blueprint.js";
import { speciesBlueprint } from "@shared/world-engine/creatures/species.js";
import { buildSkeleton } from "@shared/world-engine/creatures/skeleton.js";
import { buildCreatureMesh } from "@shared/world-engine/creatures/mesh.js";
import { getSpeciesAssets } from "@shared/world-engine/creatures/creature-model.js";
import {
  growthAgeOf,
  naturalSourceOf,
  sourceBlocksBuilding,
  sourceIsCuttable,
  sourceIsSubstantial,
} from "@shared/world-engine/products.js";
import { rectsCoverDisc, settlementFootprints } from "@shared/world-engine/kernel/town/construction.js";
import {
  wildFeatureRadiusOf,
  type WildernessFeature,
  type WildMixEntry,
} from "@shared/world-engine/interaction/quest/wilderness.js";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";

// ── R5a — THE STAGE REACHES THE BODY (pure) ────────────────────────────────

describe("agePlantBody — the plant body at an age, nub and all", () => {
  const oak = speciesBlueprint("oak");

  it("age ≥ 1 is the AUTHORED OBJECT ITSELF — a mature body is not even a copy", () => {
    // The whole reason a stand of grown trees is byte-identical to one built
    // before growth stages existed.
    expect(agePlantBody(oak, 1)).toBe(oak);
    expect(agePlantBody(oak, 2)).toBe(oak);
    expect(agePlantBody(oak, Number.NaN)).toBe(oak);
  });

  it("🌱 SHRINKS THE NUB — the 0.1 m torso a shoot used to wear at full size", () => {
    // PART 1's defect 2: `plantBlueprint` stands every plant on a
    // "near-invisible" 0.1 m torso, which on a 0.36 m oak shoot is a brown
    // spindle taking up a third of the plant.
    const shoot = agePlantBody(oak, 0);
    expect(shoot.spine.torsoLengthM).toBeLessThan(oak.spine.torsoLengthM);
    // …and never below the blueprint's own floor.
    expect(shoot.spine.torsoLengthM).toBeGreaterThanOrEqual(AGE_TORSO_MIN_M);
  });

  it("🚨 the DUPLICATED floor tracks blueprint.ts's own range", () => {
    // growth.ts is a LEAF (blueprint.ts imports it), so the range table cannot
    // be imported back and the number is repeated. This is the pin that keeps
    // the copy honest.
    expect(AGE_TORSO_MIN_M).toBe(SPINE_RANGES.torsoLengthM.min);
  });

  it("moves the height factor, it does not ADD one — stem length is unchanged", () => {
    // `stemLen = stem.lengthFrac × spine.torsoLengthM` (skeleton.ts). The nub
    // fix divides the ratio by exactly the shrink the torso achieved, so every
    // absolute length in the generated structure is `ageGrowths`' own — the
    // schedule PART 1 measured, not a second one.
    for (const age of [0, 0.25, 0.5, 0.75]) {
      const ratioOnly = ageGrowths(oak, age);
      const withNub = agePlantBody(oak, age);
      const before = ratioOnly.growths[0]!.stem.lengthFrac * oak.spine.torsoLengthM;
      const after = withNub.growths[0]!.stem.lengthFrac * withNub.spine.torsoLengthM;
      expect(after).toBeCloseTo(before, 6);
    }
  });

  it("keeps the ladder PART 1 measured — a shoot, a half-grown tree, the oak", () => {
    const h = (age: number) => {
      const s = buildSkeleton(agePlantBody(oak, age));
      return s.bounds.max.y - s.bounds.min.y;
    };
    const shoot = h(0);
    const half = h(0.5);
    const adult = h(1);
    expect(adult).toBeGreaterThan(20); // the authored 23.8 m oak
    expect(half).toBeGreaterThan(4);
    expect(half).toBeLessThan(adult * 0.6);
    expect(shoot).toBeLessThan(1); // a shoot you could step over
    expect(shoot).toBeGreaterThan(0.05);
  });

  it("the oak's three SIM classes land on three different bodies", () => {
    // `growthAgeOf` is the one owner; the stage set is the class ladder itself.
    const ages = [0, 1, 2].map((c) => growthAgeOf("oak", c));
    expect(ages).toEqual([0, 0.5, 1]);
    const levels = ages.map((a) => agePlantBody(oak, a).growths[0]!.branching.levels);
    expect(levels).toEqual([0, 2, 3]); // a shoot, a young crown, the full oak
  });
});

// ── R5b — …AND THE ASSET KEY (pure, builds real THREE geometry) ────────────

describe("the stage is in the ASSET KEY, and the scale is the ADULT's", () => {
  it("each stage is its own cached bake; the same stage is shared", () => {
    const a0 = getSpeciesAssets("oak", {}, undefined, "full", 0);
    const a05 = getSpeciesAssets("oak", {}, undefined, "full", 0.5);
    const a1 = getSpeciesAssets("oak", {}, undefined, "full", 1);
    expect(a0).not.toBe(a05);
    expect(a05).not.toBe(a1);
    expect(a0).not.toBe(a1);
    // …and a repeat of the same stage is the SAME assets — one bake per stage,
    // shared by every tree standing at it.
    expect(getSpeciesAssets("oak", {}, undefined, "full", 0)).toBe(a0);
    // 🚨 AGE 1 IS THE UNCHANGED KEY. An adult tree keeps the exact bake it had
    // before stages existed — which is what leaves every mature stand alone.
    expect(getSpeciesAssets("oak")).toBe(a1);
  });

  it("🚨 a STAGED body is measured against the ADULT, never against itself", () => {
    // The defect this whole seam exists to fix: `resolveScale` divides
    // `heightM` (the registry's adult `bodyHeightM`) by the assets' height. If
    // that height were the SHOOT's own AABB, the shoot would be scaled straight
    // back up to 23.8 m — a full-grown oak wearing a sapling's geometry.
    const adult = getSpeciesAssets("oak", {}, undefined, "full", 1);
    expect(adult.adultHeight).toBe(adult.naturalHeight);

    const shoot = getSpeciesAssets("oak", {}, undefined, "full", 0);
    expect(shoot.naturalHeight).toBeLessThan(adult.naturalHeight * 0.1);
    expect(shoot.adultHeight).toBeCloseTo(adult.naturalHeight, 6);

    // THE DRAWN HEIGHT: the world scale is the adult's, so the shoot stands as
    // tall as its own geometry and no taller.
    const bodyHeightM = naturalSourceOf("oak")!.bodyHeightM!;
    const scale = bodyHeightM / shoot.adultHeight;
    const drawnM = scale * shoot.naturalHeight;
    expect(drawnM).toBeLessThan(1.5);
    expect(drawnM).toBeGreaterThan(0.05);
    // …while the adult is exactly the registry number it always was.
    expect((bodyHeightM / adult.adultHeight) * adult.naturalHeight).toBeCloseTo(bodyHeightM, 6);
  });
});

// ── PART 1 DEFECT 1 — the leaves at `levels === 0` ─────────────────────────

describe("a shoot's leaf cards", () => {
  it("carry the foliage colour and a real normal at levels 0 (nothing black in the MESH)", () => {
    // PART 1 saw BLACK leaf cards on a shoot in the creature lab and could not
    // say where they came from. This is the mesh-side half of that question,
    // asked of the exact geometry the twin bakes: the level-0 leafy-stem path
    // (`emitBranch`: `leafLevel = 0` when `levels === 0`) is exercised by no
    // shipped plant, so ageing is the first thing ever to reach it.
    const bp = agePlantBody(speciesBlueprint("oak"), 0);
    expect(bp.growths[0]!.branching.levels).toBe(0); // the fixture's premise
    const skel = buildSkeleton(bp);
    expect(skel.growths[0]!.leaves.length).toBeGreaterThan(0);

    const geo = buildCreatureMesh(skel, bp).mesh.geometry;
    const col = geo.getAttribute("color");
    const nrm = geo.getAttribute("normal");
    const leaf = new THREE.Color(bp.growths[0]!.foliage.leafColor);
    let leafVerts = 0;
    let up = 0;
    let down = 0;
    for (let i = 0; i < col.count; i++) {
      const near = Math.abs(col.getX(i) - leaf.r) < 1e-3
        && Math.abs(col.getY(i) - leaf.g) < 1e-3
        && Math.abs(col.getZ(i) - leaf.b) < 1e-3;
      if (!near) continue;
      leafVerts++;
      const n = Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      // A DEGENERATE card would compute a zero normal and light as black —
      // the one cause the mesh builder could have owned.
      expect(n).toBeGreaterThan(0.5);
      if (nrm.getY(i) > 0) up++;
      else down++;
    }
    expect(leafVerts).toBeGreaterThan(0);
    // BOTH FACES are emitted (`emitLeafCard` writes each winding with its own
    // vertices), so a card is lit from whichever side the light is on.
    expect(up).toBeGreaterThan(0);
    expect(down).toBeGreaterThan(0);
  });
});

// ── R6 — CUTTABLE vs SUBSTANTIAL ──────────────────────────────────────────

describe("the cut is possible on a sapling; the WOOD is not", () => {
  it("🚨 a sapling IS cuttable — the pin that MOVED", () => {
    // ⚠️ THIS ASSERTION USED TO READ `false`, in this file's sibling
    // (`feature-removal.test.ts` ① — "a seedling is neither"), and the ruling
    // that moved it is the user's own, 2026-09-06: *"technically the player
    // should be given the option to cut saplings if needed, they'll just be
    // deprioritized by automatic designation because they produce less wood."*
    // The act and the yield are two questions; only the second one is about
    // size.
    expect(sourceIsCuttable("apple_tree", 0)).toBe(true);
    expect(sourceIsCuttable("oak", 0)).toBe(true);
    expect(sourceIsCuttable("oak", 1)).toBe(true);
    expect(sourceIsCuttable("oak", 2)).toBe(true);
  });

  it("…and it is STILL not substantial — no wood, no collision, no lot to block", () => {
    expect(sourceIsSubstantial("oak", 0)).toBe(false);
    expect(sourceBlocksBuilding("oak", 0)).toBe(false);
    expect(naturalSourceOf("oak")!.growth!.classes[0]!.yieldMul).toBe(0);
    // The rung above the floor bears, so it is substantial again.
    expect(sourceIsSubstantial("oak", 1)).toBe(true);
    expect(sourceBlocksBuilding("oak", 1)).toBe(true);
  });

  it("the split moved NOTHING else — the animal and the outcrop are untouched", () => {
    expect(sourceIsCuttable("sheep", undefined)).toBe(false);
    expect(sourceIsCuttable("sheep", 0)).toBe(false);
    expect(sourceIsCuttable("rock", undefined)).toBe(false); // one ending only
    expect(sourceIsCuttable("teapot", undefined)).toBe(false);
    expect(sourceIsCuttable("bush", undefined)).toBe(true);
  });
});

// ── R5c / R6b / R7 — THE LIVE HOST ────────────────────────────────────────

const doc = JSON.parse(readFileSync(join(process.cwd(), "scripts", "worlds", "frontier.spec.json"), "utf8"));

/** No plants at all: this block STANDS ITS OWN, at coordinates it chooses, so
 *  the ranking case is decided by rank rather than by whatever the scatter
 *  happened to lay nearest. */
const BARE_MIX: WildMixEntry[] = [{ species: "rock", count: 2 }];

describe("frontier — the staged twin, live", () => {
  let run: TextQuestRun;

  beforeAll(() => {
    run = bootTextQuest({ world: doc, seed: 11, dt: 0.5, wildMix: BARE_MIX });
    run.advance(20);
  }, 600_000);

  afterAll(() => run?.dispose());

  /** `standingFootprints`' own derivation (construction-director), rebuilt from
   *  the exported pieces so this file reads the SAME occupancy the host does. */
  const footprints = () => {
    const t = run.session.town!;
    return settlementFootprints(
      t.stage.center,
      [
        ...t.plan.houses.map((h) => ({ x: h.dx, y: h.dy, w: h.w, h: h.h })),
        ...t.plan.works.map((w) => ({ x: w.dx, y: w.dy, w: w.w, h: w.h })),
      ],
      t.deltas,
    );
  };

  const oakFeature = (id: string, x: number, y: number, sapling: boolean): WildernessFeature => ({
    id,
    species: "oak",
    x,
    y,
    stock: sapling ? { wood: 0 } : { wood: 16 },
    ...(sapling ? { sizeClass: 0 } : {}),
  });

  const bodyOf = (f: WildernessFeature) => run.state.avatars[`flora:${f.species}:${f.id}`];

  it("PRECONDITION — the town stands something, and the ground is otherwise bare", () => {
    expect(footprints().length).toBeGreaterThan(0);
    expect(run.session.wilderness!.features.some((f) => f.species === "oak")).toBe(false);
  }, 600_000);

  it("🏠 R7 — a plant on BUILT ground stands NO BODY, and keeps its record", () => {
    const rect = footprints()[0]!;
    const at = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    const f = oakFeature("wild:oak_indoors", at.x, at.y, true);
    // The fixture's premise, stated in the host's own terms.
    expect(rectsCoverDisc(footprints(), f.x, f.y, wildFeatureRadiusOf(f))).toBe(true);

    // 🚨 IT REPORTS SUCCESS. Nothing was REFUSED — there is simply nothing to
    // stand in a shell — so a caller must not mistake this for a failed spawn
    // and eat the tree.
    expect(run.host.addWildFeature(f)).toBe(true);
    const live = run.session.wilderness!.features.find((x) => x.id === f.id)!;
    expect(live).toBeDefined();
    // The RECORD is untouched: the stock, and therefore every reservation that
    // could ever point at this endpoint, is exactly where it was.
    expect(run.session.containerRecords.has(`flora:oak:${f.id}`)).toBe(true);
    // …and no 24 m oak is standing in the kitchen.
    expect(bodyOf(f)).toBeUndefined();
  }, 600_000);

  it("🌳 R7 — …and it stands again the moment the ground reads clear", () => {
    // ⚠️ WHAT THIS PINS is the SWEEP: the coverage test is re-asked on the
    // ledger sweep the task pool already runs, and a body-less plant whose
    // ground now reads free is stood. Coverage can stop being true from either
    // side of the disc-vs-rect test; the test moves the plant because a headless
    // demolition is a different round's machinery, and the mechanism under test
    // — "who ever asks again?" — is the same either way. (It cannot ride the
    // growth clock: that is only reached by OPENING the container, and a plant
    // with no body has no anchor to open.)
    const live = run.session.wilderness!.features.find((x) => x.id === "wild:oak_indoors")!;
    const rects = footprints();
    const clear = { x: run.session.town!.stage.center.x, y: run.session.town!.stage.center.y - 40 };
    live.x = clear.x;
    live.y = clear.y;
    expect(rectsCoverDisc(rects, live.x, live.y, wildFeatureRadiusOf(live))).toBe(false);
    for (let i = 0; i < 40 && !bodyOf(live); i++) run.advanceS(1);
    expect(bodyOf(live)).toBeDefined();
  }, 600_000);

  it("🌱 R5 — a class advance SWAPS THE BODY under the same container key", () => {
    const live = run.session.wilderness!.features.find((x) => x.id === "wild:oak_indoors")!;
    const key = `flora:oak:${live.id}`;
    const before = run.state.avatars[key];
    expect(before).toBeDefined();
    expect(live.sizeClass).toBe(0);
    // The render's read of the sim, which is the only age anything is allowed
    // to draw (`growthAgeOf` — the sim decides, the render reads).
    expect(growthAgeOf(live.species, live.sizeClass)).toBe(0);

    // Arm the growth clock in the past and run the checkpoint the size-class
    // clock rides (`regrowWildStock` → `growWildFeature`), which a ledger warp
    // settles for every feature at once.
    live.growAt = run.session.taskClock - 1;
    const warp = run.warpDays(1);
    expect(warp.ok).toBe(true);

    expect(live.sizeClass).toBe(1);
    expect(growthAgeOf(live.species, live.sizeClass)).toBe(0.5);
    // 🚨 THE KEY DID NOT MOVE, AND THE BODY DID. A stage is baked into the
    // body, so the only way to draw the new one is to stand it again — through
    // `standWildFeature`, the ONE body↔heap swap, which re-enters the model
    // factory and re-reads the age.
    expect(run.state.avatars[key]).toBeDefined();
    expect(run.state.avatars[key]).not.toBe(before);
    expect(run.session.containerRecords.has(key)).toBe(true);
  }, 600_000);

  it("🪓 R6 — the automatic chooser puts a SAPLING LAST", () => {
    // *"they'll just be deprioritized by automatic designation because they
    // produce less wood."* A spoken "cut the tree" IS the automatic chooser.
    // The staged tree the cases above grew is a YOUNG oak now — substantial,
    // and therefore a perfectly good answer to "cut the tree". Take it out so
    // the choice below is between exactly two candidates.
    expect(run.host.removeWildFeature("wild:oak_indoors")).toBe(true);
    const c = run.session.town!.stage.center;
    const sapling = oakFeature("wild:oak_near_sapling", c.x + 6, c.y - 34, true);
    const mature = oakFeature("wild:oak_far_mature", c.x + 24, c.y - 52, false);
    // The sapling goes in FIRST and stands NEARER, so nothing but the rank can
    // choose the mature tree.
    expect(run.host.addWildFeature(sapling)).toBe(true);
    expect(run.host.addWildFeature(mature)).toBe(true);
    const book = run.session.town!.deltas;
    const marksBefore = book.fellOrders().length;

    run.speak("cut + tree");

    const marked = book.fellOrders().slice(marksBefore);
    const commanded = [...run.session.pursuits.values()].filter((p) => p.bill?.link === "fell");
    const target = marked[0]?.featureId ?? commanded[0]?.bill?.objId ?? "";
    expect(target).toContain(mature.id);
    expect(target).not.toContain(sapling.id);
  }, 600_000);
});
