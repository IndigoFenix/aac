/**
 * THE HELD ORBIT FRAMES THE RELEVANCE RING, AND ZOOMS IN FROM IT
 * (shared/world-engine/spirit/ladder.ts `relevanceDisc` + `zoomBy`) — the
 * user's GL finding on the founding boot, pinned at the state-machine level:
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
 * Under the hold the OUTER bound of the frame is now the disc itself, re-read
 * every frame (a ring that steps at a building event re-frames), and `zoomBy`
 * walks the frame in from that bound, floored at one building's frame
 * (`ORBIT_ZOOM_FLOOR_M`), never out past it. Off the hold nothing changes:
 * the disc is not read and zoom 1 rewrites the value the pick already wrote.
 *
 * Same harness as builder-hold.test.ts: the REAL ladder over a minimal flat
 * town provider (the contract world-lab's planet provider implements), so
 * these pin the machine, not a mock of it.
 */
import * as THREE from "three";
import {
  CITY_FRAME, ORBIT_ZOOM_FLOOR_M, createSpiritLadder, districtRadiusFor,
  type SpiritLadder, type SpiritPointer,
} from "@shared/world-engine/spirit/ladder";
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
 *  back: `dist = radius / tan(fov/2) · CITY_FRAME`. */
const orbitDist = (camera: THREE.PerspectiveCamera): number => camera.position.length();
const frameDistFor = (radius: number): number =>
  (radius / Math.tan((FOV_DEG * Math.PI) / 360)) * CITY_FRAME;
/** Long enough for the 4 s⁻¹ radius easing to land (e^-16 of the gap). */
const SETTLE_S = 4;

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

describe("zoomBy — in from the bound, never out past it", () => {
  it("wheel-up (negative notches) closes in; the status says so", () => {
    const w = makeWorld({ disc: () => ({ x: 0, z: 0, radius: RING_FOUNDING }) });
    const ladder = bootHomestead(w.provider, true);
    hover(ladder, CENTRE, SETTLE_S);
    const d0 = orbitDist(w.camera);
    expect(ladder.orbitZoom).toBe(1);
    ladder.zoomBy(-3);
    expect(ladder.orbitZoom).toBeLessThan(1);
    const status = hover(ladder, CENTRE, SETTLE_S);
    expect(orbitDist(w.camera)).toBeLessThan(d0);
    expect(orbitDist(w.camera)).toBeCloseTo(frameDistFor(RING_FOUNDING * ladder.orbitZoom), 2);
    expect(status).toMatch(/\[zoom \d+%\]/);
  });

  it("is FLOORED at one building's frame (ORBIT_ZOOM_FLOOR_M)", () => {
    const w = makeWorld({ disc: () => ({ x: 0, z: 0, radius: RING_FOUNDING }) });
    const ladder = bootHomestead(w.provider, true);
    hover(ladder, CENTRE, SETTLE_S);
    ladder.zoomBy(-1000);
    hover(ladder, CENTRE, SETTLE_S);
    expect(orbitDist(w.camera)).toBeCloseTo(frameDistFor(ORBIT_ZOOM_FLOOR_M), 2);
    // Banked notches below the floor do not exist: one notch out MOVES.
    ladder.zoomBy(1);
    hover(ladder, CENTRE, SETTLE_S);
    expect(orbitDist(w.camera)).toBeGreaterThan(frameDistFor(ORBIT_ZOOM_FLOOR_M) * 1.05);
  });

  it("never exceeds the bound — wheel-down from the ring frame is a no-op", () => {
    const w = makeWorld({ disc: () => ({ x: 0, z: 0, radius: RING_FOUNDING }) });
    const ladder = bootHomestead(w.provider, true);
    hover(ladder, CENTRE, SETTLE_S);
    ladder.zoomBy(50);
    const status = hover(ladder, CENTRE, SETTLE_S);
    expect(ladder.orbitZoom).toBe(1);
    expect(orbitDist(w.camera)).toBeCloseTo(frameDistFor(RING_FOUNDING), 2);
    expect(status).not.toContain("[zoom");
  });

  it("stepping OUT of the district ends the zoom; coming back frames the ring again", () => {
    const w = makeWorld({ disc: () => ({ x: 0, z: 0, radius: RING_FOUNDING }) });
    const ladder = bootHomestead(w.provider, true);
    w.picks.district = STREET;
    hover(ladder, CENTRE, SETTLE_S);
    ladder.zoomBy(-5);
    hover(ladder, CENTRE, 0.5);
    expect(ladder.orbitZoom).toBeLessThan(1);
    expect(hover(ladder, BOTTOM, 1)).toContain("FOCUS=TOWN");
    expect(ladder.orbitZoom).toBe(1);
    // Zoom is inert at the whole-town depth.
    ladder.zoomBy(-5);
    expect(ladder.orbitZoom).toBe(1);
    hover(ladder, CENTRE, 1.2); // the depth-0 district pick — back down
    const status = hover(ladder, CENTRE, SETTLE_S);
    expect(status).toContain("FOCUS=DISTRICT");
    expect(orbitDist(w.camera)).toBeCloseTo(frameDistFor(RING_FOUNDING), 2);
  });

  it("works OFF the hold too, against the district frame (a city visit can lean in)", () => {
    const w = makeWorld();
    const ladder = bootHomestead(w.provider, false);
    hover(ladder, CENTRE, SETTLE_S);
    const bound = districtRadiusFor(TOWN_RADIUS);
    expect(orbitDist(w.camera)).toBeCloseTo(frameDistFor(bound), 2);
    ladder.zoomBy(-4);
    hover(ladder, CENTRE, SETTLE_S);
    expect(orbitDist(w.camera)).toBeCloseTo(frameDistFor(bound * ladder.orbitZoom), 2);
    expect(orbitDist(w.camera)).toBeLessThan(frameDistFor(bound));
  });

  it("ignores garbage and zero", () => {
    const w = makeWorld({ disc: () => ({ x: 0, z: 0, radius: RING_FOUNDING }) });
    const ladder = bootHomestead(w.provider, true);
    hover(ladder, CENTRE, 0.2);
    ladder.zoomBy(0);
    ladder.zoomBy(Number.NaN);
    ladder.zoomBy(Number.POSITIVE_INFINITY * -1);
    expect(ladder.orbitZoom).toBe(1);
  });
});
