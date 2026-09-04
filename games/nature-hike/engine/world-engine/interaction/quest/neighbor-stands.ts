// shared/world-engine/interaction/quest/neighbor-stands.ts
//
// ⚖️ #49 — THE NEIGHBOURING STANDS: a record tier for ground that was NEVER
// LOADED (neighboring-stands-round.md, Stage 1 — the MINT).
//
// ── THE GAP THIS CLOSES ───────────────────────────────────────────────────
//
// The abstract tier (`wild:area:` records) has only ever existed for ground
// that was once loaded: `home` is the fold of THIS session's scatter, and
// `farm-<siteKey>` is the town's own field. Nothing mints a record for the
// countryside beyond the manifold — so a site's supply enumeration
// (`siteMaterialSources`) sees exactly what stands inside its own near-stand
// disc, and on a sparsely-forested cell "everything within reach comes to N"
// is a true statement about a world that has a forest three hundred metres
// away. Construction deadlocks: the disc grows with `built`, building needs
// timber, timber is bounded by the disc.
//
// The consumption half already works end to end (`sourcesByLeg`,
// `siteMaterialSources`' region arm, `drawSourceShelf` → `drawWildArea`, the
// shelf haul, the refusal arithmetic — #44's live proof shipped it). What was
// missing was purely the MINT, and this file is it.
//
// ── THE SHAPE ─────────────────────────────────────────────────────────────
//
// One `WildAreaRecord` per WORLD-FIXED TILE of the ground around the site,
// keyed `wild:area:tile-<i>-<j>`, sized from THE SESSION'S OWN DENSITY MIX and
// condensed through THE SAME `condenseWildArea` a fold runs. The mint spawns
// NOTHING: the pseudo-features it deals are data handed to the condenser and
// are never session objects, never containers, never bodies.
//
// 🚨 MINTED ONLY FROM A `perHa` MIX, and that condition is the whole safety
// argument. A `perHa` line describes a COUNTRYSIDE — the extent is a free
// variable and the density is the truth — and those lines come from a cell's
// baked ecology, i.e. from a real planet whose streamed flora field is already
// standing the same forest at the same per-hectare law outside the boundary.
// That is exactly the condition the founding mount uses to decide whether to
// BOUND the near stand (`quest-host.ts`: `mix.some(e => e.perHa !== undefined)`),
// and it is the same question read from the other side: the country the disc
// declines to own is the country this file gives a record to.
//
// An absolute `count` mix is the opposite on both halves — the count IS a
// near-stand-sized number authored against a founding town's own rect, and its
// callers are the no-cell boots (a preset town, a flat test world, the headless
// harness) where there is no field out there at all. Those mint NOTHING, which
// is why every bench world is byte-identical BY CONSTRUCTION rather than by
// a flag somebody has to remember to pass.
//
// ── WHAT IS RECORDED AND NOT DONE (v1 residuals) ──────────────────────────
//
//  • UNIFORM DENSITY. Every tile is sized from the session's ONE mix, because
//    the session tier holds ONE `ClimateSample` and no CellGrid — no function
//    today samples a NEIGHBOURING cell at session tier (recon C). So the
//    countryside around a site is homogeneous at this radius, which is a fair
//    reading of 500 m of one biome and a lie at the scale where cells change.
//    Per-cell eco variation is the recorded residual; the seam is this
//    function's `mix` parameter and nothing else has to move.
//  • NO FAUNA. `buildWilderness` deals animal mix entries as CREATURES, and a
//    body with a mind is the streamer's business, never a stand (the fold's
//    own law — `foldWildArea` folds features and leaves creatures standing).
//    A neighbouring tile's herds are therefore not represented in any form.
//  • PERSISTENCE IS NOT HERE — and it is not a residual either (Stage 2,
//    2026-09-02). A minted record now survives a save through
//    `SerializedTownDeltas.areaRecords`, and NOTHING about that reaches this
//    file: the mint stayed a pure world fact, and the save works because the
//    installer is idempotent by key and the restore runs BEFORE it (quest-host
//    `makeQuestSession` wakes the durable index at session birth; `start()`
//    mints into what is left). A drawn-down tile is session state that
//    outranks the world fact, and the ordering is what says so.

import {
  buildWilderness, type WildMixEntry, type WildernessFeature,
} from "./wilderness.js";
import {
  condenseWildArea, wildAreaPopulation, type WildAreaRecord,
} from "./wild-area.js";
import { hashSeed } from "@shared/prng.js";

// ── The two numbers ───────────────────────────────────────────────────────

/**
 * THE TILE — 200 m square, 4 ha.
 *
 * 🚧 A NAMED STOPGAP, in this codebase's own convention (the `floor(log2(1+n))`
 * reach family): it is not derived from anything. What it IS chosen to match
 * is the driver's streamed flora field (`flora-field.ts` TILE 200 m / 4 ha,
 * world-fixed positions hashed from `(face, tx, ty, seed)`), so Stage 3's
 * render bridge — a tile that thins visibly as its record is drawn down —
 * has a natural unit and does not need a second quantization. The honest
 * derivation would come from the walk-budget family (`forageRadiusM`), which
 * lands at neither scale (the recorded mismatch).
 *
 * ⚖️ AND IT IS LOAD-BEARING FOR THE NO-DOUBLE-COUNT INVARIANT. The near stand
 * caps at `serviceRadiusM(scale,"hunger")` = 96 m at street clock, which is
 * strictly less than `NEIGHBOR_TILE_M / 2` = 100 — so the disc can never grow
 * out of tile (0,0)'s ground and into a ring-1 tile, and no tree is ever
 * represented twice (once as a standing container, once as record stock).
 * `neighbor-stands.test.ts` pins the inequality; moving this number without
 * moving that pin is how the double-count comes back.
 */
export const NEIGHBOR_TILE_M = 200;

/**
 * HOW FAR THE SITE'S NEIGHBOURHOOD REACHES — a tile is minted when its CENTRE
 * lies within this of the site's own centre (≈ two rings: 20 tiles at the
 * shipped 200 m tile).
 *
 * 🚧 ALSO A NAMED STOPGAP, and the more arbitrary of the two. The honest
 * number is a WALK BUDGET — how far a logging party can go and come back
 * inside the day the leg is priced at (`partnerLegSeconds` →
 * `dailyTravelM(scale)`) — and deriving it is the recorded work this round
 * did not do. 500 m is "far enough that a sparse cell is not a deadlock, near
 * enough that the tile count stays a rounding error in every sweep that
 * iterates `areaRecords`".
 */
export const NEIGHBOR_REACH_M = 500;

// ── The key grammar ───────────────────────────────────────────────────────

/**
 * 🔤 KEY GRAMMAR. `wild:area:<key>` is FROZEN (kernel/town/scope.ts
 * `WILD_AREA_PREFIX`); the tail is free, and `home` / `farm-<siteKey>` are the
 * precedent. A tile's tail is `tile-<i>-<j>` where i and j are SIGNED tile
 * offsets from the site's own tile — so a negative index spells a double
 * hyphen (`tile--1-0`), which the pattern below reads back unambiguously
 * because `-?\d+` is anchored on both sides of a literal separator.
 *
 * The key is the identity a Stage-2 persistence and a Stage-3 renderer both
 * join on, so it must be derivable from the tile alone and carry no session
 * state at all.
 */
export const neighborTileKey = (i: number, j: number): string => `tile-${i}-${j}`;

const NEIGHBOR_TILE_RE = /^tile-(-?\d+)-(-?\d+)$/;

/** Is this area key a MINTED NEIGHBOUR TILE? The predicate every reader that
 *  must treat the wild scatter differently from the town's own field asks —
 *  never a `startsWith` written out again at a call site. */
export function isNeighborTileKey(key: string): boolean {
  return NEIGHBOR_TILE_RE.test(key);
}

/** The tile a key names, or null when it names something else. */
export function neighborTileIndex(key: string): { i: number; j: number } | null {
  const m = NEIGHBOR_TILE_RE.exec(key);
  return m ? { i: Number(m[1]), j: Number(m[2]) } : null;
}

// ── The grid ──────────────────────────────────────────────────────────────

export interface NeighborGridOpts {
  /** Tile side, metres. Default `NEIGHBOR_TILE_M`. */
  tileM?: number;
  /** Mint radius, metres, measured to the tile CENTRE. Default `NEIGHBOR_REACH_M`. */
  reachM?: number;
}

/**
 * THE TILES IN REACH, in a deterministic order (i ascending, then j).
 *
 * 🚫 TILE (0,0) IS NEVER ONE OF THEM. That is the site's own ground: the near
 * stand stands there as REAL features and the `home` record folds there. A
 * tile record over it would be the same trees a second time — the one thing
 * the fold law forbids ("an area is loaded or condensed, never both").
 */
export function neighborTileOffsets(opts?: NeighborGridOpts): Array<{ i: number; j: number }> {
  const tileM = Math.max(1, opts?.tileM ?? NEIGHBOR_TILE_M);
  const reachM = Math.max(0, opts?.reachM ?? NEIGHBOR_REACH_M);
  const span = Math.floor(reachM / tileM);
  const out: Array<{ i: number; j: number }> = [];
  for (let i = -span; i <= span; i++) {
    for (let j = -span; j <= span; j++) {
      if (i === 0 && j === 0) continue; // the site's own ground — never minted
      if (Math.hypot(i * tileM, j * tileM) > reachM) continue;
      out.push({ i, j });
    }
  }
  return out;
}

/**
 * THE TILE'S TRUE RECT, in SESSION coordinates — centred on the grid whose
 * origin tile is centred on the site.
 *
 * 🚨 TRUE, NOT CLAMPED, AND THAT IS THE DELICATE SEAM. A ring-1 rect lies
 * partly and a ring-2 rect wholly OUTSIDE the session's walkable manifold, and
 * the record keeps the honest geometry: DISTANCE IS MEASURED TO THE RECT (so
 * ring 1 and ring 2 in the same direction rank differently and price different
 * legs), while FEET WALK TO A CLAMPED SHELF at the manifold's edge and the
 * priced leg delay covers the unwalked remainder. That is the
 * space-time-compression §6 model substitution — a seam may drop detail, never
 * conservation — and the split lives at the two named accessors over
 * `wildRectPointToward` (wild-area.ts), never in this rect.
 *
 * ⚖️ AND THE OVERLAP IS NOT A DOUBLE COUNT. The manifold's annulus beyond the
 * near-stand disc is DEAD GROUND in the sim: `buildWilderness`'s `keep`
 * post-filter never lays a feature there, `growNearStand` reveals only inside
 * the disc, and `wildAreaGround`'s fold rect is the disc's bounding SQUARE. So
 * where a ring-1 tile rect overlaps the manifold band from 100 m out to the
 * manifold edge, the tile record is the ONLY sim representation of that ground
 * — there is nothing there for it to double.
 */
export function neighborTileRect(
  center: { x: number; y: number },
  i: number,
  j: number,
  tileM: number = NEIGHBOR_TILE_M,
): { x: number; y: number; w: number; h: number } {
  return {
    x: center.x + i * tileM - tileM / 2,
    y: center.y + j * tileM - tileM / 2,
    w: tileM,
    h: tileM,
  };
}

// ── The mint ──────────────────────────────────────────────────────────────

export interface NeighborMintOpts extends NeighborGridOpts {
  /** THE SESSION'S OWN SCATTER MIX. Minting happens only when at least one
   *  line carries `perHa` (see the header). */
  mix: ReadonlyArray<WildMixEntry>;
  /** The site's own centre, session coordinates (`town.stage.center`). */
  center: { x: number; y: number };
  /** The session's scatter seed — every tile's own seed folds off it. */
  seed: number;
  /** Clock the records are quoted at (absolute taskClock seconds). */
  now: number;
}

/**
 * ⚖️ MINT THE NEIGHBOURING STANDS — pure, deterministic, allocating nothing in
 * the session. Returns one record per in-reach tile that actually stands
 * something; the caller installs them under their own keys.
 *
 * ⚖️ THE RECORD IS BUILT BY THE CONDENSE PATH, NOT BY HAND. A record's stands
 * must carry exactly the shape a fold produces — `byClass` / `stock` / `cap` /
 * `climbAt` / `regrowAt` with per-feature ROLLED yields — or the draw, the
 * growth walk and the ripen pulse would meet a second, subtly different
 * derivation. So the tile deals pseudo-features through the very scatter the
 * near stand is laid by (`buildWilderness`, which is also the one place that
 * resolves a `perHa` line against an extent: 4 ha × perHa, rounded) and puts
 * them through the very condenser `foldWildArea` calls
 * (`condenseWildArea`). Nothing here knows what a stand looks like.
 *
 * The features are FRESH, so they are MATURE AND STANDING (`makeFeature`
 * leaves `sizeClass`/`growAt` unset — the scatter's own default) and their
 * rolled kill stock sits at or above `killFloorOf`, so the condenser's
 * depletion inference books NO harvest direction: an untouched forest declares
 * no direction at all, which is the honest reading.
 *
 * 🚫 THE CREATURES ARE DROPPED. `buildWilderness` deals animal mix lines as
 * walking bodies, and a body is never folded (see the header's residual).
 */
export function mintNeighborStands(opts: NeighborMintOpts): WildAreaRecord[] {
  // 🚨 THE GATE — see the header. A count mix describes an authored stand, not
  // a countryside, and nothing outside its rect is drawn by anybody.
  if (!opts.mix.some((e) => e.perHa !== undefined)) return [];
  const tileM = Math.max(1, opts.tileM ?? NEIGHBOR_TILE_M);
  const out: WildAreaRecord[] = [];
  for (const { i, j } of neighborTileOffsets(opts)) {
    const key = neighborTileKey(i, j);
    const rect = neighborTileRect(opts.center, i, j, tileM);
    // ONE SEED PER TILE, folded off the session's own (the `@shared/prng`
    // hashSeed convention every other sub-stream uses). Same session seed ⇒
    // byte-identical records, and two tiles never share a draw.
    const seed = hashSeed(opts.seed, key);
    const laid = buildWilderness({
      seed,
      side: tileM,
      mix: opts.mix,
      creatures: 0, // wanderers are the streamer's, and nothing folds them
    });
    if (!laid.features.length) continue;
    // The scatter lays into ITS OWN square; the record's ground is the tile's
    // TRUE rect, so the features move with it. (`condenseWildArea` reads a
    // position only for the depletion-direction inference, which is 0 for a
    // fresh roll — but a record that named its ground in one frame and its
    // trees in another would be a trap for the first reader who used both.)
    const features: WildernessFeature[] = laid.features.map((f, n) => ({
      ...f,
      id: `wild:${f.species}_${key}.${n}`,
      x: rect.x + f.x,
      y: rect.y + f.y,
    }));
    const rec = condenseWildArea({ features, now: opts.now, area: rect, seed, key });
    // A tile whose mix rounds to nothing standing is not a source; minting it
    // would put an empty row in every sweep that iterates the records.
    if (wildAreaPopulation(rec) <= 0) continue;
    out.push(rec);
  }
  return out;
}
