// PEOPLE LOD = TRUE 3-D CAMERA DISTANCE (user ruling 2026-09-06: "Fix the
// people LOD too — use true 3D camera distance").
//
// The per-body view tier was banded on `Math.hypot(dx, dy)` — the sim-plane
// projection of camera→body, i.e. THE CAMERA'S ALTITUDE DROPPED. Every camera
// this engine has that is not a walker looks DOWN: the district orbit stands
// 41.6 m up and 76.2 m out from its focus (spirit/ladder.ts: CITY_PITCH 0.5,
// CITY_FRAME 1.35, 50° rig), and a straight-down camera has no horizontal
// offset at all — so a crowd of 8-pixel figures banded as if it were underfoot.
//
// The fix is one measure, `tierDistanceM`, used by BOTH ladders and by both
// kinds of body (residents and `flora:` trees re-band through the same sweep).
// Bands are UNCHANGED (15/45/110 per-body, 180/320/450 town) — re-anchoring
// them is a separate feel decision.
//
// PURE: view-tiers.ts has no THREE and no host, so this suite value-imports it.
// The three CALL SITES (the host's sweep + seed, and the two drivers that feed
// the height) are source pins for the same reason flora-tier-ladder.test.ts is
// — a value import of quest-host taxes every worker with the host's transform.
//
// Slice: `npm run test:engine -- tier-distance`

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TIER_BANDS,
  TOWN_TIER_BANDS,
  SCREEN_TIER_BANDS,
  TIER_RANK,
  TIER_REF_BODY_M,
  TIER_REF_FOV_DEG,
  TIER_REF_FOV_RAD,
  projectedFraction,
  refDistanceForFraction,
  seedTier,
  seedTierForProjected,
  steppedTier,
  tierDistanceM,
  tierForProjected,
} from "@shared/world-engine/creatures/view-tiers.js";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const HOST = read("shared", "world-engine", "interaction", "quest", "quest-host.ts");
const MAIN = read("games", "world-lab", "src", "main.ts");
const BOOT = read("games", "world-lab", "src", "quest-boot.ts");
const DOLL = read("games", "dollhouse", "src", "quest-boot.ts");

/** The band a body lands on at first sight (no previous tier to hold). */
const bandAt = (d: number) => seedTier(TIER_BANDS, d);

// The held district orbit, derived rather than pasted: the spirit ladder poses
// the orbit at `dist = (radius / tan(fov/2)) * CITY_FRAME`, pitched CITY_PITCH
// above the horizon, and the builder hold frames the sim's relevance disc
// (30 m at built 0, 96 m at the cap).
const CITY_PITCH = 0.5;
const CITY_FRAME = 1.35;
const FOV_RAD = (50 * Math.PI) / 180;
const orbit = (frameRadiusM: number) => {
  const dist = (frameRadiusM / Math.tan(FOV_RAD / 2)) * CITY_FRAME;
  return { dist, up: dist * Math.sin(CITY_PITCH), out: dist * Math.cos(CITY_PITCH) };
};

describe("tierDistanceM — the ONE distance both ladders band on", () => {
  it("counts the camera's HEIGHT: a body under a high camera is not `full`", () => {
    // 10 m off-axis, camera 80 m up. The old measure called this 10 m — full
    // fidelity, animator, wardrobe — for a figure ~14 px tall.
    const d = tierDistanceM({ x: 0, y: 0, z: 80 }, { x: 10, y: 0 });
    expect(d).toBeCloseTo(Math.hypot(10, 80), 10);
    expect(bandAt(d)).toBe("stick");
    expect(bandAt(10)).toBe("full"); // what it used to be
    // …and high enough, it reaches the placeholder pill, which the sim-plane
    // measure could never do from directly overhead.
    expect(bandAt(tierDistanceM({ x: 0, y: 0, z: 130 }, { x: 10, y: 0 }))).toBe("capsule");
    expect(bandAt(tierDistanceM({ x: 0, y: 0, z: 400 }, { x: 0, y: 0 }))).toBe("capsule");
  });

  it("still gives `full` to a body a dozen metres from the camera", () => {
    // The near case the ruling must not break: 12 m away on the orbit, camera
    // height included, is inside the 15 m full band.
    const o = orbit(6); // the frame floor, ORBIT_FRAME_FLOOR_M
    const dToOrbitFocus = tierDistanceM({ x: o.out, y: 0, z: o.up }, { x: 0, y: 0 });
    expect(dToOrbitFocus).toBeCloseTo(o.dist, 10);
    expect(tierDistanceM({ x: 0, y: 0, z: 7 }, { x: 9.75, y: 0 })).toBeCloseTo(12, 2);
    expect(bandAt(tierDistanceM({ x: 0, y: 0, z: 7 }, { x: 9.75, y: 0 }))).toBe("full");
    expect(bandAt(12)).toBe("full");
  });

  it("HEIGHT 0 reproduces the old 2-D arithmetic exactly (the headless pin)", () => {
    // Text mode / every driverless host feeds no view point at all, and the two
    // fallbacks (`spiritFrame`'s rect centre, the walker body) are ground
    // things with no height — so `dz` is 0 and the result must be bit-identical
    // to `Math.hypot(dx, dy)`. That is what makes the transcript diff 0 lines.
    for (const [ax, ay, bx, by] of [
      [0, 0, 3, 4], [12.5, -7.25, -3.5, 91.125], [-1e-3, 1e-3, 1e3, -1e3], [0, 0, 0, 0],
      [7, 7, 7, 7], [1e6, 1e6, 1e6 + 0.1, 1e6 - 0.1],
    ]) {
      const two = Math.hypot(bx - ax, by - ay);
      expect(tierDistanceM({ x: ax, y: ay }, { x: bx, y: by })).toBe(two);
      expect(tierDistanceM({ x: ax, y: ay, z: 0 }, { x: bx, y: by, z: 0 })).toBe(two);
      // …and the band that comes out of it, which is what actually ships.
      expect(bandAt(tierDistanceM({ x: ax, y: ay }, { x: bx, y: by }))).toBe(bandAt(two));
    }
  });

  it("is symmetric, non-negative and monotone in each leg", () => {
    const a = { x: 3, y: -4, z: 12 };
    const b = { x: -9, y: 1 };
    expect(tierDistanceM(a, b)).toBeCloseTo(tierDistanceM(b, a), 10);
    expect(tierDistanceM(a, a)).toBe(0);
    expect(tierDistanceM({ x: 0, y: 0, z: 50 }, { x: 30, y: 0 }))
      .toBeGreaterThan(tierDistanceM({ x: 0, y: 0, z: 10 }, { x: 30, y: 0 }));
  });

  it("bands 15/45/110 are UNCHANGED by this round", () => {
    expect(TIER_BANDS.map((b) => `${b.tier}@${b.from}`))
      .toEqual(["full@0", "simple@15", "stick@45", "capsule@110"]);
  });
});

describe("the held district orbit, measured both ways", () => {
  // What the ruling actually buys at the founding's held orbit — the numbers
  // that belong in the landing note, kept honest here so a later re-anchor has
  // a baseline to move.
  it("a body at the orbit's focus: 76.2 m by the old measure, 86.9 m by the new", () => {
    const o = orbit(30); // relevance disc at built 0 → district frame radius 30 m
    expect(o.up).toBeCloseTo(41.6, 1);
    expect(o.out).toBeCloseTo(76.2, 1);
    expect(o.dist).toBeCloseTo(86.9, 1);
    const cam = { x: o.out, y: 0, z: o.up };
    const focusBody = { x: 0, y: 0 };
    expect(Math.hypot(focusBody.x - cam.x, focusBody.y - cam.y)).toBeCloseTo(76.2, 1);
    expect(tierDistanceM(cam, focusBody)).toBeCloseTo(86.9, 1);
    // BOTH land in the same rung: the 3-D measure does NOT by itself move the
    // held orbit into `full` (or even `simple`) — it makes the number honest.
    // Putting the orbit in `full` is a BAND re-anchor, a separate feel call.
    expect(bandAt(76.2)).toBe("stick");
    expect(bandAt(tierDistanceM(cam, focusBody))).toBe("stick");
  });

  it("at the 96 m ring cap the orbit is capsule range either way", () => {
    const o = orbit(96);
    expect(o.dist).toBeCloseTo(277.9, 1);
    expect(bandAt(o.out)).toBe("capsule");
    expect(bandAt(tierDistanceM({ x: o.out, y: 0, z: o.up }, { x: 0, y: 0 }))).toBe("capsule");
  });

  it("zoomed to the floor, a body at the focus keeps `full` through hysteresis", () => {
    const o = orbit(6); // ORBIT_FRAME_FLOOR_M
    const d = tierDistanceM({ x: o.out, y: 0, z: o.up }, { x: 0, y: 0 });
    expect(d).toBeCloseTo(17.4, 1);
    // A first sighting seeds `simple`; a body already full holds full (17.4 is
    // inside the 15 + 10 margin), so zooming in does not flap the crowd.
    expect(bandAt(d)).toBe("simple");
    expect(steppedTier(TIER_BANDS, "full", d, 10)).toBe("full");
  });
});

describe("the TOWN clamp — same measure, same table, values unchanged", () => {
  it("keeps 180/320/450, and lives beside the per-body table", () => {
    expect(TOWN_TIER_BANDS.map((b) => `${b.tier}@${b.from}`))
      .toEqual(["full@0", "simple@180", "stick@320", "capsule@450"]);
    // The driver reads THIS table (no second copy in main.ts to drift).
    expect(MAIN).toContain("TOWN_TIER_BANDS");
    expect(MAIN).not.toMatch(/const TOWN_TIER_BANDS\s*[:=]/);
    expect(MAIN).toContain("steppedTier(TOWN_TIER_BANDS, appliedTier, distM, TIER_HYST_M)");
  });

  it("is fed a 3-D camera→centre distance, not a projection", () => {
    // `anchorPos` is the camera's WORLD position and `.distanceTo` is 3-D — the
    // town clamp already measured the way the ruling asks, which is why only
    // the per-body side changed. Pinned so a later refactor cannot quietly
    // flatten it to the sim plane and put the two ladders back out of step.
    expect(MAIN).toContain("const townDistM = anchorPos.distanceTo(liveViz.fc.worldPos);");
  });

  it("stays the COARSER of the two ladders (the effective tier rule)", () => {
    const camAtOrbit = tierDistanceM({ x: 76.2, y: 0, z: 41.6 }, { x: 0, y: 0 });
    const town = seedTier(TOWN_TIER_BANDS, camAtOrbit); // 86.9 m → full
    const body = bandAt(camAtOrbit);                    // 86.9 m → stick
    expect(town).toBe("full");
    expect(TIER_RANK[body] > TIER_RANK[town] ? body : town).toBe("stick");
  });
});

describe("the call sites feed the third leg", () => {
  it("quest-host bands on tierDistanceM, in BOTH the sweep and the seed", () => {
    expect(HOST).toContain("const d = tierDistanceM(focus, bd);");
    // (`…At(id, …, fovRad)` since the camera round: the same distance, handed
    // to the pick that also knows the camera's lens — see the C3 block below.)
    expect(HOST).toContain("seedBodyTierAt(id, tierDistanceM(focus, bd), projectingFov())");
    // The 2-D form is gone from the ladder entirely.
    expect(HOST).not.toContain("Math.hypot(bd.x - focus.x, bd.y - focus.y)");
  });

  it("the camera focus carries height, and the ground fallbacks do not", () => {
    const at = HOST.indexOf("const cameraFocus = (): TierPoint | null => {");
    expect(at).toBeGreaterThan(0);
    const body = HOST.slice(at, HOST.indexOf("\n  };", at));
    expect(body).toContain("if (viewPoint) return viewPoint;");
    // A spirit frame is a rect ON the plane and a walker is a body standing on
    // it: neither may invent a `z`, or a headless host stops being byte-identical.
    expect(body).not.toContain("z:");
  });

  it("both world-lab drivers push the camera's altitude — AND its lens", () => {
    // The town session and the wild session read ONE camera, so they must feed
    // the same components or a fauna body and a resident at equal distance
    // would band differently. `viewLens()` is that one expression (user ruling
    // C4: ONE seam, and nothing reads a camera from a global).
    expect(MAIN).toContain("embedTown.host.setViewPoint({ x: lv.x, y: lv.z, z: lv.y, ...viewLens() });");
    expect(MAIN).toContain("embedWild.quest.setViewPoint({ x: wv.x, y: wv.z, z: wv.y, ...viewLens() });");
    expect(MAIN).toContain("return { fovRad: (camera.fov * Math.PI) / 180, viewportH: viewEl.clientHeight || 1 };");
    // …and the standalone quest boot, whose camera is already in sim coords.
    expect(BOOT).toContain("x: cam.position.x, y: cam.position.z, z: cam.position.y,");
    expect(BOOT).toContain("fovRad: (cam.fov * Math.PI) / 180, viewportH: canvas.clientHeight || 1,");
    // …and the dollhouse game's own boot, which fed NOTHING before this round:
    // its per-body tiers measured from the focus RECT (a heightless, lens-less
    // fallback) while the dollhouse rig ran its own 40° fov.
    expect(DOLL).toContain("x: cam.position.x, y: cam.position.z, z: cam.position.y,");
    expect(DOLL).toContain("fovRad: (cam.fov * Math.PI) / 180, viewportH: canvas.clientHeight || 1,");
    // No driver may push a heightless point any more.
    expect(MAIN).not.toMatch(/setViewPoint\(\{ x: [a-z]+\.x, y: [a-z]+\.z \}\)/);
  });

  it("the __flora audit measures dFocus with the ladder's own function", () => {
    // The audit's job is to tell the truth about what the ladder measures; a
    // re-derivation there is how it came to report a stale rule.
    expect(MAIN).toContain("tierDistanceM(camSess, { x: p.x, y: p.y })");
  });
});

// ── LOD BY PROJECTED SIZE (user ruling C3, 2026-09-06) ──────────────────────
//
// *"even when zoomed in the people still appear with low-level LOD"* — metres
// are not the question; the share of the SCREEN a body fills is. The bands were
// calibrated in pixels on the walker's 50° rig against a 1.7 m body and then
// written down as metres, which pinned them to one camera and one body size.
// The pick now reads the projected height, and the screen bands are DERIVED
// from the metre bands at that same reference rig — so a walker session picks
// the same rung it always did, at every edge.

describe("the screen bands are DERIVED from the walker's metre bands", () => {
  it("the reference rig is the walker's own: 50°, a 1.7 m body", () => {
    expect(TIER_REF_FOV_DEG).toBe(50);
    expect(TIER_REF_FOV_RAD).toBeCloseTo((50 * Math.PI) / 180, 12);
    expect(TIER_REF_BODY_M).toBe(1.7);
  });

  it("SCREEN_TIER_BANDS is TIER_BANDS through the projection, not a second table", () => {
    expect(SCREEN_TIER_BANDS.map((b) => b.tier)).toEqual(TIER_BANDS.map((b) => b.tier));
    // `full` has no lower edge above it — it takes over from "bigger than
    // anything else", which is what the infinity says.
    expect(SCREEN_TIER_BANDS[0]).toEqual({ tier: "full", below: Number.POSITIVE_INFINITY });
    for (let i = 1; i < TIER_BANDS.length; i++) {
      expect(SCREEN_TIER_BANDS[i]!.below).toBeCloseTo(
        projectedFraction(TIER_REF_BODY_M, TIER_BANDS[i]!.from, TIER_REF_FOV_RAD), 12,
      );
    }
    // The numbers themselves, so a silent band move is visible in the diff.
    expect(SCREEN_TIER_BANDS[1]!.below).toBeCloseTo(0.121522, 6); // 1.7 m at 15 m
    expect(SCREEN_TIER_BANDS[2]!.below).toBeCloseTo(0.040507, 6); // 1.7 m at 45 m
    expect(SCREEN_TIER_BANDS[3]!.below).toBeCloseTo(0.016571, 6); // 1.7 m at 110 m
  });

  it("the projection and its inverse round-trip", () => {
    for (const d of [1, 7.5, 15, 45, 87, 110, 1000]) {
      expect(refDistanceForFraction(projectedFraction(TIER_REF_BODY_M, d, TIER_REF_FOV_RAD)))
        .toBeCloseTo(d, 9);
    }
    // A body twice as tall looks the same size twice as far away — the whole
    // reason a 23.8 m oak may not share a 1.7 m person's metre ladder.
    expect(projectedFraction(3.4, 90, TIER_REF_FOV_RAD))
      .toBeCloseTo(projectedFraction(1.7, 45, TIER_REF_FOV_RAD), 12);
  });

  it("A WALKER SESSION IS UNCHANGED: the projected pick == the distance pick at every band edge", () => {
    // THE PIN THE WHOLE RULING RESTS ON. At the walker's fov, for a
    // walker-sized body, the two coordinates are the same ladder — so no
    // walker session moves a rung on this round.
    const EPS = 1e-9;
    const at = (d: number) => projectedFraction(TIER_REF_BODY_M, d, TIER_REF_FOV_RAD);
    for (const b of TIER_BANDS) {
      for (const d of [b.from + EPS, b.from + 0.001, b.from + 1, Math.max(EPS, b.from - 0.001)]) {
        expect(seedTierForProjected(at(d))).toBe(seedTier(TIER_BANDS, d));
      }
    }
    // …hysteresis and all: every rung, both directions, across the whole range.
    // Sampled OFF the integers on purpose: the hysteretic comparisons are
    // strict (`d > from + hyst`) and the round trip through the projection is
    // exact only to an ulp, so landing a sample exactly on 5/25/35/55/100/120
    // would be asserting on the last bit rather than on the ladder.
    for (const prev of TIER_BANDS.map((b) => b.tier)) {
      for (let d = 0.25; d < 200; d += 0.5) {
        expect(tierForProjected(at(d), prev, 10)).toBe(steppedTier(TIER_BANDS, prev, d, 10));
      }
    }
  });

  it("a TALL body earns detail a person at the same distance does not", () => {
    // The defect in one line: at the founding's held orbit a 23.8 m oak and a
    // 1.7 m settler stand at the same 86.9 m and used to get the same rung.
    const d = 86.9;
    const person = projectedFraction(1.7, d, TIER_REF_FOV_RAD);
    const oak = projectedFraction(23.8, d, TIER_REF_FOV_RAD);
    expect(person).toBeCloseTo(0.020976, 6); // 2.1 % of the screen's height
    expect(oak).toBeCloseTo(0.293667, 6);    // 29 % of it — 14× the person
    expect(seedTierForProjected(person)).toBe("stick");
    expect(seedTierForProjected(oak)).toBe("full");
    expect(seedTier(TIER_BANDS, d)).toBe("stick"); // what BOTH used to get
  });

  it("a WIDER lens coarsens and a NARROWER one refines, at one distance", () => {
    // The other half: the same body at the same distance is a different size on
    // screen under a different camera. The dollhouse rig's 40° is narrower than
    // the walker's 50°, so it sees MORE detail from the same spot.
    const d = 50;
    const walker = projectedFraction(1.7, d, TIER_REF_FOV_RAD);
    const doll = projectedFraction(1.7, d, (40 * Math.PI) / 180);
    const wide = projectedFraction(1.7, d, (100 * Math.PI) / 180);
    expect(doll).toBeGreaterThan(walker);
    expect(wide).toBeLessThan(walker);
    expect(refDistanceForFraction(doll)).toBeCloseTo(d * Math.tan((40 * Math.PI) / 360) / Math.tan(TIER_REF_FOV_RAD / 2), 9);
  });

  it("degenerate inputs never NaN a tier", () => {
    expect(projectedFraction(1.7, 0, TIER_REF_FOV_RAD)).toBe(Number.POSITIVE_INFINITY);
    expect(seedTierForProjected(Number.POSITIVE_INFINITY)).toBe("full"); // on top of it
    expect(seedTierForProjected(0)).toBe("capsule");                      // vanishingly small
    expect(tierForProjected(0, "full", 10)).toBe("capsule");
  });
});

describe("the host takes the projected pick ONLY when a driver hands it a camera", () => {
  it("the sweep and the seed both go through the one gate", () => {
    // Source pins for the same reason the rest of this file uses them: a value
    // import of quest-host taxes every worker with the host's transform.
    expect(HOST).toContain("const fovRad = projectingFov();");
    expect(HOST).toContain("bodyTiers.set(id, seedBodyTierAt(id, d, fovRad));");
    expect(HOST).toContain("const t = bandedBodyTierAt(id, prev, d, fovRad);");
    expect(HOST).toContain("seedBodyTierAt(id, tierDistanceM(focus, bd), projectingFov())");
  });

  it("HEADLESS IS BYTE-IDENTICAL: no fov ⇒ the metre pick, verbatim", () => {
    // The transcript pin. `projectingFov` returns null unless BOTH a finite
    // positive fov and a positive viewport arrived, and a null takes the
    // `seedBodyTier`/`bandedBodyTier` arms — the untouched metre functions.
    const at = HOST.indexOf("const projectingFov = (): number | null => {");
    expect(at).toBeGreaterThan(0);
    const body = HOST.slice(at, HOST.indexOf("\n  };", at));
    expect(body).toContain("if (!v) return null;");
    expect(body).toContain("f <= 0");
    expect(body).toContain("h <= 0");
    expect(HOST).toContain("? seedBodyTier(d)");
    expect(HOST).toContain("? bandedBodyTier(prev, d)");
  });

  it("a body's height comes from the registry the MODEL FACTORY reads", () => {
    // A tier is a claim about what the factory will build, so the two must read
    // one source: people 1.7, pets 0.75, fauna/flora the registry height, and a
    // staged plant its own stage's share of it (the sim's stage, never a
    // viewer-side guess — the LOD-per-camera law).
    const at = HOST.indexOf("const bodyHeightM = (id: string): number => {");
    expect(at).toBeGreaterThan(0);
    const body = HOST.slice(at, HOST.indexOf("\n  };", at));
    expect(body).toContain("naturalSourceOf(idSpeciesOf(id))");
    expect(body).toContain("src?.bodyHeightM ?? 0.95");
    expect(body).toContain("growthHeightFactor(plantAgeOfBody(sess, id))");
    expect(body).toContain('id.startsWith("pet_")');
    // …and the cache is pruned by the same loop that prunes the tiers, so a
    // respawned body re-reads its stage instead of inheriting a dead one.
    expect(HOST).toContain("for (const id of bodyHeights.keys()) {");
  });

  it("the town clamp is NOT projected — it is a camera→centre coarsening", () => {
    // The clamp measures the camera against the TOWN, which has no body height
    // and no rung of its own to project. It stays exactly as it was (user
    // ruling C3: "the town clamp stays as the far coarsening").
    expect(MAIN).toContain("steppedTier(TOWN_TIER_BANDS, appliedTier, distM, TIER_HYST_M)");
    expect(MAIN).not.toContain("tierForProjected");
  });
});
