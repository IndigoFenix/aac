// DIGITS (skeleton.ts `addDigits`): the toe/finger row at a limb's contact
// point. Two laws, both from the user, both previously absent:
//
//   ⚖️ A DIGIT IS A SPLIT IN THE FOOT — "a single toe should be the width of
//      the whole foot, two should be about half each, and so on." Radius is
//      `ballR / n` and the ROW OF ROOTS tiles the foot's width. The old
//      `1.15/√n` claimed to match the limb-tip girth but at five digits laid
//      out a row 2.6× the foot's width, all sprouting from one point: a blob
//      on a stump rather than a foot split five ways.
//
//   ⚖️ A THICK LIMB DEMANDS A WIDE PAD, NOT LONG TOES — the FOOT-FUNCTION
//      round. There used to be a floor here: a digit had to clear the ball it
//      grew from, because a buried toe is a bump. True, and in the wrong
//      place — the ball is a function of LIMB GIRTH, so on any thick-legged
//      body the floor was always the binding term, `toeLengthFrac` did
//      nothing at all, and the elephant wore 40 cm toes on a 25 cm foot. The
//      floor moved to `padFrac` (the fat fill of the heel and ankle, which is
//      what actually keeps a fat leg from ending in a tassel), and the digit
//      length is now exactly what was authored, at every girth.
//
//   ⚖️ THE TOES ARE A CONDITIONAL EXTENSION OF THE FOOT. Below
//      `TOE_ALIGN_START` a digit lies flat and hinges at the ball; above it
//      the digits swing into line with the foot column and the body stands on
//      their TIPS (unguligrade), which is where a keratin cap comes from —
//      derived from `stance`, never authored.
//
// Pure geometry — no GL, no DOM, like the sibling creature suites.

import { describe, it, expect } from "@jest/globals";
import {
  buildSkeleton,
  resolveLimbs,
  halfWidthFactor,
  FOOT_FLATTEN,
  type CreatureBone,
} from "@shared/world-engine/creatures/skeleton.js";
import { buildCreatureMesh } from "@shared/world-engine/creatures/mesh.js";
import { clampBlueprint, type Blueprint } from "@shared/world-engine/creatures/blueprint.js";
import { requireSpecies } from "@shared/world-engine/creatures/species.js";

const boneLen = (b: CreatureBone): number =>
  Math.hypot(b.tail.x - b.head.x, b.tail.y - b.head.y, b.tail.z - b.head.z);

const digitIndex = (chain: string): number => Number(/d(\d+)$/.exec(chain)![1]);

/** The digits of one limb copy, in row order. */
const digitsOf = (bones: readonly CreatureBone[], chain: string): CreatureBone[] =>
  bones
    .filter((b) => new RegExp("^" + chain + "d\\d+$").test(b.chain))
    .sort((a, b) => digitIndex(a.chain) - digitIndex(b.chain));

/** The foot ball's RADIUS for a group — the same quantity `addDigits` uses. */
const ballRadius = (bp: Blueprint, group: number): number => {
  const lm = resolveLimbs(bp).limbs.find((l) => l.group === group)!;
  return lm.radiusFrac * bp.spine.girth * bp.spine.torsoLengthM * lm.taper * 1.05;
};

/**
 * The sole's RENDERED half-width. ⚠️ NOT `ballRadius`: a sole lofts with
 * `flatten = FOOT_FLATTEN`, which widens the ring to `r * halfWidthFactor(f)`.
 * Sizing the digit row off the bare bone radius is exactly the bug these pins
 * exist to stop — it laid the row across 1/1.56 of the foot it should tile.
 */
const soleHalfWidth = (bp: Blueprint, group: number): number =>
  ballRadius(bp, group) * halfWidthFactor(FOOT_FLATTEN);

/** Foot length — what `toeLengthFrac` is a fraction OF. */
const footLength = (bp: Blueprint, group: number): number => {
  const lm = resolveLimbs(bp).limbs.find((l) => l.group === group)!;
  return lm.footLengthFrac * lm.lengthFrac * bp.spine.torsoLengthM;
};

/** Outer edge to outer edge across the row of digit ROOTS. */
const rootRowWidth = (ds: readonly CreatureBone[]): number => {
  const xs = ds.map((d) => d.head.x);
  const zs = ds.map((d) => d.head.z);
  const span = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  return span + 2 * Math.max(...ds.map((d) => d.radiusHead));
};

/** A plain quadruped with one limb group, so the digit row is unambiguous. */
const testBody = (over: Record<string, unknown> = {}): Blueprint =>
  clampBlueprint({
    version: 1,
    spine: { torsoSegments: 5, torsoLengthM: 1, girth: 0.3 },
    limbGroups: [
      {
        placement: "bilateral",
        count: 2,
        stationStart: 0.2,
        stationEnd: 0.8,
        lengthFrac: 0.5,
        radiusFrac: 0.15,
        taper: 0.6,
        footLengthFrac: 0.25,
        toeCount: 4,
        toeLengthFrac: 0.6,
        toeSpread: 0.5,
        toeContrast: 0,
        opposition: 0,
        toeCurl: 0,
        ...over,
      },
    ],
  });

const SIDES = 8; // LOFT.sides — the ring resolution these pins assume

/** Vertex indices of each `limb0L…` section of a built mesh, in emit order. */
const limbSections = (bp: Blueprint): Map<string, Array<readonly [number, number, number]>> => {
  const built = buildCreatureMesh(buildSkeleton(bp), bp, { debugTags: true });
  const pos = built.mesh.geometry.getAttribute("position");
  const out = new Map<string, Array<readonly [number, number, number]>>();
  for (let i = 0; i < pos.count; i++) {
    const sec = built.sections[i] ?? "";
    if (!/^limb:limb0L(d\d+)?$/.test(sec)) continue;
    const arr = out.get(sec) ?? [];
    arr.push([pos.getX(i), pos.getY(i), pos.getZ(i)] as const);
    out.set(sec, arr);
  }
  return out;
};

/** Digit sections in row order. `loftChain` emits ring0 then ring1, so the
 *  FIRST `SIDES` vertices of a digit section are its base ring. */
const digitSections = (
  secs: Map<string, Array<readonly [number, number, number]>>,
): Array<Array<readonly [number, number, number]>> =>
  [...secs.keys()]
    .filter((k) => k !== "limb:limb0L")
    .sort((a, b) => Number(/d(\d+)$/.exec(a)![1]) - Number(/d(\d+)$/.exec(b)![1]))
    .map((k) => secs.get(k)!);

const spread = (pts: Array<readonly [number, number, number]>): number => {
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[2]);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
};

/** Width of the whole row of digit BASES as actually built. */
const renderedRowWidth = (n: number): number => {
  const bases = digitSections(limbSections(testBody({ toeCount: n }))).map((d) => d.slice(0, SIDES));
  return spread(bases.flat());
};

describe("digits — a split in the foot", () => {
  it("gives ONE digit the whole foot's width and N digits a 1/N share each", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const bp = testBody({ toeCount: n });
      const ds = digitsOf(buildSkeleton(bp).bones, "limb0L");
      expect(ds).toHaveLength(n);
      const ballR = ballRadius(bp, 0);
      for (const d of ds) {
        // 📕 THE USER'S RULE, LITERALLY: each digit is 1/n of the foot.
        expect(d.radiusHead).toBeCloseTo(ballR / n, 6);
      }
    }
  });

  it("spaces the roots across the sole's RENDERED width, not its bone radius", () => {
    for (const n of [2, 3, 4, 5]) {
      const bp = testBody({ toeCount: n });
      const ds = digitsOf(buildSkeleton(bp).bones, "limb0L");
      const W = soleHalfWidth(bp, 0);
      const slot = W / n; // half a slot = the digit's own rendered half-width
      // Outermost slot centres sit one half-slot in from each rim.
      expect(rootRowWidth(ds) / 2 + slot - ballRadius(bp, 0) / n).toBeCloseTo(W, 6);
    }
  });

  it("does not widen the row when digits are added — a foot splits, it doesn't grow", () => {
    // Measured on the RENDERED mesh, which is where "width" means anything.
    const one = renderedRowWidth(1);
    // Not exact: a slot boundary is sampled at SIDES angles, so a slot corner
    // can be chamfered by a fraction of a percent. The point is that the row
    // does not GROW with n, which is a 2.6x effect in the bug this replaces.
    for (const n of [2, 3, 4, 5]) expect(renderedRowWidth(n) / one).toBeCloseTo(1, 2);
    // The regression this replaces: `1.15/√n` made a five-digit row 2.6× as
    // wide as a one-digit foot, so the digits overlapped into a single blob.
    expect(renderedRowWidth(5)).toBeLessThan(one * 1.01);
  });

  it("keeps toeContrast shrinking the OUTER digits", () => {
    const ds = digitsOf(buildSkeleton(testBody({ toeCount: 5, toeContrast: 0.5 })).bones, "limb0L");
    expect(ds[0]!.radiusHead).toBeLessThan(ds[2]!.radiusHead);
    expect(ds[4]!.radiusHead).toBeLessThan(ds[2]!.radiusHead);
  });
});

describe("digit bases join the sole's end polygon", () => {
  it("tiles the sole's end ring — the row of bases IS that ring", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const secs = limbSections(testBody({ toeCount: n }));
      // The sole's last ring: its final SIDES verts before the TWO cap
      // centres a limb emits (root cap, then end cap).
      const sole = secs.get("limb:limb0L")!;
      const soleRing = sole.slice(-SIDES - 2, -2);
      const bases = digitSections(secs).map((d) => d.slice(0, SIDES));
      // Within the chamfer an 8-sample slot boundary can cut off a corner.
      const ratio = spread(bases.flat()) / spread(soleRing);
      expect(ratio).toBeGreaterThan(0.97);
      expect(ratio).toBeLessThanOrEqual(1.0001); // never SPILLS past the sole
    }
  });

  it("leaves NO flat between neighbours — adjacent bases share their chord", () => {
    for (const n of [2, 3, 4, 5]) {
      const bases = digitSections(limbSections(testBody({ toeCount: n }))).map((d) =>
        d.slice(0, SIDES),
      );
      const mid = (b: Array<readonly [number, number, number]>, a: number) =>
        b.reduce((s, p) => s + p[a]!, 0) / b.length;
      // Row axis = first base's centre → last base's centre.
      const ax = [0, 1, 2].map((a) => mid(bases[bases.length - 1]!, a) - mid(bases[0]!, a));
      const L = Math.hypot(ax[0]!, ax[1]!, ax[2]!) || 1;
      const u = (p: readonly number[]) => (p[0]! * ax[0]! + p[1]! * ax[1]! + p[2]! * ax[2]!) / L;
      const spans = bases.map((b) => [Math.min(...b.map(u)), Math.max(...b.map(u))] as const);
      const width = spans[spans.length - 1]![1] - spans[0]![0];
      for (let k = 1; k < spans.length; k++) {
        // 📕 A gap here is the defect the user reported: flat sole showing
        // between toes. Neighbours must MEET, not merely come close.
        expect(spans[k]![0] - spans[k - 1]![1]).toBeLessThanOrEqual(width * 1e-6);
      }
    }
  });

  it("caps a tiled digit only at its TIP — the sole's own cap seals the base", () => {
    // ring0 + ring1 + ONE cap centre. A second centre would mean a base cap
    // coplanar with (and z-fighting) the sole's cap.
    for (const d of digitSections(limbSections(testBody({ toeCount: 4 })))) {
      expect(d).toHaveLength(2 * SIDES + 1);
    }
  });
});

describe("a toe is not wrung round its own axis", () => {
  // 🚨 THE 180° TWIST. `digitBasePoints` lays a base ring out on the SOLE's
  // frame, but `loftChain` used to start every chain on a frame derived from
  // world up. Wherever those differed — i.e. on every limb whose foot is not
  // aimed the way a fresh frame assumes — base vertex k and tip vertex k
  // stopped corresponding and the toe came out wrung: measured at 161–180° on
  // EVERY shipped body. The sole's frame is now passed in as `startFrame`.
  //
  // The residual is not twist: a base ring is a wedge, so its vertices are not
  // at uniform angles about the toe's axis and this measure reads tens of
  // degrees even on a perfect toe. 90° separates the two regimes cleanly.
  const maxTwistDeg = (bp: Blueprint): number => {
    const secs = limbSections(bp);
    let worst = 0;
    for (const d of digitSections(secs)) {
      if (d.length < 2 * SIDES) continue;
      const base = d.slice(0, SIDES), tip = d.slice(SIDES, 2 * SIDES);
      const cen = (ps: typeof base) =>
        [0, 1, 2].map((a) => ps.reduce((t, p) => t + p[a]!, 0) / ps.length);
      const cB = cen(base), cT = cen(tip);
      const sub3 = (a: readonly number[], b: readonly number[]) => a.map((v, i) => v - b[i]!);
      const dot3 = (a: readonly number[], b: readonly number[]) =>
        a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
      const norm3 = (a: readonly number[]) => {
        const l = Math.hypot(a[0]!, a[1]!, a[2]!) || 1;
        return a.map((v) => v / l);
      };
      const axis = norm3(sub3(cT, cB));
      const ref = sub3(base[0]!, cB);
      const e1 = norm3(sub3(ref, axis.map((v) => v * dot3(ref, axis))));
      const e2 = [
        axis[1]! * e1[2]! - axis[2]! * e1[1]!,
        axis[2]! * e1[0]! - axis[0]! * e1[2]!,
        axis[0]! * e1[1]! - axis[1]! * e1[0]!,
      ];
      const ang = (p: readonly number[], c: readonly number[]) => {
        const v = sub3(p, c);
        return Math.atan2(dot3(v, e2), dot3(v, e1));
      };
      for (let k = 0; k < SIDES; k++) {
        let diff = ang(tip[k]!, cT) - ang(base[k]!, cB);
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        worst = Math.max(worst, Math.abs((diff * 180) / Math.PI));
      }
    }
    return worst;
  };

  it("keeps base and tip vertices corresponding, however the limb is posed", () => {
    // Poses that aim the foot every which way — a fresh frame is wrong for
    // all of them, so each of these read ~180° before the fix.
    const poses: Array<Record<string, unknown>> = [
      {},
      { legTwist: 0.6 },
      { legTwist: -0.6 },
      { restLevation: 0.4, attachHeight: 0.45 },
      { restProtraction: 0.15, restFlexion: -0.5 },
      { restProtraction: -0.15, restFlexion: 0.5 },
      { toeSpread: 1.2, toeCount: 5 },
      { stance: 1, footLengthFrac: 0.5 },
    ];
    for (const pose of poses) {
      expect(maxTwistDeg(testBody(pose))).toBeLessThan(90);
    }
  });
});

describe("digit length is the dial, and the PAD is the floor", () => {
  it("a THICK limb no longer forces LONG toes — the floor migrated", () => {
    // 🚨 THE PIN THAT FLIPPED, AND THE REASON THE ROUND HAPPENED. This used to
    // assert the opposite — that thickening the limb GREW the digits (×1.5 at
    // 5× the girth), because a digit had to clear the ball it grows from.
    // What that actually bought was a dial nobody could use: on any thick leg
    // the floor was the binding term, so `toeLengthFrac` moved nothing, and
    // the user's report was exactly that — it "doesn't seem to do anything".
    //
    // Same foot fraction, same leg length, same digit count, 5× the girth: the
    // digits must now come out the SAME LENGTH, because a toe is a fraction of
    // the FOOT and the foot did not change. What answers the girth instead is
    // `padFrac`, pinned two tests down.
    const thin = digitsOf(buildSkeleton(testBody({ radiusFrac: 0.1 })).bones, "limb0L");
    const thick = digitsOf(buildSkeleton(testBody({ radiusFrac: 0.5 })).bones, "limb0L");
    expect(boneLen(thick[1]!)).toBeCloseTo(boneLen(thin[1]!), 6);
  });

  it("draws EXACTLY the authored length, at every girth and every fraction", () => {
    // The dial is live and it is not approximate: a digit is a rigid segment
    // of `toeLengthFrac × footLength × mult`, however far it has to pitch down
    // to reach the ground. (The centre digit of an odd row has mult 1, and
    // `toeCurl` is 0 on this body, so this is exact rather than bounded.)
    for (const radiusFrac of [0.1, 0.25, 0.4, 0.6]) {
      for (const toeLengthFrac of [0.2, 0.5, 0.9]) {
        const bp = testBody({ radiusFrac, toeLengthFrac, toeCount: 3, toeContrast: 0 });
        const want = toeLengthFrac * footLength(bp, 0);
        for (const d of digitsOf(buildSkeleton(bp).bones, "limb0L")) {
          expect(boneLen(d)).toBeCloseTo(want, 6);
        }
      }
    }
  });

  it("is MONOTONIC in the dial on the very body the floor used to swallow", () => {
    // The elephant is the case that convicted the floor: a 25 cm foot wearing
    // 35 cm toes. Sweeping the dial on a limb that thick must move the art.
    const seen: number[] = [];
    const dials = [0.2, 0.4, 0.6, 0.8];
    for (const toeLengthFrac of dials) {
      const bp = testBody({ radiusFrac: 0.6, taper: 0.9, toeCount: 4, toeLengthFrac });
      seen.push(Math.max(...digitsOf(buildSkeleton(bp).bones, "limb0L").map(boneLen)));
    }
    // Not merely increasing — PROPORTIONAL. Under the floor these four were
    // one number (0.36 m, every time, on a 0.25 m foot).
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]! / seen[0]!).toBeCloseTo(dials[i]! / dials[0]!, 6);
    }
  });

  it("keeps every hand-tuned body's digits AT their authored length", () => {
    // The registry, end to end. Under the floor, four of these six were being
    // stretched (human ×0.99 of the bound, deer ×0.85, quadruped ×0.79,
    // ungulate ×0.44) and the two thickest were visible art: the cow's hoof
    // was drawn at ×3.0 of what its row said and the elephant's toes at ×2.5.
    // Now the drawn length IS the authored length on all of them, and the
    // giant-toe report resolves by derivation rather than by anyone retuning a
    // row. (`toeCurl` shortens the run, so this is an upper bound plus a floor
    // at the curl these bodies carry — never the ×2.5 blow-up.)
    for (const id of ["human", "dog", "cat", "deer", "quadruped", "ungulate", "cow", "elephant"]) {
      const bp = clampBlueprint(requireSpecies(id).blueprint);
      const lm = resolveLimbs(bp).limbs[0]!;
      const authored = lm.toeLengthFrac * footLength(bp, 0);
      const built = digitsOf(buildSkeleton(bp).bones, "limb0L").map(boneLen);
      expect(built.length).toBeGreaterThan(0);
      const longest = Math.max(...built);
      expect(longest).toBeLessThanOrEqual(authored * 1.001);
      // `toeContrast` shrinks the outer digits and `toeCurl` shortens the run,
      // so the longest is bounded below by both — never by a floor.
      expect(longest).toBeGreaterThan(authored * (1 - 0.45 * lm.toeCurl) * (1 - lm.toeContrast) * 0.99);
    }
  });

  it("keeps an opposed thumb shorter than the fingers beside it", () => {
    const ds = digitsOf(buildSkeleton(testBody({ toeCount: 4, opposition: 0.8 })).bones, "limb0L");
    expect(boneLen(ds[3]!)).toBeLessThan(boneLen(ds[2]!));
  });
});

/**
 * ⚖️ A DIGIT'S BASE AND ITS TIP ARE ON THE SAME SIDE OF THE FOOT.
 *
 * 🚨 THE DEFECT THIS PINS HAS BEEN "FIXED" MORE THAN ONCE AND KEPT COMING BACK,
 * because every previous attempt looked in `addDigits` — and the skeleton was
 * never the problem. The skeleton lays the roots across the foot in index
 * order along `cross(worldUp, footDir)`. mesh.ts cuts each digit's BASE RING
 * out of the sole's end polygon at a slot tiling `[-rx, +rx]` along the sole
 * loft's parallel-transported `end.side`. Those are two independent readings of
 * "across the foot", and nothing forced them to agree on a SIGN.
 *
 * They did not agree. The loft frame starts at `cross(worldUp, dir)` of the
 * FEMUR, which for a mammal hanging within a few degrees of vertical is
 * ill-conditioned — its direction is set by the femur's tiny tilt azimuth — and
 * parallel transport then carries that arbitrary roll faithfully to the foot.
 * Measured against the skeleton's own row axis it was off by a mean of 115° and
 * by a full 180° at worst, past 90° on 24 of 36 digit rows in the registry. Past
 * 90° means every toe's base ring is cut on the far side of the sole from the
 * tip its bone runs to: the row crosses itself.
 *
 * So this pin is deliberately taken on the BUILT MESH, not on the bones — the
 * bones were always right. If it fails, the two derivations have drifted apart
 * again; the fix is `limbStartFrame` / `slotRow` in mesh.ts, not `addDigits`.
 */
describe("digits do not cross the foot", () => {
  const SEC = /^limb:(limb\d+[LR])(d\d+)?$/;

  /** Base-ring and tip-ring centroids of every digit of every toed limb copy. */
  const digitRows = (bp: Blueprint): Map<string, Array<{ base: number[]; tip: number[] }>> => {
    const built = buildCreatureMesh(buildSkeleton(bp), bp, { debugTags: true });
    const pos = built.mesh.geometry.getAttribute("position");
    const verts = new Map<string, number[][]>();
    for (let i = 0; i < pos.count; i++) {
      const m = SEC.exec(built.sections[i] ?? "");
      if (!m || !m[2]) continue;
      const arr = verts.get(`${m[1]}|${m[2]}`) ?? [];
      arr.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
      verts.set(`${m[1]}|${m[2]}`, arr);
    }
    const mean = (pts: number[][]): number[] => [0, 1, 2].map(
      (a) => pts.reduce((s, p) => s + p[a]!, 0) / pts.length);
    const rows = new Map<string, Array<{ base: number[]; tip: number[] }>>();
    for (const [key, pts] of [...verts].sort()) {
      const [chain, d] = key.split("|");
      // `loftChain` emits ring0 (the base, cut from the sole) then ring1 (the tip).
      if (pts.length < SIDES * 2) continue;
      const row = rows.get(chain!) ?? [];
      row[Number(/d(\d+)/.exec(d!)![1])] = {
        base: mean(pts.slice(0, SIDES)), tip: mean(pts.slice(-SIDES)),
      };
      rows.set(chain!, row);
    }
    return rows;
  };

  it("orders every toe's BASE the same way it orders its TIP — both sides, across the registry", () => {
    let checkedRows = 0;
    for (const id of ["human", "dog", "cat", "horse", "cow", "elephant",
      "deer", "quadruped", "sauropod", "crocodile", "ungulate"]) {
      const bp = clampBlueprint(requireSpecies(id).blueprint);
      for (const [chain, row] of digitRows(bp)) {
        const digits = row.filter(Boolean);
        if (digits.length < 2) continue;
        checkedRows++;
        // The row's own across-the-foot axis, taken from the BASES as built.
        const axis = [0, 1, 2].map((a) => digits[digits.length - 1]!.base[a]! - digits[0]!.base[a]!);
        const alen = Math.hypot(...axis) || 1;
        const u = (p: number[]): number =>
          (p[0]! * axis[0]! + p[1]! * axis[1]! + p[2]! * axis[2]!) / alen;
        for (let i = 0; i < digits.length; i++) {
          for (let j = i + 1; j < digits.length; j++) {
            const dBase = u(digits[j]!.base) - u(digits[i]!.base);
            const dTip = u(digits[j]!.tip) - u(digits[i]!.tip);
            // A CROSSING is exactly a sign disagreement: toe j is right of toe i
            // at the base but left of it at the tip (or the reverse).
            expect(`${id}/${chain}/${i}-${j}: ${Math.sign(dBase)}`)
              .toBe(`${id}/${chain}/${i}-${j}: ${Math.sign(dTip)}`);
          }
        }
      }
    }
    expect(checkedRows).toBeGreaterThan(20); // the sweep actually swept
  });
});
