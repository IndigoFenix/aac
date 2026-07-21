// THE HEADLESS ERRAND WALK (DEBUG-CREATURE-BEHAVIOR §6's missing harness,
// first slice): real generated rooms + real furnishPlan furniture, walked by
// the REAL follower (createNpcController) over the REAL leg assembly
// (floor-route routeIndoorAware) with the REAL world-host detour block and
// REAL engine locomotion (steerAvatar + tickWorld door easing). Every
// furniture errand must ARRIVE — this is the sim that exposed, in turn: the
// tangency-blocked stand points, the corner-cut door wedge, the furniture-
// blind transits, the mid-room U-trap, the brake-stalled tight arrivals, and
// the early-turn carrot freeze. If it goes red, read that list first.
import { describe, it, expect } from "@jest/globals";
import {
  addLocalAvatar,
  createWorldState,
  expandWorldBuildings,
  steerAvatar,
  structuresWalkable,
  fixturesWalkable,
  tickWorld,
  type WorldState,
} from "@shared/world-engine/engine.js";
import {
  createDetourMemory,
  createNpcController,
  detourAim,
  sideOfBend,
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
  // Up to 3 attempts — quest-host's stall watch does the same: when a walk
  // ends short, the stand point is RE-PICKED from where the body actually
  // stands and the errand re-routed.
  for (let attempt = 0; attempt < 3; attempt++) {
    const from = { x: body.x, y: body.y };
    stand = standPointFor(s, pieceId, { x: obj.x, y: obj.y }, from);
    ctrl.setErrand({ points: routeIndoorAware(s, from, stand) });
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
      // The world-host detour block, verbatim: never on a tight routed leg.
      if (aim && !ctrl.errandLegTight()) {
        bent = detourAim({ x: body.x, y: body.y }, aim, walk, 0.4, mem.prefer("npc", t));
        if (bent !== aim) {
          const side = sideOfBend({ x: body.x, y: body.y }, aim, bent);
          mem.record("npc", side, t);
          if (lastSide !== 0 && side !== lastSide) switches++;
          lastSide = side;
        }
      }
      steerAvatar(s, "npc", bent, dt);
      tickWorld(s, { aim: null }, dt); // doors ease; the parked player brakes
      t += dt;
      if (!ctrl.hasErrand()) {
        done = true;
        break;
      }
    }
    if (done && Math.hypot(stand.x - body.x, stand.y - body.y) <= 1.3) {
      return { arrived: true, switches, t, walledIn: false };
    }
  }
  return { arrived: false, switches, t, walledIn: !standClear(s, stand) };
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
      let worstSwitches = 0;
      for (const piece of pieces) {
        if (piece.kind === "chair" || piece.kind === "bowl") continue; // passthrough
        const r = walkErrand(house, piece.id);
        // A WALLED-IN target (its stand point itself unstandable — a fixture
        // buried in a corner cluster) is not owed an arrival: production's
        // stall watch gives up and applies the effect in place. It still must
        // TERMINATE, which reaching this line proves (the walk loop is bounded).
        if (!r.arrived && !r.walledIn) failures.push(`${piece.id} (t=${r.t.toFixed(1)}s, switches=${r.switches})`);
        worstSwitches = Math.max(worstSwitches, r.switches);
      }
      expect(failures).toEqual([]);
      // FLIP-THRASH pin: a healthy walk changes detour shoulder at most a
      // couple of times; the old dither flipped every few frames.
      expect(worstSwitches).toBeLessThanOrEqual(3);
    });
  }
});
