/**
 * THE HELD ORBIT FRAMES THE RELEVANCE RING — AND ITS POSE IS ONE TUNABLE RECORD
 * (shared/world-engine/spirit/ladder.ts `relevanceDisc` + spirit/orbit-pose.ts).
 *
 * The user's GL finding on the founding boot, pinned at the state-machine level:
 *
 *   "Right now the camera is too far away to see anything, and I can't zoom
 *    in. The circle should really be close to the outer camera bounds, since
 *    that's the point of it."  (2026-09-05)
 *
 * The district orbit framed `districtRadiusFor(townRadius)` — a third of the
 * SITE radius (a founding's plan floors at 200 m ⇒ a 66 m frame) — while the
 * sim's own relevance disc (`nearStandRadiusM`, the border ring world-lab
 * draws) stood at 30 m. So the ring sat in the middle of the picture and the
 * people inside it were specks, and the builder hold — correctly — pinned the
 * only gaze gesture that ever got closer.
 *
 * Under the hold the OUTER bound of the frame is the disc itself, re-read every
 * frame (a ring that steps at a building event re-frames). Off the hold nothing
 * changes: the disc is not read at all.
 *
 * 🚫 THE ZOOM PINS ARE GONE (user ruling C2, 2026-09-06): *"Mouse wheel should
 * not be a control for core behaviors — remember, the game is being designed
 * for eyegaze."* `zoomBy`/`orbitZoom` were removed from the ladder, so their
 * six pins (wheel-in, floor, bound, step-out reset, off-hold zoom, garbage) had
 * nothing left to describe. What replaced them is the pose RECORD (C1): the
 * four numbers the frame is made of, tuned by eye in the lab's 🎥 Camera panel
 * and then baked — pinned below as (a) byte-identical at the shipped defaults
 * and (b) each field doing exactly one thing.
 *
 * Same harness as builder-hold.test.ts: the REAL ladder over a minimal flat
 * town provider (the contract world-lab's planet provider implements), so
 * these pin the machine, not a mock of it.
 */
import * as THREE from "three";
import {
  CITY_FRAME, ORBIT_FRAME_FLOOR_M, createSpiritLadder, districtRadiusFor,
  type SpiritLadder, type SpiritPointer,
} from "@shared/world-engine/spirit/ladder";
import {
  ORBIT_POSE_DEFAULTS, orbitPose, orbitPoseOverridden, resetOrbitPoseForTests, setOrbitPose,
} from "@shared/world-engine/spirit/orbit-pose";
import type {
  SpiritFocusTarget, SpiritFrameProvider, SpiritGroundSession,
  SpiritStructureHost, SpiritTownSession,
} from "@shared/world-engine/spirit/frame-provider";

const W = 1600;
const H = 900;
const DT = 1 / 60;
const FOV_DEG = 60;
/** A founding: `planet-provider` floors the plan radius at 200 m, so the
 *  district frame lands at 66 m — more than twice the ring below. */
const TOWN_RADIUS = 200;
/** The ring a founding gets before it has built anything (`NEAR_STAND_BASE_M`). */
const RING_FOUNDING = 30;
/** …and after its first buildings (`nearStandRadiusM`, 1–2 built). */
const RING_FIRST_HOUSE = 45;
const TOWN_REF = { id: "homestead" };
const STREET: SpiritFocusTarget = { kind: "district", x: 12, z: -8, radius: 40 };

function chartFrame(x: number, z: number) {
  return {
    origin: new THREE.Vector3(x, 0, z),
    east: new THREE.Vector3(1, 0, 0),
    north: new THREE.Vector3(0, 0, 1),
    up: new THREE.Vector3(0, 1, 0),
  };
}

function makeWorld(opts: { disc?: () => { x: number; z: number; radius: number } | null } = {}) {
  const picks: { district: SpiritFocusTarget | null } = { district: null };
  const camera = new THREE.PerspectiveCamera(FOV_DEG, W / H, 0.1, 1e6);
  const host: SpiritStructureHost = {
    setSpiritFocus: () => {},
    dollhousePose: () => {},
    placeGazeAvatar: () => {},
    setPointer: () => {},
    clearPointer: () => {},
    step: () => {},
  };
  const ground: SpiritGroundSession = {
    chartAt: (x, z) => chartFrame(x, z),
    groundY: () => 0,
    buildingAt: () => null,
  };
  const session: SpiritTownSession = {
    label: "homestead",
    radius: () => TOWN_RADIUS,
    chartAt: (x, z) => chartFrame(x, z),
    pickDistrict: () => picks.district,
    pickBuilding: () => null,
    structureHost: () => host,
    ...(opts.disc ? { relevanceDisc: opts.disc } : {}),
  };
  const provider: SpiritFrameProvider = {
    scopeLevel: "town",
    camera,
    viewSize: () => ({ w: W, h: H }),
    advance: () => {},
    rebaseOnCamera: () => ({ near: 0.1, far: 1e6, camAtOrigin: false }),
    postFrame: () => ({ nearTown: null, waiting: null }),
    openTown: () => session,
    openGround: () => ground,
    spark: () => {},
  };
  return { camera, provider, picks };
}

/** Boot exactly as the founding premise does (world-lab `stepFoundingPremise`). */
function bootHomestead(provider: SpiritFrameProvider, hold: boolean): SpiritLadder {
  const ladder = createSpiritLadder({
    provider, ceiling: "town", start: { level: "town", town: TOWN_REF },
  });
  ladder.setCeiling("town");
  ladder.focusTown(TOWN_REF, { district: true });
  ladder.setBuilderHold(hold);
  return ladder;
}

const at = (x: number, y: number): SpiritPointer => ({ x, y, clientX: x, clientY: y });
const CENTRE = at(W / 2, H / 2);
/** The bottom EXIT strip (ndcY < −0.7, bottom centre). */
const BOTTOM = at(W / 2, H * 0.94);

function hover(ladder: SpiritLadder, p: SpiritPointer | null, secs: number): string {
  let status = "";
  const frames = Math.round(secs / DT);
  for (let i = 0; i < frames; i++) status = ladder.step(p, DT, 1_000 + i * 16).status;
  return status;
}

/** Camera → focus distance (focus at the chart origin) — `orbitRelPose` read
 *  back: `dist = radius / tan(fov/2) · frameFactor`. */
const orbitDist = (camera: THREE.PerspectiveCamera): number => camera.position.length();
/** The two legs of that distance: how far OUT along the ground and how far UP. */
const orbitOut = (camera: THREE.PerspectiveCamera): number =>
  Math.hypot(camera.position.x, camera.position.z);
const orbitUp = (camera: THREE.PerspectiveCamera): number => camera.position.y;
const frameDistFor = (radius: number, frameFactor = CITY_FRAME): number =>
  (radius / Math.tan((FOV_DEG * Math.PI) / 360)) * frameFactor;
/** Long enough for the 4 s⁻¹ radius easing to land (e^-16 of the gap). */
const SETTLE_S = 4;

// The pose record is a PERSISTED GLOBAL (the lag-comp shape). Every test starts
// from the shipped defaults, and none may leak an override into the next.
beforeEach(() => resetOrbitPoseForTests());
afterEach(() => resetOrbitPoseForTests());

describe("the held orbit's outer bound is the relevance disc", () => {
  it("frames the RING, not a third of the site — the circle at the camera's bound", () => {
    const w = makeWorld({ disc: () => ({ x: 0, z: 0, radius: RING_FOUNDING }) });
    const ladder = bootHomestead(w.provider, true);
    const status = hover(ladder, CENTRE, SETTLE_S);
    expect(ladder.level).toBe("town");
    expect(status).toContain("[build hold]");
    // The ONE definition the whole test hangs on: the frame radius is the disc.
    expect(orbitDist(w.camera)).toBeCloseTo(frameDistFor(RING_FOUNDING), 2);
    // …and it is a tighter frame than the site-derived district was.
    expect(districtRadiusFor(TOWN_RADIUS)).toBeCloseTo(66, 6);
    expect(orbitDist(w.camera)).toBeLessThan(frameDistFor(districtRadiusFor(TOWN_RADIUS)) * 0.5);
  });

  it("follows the ring when it STEPS (a building event), eased — never a jump", () => {
    let ring = RING_FOUNDING;
    const w = makeWorld({ disc: () => ({ x: 0, z: 0, radius: ring }) });
    const ladder = bootHomestead(w.provider, true);
    hover(ladder, CENTRE, SETTLE_S);
    const d0 = orbitDist(w.camera);
    ring = RING_FIRST_HOUSE;
    // One frame later the camera has MOVED but is nowhere near the new frame.
    hover(ladder, CENTRE, DT);
    const d1 = orbitDist(w.camera);
    expect(d1).toBeGreaterThan(d0);
    expect(d1).toBeLessThan(d0 + (frameDistFor(RING_FIRST_HOUSE) - d0) * 0.25);
    hover(ladder, CENTRE, SETTLE_S);
    expect(orbitDist(w.camera)).toBeCloseTo(frameDistFor(RING_FIRST_HOUSE), 2);
  });

  it("WITHOUT the hold the disc is not read — a city visit frames its district exactly as before", () => {
    const w = makeWorld({ disc: () => ({ x: 0, z: 0, radius: RING_FOUNDING }) });
    const ladder = bootHomestead(w.provider, false);
    hover(ladder, CENTRE, SETTLE_S);
    expect(orbitDist(w.camera)).toBeCloseTo(frameDistFor(districtRadiusFor(TOWN_RADIUS)), 2);
  });

  it("a session that bounds no stand keeps the district frame under the hold (the disc is optional)", () => {
    const w = makeWorld(); // no relevanceDisc at all
    const ladder = bootHomestead(w.provider, true);
    hover(ladder, CENTRE, SETTLE_S);
    expect(orbitDist(w.camera)).toBeCloseTo(frameDistFor(districtRadiusFor(TOWN_RADIUS)), 2);
    const w2 = makeWorld({ disc: () => null });
    const l2 = bootHomestead(w2.provider, true);
    hover(l2, CENTRE, SETTLE_S);
    expect(orbitDist(w2.camera)).toBeCloseTo(frameDistFor(districtRadiusFor(TOWN_RADIUS)), 2);
  });
});

describe("NO WHEEL ON THE EYEGAZE SURFACE (C2) — the zoom control is gone", () => {
  // MOVED PINS, and why: the six `zoomBy` cases below this line used to pin the
  // wheel's behaviour (in from the bound, floored, never out past it, reset on
  // step-out, off-hold, garbage-proof). The user rejected the whole control the
  // day after it landed — an eyegaze player has a pointer and a dwell, so a
  // core behaviour reachable only by wheel is unreachable for the product's
  // actual user. There is nothing left to pin except its ABSENCE, and the fact
  // that the frame it used to fight over is still the ring.
  it("the ladder exposes no zoom at all, and the status never advertises one", () => {
    const w = makeWorld({ disc: () => ({ x: 0, z: 0, radius: RING_FOUNDING }) });
    const ladder = bootHomestead(w.provider, true);
    const l = ladder as unknown as Record<string, unknown>;
    expect(l.zoomBy).toBeUndefined();
    expect(l.orbitZoom).toBeUndefined();
    const status = hover(ladder, CENTRE, SETTLE_S);
    expect(status).not.toContain("zoom");
    expect(status).toContain("[build hold]");
  });

  it("the FRAME FLOOR survives the zoom's removal (a degenerate ring never collapses the camera)", () => {
    // The floor used to be the wheel's stop; it is now simply the smallest
    // frame the orbit will take, which is what protects a ring that has not
    // sized itself yet.
    const w = makeWorld({ disc: () => ({ x: 0, z: 0, radius: 0.5 }) });
    const ladder = bootHomestead(w.provider, true);
    hover(ladder, CENTRE, SETTLE_S);
    expect(orbitDist(w.camera)).toBeCloseTo(frameDistFor(ORBIT_FRAME_FLOOR_M), 2);
  });

  it("stepping out and back still frames the ring (the reset the zoom used to need)", () => {
    const w = makeWorld({ disc: () => ({ x: 0, z: 0, radius: RING_FOUNDING }) });
    const ladder = bootHomestead(w.provider, true);
    w.picks.district = STREET;
    hover(ladder, CENTRE, SETTLE_S);
    expect(hover(ladder, BOTTOM, 1)).toContain("FOCUS=TOWN");
    hover(ladder, CENTRE, 1.2); // the depth-0 district pick — back down
    const status = hover(ladder, CENTRE, SETTLE_S);
    expect(status).toContain("FOCUS=DISTRICT");
    expect(orbitDist(w.camera)).toBeCloseTo(frameDistFor(RING_FOUNDING), 2);
  });
});

describe("THE POSE IS ONE RECORD (C1) — tuned by eye, then baked", () => {
  it("the shipped defaults ARE the old literals, and the camera lands where they say", () => {
    // Byte-identity, stated as the arithmetic rather than as a snapshot: pitch
    // 0.5 rad, frame 1.35, lift 0.35 of the radius, ring→frame 1.0 — the four
    // numbers that were spelled inline in ladder.ts before the round.
    expect(ORBIT_POSE_DEFAULTS).toEqual({
      pitchRad: 0.5, frameFactor: 1.35, liftFrac: 0.35, ringFrameFactor: 1,
    });
    expect(CITY_FRAME).toBe(ORBIT_POSE_DEFAULTS.frameFactor);
    expect(orbitPose()).toEqual(ORBIT_POSE_DEFAULTS);
    expect(orbitPoseOverridden()).toBe(false);

    const w = makeWorld({ disc: () => ({ x: 0, z: 0, radius: RING_FOUNDING }) });
    const ladder = bootHomestead(w.provider, true);
    hover(ladder, CENTRE, SETTLE_S);
    const dist = orbitDist(w.camera);
    expect(dist).toBeCloseTo(frameDistFor(RING_FOUNDING), 4);
    expect(orbitUp(w.camera)).toBeCloseTo(dist * Math.sin(0.5), 6);
    expect(orbitOut(w.camera)).toBeCloseTo(dist * Math.cos(0.5), 6);
  });

  it("PITCH swings the camera along an arc — the distance to the focus never moves", () => {
    // Which is exactly why pitch cannot change an LOD tier: the ladder bands on
    // camera→body distance, and this control does not touch it.
    const w = makeWorld({ disc: () => ({ x: 0, z: 0, radius: RING_FOUNDING }) });
    const ladder = bootHomestead(w.provider, true);
    hover(ladder, CENTRE, SETTLE_S);
    const before = orbitDist(w.camera);
    setOrbitPose({ pitchRad: 0.9 });
    hover(ladder, CENTRE, 0.2);
    const dist = orbitDist(w.camera);
    expect(dist).toBeCloseTo(before, 4);
    expect(orbitUp(w.camera)).toBeCloseTo(dist * Math.sin(0.9), 6);
    expect(orbitOut(w.camera)).toBeCloseTo(dist * Math.cos(0.9), 6);
  });

  it("FRAME scales the stand-off, and nothing else", () => {
    const w = makeWorld({ disc: () => ({ x: 0, z: 0, radius: RING_FOUNDING }) });
    const ladder = bootHomestead(w.provider, true);
    hover(ladder, CENTRE, SETTLE_S);
    setOrbitPose({ frameFactor: 0.7 });
    hover(ladder, CENTRE, SETTLE_S);
    expect(orbitDist(w.camera)).toBeCloseTo(frameDistFor(RING_FOUNDING, 0.7), 4);
    // Same arc, so the up:out ratio is untouched — only the radius changed.
    expect(orbitUp(w.camera) / orbitOut(w.camera)).toBeCloseTo(Math.tan(0.5), 6);
  });

  it("LIFT raises what the camera looks AT without moving the camera", () => {
    const w = makeWorld({ disc: () => ({ x: 0, z: 0, radius: RING_FOUNDING }) });
    const ladder = bootHomestead(w.provider, true);
    hover(ladder, CENTRE, SETTLE_S);
    const pos = w.camera.position.clone();
    const before = w.camera.getWorldDirection(new THREE.Vector3()).y;
    setOrbitPose({ liftFrac: 1.2 });
    hover(ladder, CENTRE, 0.2);
    expect(w.camera.position.distanceTo(pos)).toBeLessThan(1e-3);
    // Looking at a HIGHER point from the same place = a less steeply downward
    // view (the forward vector's y rises toward 0).
    expect(w.camera.getWorldDirection(new THREE.Vector3()).y).toBeGreaterThan(before);
  });

  it("RING scales the frame the disc gives — and is not read off the hold", () => {
    const w = makeWorld({ disc: () => ({ x: 0, z: 0, radius: RING_FOUNDING }) });
    const ladder = bootHomestead(w.provider, true);
    hover(ladder, CENTRE, SETTLE_S);
    setOrbitPose({ ringFrameFactor: 0.6 });
    hover(ladder, CENTRE, SETTLE_S);
    expect(orbitDist(w.camera)).toBeCloseTo(frameDistFor(RING_FOUNDING * 0.6), 4);
    // A city visit never reads the disc, so it never reads this either — the
    // off-hold framing stays exactly the district the gaze picked.
    const w2 = makeWorld({ disc: () => ({ x: 0, z: 0, radius: RING_FOUNDING }) });
    const l2 = bootHomestead(w2.provider, false);
    hover(l2, CENTRE, SETTLE_S);
    expect(orbitDist(w2.camera)).toBeCloseTo(frameDistFor(districtRadiusFor(TOWN_RADIUS)), 2);
  });

  it("an override is a DEBUG state: clearing it restores the shipped pose exactly", () => {
    const w = makeWorld({ disc: () => ({ x: 0, z: 0, radius: RING_FOUNDING }) });
    const ladder = bootHomestead(w.provider, true);
    hover(ladder, CENTRE, SETTLE_S);
    const pos = w.camera.position.clone();
    setOrbitPose({ pitchRad: 1.1, frameFactor: 0.55, liftFrac: 0.9, ringFrameFactor: 1.7 });
    expect(orbitPoseOverridden()).toBe(true);
    hover(ladder, CENTRE, SETTLE_S);
    expect(w.camera.position.distanceTo(pos)).toBeGreaterThan(1);
    resetOrbitPoseForTests();
    expect(orbitPose()).toEqual(ORBIT_POSE_DEFAULTS);
    hover(ladder, CENTRE, SETTLE_S);
    expect(w.camera.position.distanceTo(pos)).toBeLessThan(1e-3);
  });

  it("refuses garbage — a hand-edited override can never NaN the camera", () => {
    setOrbitPose({ pitchRad: Number.NaN, frameFactor: Number.POSITIVE_INFINITY });
    expect(orbitPose()).toEqual(ORBIT_POSE_DEFAULTS);
    (globalThis as unknown as { __orbitPose?: unknown }).__orbitPose = { pitchRad: "0.9" };
    expect(orbitPose()).toEqual(ORBIT_POSE_DEFAULTS);
  });
});
