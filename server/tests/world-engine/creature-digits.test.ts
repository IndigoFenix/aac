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
//   ⚖️ DIGIT LENGTH IS TIED TO THE LIMB, not only to the foot. `toeLengthFrac`
//      measures a digit against the FOOT and so says nothing about how THICK
//      the limb is; a human toe fraction carried onto a bear-thick leg (what
//      `bipedalize` does) came out shorter than the ball it grows from. A
//      digit now also clears its own ball. It is a FLOOR: an authored long
//      hoof or claw wins, so the bodies posed in the lab are untouched.
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

describe("digit length is tied to the limb", () => {
  it("grows the digits when the LIMB thickens, with the foot held fixed", () => {
    // Same foot fraction, same leg length, same digit count — only girth
    // changes. Before the floor these two feet had IDENTICAL digits.
    const thin = digitsOf(buildSkeleton(testBody({ radiusFrac: 0.1 })).bones, "limb0L");
    const thick = digitsOf(buildSkeleton(testBody({ radiusFrac: 0.5 })).bones, "limb0L");
    expect(boneLen(thick[1]!)).toBeGreaterThan(boneLen(thin[1]!) * 1.5);
  });

  it("never leaves a digit buried in the ball it grows from", () => {
    // The pathology: a thick limb wearing a thin limb's toe fraction. Every
    // digit must run clear of the ball's radius, whatever the fractions say.
    for (const radiusFrac of [0.1, 0.25, 0.4, 0.6]) {
      for (const toeLengthFrac of [0.2, 0.5, 0.9]) {
        const bp = testBody({ radiusFrac, toeLengthFrac });
        const ballR = ballRadius(bp, 0);
        for (const d of digitsOf(buildSkeleton(bp).bones, "limb0L")) {
          expect(boneLen(d)).toBeGreaterThan(ballR);
        }
      }
    }
  });

  it("is a FLOOR — a long authored hoof or claw is left alone", () => {
    // One long digit on a slender leg: the foot-derived length wins, so the
    // floor must not be visible in the result at all. Grounded digits shorten
    // with curl; curl is 0 here, so this is exact.
    const bp = testBody({ toeCount: 1, toeLengthFrac: 1, radiusFrac: 0.05, taper: 0.3 });
    const d = digitsOf(buildSkeleton(bp).bones, "limb0L")[0]!;
    expect(boneLen(d)).toBeCloseTo(footLength(bp, 0), 4);
  });

  it("leaves the hand-tuned bodies on their authored toe length", () => {
    // 📕 The floor is calibrated so that nothing anyone posed in the lab
    // moves. If a body here starts failing, DIGIT_MIN_ASPECT was raised past
    // what the tuned bodies clear — retune the constant, not the body.
    for (const id of ["human", "dog", "cat", "deer", "quadruped", "ungulate"]) {
      const bp = clampBlueprint(requireSpecies(id).blueprint);
      const lm = resolveLimbs(bp).limbs[0]!;
      const authored = lm.toeLengthFrac * footLength(bp, 0);
      const ballR = ballRadius(bp, 0);
      const n = Math.max(1, Math.round(lm.toeCount));
      expect(authored).toBeGreaterThan(ballR + (ballR / n) * 1.5);
    }
  });

  it("keeps an opposed thumb shorter than the fingers beside it", () => {
    const ds = digitsOf(buildSkeleton(testBody({ toeCount: 4, opposition: 0.8 })).bones, "limb0L");
    expect(boneLen(ds[3]!)).toBeLessThan(boneLen(ds[2]!));
  });
});
