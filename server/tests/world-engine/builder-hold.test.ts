/**
 * THE BUILDER HOLD (shared/world-engine/spirit/ladder.ts `setBuilderHold`) —
 * the user's early-town-builder camera ruling, pinned at the state-machine
 * level:
 *
 *   "in early town builder mode, the camera should be fixed to orbiting at a
 *    close distance, and hovering over objects should select them without
 *    shifting into ground mode."  (2026-09-03)
 *
 * The district orbit used to be a RUNG the gaze fell through: a 0.6 s hover on
 * ANY terrain (a tree included) armed `enterGround`, and a lot dwell descended
 * into the dollhouse — so the camera was yanked out from under the player by
 * the very hover they were making to select something. Under the hold both
 * DOWNWARD changes are pinned off while the turntable and the deliberate
 * step-out stay, which is what "fixed to orbiting at a close distance" means:
 * the rung cannot fall out from under you.
 *
 * These drive the REAL ladder over a minimal frame provider (a flat town, no
 * flight seam — the same contract world-lab's planet provider implements), so
 * they pin the state machine, not a mock of it. The pointer half of the ruling
 * lives in the drivers (world-lab main.ts / quest-boot.ts) and is verified by
 * `npx tsc --noEmit -p games/world-lab/tsconfig.json`.
 */
import * as THREE from "three";
import {
  createSpiritLadder, districtRadiusFor,
  type SpiritLadder, type SpiritPointer,
} from "@shared/world-engine/spirit/ladder";
import type {
  SpiritFocusTarget, SpiritFrameProvider, SpiritGroundSession,
  SpiritStructureHost, SpiritTownSession,
} from "@shared/world-engine/spirit/frame-provider";

const W = 1600;
const H = 900;
const DT = 1 / 60;
/** A town big enough that its district radius lands mid-band (300 × 0.33 = 99). */
const TOWN_RADIUS = 300;
const TOWN_REF = { id: "homestead" };

const STREET: SpiritFocusTarget = { kind: "district", x: 12, z: -8, radius: 40 };
const LOT: SpiritFocusTarget = {
  kind: "building", x: 6, z: 4, radius: 9, frame: { x: 6, y: 4, w: 8, h: 6 },
};

interface Picks {
  district: SpiritFocusTarget | null;
  building: SpiritFocusTarget | null;
}

function chartFrame(x: number, z: number) {
  return {
    origin: new THREE.Vector3(x, 0, z),
    east: new THREE.Vector3(1, 0, 0),
    north: new THREE.Vector3(0, 0, 1),
    up: new THREE.Vector3(0, 1, 0),
  };
}

function makeWorld() {
  const picks: Picks = { district: null, building: null };
  const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 1e6);
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
    pickBuilding: () => picks.building,
    structureHost: () => host,
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

/** Boot exactly as the founding premise does: a town-ceilinged ladder framed
 *  on the site's DISTRICT depth (world-lab main.ts `stepFoundingPremise`). */
function bootHomestead(provider: SpiritFrameProvider): SpiritLadder {
  const ladder = createSpiritLadder({
    provider, ceiling: "town", start: { level: "town", town: TOWN_REF },
  });
  ladder.setCeiling("town");
  ladder.focusTown(TOWN_REF, { district: true });
  return ladder;
}

/** Screen px → the ladder's pointer (client px are the same here). */
const at = (x: number, y: number): SpiritPointer => ({ x, y, clientX: x, clientY: y });

/** Gaze centre — inside the dwell zone, clear of the orbit bands. */
const CENTRE = at(W / 2, H / 2);
/** The bottom EXIT strip (ndcY < −0.7, bottom centre). */
const BOTTOM = at(W / 2, H * 0.94);
/** Deep in the lower-left corner — the turntable band. */
const CORNER = at(W * 0.025, H * 0.95);

/** Hold a pointer still for `secs` and return the LAST frame's status. */
function hover(ladder: SpiritLadder, p: SpiritPointer | null, secs: number): string {
  let status = "";
  const frames = Math.round(secs / DT);
  for (let i = 0; i < frames; i++) status = ladder.step(p, DT, 1_000 + i * 16).status;
  return status;
}

/** The town rung's focus DEPTH, read off its own status line. */
const depthOf = (status: string): string =>
  /FOCUS=(TOWN|DISTRICT)/.exec(status)?.[1] ?? "-";

/** The orbit azimuth implied by the posed camera (chart basis east/up/north,
 *  focus at the chart origin) — `orbitRelPose` inverted. */
const orbitAz = (camera: THREE.PerspectiveCamera): number =>
  Math.atan2(-camera.position.z, -camera.position.x);

/** Camera → focus distance: the "close orbit" itself. */
const orbitDist = (camera: THREE.PerspectiveCamera): number => camera.position.length();

describe("builder hold — the downward rung changes are pinned off", () => {
  it("a street dwell no longer drops the player into the ground glide", () => {
    const w = makeWorld();
    const ladder = bootHomestead(w.provider);
    ladder.setBuilderHold(true);
    w.picks.district = STREET; // any terrain under the gaze — a tree included
    const status = hover(ladder, CENTRE, 2);
    expect(ladder.level).toBe("town");
    expect(depthOf(status)).toBe("DISTRICT");
    expect(status).toContain("[build hold]");
    // The dwell counter never even starts: the hover belongs to the host.
    expect(status).toContain("dwell 0%");
  });

  it("…and WITHOUT the hold that same dwell still enters the ground glide", () => {
    const w = makeWorld();
    const ladder = bootHomestead(w.provider);
    w.picks.district = STREET;
    hover(ladder, CENTRE, 2);
    expect(ladder.level).toBe("ground");
  });

  it("a building-lot dwell no longer descends into the dollhouse", () => {
    const w = makeWorld();
    const ladder = bootHomestead(w.provider);
    ladder.setBuilderHold(true);
    w.picks.building = LOT;
    const status = hover(ladder, CENTRE, 2);
    expect(ladder.level).toBe("town");
    expect(depthOf(status)).toBe("DISTRICT");
  });

  it("…and WITHOUT the hold that same dwell still enters the structure rung", () => {
    const w = makeWorld();
    const ladder = bootHomestead(w.provider);
    w.picks.building = LOT;
    hover(ladder, CENTRE, 2);
    expect(ladder.level).toBe("structure");
  });

  it("holds through a LONG dwell — this is a pin, not a longer timer", () => {
    const w = makeWorld();
    const ladder = bootHomestead(w.provider);
    ladder.setBuilderHold(true);
    w.picks.district = STREET;
    w.picks.building = LOT;
    hover(ladder, CENTRE, 20);
    expect(ladder.level).toBe("town");
  });
});

describe("builder hold — what stays available", () => {
  it("the corner turntable still spins the orbit (the manual look-around)", () => {
    const w = makeWorld();
    const ladder = bootHomestead(w.provider);
    ladder.setBuilderHold(true);
    w.picks.district = STREET;
    hover(ladder, CENTRE, 0.2); // settle the pose
    const az0 = orbitAz(w.camera);
    hover(ladder, CORNER, 1.5);
    const az1 = orbitAz(w.camera);
    expect(Math.abs(az1 - az0)).toBeGreaterThan(0.1);
    expect(ladder.level).toBe("town");
  });

  it("…and the orbit keeps its DISTRICT radius while it spins (fixed, close)", () => {
    const w = makeWorld();
    const ladder = bootHomestead(w.provider);
    ladder.setBuilderHold(true);
    w.picks.district = STREET;
    hover(ladder, CENTRE, 0.2);
    const d0 = orbitDist(w.camera);
    // The framing distance is derived from the district radius alone — no
    // painted metre value (districtRadiusFor: 33% of the site, held 30–160 m).
    const r = districtRadiusFor(TOWN_RADIUS);
    expect(r).toBeCloseTo(99, 6);
    expect(d0).toBeGreaterThan(r); // it frames the district, so it stands off it
    hover(ladder, CORNER, 1.5);
    expect(orbitDist(w.camera)).toBeCloseTo(d0, 3);
    hover(ladder, CENTRE, 2); // a full dwell on the street: still no descent
    expect(orbitDist(w.camera)).toBeCloseTo(d0, 3);
  });

  it("the bottom-strip step-out still raises a rung (the deliberate leave)", () => {
    const w = makeWorld();
    const ladder = bootHomestead(w.provider);
    ladder.setBuilderHold(true);
    w.picks.district = STREET;
    expect(depthOf(hover(ladder, CENTRE, 0.2))).toBe("DISTRICT");
    const status = hover(ladder, BOTTOM, 1);
    expect(ladder.level).toBe("town");
    expect(depthOf(status)).toBe("TOWN");
  });

  it("…and the whole-town depth can still pick a district back DOWN into the build", () => {
    const w = makeWorld();
    const ladder = bootHomestead(w.provider);
    ladder.setBuilderHold(true);
    w.picks.district = STREET;
    hover(ladder, CENTRE, 0.2);
    expect(depthOf(hover(ladder, BOTTOM, 1))).toBe("TOWN");
    // Depth 0 → depth 1 never leaves this rung, so the hold does not pin it:
    // it is how the step-out gesture gets back to the homestead.
    const status = hover(ladder, CENTRE, 1.2);
    expect(ladder.level).toBe("town");
    expect(depthOf(status)).toBe("DISTRICT");
  });

  it("the town ceiling still holds the whole-town depth (no flight under the hold)", () => {
    const w = makeWorld();
    const ladder = bootHomestead(w.provider);
    ladder.setBuilderHold(true);
    w.picks.district = STREET;
    hover(ladder, CENTRE, 0.2);
    hover(ladder, BOTTOM, 1);
    const status = hover(ladder, BOTTOM, 2);
    expect(ladder.level).toBe("town");
    expect(status).toContain("the ceiling holds here");
  });
});

describe("builder hold — it does not leak", () => {
  it("defaults OFF, and reads back what was set", () => {
    const w = makeWorld();
    const ladder = bootHomestead(w.provider);
    expect(ladder.builderHold).toBe(false);
    ladder.setBuilderHold(true);
    expect(ladder.builderHold).toBe(true);
    ladder.setBuilderHold(false);
    expect(ladder.builderHold).toBe(false);
  });

  it("an UN-held ladder is byte-identical to one that never heard of the hold", () => {
    // The un-held path is the one every OTHER boot takes (city visits,
    // nature-hike, walker sessions): same statuses, frame for frame.
    const a = makeWorld();
    const b = makeWorld();
    const la = bootHomestead(a.provider);
    const lb = bootHomestead(b.provider);
    lb.setBuilderHold(false);
    const script: Array<[SpiritPointer | null, number]> = [
      [CENTRE, 0.3], [CORNER, 0.5], [BOTTOM, 0.2], [null, 0.1], [CENTRE, 0.4],
    ];
    a.picks.district = STREET;
    b.picks.district = STREET;
    const sa: string[] = [];
    const sb: string[] = [];
    for (const [p, secs] of script) {
      sa.push(hover(la, p, secs));
      sb.push(hover(lb, p, secs));
    }
    expect(sb).toEqual(sa);
    expect(sa.join("|")).not.toContain("[build hold]");
    expect(lb.level).toBe(la.level);
  });

  it("changes NOTHING on the ground rung — that rung's own laws still run", () => {
    const w = makeWorld();
    const ladder = bootHomestead(w.provider);
    w.picks.district = STREET;
    hover(ladder, CENTRE, 2);
    expect(ladder.level).toBe("ground"); // descended before the hold was armed
    // Arming it here must not pin the glide: the hold is read only by stepTown.
    ladder.setBuilderHold(true);
    hover(ladder, CENTRE, 0.5);
    expect(ladder.level).toBe("ground");
    hover(ladder, BOTTOM, 1);
    expect(ladder.level).toBe("town"); // the glide's own bottom-dwell ascent
  });
});
