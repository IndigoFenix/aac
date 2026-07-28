// shared/world-engine/furniture-use.ts
//
// THE FURNITURE USE-POINT CONTRACT — the ONE spec-side authority for HOW a
// body uses a fixture. Composing the visible "someone using furniture" pose
// used to draw from ~5 independent layers with no shared contract: the fixture
// spec (facing/radius), the renderer's anchor resolution, the rig conventions
// (origin at feet), the animator overlays (crouch/recline), and per-frame
// easing. Each fixture kind had a PRIVATE compensation path (sleep re-centres,
// sit drops, eat un-anchors), so a change to any layer silently shifted the
// picture and no test at the composition layer caught it (sitters floated a
// hip-height above seats while sim-side tests stayed green).
//
// This module gives every fixture kind THREE declared facts — the contract:
//   • usePoint      — WHERE on the fixture the use happens (local offset,
//                     forward/lateral/up as fractions of the piece's radius;
//                     forward = the fixture's own FRONT, +X in recipe space).
//   • useDirections — the local approach angle(s) a body uses it FROM (0 = the
//                     front). A door/fridge/chest is front-only; a table has
//                     four sides; a bed has both long sides + the foot. World
//                     angles are these rotated by the piece's `facing`.
//   • contactPart   — which body part must COINCIDE with the use point: a
//                     seat/toilet → the pelvis underside (a real drop onto the
//                     seat), a bed → the torso centre (the recline re-centres
//                     it), a table/container/door → a reach point at standing
//                     height (the body stays standing beside it).
//
// Defaults are DERIVED from the kind's semantics (STATION_PROPERTIES — a
// container/appliance is a front-approached reach; a chair/toilet is a seat; a
// bed is a bunk), so every existing kind gets a contract with no hand-tuning
// (emergent over scripted). A kind may OVERRIDE any field in USE_CONTRACTS.
//
// Renderer-agnostic and THREE-free: the composed world pose is pure math the
// renderer (render3d.resolveActivityAnchor), the sim (stand-points), and a
// headless test all read the SAME way — one contract, one composition.
//
// LAW (feedback_properties_from_spec_side): properties live on the SPEC side.
// This module READS the fixture spec; it never re-authors geometry. The
// use-point heights re-use object-models' own surface fractions so the contract
// and the drawn mesh can never disagree about where the seat/mattress is.

import type { FixtureKind } from "./types.js";
import { STATION_PROPERTIES } from "./kernel/town/stations.js";
import { BED_TOP_FRAC, SEAT_TOP_FRAC, TABLE_TOP_Y } from "./object-models.js";

/** Which body part lands ON the use point — selects the body-side vertical
 *  offset the rig applies (the drop/recline), so no fixture needs its own. */
export type ContactPart =
  /** The seat/toilet: the crouched pelvis underside rests on the surface (a real
   *  drop below the surface height — the sitter's feet hang toward the floor). */
  | "pelvis"
  /** The bed: the reclined torso centre lies on the mattress (the recline
   *  transform re-centres the lying body — its TARGET is the use point). */
  | "torso"
  /** A table/container/door/appliance: a reach point at standing height. The
   *  body stays STANDING beside the piece (never poses on it). */
  | "reach";

/** A local offset on the fixture, in fractions of its radius. `forward` runs
 *  along the fixture's FRONT (+X recipe axis, the way `facing` points),
 *  `lateral` perpendicular (+ = the front's left), `up` is height above the
 *  ground (the same "fraction of radius above the floor" frame as
 *  BED_TOP_FRAC / SEAT_TOP_FRAC). */
export interface UseOffset {
  forward: number;
  lateral: number;
  up: number;
}

/** WHAT a fixture kind declares about being used — the whole contract. */
export interface FixtureUseContract {
  /** Where the contact part lands (local, radius fractions). */
  usePoint: UseOffset;
  /** Local approach angles a body uses it from (radians, 0 = the front/+X).
   *  Front-only kinds carry `[0]`; multi-sided kinds list every usable side.
   *  The FIRST entry is the preferred side. World angles rotate these by the
   *  piece's `facing`. Never includes the wall side (a headboard, a cabinet
   *  back) — a body can't stand there. */
  useDirections: number[];
  /** The body part that coincides with the use point. */
  contactPart: ContactPart;
  /** Does the body pose ON the piece (a seat, a bed) or STAND BESIDE it (a
   *  table, a chest)? Only an on-fixture use produces a display anchor the body
   *  slides onto; a beside use poses the body where it stands. */
  onFixture: boolean;
}

// ---------------------------------------------------------------------------
// Derived defaults — the contract every kind gets for free from its semantics
// ---------------------------------------------------------------------------

/** The cardinal + long-side approach sets, reused by the defaults. */
const FRONT_ONLY = [0];
const FOUR_SIDES = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
/** A bed's usable approaches: both long sides and the foot — never the
 *  headboard (−X, against the wall). The recipe lays the bed long in X with the
 *  headboard at −X, so the open sides are ±Z (±π/2) and the foot is +X (0). */
const BED_SIDES = [Math.PI / 2, -Math.PI / 2, 0];

/** A nominal reach height (fraction of radius above the floor) for a
 *  beside-used piece — chest/cabinet high. Only the sim stand-side + the debug
 *  dump read it (a reach use never anchors the body), so it need not match a
 *  specific mesh face; it just has to read as "at the front, waist-ish high". */
const REACH_UP = 1.0;

/** Is a kind a container/appliance a body OPENS or works at from its FRONT? */
function isReachStation(kind: FixtureKind): boolean {
  const props = STATION_PROPERTIES[kind] ?? [];
  return props.includes("container") || props.includes("appliance");
}

/**
 * THE DERIVED CONTRACT: what a kind gets purely from its semantics, before any
 * per-kind override. Seats (chair/toilet) drop a pelvis onto their seat surface;
 * a bed lies a torso on its mattress; everything a body OPENS or works at
 * (chest, cupboard, refrigerator, oven, workbench, barrel, bin) is a
 * front-approached reach; anything else is a reach from any open side.
 */
export function defaultContract(kind: FixtureKind): FixtureUseContract {
  if (kind === "chair" || kind === "toilet") {
    return {
      usePoint: { forward: 0, lateral: 0, up: SEAT_TOP_FRAC[kind] ?? 1.0 },
      // The sitter sits FACING the way the seat faces — the front (0). Solid
      // seats (a toilet) are still approached from the front; a chair is
      // pass-through so the approach is trivial, but the side stays the front.
      useDirections: FRONT_ONLY,
      contactPart: "pelvis",
      onFixture: true,
    };
  }
  if (kind === "bed") {
    return {
      usePoint: { forward: 0, lateral: 0, up: BED_TOP_FRAC },
      useDirections: BED_SIDES,
      contactPart: "torso",
      onFixture: true,
    };
  }
  if (kind === "bath") {
    // YOU GET IN THE BATH. A tub used to take the generic beside-reach — the
    // same contract as a table — so a body washing ITSELF stood outside the tub
    // and reached in. It settles INSIDE instead: the use point is the basin
    // (SEAT_TOP_FRAC bath), and the pelvis contact drops the body into the
    // water rather than perching it on the rim.
    //
    // This does NOT capture a body washing SOMETHING ELSE at the tub, and
    // deliberately so — that isn't a per-kind distinction to make here. A
    // laundry scrub runs as a `processStack` dwell, which poses the body where
    // it stands and names no station, so it never reaches the on-fixture anchor
    // at all. Only a `rest`-shaped use (hygiene's own restAt) hands the anchor
    // a station id. The two uses of one tub separate themselves.
    return {
      usePoint: { forward: 0, lateral: 0, up: SEAT_TOP_FRAC["bath"] ?? 0.4 },
      useDirections: FOUR_SIDES, // step in from whichever side the room leaves open
      contactPart: "pelvis",
      onFixture: true,
    };
  }
  if (isReachStation(kind)) {
    return {
      usePoint: { forward: 1, lateral: 0, up: REACH_UP },
      useDirections: FRONT_ONLY, // open it from the FRONT — never the side
      contactPart: "reach",
      onFixture: false,
    };
  }
  // Tables, baths, bowls and any future plain furniture: a reach from any open
  // side (a table is eaten at from every side; a bath is scrubbed at).
  return {
    usePoint: { forward: 1, lateral: 0, up: REACH_UP },
    useDirections: FOUR_SIDES,
    contactPart: "reach",
    onFixture: false,
  };
}

/**
 * Per-kind OVERRIDES layered onto the derived default. Only what the geometry
 * demands beyond the semantic default lives here — the table's realistic
 * tabletop reach (decoupled from its wide footprint), and nothing else so far.
 * The default already gives chairs/toilets/beds/containers the right contract.
 */
const OVERRIDES: Partial<Record<FixtureKind, Partial<FixtureUseContract>>> = {
  table: {
    // The tabletop is a fixed world height, DECOUPLED from the (wide) footprint
    // radius — mirror object-models' TABLE_TOP_Y so the reach sits at the real
    // top. A table's radius is ~0.8, so express the world height as a fraction.
    usePoint: { forward: 0.9, lateral: 0, up: TABLE_TOP_Y / 0.8 },
  },
};

/** The full contract for a kind — the derived default with its override merged. */
export function useContractFor(kind: FixtureKind): FixtureUseContract {
  const base = defaultContract(kind);
  const over = OVERRIDES[kind];
  if (!over) return base;
  return {
    usePoint: over.usePoint ?? base.usePoint,
    useDirections: over.useDirections ?? base.useDirections,
    contactPart: over.contactPart ?? base.contactPart,
    onFixture: over.onFixture ?? base.onFixture,
  };
}

// ---------------------------------------------------------------------------
// Composition — the ONE place the local contract becomes a world transform
// ---------------------------------------------------------------------------

/** A fixture as the contract needs to read it: its world centre, footprint
 *  radius, front-facing GAME angle, and the ground height at its base. */
export interface FixturePose {
  x: number;
  y: number;
  radius: number;
  /** GAME angle the front points at (radians, 0 = +x). Absent = 0. */
  facing?: number;
  /** World height of the fixture's base (terrain + storey lift). */
  groundZ: number;
}

/** The composed WORLD use point + facing for an ON-FIXTURE use (a seat, a bed):
 *  where the contact part must land and which way the body faces. `contact`
 *  tells the rig which body-side offset to apply. The vertical `z` is the
 *  SURFACE height; the rig then drops/re-centres by its own contact offset.
 *
 *  Coordinates: `x`/`z` are the GAME plan (the renderer maps game y → three z),
 *  `y` is the world height — matching resolveActivityAnchor's existing shape
 *  `{ x, y, z, yaw }` so it is a drop-in. `yaw` is the THREE yaw for the body,
 *  already through the game-angle→yaw mirror (via `bodyYaw`). */
export interface UseAnchor {
  x: number;
  y: number;
  z: number;
  yaw: number;
  contact: ContactPart;
}

/** Rotate a local (forward, lateral) offset into the GAME plan by `facing`. */
function toWorldPlan(fx: number, lat: number, facing: number): { dx: number; dy: number } {
  const c = Math.cos(facing);
  const s = Math.sin(facing);
  // forward runs along +facing; lateral is +90° from it.
  return { dx: fx * c - lat * s, dy: fx * s + lat * c };
}

/**
 * THE SHARED PLACEMENT FUNCTION for an on-fixture use: compose the fixture's
 * contract + pose into the world use anchor. Consumed by
 * render3d.resolveActivityAnchor (which then hands it to the creature model)
 * and by the composition test — one formula, provably shared.
 *
 * `bodyYaw(facing)` converts the fixture's front game-angle into the body's
 * THREE yaw (render3d.sitterYaw / bedSleeperYaw own that mirror — the contract
 * stays THREE-free by taking it as a parameter).
 */
export function useAnchorWorld(
  contract: FixtureUseContract,
  fixture: FixturePose,
  bodyYaw: (facing: number | undefined) => number,
): UseAnchor {
  const r = fixture.radius;
  const facing = fixture.facing ?? 0;
  const { dx, dy } = toWorldPlan(contract.usePoint.forward * r, contract.usePoint.lateral * r, facing);
  return {
    x: fixture.x + dx,
    y: fixture.groundZ + contract.usePoint.up * r,
    z: fixture.y + dy,
    yaw: bodyYaw(fixture.facing),
    contact: contract.contactPart,
  };
}

/** The PLAN (GAME x/y) projection of an on-fixture use point — WHERE the sim
 *  body must stand to be ON the fixture (a bed/seat centre). The sim is plan-view
 *  2D, so the vertical `up` is irrelevant here; this drops it, reusing the SAME
 *  composition as `useAnchorWorld` (whose `x` is the game x and `z` the game y) so
 *  the sim body and the rendered pose can never disagree about the use point. */
export function useAnchorPlan(contract: FixtureUseContract, fixture: FixturePose): { x: number; y: number } {
  const a = useAnchorWorld(contract, fixture, () => 0);
  return { x: a.x, y: a.z };
}

/** The WORLD approach angles (GAME frame) a body may use the fixture from —
 *  the local `useDirections` rotated by the piece's facing, preferred first. */
export function useDirectionsWorld(contract: FixtureUseContract, facing: number | undefined): number[] {
  const f = facing ?? 0;
  return contract.useDirections.map((a) => a + f);
}

/** Unit stand-side vectors (GAME plan) pointing FROM the fixture toward each
 *  usable approach side, preferred first — where a body STANDS to use the piece
 *  (a fridge only from the front, a table from any side). Feeds the sim stand
 *  spot so a body opens the fridge from the front, never the side. */
export function useSideDirs(contract: FixtureUseContract, facing: number | undefined): { x: number; y: number }[] {
  return useDirectionsWorld(contract, facing).map((a) => ({ x: Math.cos(a), y: Math.sin(a) }));
}

// ---------------------------------------------------------------------------
// Live debug — per-creature composed pose vs use-point delta (__questLab)
// ---------------------------------------------------------------------------

/** The minimal live-world slice the pose dump reads (a WorldState subset), so
 *  this stays decoupled from the full engine type and THREE-free. */
export interface UseDumpWorld {
  avatars: Record<
    string,
    { id: string; x: number; y: number; fx: number; fy: number; activity?: { kind: string; objId?: string } }
  >;
  objects: Record<string, { x: number; y: number } | undefined>;
  spec: { objects: ReadonlyArray<{ id: string; radius: number; facing?: number; fixture?: FixtureKind }> };
}

/** One body's composed pose measured against its fixture's use-point contract. */
export interface UsePoseDelta {
  id: string;
  fixture: FixtureKind;
  contactPart: ContactPart;
  onFixture: boolean;
  /** World use point (GAME plan) the contact part should land on. */
  usePoint: { x: number; y: number };
  /** The sim body's current plan position. */
  body: { x: number; y: number };
  /** Planar body→use-point distance (0 = dead on the use point). */
  planarDelta: number;
  /** |body heading − expected heading|, radians. An on-fixture use expects the
   *  body to face the fixture's own facing; a beside use expects it to face the
   *  fixture. A big number is a visibly wrong sit/sleep/reach. */
  yawDelta: number;
}

/** DUMP every creature currently in an activity against the use-point contract
 *  — the one-console-call eyeball check the __questLab hooks expose. Pure over a
 *  WorldState slice: for each body with an `activity.objId` naming a fixture, it
 *  reports the fixture, contact part, the world use point, the sim body, and the
 *  planar + yaw deltas — so a wrong-looking pose is one number away. */
export function furnitureUsePoseDump(world: UseDumpWorld): UsePoseDelta[] {
  const out: UsePoseDelta[] = [];
  for (const a of Object.values(world.avatars)) {
    const act = a.activity;
    if (!act?.objId) continue;
    const spec = world.spec.objects.find((s) => s.id === act.objId);
    const obj = world.objects[act.objId];
    if (!spec?.fixture || !obj) continue;
    const contract = useContractFor(spec.fixture);
    const facing = spec.facing ?? 0;
    const { dx, dy } = toWorldPlan(contract.usePoint.forward * spec.radius, contract.usePoint.lateral * spec.radius, facing);
    const usePoint = { x: obj.x + dx, y: obj.y + dy };
    const bodyAngle = Math.atan2(a.fy, a.fx);
    // On-fixture: the body takes the fixture's own facing. Beside: it faces the
    // fixture from the use side.
    const expected = contract.onFixture ? facing : Math.atan2(obj.y - a.y, obj.x - a.x);
    out.push({
      id: a.id,
      fixture: spec.fixture,
      contactPart: contract.contactPart,
      onFixture: contract.onFixture,
      usePoint,
      body: { x: a.x, y: a.y },
      planarDelta: Math.hypot(usePoint.x - a.x, usePoint.y - a.y),
      yawDelta: Math.abs(Math.atan2(Math.sin(bodyAngle - expected), Math.cos(bodyAngle - expected))),
    });
  }
  return out;
}
