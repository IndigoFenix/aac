/**
 * FACE DEFECT SWEEP — a headless audit of the creature head generator.
 *
 * Builds skeletons (and optionally the fused mesh) across a grid of head
 * parameters and reports, per combination, the geometric defects listed in
 * planning-docs/games/world-engine/creature-body-constraints.md:
 *
 *   backward-forehead  the forehead bones run BACKWARD (muzzle root behind
 *                      the cranium front) — the face folds into the skull.
 *   sweep-cross        the mesh's dorsal and ventral anchor sweeps overlap
 *                      (aBot >= aTop): top/bottom anchors cross, every union
 *                      ring inverts — this is the caved-in face.
 *   root-inside        the muzzle-root rim sits INSIDE the cranium guide.
 *   forehead-wall      the dorsal contour turns > WALL_DEG at the bridge —
 *                      the sharp vertical wall above the snout.
 *   jaw-step           the mandible root hangs below the cranium's ventral
 *                      surface by more than a fraction of the head radius.
 *   nose-fat           the nose base is wider than the surface it sits on.
 *   nose-buried        the nose root is not on the skull surface.
 *   flipped-tris       (mesh mode) skull triangles whose normal points INTO
 *                      the skull-guide union.
 *
 * Usage:
 *   npx tsx scripts/diagnose-creature-faces.ts              # grid sweep, skeleton-only
 *   npx tsx scripts/diagnose-creature-faces.ts --mesh       # also loft the mesh (slow)
 *   npx tsx scripts/diagnose-creature-faces.ts --random 400 # random blueprints
 *   npx tsx scripts/diagnose-creature-faces.ts --worst 20   # list the worst combos
 */
import {
  defaultBlueprint,
  clampBlueprint,
  randomBlueprint,
  type Blueprint,
} from "../shared/world-engine/creatures/blueprint.js";
import {
  buildSkeleton,
  type CreatureSkeleton,
  type SkullGuide,
  type SkullPrim,
} from "../shared/world-engine/creatures/skeleton.js";
import { buildCreatureMesh } from "../shared/world-engine/creatures/mesh.js";
import { listSpecies, speciesBlueprint } from "../shared/world-engine/creatures/species.js";

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(n);
const num = (n: string, d: number): number => {
  const i = argv.indexOf(n);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const WITH_MESH = flag("--mesh") || flag("--extremes");
const RANDOM_N = num("--random", 0);
const WORST = num("--worst", 12);
const WALL_DEG = num("--wall", 75);
/** Fixed loft resolution, so the mandible ring chunking below is exact. */
const MESH_SIDES = 16;

type V3 = { x: number; y: number; z: number };
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return mul(a, 1 / l);
};
const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const X: V3 = { x: 1, y: 0, z: 0 };

/** Half-axis along a prim's own axis (stations are flat discs: halfLen 0). */
const primLen = (pr: SkullPrim): number => (pr.halfLen > 1e-9 ? pr.halfLen : pr.ry);

/** Is `p` inside the skull-guide union (any prim), with a slack margin? */
function insideUnion(gd: SkullGuide, p: V3, slack = 0): boolean {
  const test = (pr: SkullPrim): boolean => {
    const U = norm(cross(pr.dir, X));
    const rel = sub(p, pr.center);
    const ox = rel.x / (pr.rx + slack);
    const oy = dot(rel, U) / (pr.ry + slack);
    const oz = dot(rel, pr.dir) / (primLen(pr) + slack);
    return ox * ox + oy * oy + oz * oz < 1;
  };
  if (test(gd.cranium)) return true;
  return gd.stations.some(test);
}

interface Defects {
  backwardForehead: number; // most-negative forward progress / headR
  sweepCross: number; // aBot - aTop (radians); > 0 = crossed
  rootInside: number; // depth of the root rim inside the cranium / headR
  wallDeg: number; // sharpest dorsal turn at the bridge (degrees)
  jawStep: number; // half-depth turn at the rear-shell -> muzzle handover (deg)
  plateDeg: number; // steepest WIDTH change in the skull loft (deg; 90 = a vertical annulus)
  sprawl: number; // worst skull ring z-span / its own diameter (>1 = not a cross-section)
  noseFat: number; // noseR / host ry  (> 1 = fatter than its host)
  noseBuried: number; // 1 when the first segment never leaves the skull
  flippedTris: number;
  /** Triangles DEEP inside the union — hidden, not broken. Informational:
   *  every loft has some (caps, sunk rings), so it is never a defect. */
  buriedTris: number;
  skullTris: number;
}

function analyse(bp: Blueprint, withMesh: boolean): Defects {
  const skel: CreatureSkeleton = buildSkeleton(bp);
  const d: Defects = {
    backwardForehead: 0,
    sweepCross: -Math.PI,
    rootInside: 0,
    wallDeg: 0,
    jawStep: 0,
    plateDeg: 0,
    sprawl: 0,
    noseFat: 0,
    noseBuried: 0,
    flippedTris: 0,
    buriedTris: 0,
    skullTris: 0,
  };
  const lm = skel.head;
  const gd = skel.skull;
  if (!lm || !gd) return d;
  const headR = lm.radius;

  // 1) Forehead bones running backward.
  for (const b of skel.bones) {
    if (!b.id.startsWith("forehead")) continue;
    const fwd = dot(sub(b.tail, b.head), lm.braincaseAxis) / headR;
    if (fwd < d.backwardForehead) d.backwardForehead = fwd;
  }

  // 2) Dorsal/ventral anchor sweeps (exactly as mesh.ts computes them).
  const cC = gd.cranium.center;
  const cF = gd.cranium.dir;
  const cU = norm(cross(cF, X));
  const aL = gd.cranium.halfLen;
  const bH = gd.cranium.ry;
  const root = gd.stations[gd.muzzleFrom];
  if (root) {
    const rUp = norm(cross(root.dir, X));
    const rootTop = add(root.center, mul(rUp, root.ry));
    const rootBot = add(root.center, mul(rUp, -root.ry));
    const angOf = (p: V3): number => {
      const rel = sub(p, cC);
      return Math.atan2(dot(rel, cU) / bH, dot(rel, cF) / aL);
    };
    d.sweepCross = angOf(rootBot) - angOf(rootTop);
    // 3) Root rim inside the cranium.
    for (const p of [rootTop, rootBot, root.center]) {
      const rel = sub(p, cC);
      const q = Math.hypot(rel.x / gd.cranium.rx, dot(rel, cU) / bH, dot(rel, cF) / aL);
      if (q < 1) d.rootInside = Math.max(d.rootInside, ((1 - q) * Math.min(aL, bH)) / headR);
    }
  }

  // 4) Sharpest turn along the dorsal contour (the wall above the snout).
  //    The contour runs snout tip -> bridge -> crown, so consecutive
  //    segments turning sharply IS the vertical wall.
  //    Segments shorter than 5% of the head radius are SKIPPED. A turn
  //    measured across a sub-visible span is not a wall at any render
  //    scale, and a near-degenerate muzzle (a flat human face, whose whole
  //    rostrum is 1% of the head radius long) is nothing but such segments:
  //    its "muzzle top line" is dominated by the station up-vectors rather
  //    than by any real shape, and it would otherwise own the metric.
  const MIN_SEG = headR * 0.05;
  for (let i = 1; i + 1 < gd.dorsal.length; i++) {
    const s0 = sub(gd.dorsal[i].p, gd.dorsal[i - 1].p);
    const s1 = sub(gd.dorsal[i + 1].p, gd.dorsal[i].p);
    if (len(s0) < MIN_SEG || len(s1) < MIN_SEG) continue;
    const deg = (Math.acos(Math.max(-1, Math.min(1, dot(norm(s0), norm(s1))))) * 180) / Math.PI;
    d.wallDeg = Math.max(d.wallDeg, deg);
  }

  // 6/7) Nose vs. the surface it grows from.
  const noseBones = skel.bones.filter((b) => b.id.startsWith("nose"));
  if (noseBones.length > 0) {
    const nose0 = noseBones[0];
    const rootP = nose0.head;
    // Host = the prim whose SURFACE the root actually sits on (|q - 1|
    // smallest), not merely the nearest center.
    let hostR = gd.cranium.ry;
    let best = Infinity;
    for (const pr of [gd.cranium, ...gd.stations]) {
      const U = norm(cross(pr.dir, X));
      const rel = sub(rootP, pr.center);
      const q = Math.hypot(rel.x / pr.rx, dot(rel, U) / pr.ry, dot(rel, pr.dir) / primLen(pr));
      if (Math.abs(q - 1) < best) {
        best = Math.abs(q - 1);
        hostR = Math.min(pr.rx, pr.ry);
      }
    }
    // `noseRadiusFrac` is now a fraction OF THE HOST, so this ratio can no
    // longer exceed the dial's own ceiling (1.2). Anything above that means
    // the nose was sized against something other than what it sits on.
    d.noseFat = nose0.radiusHead / Math.max(1e-6, hostR);
    // Buried / flipped: ANY segment that ends back inside the skull, or a
    // segment pointing back at the surface it grew out of.
    const outward = norm(sub(nose0.tail, rootP));
    for (const b of noseBones) {
      if (insideUnion(gd, b.tail)) d.noseBuried = 1;
      if (dot(norm(sub(b.tail, b.head)), outward) < 0) d.noseBuried = 1;
    }
  }

  if (withMesh) {
    const built = buildCreatureMesh(skel, bp, { debugTags: true, sides: MESH_SIDES });
    const g = built.mesh.geometry;
    const idx = g.getIndex()!;
    const pos = g.getAttribute("position");
    for (let t = 0; t < idx.count; t += 3) {
      const i0 = idx.getX(t);
      const i1 = idx.getX(t + 1);
      const i2 = idx.getX(t + 2);
      if (!built.sections[i0]?.startsWith("skull")) continue;
      d.skullTris++;
      const a: V3 = { x: pos.getX(i0), y: pos.getY(i0), z: pos.getZ(i0) };
      const b: V3 = { x: pos.getX(i1), y: pos.getY(i1), z: pos.getZ(i1) };
      const c: V3 = { x: pos.getX(i2), y: pos.getY(i2), z: pos.getZ(i2) };
      const n = norm(cross(sub(b, a), sub(c, a)));
      if (!Number.isFinite(n.x)) continue;
      const ctr = mul(add(add(a, b), c), 1 / 3);
      const eps = headR * 0.02;
      // Facing INTO the solid: a step along the normal lands inside the
      // guide union while a step against it lands outside.
      // A triangle DEEP inside the union is buried, not broken: nothing
      // sees it. Only surface triangles — those near the union boundary —
      // count as flipped. Without this split the detector lumps hidden
      // geometry in with visible inversions and reports a defect rate that
      // no render can confirm.
      if (insideUnion(gd, ctr, -headR * 0.05)) {
        d.buriedTris++;
      } else if (insideUnion(gd, add(ctr, mul(n, eps))) && !insideUnion(gd, add(ctr, mul(n, -eps)))) {
        d.flippedTris++;
      }
    }

    // 4b) The VERTICAL PLATE above the snout. The sagittal rail can be
    //     perfectly smooth while the skull's WIDTH collapses between two
    //     rings — quads standing in a z plane, a wall with no thickness.
    //     No sagittal measure can see it, which is why it outlived the
    //     forehead rework. Measured as the width profile's angle: two rings
    //     at the same z with different widths give 90 degrees.
    const skullIdx: number[] = [];
    for (let v = 0; v < pos.count; v++) {
      if (built.sections[v] === "skull") skullIdx.push(v);
    }
    const sAt = (r: number, k: number): V3 => {
      const v = skullIdx[r * MESH_SIDES + k];
      return { x: pos.getX(v), y: pos.getY(v), z: pos.getZ(v) };
    };
    const nSkull = Math.floor(skullIdx.length / MESH_SIDES);
    let pw = 0, pz = 0;
    for (let r = 0; r < nSkull; r++) {
      const a = sAt(r, 0), b = sAt(r, MESH_SIDES / 2);
      const w = Math.abs(a.x - b.x) * 0.5;
      const z = (a.z + b.z) * 0.5;
      // 4c) RING SPRAWL. A loft ring is a CROSS-SECTION; when the union
      //     sweep's rays escape down a pitched or curved muzzle, one
      //     "cranium" ring splays along the snout instead — a ring whose
      //     z-span dwarfs its own diameter. That is the face coming apart
      //     at extreme pitch/curve, and it is invisible to every profile
      //     measure because each ring is individually well-formed.
      //     Normalised against the ring's own WIDTH (its ±X extent), which
      //     is the one dimension a sprawling ring does not inflate — divide
      //     by anything that grows with the sprawl and the ratio stays put.
      let zLo = Infinity, zHi = -Infinity;
      for (let k = 0; k < MESH_SIDES; k++) {
        const q = sAt(r, k);
        zLo = Math.min(zLo, q.z);
        zHi = Math.max(zHi, q.z);
      }
      if (w > headR * 0.02) d.sprawl = Math.max(d.sprawl, (zHi - zLo) / (2 * w));
      if (r > 0 && Math.abs(w - pw) > headR * 0.01) {
        d.plateDeg = Math.max(d.plateDeg,
          (Math.atan2(Math.abs(w - pw), Math.abs(z - pz)) * 180) / Math.PI);
      }
      pw = w;
      pz = z;
    }

    // 5) Mandible DEPTH STEP — the documented complaint, "the jaw doesn't
    //    have a natural connection with the bottom of the head, it sharply
    //    sticks out if jawDepth > 0". The mandible is lofted in two halves:
    //    REAR SHELLS that are the head's own lower-face cross-sections, then
    //    MUZZLE rings carrying jawDepth. What must be continuous across that
    //    handover is the shell's HALF-DEPTH, so that is what this measures.
    //
    //    Half-depth, not the 3-D silhouette: a muzzle that pitches or curves
    //    down swings the silhouette hard without anything being wrong, and
    //    both a steepness and a turn measure mistake that for a defect. The
    //    depth field is invariant to where the muzzle points.
    //
    //    loftChain emits rings in order, `sides` vertices each, and every
    //    ring is parameterised the same way (angle s/sides·2π about the
    //    ring's own up axis). So vertex 0 and vertex sides/2 straddle the
    //    ring's centre and vertex 3·sides/4 is its VENTRAL point, whatever
    //    the ring's plane is doing. z-bucketing cannot do any of this — the
    //    rear rings are angled planes swept from the cranium centre.
    const mand: number[] = [];
    for (let v = 0; v < pos.count; v++) {
      if (built.sections[v] === "mandible") mand.push(v);
    }
    const at = (r: number, k: number): V3 => {
      const v = mand[r * MESH_SIDES + k];
      return { x: pos.getX(v), y: pos.getY(v), z: pos.getZ(v) };
    };
    const nRings = Math.floor(mand.length / MESH_SIDES);
    const depth: number[] = [];
    const zAt: number[] = [];
    for (let r = 0; r < nRings; r++) {
      const ctr = mul(add(at(r, 0), at(r, MESH_SIDES / 2)), 0.5);
      depth.push(len(sub(at(r, Math.floor((3 * MESH_SIDES) / 4)), ctr)));
      zAt.push(ctr.z);
    }
    //    Only the HANDOVER ring is judged. Further forward the mandible
    //    tapers with the muzzle to its tip, which is `muzzleSquash`'s job
    //    and dwarfs the junction — a max over the whole run just reports the
    //    tip and hides the defect being looked for.
    //    As an ANGLE, not a raw jump: the rear shells no longer land on the
    //    root rim (the duplicate ring that made them coincident WAS the
    //    vertical plate), so the handover now spans real distance and a raw
    //    jump would read a legitimate slope as a step. 90 degrees is a step.
    const nMuzzleRings = gd.stations.slice(gd.muzzleFrom)
      .filter((st) => st.biteY !== undefined).length;
    const j = nRings - nMuzzleRings;
    if (j > 0 && j < nRings) {
      d.jawStep = (Math.atan2(Math.abs(depth[j] - depth[j - 1]),
        Math.abs(zAt[j] - zAt[j - 1])) * 180) / Math.PI;
    }
  }
  return d;
}

// ── The sweep ────────────────────────────────────────────────────────────

interface Case {
  label: string;
  d: Defects;
}

function headBp(over: Partial<Blueprint["head"]>): Blueprint {
  const bp = defaultBlueprint();
  return clampBlueprint({ ...bp, head: { ...bp.head, ...over } });
}

// ── Template drift ───────────────────────────────────────────────────────
// `foreheadHeight`/`foreheadLength` changed MEANING: they used to walk the
// muzzle root's TOP RIM around the cranium ellipse, and now they are the ring
// CENTRE's height and its forward reach past the front pole. Every authored
// blueprint therefore seats its muzzle somewhere slightly new. This reports
// how far each species moved, and the dial values that would put it back.
if (flag("--templates")) {
  const rows: { id: string; drift: number; fh: [number, number]; fl: [number, number] }[] = [];
  for (const sp of listSpecies()) {
    if (sp.stub || sp.bodiless) continue;
    const h = speciesBlueprint(sp.id).head;
    if (h.snoutLengthFrac <= 1e-4) continue; // no muzzle: nothing seats
    // Everything scales with headR, so work in head radii and drop it.
    const aL = h.lengthFrac;
    const bH = h.braincaseDome;
    const aspect = Math.max(0.35, Math.min(3, h.snoutFlatten * h.crossSection));
    const snoutUR = h.snoutRadiusFrac / Math.sqrt(aspect);
    // Old seat: the dial placed the rim, and the height dragged z around.
    const dotUp = (-0.85 + 1.55 * h.foreheadHeight) * bH;
    const cosF = Math.sqrt(Math.max(0, 1 - (dotUp / bH) ** 2));
    const oldY = dotUp - snoutUR;
    const oldZ = aL * cosF + h.foreheadLength;
    // New seat: the dials ARE the centre's (y, z).
    const newY = (-1 + 1.9 * h.foreheadHeight) * bH;
    const newZ = aL + h.foreheadLength;
    rows.push({
      id: sp.id,
      drift: Math.hypot(newY - oldY, newZ - oldZ),
      fh: [h.foreheadHeight, (oldY / bH + 1) / 1.9],
      fl: [h.foreheadLength, oldZ - aL],
    });
  }
  rows.sort((a, b) => b.drift - a.drift);
  console.log("# template drift — how far each species' muzzle root moved (head radii)\n");
  console.log("  drift  species                foreheadHeight     foreheadLength");
  for (const r of rows) {
    const clampNote = r.fh[1] < 0 || r.fh[1] > 1 || r.fl[1] < 0 ? "  (out of range)" : "";
    console.log(
      `  ${r.drift.toFixed(3)}  ${r.id.padEnd(20)} ` +
        `${r.fh[0].toFixed(2)} → ${r.fh[1].toFixed(2)}      ` +
        `${r.fl[0].toFixed(2)} → ${r.fl[1].toFixed(2)}${clampNote}`,
    );
  }
  const big = rows.filter((r) => r.drift > 0.1).length;
  console.log(`\n${rows.length} species with a muzzle; ${big} moved more than 0.1 head radii.`);
  process.exit(0);
}

const cases: Case[] = [];
if (flag("--extremes")) {
  // The pitch/curve corner, with muzzles long enough to reach it. Meshed by
  // default — the defects here are loft defects, not skeleton ones.
  for (const facePitch of [-0.9, -0.45, 0, 0.45, 0.9])
    for (const snoutCurve of [-1, -0.5, 0, 0.5, 1])
      for (const snoutLengthFrac of [0.3, 1, 2.5, 4])
        for (const snoutRadiusFrac of [0.15, 0.35, 0.6]) {
          const bp = headBp({ facePitch, snoutCurve, snoutLengthFrac, snoutRadiusFrac, snoutSegments: 5 });
          cases.push({
            label: `pitch=${facePitch} curve=${snoutCurve} sl=${snoutLengthFrac} sr=${snoutRadiusFrac}`,
            d: analyse(bp, true),
          });
        }
} else if (flag("--species")) {
  // The REGISTRY, not a synthetic grid: what the game actually spawns. A
  // defect here is shipping; a defect in the grid is only reachable.
  for (const sp of listSpecies()) {
    if (sp.stub || sp.bodiless) continue;
    let bp: Blueprint;
    try {
      bp = speciesBlueprint(sp.id);
    } catch {
      continue;
    }
    if (bp.head.snoutLengthFrac <= 1e-4) continue;
    cases.push({ label: sp.id, d: analyse(bp, WITH_MESH) });
  }
} else if (RANDOM_N > 0) {
  for (let i = 0; i < RANDOM_N; i++) {
    const bp = randomBlueprint(i + 1);
    cases.push({ label: `random seed ${i + 1}`, d: analyse(bp, WITH_MESH) });
  }
} else {
  const FH = [0, 0.2, 0.45, 0.7, 0.9, 1];
  const FL = [0, 0.15, 0.3, 0.8, 1.5, 2];
  const FP = [-0.9, -0.4, 0, 0.4, 0.9];
  const SR = [0.1, 0.25, 0.45, 0.7, 0.9];
  const SL = [0.2, 0.8, 2, 4];
  const NL = [0, 0.5, 2.5];
  for (const foreheadHeight of FH)
    for (const foreheadLength of FL)
      for (const facePitch of FP)
        for (const snoutRadiusFrac of SR)
          for (const snoutLengthFrac of SL)
            for (const noseLengthFrac of NL) {
              cases.push({
                label:
                  `fh=${foreheadHeight} fl=${foreheadLength} pitch=${facePitch} ` +
                  `sr=${snoutRadiusFrac} sl=${snoutLengthFrac} nose=${noseLengthFrac}`,
                d: analyse(
                  headBp({
                    foreheadHeight,
                    foreheadLength,
                    facePitch,
                    snoutRadiusFrac,
                    snoutLengthFrac,
                    noseLengthFrac,
                  }),
                  WITH_MESH,
                ),
              });
            }
}

const bad: Record<string, (d: Defects) => boolean> = {
  backwardForehead: (d) => d.backwardForehead < -0.02,
  sweepCross: (d) => d.sweepCross > -0.02,
  rootInside: (d) => d.rootInside > 0.02,
  foreheadWall: (d) => d.wallDeg > WALL_DEG,
  jawStep: (d) => d.jawStep > 75,
  plate: (d) => d.plateDeg > 75,
  sprawl: (d) => d.sprawl > 2.5,
  noseFat: (d) => d.noseFat > 1.2,
  noseBuried: (d) => d.noseBuried > 0,
  flippedTris: (d) => d.flippedTris > 0,
};

console.log(`# creature face defect sweep — ${cases.length} combinations${WITH_MESH ? " (with mesh)" : ""}\n`);
for (const [name, pred] of Object.entries(bad)) {
  if (!WITH_MESH && (name === "flippedTris" || name === "jawStep" || name === "plate" || name === "sprawl")) continue;
  const hits = cases.filter((c) => pred(c.d));
  const pct = ((hits.length / cases.length) * 100).toFixed(1);
  console.log(`${name.padEnd(18)} ${String(hits.length).padStart(5)} / ${cases.length}  (${pct}%)`);
}
const anyBad = cases.filter((c) => Object.values(bad).some((p) => p(c.d))).length;
console.log(
  `${"ANY DEFECT".padEnd(18)} ${String(anyBad).padStart(5)} / ${cases.length}  ` +
    `(${((anyBad / cases.length) * 100).toFixed(1)}%)\n`,
);

const sortKey = argv.includes("--by-plate") ? (c: Case) => c.d.plateDeg
  : argv.includes("--by-wall") ? (c: Case) => c.d.wallDeg
  : argv.includes("--by-nose") ? (c: Case) => c.d.noseBuried * 10 + c.d.noseFat
  : argv.includes("--by-jaw") ? (c: Case) => c.d.jawStep
  : (c: Case) => c.d.sweepCross;
const worst = [...cases].sort((a, b) => sortKey(b) - sortKey(a)).slice(0, WORST);
console.log(`## worst ${WORST} by sweep crossing (aBot - aTop; > 0 inverts every ring)`);
for (const c of worst) {
  console.log(
    `  ${c.d.sweepCross.toFixed(3).padStart(7)}  wall=${c.d.wallDeg.toFixed(0).padStart(3)}°  ` +
      `jaw=${c.d.jawStep.toFixed(0).padStart(2)}  plate=${c.d.plateDeg.toFixed(0).padStart(2)}  sprawl=${c.d.sprawl.toFixed(2)}  flip=${String(c.d.flippedTris).padStart(3)} buried=${String(c.d.buriedTris).padStart(3)}/${c.d.skullTris}  ${c.label}`,
  );
}
