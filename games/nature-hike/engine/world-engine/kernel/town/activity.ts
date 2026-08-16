/**
 * activity.ts — THE ONE "what is this creature doing right now, and where" function.
 *
 * Design law (user, 2026-07-12, npc-behavior-and-town-economy.md §13b): EVERY system that
 * asks "is a creature mid-task, and where" — spawning a resident mid-trip, spawning one
 * mid-MEAL, later mid-JOB — MUST go through ONE shared function, so a bug in mid-task
 * spawning is fixed in a single place. Today the town streams a shopper mid-trip from
 * `goods.ts errand(house, t)`; this composes that SHOP schedule with an EAT schedule (and,
 * later, jobs) into one `creatureActivityAt`.
 *
 * PURE + time-only: given a member's shop errand (or null) and its eat-cycle params, it
 * returns the current task, sub-phase, progress, and canonical position — a deterministic
 * function of `t`, so it works off-screen for the whole crowd and is headless-testable.
 * The caller (residents.ts streaming, or the host spawn estimate) maps the result onto a
 * body; the LIVE need/goal loop takes over once a creature is loaded and disrupted (§13).
 */

import { FOOD_DAY_SEC } from "./goods.js";
import type { HouseErrand } from "./goods.js";

/** A member eats about once per food-day; the HOUSEHOLD's staggered meals sum to the
 *  schedule's linear pantry drain (HOUSEHOLD rations/day). */
export const MEAL_PERIOD_SEC = FOOD_DAY_SEC;
/** The visible mid-MEAL window (seconds): fetch a unit + eat it at the table. A creature
 *  loaded while `t` lands in this window spawns AT the table, mid-meal. */
export const MEAL_SEC = 24;
/** Hunger rises at one ration per food-day, per person (the §13a anchor). Units: fraction
 *  of a ration per second — reaches the 1-ration threshold in one food-day. */
export const HUNGER_RATE = 1 / FOOD_DAY_SEC;
/** Act on hunger once a whole ration's worth has built up. */
export const HUNGER_THRESHOLD = 1;

type Pt = { x: number; y: number };

/** Deterministic per-(house,member) meal phase offset, so a household's members eat at
 *  staggered times rather than all at once. */
export function mealOffset(seed: number, houseIndex: number, member: number): number {
  let h = 0x811c9dc5 ^ seed;
  const key = `meal:${houseIndex}:${member}`;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) / 4294967296) * MEAL_PERIOD_SEC;
}

/** The scheduled HUNGER a member would have at `t` if it ate on its meal clock: a sawtooth
 *  rising from 0 to 1 over the period, reset by each meal. Used to SEED a freshly-loaded
 *  creature's live meter so the crowd isn't all at hunger 0 (some are ready to eat). */
export function scheduledHunger(mealOff: number, t: number): number {
  const u = (((t + mealOff) % MEAL_PERIOD_SEC) + MEAL_PERIOD_SEC) % MEAL_PERIOD_SEC;
  // 0 during/just after the meal window, climbing to ~1 just before the next one.
  return u < MEAL_SEC ? 0 : Math.min(1, (u - MEAL_SEC) / (MEAL_PERIOD_SEC - MEAL_SEC));
}

export type CreatureTask = "shop" | "work" | "eat" | "idle";

export interface CreatureActivity {
  task: CreatureTask;
  /** shop → the errand phase (home/to_source/at_source/to_home); work → "working";
   *  eat → "eating"; idle → "home". */
  phase: string;
  /** 0..1 through the current task window (work shift / meal), else 0. */
  progress: number;
  /** Canonical position for this activity NOW — the spawn point. */
  pos: Pt;
  /** SHOP only: the full errand (walkTo/cycle/source) the streaming layer needs. */
  errand?: HouseErrand;
}

export interface ActivityCtx {
  /** This member's shopping errand at `t` (from `goods.errand`), or null if the member is a
   *  HOMEBODY that never shops. When the phase is anything but "home" the member is OUT on
   *  the trip and that wins — the highest-priority visible task. */
  shop: HouseErrand | null;
  /** This member's JOB shift (roster duty), or null: the street-day clock window and where
   *  it stands while working (the workplace doorstep/stand). Inside the window the member
   *  is AT WORK — above meals/idle, below an out shopping trip (whose body is already
   *  committed to the streets). */
  job?: { window: { start: number; len: number }; workPos: Pt } | null;
  /** Meal phase offset for this member (`mealOffset`). */
  mealOff: number;
  /** Where this member eats (its house table) and idles (its home spot). */
  tablePos: Pt;
  homeSpot: Pt;
  t: number;
}

/**
 * Compose a member's current activity from its schedules. Priority: an OUT shopping trip
 * (the body is on the streets) beats everything; then an active JOB shift (at the
 * workplace); then the meal window (at the table); else idle at home. Re-derive from `t` —
 * never stored — so a mid-task spawn (walking / at the stall / mid-shift at the workplace /
 * at the table eating) falls out of the same call.
 */
export function creatureActivityAt(ctx: ActivityCtx): CreatureActivity {
  if (ctx.shop && ctx.shop.phase !== "home") {
    const cyc = ctx.shop; // out on the trip — the shop schedule owns the body
    return { task: "shop", phase: cyc.phase, progress: 0, pos: cyc.pos, errand: cyc };
  }
  if (ctx.job) {
    const day = ((ctx.t / FOOD_DAY_SEC) % 1 + 1) % 1;
    const rel = ((day - ctx.job.window.start) % 1 + 1) % 1;
    if (rel < ctx.job.window.len) {
      return { task: "work", phase: "working", progress: rel / ctx.job.window.len, pos: ctx.job.workPos };
    }
  }
  const u = (((ctx.t + ctx.mealOff) % MEAL_PERIOD_SEC) + MEAL_PERIOD_SEC) % MEAL_PERIOD_SEC;
  if (u < MEAL_SEC) {
    return { task: "eat", phase: "eating", progress: u / MEAL_SEC, pos: ctx.tablePos };
  }
  return { task: "idle", phase: "home", progress: 0, pos: ctx.homeSpot };
}
