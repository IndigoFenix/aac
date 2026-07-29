// THE HEADLESS ERRAND WALK (DEBUG-CREATURE-BEHAVIOR §6's missing harness,
// first slice): real generated rooms + real furnishPlan furniture, walked by
// the REAL follower (createNpcController) over the REAL leg assembly
// (floor-route routeIndoorAware) with the REAL world-host detour block and
// REAL engine locomotion (steerAvatar + tickWorld door easing). Every
// furniture errand must ARRIVE — this is the sim that exposed, in turn: the
// tangency-blocked stand points, the corner-cut door wedge, the furniture-
// blind transits, the mid-room U-trap, the brake-stalled tight arrivals, and
// the early-turn carrot freeze. If it goes red, read that list first.
//
// It now also walks the PRODUCTION locomotion — wall-glide granted to the NPC
// and withheld on a tight routed leg, as world-host does — and pins CORRIDOR
// FIDELITY beside arrival: a body may not end up closer to a fixture than its
// own plan ever went, nor stray far off the planned line. Arrival alone let a
// body reach the chest by grinding round the table it was routed around; the
// law is that it walks the corridor the router measured. See
// indoor-corner-cut.test.ts for the isolated statement of that law.
import { describe, it, expect } from "@jest/globals";
import {
  addLocalAvatar,
  buildingAt,
  createWorldState,
  expandWorldBuildings,
  steerAvatar,
  structuresWalkable,
  fixturesWalkable,
  tickWorld,
  WORLD_ENGINE_DEFAULTS,
  type WorldEngineConfig,
  type WorldState,
} from "@shared/world-engine/engine.js";
import {
  createDetourMemory,
  createNpcController,
  detourAim,
  sideOfBend,
  type NpcErrandPoint,
} from "@shared/world-engine/npc-controller.js";
import { standClear, standPointFor } from "@shared/world-engine/interaction/quest/stand-points.js";
import { routeIndoorAware } from "@shared/world-engine/interaction/quest/floor-route.js";
import { houseRoomPlan } from "@shared/world-engine/kernel/town/rooms.js";
import { houseFurniture } from "@shared/world-engine/kernel/town/furniture.js";
import type { TownHouse } from "@shared/world-engine/kernel/town/plan.js";
import type { BuildingSpec, ObjectSpec, WorldSpec } from "@shared/world-engine/types.js";

const center = { x: 200, y: 200 };

function mkHouse(index: number, w: number, h: number, door: TownHouse["door"]): TownHouse {
  return { index, dx: -w / 2, dy: -h / 2, w, h, door, color: "#a8875f", floors: 1 };
}

interface WalkResult {
  arrived: boolean;
  switches: number;
  t: number;
  /** The target's stand point is itself unstandable (a fixture walled into a
   *  corner cluster) — production's stall watch gives up and applies the
   *  effect in place (termination over fidelity), so arrival isn't owed. */
  walledIn: boolean;
  /** Worst clearance the ROUTE itself keeps from a solid fixture, and the worst
   *  the BODY actually kept. The route's figure is the whole budget: a follower
   *  that ends up closer than its plan ever went is standing on ground the
   *  planner never certified — the corner-cut, measured. */
  planClear: number;
  bodyClear: number;
  /** Worst distance from the walked plan — the other half of the law. */
  maxDev: number;
}

/** The mover's collision radius throughout this harness (the engine default —
 *  the girth the router plans at, floor-route planGeom `plan`). */
const BODY_R = 0.4;
/** The host's NPC steer config: wall-glide granted (world-host steerConfigOf). */
const NPC_GLIDE: WorldEngineConfig = { ...WORLD_ENGINE_DEFAULTS, wallGlide: true };

/** How much room is left between the body's collision square and the nearest
 *  SOLID fixture's keep-out. Measured by probe, not by geometry, so it counts
 *  exactly the fixtures locomotion collides with (pass-through kinds — a chair,
 *  a bowl — are invisible to it, as they should be). 0 = the body's edge is
 *  touching the furniture; the constraint makes anything below that impossible,
 *  which is why a cut shows up as clearance SPENT rather than as overlap. */
function fixtureClearance(s: WorldState, p: { x: number; y: number }): number {
  const CAP = 0.6; // beyond a body-and-a-half of room there is nothing to report
  if (fixturesWalkable(s, p, BODY_R + CAP, 0)) return CAP;
  let lo = 0;
  let hi = CAP;
  for (let k = 0; k < 8; k++) {
    const mid = (lo + hi) / 2;
    if (fixturesWalkable(s, p, BODY_R + mid, 0)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** How far `p` strayed from the walked plan (its entry point + every routed
 *  point). The corridor is measured in centimetres, so this is the other half of
 *  the law: even where a plan happens to run through open floor, a body that has
 *  left its line by half a metre is no longer walking the route that was checked. */
function distToPlan(p: { x: number; y: number }, poly: { x: number; y: number }[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[i + 1]!;
    const bx = b.x - a.x;
    const by = b.y - a.y;
    const len2 = bx * bx + by * by;
    const t = len2 < 1e-9 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * bx + (p.y - a.y) * by) / len2));
    best = Math.min(best, Math.hypot(p.x - (a.x + bx * t), p.y - (a.y + by * t)));
  }
  return best;
}

/** The plan's own worst clearance — densely sampled, because the corridor the
 *  planner certified is the whole polyline, not just its vertices. */
function planClearance(s: WorldState, poly: { x: number; y: number }[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[i + 1]!;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.05));
    for (let k = 0; k <= n; k++) {
      best = Math.min(best, fixtureClearance(s, { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n }));
    }
  }
  return best;
}

/** Walk ONE errand exactly the way the live host does. */
function walkErrand(house: TownHouse, pieceId: string): WalkResult {
  const rooms = houseRoomPlan(center, house).rooms;
  const buildings: BuildingSpec[] = rooms.map((room) => ({
    id: room.id,
    footprint: room.rect,
    floors: 1,
    stairs: false,
    wallThickness: 0.4,
    doorways: room.doorways,
    color: house.color,
  }));
  const pieces = houseFurniture(center, house, [{ key: "food", slot: 0 }, { key: "cloth", slot: 1 }]);
  const objects: ObjectSpec[] = pieces.map((p) => ({
    id: p.id,
    x: p.x,
    y: p.y,
    shape: "box" as const,
    radius: p.radius,
    fixture: p.kind,
    openable: p.openable,
    facing: p.facing,
    interactions: [],
  }));
  const spec: WorldSpec = {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: 400, height: 400 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 5, y: 5 }], // the LOCAL player, parked far away
    objects,
    buildings,
    multiplayer: { maxPlayers: 2, authority: "distributed" },
    content: { kind: "sandbox" },
  };
  const s: WorldState = createWorldState(expandWorldBuildings(spec), "me");
  // Body spawns on ROBUSTLY clear living-room floor (embodiment never
  // teleports onto a box-marginal point).
  const living = rooms[0]!.rect;
  const lc0 = { x: living.x + living.w / 2, y: living.y + living.h / 2 };
  const hardClear = (p: { x: number; y: number }) =>
    structuresWalkable(s, p, 0.55, 0) && fixturesWalkable(s, p, 0.55, 0);
  let lc = lc0;
  outer: for (const rad of [0, 0.6, 1.2, 1.8, 2.4, 3.0]) {
    for (let ang = 0; ang < 6.28; ang += 0.523) {
      const p = { x: lc0.x + Math.cos(ang) * rad, y: lc0.y + Math.sin(ang) * rad };
      if (hardClear(p)) {
        lc = p;
        break outer;
      }
    }
  }
  const body = addLocalAvatar(s, "npc", lc.x, lc.y);
  const obj = s.objects[pieceId]!;
  const ctrl = createNpcController({ id: "npc", x: lc.x, y: lc.y, behavior: { movement: "stationary" } });
  const mem = createDetourMemory();
  const walk = (p: { x: number; y: number }, r: number) =>
    structuresWalkable(s, p, r, 0) && fixturesWalkable(s, p, r, 0);
  const dt = 1 / 60;
  let t = 0;
  let lastSide: 1 | -1 | 0 = 0;
  let switches = 0;
  let stand = { x: obj.x, y: obj.y };
  let planClear = Infinity;
  let bodyClear = Infinity;
  let maxDev = 0;
  // Up to 3 attempts — quest-host's stall watch does the same: when a walk
  // ends short, the stand point is RE-PICKED from where the body actually
  // stands and the errand re-routed.
  for (let attempt = 0; attempt < 3; attempt++) {
    const from = { x: body.x, y: body.y };
    stand = standPointFor(s, pieceId, { x: obj.x, y: obj.y }, from);
    // quest-host doorRouteErrand's point construction, verbatim — a point the
    // router placed INSIDE a building is `tight` (no corner-cutting indoors),
    // and that flag is what vetoes both steer-time shortcuts below. Routing
    // without it walks a plan production never issues.
    const routed = routeIndoorAware(s, from, stand);
    const plan: NpcErrandPoint[] = routed.map((p, i) => ({
      x: p.x,
      y: p.y,
      ...(buildingAt(s, p.x, p.y) ? { tight: true } : {}),
      ...(i === routed.length - 1 ? {} : { arrive: p.arrive ?? 0.9 }),
      ...(p.doorId ? { doorId: p.doorId } : {}),
    }));
    ctrl.setErrand({ points: plan });
    const poly = [from, ...plan.map((p) => ({ x: p.x, y: p.y }))];
    planClear = Math.min(planClear, planClearance(s, poly));
    let done = false;
    for (let f = 0; f < 30 * 60; f++) {
      const aim = ctrl.computeAim({
        self: body,
        humans: [],
        now: t,
        width: 400,
        height: 400,
        rng: () => 0.5,
        walkable: walk,
        radius: 0.4,
      });
      let bent = aim;
      // The world-host steering block, verbatim: ONE reading of the tight veto,
      // and it gates BOTH steer-time shortcuts — the local aim bend here and the
      // engine's wall glide at steerAvatar below.
      const legTight = ctrl.errandLegTight();
      if (aim && !legTight) {
        bent = detourAim({ x: body.x, y: body.y }, aim, walk, 0.4, mem.prefer("npc", t));
        if (bent !== aim) {
          const side = sideOfBend({ x: body.x, y: body.y }, aim, bent);
          mem.record("npc", side, t);
          if (lastSide !== 0 && side !== lastSide) switches++;
          lastSide = side;
        }
      }
      // Declare the doorway being walked through, exactly as the host does — a
      // door opens because a body is crossing it, so without this line every
      // errand through an interior doorway stands at a shut door.
      body.crossingDoorId = ctrl.crossingDoorId();
      // PRODUCTION LOCOMOTION. The host grants wall-glide to every NPC it steers
      // (world-host steerConfigOf) and withholds it on a tight routed leg. This
      // harness once steered with the bare defaults — glide-free — so it walked a
      // body production does not run, and could not see the glide dragging a body
      // off its corridor and along the furniture it was routed around.
      steerAvatar(s, "npc", bent, dt, legTight ? WORLD_ENGINE_DEFAULTS : NPC_GLIDE);
      tickWorld(s, { aim: null }, dt); // doors ease; the parked player brakes
      t += dt;
      bodyClear = Math.min(bodyClear, fixtureClearance(s, body));
      maxDev = Math.max(maxDev, distToPlan(body, poly));
      if (!ctrl.hasErrand()) {
        done = true;
        break;
      }
    }
    if (done && Math.hypot(stand.x - body.x, stand.y - body.y) <= 1.3) {
      return { arrived: true, switches, t, walledIn: false, planClear, bodyClear, maxDev };
    }
  }
  return { arrived: false, switches, t, walledIn: !standClear(s, stand), planClear, bodyClear, maxDev };
}

describe("furnished-house errands ARRIVE (the anti-wedge, anti-flip pin)", () => {
  // A spread including the historically pathological shapes: the sideways
  // hall houses whose living-room furniture crowds the interior door.
  const houses = [
    mkHouse(0, 12, 9, "south"),
    mkHouse(17, 11.8, 9.8, "east"),
    mkHouse(23, 11.8, 9.8, "west"),
  ];

  for (const house of houses) {
    it(`every furniture errand in the ${house.w}×${house.h} ${house.door}-door house arrives without flip-thrash`, () => {
      const pieces = houseFurniture(center, house, [{ key: "food", slot: 0 }, { key: "cloth", slot: 1 }]);
      const failures: string[] = [];
      const cuts: string[] = [];
      let worstSwitches = 0;
      for (const piece of pieces) {
        if (piece.kind === "chair" || piece.kind === "bowl") continue; // passthrough
        const r = walkErrand(house, piece.id);
        // A WALLED-IN target (its stand point itself unstandable — a fixture
        // buried in a corner cluster) is not owed an arrival: production's
        // stall watch gives up and applies the effect in place. It still must
        // TERMINATE, which reaching this line proves (the walk loop is bounded).
        if (!r.arrived && !r.walledIn) failures.push(`${piece.id} (t=${r.t.toFixed(1)}s, switches=${r.switches})`);
        // NO CORNER-CUTTING INDOORS. The route's own worst clearance is the
        // entire budget the follower may spend — every routed indoor point is
        // `tight`, meaning "walk this line exactly, the ground either side is
        // the furniture I routed you around". A body that ends up closer to a
        // fixture than its own plan ever went has cut a corner, whichever
        // shortcut did it (the aim bend, the wall glide, or the carrot's
        // lookahead chording across the routed vertices). The 5 cm slack is
        // locomotion's discretisation — one frame at walking pace.
        // The 10 cm slack is the follower's TRACKING error — a body steering a
        // 5 m/s line at 60 Hz sits a few centimetres off it — not a licence to
        // cut: the shortcuts this pins spent 0.13 m of a 0.20 m budget (the
        // carrot chording a dogleg) and half a metre of line (the wall glide).
        if (r.bodyClear < r.planClear - 0.1) {
          cuts.push(`${piece.id} (body ${r.bodyClear.toFixed(3)} < plan ${r.planClear.toFixed(3)})`);
        }
        if (r.maxDev > 0.3) cuts.push(`${piece.id} strayed ${r.maxDev.toFixed(3)} m off its plan`);
        worstSwitches = Math.max(worstSwitches, r.switches);
      }
      expect(failures).toEqual([]);
      expect(cuts).toEqual([]);
      // FLIP-THRASH pin: a healthy walk changes detour shoulder at most a
      // couple of times; the old dither flipped every few frames.
      expect(worstSwitches).toBeLessThanOrEqual(3);
    });
  }
});
