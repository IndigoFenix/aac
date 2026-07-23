// TEMP (view-distance-lod-tiers.md): headless repro of the s.errands stall.
// Builds a real town, steps its stage like onFrame does, and mirrors the
// doorRouteErrand cost (roadLeg → routeIndoorAware) for every emitted errand.
// Run: npx tsx scripts/tmp-profile-errands.ts   — delete when the fix lands.
import { buildTownPlay } from "../shared/world-engine/interaction/town/town-play.js";
import { createWorldState, setWorldBuildings, buildingAt, routeThroughDoors } from "../shared/world-engine/engine.js";
import { roadRoute } from "../shared/world-engine/kernel/town/streets.js";
import { routeIndoorAware } from "../shared/world-engine/interaction/quest/floor-route.js";

const play = buildTownPlay({ seed: 11 });
const stage = play.stage;
const center = stage.center;
const state = createWorldState(stage.spec, "local", 0);
const bodies = new Map<string, { x: number; y: number }>();
const p = { x: center.x, y: center.y }; // viewer start (orbits below)

const houseOfId = (id: string): string | null => /^h_(\d+)/.exec(id)?.[1] ?? null;
const ROAD_LEG_MIN = 8;

function roadLeg(a: { x: number; y: number }, b: { x: number; y: number }) {
  if (Math.hypot(b.x - a.x, b.y - a.y) < ROAD_LEG_MIN) return [b];
  const local = roadRoute(
    play.plan.streets,
    { x: a.x - center.x, y: a.y - center.y },
    { x: b.x - center.x, y: b.y - center.y },
  );
  if (local.length < 2) return [b];
  return [...local.slice(1, -1).map((q) => ({ x: q.x + center.x, y: q.y + center.y })), b];
}

// Mirror of quest-host doorRouteErrand's per-point work.
function routeErrand(startPos: { x: number; y: number }, points: Array<{ x: number; y: number }>): number {
  let waypoints = 0;
  let prev = startPos;
  for (const pt of points) {
    const bA = buildingAt(state, prev.x, prev.y);
    const bB = buildingAt(state, pt.x, pt.y);
    const hA = bA ? houseOfId(bA.id) : null;
    const indoorLeg = !!bA && !!bB && (bA.id === bB.id || (hA !== null && hA === houseOfId(bB.id)));
    const via = !indoorLeg ? roadLeg(prev, pt) : [pt];
    for (const q of via) {
      const a = performance.now();
      routeThroughDoors(state, prev, q);
      const b = performance.now();
      waypoints += routeIndoorAware(state, prev, q, 0.5).length;
      const c = performance.now();
      msDoors += b - a;
      msFull += c - b;
      calls++;
      prev = q;
    }
  }
  return waypoints;
}
let msDoors = 0;
let msFull = 0;
let calls = 0;

// MOVING VIEWER (dwell-rework verification): walk a ~60 m circle at ~5 m/s —
// exactly the continuous-input jitter that thrashed the stateless desired set
// (spawn+despawn pairs every frame). With the embodiment dwell, steady-state
// churn should be near zero.
const ORBIT_R = 60;
const ORBIT_SPEED = 5; // m/s along the circle
let spawnsIn10s = 0;
let despawnsIn10s = 0;
let errandsIn10s = 0;
let lastReport = 0;

const DT = 1 / 60;
let tSec = 0;
let totalErrands = 0;
let totalRouteMs = 0;
let worstFrameMs = 0;
let worstFrameErrands = 0;
let framesWithErrands = 0;
let frame = 0;
const t0 = performance.now();

for (; frame < 24 * 60 * 60; frame++) { // up to 24 sim-minutes
  tSec += DT;
  const ang = (tSec * ORBIT_SPEED) / ORBIT_R;
  p.x = center.x + Math.cos(ang) * ORBIT_R;
  p.y = center.y + Math.sin(ang) * ORBIT_R;
  const f = stage.frame(p, tSec, (id) => bodies.get(id) ?? null);
  if (f.buildings) setWorldBuildings(state, f.buildings);
  for (const s of f.add) bodies.set(s.id, { x: s.x, y: s.y });
  for (const id of f.remove) bodies.delete(id);
  spawnsIn10s += f.add.length;
  despawnsIn10s += f.remove.length;
  errandsIn10s += f.errands.length;
  if (tSec - lastReport >= 10) {
    console.log(
      `t=${tSec.toFixed(0)}s: spawns=${spawnsIn10s} despawns=${despawnsIn10s} errands=${errandsIn10s} bodies=${bodies.size} (per 10 sim-sec)`,
    );
    spawnsIn10s = despawnsIn10s = errandsIn10s = 0;
    lastReport = tSec;
  }
  if (f.errands.length) {
    framesWithErrands++;
    const r0 = performance.now();
    let wp = 0;
    for (const e of f.errands) {
      const at = bodies.get(e.npcId) ?? e.points[0]!;
      wp += routeErrand(at, e.points);
    }
    const ms = performance.now() - r0;
    totalErrands += f.errands.length;
    totalRouteMs += ms;
    if (ms > worstFrameMs) { worstFrameMs = ms; worstFrameErrands = f.errands.length; }
    if (ms > 100) {
      console.log(
        `frame ${frame} (t=${tSec.toFixed(1)}s): ${f.errands.length} errands, ${wp} waypoints, ${ms.toFixed(0)}ms`,
      );
    }
  }
  if (performance.now() - t0 > 90_000) { console.log("(time cap hit)"); break; }
}

console.log(`\n=== ${frame} frames (${tSec.toFixed(0)} sim-sec), wall ${(performance.now() - t0).toFixed(0)}ms`);
console.log(`buildings in state: ${state.spec.buildings?.length ?? 0}, structures: ${state.spec.structures?.length ?? 0}`);
console.log(`bodies: ${bodies.size}`);
console.log(`errands total: ${totalErrands} across ${framesWithErrands} frames (of ${frame})`);
console.log(`route ms total: ${totalRouteMs.toFixed(0)}, worst frame: ${worstFrameMs.toFixed(0)}ms (${worstFrameErrands} errands)`);
console.log(`avg per errand: ${(totalRouteMs / Math.max(1, totalErrands)).toFixed(1)}ms`);
console.log(
  `routeIndoorAware calls: ${calls} — routeThroughDoors(door graph) ${msDoors.toFixed(0)}ms vs full-call remainder ${msFull.toFixed(0)}ms`,
);
