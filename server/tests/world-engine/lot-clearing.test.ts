// ⚖️ A TREE IN THE WAY IS A PREREQUISITE TASK, NOT A REFUSAL.
//
// User ruling, 2026-09-02, verbatim: *"if a tree is in the way of a
// construction, making felling that tree a required task that is assigned
// automatically as a prerequisite"*, and its second half: *"Or just make it
// that trees won't grow if a building is already there, and there is a minimum
// growth level below which they are ignored."*
//
// The two halves are one mechanism and this file pins it as one:
//
//   1. a MATURE tree standing on a staked lot is recorded on the row as
//      required work — never a refusal, never a silent deletion;
//   2. felling it RE-SEEDS it at the identical spot (the S3 H2 growth law,
//      untouched — this round changed nothing about it);
//   3. the re-seeded SAPLING is below the obstruction floor, so the lot now
//      reads FREE and the build proceeds;
//   4. the building standing over that sapling suppresses its growth clock, so
//      it never becomes a tree inside somebody's house.
//
// Step 3 is what makes step 1 terminate for a TREE, and it is why the felling
// round needed no removal semantic of its own. The sequence is walked end to
// end in the last describe block, because each piece being right individually
// is exactly how the deadlock would have been shipped.
//
// ⚖️ SUPERSEDED IN PART, 2026-09-02 (the removal round, then the cut round the
// same day). A harvest-only source was ruled NOT a blocker here, on a
// termination argument: felling can never end a bush, so staking one would be
// work nobody could finish. THE CUT (`sourceIsCuttable`, the host's
// `cutWildFeature`, the clearing sweep's one arm) is that work, so
// `sourceBlocksBuilding` widened to substantial-full-stop and the bush cases
// below assert the opposite of what they used to.
//
// ⚠️ WHAT THE CUT ROUND CHANGED UNDER THIS FILE. Felling stopped being an
// ARITHMETIC CONSEQUENCE of hauling a tree empty and became an ACT: the sweep
// CUTS the blocker, the trunk stays as a heap of its own timber, the haul
// carries that away, and the spent heap re-seeds. Every step of the sequence
// this file walks is still there and still terminates — one extra state
// (`downed`) now sits between "standing" and "gone".
//
// 🚫 The clearing a session's scatter used to do at mount time (`clearR` /
// `clearAt`) is GONE as of the arrival ruling one day later — *"the land
// should still be untouched"* (`arrival-untouched.test.ts`), which is the
// round these rules were the prerequisite for. Nothing here changed with it:
// every test below CONSTRUCTS the occupied state directly rather than waiting
// for it to occur, so the two rounds are pinned independently.

import { describe, it, expect } from "@jest/globals";
import {
  naturalSources,
  obstructingGrowthClass,
  sourceBlocksBuilding,
  sourceDepletes,
  sourceIsCuttable,
  sourceIsSubstantial,
  standingGrowthClass,
  naturalSourceOf,
} from "@shared/world-engine/products.js";
import {
  clearingPending,
  createTownDeltas,
  discOverlapsRect,
  featuresOnFootprint,
  rectsCoverDisc,
  settlementFootprints,
  type GroundFeature,
  type Rect,
} from "@shared/world-engine/kernel/town/construction.js";
import { clearFirstLine } from "@shared/world-engine/interaction/dialogue/placement-lines.js";
import {
  wildFeatureRadius,
  wildFeatureRadiusOf,
} from "@shared/world-engine/interaction/quest/wilderness.js";

// ── ① THE THRESHOLD IS READ OFF THE LADDER, NEVER PAINTED ──────────────────

describe("the obstruction threshold", () => {
  it("floors at the first class that bears anything", () => {
    const oak = naturalSourceOf("oak")!.growth!;
    // sapling(0) / young(.25) / mature(1) — the floor is `young`.
    expect(obstructingGrowthClass(oak)).toBe(1);
    expect(oak.classes[1]!.name).toBe("young");

    const apple = naturalSourceOf("apple_tree")!.growth!;
    // sapling(0) / mature(1) — a two-rung ladder floors at its top.
    expect(obstructingGrowthClass(apple)).toBe(1);
    expect(apple.classes[1]!.name).toBe("mature");
  });

  it("is not a number this test could have been written without", () => {
    // The point of deriving it: every growth-bearing source answers the same
    // question the same way, with nothing species-specific written down.
    for (const species of ["oak", "apple_tree"]) {
      const g = naturalSourceOf(species)!.growth!;
      const floor = obstructingGrowthClass(g);
      expect(g.classes[floor]!.yieldMul).toBeGreaterThan(0);
      for (let i = 0; i < floor; i++) expect(g.classes[i]!.yieldMul).toBe(0);
    }
  });

  it("reads an UNSET sizeClass as mature — the scatter's own default", () => {
    const oak = naturalSourceOf("oak")!.growth!;
    expect(standingGrowthClass("oak", undefined)).toBe(oak.classes.length - 1);
    expect(standingGrowthClass("oak", 0)).toBe(0);
    // A source with no ladder has no class to stand at.
    expect(standingGrowthClass("rock", undefined)).toBe(0);
  });
});

describe("what counts as standing there", () => {
  it("a sapling is not a thing; a young tree is", () => {
    expect(sourceIsSubstantial("oak", 0)).toBe(false);
    expect(sourceIsSubstantial("oak", 1)).toBe(true);
    expect(sourceIsSubstantial("oak", 2)).toBe(true);
    expect(sourceIsSubstantial("oak", undefined)).toBe(true); // freshly scattered
  });

  it("a rock is always a rock — no ladder, no sub-threshold state", () => {
    expect(sourceIsSubstantial("rock", undefined)).toBe(true);
    expect(sourceIsSubstantial("rock", 0)).toBe(true);
  });

  it("blocks a build whenever something substantial is standing there", () => {
    expect(sourceBlocksBuilding("oak", undefined)).toBe(true);
    expect(sourceBlocksBuilding("rock", undefined)).toBe(true);
    // ⚖️ WIDENED 2026-09-02 (the removal round). These two answered FALSE while
    // the predicate carried a second "and fellable" clause — a berry bush was
    // ruled scenery because staking it would have been work nobody could
    // finish. The cut is the work that finishes it (`sourceIsCuttable`), so
    // the exception has nothing left to stand on and occupancy is decided by
    // occupancy again.
    expect(sourceBlocksBuilding("banana_plant", undefined)).toBe(true);
    expect(sourceBlocksBuilding("grape_vine", undefined)).toBe(true);
    // …and never a sapling, whatever else is true of it. The FLOOR is what
    // terminates the growth case, and this round did not touch it.
    expect(sourceBlocksBuilding("oak", 0)).toBe(false);
    expect(sourceBlocksBuilding("apple_tree", 0)).toBe(false);
    // Nothing the catalogue never heard of is ever staked.
    expect(sourceBlocksBuilding("teapot", undefined)).toBe(false);
  });

  it("every standing blocker has exactly ONE ending — cut, or worn away", () => {
    // 🚨 THE ONE-ENDING LAW. `sourceDepletes` ends an outcrop (taken from until
    // it is spent); `sourceIsCuttable` ends everything else, at an act. If a
    // source could be both, one standing thing would have two ways to stop
    // standing; if it could be neither, the stake it earns would never
    // terminate — which is precisely the deadlock the old "and fellable"
    // clause was dodging. Walked over the whole catalogue so a NEW row cannot
    // slip through in either direction.
    //
    // ⚠️ THE KEY IS NO LONGER "has a kill product". Under the cut round an oak
    // and a bush are equally cuttable — the yield is a consequence of the
    // plant's products, never a gate on the verb — and this assertion read the
    // opposite way round until that ruling landed.
    //
    // ⚠️ …NOR IS IT "depletes at all". A source may bear fruit, deplete a fibre
    // AND yield timber only when felled (products.ts' own header); having
    // substance to give up is what makes it cuttable, so only a PURE-deplete
    // source keeps the outcrop's ending. And a CREATURE is on no ladder here —
    // a wilderness body is never staked as lot clearing at all.
    for (const src of naturalSources()) {
      if (src.kind === "animal") continue;
      if (!sourceBlocksBuilding(src.species, undefined)) continue;
      const pureDeplete = sourceDepletes(src) && !src.products.some((p) => p.method === "kill");
      expect(sourceIsCuttable(src.species, undefined)).toBe(!pureDeplete);
    }
  });
});

// ── ② ONE GEOMETRY, READ FROM BOTH ENDS ────────────────────────────────────

describe("footprint ∩ wilderness", () => {
  const lot: Rect = { x: 10, y: 10, w: 8, h: 6 };

  it("a disc counts when it touches the rect, not only when its centre is in", () => {
    expect(discOverlapsRect(lot, 14, 13, 0.5)).toBe(true); // centre inside
    expect(discOverlapsRect(lot, 9.6, 13, 0.5)).toBe(true); // trunk grazes the wall
    expect(discOverlapsRect(lot, 9.0, 13, 0.5)).toBe(false); // a metre clear
    expect(discOverlapsRect(lot, 9.0, 13, 0.5, 1.0)).toBe(true); // …until padded
  });

  it("corners are measured as corners, not as bounding boxes", () => {
    // The clamp is what makes this right: a disc off the corner is further
    // away than either axis alone says.
    expect(discOverlapsRect(lot, 9.5, 9.5, 0.6)).toBe(false);
    expect(discOverlapsRect(lot, 9.7, 9.7, 0.6)).toBe(true);
  });

  it("names every blocker on the lot, in the order it was given", () => {
    const features: GroundFeature[] = [
      { id: "wild:oak_0", x: 0, y: 0, r: 0.7 },
      { id: "wild:oak_1", x: 13, y: 12, r: 0.7 },
      { id: "wild:rock_0", x: 17.5, y: 15.5, r: 0.5 },
    ];
    expect(featuresOnFootprint(lot, features)).toEqual(["wild:oak_1", "wild:rock_0"]);
  });

  it("is the SAME test the growth rule asks from the other end", () => {
    // One derivation, two readers: the builder asks "which features are on my
    // lot?", the clock asks "is a lot on top of me?". Same answer, always.
    const f = { x: 13, y: 12, r: 0.7 };
    expect(featuresOnFootprint(lot, [{ id: "f", ...f }])).toEqual(["f"]);
    expect(rectsCoverDisc([lot], f.x, f.y, f.r)).toBe(true);

    const away = { x: 40, y: 40, r: 0.7 };
    expect(featuresOnFootprint(lot, [{ id: "f", ...away }])).toEqual([]);
    expect(rectsCoverDisc([lot], away.x, away.y, away.r)).toBe(false);
  });
});

describe("the ground a settlement occupies", () => {
  it("lifts settlement-local rects into world coords", () => {
    const deltas = createTownDeltas();
    const rects = settlementFootprints({ x: 100, y: 200 }, [{ x: -5, y: -4, w: 8, h: 6 }], deltas);
    expect(rects).toEqual([{ x: 95, y: 196, w: 8, h: 6 }]);
  });

  it("counts a RISING founded row, not only a finished one", () => {
    // A staked plot is spoken-for ground the moment it is staked — that is the
    // whole point of staking it, and it is what stops a sapling maturing
    // inside a half-built wall while the builders are still hauling.
    const deltas = createTownDeltas();
    deltas.foundBuilding(
      { type: "house", slot: 0, dx: 2, dy: 3, w: 9, h: 8, door: "north" },
      0, 1, { wood: 6 },
    );
    const rects = settlementFootprints({ x: 0, y: 0 }, [], deltas);
    expect(rects).toEqual([{ x: 2, y: 3, w: 9, h: 8 }]);
    expect(rectsCoverDisc(rects, 6, 7, 0.7)).toBe(true);
  });
});

// ── ③ THE STAKE ────────────────────────────────────────────────────────────

describe("the felling stake on a founded row", () => {
  const found = () => {
    const deltas = createTownDeltas();
    const b = deltas.foundBuilding(
      { type: "house", slot: 0, dx: 0, dy: 0, w: 9, h: 8, door: "north" },
      0, 1, { wood: 6 },
    );
    return { deltas, b };
  };

  it("is absent on open ground and pending once staked", () => {
    const { b } = found();
    expect(clearingPending(b)).toBe(false);
    b.clearing = ["wild:oak_3"];
    expect(clearingPending(b)).toBe(true);
    delete b.clearing;
    expect(clearingPending(b)).toBe(false);
  });

  it("survives a save/reload — required work is not a session opinion", () => {
    const { deltas, b } = found();
    b.clearing = ["wild:oak_3", "wild:rock_1"];
    const back = createTownDeltas(deltas.toJSON());
    const row = back.founded().find((f) => f.ord === b.ord)!;
    expect(row.clearing).toEqual(["wild:oak_3", "wild:rock_1"]);
    expect(clearingPending(row)).toBe(true);
  });
});

// ── ④ WHAT IT SAYS ─────────────────────────────────────────────────────────

describe("the spoken prerequisite", () => {
  it("names the blocking noun in the causal shape, and is not a refusal", () => {
    const line = clearFirstLine("house", "plants");
    expect(line.a).toBe("here");
    expect(line.b).toBe("because + plants + here");
    expect(line.c).toBe("i_me + put.not + house + because + plants + here");
    // 🚨 NOT a bare "no" GLYPH: the order was accepted and the work was
    // staked, so the refusal token must not appear as a symbol of its own
    // (`put.not` is the verb's negation, which is a different claim).
    expect(line.c.split(" + ")).not.toContain("no");
  });
});

// ── ⑤ THE WHOLE LAW, END TO END ────────────────────────────────────────────

describe("fell → re-seed → build → stay a sapling", () => {
  // The lot the house is staked on, world coords.
  const lot: Rect = { x: 0, y: 0, w: 9, h: 8 };
  // The oak, standing dead centre of it.
  const at = { x: 4.5, y: 4 };

  const blockersOn = (rect: Rect, f: { species: string; sizeClass?: number; stock: Record<string, number> }) =>
    sourceBlocksBuilding(f.species, f.sizeClass)
      ? featuresOnFootprint(rect, [
          { id: "wild:oak_0", x: at.x, y: at.y, r: wildFeatureRadius(f.species, f.stock) },
        ])
      : [];

  it("terminates — and terminates WITHOUT a removal semantic", () => {
    // ① A MATURE OAK IS IN THE WAY. The order is not refused; it is staked.
    const mature = { species: "oak", stock: { wood: 16 } };
    expect(blockersOn(lot, mature)).toEqual(["wild:oak_0"]);

    // ② FELLED — the wood is hauled off through the ordinary material path
    // (that is what makes it feed the bill) and the kill stock empties. The
    // growth law then RE-SEEDS the feature at the identical spot, class 0.
    // Nothing about that law was changed by this round; this is just what it
    // already does, and what a naive prerequisite would have deadlocked on.
    const reseeded = { species: "oak", sizeClass: 0, stock: { wood: 0 } };

    // ③ …AND THE SAPLING IS NOT IN ANYBODY'S WAY. The lot reads FREE.
    expect(blockersOn(lot, reseeded)).toEqual([]);

    // ④ THE HOUSE GOES UP OVER IT, and the ground it stands on is occupied —
    // so the clock never climbs and the sapling never becomes a tree indoors.
    const built = settlementFootprints({ x: 0, y: 0 }, [{ x: 0, y: 0, w: 9, h: 8 }], null);
    expect(rectsCoverDisc(built, at.x, at.y, wildFeatureRadius("oak", reseeded.stock))).toBe(true);
  });

  it("a YOUNG tree still blocks — the floor is bearing, not felled-ness", () => {
    // The rung between sapling and mature is real work and real timber, so it
    // is real obstruction. (Its stock is small, so its DRAWN radius shrinks —
    // which must not be mistaken for being below the threshold: size on the
    // ground and growth class are two different facts.)
    const young = { species: "oak", sizeClass: 1, stock: { wood: 4 } };
    expect(sourceBlocksBuilding(young.species, young.sizeClass)).toBe(true);
    expect(blockersOn(lot, young)).toEqual(["wild:oak_0"]);
  });

  // ── ⚖️ OCCUPANCY IS MEASURED AT THE CLASS THE TREE ACTUALLY STANDS AT ─────
  //
  // 🚨 `wildFeatureRadius(species, stock)` WITH NO OPTS MEANS MATURE AND
  // STANDING — not "don't care". Three occupancy sites built the opts by hand
  // and one of them (`wildFeatureFootprint`) got it right, so the other three
  // silently measured every feature at its grown size: the founding mount
  // refused to lay saplings that fit, the near-stand step skipped them, and —
  // worst — the growth clock tested a class-0 sapling against a mature oak's
  // disc, suppressing the very clock it needs to climb. `wildFeatureRadiusOf`
  // is the ONE derivation now; these tests pin the difference it makes.

  describe("a sapling is measured as a sapling", () => {
    const mature = { species: "oak", stock: { wood: 16 } };
    const sapling = { species: "oak", sizeClass: 0, stock: { wood: 0 } };

    it("draws strictly smaller than the grown tree it will become", () => {
      expect(wildFeatureRadiusOf(sapling)).toBeLessThan(wildFeatureRadiusOf(mature));
      // …and the opt-less call is the MATURE answer, which is exactly why
      // omitting the class is a claim and not an abstention.
      expect(wildFeatureRadiusOf(mature)).toBeCloseTo(wildFeatureRadius("oak", mature.stock), 6);
    });

    it("🌱 clears a wall the mature tree's disc would have covered", () => {
      // A lot wall at x = 9, with the feature standing just outside it. The
      // grown oak's trunk grazes the wall; the sapling is a clear half-metre off
      // it — so the mount lays it, the stand step deals it, and the growth clock
      // lets it climb, all three of which used to answer the other way.
      const built = settlementFootprints({ x: 0, y: 0 }, [{ x: 0, y: 0, w: 9, h: 8 }], null);
      const just = { x: 9 + 0.5, y: 4 };
      expect(rectsCoverDisc(built, just.x, just.y, wildFeatureRadiusOf(mature))).toBe(true);
      expect(rectsCoverDisc(built, just.x, just.y, wildFeatureRadiusOf(sapling))).toBe(false);
      // 🚨 THE BUG IN ONE LINE: measured the old way, the sapling reads as
      // covered — the grown tree's footprint applied to a thing that is not
      // there yet.
      expect(rectsCoverDisc(built, just.x, just.y, wildFeatureRadius("oak", sapling.stock))).toBe(true);
    });

    it("a DOWNED trunk is measured off what is left of it, not off its class", () => {
      // The other half of the opts. A felled oak whose timber has been hauled
      // is a small heap; standing, the same stock would still read mature.
      const emptied = { species: "oak", downed: true, stock: { wood: 0 } };
      const full = { species: "oak", downed: true, stock: { wood: 16 } };
      expect(wildFeatureRadiusOf(emptied)).toBeLessThan(wildFeatureRadiusOf(full));
      expect(wildFeatureRadiusOf(emptied)).toBeLessThan(wildFeatureRadiusOf(mature));
    });
  });

  it("a fruit bush on the lot IS a blocker now — and the CUT is what ends it", () => {
    // ⚖️ 2026-09-02, the removal round. This used to assert the opposite: no
    // kill product ⇒ no last unit whose taking is the felling ⇒ no work anybody
    // could finish, so the walls went up around the bush. Now the clearing
    // sweep cuts it — the berries come off it and then it is out of the ground
    // — so the stake terminates and the lot is honestly occupied until it does.
    expect(blockersOn(lot, { species: "grape_vine", stock: { grape: 2 } })).toEqual(["wild:oak_0"]);
    expect(sourceIsCuttable("grape_vine", undefined)).toBe(true);
    // ⚠️ …AND SO IS THE OAK'S, which is the cut round's correction on top of
    // the removal round's. This line asserted FALSE for one day: the sweep had
    // a removal arm and a felling arm, and a child pressing `cut` on a tree was
    // told no. One act, both blockers.
    expect(sourceIsCuttable("oak", undefined)).toBe(true);
    // ⚠️ PIN MOVED 2026-09-06 (PLANTS GROW LIKE PLANTS, R6). This read
    // `sourceIsCuttable("apple_tree", 0) === false` — "a seedling is neither".
    // The user split the two halves (*"technically the player should be given
    // the option to cut saplings if needed, they'll just be deprioritized by
    // automatic designation because they produce less wood"*): the ACT is
    // offered on a seedling, and everything THIS FILE is about — the lot, the
    // stake, the bill — is the OTHER predicate, unmoved. A seedling is still in
    // nobody's way, and that is what the two lines below assert.
    expect(sourceIsCuttable("apple_tree", 0)).toBe(true);
    expect(sourceBlocksBuilding("apple_tree", 0)).toBe(false);
    expect(blockersOn(lot, { species: "apple_tree", sizeClass: 0, stock: { wood: 0 } })).toEqual([]);
  });
});
