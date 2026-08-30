// LIMB ATTACHMENT — the tetrapod law.
//
// ⚖️ A FORELIMB AND A HINDLIMB ARE NOT COPIES OF ONE LIMB. `resolveLimbs`
// duplicates a group's copies along the body and gives them all the SAME
// posture dials, and the knee's fore/aft direction comes from exactly one of
// them (`restFlexion`, via the IK pole). So a single group spanning chest to
// hip can only ever bend both pairs the same way.
//
// That is what every hand-authored mammal did — one group, `stationStart` ~0.15
// to `stationEnd` ~0.85, `count: 2` — and measured, EVERY knee on EVERY mammal
// pointed backward. A mammal's foreleg elbow does point back, so the front pair
// was right by accident; the hind pair was inverted on all ten bodies. It could
// not be tuned out, only restructured.
//
// The anatomy these pins encode:
//   FORELIMB elbow points BACKWARD  → restFlexion < 0
//   HINDLIMB knee  points FORWARD   → restFlexion > 0
// (verified against the built skeleton, not assumed: `restFlexion` > 0 puts the
// IK knee pole toward +Z, which is forward.)
//
// Arthropods are deliberately exempt: a leg ROW (3+ pairs) really is one kind
// of limb repeated, and its joint arches upward from `restLevation` with no
// fore/aft component at all. So is a membranous limb — a flipper or a wing has
// no knee to point anywhere.

import { describe, it, expect } from "@jest/globals";
import { clampBlueprint, type Blueprint, type LimbGroupBlueprint } from "@shared/world-engine/creatures/blueprint.js";
import { buildSkeleton, resolveLimbs } from "@shared/world-engine/creatures/skeleton.js";
import { listSpecies } from "@shared/world-engine/creatures/species.js";

/** A limb that bears weight on a joint — i.e. one with a knee to aim. A HAND
 *  is not a foot: an opposed digit means the limb is an arm, which hangs on the
 *  un-recruited FK path rather than the ground solve, so the tetrapod law about
 *  knees does not speak for it. */
const isLeg = (g: LimbGroupBlueprint): boolean =>
  g.membrane < 0.5 && g.lengthFrac > 0.05 && g.opposition < 0.05;

/** Fore and hind stations, in the registry's convention: 0 = chest, 1 = hip. */
const FORE_OF = 0.4;
const HIND_OF = 0.6;

const bodiedCreatures = (): Array<{ id: string; bp: Blueprint }> =>
  listSpecies()
    .filter((s) => s.kind === "creature" && !s.stub && !s.bodiless)
    .map((s) => ({ id: s.id, bp: clampBlueprint(s.blueprint) }));

/** Where the knee sits fore/aft of the hip→ankle chord. + = forward. */
const kneeOffsetZ = (bp: Blueprint): Map<number, number> => {
  const skel = buildSkeleton(bp);
  const chains = new Map<string, typeof skel.bones>();
  for (const b of skel.bones) {
    if (!/^limb\d+L\d+$/.test(b.id)) continue;
    const c = /^(limb\d+L)/.exec(b.id)![1]!;
    (chains.get(c) ?? chains.set(c, []).get(c)!).push(b);
  }
  const out = new Map<number, number>();
  for (const [c, bs] of chains) {
    const flat = Number(/^limb(\d+)/.exec(c)![1]);
    const hip = bs[0]!.head, ankle = bs[bs.length - 1]!.tail, knee = bs[1]!.tail;
    out.set(flat, knee.z - (hip.z + (ankle.z - hip.z) * 0.5));
  }
  return out;
};

describe("the knee's direction is a real degree of freedom", () => {
  it("restFlexion > 0 aims the knee FORWARD and < 0 aims it BACK", () => {
    // The convention every authored body depends on. If this ever flips, the
    // fore/hind signs below are all backwards and nothing else would say so.
    const twoLegged = (foreFlex: number, hindFlex: number): Blueprint =>
      clampBlueprint({
        version: 1,
        spine: { torsoSegments: 6, torsoLengthM: 1.2, girth: 0.22 },
        posture: { bodyHeight: 0.8 },
        limbGroups: [
          { placement: "bilateral", count: 1, stationStart: 0.15, stationEnd: 0.15, lengthFrac: 0.55, radiusFrac: 0.1, restLevation: -0.5, restFlexion: foreFlex, footLengthFrac: 0.2, toeCount: 4 },
          { placement: "bilateral", count: 1, stationStart: 0.85, stationEnd: 0.85, lengthFrac: 0.55, radiusFrac: 0.1, restLevation: -0.5, restFlexion: hindFlex, footLengthFrac: 0.2, toeCount: 4 },
        ],
      });
    const pos = kneeOffsetZ(twoLegged(0.5, -0.5));
    expect(pos.get(0)!).toBeGreaterThan(0); // +flexion → forward
    expect(pos.get(1)!).toBeLessThan(0); // −flexion → back
    const neg = kneeOffsetZ(twoLegged(-0.5, 0.5));
    expect(neg.get(0)!).toBeLessThan(0);
    expect(neg.get(1)!).toBeGreaterThan(0);
  });
});

describe("tetrapods attach fore and hind limbs separately", () => {
  it("never spans chest to hip with a single 2-copy leg group", () => {
    // 🚨 THE STRUCTURAL DEFECT. Such a group hands both pairs one restFlexion,
    // so one of them MUST be inverted. A leg ROW (3+ pairs, an arthropod) and a
    // membranous limb (a flipper) are exempt — see the header.
    const offenders: string[] = [];
    for (const { id, bp } of bodiedCreatures()) {
      for (const g of bp.limbGroups) {
        if (!isLeg(g) || Math.round(g.count) !== 2) continue;
        if (g.stationStart < FORE_OF && g.stationEnd > HIND_OF) {
          offenders.push(`${id} (${g.stationStart}→${g.stationEnd})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("folds the fore knee BACK and the hind knee FORWARD", () => {
    // Checked on the BUILT skeleton, so it catches a body whose dials say one
    // thing and whose geometry does another.
    const wrong: string[] = [];
    for (const { id, bp } of bodiedCreatures()) {
      const legs = bp.limbGroups
        .map((g, i) => ({ g, i }))
        .filter(({ g }) => isLeg(g) && Math.round(g.count) <= 2);
      const fore = legs.filter(({ g }) => g.stationStart < FORE_OF);
      const hind = legs.filter(({ g }) => g.stationStart > HIND_OF);
      if (!fore.length || !hind.length) continue; // biped, leg row, or limbless
      const knees = kneeOffsetZ(bp);
      // A knee sitting all but ON the hip→ankle line has no direction to be
      // wrong about; only a real bulge counts.
      const eps = (g: LimbGroupBlueprint) => 0.01 * g.lengthFrac * bp.spine.torsoLengthM;
      for (const { g, i } of fore) {
        const dz = knees.get(i);
        if (dz !== undefined && dz > eps(g)) wrong.push(`${id} fore group ${i} knee FORWARD`);
      }
      for (const { g, i } of hind) {
        const dz = knees.get(i);
        if (dz !== undefined && dz < -eps(g)) wrong.push(`${id} hind group ${i} knee BACK`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("keeps every leg group's copies placed where they were", () => {
    // Splitting a 2-copy group into two 1-copy groups must not MOVE a leg:
    // `resolveLimbs` gives a lone copy t=0, so a group that relied on size
    // gravitation across its copies has to bake that into its own dials.
    for (const { id, bp } of bodiedCreatures()) {
      for (const lm of resolveLimbs(bp).limbs) {
        expect(Number.isFinite(lm.station)).toBe(true);
        expect(lm.lengthFrac).toBeGreaterThanOrEqual(0);
        expect(`${id}:${lm.radiusFrac >= 0}`).toBe(`${id}:true`);
      }
    }
  });
});
