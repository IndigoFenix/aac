// shared/world-engine/kernel/destiny.ts
//
// THE DESTINY CONVENTIONS — the states round's §4 laws as a module
// (states-round.md "# ROUND PLAN" §10/§11 S0, user rulings §14, 2026-08-25).
// Rung-agnostic on purpose: nothing here names a rung, a clock unit, or an
// item catalogue. Timestamps are absolute values in WHATEVER clock the
// caller steps (taskClock seconds at the fine rung, economy days at the
// town rung, whole game-years at the state rung — the §14-⑧ grain ladder
// lives in the steppers, never here).
//
// The laws this module makes mechanical:
//
// ⚖️ SEEDED DRAWS ARE COORDINATE-KEYED, NEVER SEQUENTIAL (§4 law 4).
//    `hash01` is ONE hash per (seed, coordinates, salt) tuple with no
//    hidden stream state, so evaluation order can never matter — a watched
//    replay and a warp draw the same values in any order. Moved here
//    VERBATIM from planet/history.ts (which now re-imports it): one
//    definition of "the draw" for every rung.
//
// ⚖️ DECAY IS A FUNCTION OF TIMESTAMPS, NEVER OF STEPS (§4 law 3). A
//    below-threshold fact gets its expiry stamped AT WRITE and reaches
//    exactly zero at that date — quantized, not asymptotic. Fast-forward
//    is then a FILTER BY DATE: no integration, no drift, and the watched
//    path fades to the identical zero on the identical day.
//
// ⚖️ THE FLUX LAW (user ruling §14-②, 2026-08-25): "All items can have a
//    chance of destruction or creation within a locale and this impacts
//    the noise level and how long a player's impact must be retained."
//    A locale's own creation/destruction flux for a kind IS the noise
//    floor for that kind there; a delta's retention time scales with its
//    magnitude relative to that flux, and ZERO flux means PERMANENT.
//    The user's calibration cases all derive from this one shape:
//      • consumables into a city with that industry — high flux, erased
//        quickly (the churn metabolizes the delta);
//      • non-consumables into that industry's city — some churn, the books
//        keep it, the impact is small;
//      • non-consumables where the kind is RARE — near-zero flux, the
//        impact is significant and durable;
//      • a rare non-consumable left in wilderness — no flux at all: the
//        item is never destroyed (only its below-threshold SPATIAL detail
//        may re-sample on expand — position drifts, existence does not).
//    The player needs NO special rule: player deltas obey the same law.
//
// ⚖️ MICRO WRITES MACRO ONLY THROUGH DECLARED FLOWS (§4 law 2). The
//    channel registry below is the enumerable membrane the S4 audit walks:
//    every coarse writer registers, the audit reds on any that don't.
//    Channel ids are plain strings so trait-flavored channels (PopuSim
//    joining the state rung for wars/breakaways/disease — §14-⑦ "the seam
//    must stay surmountable") register the same way; nothing here may
//    acquire vocabulary from the composition seam.

// ── The draw ────────────────────────────────────────────────────────────────

/** SplitMix32 — the deterministic draw. One hash per (salt, coordinates)
 *  tuple; no sequential RNG state, so evaluation order never matters.
 *  (Verbatim from planet/history.ts, the nations arc's court — moved here
 *  so every rung draws through one definition.) */
export function hash01(seed: number, a: number, b: number, c: number, salt: number): number {
  let h = (seed ^ (a * 0x9e3779b9) ^ (b * 0x85ebca6b) ^ (c * 0xc2b2ae35) ^ (salt * 0x27d4eb2f)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 0x1_0000_0000;
}

// ── Fading memories (law 3 + the flux law) ──────────────────────────────────

/** A below-threshold fact that leaves a TRACE — a burned barn, a moved
 *  crate, a grave. The persistent layer IS the definition of what leaves
 *  a mark: alive until `expiresAt`, then exactly gone. Units are the
 *  caller's clock; `kind` is an opaque tag (an item kind, a memory class
 *  — the stamping caller's vocabulary, never this module's). */
export interface DestinyMemory {
  kind: string;
  /** How much the fact moved, in the caller's books unit. */
  magnitude: number;
  /** Absolute write time (caller's clock). */
  writtenAt: number;
  /** Absolute death date (caller's clock). Infinity = permanent. */
  expiresAt: number;
}

/** How many metabolize-spans a trace outlives its own absorption — the
 *  one content dial in the law (S5-tunable; nothing pins it yet). The
 *  LAW is the shape: retention = magnitude / flux, scaled by this. */
export const MEMORY_TURNOVER_DEFAULT = 4;

/**
 * THE FLUX LAW as arithmetic: how long a delta of `magnitude` is
 * remembered in a locale whose creation/destruction churn for that kind
 * is `flux` (books units per caller-clock unit).
 *
 *   flux ≤ 0 (or NaN)  →  Infinity — nothing metabolizes it, the mark is
 *                          permanent (the wilderness case);
 *   magnitude ≤ 0      →  0 — a nothing was never a mark;
 *   otherwise          →  (magnitude / flux) × turnover — the time the
 *                          locale's own churn takes to turn the delta
 *                          over, with a visible tail (an INFINITE churn
 *                          therefore absorbs instantly — the division's
 *                          own zero).
 */
export function memoryLifespan(
  magnitude: number, flux: number, turnover: number = MEMORY_TURNOVER_DEFAULT,
): number {
  if (!(flux > 0)) return Infinity;
  if (!(magnitude > 0)) return 0;
  return (magnitude / flux) * turnover;
}

/** Stamp a memory AT WRITE — expiry is decided once, here, never revised
 *  by later steps (law 3: revising it would be step-dependence in
 *  disguise; a changed world writes a NEW memory instead). */
export function stampMemory(
  kind: string, magnitude: number, writtenAt: number, flux: number,
  turnover: number = MEMORY_TURNOVER_DEFAULT,
): DestinyMemory {
  const life = memoryLifespan(magnitude, flux, turnover);
  return {
    kind,
    magnitude,
    writtenAt,
    expiresAt: Number.isFinite(life) ? writtenAt + life : Infinity,
  };
}

/** Alive strictly BEFORE the death date — at `expiresAt` the trace is
 *  exactly zero (quantized, not asymptotic). */
export function memoryAlive(mem: DestinyMemory, now: number): boolean {
  return now < mem.expiresAt;
}

/** The fast-forward: a warp over memories is a FILTER BY DATE — no
 *  integration, no drift; the watched path fades to the identical zero
 *  on the identical day. */
export function filterMemories(
  memories: readonly DestinyMemory[], now: number,
): DestinyMemory[] {
  return memories.filter(m => memoryAlive(m, now));
}

// ── The membrane: declared coarse-write channels (law 2) ────────────────────

/** One declared flow — a named door through which fine detail may move a
 *  coarse variable. The id is the audit key; the description is for the
 *  reader of the audit's failure message. */
export interface CoarseChannel {
  id: string;
  description: string;
}

const channels = new Map<string, CoarseChannel>();

/** Register a coarse-write channel. Duplicate ids throw — a channel is a
 *  law, and two laws with one name is how membranes leak. */
export function registerCoarseChannel(channel: CoarseChannel): void {
  if (channels.has(channel.id)) {
    throw new Error(`destiny: coarse channel '${channel.id}' already registered`);
  }
  channels.set(channel.id, channel);
}

/** The enumerable membrane — what the S4 audit walks. Sorted by id so the
 *  enumeration is deterministic regardless of registration order. */
export function coarseChannels(): CoarseChannel[] {
  return [...channels.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** True when `id` names a declared flow. */
export function isCoarseChannel(id: string): boolean {
  return channels.has(id);
}
