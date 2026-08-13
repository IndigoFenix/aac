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

import { growthClassYield, naturalSourceOf } from "../../products.js";
import {
  wildFeatureContainerId, type WildernessFeature,
} from "./wilderness.js";

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
    if (taken > 0) {
      const dx = f.x - cx;
      const dy = f.y - cy;
      if (dx !== 0 || dy !== 0) draw[wildDrawSectorOf(dx, dy)] += taken;
    }
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
