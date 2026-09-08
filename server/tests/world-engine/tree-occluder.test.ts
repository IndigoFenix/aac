// 🌳 OCCLUDING TREES ARE OUTLINES (user, 2026-09-06, on the baked orbit pose:
// "The main issue with it is that nearby trees can block the view. Maybe render
// them as outlines if they're blocking the camera").
//
// At the pose the user chose (`orbit-pose.ts`: pitch 0.5, frame 1, lift 0, ring
// 0.5) a founding's camera stands 28.2 m out and 15.4 m up from a 15 m frame,
// inside a 30 m relevance ring holding ~50 oaks. An oak is 23.8 m tall and
// fills 79 % of the viewport height there, so ONE of them on the sight line
// hides the whole site.
//
// The geometry lives in `spirit/occluders.ts` — PURE, no THREE, no host, no
// session — precisely so it can be pinned without a browser. What the answer
// then MEANS (a forced `stick` rung through the ordinary re-tier drain, drawn
// with the hollowed stick material) is the host's and the view's business, and
// those three seams are pinned here as SOURCE, for the same reason
// tier-distance-3d.test.ts pins its call sites: a value import of quest-host
// taxes every worker with the host's transform.
//
// Slice: `npm run test:engine -- occluder`

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OCCLUDER_RULE,
  crownRadiusM,
  occludingBodies,
  occlusionOf,
  sameOccluders,
  type OccPoint,
  type OccluderBody,
} from "@shared/world-engine/spirit/occluders.js";
import { ORBIT_POSE_DEFAULTS } from "@shared/world-engine/spirit/orbit-pose.js";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const HOST = read("shared", "world-engine", "interaction", "quest", "quest-host.ts");
const MAIN = read("games", "world-lab", "src", "main.ts");
const RENDER = read("shared", "world-engine", "render3d.ts");
const STICK = read("shared", "world-engine", "creatures", "stick-lod.ts");
const VIEW = read("shared", "world-engine", "world-view.ts");

/** THE SHIPPED SHOT, read off the pose record rather than pasted: the founding
 *  ring is 30 m, the frame is that × `ringFrameFactor`, and the camera stands
 *  off it by `frameFactor` fov-fitting distances, pitched `pitchRad` up. */
const FOV_RAD = (50 * Math.PI) / 180;
const RING_M = 30;
const frameM = RING_M * ORBIT_POSE_DEFAULTS.ringFrameFactor;
const DIST = (frameM / Math.tan(FOV_RAD / 2)) * ORBIT_POSE_DEFAULTS.frameFactor;
const CAM: OccPoint = {
  x: DIST * Math.cos(ORBIT_POSE_DEFAULTS.pitchRad),
  y: 0,
  z: DIST * Math.sin(ORBIT_POSE_DEFAULTS.pitchRad),
};
/** Lift 0 ⇒ the camera looks at the ground AT the site's centre. */
const FOCUS: OccPoint = { x: 0, y: 0, z: 0 };
const OAK_M = 23.8; // products.ts `bodyHeightM`
const oak = (id: string, x: number, y: number, heightM = OAK_M): OccluderBody =>
  ({ id, x, y, heightM });
const NONE: ReadonlySet<string> = new Set<string>();
const ids = (s: ReadonlySet<string>) => [...s].sort();

describe("the shot the rule runs in", () => {
  it("is the pose the user baked — 28.2 m out, 15.4 m up, a 15 m frame", () => {
    expect(frameM).toBeCloseTo(15, 6);
    expect(DIST).toBeCloseTo(32.17, 2);
    expect(CAM.x).toBeCloseTo(28.23, 2);
    expect(CAM.z).toBeCloseTo(15.42, 2);
  });

  it("an oak's crown is derived from its height (nothing declares a width)", () => {
    expect(OCCLUDER_RULE.crownFrac).toBe(0.3);
    expect(crownRadiusM(OAK_M)).toBeCloseTo(7.14, 2); // 14.3 m across
    expect(crownRadiusM(0)).toBe(0);
    expect(crownRadiusM(-5)).toBe(0); // a nonsense height can never widen it
  });
});

describe("occlusionOf — segment↔segment, not a plan view", () => {
  it("a tree ON the sight line clears it by nothing, halfway along", () => {
    const hit = occlusionOf(CAM, FOCUS, oak("t", CAM.x / 2, 0));
    expect(hit).not.toBeNull();
    expect(hit!.clearM).toBeCloseTo(0, 6);
    expect(hit!.u).toBeCloseTo(0.5, 6);
  });

  it("clears it by exactly its lateral offset when it stands beside the line", () => {
    const hit = occlusionOf(CAM, FOCUS, oak("t", CAM.x / 2, 7));
    expect(hit!.clearM).toBeCloseTo(7, 6);
    expect(hit!.u).toBeCloseTo(0.5, 6);
  });

  it("MEASURES THE TREE'S OWN HEIGHT: the same spot, a herb and an oak", () => {
    // The whole reason this is not a 2-D test. The sight line passes 7.7 m over
    // the ground at the halfway point, so an oak's crown is in the way and a
    // 0.4 m herb standing in the same footprint is not — a plan-view distance
    // would call them identical.
    const at = CAM.x / 2;
    expect(occlusionOf(CAM, FOCUS, oak("oak", at, 0))!.clearM).toBeCloseTo(0, 6);
    // The herb's own top is 6.4 m off the line (the perpendicular, not the
    // vertical) — and its crown is 0.12 m wide, so it is not remotely in the way.
    const herb = occlusionOf(CAM, FOCUS, oak("herb", at, 0, 0.4))!;
    expect(herb.clearM).toBeCloseTo(6.417, 2);
    expect(herb.clearM).toBeGreaterThan(crownRadiusM(0.4));
  });

  it("pins the closest approach INSIDE the segments (behind, and past)", () => {
    // Behind the camera: the nearest point on the sight line is its start.
    expect(occlusionOf(CAM, FOCUS, oak("behind", CAM.x + 12, 0))!.u).toBe(0);
    // Past the focus: its end.
    expect(occlusionOf(CAM, FOCUS, oak("past", -12, 0))!.u).toBe(1);
  });

  it("survives every degenerate shape", () => {
    // No sight line at all ⇒ there is no "in front of" to be on.
    expect(occlusionOf(CAM, CAM, oak("t", 1, 1))).toBeNull();
    // A zero-height body is a POINT at its foot — still a number, never NaN.
    const flat = occlusionOf(CAM, FOCUS, oak("flat", CAM.x / 2, 0, 0))!;
    expect(Number.isFinite(flat.clearM)).toBe(true);
    expect(flat.clearM).toBeCloseTo(6.771, 2);
    // Camera straight over the trunk: the sight line and the axis are parallel.
    const over = occlusionOf({ x: 0, y: 0, z: 40 }, FOCUS, oak("under", 0, 0))!;
    expect(Number.isFinite(over.clearM)).toBe(true);
    expect(over.clearM).toBeCloseTo(0, 6);
  });
});

describe("occludingBodies — who is actually in the way", () => {
  it("the tree on the line is; the one a crown-and-a-half aside is not", () => {
    const trees = [oak("on", CAM.x / 2, 0), oak("aside", CAM.x / 2, 11)];
    expect(ids(occludingBodies(CAM, FOCUS, trees, NONE))).toEqual(["on"]);
  });

  it("A TREE STANDING ON THE SITE IS THE SUBJECT, NOT AN OBSTRUCTION", () => {
    // Dead on the sight line, but at the focus end of it: `nearEnter` spares it.
    const atSite = occlusionOf(CAM, FOCUS, oak("home", 0.5, 0))!;
    expect(atSite.clearM).toBeCloseTo(0, 2);
    expect(atSite.u).toBeGreaterThan(OCCLUDER_RULE.nearEnter);
    expect(occludingBodies(CAM, FOCUS, [oak("home", 0.5, 0)], NONE).size).toBe(0);
    // …and the same tree a third of the way out IS in the way.
    expect(ids(occludingBodies(CAM, FOCUS, [oak("home", CAM.x * 0.66, 0)], NONE)))
      .toEqual(["home"]);
  });

  it("nothing behind the camera or past the focus counts", () => {
    const trees = [oak("behind", CAM.x + 12, 0), oak("past", -12, 0)];
    expect(occludingBodies(CAM, FOCUS, trees, NONE).size).toBe(0);
  });

  it("a herb is never a wall (the height floor, and the geometry under it)", () => {
    const trees = [oak("herb", CAM.x / 2, 0, 0.4), oak("bush", CAM.x / 2, 0, 1.3)];
    expect(occludingBodies(CAM, FOCUS, trees, NONE).size).toBe(0);
    // …and it is not the floor ALONE doing the work: drop the floor to zero and
    // the 3-D test still refuses them.
    const rule = { ...OCCLUDER_RULE, minHeightM: 0 };
    expect(occludingBodies(CAM, FOCUS, trees, NONE, { rule }).size).toBe(0);
  });

  it("no sight line ⇒ nobody occludes", () => {
    expect(occludingBodies(CAM, CAM, [oak("on", CAM.x / 2, 0)], NONE).size).toBe(0);
  });
});

describe("HYSTERESIS — a tree grazing the edge never flickers", () => {
  const enterM = crownRadiusM(OAK_M) * OCCLUDER_RULE.enterFrac;
  const exitM = crownRadiusM(OAK_M) * OCCLUDER_RULE.exitFrac;

  it("enters closer than it leaves, and both are fractions of the crown", () => {
    expect(enterM).toBeCloseTo(6.426, 3);
    expect(exitM).toBeCloseTo(8.211, 3);
    expect(exitM).toBeGreaterThan(enterM);
  });

  it("a body between the two thresholds keeps whatever it already was", () => {
    const between = [oak("t", CAM.x / 2, 7)]; // clearance 7 m: past enter, inside exit
    expect(occludingBodies(CAM, FOCUS, between, NONE).size).toBe(0);
    expect(ids(occludingBodies(CAM, FOCUS, between, new Set(["t"])))).toEqual(["t"]);
  });

  it("a lateral sweep out and back flips exactly ONCE each way", () => {
    // The failure this rule exists to prevent: a camera orbiting past a trunk
    // rebuilding that model every frame. Sweep the tree across the sight line
    // and count transitions — an unhysteretic rule flips at the same offset in
    // both directions, so any jitter there is a rebuild storm.
    const STEP = 0.05;
    const OUT = 240; // 12 m of lateral offset, in 5 cm steps
    let held: ReadonlySet<string> = NONE;
    const seen: boolean[] = [];
    for (let i = 0; i <= OUT; i++) {
      held = occludingBodies(CAM, FOCUS, [oak("t", CAM.x / 2, i * STEP)], held);
      seen.push(held.has("t"));
    }
    for (let i = OUT; i >= 0; i--) {
      held = occludingBodies(CAM, FOCUS, [oak("t", CAM.x / 2, i * STEP)], held);
      seen.push(held.has("t"));
    }
    const flips = seen.filter((v, i) => i > 0 && v !== seen[i - 1]).length;
    expect(seen[0]).toBe(true);
    expect(seen[seen.length - 1]).toBe(true);
    expect(flips).toBe(2);
    // …and it let go on the way OUT further than it took hold on the way BACK:
    // the gap between those two offsets IS the hysteresis.
    const outLast = seen.slice(0, OUT + 1).lastIndexOf(true) * STEP;
    const backLastOff = (2 * OUT + 1 - seen.lastIndexOf(false)) * STEP;
    expect(outLast).toBeGreaterThan(enterM);
    expect(outLast).toBeLessThanOrEqual(exitM);
    expect(backLastOff).toBeGreaterThanOrEqual(enterM);
    // The GAP between letting go and taking hold again IS the hysteresis —
    // ~1.8 m of crown at these numbers, and it is what a jittering camera
    // sitting on the edge falls into instead of rebuilding a model every frame.
    expect(outLast - backLastOff).toBeGreaterThan(1);
  });
});

describe("THE HOVERED TREE IS NEVER AN OUTLINE", () => {
  it("it must stay fully drawn and selectable — the orbit dwell IS the pick", () => {
    const trees = [oak("on", CAM.x / 2, 0), oak("also", CAM.x * 0.3, 1)];
    expect(ids(occludingBodies(CAM, FOCUS, trees, NONE))).toEqual(["also", "on"]);
    expect(ids(occludingBodies(CAM, FOCUS, trees, NONE, { exempt: "on" }))).toEqual(["also"]);
  });

  it("…and hovering one that is ALREADY outlined releases it that frame", () => {
    const trees = [oak("on", CAM.x / 2, 0)];
    const held = occludingBodies(CAM, FOCUS, trees, NONE);
    expect(held.has("on")).toBe(true);
    expect(occludingBodies(CAM, FOCUS, trees, held, { exempt: "on" }).size).toBe(0);
  });

  it("a null/absent exemption spares nobody", () => {
    const trees = [oak("on", CAM.x / 2, 0)];
    expect(occludingBodies(CAM, FOCUS, trees, NONE, { exempt: null }).size).toBe(1);
    expect(occludingBodies(CAM, FOCUS, trees, NONE, {}).size).toBe(1);
  });
});

describe("sameOccluders — the driver only pushes on a change", () => {
  it("compares membership, not identity or order", () => {
    expect(sameOccluders(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
    expect(sameOccluders(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
    expect(sameOccluders(new Set(["a"]), new Set(["b"]))).toBe(false);
    expect(sameOccluders(NONE, new Set<string>())).toBe(true);
  });
});

describe("the seams: a FORCED TIER, an outline, and nothing the sim can see", () => {
  it("the host holds an occluder at the SILHOUETTE rung, in the one tier expression", () => {
    expect(HOST).toContain('const OCCLUDER_TIER: CreatureTier = "stick";');
    expect(HOST).toContain(
      "if (occluders.has(id) && TIER_RANK[OCCLUDER_TIER] > TIER_RANK[t]) t = OCCLUDER_TIER;",
    );
    // ONE effective-tier rule, read by the build query AND by the town clamp's
    // requeue filter — a second copy is how the two would come to disagree.
    expect(HOST).toContain("return effectiveTier(id, b, creatureTier);");
    expect(HOST).toContain("const oldEff = effectiveTier(id, b, prevTown);");
  });

  it("it rides the EXISTING re-tier drain, and never writes the body's band", () => {
    expect(HOST).toContain("if (without !== withForce && !retierQueue.includes(id)) retierQueue.push(id);");
    expect(HOST).toContain("questView?.setAvatarOutline?.(id, on);");
    // `bodyTiers` is left alone on purpose: the projected-size band keeps
    // tracking underneath, so releasing an occluder restores its real rung with
    // no re-seed. If this ever starts writing it, a released tree would be
    // stuck at `stick` until it moved.
    const at = HOST.indexOf("    setOccluders(ids) {");
    expect(at).toBeGreaterThan(0);
    const body = HOST.slice(at, HOST.indexOf("\n    },", at));
    expect(body).not.toContain("bodyTiers");
  });

  it("the candidates are FLORA bodies with the ladder's own height", () => {
    const at = HOST.indexOf("    occluderCandidates() {");
    expect(at).toBeGreaterThan(0);
    const body = HOST.slice(at, HOST.indexOf("\n    },", at));
    expect(body).toContain("if (!id.startsWith(FLORA_BODY_PREFIX)) continue;");
    expect(body).toContain("heightM: bodyHeightM(id)");
  });

  it("the DRIVER owns the camera, the focus and the hover", () => {
    // The occluder test is fed the SAME camera point the LOD seam pushes — one
    // point, two consumers, so they can never disagree about where the viewer is.
    expect(MAIN).toContain("stepTreeOccluders({ x: lv.x, y: lv.z, z: lv.y }, now);");
    expect(MAIN).toContain("const held = !!spirit && spirit.ladder.level === \"town\" && spirit.ladder.builderHold;");
    // The focus is the sim's OWN near stand, never a re-derived centre.
    expect(MAIN).toContain("{ x: ns.at.x, y: ns.at.y, z: 0 }");
    // …and the hover comes from the host, not from a second pick.
    expect(MAIN).toContain("{ exempt: host.hoveredBodyId() }");
    expect(HOST).toContain('return hv && hv.kind === "avatar" ? hv.id : null;');
  });

  it("the outline is the STICK tier hollowed, not a second model path", () => {
    // One geometry, one bake cache: only the MATERIAL differs, and it is
    // assigned per-Mesh so outlining one oak cannot ghost every oak.
    expect(STICK).toContain("export function stickOutlineMaterial(): THREE.MeshBasicMaterial {");
    expect(STICK).toContain("if ( stickDist < stickR - ");
    // 🚨 A per-variant program cache key: three caches programs by this string,
    // so a shared key would hand the outline the solid variant's program.
    expect(STICK).toContain('mat.customProgramCacheKey = () => (outline ? "stick-lod-outline" : "stick-lod");');
    // The rim is a constant number of DEVICE PIXELS, not a share of the capsule.
    expect(STICK).toContain("vStickPerPx = unitsPerPx;");
    expect(RENDER).toContain('cur.name === "stick-lod"');
    expect(RENDER).toContain("this.applyAvatarOutline(model, this.outlinedAvatars.has(a.id));");
    expect(VIEW).toContain("setAvatarOutline?(id: string, on: boolean): void;");
  });

  it("nothing about it reaches the sim, and a driverless host allocates nothing", () => {
    expect(HOST).toContain("const EMPTY_OCCLUDERS: ReadonlySet<string> = new Set<string>();");
    expect(HOST).toContain("let occluders: ReadonlySet<string> = EMPTY_OCCLUDERS;");
    // The predicate module is PURE — no THREE, no host, no session.
    const SRC = read("shared", "world-engine", "spirit", "occluders.ts");
    expect(SRC).not.toContain("import ");
    expect(SRC).not.toMatch(/from ["']/);
  });
});
