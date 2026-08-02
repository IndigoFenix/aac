/**
 * build-ghosts.ts — WHERE THE BLOCKS ARE GOING (construction phase 6).
 *
 * A construction site was a rectangle with a clock on it. You could not tell,
 * looking at one, what was meant to stand there, how much of it was paid for,
 * or whether the thing was progressing at all — the only signal was that after
 * a while a building appeared. This module turns a site into a DRAWN PLAN: one
 * outline per piece, standing where the piece will stand.
 *
 * THE PIECES ARE THE BILL. Every outline is exactly one BAY of the same
 * `shellBill`/`annexBill` arithmetic that priced the order (block-bill.ts), so
 * the ghosts are not an illustration of the cost — they ARE the cost, laid out
 * in space. Count the outlines, and you have counted the blocks. Watch them
 * change colour, and you are watching the pile fill.
 *
 * THE ORDER IS THE BUILD ORDER — floor, then walls, then roof. It is what a
 * builder does, and it makes the fill legible: a site fills from the ground up,
 * so "how far along is this" is answerable from across the street without
 * reading a number.
 *
 * Kernel layering: pure geometry + arithmetic. No renderer types (the overlay
 * owns how a ghost is drawn), no session, no clock.
 */

import { BLOCKS_PER_BAY, baysAcross } from "./block-bill.js";

/** How a piece is faring. THE definition — the overlay re-exports it rather
 *  than declaring its own, because deciding the state is a kernel job and
 *  colouring it is a render one, and two copies of the union would drift. */
export type GhostState = "claimed" | "pending" | "blocked";

/** One unbuilt piece, in world coordinates. */
export interface GhostPiece {
  id: string;
  kind: "floor" | "roof" | "wall" | "furniture";
  /** Centre. */
  x: number;
  y: number;
  /** Extent across (`w`) and deep (`h`) in the piece's own frame — a wall's
   *  `w` is its run and `h` its thickness. */
  w: number;
  h: number;
  /** Run direction, GAME angle (0 = +x, π/2 = +y). Walls only. */
  facing?: number;
  /** Blocks this piece accounts for — what it subtracts from the pile as the
   *  fill walks the list. */
  blocks: number;
}

export interface GhostPieceState extends GhostPiece {
  state: GhostState;
}

const EDGE_THICKNESS = 0.4; // the engine's wallThickness — a ghost fills the wall's volume

/**
 * The bays of a building shell, in build order: floor grid, wall runs around
 * the perimeter, then the roof grid over the top.
 *
 * `skipWall` names an edge that is NOT built — an annex shares one wall with
 * the house it grows off, and drawing a ghost there would promise a wall that
 * is already standing (and inflate the count past the bill).
 */
export function shellGhostPieces(
  idPrefix: string,
  rect: { x: number; y: number; w: number; h: number },
  opts?: {
    /** Perimeter edges to leave out (an annex's shared wall). */
    skipWall?: ReadonlyArray<"north" | "south" | "east" | "west">;
    /** Draw no floor/roof — an interior partition builds neither. */
    wallsOnly?: boolean;
    /** Only these edges get walls (an interior cut: the one partition). */
    onlyWall?: ReadonlyArray<"north" | "south" | "east" | "west">;
  },
): GhostPiece[] {
  const across = baysAcross(rect.w);
  const deep = baysAcross(rect.h);
  const bw = rect.w / across;
  const bh = rect.h / deep;
  const out: GhostPiece[] = [];

  const grid = (kind: "floor" | "roof"): void => {
    for (let j = 0; j < deep; j++) {
      for (let i = 0; i < across; i++) {
        out.push({
          id: `${idPrefix}_${kind}_${i}_${j}`,
          kind,
          x: rect.x + (i + 0.5) * bw,
          y: rect.y + (j + 0.5) * bh,
          w: bw,
          h: bh,
          blocks: BLOCKS_PER_BAY[kind],
        });
      }
    }
  };

  if (!opts?.wallsOnly) grid("floor");

  const skip = new Set(opts?.skipWall ?? []);
  const only = opts?.onlyWall ? new Set(opts.onlyWall) : null;
  // Each edge, split into its own bays. Horizontal edges run along +x, vertical
  // ones along +y; a wall ghost is centred ON the boundary line, which is where
  // the real wall structure goes (engine.ts edgeStructures).
  const edges: Array<{
    edge: "north" | "south" | "east" | "west";
    n: number;
    at: (k: number) => { x: number; y: number; w: number; facing: number };
  }> = [
    {
      edge: "north", n: across,
      at: (k) => ({ x: rect.x + (k + 0.5) * bw, y: rect.y, w: bw, facing: 0 }),
    },
    {
      edge: "south", n: across,
      at: (k) => ({ x: rect.x + (k + 0.5) * bw, y: rect.y + rect.h, w: bw, facing: 0 }),
    },
    {
      edge: "west", n: deep,
      at: (k) => ({ x: rect.x, y: rect.y + (k + 0.5) * bh, w: bh, facing: Math.PI / 2 }),
    },
    {
      edge: "east", n: deep,
      at: (k) => ({ x: rect.x + rect.w, y: rect.y + (k + 0.5) * bh, w: bh, facing: Math.PI / 2 }),
    },
  ];
  for (const e of edges) {
    if (skip.has(e.edge)) continue;
    if (only && !only.has(e.edge)) continue;
    for (let k = 0; k < e.n; k++) {
      const p = e.at(k);
      out.push({
        id: `${idPrefix}_wall_${e.edge}_${k}`,
        kind: "wall",
        x: p.x,
        y: p.y,
        w: p.w,
        h: EDGE_THICKNESS,
        facing: p.facing,
        blocks: BLOCKS_PER_BAY.wall,
      });
    }
  }

  if (!opts?.wallsOnly) grid("roof");
  return out;
}

export type GhostEdge = "north" | "south" | "east" | "west";

const EDGE_MIDS = (r: { x: number; y: number; w: number; h: number }): Array<{
  edge: GhostEdge;
  x: number;
  y: number;
}> => [
  { edge: "north", x: r.x + r.w / 2, y: r.y },
  { edge: "south", x: r.x + r.w / 2, y: r.y + r.h },
  { edge: "west", x: r.x, y: r.y + r.h / 2 },
  { edge: "east", x: r.x + r.w, y: r.y + r.h / 2 },
];

/**
 * Which edge of `rect` faces `host` — the wall an ANNEX shares with the
 * building it grows off, and therefore the one wall it does not build.
 *
 * Derived from the geometry rather than from `AnnexSide`, on purpose: the side
 * is recorded in the DOOR-LOCAL frame (rear/side0/side1 — construction.ts),
 * which maps to a compass edge only through the host's door orientation, and a
 * ghost drawn on the wrong edge is worse than none. The rects are already in
 * world coordinates by the time anything wants to draw them, and "the edge
 * closest to the thing I am attached to" needs no frame at all.
 */
export function sharedEdgeWith(
  rect: { x: number; y: number; w: number; h: number },
  host: { x: number; y: number; w: number; h: number },
): GhostEdge {
  const hx = host.x + host.w / 2;
  const hy = host.y + host.h / 2;
  let best = EDGE_MIDS(rect)[0]!;
  let bestD = Infinity;
  for (const m of EDGE_MIDS(rect)) {
    const d = Math.hypot(m.x - hx, m.y - hy);
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return best.edge;
}

/**
 * The edges of `cut` that are NOT flush with `host` — an INTERIOR cut's
 * partition, and nothing else. The guillotine law (construction.ts
 * InteriorSpec) puts the new room flush against its host on three sides, so
 * exactly one edge is new; a degenerate case that finds several returns them
 * all rather than guessing.
 */
export function freeEdgesOf(
  cut: { x: number; y: number; w: number; h: number },
  host: { x: number; y: number; w: number; h: number },
  eps = 0.05,
): GhostEdge[] {
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= eps;
  const out: GhostEdge[] = [];
  if (!near(cut.y, host.y)) out.push("north");
  if (!near(cut.y + cut.h, host.y + host.h)) out.push("south");
  if (!near(cut.x, host.x)) out.push("west");
  if (!near(cut.x + cut.w, host.x + host.w)) out.push("east");
  return out;
}

/**
 * COLOUR THE PLAN from how far the materials have got.
 *
 * `staged` blocks are walked down the list in build order: everything they
 * cover is `claimed` (that material exists and is spoken for), and the first
 * piece they cannot cover in full is where the site actually is. What is left
 * is `pending` while any chain is running that could produce more, and
 * `blocked` when nothing reachable can — the honest read of a starved site,
 * and the only state that asks the player for anything.
 *
 * A piece is claimed only when the pile covers it WHOLE. A half-paid bay is
 * still not built, and showing it blue would say the material is there.
 */
export function paintGhosts(
  pieces: readonly GhostPiece[],
  opts: {
    /** Blocks staged at the site (its pile), plus anything reserved inbound. */
    staged: number;
    /** Is a supply chain running for the rest (hauls posted, blocks milling)? */
    supplying: boolean;
    /** Pieces that cannot be built at all right now, whatever the pile holds —
     *  a furniture spot with nowhere legal to stand. Always `blocked`. */
    blocked?: ReadonlySet<string>;
  },
): GhostPieceState[] {
  let left = Math.max(0, opts.staged);
  const rest: GhostState = opts.supplying ? "pending" : "blocked";
  return pieces.map((p) => {
    if (opts.blocked?.has(p.id)) return { ...p, state: "blocked" as const };
    if (left >= p.blocks) {
      left -= p.blocks;
      return { ...p, state: "claimed" as const };
    }
    return { ...p, state: rest };
  });
}
