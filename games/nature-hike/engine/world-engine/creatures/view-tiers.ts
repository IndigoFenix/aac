// CREATURE VIEW TIERS — the distance ladder, and nothing else.
//
// A body's fidelity is a RENDER-ONLY, PER-CAMERA choice: each client picks it
// from ITS OWN camera, so in multiplayer every peer dresses the same replicated
// bodies at its own fidelity and no tier state ever rides the wire or feeds the
// sim. (LAW — see planning-docs/games/world-engine/view-distance-lod-tiers.md.)
//
// Two ladders run this table, and BOTH measure the TRUE 3-D distance from the
// camera (user ruling 2026-09-06) — `tierDistanceM` below is the one measure:
//   • the PER-BODY band (quest-host), camera → each body — the one that matters
//     once the camera is inside a town;
//   • the coarse TOWN clamp (the driver in main.ts), camera → the town centre —
//     the orbit/approach clamp. The EFFECTIVE tier is the coarser.
//
// PURE — no THREE, no host. It lives on its own so both drivers and the test
// share ONE boundary rule (a rule written twice is where an asymmetric edge,
// and the rebuild flap it causes, hides) without value-importing the host.

import type { CreatureDetail } from "./creature-model";

/** full → simple → stick → capsule, coarsening with distance. `capsule` is not
 *  a build detail at all: it REPLACES the body with the placeholder pill. */
export type CreatureTier = CreatureDetail | "capsule";

export interface TierBand {
  tier: CreatureTier;
  /** Metres at which this rung takes over (the ladder is nearest-first). */
  from: number;
}

/** THE PER-BODY LADDER. Calibrated against what a body is actually WORTH at
 *  each range: on the 50° rig a 1.7 m body is ~1160/d pixels tall, so
 *    <15 m  (>77 px) — the loft's rings are visible; full fidelity earns it.
 *    15-45 m (26-77 px) — the cheap loft still reads as a dressed body.
 *    45-110 m (11-26 px) — clothing is 2 px of colour and the skin is a
 *      silhouette, so the STICK tier draws that silhouette directly, at one
 *      bake per species instead of one per garment (creature-model.ts's
 *      `outfitForDetail`). This band used to be `simple` — it is the band the
 *      dollhouse crawl was paid in.
 *    >110 m (<11 px) — the placeholder capsule; nothing of the body survives. */
export const TIER_BANDS: readonly TierBand[] = [
  { tier: "full", from: 0 },
  { tier: "simple", from: 15 },
  { tier: "stick", from: 45 },
  { tier: "capsule", from: 110 },
];

/** THE COARSE TOWN CLAMP — camera → town CENTRE, one rung per band. The
 *  orbit/approach ladder: it cannot tier a crowd the camera stands INSIDE (that
 *  is the per-body band above), it only stops a town two districts away from
 *  dressing anybody. Lives here, beside the per-body table, because the driver
 *  (world-lab `hystereticCreatureTier`) and the pin must read ONE table — a
 *  second copy is how the two ladders would come to disagree. */
export const TOWN_TIER_BANDS: readonly TierBand[] = [
  { tier: "full", from: 0 },
  { tier: "simple", from: 180 },
  { tier: "stick", from: 320 },
  { tier: "capsule", from: 450 },
];

/** Coarseness order — the EFFECTIVE tier of two ladders is the higher rank. */
export const TIER_RANK: Record<CreatureTier, number> = { full: 0, simple: 1, stick: 2, capsule: 3 };

/** A point the LOD measures FROM or TO, in one session's SIM metres.
 *
 *  ⚖️ ONE HEIGHT CONVENTION (user ruling 2026-09-06, "use true 3D camera
 *  distance"): `x`/`y` are the sim plane; `z` is metres ABOVE THE SIM GROUND
 *  PLANE — the plane the session's own coordinates live on (world-lab: the
 *  live-town anchor's local y = 0, so a driver reads it straight off
 *  `worldToLocal(camera)`.y). A BODY stands on that ground, so a body's `z` is
 *  0 and is simply omitted; only the camera ever carries one. Terrain lift
 *  under a body is deliberately NOT in it — an LOD band is not a ground query,
 *  and a metre of hill is noise against a 15/45/110 ladder. */
export interface TierPoint {
  x: number;
  y: number;
  /** Metres above the sim ground plane. Absent ⇒ 0 (on the ground). */
  z?: number;
}

/** THE ONE SEAM A DRIVER HANDS THE HOST (user ruling C4, 2026-09-06: *"the
 *  drivers hand the provider the FULL camera … nothing reads `camera` from a
 *  global"*). A `TierPoint` — position INCLUDING height — plus the two facts
 *  that turn a distance into a SIZE ON SCREEN.
 *
 *  Both optional, and the pair is the switch: with a finite `fovRad > 0` and
 *  `viewportH > 0` the host bands by PROJECTED SIZE (`tierForProjected`);
 *  without them it bands by metres exactly as before. A headless host (text
 *  mode, every driverless test) feeds no view point at all, so it takes the
 *  metre path verbatim — that is what keeps the transcripts byte-identical. */
export interface ViewPoint extends TierPoint {
  /** VERTICAL field of view in RADIANS (THREE's `PerspectiveCamera.fov` is
   *  vertical; convert the degrees). */
  fovRad?: number;
  /** Viewport height in pixels. The tier itself is scale-free — a fraction of
   *  the viewport height — so this is not in the band arithmetic; it is what
   *  makes the fraction a SCREEN measure a readout can quote in pixels, and it
   *  is the second half of "the driver really handed me a camera". */
  viewportH?: number;
}

/** THE DISTANCE THE LADDER BANDS — the TRUE 3-D camera→body distance.
 *
 *  Was `hypot(dx, dy)`: the camera's ALTITUDE WAS DROPPED, so an orbit camera
 *  41 m up and 76 m out banded its subject at 76 m instead of 87 m, and a
 *  camera directly overhead banded everything under it at ~0 m — full fidelity
 *  for a crowd of 8-pixel figures.
 *
 *  Headless / text mode feeds no height at all (nor do the `spiritFrame` and
 *  player-body fallbacks), and `dz === 0` takes the 2-D branch VERBATIM — so a
 *  driverless host's arithmetic is byte-identical to what it was, which is the
 *  transcript pin. (`Math.hypot(a, b, 0)` should agree anyway; the branch means
 *  it does not have to.) */
export function tierDistanceM(from: TierPoint, to: TierPoint): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = (to.z ?? 0) - (from.z ?? 0);
  return dz === 0 ? Math.hypot(dx, dy) : Math.hypot(dx, dy, dz);
}

/** The rung a distance lands on with NO hysteresis — a first sighting, where
 *  there is no previous tier to hold. A far spawn must seed here rather than
 *  build full and be rebuilt a frame later. */
export function seedTier(bands: readonly TierBand[], distM: number): CreatureTier {
  let t: CreatureTier = bands[0]?.tier ?? "full";
  for (const b of bands) if (distM >= b.from) t = b.tier;
  return t;
}

/** Step a banded tier WITH hysteresis: coarsen only once the distance is
 *  `hystM` PAST the next boundary, refine only once it is `hystM` INSIDE the
 *  previous one. Every flip costs a model rebuild, so a camera hovering on a
 *  boundary must never flap — the same failure mode as the crowd-budget churn
 *  regression. Table-driven, and it may cross several rungs in one call (a
 *  fast descent), so a jump from capsule to full never stalls a rung short. */
export function steppedTier(
  bands: readonly TierBand[],
  prev: CreatureTier,
  distM: number,
  hystM: number,
): CreatureTier {
  let j = Math.max(0, bands.findIndex((b) => b.tier === prev));
  while (j + 1 < bands.length && distM > bands[j + 1].from + hystM) j++;
  while (j > 0 && distM < bands[j].from - hystM) j--;
  return bands[j]?.tier ?? "full";
}

// ── LOD BY PROJECTED SIZE (user ruling C3, 2026-09-06) ──────────────────────
//
// *"even when zoomed in the people still appear with low-level LOD"* — because
// METRES ARE NOT THE QUESTION. What a body is worth is how much of the screen
// it fills, and that depends on the camera's fov and the body's own height as
// much as on the distance. The walker bands above were CALIBRATED in pixels
// ("on the 50° rig a 1.7 m body is ~1160/d px tall") and then written down as
// metres, which silently pinned them to one camera and one body size: an orbit
// camera at a different fov, a 23.8 m oak, or a future scheme all get the wrong
// rung from the right number.
//
// So the pick reads the PROJECTED HEIGHT — the fraction of the viewport's
// height the body covers — and the bands are DERIVED from the walker's own
// metre bands at the walker's own fov, which makes a walker session pick the
// same tier at every band edge as it always did (pinned in
// tier-distance-3d.test.ts). Nothing about the ladder, its order or its
// hysteresis changes; only the coordinate it is measured in.

/** THE REFERENCE RIG the metre bands were calibrated on: the WALKER's own
 *  camera. `world-tunables.ts` `camera.overhead.fov` / `camera.shoulder.fov`
 *  are both 50°, and render3d builds and drives its camera at `rig.fov`. */
export const TIER_REF_FOV_DEG = 50;
export const TIER_REF_FOV_RAD = (TIER_REF_FOV_DEG * Math.PI) / 180;
/** …and the reference BODY: a person, the subject the bands were calibrated
 *  against (`TIER_BANDS` above: "a 1.7 m body"; quest-host's people factory
 *  stands everyone at `heightM: 1.7`). */
export const TIER_REF_BODY_M = 1.7;

/** What fraction of the VIEWPORT HEIGHT a body of `bodyM` standing `distM`
 *  from the camera covers, under a vertical field of view `fovRad`.
 *
 *  The whole of the perspective projection that matters here: the view frustum
 *  is `2·d·tan(fov/2)` metres tall at distance `d`, so the body covers
 *  `bodyM` of that. Scale-free — no pixels, no aspect ratio (THREE's `fov` is
 *  vertical, so the aspect only ever widens the picture sideways). */
export function projectedFraction(bodyM: number, distM: number, fovRad: number): number {
  const halfSpan = distM * Math.tan(fovRad / 2);
  return halfSpan > 0 ? bodyM / (2 * halfSpan) : Number.POSITIVE_INFINITY;
}

/** The inverse, AT THE REFERENCE RIG: the walker distance at which a person
 *  covers `fraction` of the screen. This is the bridge between the two
 *  coordinates — see `tierForProjected`. */
export function refDistanceForFraction(fraction: number): number {
  return fraction > 0
    ? TIER_REF_BODY_M / (2 * Math.tan(TIER_REF_FOV_RAD / 2) * fraction)
    : Number.POSITIVE_INFINITY;
}

/** THE SAME LADDER, STATED IN SCREEN FRACTION — **computed, never painted**.
 *  The mirror of `TIER_BANDS`: `below` is the share of the viewport height a
 *  body must drop UNDER for this rung to take over (a metre band says "takes
 *  over at/above this distance"; further away is smaller on screen, so the
 *  comparison flips with it):
 *
 *      full     — anything bigger than the next entry
 *      simple   < 0.121521   (1.7 m at 15 m, 50°)
 *      stick    < 0.040507   (1.7 m at 45 m, 50°)
 *      capsule  < 0.016571   (1.7 m at 110 m, 50°)
 *
 *  Derived here so the two statements of the ladder can never drift: change a
 *  metre band and these move with it. Read by the debug readout and by the
 *  pins; the pick itself goes through `tierForProjected`. */
export const SCREEN_TIER_BANDS: readonly { tier: CreatureTier; below: number }[] =
  TIER_BANDS.map((b) => ({
    tier: b.tier,
    below: b.from > 0 ? projectedFraction(TIER_REF_BODY_M, b.from, TIER_REF_FOV_RAD) : Number.POSITIVE_INFINITY,
  }));

/** THE PROJECTED-SIZE PICK — the tier a body covering `fraction` of the
 *  viewport height earns, with the same hysteresis as the distance pick.
 *
 *  ⚖️ ONE LADDER, ONE HYSTERESIS RULE. Rather than a second table with a second
 *  margin, the fraction is converted back to the distance at which the
 *  REFERENCE body would look that size and handed to `steppedTier`. Three
 *  things fall out of that, all of them wanted:
 *   • at the walker's fov, for a walker-sized body, this IS `steppedTier` on
 *     the metre distance — bit for bit, at every band edge (the pin);
 *   • `hystM` becomes a fixed margin in SCREEN FRACTION, identical for a person
 *     and for an oak, which is what "don't flap on a boundary" means once the
 *     boundary is a size on screen;
 *   • there is no second table to fall out of step with `TIER_BANDS`. */
export function tierForProjected(
  fraction: number,
  prev: CreatureTier,
  hystM: number,
): CreatureTier {
  return steppedTier(TIER_BANDS, prev, refDistanceForFraction(fraction), hystM);
}

/** The projected-size SEED — a first sighting, no previous tier to hold (the
 *  `seedTier` of the screen ladder). */
export function seedTierForProjected(fraction: number): CreatureTier {
  return seedTier(TIER_BANDS, refDistanceForFraction(fraction));
}

/** The BUILD detail a view tier asks the creature builder for. ONE definition,
 *  because several factories must agree: the town factory, the no-town
 *  (wilderness) factory and the natural-body factory. The capsule tier
 *  REPLACES a body wholesale, so any skinned body still built under it — a
 *  fresh spawn mid-cross — takes the cheapest skinned form there is. */
export function detailForTier(t: CreatureTier | undefined): CreatureDetail {
  return t === "full" || t === undefined ? "full" : t === "simple" ? "simple" : "stick";
}
