// shared/world-engine/interaction/quest/wild-area.ts
//
// ⚖️ THE WILD AREA — a resource source in CLOSED FORM, with the scattered
// features as its RENDERER (S&D S4; feedback_world_size_resource_realism).
//
// USER LAW (2026-08-12, verbatim): *"forested or farm areas don't need to be
// rendered to be used as resource sources — like artificial structures,
// natural structures can be offloaded. Their resource population and harvest
// state can be stored as numbers and loaded as needed (note that trees grow
// and larger trees will typically be cut first). The direction or directions
// they are harvested from should probably be conserved though, so that when
// they are loaded their gradient is thinner near the places harvesting them."*
// And the addendum: *"treat wilderness areas as a type of RENDERER for a
// resource's source, treated the same as a storeroom, shop or city."*
//
// ── WHAT THIS IS ──────────────────────────────────────────────────────────
// The condensed-twin doctrine (`stockAbstractPartner`'s, scope-ledger audit
// §4) applied to nature: ONE endpoint, two forms.
//
//   loaded    scattered `WildernessFeature`s — real objects, real container
//             stacks, the ordinary take path (wilderness.ts)
//   unloaded  a `WildAreaRecord` — per-species counts by size class, harvest
//             state and capacity as numbers, the growth/regrow clocks as
//             numbers, and the harvest-DIRECTION gradient
//
// `condenseWildArea` folds the first into the second; `expandWildArea` deals
// the second back out. Both are PURE and DETERMINISTIC, and both CONSERVE
// EXACTLY: the units in a record equal the units in the features it came
// from, to the unit, per glyph (`wildAreaStock`). That is the LOD-fold law —
// ceasing to be simulated FOLDS, it never evaporates (population.ts
// demote/promote is the precedent this copies).
//
// 🚨 WHAT IS *NOT* CONSERVED, deliberately: WHERE each tree stands. A record
// keeps counts, state and directions — never positions. Re-expanding lays the
// stand out again from the record's own seed, so a forest you walked away
// from and came back to has the same trees holding the same wood in the same
// size classes, arranged afresh with the harvested side thinner. Under the
// law that IS the model ("their resource population and harvest state can be
// stored as numbers"); a renderer that had to remember every trunk would not
// be a renderer.
//
// ⚖️ GROWTH IS PRODUCTION, NOT A CONSERVATION BREAK. An unloaded stand keeps
// growing (`advanceWildArea`, the same class clock `dueGrowthAdvance` walks
// while loaded). Fold and expand at the SAME clock are exactly equal; time
// passing in between adds wood the same way it would have with the trees in
// view, which is the whole point of offloading a forest rather than freezing
// it.

import {
  growthClassYield, naturalSourceOf,
  type NaturalProduct, type NaturalSource,
} from "../../products.js";
import {
  wildFeatureContainerId, type WildernessFeature,
} from "./wilderness.js";
import {
  registerFoldCodec,
  type FoldCodec, type FoldCtx, type FoldRecord, type FoldRefusal,
} from "../../kernel/town/fold.js";
// ⚖️ F5 — the draw runs on the ONE take primitive every other endpoint uses
// (head-matched, facted variants in stable order), and the source answers as an
// ordinary `StockEndpoint` so a leg to it needs no second execution path.
import { stackHead, takeStock, type StockEndpoint } from "../../kernel/town/transfer.js";
// ⚖️ F5 — ONE serviceability predicate for standing legs, shared with the town
// codec (see its own doc in barter.ts: the fact is about the leg and the scope
// it is booked against, not about towns).
import { standingLegServiced } from "../../kernel/town/barter.js";
import { parseScopeId, wildAreaId, type ScopeId } from "../../kernel/town/scope.js";

// ── The record ────────────────────────────────────────────────────────────

/** How many compass sectors the harvest-direction gradient keeps. Eight is
 *  the board's own direction vocabulary (N/NE/E/…), which is also the
 *  coarsest histogram that can still say "they came from the south-west". */
export const WILD_DRAW_SECTORS = 8;

/** ONE SPECIES' STAND, condensed. Everything here is numbers — the population
 *  by size class, what it holds, what it can hold, and the clocks. */
export interface WildStand {
  species: string;
  /** Sources standing, by growth-class index (`NaturalSource.growth.classes`).
   *  A species with no growth clock has ONE bucket (index 0) holding its whole
   *  population — "stone stays finite" needs no size story. Σ = population. */
  byClass: number[];
  /** HARVEST STATE — units standing across the whole stand, by glyph. */
  stock: Record<string, number>;
  /** Live-bearing capacity across the stand, by glyph (regrowth's ceiling). */
  cap: Record<string, number>;
  /** GROWTH CLOCKS — one absolute deadline per source still climbing, with the
   *  class it climbs FROM. Sorted (class, then deadline) so a fold is
   *  byte-stable. */
  climbAt: { cls: number; at: number }[];
  /** REGROW CLOCKS — glyph → absolute deadlines, one per source below its own
   *  bearing capacity. Sorted ascending. */
  regrowAt: Record<string, number[]>;
}

/**
 * AN OFFLOADED WILD AREA. The endpoint id is `wild:area:<key>`
 * (kernel/town/scope.ts `WILD_AREA_PREFIX`) — the same grammar the standing
 * sources speak, because they are the same endpoint in two forms.
 */
export interface WildAreaRecord {
  /** Area key (the id's tail — `wild:area:<key>`). */
  key: string;
  /** The ground the stand occupies, in session coordinates. */
  area: { x: number; y: number; w: number; h: number };
  /** Placement seed — the record re-lays its own renderer deterministically. */
  seed: number;
  /** Clock (absolute taskClock seconds) this record's state is quoted at. */
  at: number;
  stands: WildStand[];
  /**
   * ⚖️ THE HARVEST-DIRECTION GRADIENT, conserved (the user's own clause).
   * Weight per compass sector (index 0 = +x, counter-clockwise), accumulated
   * from WHERE the units were taken: sources that lost stock sit on the side
   * the harvesters came from. On expand the stand is laid out THINNER toward
   * the heavy sectors — the wood nearest the town is the wood already cut.
   */
  draw: number[];
}

/** Every unit an offloaded area holds, by glyph — the read side of the
 *  record, and what the session's conservation audit counts while the trees
 *  are not standing. */
export function wildAreaStock(rec: WildAreaRecord): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of rec.stands) {
    for (const [g, n] of Object.entries(s.stock)) {
      if (n > 0) out[g] = (out[g] ?? 0) + n;
    }
  }
  return out;
}

/** Population by species and size class — the "how much forest is left"
 *  question, answerable without loading a single tree. */
export function wildAreaCounts(rec: WildAreaRecord): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const s of rec.stands) out[s.species] = [...s.byClass];
  return out;
}

/** How many sources stand in the whole area. */
export function wildAreaPopulation(rec: WildAreaRecord): number {
  return rec.stands.reduce((n, s) => n + s.byClass.reduce((a, b) => a + b, 0), 0);
}

// ── Fold ──────────────────────────────────────────────────────────────────

/** The class count a species answers to (1 for a growth-less source). */
function classCountOf(species: string): number {
  return naturalSourceOf(species)?.growth?.classes.length ?? 1;
}

/** A feature's class index, defaulting to MATURE exactly as the live readers
 *  do (`wildFeatureSizeRank`: unset `sizeClass` = the catalogue's last class,
 *  because that is what the scatter lays down). */
function classOf(f: Pick<WildernessFeature, "species" | "sizeClass">): number {
  const n = classCountOf(f.species);
  return Math.max(0, Math.min(n - 1, f.sizeClass ?? n - 1));
}

/**
 * THE SMALLEST KILL STOCK A FRESH SOURCE OF THIS SIZE COULD HOLD — the floor
 * below which a standing source has CERTAINLY been drawn from.
 *
 * 🚨 Not the species MAXIMUM (`wildFeatureRadius`'s denominator, right for
 * "how big does this look" and wrong here): every feature rolls somewhere in
 * `[min, max]`, so measuring against the max reports a fresh, untouched
 * forest as harvested from every direction at once — a gradient out of pure
 * roll noise. Measuring against the MINIMUM can only under-report, which is
 * the honest direction for evidence: a stand nobody has touched declares no
 * direction at all.
 */
function killFloorOf(species: string, cls: number): number {
  const src = naturalSourceOf(species);
  const mul = src?.growth ? src.growth.classes[cls]?.yieldMul ?? 1 : 1;
  let n = 0;
  for (const p of src?.products ?? []) {
    if (p.method === "kill") n += Math.round(p.yield.min * mul);
  }
  return n;
}

/** Units of kill stock left standing in one feature. */
function killLeft(species: string, stock: Readonly<Record<string, number>>): number {
  const src = naturalSourceOf(species);
  let n = 0;
  for (const p of src?.products ?? []) if (p.method === "kill") n += stock[p.glyph] ?? 0;
  return n;
}

/** Which sector a direction falls in (index 0 = +x, counter-clockwise). */
export function wildDrawSectorOf(dx: number, dy: number): number {
  const a = Math.atan2(dy, dx);
  const turn = (a < 0 ? a + Math.PI * 2 : a) / (Math.PI * 2);
  return Math.min(WILD_DRAW_SECTORS - 1, Math.floor(turn * WILD_DRAW_SECTORS));
}

/**
 * ⚖️ THE ONE HARVEST-DIRECTION RECORDING — the user's *"the direction or
 * directions they are harvested from should probably be conserved"* clause,
 * written once for BOTH readings of a draw:
 *
 *   · `condenseWildArea` INFERS one from the depletion it finds standing (a
 *     source that has lost units is a source somebody walked to);
 *   · `drawWildArea` BOOKS one it was told (a source draw knows exactly who came
 *     for it and from where).
 *
 * Weight is UNITS TAKEN either way, and the vector is from the area's CENTRE
 * toward the harvesters — so the two readings accumulate into one histogram
 * that `expandWildArea` thins the stand against. Dead centre names no
 * direction and books nothing. Mutates `draw` (the caller owns the array).
 */
export function addWildDraw(draw: number[], dx: number, dy: number, units: number): void {
  if (!(units > 0)) return;
  if (dx === 0 && dy === 0) return;
  const s = wildDrawSectorOf(dx, dy);
  draw[s] = (draw[s] ?? 0) + units;
}

/** What the fold needs from the live session: the stack standing in each
 *  source right now (the host's `containerStock`, never the initial roll). */
export interface WildFoldInput {
  features: readonly WildernessFeature[];
  /** Live stack of one feature, by its CONTAINER id (`wildFeatureContainerId`
   *  — a body id when embodied). Absent ⇒ the feature's own recorded stock. */
  liveStock?(containerId: string): Readonly<Record<string, number>> | undefined;
  /** Clock the fold is taken at (absolute taskClock seconds). */
  now: number;
  area: { x: number; y: number; w: number; h: number };
  seed: number;
  key: string;
  /** The record this area folded to LAST time, when there is one — its
   *  gradient is carried forward, because a direction harvested a year ago is
   *  still the direction the thin side faces. */
  prev?: WildAreaRecord | null;
}

/**
 * ⚖️ FOLD — the standing sources become the record. Conserves every unit:
 * `wildAreaStock(condenseWildArea(x))` equals the sum of the live stacks that
 * went in, per glyph, exactly.
 */
export function condenseWildArea(input: WildFoldInput): WildAreaRecord {
  const stands = new Map<string, WildStand>();
  const draw = [...(input.prev?.draw ?? new Array<number>(WILD_DRAW_SECTORS).fill(0))];
  const cx = input.area.x + input.area.w / 2;
  const cy = input.area.y + input.area.h / 2;
  // Species order = FIRST APPEARANCE in the feature list, so the same scatter
  // always folds to the same record (and re-expands to the same stand).
  for (const f of input.features) {
    let st = stands.get(f.species);
    if (!st) {
      st = {
        species: f.species,
        byClass: new Array<number>(classCountOf(f.species)).fill(0),
        stock: {},
        cap: {},
        climbAt: [],
        regrowAt: {},
      };
      stands.set(f.species, st);
    }
    const cls = classOf(f);
    st.byClass[cls] = (st.byClass[cls] ?? 0) + 1;
    const live = input.liveStock?.(wildFeatureContainerId(f)) ?? f.stock;
    for (const [g, n] of Object.entries(live)) {
      if (n > 0) st.stock[g] = (st.stock[g] ?? 0) + n;
    }
    for (const [g, n] of Object.entries(f.harvestCap ?? {})) {
      if (n > 0) st.cap[g] = (st.cap[g] ?? 0) + n;
    }
    if (f.growAt !== undefined) st.climbAt.push({ cls, at: f.growAt });
    for (const [g, at] of Object.entries(f.regrowAt ?? {})) {
      (st.regrowAt[g] ??= []).push(at);
    }
    // ⚖️ THE DIRECTION, from the DEPLETION ITSELF — no new call site, no live
    // accumulator to keep in step. A source that has lost units is a source
    // somebody walked to, so the vector from the area's centre to it, weighted
    // by what it lost, IS the direction the harvesters came from.
    const taken = Math.max(0, killFloorOf(f.species, cls) - killLeft(f.species, live));
    addWildDraw(draw, f.x - cx, f.y - cy, taken);
  }
  for (const st of stands.values()) {
    st.climbAt.sort((a, b) => a.cls - b.cls || a.at - b.at);
    for (const g of Object.keys(st.regrowAt)) st.regrowAt[g]!.sort((a, b) => a - b);
  }
  return {
    key: input.key,
    area: { ...input.area },
    seed: input.seed,
    at: input.now,
    stands: [...stands.values()],
    draw,
  };
}

// ── Unfold ────────────────────────────────────────────────────────────────

/** Deterministic placement RNG — the scatter's own mulberry32. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable numeric seed for a string (FNV-1a — the flora-twin convention). */
function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * SPLIT `total` INTO `weights.length` WHOLE UNITS in proportion to `weights`,
 * losing nothing. Largest-remainder, ties to the earlier index — the exactness
 * the conservation law needs (a floor-and-hope deal-out is how a fold quietly
 * eats a unit per glyph per cycle).
 */
export function dealUnits(total: number, weights: readonly number[]): number[] {
  const n = weights.length;
  const out = new Array<number>(n).fill(0);
  if (n === 0 || total <= 0) return out;
  const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  // No weight anywhere (a stand of saplings holding fruit): spread evenly, so
  // the units still land somewhere rather than piling onto index 0.
  const w = sum > 0 ? weights.map((x) => Math.max(0, x)) : new Array<number>(n).fill(1);
  const wsum = sum > 0 ? sum : n;
  const rema: { i: number; r: number }[] = [];
  let given = 0;
  for (let i = 0; i < n; i++) {
    const exact = (total * w[i]!) / wsum;
    const whole = Math.floor(exact);
    out[i] = whole;
    given += whole;
    rema.push({ i, r: exact - whole });
  }
  rema.sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; given < total; k++, given++) out[rema[k % n]!.i]! += 1;
  return out;
}

export interface WildUnfoldInput {
  rec: WildAreaRecord;
  /** Feature id for the `i`-th source of a species — the caller owns the id
   *  vocabulary (`wild:<species>_<n>`). Default: the scatter's own spelling. */
  idOf?(species: string, index: number): string;
  /** Keep-clear disc (a town's plaza — the scatter's own `clearAt`/`clearR`). */
  clearAt?: { x: number; y: number };
  clearR?: number;
}

/** How hard the gradient bites: at full weight, the harvested edge of the
 *  stand keeps ~1/4 of the density the far edge does. Not zero — a logged
 *  wood is thinner, never a clearing with a hard line through it. */
const WILD_GRADIENT_STRENGTH = 0.75;

/**
 * ⚖️ UNFOLD — the record deals its sources back out, THINNER TOWARD THE
 * HARVESTERS (the user's clause). Conserves every unit: the features returned
 * hold exactly `wildAreaStock(rec)`, per glyph.
 *
 * Deterministic in the record alone: same record ⇒ same features, same
 * positions, same stocks, same clocks.
 */
export function expandWildArea(input: WildUnfoldInput): WildernessFeature[] {
  const { rec } = input;
  const out: WildernessFeature[] = [];
  const maxDraw = rec.draw.reduce((a, b) => Math.max(a, b), 0);
  const cx = rec.area.x + rec.area.w / 2;
  const cy = rec.area.y + rec.area.h / 2;
  const halfSpan = Math.max(1e-3, Math.hypot(rec.area.w, rec.area.h) / 2);
  const clearR = Math.max(0, input.clearR ?? 0);
  const clearAt = input.clearAt;

  /** THE GRADIENT, as an acceptance probability. A candidate deep in a heavily
   *  harvested sector is the least likely place a tree is still standing; the
   *  area's middle is barely touched either way, because the harvesters
   *  reached the near edge first. */
  const keepChance = (x: number, y: number): number => {
    if (maxDraw <= 0) return 1;
    const dx = x - cx;
    const dy = y - cy;
    const r = Math.hypot(dx, dy);
    if (r <= 1e-6) return 1;
    const w = (rec.draw[wildDrawSectorOf(dx, dy)] ?? 0) / maxDraw;
    const depth = Math.min(1, r / halfSpan);
    return Math.max(0.05, 1 - WILD_GRADIENT_STRENGTH * w * depth);
  };

  for (const st of rec.stands) {
    const pop = st.byClass.reduce((a, b) => a + b, 0);
    if (pop <= 0) continue;
    const rng = mulberry((rec.seed >>> 0) ^ hashSeed(st.species));
    // CLASSES in order (saplings first), so the i-th feature's class is a
    // function of the record alone.
    const classes: number[] = [];
    st.byClass.forEach((n, cls) => {
      for (let i = 0; i < n; i++) classes.push(cls);
    });
    // KILL STOCK follows the size story: a sapling holds a sapling's worth of
    // wood, a mature trunk a trunk's worth (`growthClassYield`'s own ratio) —
    // and the totals still come out to the unit, which is what makes "larger
    // trees are cut first" survive a fold.
    const growth = naturalSourceOf(st.species)?.growth;
    const classWeight = classes.map((c) => (growth ? growth.classes[c]?.yieldMul ?? 0 : 1));
    const killGlyphs = new Set(
      (naturalSourceOf(st.species)?.products ?? [])
        .filter((p) => p.method === "kill")
        .map((p) => p.glyph),
    );
    const share: Record<string, number[]> = {};
    for (const [g, n] of Object.entries(st.stock)) {
      share[g] = dealUnits(n, killGlyphs.has(g) ? classWeight : classes.map(() => 1));
    }
    const capShare: Record<string, number[]> = {};
    for (const [g, n] of Object.entries(st.cap)) {
      capShare[g] = dealUnits(n, classes.map(() => 1));
    }
    // CLOCKS deal out to the features they belong to: a climb deadline to a
    // source of the class it climbs from, a regrow deadline to a source that
    // is actually below its own bearing capacity.
    const climbLeft = st.climbAt.map((c) => ({ ...c }));
    const regrowLeft: Record<string, number[]> = {};
    for (const [g, list] of Object.entries(st.regrowAt)) regrowLeft[g] = [...list];

    for (let i = 0; i < pop; i++) {
      const cls = classes[i]!;
      // Rejection-sample the position against the gradient; a stubborn
      // candidate lands anyway after a bounded number of tries (the scatter's
      // own 12, so a dense forest never spins).
      let x = 0;
      let y = 0;
      for (let tries = 0; tries < 12; tries++) {
        x = rec.area.x + rng() * rec.area.w;
        y = rec.area.y + rng() * rec.area.h;
        if (clearAt && Math.hypot(x - clearAt.x, y - clearAt.y) < clearR) continue;
        if (rng() <= keepChance(x, y)) break;
      }
      const stock: Record<string, number> = {};
      for (const [g, list] of Object.entries(share)) {
        const n = list[i] ?? 0;
        if (n > 0) stock[g] = n;
      }
      const f: WildernessFeature = {
        id: input.idOf?.(st.species, i) ?? `wild:${st.species}_${i}`,
        species: st.species,
        x,
        y,
        stock,
      };
      const cap: Record<string, number> = {};
      for (const [g, list] of Object.entries(capShare)) {
        const n = list[i] ?? 0;
        if (n > 0) cap[g] = n;
      }
      if (Object.keys(cap).length) f.harvestCap = cap;
      // A class the scatter would have laid down MATURE stays unset, exactly
      // as `makeFeature` leaves it — so a never-harvested forest folds and
      // unfolds to features byte-identical in state to a fresh scatter's.
      if (growth && cls !== growth.classes.length - 1) f.sizeClass = cls;
      const ci = climbLeft.findIndex((c) => c.cls === cls);
      if (ci >= 0) {
        f.growAt = climbLeft[ci]!.at;
        climbLeft.splice(ci, 1);
      }
      for (const g of Object.keys(regrowLeft)) {
        const list = regrowLeft[g]!;
        if (!list.length) continue;
        if ((stock[g] ?? 0) >= (cap[g] ?? 0)) continue; // full: no clock runs
        (f.regrowAt ??= {})[g] = list.shift()!;
      }
      out.push(f);
    }
  }
  return out;
}

// ── The clock, while nobody is looking ────────────────────────────────────

/**
 * ⚖️ AN UNLOADED STAND STILL GROWS. The same class clock `dueGrowthAdvance`
 * walks on a standing feature, walked over the record's aggregate: every
 * deadline past `now` climbs one class and re-arms, stopping at mature (where
 * the clock retires), and the stand's kill stock is re-derived from the
 * classes it now holds.
 *
 * 🚨 THIS IS THE ONE STEP THAT MAY CHANGE THE TOTALS, and it is production —
 * a tree that grew while you were away has more wood in it, exactly as it
 * would have with you watching. Fold and expand never do (see the header).
 *
 * `classPeriodS` is the caller's (`growthClassPeriodS(scale, growth)` — the
 * scale lives outside this module, as it does for every other pure
 * calculator here). Returns a NEW record; the input is untouched.
 */
export function advanceWildArea(
  rec: WildAreaRecord,
  now: number,
  classPeriodS: (species: string) => number,
): WildAreaRecord {
  const stands: WildStand[] = [];
  let moved = false;
  for (const st of rec.stands) {
    const growth = naturalSourceOf(st.species)?.growth;
    if (!growth || !st.climbAt.length) {
      stands.push(st);
      continue;
    }
    const period = Math.max(1e-3, classPeriodS(st.species));
    const byClass = [...st.byClass];
    const climbAt: { cls: number; at: number }[] = [];
    const last = growth.classes.length - 1;
    for (const c of st.climbAt) {
      let cls = c.cls;
      let at = c.at;
      while (at <= now && cls < last) {
        byClass[cls] = Math.max(0, (byClass[cls] ?? 0) - 1);
        cls++;
        byClass[cls] = (byClass[cls] ?? 0) + 1;
        at += period;
        moved = true;
      }
      if (cls < last) climbAt.push({ cls, at });
    }
    if (!moved) {
      stands.push(st);
      continue;
    }
    // The stand's kill stock is a function of the classes standing in it (the
    // "size means units left, not a fraction" law, read forward for growth —
    // `dueGrowthAdvance` replaces a grown feature's kill stock the same way).
    const stock = { ...st.stock };
    for (const p of naturalSourceOf(st.species)?.products ?? []) {
      if (p.method !== "kill") continue;
      let n = 0;
      byClass.forEach((count, cls) => {
        n += count * growthClassYield(p, growth.classes[cls]!.yieldMul);
      });
      stock[p.glyph] = n;
    }
    climbAt.sort((a, b) => a.cls - b.cls || a.at - b.at);
    stands.push({ ...st, byClass, stock, climbAt });
  }
  // Harvest regrowth is the standing source's own ledger and needs the live
  // stack to catch up against; an unloaded stand's fruit resumes on expand,
  // where `dueHarvestRegrowth` sees a real feature again. Recorded, not
  // silently dropped: the deadlines survive the fold untouched.
  if (!moved) return rec;
  return { ...rec, at: now, stands };
}

// ── ⚖️ F5 — THE DRAW: a source yields without standing up ─────────────────
//
// (fold-round.md stage F5, REGION REACH: *"the offloaded wild/regional source
// becomes a trade endpoint through the same condensed-partner seam — a town
// draws on the region exactly as it trades with a stub town, price and legs
// included."*)
//
// A condensed TOWN's shelf is topped up by a MINT — closed-form production
// nobody is simulating (`stockAbstractPartner`, F-③'s integral). A source's is
// not: the units are already in the record, standing in real stands, and a
// draw MOVES them. That is the whole difference between a fiction and a
// record, and it is why this is the one thing the source needs that a stub town
// does not — everything else (the endpoint, the priced leg, the scheduled
// agreement) is the partner seam unchanged.

/** How many sources stand in one stand. */
function standPopulation(st: WildStand): number {
  return st.byClass.reduce((a, b) => a + b, 0);
}

/** A deep-enough copy to mutate — the draw is pure in its input, exactly as
 *  `advanceWildArea` is. */
function cloneStand(st: WildStand): WildStand {
  const regrowAt: Record<string, number[]> = {};
  for (const [g, list] of Object.entries(st.regrowAt)) regrowAt[g] = [...list];
  return {
    species: st.species,
    byClass: [...st.byClass],
    stock: { ...st.stock },
    cap: { ...st.cap },
    climbAt: st.climbAt.map((c) => ({ ...c })),
    regrowAt,
  };
}

/** The units ONE source of class `cls` carries of a product — the very yield
 *  `advanceWildArea` re-derives a stand's timber from, so felling and growing
 *  speak one arithmetic (and a growth-less source answers its plain midpoint,
 *  exactly as `killFloorOf` reads one). */
function sourceYieldOf(src: NaturalSource, p: NaturalProduct, cls: number): number {
  const mul = src.growth ? src.growth.classes[cls]?.yieldMul ?? 1 : 1;
  return growthClassYield(p, mul);
}

/** The biggest class still standing that actually CARRIES the good — a stand
 *  of saplings holds no timber, and felling one would destroy a tree for
 *  nothing. −1 when the stand has nothing left to give. */
function largestBearingClass(st: WildStand, src: NaturalSource, p: NaturalProduct): number {
  for (let cls = st.byClass.length - 1; cls >= 0; cls--) {
    if ((st.byClass[cls] ?? 0) > 0 && sourceYieldOf(src, p, cls) > 0) return cls;
  }
  return -1;
}

/**
 * ⚖️ A KILL DRAW FELLS — one source, and everything it carried of every kill
 * product comes out with it (the population drops by one, and its growth clock
 * with it).
 *
 * 🚨 WHY FELLING AND NOT A PLAIN STOCK DEBIT. `advanceWildArea` RE-DERIVES a
 * stand's kill stock from the classes standing in it — growth is production —
 * so timber quietly subtracted without dropping the tree grows straight back
 * at the next class climb: the same wood in the buyer's yard AND back in the
 * forest. Felling is what keeps the two readings honest, and it is also what
 * the loaded path does (`sourceKillExhausted`: "the last wood taken IS the
 * felling").
 */
function fellSource(st: WildStand, src: NaturalSource, cls: number): Record<string, number> {
  st.byClass[cls] = Math.max(0, (st.byClass[cls] ?? 0) - 1);
  const out: Record<string, number> = {};
  for (const p of src.products) {
    if (p.method !== "kill") continue;
    for (const [g, n] of Object.entries(takeStock(st.stock, p.glyph, sourceYieldOf(src, p, cls)))) {
      out[g] = (out[g] ?? 0) + n;
    }
  }
  // Its class clock comes down with it. `climbAt` is sorted (class, deadline),
  // so the first entry of the class is the one nearest maturing — the biggest
  // tree in the class, which is the one being cut. A MATURE source has no
  // entry at all and nothing is removed.
  const ci = st.climbAt.findIndex((c) => c.cls === cls);
  if (ci >= 0) st.climbAt.splice(ci, 1);
  return out;
}

/** What a draw asks the source for. */
export interface WildDrawInput {
  /** The good wanted — HEAD-matched, `takeStock`'s own rule (`wood` draws
   *  `wood.wet` too). */
  glyph: string;
  /** Units wanted. A KILL draw FELLS, so the answer may be LARGER than this (a
   *  felled tree's whole timber comes out at once) and smaller when the stand
   *  runs out — an honest partial, never an invented unit. */
  units: number;
  /** WHERE the draw came from, in the record's own coordinates — the drawing
   *  town's gate. Absent ⇒ nobody says, and no direction is booked. */
  from?: { x: number; y: number } | null;
  /** Clock the draw happens at; the record is re-quoted at it. */
  now?: number;
}

export interface WildDrawResult {
  /** The record AFTER the draw — a NEW object where anything moved (the input
   *  is untouched, exactly as `advanceWildArea` leaves its input alone), the
   *  SAME object where nothing did. */
  rec: WildAreaRecord;
  /** Exactly what left the stands, by concrete glyph. Σ equals the record's
   *  stock drop, to the unit: that IS the conservation contract, and the
   *  caller must land every one of these units somewhere. */
  taken: Record<string, number>;
}

/**
 * ⚖️ DRAW FROM AN OFFLOADED STAND — the source's harvest, in closed form.
 *
 * The units come OUT of the record (they were always there), the stand's
 * population follows where the good is a kill product, and the
 * harvest-DIRECTION histogram books the draw against the sector the drawer
 * came from — the same `addWildDraw` the fold's own inference uses, so a source
 * that has been sold from re-expands thinner on the side that bought.
 *
 * Deterministic and pure. Stands are visited in record order; a stand that
 * cannot answer is returned untouched (same object), so a draw that moves
 * nothing leaves the record byte-identical.
 */
export function drawWildArea(rec: WildAreaRecord, input: WildDrawInput): WildDrawResult {
  const taken: Record<string, number> = {};
  let left = Math.max(0, Math.floor(input.units));
  if (left <= 0) return { rec, taken };
  const head = stackHead(input.glyph);
  let drawn = 0;
  /** Bank what came out of a stand, and count the asked-for head against the
   *  request (a felled tree's OTHER products ride out too, but they are not
   *  what was ordered). */
  const bank = (out: Readonly<Record<string, number>>): void => {
    for (const [g, n] of Object.entries(out)) {
      if (!(n > 0)) continue;
      taken[g] = (taken[g] ?? 0) + n;
      drawn += n;
      if (stackHead(g) === head) left -= n;
    }
  };
  let moved = false;
  const stands = rec.stands.map((st) => {
    if (left <= 0) return st;
    const src = naturalSourceOf(st.species);
    const product = src?.products.find((p) => stackHead(p.glyph) === head);
    if (!src || !product) return st;
    const before = drawn;
    const next = cloneStand(st);
    if (product.method === "kill") {
      while (left > 0) {
        const cls = largestBearingClass(next, src, product);
        if (cls < 0) break;
        bank(fellSource(next, src, cls));
      }
    } else {
      // A PICK, not a felling: harvest stock comes off the stand and the source
      // keeps standing — its own regrow clock is what puts the fruit back, so a
      // picked orchard is not a cleared one.
      bank(takeStock(next.stock, head, left));
    }
    if (drawn === before) return st; // nothing this stand could answer
    if (standPopulation(next) <= 0) {
      // 🚨 A STAND WITH NOTHING STANDING HOLDS NOTHING. `expandWildArea` deals
      // no features for a population of 0 and would drop whatever the record
      // still listed — so the last source out carries the remainder with it
      // (the felling rule's "a felled tree bears nothing", read forward).
      for (const g of Object.keys(next.stock)) bank(takeStock(next.stock, g, next.stock[g] ?? 0));
      next.cap = {};
      next.regrowAt = {};
      next.climbAt = [];
    } else {
      // Fewer sources bear less: the stand's capacity and its regrow queue
      // follow the population down, or a felled wood would keep the bearing
      // ceiling of the trees it no longer has.
      const oldPop = standPopulation(st);
      const newPop = standPopulation(next);
      if (newPop < oldPop && oldPop > 0) {
        for (const [g, n] of Object.entries(next.cap)) {
          const scaled = Math.round((n * newPop) / oldPop);
          if (scaled > 0) next.cap[g] = scaled;
          else delete next.cap[g];
        }
        for (const [g, list] of Object.entries(next.regrowAt)) {
          if (list.length > newPop) next.regrowAt[g] = list.slice(0, newPop);
        }
      }
    }
    moved = true;
    return next;
  });
  if (!moved) return { rec, taken };
  const draw = [...rec.draw];
  if (input.from) {
    const centre = wildAreaCenter(rec);
    addWildDraw(draw, input.from.x - centre.x, input.from.y - centre.y, drawn);
  }
  return { rec: { ...rec, at: input.now ?? rec.at, stands, draw }, taken };
}

// ── ⚖️ F5 — THE SOURCE AS A TRADE ENDPOINT (one-way) ──────────────────────

/** Where the source stands: its own ground's centre, and the point a road to it
 *  is measured to. */
export function wildAreaCenter(rec: WildAreaRecord): { x: number; y: number } {
  return { x: rec.area.x + rec.area.w / 2, y: rec.area.y + rec.area.h / 2 };
}

/**
 * A SOURCE, READ AS A PARTNER — everything the trade tier asks a condensed
 * partner (`TownRecord`'s own list: what it has, where it is, how long the
 * road is), off the wild record instead of a town's. Deliberately the same
 * SHAPE and deliberately NOT the same type: a town is a party with needs that
 * trades both ways, and a forest is a source.
 *
 * ⚖️ "Source" — like "catchment" — names a ROLE, not an object type: the same
 * object may be both, depending on circumstance (a depot is at once the place
 * the harvest is stored locally AND the source it is distributed from).
 */
export interface WildSourcePartner {
  /** The area key (`wild:area:<key>`'s tail). */
  key: string;
  /**
   * ⚖️ THE ENDPOINT ITS GOODS SIT AT — the source's own scope id, and NEVER a
   * `town:` one. That single choice is what makes the one-way law STRUCTURAL
   * instead of a convention: `scopeReceivesGoods` reads FALSE off a `wild:` id
   * everywhere and forever (scope.ts: *"a shelf receives, a source only
   * yields"* — and its own doc already names "an offloaded region source" as
   * the case), so no reader has to remember that this partner is special.
   */
  id: ScopeId;
  /** Where it stands (the record's ground, centre). */
  at: { x: number; y: number };
  /** The ROAD to it in world metres, for the ONE leg seat (the host's
   *  `partnerLegSeconds` → `barterLegSeconds`). Null when the drawer has no
   *  place to measure from — the same honest null a place-less stub takes, and
   *  the same flat leg it is priced at. */
  distanceM: number | null;
  /** What it can sell right now, by glyph — the record's own stock reading,
   *  which is also the audit's (`wildAreaStock`). One number, one source. */
  yields: Record<string, number>;
}

/** Read a folded area as a trade partner, from the drawing town's place. */
export function wildSourcePartner(
  rec: WildAreaRecord,
  from?: { x: number; y: number } | null,
): WildSourcePartner {
  const at = wildAreaCenter(rec);
  return {
    key: rec.key,
    id: wildAreaId(rec.key),
    at,
    distanceM: from ? Math.hypot(at.x - from.x, at.y - from.y) : null,
    yields: wildAreaStock(rec),
  };
}

/**
 * ⚖️ A SOURCE YIELDS AND NEVER RECEIVES — the capacity is ZERO, deliberately.
 *
 * `putStock` finds no room for a single unit, so `transferStock` hands every
 * unit straight back to the sender: a sell-to-source leg cannot move goods even
 * if one were somehow posted, and nothing is lost in the attempt (which is the
 * conservation law's own requirement of a refusal). Drawing is unaffected —
 * taking reads the stack and never the capacity.
 *
 * `shelf` is the source's BOUNDARY SHELF, the live map a draw lands in and a leg
 * ships out of: the exact counterpart of a condensed town's `partnerStock`
 * shelf, filled by `drawWildArea` where the town's is filled by a mint. No
 * `at`: like a partner town's endpoint this is abstract and scheduled-only —
 * you do not walk to a region.
 *
 * KEYED, NOT RECORDED, on purpose: the shelf OUTLIVES the record. Timber
 * already cut and waiting at the road is not standing timber, so an area that
 * loads its stand back in leaves the shelf exactly where it is — and a leg
 * still owed against it goes on shipping instead of failing for want of an
 * endpoint.
 */
export function wildSourceEndpoint(key: string, shelf: Record<string, number>): StockEndpoint {
  return { id: wildAreaId(key), kind: "wild", capacity: 0, stack: shelf, owner: null };
}

// ── The registered codec (F1 — fold-round.md) ───────────────────────────────
//
// ⚖️ F-② — wild is the FIRST codec through the one fold. `condenseWildArea`/
// `expandWildArea` above are UNTOUCHED and byte-stable: every existing caller
// (quest-host.ts `foldWildArea`/`unfoldWildArea`) keeps calling them
// directly. What follows is a thin second front door — the generic dispatch
// (`kernel/town/fold.ts` `condense`/`expand`) — registered so this kind never
// needs its own hand-add in a host's stock audit again (`foldedStock`).

/**
 * What the codec's `condense`/`expand` need from the live host, beyond the
 * base clock (`FoldCtx.now`) — the union of `WildFoldInput` and
 * `WildUnfoldInput` above, minus what the scope id itself already answers
 * (the area's `key` is the id's own tail, `wild:area:<key>`).
 */
export interface WildFoldCtx extends FoldCtx {
  /** condense: the standing features to fold (absent ⇒ none stood). */
  features?: readonly WildernessFeature[];
  /** condense: the live stack per feature (host's `containerStock`). */
  liveStock?(containerId: string): Readonly<Record<string, number>> | undefined;
  /** condense: the ground this area occupies. */
  area: { x: number; y: number; w: number; h: number };
  /** condense: the placement seed. */
  seed: number;
  /** condense: the record this area folded to LAST time (carries the
   *  gradient forward — see `condenseWildArea`'s own doc, above). */
  prev?: WildAreaRecord | null;
  /** expand: feature id for the i-th source of a species (default: the
   *  scatter's own spelling — see `WildUnfoldInput`). */
  idOf?(species: string, index: number): string;
  /** expand: keep-clear disc (a town's plaza). */
  clearAt?: { x: number; y: number };
  clearR?: number;
  /** expand: receives each feature laid back out — the live host's hook to
   *  materialize it, a test's hook to collect them for a stock check.
   *  Optional: omit for a dry run that only wants the ids back. */
  place?(feature: WildernessFeature): void;
}

function condenseWildAreaPayload(id: ScopeId, ctx: WildFoldCtx): WildAreaRecord | FoldRefusal {
  const ref = parseScopeId(id);
  if (ref.kind !== "wild" || ref.form !== "area") {
    return { refused: true, kind: "wild", id, blockers: [], note: `not a wild-area id ("${id}")` };
  }
  return condenseWildArea({
    features: ctx.features ?? [],
    liveStock: ctx.liveStock,
    now: ctx.now,
    area: ctx.area,
    seed: ctx.seed,
    key: ref.tag,
    prev: ctx.prev,
  });
}

function expandWildAreaPayload(
  record: FoldRecord<WildAreaRecord>,
  ctx: WildFoldCtx,
): ScopeId[] | FoldRefusal {
  const features = expandWildArea({
    rec: record.payload,
    idOf: ctx.idOf,
    clearAt: ctx.clearAt,
    clearR: ctx.clearR,
  });
  for (const f of features) ctx.place?.(f);
  return features.map((f) => f.id);
}

/**
 * THE WILD CODEC — registered below at module load, so importing this module
 * (already the whole game does, for `condenseWildArea`/`expandWildArea`
 * themselves) is enough to make `kind: "wild"` foldable through the generic
 * dispatch.
 */
export const WILD_AREA_CODEC: FoldCodec<WildAreaRecord, WildFoldCtx> = {
  kind: "wild",
  condense: condenseWildAreaPayload,
  expand: expandWildAreaPayload,
  stockOf: wildAreaStock,
  // ⚖️ F5 — a standing DRAW leg booked against the area itself is serviced by
  // the record (the sweep draws the shelf out of it and ships, with no stand
  // loaded anywhere), exactly as a condensed town's standing trade leg is
  // serviced by its shelf. ONE predicate for both (barter.ts). A leg against a
  // STANDING FEATURE (`wild:oak_3`) is not covered and refuses: that endpoint
  // is precisely what stops existing at this fold.
  services: standingLegServiced,
};

registerFoldCodec(WILD_AREA_CODEC);
