/**
 * The spirit LADDER (shared/world-engine/spirit/ladder.ts) — the one level
 * state machine over a mock SpiritFrameProvider. Pins: the FLIGHT→TOWN enter
 * gate, the dwell descent (town → district → structure), the BLENDED
 * structure zoom (no camera handoff — monotone pose blend, pointer gated on
 * arrival), the bottom-dwell ascent, and the CEILING law (initial_focus is
 * the initial ceiling; scope is absolute).
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { createSpiritLadder, CITY_FOCUS_ALT, GROUND_ENTER_ALT } from "@shared/world-engine/spirit/ladder";
import { createDroneCamera } from "@shared/world-engine/spirit/drone-camera";
import type {
  SpiritFrameProvider, SpiritFocusTarget, SpiritGroundBuildingHit, SpiritLevel,
  SpiritNearTown, SpiritStructureHost, SpiritTownSession,
} from "@shared/world-engine/spirit/frame-provider";

const DT = 1 / 60;

interface MockWorld {
  provider: SpiritFrameProvider;
  host: SpiritStructureHost & { log: string[]; pointerCount: number };
  setNearTown(near: SpiritNearTown | null): void;
  setPicks(district: SpiritFocusTarget | null, building: SpiritFocusTarget | null): void;
  setGroundBuilding(hit: SpiritGroundBuildingHit | null): void;
  /** placeAvatar calls on the GROUND session (the glide parks the walker). */
  groundPlaced(): number;
  /** THE BODY THE SPARK DRIVES (session-local), or null for a free spirit. */
  setDrivenBody(b: { x: number; z: number; fx: number; fz: number } | null): void;
  /** Where placeAvatar last parked the spark's own body (session-local). */
  placedAt(): { x: number; z: number } | null;
  /** GROUND RELIEF — terrain height (anchor-chart y) at session-local (x,z).
   *  Default flat. A chart standing at (x,z) has its origin ON the terrain, and
   *  `groundY` reports the same height: exactly the planet provider's contract
   *  (`createSurfaceChart(body, dirAt(x,z), groundHAt(...))`). */
  setRelief(fn: (x: number, z: number) => number): void;
  /** The last world position the ladder's overlay spark was placed at. */
  sparkAt(): THREE.Vector3 | null;
  /** ILLUSORY MOTION: the last camera-local drift handed to the spark (null =
   *  explicitly cleared). `undefined` = never called at all. */
  sparkDrift(): THREE.Vector3 | null | undefined;
  /** PLANET-LAW seams (drawnWorld mocks only): what the host REPORTED and
   *  what the ladder DREW. */
  setHostCursor(c: { pos: THREE.Vector3; hovering: boolean; select: number } | null): void;
  hostExtCursor(): boolean | null;
  groundSparkCalls(): ({ x: number; y: number } | null)[];
  /** The dwell progress the ladder passed through with each drawn-world cast —
   *  the engine's bloom riding on the ray's metres. */
  groundSparkSelects(): number[];
  /** The SNAP POINT (an entity engine's own placement) handed to the last
   *  ground-cursor call, or null when the ray decided the metres. */
  groundSparkAt(): THREE.Vector3 | null;
  setTownCalls(): (unknown | null)[];
  sparkHover(): boolean;
  sparkSelect(): number;
  /** How often the ladder HID the spark (spark(null)). Hiding it on a frame
   *  that then re-targets it takes GazeSpark's "appear in place" path, which
   *  kills the dart forever — see the teleport pin. */
  sparkNullCalls(): number;
}

function mockWorld(
  scope: SpiritLevel,
  withFlight: boolean,
  opts?: { drawnWorld?: boolean },
): MockWorld {
  const camera = new THREE.PerspectiveCamera(60, 800 / 600);
  let nearTown: SpiritNearTown | null = null;
  let districtPick: SpiritFocusTarget | null = null;
  let buildingPick: SpiritFocusTarget | null = null;
  let groundBuilding: SpiritGroundBuildingHit | null = null;
  let placed = 0;
  let placedAt: { x: number; z: number } | null = null;
  let driven: { x: number; z: number; fx: number; fz: number } | null = null;
  let relief: (x: number, z: number) => number = () => 0;
  let sparkAt: THREE.Vector3 | null = null;
  let sparkDrift: THREE.Vector3 | null | undefined = undefined;
  let sparkHover = false;
  let sparkSelect = 0;
  let hostCursor: { pos: THREE.Vector3; hovering: boolean; select: number } | null = null;
  let hostExtCursor: boolean | null = null;
  let sparkNullCalls = 0;
  const groundSparkCalls: ({ x: number; y: number } | null)[] = [];
  const groundSparkSelects: number[] = [];
  let groundSparkAt: THREE.Vector3 | null = null;
  const setTownCalls: (unknown | null)[] = [];

  const host: MockWorld["host"] = {
    log: [],
    pointerCount: 0,
    setSpiritFocus(frame) { this.log.push(`focus:${frame ? `${frame.x},${frame.y},${frame.w},${frame.h}` : "null"}`); },
    dollhousePose(_frame, az, out) {
      out.pos.set(100 + Math.cos(az) * 20, 15, 100 + Math.sin(az) * 20);
      out.look.set(100, 2, 100);
      out.up.set(0, 1, 0);
      out.fov = 40;
    },
    placeGazeAvatar(x, y) { this.log.push(`avatar:${x},${y}`); },
    setPointer() { this.pointerCount++; },
    clearPointer() { /* noop */ },
    step() { /* noop */ },
    // Planet-law seam: separate capture (not `log`) so existing pins on log
    // contents stay byte-stable.
    setExternalCursor(on) { hostExtCursor = on; },
    cursorWorld(out) {
      if (!hostCursor) return null;
      out.copy(hostCursor.pos);
      return { hovering: hostCursor.hovering, select: hostCursor.select };
    },
  };

  const session: SpiritTownSession = {
    label: "Mockville",
    radius: () => 400,
    chartAt: (x, z) => ({
      origin: new THREE.Vector3(x, 0, z),
      east: new THREE.Vector3(1, 0, 0),
      north: new THREE.Vector3(0, 0, 1),
      up: new THREE.Vector3(0, 1, 0),
    }),
    pickDistrict: () => districtPick,
    pickBuilding: () => buildingPick,
    structureHost: () => host,
  };

  const drone = createDroneCamera(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), 1000);
  const provider: SpiritFrameProvider = {
    scopeLevel: scope,
    camera,
    viewSize: () => ({ w: 800, h: 600 }),
    advance() { /* noop */ },
    rebaseOnCamera: () => ({ near: 0.5, far: 1e9, camAtOrigin: false }),
    postFrame: () => ({ nearTown, waiting: null }),
    openTown: () => session,
    openGround: (worldPos) => ({
      // A chart STANDS ON THE TERRAIN at (x,z) — its origin carries the relief,
      // and its `up` is the local vertical, so the tangent plane through it is
      // horizontal at that ground height (the planet provider's real shape).
      chartAt: (x, z) => ({
        origin: new THREE.Vector3(worldPos.x + x, relief(x, z), worldPos.z + z),
        east: new THREE.Vector3(1, 0, 0),
        north: new THREE.Vector3(0, 0, 1),
        up: new THREE.Vector3(0, 1, 0),
      }),
      groundY: (x, z) => relief(x, z),
      // The mock building occupies a REAL region (session-local) — the
      // gaze-in-building possession rule needs spatial misses to exist. A
      // centre-screen gaze from the shoulder rig rests ~19 m ahead (inside);
      // a top-of-screen gaze rests ~84 m ahead (past the far wall).
      buildingAt: (x, z) =>
        groundBuilding && Math.abs(x) <= 30 && z >= -10 && z <= 70 ? groundBuilding : null,
      placeAvatar: (x, z) => { placed++; placedAt = { x, z }; },
      drivenBody: () => driven,
      // setTown = the dynamic-town-content opt-in (planet-shaped sessions
      // only; a flat session's town never changes and its postFrame reports
      // no nearTown — the ladder must not strip its ref).
      ...(opts?.drawnWorld ? { setTown: (ref: unknown | null) => { setTownCalls.push(ref); } } : {}),
    }),
    ...(withFlight ? {
      flight: {
        drone,
        radius: 6_000_000,
        minAlt: 12,
        maxAlt: 1_000_000,
        screenToChart: () => ({ x: 0, y: 0 }),
        groundPoint: (out: THREE.Vector3) => out.set(0, 0, 0),
        stepStreaming: () => ({ near: 0.5, far: 1e9 }),
        placeCamera() { /* noop */ },
      },
    } : {}),
    spark(pos, hovering, select) {
      if (!pos) sparkNullCalls++;
      sparkAt = pos ? pos.clone() : null;
      sparkHover = hovering ?? false;
      sparkSelect = select ?? 0;
    },
    sparkDrift(vel) { sparkDrift = vel ? vel.clone() : null; },
    // A DRAWN world to raycast = the planet path (the flat default omits it,
    // exactly as the flat provider does).
    ...(opts?.drawnWorld ? {
      groundSpark(pointer: { x: number; y: number } | null, select?: number, at?: THREE.Vector3) {
        groundSparkCalls.push(pointer ? { ...pointer } : null);
        groundSparkSelects.push(select ?? 0);
        groundSparkAt = at ? at.clone() : null;
        return true;
      },
    } : {}),
  };

  return {
    provider, host,
    setNearTown: (n) => { nearTown = n; },
    setPicks: (d, b) => { districtPick = d; buildingPick = b; },
    setGroundBuilding: (h) => { groundBuilding = h; },
    groundPlaced: () => placed,
    setDrivenBody: (b) => { driven = b; },
    placedAt: () => placedAt,
    setRelief: (fn) => { relief = fn; },
    sparkAt: () => sparkAt,
    sparkDrift: () => sparkDrift,
    setHostCursor: (c) => { hostCursor = c; },
    hostExtCursor: () => hostExtCursor,
    groundSparkCalls: () => groundSparkCalls,
    groundSparkSelects: () => groundSparkSelects,
    groundSparkAt: () => groundSparkAt,
    setTownCalls: () => setTownCalls,
    sparkHover: () => sparkHover,
    sparkSelect: () => sparkSelect,
    sparkNullCalls: () => sparkNullCalls,
  };
}

/** A steady pointer at screen centre (inside the dwell zone). */
const CENTRE = { x: 400, y: 300, clientX: 400, clientY: 300 };
/** A steady pointer on the bottom exit strip (ndcY < −0.7). */
const BOTTOM = { x: 400, y: 570, clientX: 400, clientY: 570 };

const run = (ladder: ReturnType<typeof createSpiritLadder>, pointer: typeof CENTRE | null, frames: number): void => {
  let now = 0;
  for (let i = 0; i < frames; i++) {
    now += DT * 1000;
    ladder.step(pointer, DT, now);
  }
};

/**
 * ILLUSORY MOTION — the flight spark's slipstream + depth.
 *
 * The drone crosses the planet at hundreds of m/s, but the camera rides with
 * it and the HUD spark is parented to the camera, so NOTHING on screen moves.
 * The ladder fakes it from the steering rates. What's worth pinning is not the
 * magnitudes (pure feel — `SLIP_GAIN`/`SLIP_DEPTH_GAIN` are tuning knobs) but
 * the SIGNS: every one of them is a chance to get the illusion exactly
 * backwards, and backwards still looks like a plausible effect on screen.
 *
 * The mock's `placeCamera` is a no-op, so the camera stays at the origin
 * un-rotated and camera-local == world here — which is what lets these read
 * the drift components straight off the axes.
 */
describe("FLIGHT — the spark's illusory motion", () => {
  /** ndc → the mock's 800×600 pointer. */
  const at = (ndcX: number, ndcY: number): typeof CENTRE => {
    const x = ((ndcX + 1) / 2) * 800;
    const y = ((1 - ndcY) / 2) * 600;
    return { x, y, clientX: x, clientY: y };
  };
  // Each of these isolates ONE regime (see the zone constants in ladder.ts):
  // the dead zone is a disc of r=0.24 about (0, −0.3), so screen centre is
  // already outside it and dives at full rate.
  const TOP = at(0, 0.9);      // forward only
  const RIGHT = at(1, 0);      // side-pan right only (|x| past the rot edge)
  const TURN = at(0.4, 0);     // rotate right (inside the rot edge) + some dive
  const DIVE = CENTRE;         // straight down
  const RISE = BOTTOM;         // straight up

  const flyWith = (pointer: typeof CENTRE, frames = 1): MockWorld => {
    const w = mockWorld("flight", true);
    const ladder = createSpiritLadder({ provider: w.provider, ceiling: "flight" });
    run(ladder, pointer, frames);
    expect(ladder.level).toBe("flight"); // never fell through to a rung change
    return w;
  };

  it("embers stream BACKWARD when flying forward", () => {
    const d = flyWith(TOP).sparkDrift()!;
    expect(d).not.toBeNull();
    expect(d.y).toBeLessThan(0); // forward is up-screen ⇒ the world runs down it
    expect(Math.abs(d.x)).toBeLessThan(Math.abs(d.y) * 0.1); // and only that way
  });

  it("embers stream LEFT when panning right", () => {
    const d = flyWith(RIGHT).sparkDrift()!;
    expect(d.x).toBeLessThan(0);
    expect(Math.abs(d.y)).toBeLessThan(Math.abs(d.x) * 0.1);
  });

  it("turning right sweeps the world counter-clockwise about screen centre", () => {
    // Turn your head right and the scene sweeps left: a point at screen-RIGHT
    // rides UP-screen. The pointer that commands the turn is itself right of
    // centre, so the spark sits at +x and its drift must be +y.
    const d = flyWith(TURN).sparkDrift()!;
    expect(d.y).toBeGreaterThan(0);
  });

  it("embers stream INTO the screen when climbing, and OUT of it when diving", () => {
    // +z is toward the viewer. Climb and the world falls away behind the
    // screen; dive and it rushes out past your head.
    expect(flyWith(RISE).sparkDrift()!.z).toBeLessThan(0);
    expect(flyWith(DIVE).sparkDrift()!.z).toBeGreaterThan(0);
  });

  it("a still camera leaves no wake", () => {
    // Dead centre of the dead zone: no regime fires, so nothing may fizz.
    const d = flyWith(at(0, -0.3), 10).sparkDrift()!;
    expect(d.length()).toBeCloseTo(0, 9);
  });

  it("the spark LEADS: it draws IN while climbing and throws OUT while diving", () => {
    // The camera looks down, so up is toward the viewer — climbing, the spark
    // leads up out of the world and swells; diving, it plunges out ahead. It
    // leads while the embers trail, and the OPPOSITION is what sells it: a
    // spark drifting back with its own wake reads as sliding, not accelerating.
    // The camera is at the origin here, so |sparkAt| IS the spark's depth.
    const rest = flyWith(at(0, -0.3), 1).sparkAt()!.length();
    // Long enough for the ~0.4s ease to have committed, short enough to stay
    // airborne (1000 m · e^−0.9 ≈ 407 m, well over GROUND_ENTER_ALT).
    expect(flyWith(RISE, 60).sparkAt()!.length()).toBeLessThan(rest);
    expect(flyWith(DIVE, 60).sparkAt()!.length()).toBeGreaterThan(rest);
  });

  it("the depth EASES rather than stepping — the acceleration read", () => {
    // One frame of dive must barely move it; a held dive must move it a lot.
    // A step change would read as a size pop instead of acceleration (and,
    // past the spark's dart threshold, would fire a spurious dart).
    const rest = flyWith(at(0, -0.3), 1).sparkAt()!.length();
    const oneFrame = Math.abs(flyWith(DIVE, 1).sparkAt()!.length() - rest);
    const settled = Math.abs(flyWith(DIVE, 60).sparkAt()!.length() - rest);
    expect(oneFrame).toBeGreaterThan(0);
    expect(oneFrame).toBeLessThan(settled * 0.15);
    expect(oneFrame).toBeLessThan(0.5); // GazeSpark's dartThresh — no false dart
  });

  it("is cleared on any rung but FLIGHT — no fizzing ground cursor", () => {
    const w = mockWorld("flight", true);
    const ladder = createSpiritLadder({ provider: w.provider, ceiling: "flight" });
    run(ladder, DIVE, 1);
    expect(w.sparkDrift()!.length()).toBeGreaterThan(0);
    // Dive to the deck: the ladder hands over to the ground rung, and the
    // drift it was holding must not survive the handover.
    w.provider.flight!.drone.altitude = GROUND_ENTER_ALT - 1;
    run(ladder, DIVE, 2);
    expect(ladder.level).toBe("ground");
    expect(w.sparkDrift()).toBeNull();
  });
});

describe("FLIGHT → TOWN — the enter gate", () => {
  it("enters town-focus only under the altitude gate and within the town's own radius", () => {
    const w = mockWorld("flight", true);
    const ladder = createSpiritLadder({ provider: w.provider, ceiling: "flight" });
    expect(ladder.level).toBe("flight");
    // A town far away — no entry.
    w.setNearTown({ ref: {}, label: "Mockville", distM: 5_000, radius: 400 });
    run(ladder, null, 10);
    expect(ladder.level).toBe("flight");
    // Close, but the drone is too high.
    w.provider.flight!.drone.altitude = CITY_FOCUS_ALT * 2;
    w.setNearTown({ ref: {}, label: "Mockville", distM: 100, radius: 400 });
    run(ladder, null, 10);
    expect(ladder.level).toBe("flight");
    // Low and close — enter.
    w.provider.flight!.drone.altitude = 1000;
    run(ladder, null, 2);
    expect(ladder.level).toBe("town");
  });
});

describe("TOWN — dwell descent and blended structure zoom", () => {
  const frame = { x: 500, y: 480, w: 12, h: 10 };

  function descendToStructure(): { w: MockWorld; ladder: ReturnType<typeof createSpiritLadder> } {
    const w = mockWorld("flight", true);
    const ladder = createSpiritLadder({
      provider: w.provider, ceiling: "flight",
      start: { level: "town", town: {} },
    });
    w.setPicks(
      { kind: "district", x: 50, z: 30, radius: 120 },
      { kind: "building", x: 55, z: 33, radius: 14, frame },
    );
    // Blend in (blend > 0.9 gates the dwell), then dwell town→district→building.
    run(ladder, CENTRE, 600);
    return { w, ladder };
  }

  it("town → district → STRUCTURE by steady centre dwell; the dollhouse engages once", () => {
    const { w, ladder } = descendToStructure();
    expect(ladder.level).toBe("structure");
    // The dollhouse was framed on the picked building and the gaze walker parked.
    expect(w.host.log).toContain(`focus:${frame.x},${frame.y},${frame.w},${frame.h}`);
    expect(w.host.log.filter((l) => l.startsWith("avatar:")).length).toBe(1);
    expect(w.host.log).toContain(`avatar:${frame.x + frame.w / 2},${frame.y + frame.h / 2}`);
  });

  it("the structure zoom BLENDS (camera eases monotonically toward the dollhouse pose)", () => {
    const w = mockWorld("flight", true);
    const ladder = createSpiritLadder({
      provider: w.provider, ceiling: "flight",
      start: { level: "town", town: {} },
    });
    w.setPicks(
      { kind: "district", x: 50, z: 30, radius: 120 },
      { kind: "building", x: 55, z: 33, radius: 14, frame },
    );
    run(ladder, CENTRE, 600);
    expect(ladder.level).toBe("structure");
    // From here the camera should CLOSE IN on the dollhouse pose every frame.
    // FACING CONTINUITY: the dollhouse starts at the orbit's azimuth + π/2
    // (the orbit az never moved off 0 — the pointer sat at screen centre).
    const az = Math.PI / 2;
    const target = new THREE.Vector3(100 + 20 * Math.cos(az), 15, 100 + 20 * Math.sin(az));
    let prev = Infinity;
    let now = 700 * DT * 1000;
    for (let i = 0; i < 60; i++) {
      now += DT * 1000;
      ladder.step(CENTRE, DT, now);
      const d = w.provider.camera.position.distanceTo(target);
      expect(d).toBeLessThanOrEqual(prev + 1e-6); // monotone, never a jump-back
      prev = d;
    }
    expect(prev).toBeLessThan(1); // arrived at the dollhouse pose
    expect(w.provider.camera.fov).toBeCloseTo(40, 3); // dollhouse fov landed
  });

  it("pointer forwards to the host only once the blend has arrived", () => {
    const w = mockWorld("flight", true);
    const ladder = createSpiritLadder({
      provider: w.provider, ceiling: "flight",
      start: { level: "town", town: {} },
    });
    w.setPicks(
      { kind: "district", x: 50, z: 30, radius: 120 },
      { kind: "building", x: 55, z: 33, radius: 14, frame },
    );
    // Reach structure level, then measure pointer forwarding across the blend.
    let now = 0;
    let entered = -1;
    for (let i = 0; i < 700; i++) {
      now += DT * 1000;
      ladder.step(CENTRE, DT, now);
      if (ladder.level === "structure" && entered < 0) entered = i;
    }
    expect(entered).toBeGreaterThan(0);
    // Forwarding started only after the blend crossed its gate — the count is
    // well below the frames spent at structure level.
    const structureFrames = 700 - entered;
    expect(w.host.pointerCount).toBeGreaterThan(0);
    expect(w.host.pointerCount).toBeLessThan(structureFrames - 30);
  });

  it("bottom dwell steps back out: structure → GROUND (the rung above; reverse blend)", () => {
    const { ladder } = descendToStructure();
    expect(ladder.level).toBe("structure");
    // Exit dwell (0.5 s) + reverse blend (0.7 s) ≈ 75 frames — lands in the
    // glide at the building's doorstep.
    run(ladder, BOTTOM, 100);
    expect(ladder.level).toBe("ground");
    // Remaining on the bottom ascends again: ground → district orbit.
    run(ladder, BOTTOM, 120);
    expect(ladder.level).toBe("town");
  });

  it("leaving the dollhouse SEALS the cutaway (setSpiritFocus null on exit)", () => {
    const { w, ladder } = descendToStructure();
    run(ladder, BOTTOM, 100);
    expect(ladder.level).toBe("ground");
    const focusLog = w.host.log.filter((l) => l.startsWith("focus:"));
    expect(focusLog[focusLog.length - 1]).toBe("focus:null");
  });

  it("exiting a structure never instantly re-enters one (entry arms only outside a footprint)", () => {
    const { w, ladder } = descendToStructure();
    expect(ladder.level).toBe("structure");
    // The glide's spawn point reads as INSIDE a footprint (a dense block):
    // the dollhouse must not bounce straight back in — entry stays unarmed.
    w.setGroundBuilding({
      town: {},
      target: { kind: "building", x: 55, z: 33, radius: 14, frame },
    });
    run(ladder, BOTTOM, 100);
    expect(ladder.level).toBe("ground");
    run(ladder, null, 200);
    expect(ladder.level).toBe("ground");
  });

  it("the GROUND glide parks the invisible avatar on itself every frame", () => {
    const { w, ladder } = descendToStructure();
    run(ladder, BOTTOM, 100);
    expect(ladder.level).toBe("ground");
    const before = w.groundPlaced();
    run(ladder, null, 60);
    expect(w.groundPlaced() - before).toBe(60);
  });

  it("town/district framing keeps every roof sealed (no town-wide reveal)", () => {
    const w = mockWorld("flight", true);
    const ladder = createSpiritLadder({
      provider: w.provider, ceiling: "flight",
      start: { level: "town", town: {} },
    });
    run(ladder, CENTRE, 400); // no picks set — the orbit just frames the town
    expect(ladder.level).toBe("town");
    expect(w.host.log.some((l) => l.startsWith("focus:") && l !== "focus:null")).toBe(false);
  });
});

/**
 * THE CORNER TURNTABLE (shared/world-engine/spirit/corner-orbit.ts).
 *
 * Every focus the ladder can hold — a structure, a district, a city, a whole
 * region — is circled by the SAME law: park the spark in a screen CORNER.
 * Lower-left / upper-right wind the azimuth UP (the camera goes
 * counter-clockwise over an east/north chart); upper-left / lower-right wind it
 * DOWN. The vertical half is what picks the direction, so the pins below are on
 * the SIGNS: a side-only law (the bug) reads as a plausible orbit until you
 * notice the far rim spins the wrong way under your gaze.
 */
describe("ORBIT — the screen corners circle whatever is framed", () => {
  const frame = { x: 500, y: 480, w: 12, h: 10 };
  /** ndc → the mock's 800×600 pointer. */
  const at = (ndcX: number, ndcY: number): typeof CENTRE => {
    const x = ((ndcX + 1) / 2) * 800;
    const y = ((1 - ndcY) / 2) * 600;
    return { x, y, clientX: x, clientY: y };
  };
  const LOWER_LEFT = at(-0.95, -0.85);
  const UPPER_RIGHT = at(0.95, 0.85);
  const UPPER_LEFT = at(-0.95, 0.85);
  const LOWER_RIGHT = at(0.95, -0.85);
  /** Same screen side, ON the crossover row — the direction ramps to nothing. */
  const MID_LEFT = at(-0.95, 0);

  /**
   * Turn a TOWN/DISTRICT/REGION framing with `pointer` and report the azimuth
   * swept. A flat town-scope world has no flight rig underneath, so the camera
   * IS the orbit pose every frame (nothing to blend against) and its azimuth
   * reads straight off the position: the mock chart is east=+x / north=+z with
   * the focus at the origin, and the orbit starts at az 0 (no wrap to unpick).
   */
  const townSweep = (pointer: typeof CENTRE, frames = 60): number => {
    const w = mockWorld("town", false);
    const ladder = createSpiritLadder({
      provider: w.provider, ceiling: "town",
      start: { level: "town", town: {} },
    });
    const azOf = (): number => {
      const p = w.provider.camera.position;
      return Math.atan2(-p.z, -p.x); // the orbit's own azimuth (camera sits opposite)
    };
    run(ladder, null, 2); // pose the camera once, gaze-free
    const before = azOf();
    run(ladder, pointer, frames);
    expect(ladder.level).toBe("town"); // orbiting never changed rung
    return azOf() - before;
  };

  it("a town/district: lower-left and upper-right wind the SAME way", () => {
    const ll = townSweep(LOWER_LEFT);
    const ur = townSweep(UPPER_RIGHT);
    expect(ll).toBeGreaterThan(0.1);
    expect(ur).toBeGreaterThan(0.1);
    expect(ur).toBeCloseTo(ll, 6);
  });

  it("…and upper-left / lower-right wind the other way", () => {
    const ul = townSweep(UPPER_LEFT);
    const lr = townSweep(LOWER_RIGHT);
    expect(ul).toBeLessThan(-0.1);
    expect(lr).toBeCloseTo(ul, 6);
    expect(ul).toBeCloseTo(-townSweep(LOWER_LEFT), 6);
  });

  it("a side gaze level with the focus holds still (the crossover eases to nothing)", () => {
    expect(townSweep(MID_LEFT, 120)).toBeCloseTo(0, 9);
  });

  it("the centre stays for aiming — no orbit inside the dead zone", () => {
    expect(townSweep(CENTRE, 120)).toBeCloseTo(0, 9);
  });

  it("a LOWER corner orbits instead of exiting the rung (the bottom strip is bottom-CENTRE)", () => {
    // Same world/ceiling as the bottom-dwell exit pin: BOTTOM leaves for
    // flight, the corner beside it must not — a rung change out from under a
    // half-finished circle is the whole reason the strip is centre-only.
    const corner = mockWorld("flight", true);
    const ladder = createSpiritLadder({
      provider: corner.provider, ceiling: "flight",
      start: { level: "town", town: {} },
    });
    run(ladder, LOWER_LEFT, 600);
    expect(ladder.level).toBe("town");

    const centre = mockWorld("flight", true);
    const exiting = createSpiritLadder({
      provider: centre.provider, ceiling: "flight",
      start: { level: "town", town: {} },
    });
    run(exiting, BOTTOM, 600);
    expect(exiting.level).toBe("flight");
  });

  /** Descend to the dollhouse, then sweep it — the SAME corners, one rung down. */
  const structureSweep = (pointer: typeof CENTRE, frames = 60): number => {
    const w = mockWorld("flight", true);
    const ladder = createSpiritLadder({
      provider: w.provider, ceiling: "flight",
      start: { level: "town", town: {} },
    });
    w.setPicks(
      { kind: "district", x: 50, z: 30, radius: 120 },
      { kind: "building", x: 55, z: 33, radius: 14, frame },
    );
    run(ladder, CENTRE, 600); // town → district → structure, blend arrived
    expect(ladder.level).toBe("structure");
    // The mock's dollhouse pose rides a 20 m circle about (100, 100).
    const azOf = (): number => {
      const p = w.provider.camera.position;
      return Math.atan2(p.z - 100, p.x - 100);
    };
    const before = azOf();
    run(ladder, pointer, frames);
    expect(ladder.level).toBe("structure");
    return azOf() - before;
  };

  it("a structure obeys the same corner law (one code source, every object)", () => {
    const ll = structureSweep(LOWER_LEFT);
    const ur = structureSweep(UPPER_RIGHT);
    const ul = structureSweep(UPPER_LEFT);
    const lr = structureSweep(LOWER_RIGHT);
    expect(ll).toBeGreaterThan(0.1);
    expect(ur).toBeCloseTo(ll, 6);
    expect(ul).toBeCloseTo(-ll, 6);
    expect(lr).toBeCloseTo(-ll, 6);
    expect(structureSweep(MID_LEFT, 120)).toBeCloseTo(0, 9);
  });
});

describe("GROUND — the glide between town and structure", () => {
  const frame = { x: 500, y: 480, w: 12, h: 10 };

  it("the flight dive becomes the glide at the altitude gate", () => {
    const w = mockWorld("flight", true);
    const ladder = createSpiritLadder({ provider: w.provider, ceiling: "flight" });
    expect(ladder.level).toBe("flight");
    w.provider.flight!.drone.altitude = GROUND_ENTER_ALT - 1;
    run(ladder, null, 3);
    expect(ladder.level).toBe("ground");
  });

  it("gliding into a building descends into its dollhouse (glide + gaze dwell)", () => {
    const w = mockWorld("flight", true);
    const ladder = createSpiritLadder({ provider: w.provider, ceiling: "flight" });
    w.provider.flight!.drone.altitude = GROUND_ENTER_ALT - 1;
    run(ladder, null, 3);
    expect(ladder.level).toBe("ground");
    // Let the entry blend land (and the entry ARM — outside every footprint),
    // then the glide stands in a building WITH the gaze resting there too:
    // possession needs both, held for the short dwell.
    run(ladder, null, 90);
    w.setGroundBuilding({
      town: {},
      target: { kind: "building", x: 55, z: 33, radius: 14, frame },
    });
    run(ladder, CENTRE, 120);
    expect(ladder.level).toBe("structure");
    expect(w.host.log).toContain(`focus:${frame.x},${frame.y},${frame.w},${frame.h}`);
  });

  it("flying THROUGH a building while gazing past it never possesses it", () => {
    const w = mockWorld("flight", true);
    const ladder = createSpiritLadder({ provider: w.provider, ceiling: "flight" });
    w.provider.flight!.drone.altitude = GROUND_ENTER_ALT - 1;
    run(ladder, null, 3);
    expect(ladder.level).toBe("ground");
    run(ladder, null, 90); // blend + arm
    w.setGroundBuilding({
      town: {},
      target: { kind: "building", x: 55, z: 33, radius: 14, frame },
    });
    // Gaze pinned at the TOP of the screen (above the horizon — no settled
    // ground point): the glide sits inside the footprint but the gaze never
    // rests there, so the same-building dwell never accrues.
    const TOP = { x: 400, y: 30, clientX: 400, clientY: 30 };
    run(ladder, TOP, 200);
    expect(ladder.level).toBe("ground");
  });

  it("open-country glide ascends back to flight on the bottom dwell", () => {
    const w = mockWorld("flight", true);
    const ladder = createSpiritLadder({ provider: w.provider, ceiling: "flight" });
    w.provider.flight!.drone.altitude = GROUND_ENTER_ALT - 1;
    run(ladder, null, 3);
    expect(ladder.level).toBe("ground");
    run(ladder, BOTTOM, 200);
    expect(ladder.level).toBe("flight");
    // The drone re-enters above the glide, higher than the enter gate.
    expect(w.provider.flight!.drone.altitude).toBeGreaterThan(GROUND_ENTER_ALT);
  });

  it("a structure-scope ceiling makes ground unreachable from the dollhouse", () => {
    const w = mockWorld("flight", true);
    const ladder = createSpiritLadder({
      provider: w.provider, ceiling: "structure",
      start: { level: "town", town: {} },
    });
    w.setPicks(
      { kind: "district", x: 50, z: 30, radius: 120 },
      { kind: "building", x: 55, z: 33, radius: 14, frame },
    );
    run(ladder, CENTRE, 600);
    expect(ladder.level).toBe("structure");
    run(ladder, BOTTOM, 300); // the exit strip never accrues — ceiling holds
    expect(ladder.level).toBe("structure");
  });
});

/**
 * THE PLAYER IS THE SPARK; THE AVATAR IS JUST A BODY. The ground glide is the
 * fake body a sparkless spirit needs — so the moment the spark claims a real
 * creature, the glide must stop being a walker and follow it. Without this the
 * claimed body walked off on its own legs while the camera glided away after
 * the gaze, which read as "the claim isn't working".
 */
describe("GROUND — riding a claimed body", () => {
  const frame = { x: 500, y: 480, w: 12, h: 10 };

  /** A ladder resting on the ground rung, blend landed and entry armed. */
  function onGround(): { w: MockWorld; ladder: ReturnType<typeof createSpiritLadder> } {
    const w = mockWorld("flight", true);
    const ladder = createSpiritLadder({ provider: w.provider, ceiling: "flight" });
    w.provider.flight!.drone.altitude = GROUND_ENTER_ALT - 1;
    run(ladder, null, 3);
    expect(ladder.level).toBe("ground");
    run(ladder, null, 90);
    return { w, ladder };
  }

  it("the glide FOLLOWS the claimed body instead of steering itself", () => {
    const { w, ladder } = onGround();
    // The body walks (the host steers it on its own legs); the glide is not
    // told an aim at all — it must land exactly on the body regardless.
    w.setDrivenBody({ x: 10, z: 20, fx: 0, fz: 1 });
    run(ladder, CENTRE, 30);
    expect(w.placedAt()!.x).toBeCloseTo(10, 5);
    expect(w.placedAt()!.z).toBeCloseTo(20, 5);
    // It KEEPS following — a one-off snap would drift away as the body walks on.
    w.setDrivenBody({ x: 14, z: 26, fx: 0, fz: 1 });
    run(ladder, CENTRE, 30);
    expect(w.placedAt()!.x).toBeCloseTo(14, 5);
    expect(w.placedAt()!.z).toBeCloseTo(26, 5);
  });

  it("the bottom dwell does NOT ascend while a body is claimed", () => {
    const { w, ladder } = onGround();
    w.setDrivenBody({ x: 0, z: 0, fx: 0, fz: 1 });
    // The identical dwell that ascends a FREE spirit to flight (above).
    run(ladder, BOTTOM, 300);
    expect(ladder.level).toBe("ground");
  });

  it("walking into a house does not cut its roof away", () => {
    const { w, ladder } = onGround();
    w.setDrivenBody({ x: 0, z: 20, fx: 0, fz: 1 });
    w.setGroundBuilding({
      town: {},
      target: { kind: "building", x: 55, z: 33, radius: 14, frame },
    });
    // The dollhouse is a GHOST's affordance: the same glide+gaze dwell that
    // opens a house for a free spirit must leave it sealed for a body, which
    // just walks in under the ground rung's own door-open reveal.
    run(ladder, CENTRE, 200);
    expect(ladder.level).toBe("ground");
    expect(w.host.log).not.toContain(`focus:${frame.x},${frame.y},${frame.w},${frame.h}`);
  });

  it("RELEASING the body hands the glide back — the spirit steers again", () => {
    const { w, ladder } = onGround();
    w.setDrivenBody({ x: 10, z: 20, fx: 0, fz: 1 });
    run(ladder, BOTTOM, 300);
    expect(ladder.level).toBe("ground"); // pinned while ridden
    // The spark leaves the creature: every spirit affordance comes back, and
    // the glide resumes from where the body left it (not the stale anchor).
    w.setDrivenBody(null);
    run(ladder, BOTTOM, 300);
    expect(ladder.level).toBe("flight");
  });

  it("a mid-dwell claim never lands a stale count on release", () => {
    const { w, ladder } = onGround();
    // Dwell the exit strip ALMOST to the ascend, then claim a body.
    run(ladder, BOTTOM, 20);
    w.setDrivenBody({ x: 0, z: 0, fx: 0, fz: 1 });
    run(ladder, BOTTOM, 60);
    w.setDrivenBody(null);
    // One frame off the strip: the hold must have been cleared by the claim,
    // so this cannot tip an ascend the player never asked for.
    run(ladder, CENTRE, 1);
    expect(ladder.level).toBe("ground");
  });
});

/**
 * THE SPARK IS THE CURSOR: it marks the ground point the gaze rests on, so it
 * must project back onto the very pixel being looked at. Over FLAT ground any
 * placement scheme agrees; over relief they diverge, which is why this pins the
 * sloped case.
 */
describe("GROUND — the spark sits under the cursor", () => {
  const GAZE = { x: 400, y: 250, clientX: 400, clientY: 250 };
  /** The spark is drawn this far ABOVE the ground point it marks (ladder.ts). */
  const SPARK_LIFT = 0.4;

  /** Where the gaze ray TRULY meets the terrain — bisected against the mock's
   *  own relief. This is the answer the placement has to reproduce; the mock is
   *  anchored at the origin, so world (x,z) are session-local and the terrain is
   *  simply `y = relief(x, z)`. */
  function trueGroundHit(w: MockWorld, relief: (x: number, z: number) => number): THREE.Vector3 {
    const cam = w.provider.camera;
    cam.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2((GAZE.x / 800) * 2 - 1, -((GAZE.y / 600) * 2 - 1)),
      cam,
    );
    const at = (t: number): THREE.Vector3 =>
      ray.ray.origin.clone().addScaledVector(ray.ray.direction, t);
    // Height above ground along the ray: starts positive (the camera is up),
    // crosses zero where the ray lands.
    const h = (t: number): number => { const p = at(t); return p.y - relief(p.x, p.z); };
    let lo = 0;
    let hi = 4000;
    expect(h(lo)).toBeGreaterThan(0);
    expect(h(hi)).toBeLessThan(0);
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (h(mid) > 0) lo = mid; else hi = mid;
    }
    return at((lo + hi) / 2);
  }

  function gazeOnSlope(slope: number): { spark: THREE.Vector3; want: THREE.Vector3 } {
    const relief = (_x: number, z: number): number => slope * z; // falls away ahead (+z)
    const w = mockWorld("flight", true);
    w.setRelief(relief);
    const ladder = createSpiritLadder({ provider: w.provider, ceiling: "flight" });
    w.provider.flight!.drone.altitude = GROUND_ENTER_ALT - 1;
    run(ladder, null, 3);
    expect(ladder.level).toBe("ground");
    run(ladder, null, 90); // entry blend lands
    // PIN the glide on a claimed body: the camera settles and the geometry stops
    // moving, so what's measured is the PLACEMENT, not a chase transient.
    w.setDrivenBody({ x: 0, z: 0, fx: 0, fz: 1 });
    run(ladder, GAZE, 240);
    const spark = w.sparkAt();
    expect(spark).not.toBeNull();
    const want = trueGroundHit(w, relief);
    want.y += SPARK_LIFT;
    return { spark: spark!, want };
  }

  it("flat ground — the spark marks the point the gaze ray lands on", () => {
    const { spark, want } = gazeOnSlope(0);
    expect(spark.z).toBeCloseTo(want.z, 1);
    expect(spark.y).toBeCloseTo(want.y, 1);
  });

  it("SLOPING ground — the spark still marks where the ray lands", () => {
    // Placing it by intersecting a FLAT plane and then dropping to the terrain
    // puts it short of, and below, the point actually being looked at.
    const { spark, want } = gazeOnSlope(-0.12); // an ordinary 12% hillside
    expect(spark.z).toBeCloseTo(want.z, 1);
    expect(spark.y).toBeCloseTo(want.y, 1);
  });

  // The march is a fixed point, so it has to be shown converging on ground that
  // pulls the answer BOTH ways — downhill (the hit runs further out) and uphill
  // (it pulls nearer) — and on a slope steep enough to need several steps.
  it.each([
    { name: "a steep fall-away", slope: -0.3 },
    { name: "rising ground", slope: 0.2 },
  ])("converges on $name", ({ slope }) => {
    const { spark, want } = gazeOnSlope(slope);
    expect(spark.z).toBeCloseTo(want.z, 1);
    expect(spark.y).toBeCloseTo(want.y, 1);
  });
});

describe("GROUND — ONE cursor pipeline, planet or flat", () => {
  const TOWN = { town: true };
  const NEAR = { ref: TOWN, label: "Mockville", distM: 100, radius: 400 };

  it("the entity engine RESOLVES the cursor, the planet DRAWS it", () => {
    const w = mockWorld("flight", true, { drawnWorld: true });
    const ladder = createSpiritLadder({ provider: w.provider, ceiling: "flight" });
    w.setNearTown(NEAR);
    ladder.dropToGround(new THREE.Vector3(0, 0, 0), TOWN);
    run(ladder, CENTRE, 5);
    // The host never draws a spark of its own — one cursor on screen, and on a
    // planet it is the provider's (an object on the planet, the same one
    // whether or not a town happens to be mounted).
    expect(w.hostExtCursor()).toBe(true);
    // Nothing reported yet ⇒ the bare drawn-world raycast stands in.
    expect(w.groundSparkCalls().some((c) => c !== null)).toBe(true);
    expect(ladder.debugGround().startsWith("prov")).toBe(true);

    // …but the moment an entity engine under the glide REPORTS a cursor, that
    // is the cursor: its pick stopped on walls, snapped to the entity under the
    // pixel and carries the dwell — the pipeline the flat path has always had.
    // A town reporting is NOT the old frame leak: the report is WORLD coords
    // off the drawn skin, never town-plaza coordinates.
    w.setHostCursor({ pos: new THREE.Vector3(5, 1, 5), hovering: true, select: 0.5 });
    run(ladder, CENTRE, 1);
    const at = w.groundSparkAt(); // the snap point rides the same one call
    expect(at).not.toBeNull();
    expect(at!.x).toBeCloseTo(5, 3);
    expect(at!.z).toBeCloseTo(5, 3);
    expect(ladder.debugGround().startsWith("rep")).toBe(true);
  });

  it("a BARE ground point keeps the drawn-world metres — the engine only lends its dwell", () => {
    // The engine's own ground point is analytic (its height sampler), and on a
    // planet the sampler and the drawn LOD skin disagree by metres — taking its
    // position for a bare point is the spark sinking under the ground the
    // player can see. So: ray for WHERE, engine for the bloom.
    const w = mockWorld("flight", true, { drawnWorld: true });
    const ladder = createSpiritLadder({ provider: w.provider, ceiling: "flight" });
    w.setNearTown(NEAR);
    ladder.dropToGround(new THREE.Vector3(0, 0, 0), TOWN);
    w.setHostCursor({ pos: new THREE.Vector3(5, 1, 5), hovering: false, select: 0.4 });
    const casts = w.groundSparkCalls().length;
    run(ladder, CENTRE, 1);
    expect(w.groundSparkCalls().length).toBe(casts + 1); // the ray placed it
    const selects = w.groundSparkSelects();
    expect(selects[selects.length - 1]).toBeCloseTo(0.4, 3); // …carrying the dwell
    expect(w.groundSparkAt()).toBeNull();                    // …and no snap point
    expect(ladder.debugGround().startsWith("prov+")).toBe(true);
  });

  it("the glide standing in a town is what makes the town tick at full rate", () => {
    const w = mockWorld("flight", true, { drawnWorld: true });
    const ladder = createSpiritLadder({ provider: w.provider, ceiling: "flight" });
    w.setNearTown(NEAR);
    expect(ladder.groundInTown()).toBe(false); // still airborne
    ladder.dropToGround(new THREE.Vector3(0, 0, 0), TOWN);
    run(ladder, CENTRE, 2);
    // The host layer reads this to step that town at the frame rate: it is the
    // player's cursor + interaction engine on this rung, and a 2 Hz gaze
    // pipeline reads as a lagging laser pointer.
    expect(ladder.groundInTown()).toBe(true);
    w.setNearTown({ ...NEAR, distM: 600 }); // glide out past the attach radius
    run(ladder, null, 2);
    expect(ladder.groundInTown()).toBe(false);
  });

  it("never hides the spark on a frame it re-targets (the teleport that killed the dart)", () => {
    const w = mockWorld("flight", true, { drawnWorld: true });
    const ladder = createSpiritLadder({ provider: w.provider, ceiling: "flight" });
    w.setNearTown(NEAR);
    ladder.dropToGround(new THREE.Vector3(0, 0, 0), TOWN);
    run(ladder, CENTRE, 10);
    // `spark(null)` hides it, and GazeSpark.setTarget's "appear in place,
    // don't streak in" path fires whenever the spark is hidden — so hiding it
    // every frame and immediately re-targeting it pinned the cursor to the
    // gaze point forever: it could never dart, and a light that should fly
    // through the world read as a laser pointer.
    expect(w.sparkNullCalls()).toBe(0);
  });

  it("a FLAT standalone world keeps its host's own cursor (no drawn world to raycast)", () => {
    const w = mockWorld("flight", true); // no groundSpark — the flat shape
    const ladder = createSpiritLadder({ provider: w.provider, ceiling: "flight" });
    w.setNearTown(NEAR);
    ladder.dropToGround(new THREE.Vector3(0, 0, 0), TOWN);
    run(ladder, CENTRE, 5);
    expect(w.hostExtCursor()).toBeNull(); // never opted out
    expect(ladder.debugGround().startsWith("host")).toBe(true);
  });

  it("townRef is CONTENT, re-evaluated per frame: gliding out releases it, gliding in acquires it", () => {
    const w = mockWorld("flight", true, { drawnWorld: true });
    const ladder = createSpiritLadder({ provider: w.provider, ceiling: "flight" });
    w.setNearTown(NEAR);
    ladder.dropToGround(new THREE.Vector3(0, 0, 0), TOWN);
    run(ladder, null, 2);
    expect(w.setTownCalls()).toHaveLength(0); // same ref: no churn
    w.setNearTown({ ...NEAR, distM: 600 }); // beyond 400 × 1.25 = 500
    run(ladder, null, 2);
    const calls = w.setTownCalls();
    expect(calls[calls.length - 1]).toBeNull(); // released mid-glide
    expect(ladder.debugGround()).toContain("town:-");
    w.setNearTown({ ...NEAR, distM: 80 }); // back inside the reach
    run(ladder, null, 2);
    const calls2 = w.setTownCalls();
    expect(calls2[calls2.length - 1]).toBe(TOWN); // acquired mid-glide
    expect(ladder.debugGround()).toContain("town:ref");
  });
});

describe("the CEILING law", () => {
  it("a town-scope world refuses the exit to flight (no flight seam, ceiling town)", () => {
    const w = mockWorld("town", false);
    const ladder = createSpiritLadder({
      provider: w.provider, ceiling: "town",
      start: { level: "town", town: {} },
    });
    expect(ladder.level).toBe("town");
    run(ladder, BOTTOM, 600); // dwell the exit strip forever
    expect(ladder.level).toBe("town"); // the ceiling holds
  });

  it("a structure initial ceiling holds INSIDE a larger world until raised", () => {
    const w = mockWorld("flight", true);
    const ladder = createSpiritLadder({
      provider: w.provider, ceiling: "structure",
      start: { level: "town", town: {} },
    });
    // At depth 0 with ceiling=structure, the exit strip must not reach flight.
    run(ladder, BOTTOM, 600);
    expect(ladder.level).toBe("town");
    // Gameplay raises the ceiling — now the same dwell exits to flight.
    ladder.setCeiling("flight");
    run(ladder, BOTTOM, 600);
    expect(ladder.level).toBe("flight");
  });

  it("setCeiling clamps to the provider's scope", () => {
    const w = mockWorld("town", false);
    const ladder = createSpiritLadder({
      provider: w.provider, ceiling: "structure",
      start: { level: "town", town: {} },
    });
    ladder.setCeiling("flight"); // scope is town — clamped
    expect(ladder.ceiling).toBe("town");
  });
});
