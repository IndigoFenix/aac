// CREATURE VIEW TIERS — the distance ladder, and nothing else.
//
// A body's fidelity is a RENDER-ONLY, PER-CAMERA choice: each client picks it
// from ITS OWN camera, so in multiplayer every peer dresses the same replicated
// bodies at its own fidelity and no tier state ever rides the wire or feeds the
// sim. (LAW — see planning-docs/games/world-engine/view-distance-lod-tiers.md.)
//
// Two ladders run this table:
//   • the PER-BODY band (quest-host), measured from the local camera focus to
//     each body — the one that matters once the camera is inside a town;
//   • the coarse TOWN clamp (the driver in main.ts), measured to the town
//     centre — the orbit/approach clamp. The EFFECTIVE tier is the coarser.
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

/** Coarseness order — the EFFECTIVE tier of two ladders is the higher rank. */
export const TIER_RANK: Record<CreatureTier, number> = { full: 0, simple: 1, stick: 2, capsule: 3 };

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

/** The BUILD detail a view tier asks the creature builder for. ONE definition,
 *  because several factories must agree: the town factory, the no-town
 *  (wilderness) factory and the natural-body factory. The capsule tier
 *  REPLACES a body wholesale, so any skinned body still built under it — a
 *  fresh spawn mid-cross — takes the cheapest skinned form there is. */
export function detailForTier(t: CreatureTier | undefined): CreatureDetail {
  return t === "full" || t === undefined ? "full" : t === "simple" ? "simple" : "stick";
}
