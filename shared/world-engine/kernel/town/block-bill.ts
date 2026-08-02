/**
 * block-bill.ts — HOW MANY BLOCKS A THING COSTS, derived from its GEOMETRY
 * instead of hand-authored per catalog row (construction phase 6).
 *
 * THE COMPLAINT this answers: a house cost 3 blocks. A block is meant to be
 * the smallest meaningful unit of material construction, so three of them
 * cannot be a building — you could carry a whole house in two trips. The bill
 * has to come from the SIZE of what is being built, or every new structure
 * needs someone to guess a number for it, and the guesses never agree.
 *
 * ── THE BAY ────────────────────────────────────────────────────────────────
 * The engine has NO construction grid: footprints are arbitrary metres
 * (`StructureSpec.footprint`), rooms are continuous float rects from a
 * guillotine subdivision (rooms.ts), walls are one structure per uninterrupted
 * run (engine.ts buildingStructures), and floors/roofs are single render slabs.
 * There is no tile to bill per, so this module DEFINES one:
 *
 *   A BAY is `BUILD_BAY_M` metres square — one storey tall, one bay along the
 *   run. It is the timber-framer's bay, not a rendered object: nothing is
 *   snapped to it and no geometry changes. It exists only to be COUNTED.
 *
 * Every surface is then billed the same way — `BLOCKS_PER_BAY` blocks per bay
 * of floor, of roof, and of wall face. A 9×8 m cottage is 3×3 bays of floor
 * (36), the same of roof (36), and 12 bays of wall around its perimeter (48):
 * 120 blocks, against the 3 it used to cost.
 *
 * ── THE KNOBS ──────────────────────────────────────────────────────────────
 * `BUILD_BAY_M` and `BLOCKS_PER_BAY` are the only two numbers. Halving the bay
 * quadruples every floor and roof bill; changing a `BLOCKS_PER_BAY` entry
 * moves one surface. Everything downstream — the catalog, annexes, partitions,
 * the demolition refund, the ghost outlines the builder sees — reads through
 * this module, so the whole economy moves together and cannot drift.
 *
 * TUNED AGAINST THE RAW YIELDS, not in isolation: `inPerOut` raws per block
 * (products.ts) means a cottage is 240 wood, so the tree a block chain starts
 * at has to be worth felling. Move a knob here and the yields want a look.
 *
 * Kernel layering: pure arithmetic. Imports one glyph constant and nothing
 * else, so every layer above (catalog, director, renderer) can read it.
 */

import { BLOCK_GLYPH } from "../../products.js";

/**
 * THE BLOCK, as a physical object — what one unit looks like in a pair of
 * hands and stacked on a site. A squared unit roughly 0.8 × 0.4 × 0.4 m: a
 * dressed stone or a sawn baulk, heavy enough to read as construction material
 * and small enough that a body can carry one. The renderer's `block` recipe
 * (object-models.ts) is built to these proportions; the numbers live HERE
 * because the same unit is what the bill counts.
 */
export const BLOCK_SIZE_M = { l: 0.8, w: 0.4, h: 0.4 } as const;

/** The bay: metres of floor/roof square, and metres of wall run per storey. */
export const BUILD_BAY_M = 3;

/** Blocks per bay, per surface. Walls carry the same as the flat surfaces —
 *  a wall bay is a whole storey of face, so it is genuinely more material per
 *  square metre, which is why walls dominate a small building's bill. */
export const BLOCKS_PER_BAY: Readonly<Record<"floor" | "roof" | "wall", number>> = {
  floor: 4,
  roof: 4,
  wall: 4,
};

/** A bill, itemized — the ghost overlay draws one outline per bay, so it needs
 *  the parts and not just the sum. */
export interface BlockBill {
  /** Bays of each surface (COUNTS OF BAYS, not of blocks). */
  floorBays: number;
  roofBays: number;
  wallBays: number;
  /** Blocks, per surface and in total. */
  floor: number;
  roof: number;
  wall: number;
  total: number;
}

/** Bays spanning a run of `m` metres — at least one (any real wall is a bay,
 *  however short). The epsilon keeps a 9.000000001 m edge from buying a
 *  fourth bay off float noise. */
export function baysAcross(m: number): number {
  return Math.max(1, Math.ceil(m / BUILD_BAY_M - 1e-9));
}

function billOf(floorBays: number, roofBays: number, wallBays: number): BlockBill {
  const floor = floorBays * BLOCKS_PER_BAY.floor;
  const roof = roofBays * BLOCKS_PER_BAY.roof;
  const wall = wallBays * BLOCKS_PER_BAY.wall;
  return { floorBays, roofBays, wallBays, floor, roof, wall, total: floor + roof + wall };
}

/**
 * A WHOLE BUILDING from its footprint: every storey gets a floor, the top one
 * gets the roof, and the perimeter is walled on every storey.
 */
export function shellBill(
  footprint: { w: number; h: number },
  floors = 1,
): BlockBill {
  const n = Math.max(1, Math.floor(floors));
  const across = baysAcross(footprint.w);
  const deep = baysAcross(footprint.h);
  const perStorey = across * deep;
  // One roof, however many storeys — a second floor buys another slab of
  // FLOOR, not another roof.
  return billOf(perStorey * n, perStorey, 2 * (across + deep) * n);
}

/**
 * AN ANNEX — a room bolted onto a standing building. It brings its own floor
 * and roof, and walls on every side BUT the one it shares with the house: the
 * shared wall is already standing (the annex cuts a door through it, which is
 * why `doorInto` exists). Which side that is comes off `AnnexSide` in the
 * door-local frame — `rear` shares its full `u` extent, a flank shares `v`.
 */
export function annexBill(a: {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  side: "rear" | "side0" | "side1";
}): BlockBill {
  const w = Math.abs(a.u1 - a.u0);
  const h = Math.abs(a.v1 - a.v0);
  const across = baysAcross(w);
  const deep = baysAcross(h);
  const shared = a.side === "rear" ? across : deep;
  return billOf(across * deep, across * deep, 2 * (across + deep) - shared);
}

/**
 * AN INTERIOR CUT — a partition dropped across a standing room's floor. No new
 * floor, no new roof, no new outer wall: the ONE thing built is the partition
 * itself, flush on three sides (the guillotine law, construction.ts
 * InteriorSpec). Its length is the free span — the extent the cut runs along.
 *
 * This is what makes subdividing a shell dramatically cheaper than annexing
 * onto it, which is correct and was invisible while both cost one block.
 */
export function partitionBill(a: {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}): BlockBill {
  const w = Math.abs(a.u1 - a.u0);
  const h = Math.abs(a.v1 - a.v0);
  // The partition runs along the LONGER of the two spans — a guillotine cut
  // takes a band off the host, and the cut line is the band's long edge.
  return billOf(0, 0, baysAcross(Math.max(w, h)));
}

/**
 * A FURNITURE PIECE, from its footprint radius (stations.ts FURNITURE_ITEMS).
 * A chair is a block, a table is five; nothing is free, because "furniture is
 * made of blocks too" is the same law the walls follow. Deliberately derived
 * rather than authored per kind, for the catalog's reason: a new station kind
 * gets a sane bill the moment it declares a radius.
 */
export function furnitureBlocks(radius: number): number {
  return Math.max(1, Math.round(radius * 6));
}

/** A bill (or a bare block count) as a costs map the whole construction
 *  machinery already speaks — `missingCosts`, `resolveMaterials`, a
 *  `FoundedBuilding.costs` row. */
export function blockCosts(bill: BlockBill | number): Record<string, number> {
  return { [BLOCK_GLYPH]: typeof bill === "number" ? bill : bill.total };
}
