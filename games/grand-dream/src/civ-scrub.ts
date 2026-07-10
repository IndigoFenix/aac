/**
 * Civilization-history scrubber — geo-scrub's twin for the settlement
 * graph (civilization-emergence.md §3a): the tri world records keyframes
 * of a history that ACTUALLY HAPPENED (tri.ts `history` option — the
 * boot-run/keyframe pattern tectonics shipped), and this module makes
 * them scrubbable. A position ∈ [0,1] across the recorded span picks a
 * target (continuous quantities — population, road wear, hostility —
 * lerped between the two straddling keyframes; discrete facts — roster
 * membership, majority civ, dead — from the NEARER frame, the same
 * "ownership is discrete" rule geo-scrub uses for plates), and the SHOWN
 * values ease toward it with `easeToward`: drag the slider and cities
 * swell, shrink, change flags, and fall through their recorded past
 * instead of snapping frame to frame. Retargeting mid-morph is free.
 *
 * Pure presentation: the live world is untouched at any position — scrub
 * back to "now" (pos 1) and the ordinary map resumes. The scrubber is
 * read-only toward the past (§5: recorded keyframes are facts).
 */

import { easeToward, frameDt } from "./transients";
import type { CivHistory } from "./tri";

/** The interpolated (pre-easing) state at a scrub position — the pure
 *  core, exported for tests. Arrays align with the history's rosters. */
export interface CivTarget {
  /** Fractional recorded day at this position, for captions. */
  day: number;
  cities: Array<{ present: boolean; pop: number; civ: string; dead: boolean }>;
  edges: Array<{ present: boolean; road: number; hostility: number }>;
}

export interface CivScrubber {
  /** Position across the recorded history: 0 = oldest keyframe, 1 = the
   *  newest recorded frame (the head; the LIVE map takes over at 1). */
  setPos(p: number): void;
  pos(): number;
  /** The (fractional) recorded day at the current position. */
  day(): number;
  /** Ease the shown values toward the position's target and return the
   *  drawable state. Call once per animation frame. */
  view(ts: number): CivTarget;
}

const MORPH_TAU = 0.2; // s — snappy, but visibly a morph

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** The keyframe pair straddling a position, and the blend between. */
function seg(history: CivHistory, pos: number): { ai: number; bi: number; t: number } {
  const n = history.frames.length;
  if (n < 2) return { ai: 0, bi: 0, t: 0 };
  const f = clamp01(pos) * (n - 1);
  const ai = Math.min(n - 2, Math.floor(f));
  return { ai, bi: ai + 1, t: Math.min(1, f - ai) };
}

/** Pure interpolation at a position: continuous values lerp, discrete
 *  facts (presence, civ, dead) come from the nearer frame. A city or
 *  edge present in only one straddling frame takes that frame's value —
 *  there is nothing to lerp from before it existed. */
export function civTargetAt(history: CivHistory, pos: number): CivTarget {
  const { ai, bi, t } = seg(history, pos);
  const a = history.frames[ai];
  const b = history.frames[bi];
  if (!a) return { day: 0, cities: [], edges: [] };
  const disc = t < 0.5 ? a : b; // discrete facts from the nearer frame

  const cities = history.cities.map((_, ci) => {
    const inA = ci < a.pop.length;
    const inB = ci < b.pop.length;
    const present = ci < disc.pop.length;
    const pop = inA && inB
      ? a.pop[ci] + (b.pop[ci] - a.pop[ci]) * t
      : inA ? a.pop[ci] : inB ? b.pop[ci] : 0;
    return {
      present,
      pop: present ? pop : 0,
      civ: present ? disc.civ[ci] : "",
      dead: present ? disc.dead[ci] : false,
    };
  });

  const lerpEdge = (arrA: number[], arrB: number[], ei: number): number => {
    const inA = ei < arrA.length;
    const inB = ei < arrB.length;
    return inA && inB
      ? arrA[ei] + (arrB[ei] - arrA[ei]) * t
      : inA ? arrA[ei] : inB ? arrB[ei] : 0;
  };
  const edges = history.edges.map((_, ei) => ({
    present: ei < disc.edgeCount,
    road: lerpEdge(a.road, b.road, ei),
    hostility: lerpEdge(a.hostility, b.hostility, ei),
  }));

  return { day: a.day + (b.day - a.day) * t, cities, edges };
}

export function createCivScrubber(history: CivHistory): CivScrubber {
  // Shown state primes at the NEWEST frame — scrubbing starts from "now"
  // and morphs backward, exactly like the geologic scrubber.
  const head = civTargetAt(history, 1);
  const shownPop = Float64Array.from(head.cities.map(c => c.pop));
  const shownRoad = Float64Array.from(head.edges.map(e => e.road));
  const shownHost = Float64Array.from(head.edges.map(e => e.hostility));
  let p = 1;
  let lastTs = -1;

  return {
    setPos(v) { p = clamp01(v); },
    pos: () => p,
    day: () => civTargetAt(history, p).day,
    view(ts) {
      const target = civTargetAt(history, p);
      const dt = frameDt(lastTs, ts);
      lastTs = ts;
      if (dt > 0) {
        target.cities.forEach((c, i) => {
          shownPop[i] = easeToward(shownPop[i], c.pop, dt, MORPH_TAU, MORPH_TAU, 0.5);
        });
        target.edges.forEach((e, i) => {
          shownRoad[i] = easeToward(shownRoad[i], e.road, dt, MORPH_TAU, MORPH_TAU, 0.001);
          shownHost[i] = easeToward(shownHost[i], e.hostility, dt, MORPH_TAU, MORPH_TAU, 0.001);
        });
      }
      return {
        day: target.day,
        cities: target.cities.map((c, i) => ({ ...c, pop: c.present ? shownPop[i] : 0 })),
        edges: target.edges.map((e, i) => ({ ...e, road: shownRoad[i], hostility: shownHost[i] })),
      };
    },
  };
}
