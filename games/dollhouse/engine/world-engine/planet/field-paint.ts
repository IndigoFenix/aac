// shared/world-engine/planet/field-paint.ts
//
// FARM FIELDS AS TERRAIN PAINT — the third member of the paint family
// (rivers.ts relief recolor, route-paint.ts lanes), minted by the
// depletion↔render bridge round (ruling Ⓐ, 2026-08-26: "a ground texture
// would be better than a paint slab … similar to the way forests are
// rendered from a distance"). Forests-from-a-distance ARE biome vertex
// colour, but the biome field's cell is ~400 m and a field patch is
// 10–60 m — sub-cell AND sub-vertex at town-viewing altitudes. The house
// answer is the route-paint architecture, verbatim: paint the rects into
// the terrain's own vertex colours at their TRUE extent, let a rect the
// mesh cannot resolve FADE by coverage instead of widening, and repaint
// standing chunks through PlanetLod.refresh when the index grows. Draped
// decals are the rejected alternative, twice over (river-ribbons.ts:5,
// route-paint.ts:5 — a drape floats/buries as the quadtree re-chords).
//
// The index is GROWABLE and keyed like route paint: one key per town,
// `setFields` swaps a key's rects with content-idempotency (a re-laid town
// repaints instead of ghosting) and hands back the disturbed ground as a
// `PaintPatch` for `refreshTerrain`. Painted fields persist after a town's
// live session unmounts — they are the plan's deterministic truth, not
// session chrome. Colour only: no height, no material change (the
// `materialAt` coupling is deliberately untouched in v1 — grass detail
// under the tilled tint reads fine; a soil material arm is the recorded
// upgrade).
//
// Scan strategy: a flat array with a per-rect bounding radius pre-check.
// Fields number tens per town and tintAt runs only inside chunk REBUILDS
// (1089 verts each), never per-frame; the route-paint binning pattern is
// the recorded upgrade path if field counts ever grow past that.

import type { PaintPatch } from "./route-paint.js";

type V3 = readonly [number, number, number];

/** Tilled-field colour (linear, matching the vertex-colour space the other
 *  paints use) — a hay-green distinct from the ecology TREE/steppe tints.
 *  Content dial, eyeball-tunable. */
const FIELD_R = 0.30, FIELD_G = 0.36, FIELD_B = 0.11;
/** Full-strength blend inside a rect (route paint's own ceiling). */
const PAINT_MAX = 0.8;
/** Edge feather, metres — a field ends in a margin, not a razor line. */
const FEATHER_M = 3;

/** One painted rectangle, in the planet's own frame: centre as a unit
 *  direction, the rect's local axes as unit TANGENT vectors (the town
 *  plan's east/north carried onto the sphere), half extents in metres.
 *  Small-chord math throughout — a field is metres on a planet of
 *  kilometres, so the tangent-plane projection is exact for all purposes. */
export interface FieldRect {
  center: V3;
  u: V3;
  v: V3;
  halfU: number;
  halfV: number;
}

export interface FieldPaint {
  /** REPLACE what a key paints (content-idempotent, replaceRoutes' law):
   *  returns the ground the swap disturbed as one ball, or null when the
   *  key already paints exactly this (laying the same fields twice is
   *  free). An empty `rects` erases the key. */
  setFields(key: string, rects: readonly FieldRect[]): PaintPatch | null;
  /** Blend field colour into `rgb` where `dir` lies inside a painted rect —
   *  true extent, coverage-faded below the mesh's resolution
   *  (`vertSpanM`; 0 = exact). */
  tintAt(dir: V3, vertSpanM: number, rgb: [number, number, number]): void;
  /** Rects indexed so far (host diagnostics). */
  fieldCount(): number;
}

/** A rect's identity as its eleven numbers — content-equality for the
 *  replace law (doubles round-trip through their default string form). */
const rectId = (r: FieldRect): string =>
  [r.center[0], r.center[1], r.center[2], r.u[0], r.u[1], r.u[2],
    r.v[0], r.v[1], r.v[2], r.halfU, r.halfV].join(",");

export function createFieldPaint(radiusM: number): FieldPaint {
  const byKey = new Map<string, FieldRect[]>();
  /** Flat scan list, rebuilt on set — tens of rects, rebuild-time only. */
  let all: Array<FieldRect & { boundM: number }> = [];

  const rebuild = (): void => {
    all = [];
    for (const rects of byKey.values()) {
      for (const r of rects) {
        all.push({ ...r, boundM: Math.hypot(r.halfU, r.halfV) + FEATHER_M });
      }
    }
  };

  /** The ball covering a rect set (PaintPatch terms: chord metres). */
  const ballOf = (rects: readonly FieldRect[]): PaintPatch | null => {
    if (!rects.length) return null;
    let cx = 0, cy = 0, cz = 0;
    for (const r of rects) { cx += r.center[0]; cy += r.center[1]; cz += r.center[2]; }
    const m = Math.hypot(cx, cy, cz) || 1;
    const center: [number, number, number] = [cx / m, cy / m, cz / m];
    let radius = 0;
    for (const r of rects) {
      const chord = Math.hypot(
        r.center[0] - center[0], r.center[1] - center[1], r.center[2] - center[2],
      ) * radiusM;
      radius = Math.max(radius, chord + Math.hypot(r.halfU, r.halfV) + FEATHER_M);
    }
    return { center, radiusM: radius };
  };

  return {
    setFields(key, rects) {
      const prev = byKey.get(key) ?? [];
      const same =
        prev.length === rects.length &&
        prev.every((r, i) => rectId(r) === rectId(rects[i]!));
      if (same) return null;
      if (rects.length) byKey.set(key, rects.map((r) => ({ ...r })));
      else byKey.delete(key);
      rebuild();
      // Disturbed ground = old ∪ new, as one ball (a town's fields sit in
      // one plan-sized neighbourhood, so the union ball stays tight).
      const balls = [ballOf(prev), ballOf(rects)].filter((b): b is PaintPatch => !!b);
      if (!balls.length) return null;
      if (balls.length === 1) return balls[0]!;
      const [a, b] = [balls[0]!, balls[1]!];
      const cx = a.center[0] + b.center[0], cy = a.center[1] + b.center[1], cz = a.center[2] + b.center[2];
      const m = Math.hypot(cx, cy, cz) || 1;
      const center: [number, number, number] = [cx / m, cy / m, cz / m];
      const span = (p: PaintPatch): number =>
        Math.hypot(p.center[0] - center[0], p.center[1] - center[1], p.center[2] - center[2]) * radiusM + p.radiusM;
      return { center, radiusM: Math.max(span(a), span(b)) };
    },

    tintAt(dir, vertSpanM, rgb) {
      for (const r of all) {
        // Chord offset from the rect centre, in metres — cheap reject first.
        const ox = (dir[0] - r.center[0]) * radiusM;
        const oy = (dir[1] - r.center[1]) * radiusM;
        const oz = (dir[2] - r.center[2]) * radiusM;
        if (ox * ox + oy * oy + oz * oz > r.boundM * r.boundM) continue;
        const lu = Math.abs(ox * r.u[0] + oy * r.u[1] + oz * r.u[2]);
        const lv = Math.abs(ox * r.v[0] + oy * r.v[1] + oz * r.v[2]);
        if (lu > r.halfU + FEATHER_M || lv > r.halfV + FEATHER_M) continue;
        // Edge feather: full inside, ramping to zero over FEATHER_M outside.
        const over = Math.max(lu - r.halfU, lv - r.halfV, 0);
        const edge = 1 - over / FEATHER_M;
        // Coverage fade (route paint's law): a rect the mesh cannot resolve
        // fades instead of widening — no field-coloured smears from orbit.
        const minHalf = Math.min(r.halfU, r.halfV);
        const coverage = vertSpanM > 0 ? Math.min(1, (2.6 * minHalf) / vertSpanM) : 1;
        const s = PAINT_MAX * coverage * Math.max(0, Math.min(1, edge));
        if (s <= 0) continue;
        rgb[0] += (FIELD_R - rgb[0]) * s;
        rgb[1] += (FIELD_G - rgb[1]) * s;
        rgb[2] += (FIELD_B - rgb[2]) * s;
        return; // rects never overlap within a plan; first hit wins
      }
    },

    fieldCount() {
      return all.length;
    },
  };
}
