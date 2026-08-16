/**
 * roster.ts — WHO DOES WHAT in a household: the DUTY ROSTER
 * (household-duties-and-sims-mode.md §1). A Duty is a data row binding an
 * ACTIVITY (a good's shopping cycle · a shift at a work building · a Sims-mode
 * chore) to a SCHEDULE; `rosterOf` deals every house's duties to its members,
 * pure + deterministic. This is the ONE allocator — the old "member index ==
 * good slot" identity survives only as the shopping rule inside it, and every
 * consumer (residents.ts spawning, activity composition, quest-host templates
 * and dialogue) reads the roster instead of re-deriving the mapping.
 *
 * WHY: one member ⇒ exactly one errand couldn't scale — jobs, several errands
 * per person, members with none, and household-mode chores all need N duties
 * per member. A duty list also gives dialogue its material ("where are you
 * going?" / "why?") and the live need loop its templates, from one source.
 */

import { HOUSEHOLD } from "./goods.js";

/** What a duty has the body DO when it claims it. `shop` carries the good's
 *  errand ROLE (its slot — box corner + cycle role, unchanged math). `job` and
 *  `home` land with the jobs / household slices; the shapes are fixed now so
 *  consumers switch exhaustively. */
export type DutyActivity =
  | { kind: "shop"; good: string; role: number }
  | { kind: "job"; work: number }
  | { kind: "home"; chore: string };

export interface Duty {
  /** Stable within the house ("shop:food", "job:3"). */
  key: string;
  activity: DutyActivity;
  /** Street-day clock window claiming the body (jobs/chores); absent = the
   *  activity's own cycle (a shop duty runs on the goods clock). Fractions of
   *  the street day, start ∈ [0,1). */
  window?: { start: number; len: number };
  /** Composition tie-break when several duties could claim the body — higher
   *  wins (job > shop > implicit meal > idle). */
  priority: number;
}

/** Duty priorities — spaced so slices can slot between. */
export const SHOP_PRIORITY = 2;
export const JOB_PRIORITY = 3;

/**
 * The duties of one household, member → Duty[]. Deterministic; same inputs,
 * same roster forever.
 *
 * SHOPPING: good of role r (its slot) lands on the (r+1)-th NON-EXCLUDED
 * member — byte-identical to the resident model's historical `runnerId` rule,
 * so streaming/spawn positions are unchanged by the refactor. A house with
 * more goods than souls drops the later runs (the one-soul house still eats).
 *
 * JOBS (`jobs`, from `assignTownJobs`): each entry lands on its member as a
 * shift-windowed duty. Assignment already avoided shoppers and kept a soul at
 * home; here it's just rows.
 */
export function rosterOf(
  goods: ReadonlyArray<{ key: string; slot?: number }>,
  excludedMembers?: ReadonlySet<number>,
  jobs?: ReadonlyArray<JobAssignment>,
): Duty[][] {
  const members: Duty[][] = Array.from({ length: HOUSEHOLD }, () => []);
  const eligible: number[] = [];
  for (let m = 0; m < HOUSEHOLD; m++) {
    if (!excludedMembers?.has(m)) eligible.push(m);
  }
  goods.forEach((g, i) => {
    const role = g.slot ?? i;
    const m = eligible[role];
    if (m === undefined) return; // more roles than souls — the later runs drop
    members[m]!.push({
      key: `shop:${g.key}`,
      activity: { kind: "shop", good: g.key, role },
      priority: SHOP_PRIORITY,
    });
  });
  for (const j of jobs ?? []) {
    if (j.member < 0 || j.member >= HOUSEHOLD || excludedMembers?.has(j.member)) continue;
    members[j.member]!.push({
      key: `job:${j.work}`,
      activity: { kind: "job", work: j.work },
      window: j.window,
      priority: JOB_PRIORITY,
    });
  }
  return members;
}

// ── Jobs — town-wide staff allocation ──────────────────────────────────────

/** One member's employment: a shift at `works[work]` inside a street-day
 *  clock window (fractions of the day, start ∈ [0,1)). */
export interface JobAssignment {
  member: number;
  work: number;
  window: { start: number; len: number };
}

/** Souls one work building employs when its row declares no `staff` of its
 *  own (①b: a founded building's StructureSpec.jobs overrides per building;
 *  this flat default covers every base work). Projection-only economy:
 *  bodies at workplaces render the aggregate's production, they don't feed it. */
export const STAFF_PER_WORK = 2;
/** A shift's length, in street-day fractions (§2: a mid-day working day). */
export const SHIFT_LEN = 0.38;

function hash01(seed: number, key: string): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Assign every work building its STAFF from the nearest households'
 * DUTY-FREE members (household-duties-and-sims-mode.md §1). Deterministic,
 * pure geometry in, rows out:
 *
 *   • works hire in plan order; houses queue by doorstep distance (stable by
 *     index) — commuters live near their work;
 *   • only members WITHOUT a shop duty are hired (v1 keeps duties disjoint —
 *     the shop clock and a shift can't contest one body), and every house
 *     keeps at least ONE duty-free soul at home;
 *   • one hire per house per work before seconds, so employment spreads;
 *   • each work's shift window is hash-staggered (start ~0.22–0.34 of the
 *     street day), so the town doesn't commute in lockstep.
 *
 * Returns houseIndex → its members' jobs (empty map entries omitted).
 */
export function assignTownJobs(
  houses: ReadonlyArray<{ index: number; door: { x: number; y: number } }>,
  /** `staff` overrides the flat STAFF_PER_WORK for that work (①b: a founded
   *  building's StructureSpec.jobs; 0 = unstaffed — e.g. still building). */
  works: ReadonlyArray<{ door: { x: number; y: number }; staff?: number }>,
  goodsCount: number,
  seed: number,
): Map<number, JobAssignment[]> {
  const out = new Map<number, JobAssignment[]>();
  // Duty-free pool per house: members past the shoppers, minus one kept home.
  const freeOf = new Map<number, number[]>();
  for (const h of houses) {
    const free: number[] = [];
    for (let m = goodsCount; m < HOUSEHOLD - 1; m++) free.push(m);
    freeOf.set(h.index, free);
  }
  works.forEach((wk, w) => {
    const staffTarget = Math.max(0, wk.staff ?? STAFF_PER_WORK);
    if (staffTarget === 0) return;
    const window = { start: 0.22 + hash01(seed, `shift:${w}`) * 0.12, len: SHIFT_LEN };
    const byDist = [...houses].sort((a, b) => {
      const da = Math.hypot(a.door.x - wk.door.x, a.door.y - wk.door.y);
      const db = Math.hypot(b.door.x - wk.door.x, b.door.y - wk.door.y);
      return da === db ? a.index - b.index : da - db;
    });
    // Each ROUND takes at most one member per house (nearest first), so
    // employment spreads before any household sends a second commuter.
    let crew = 0;
    for (let round = 0; round < HOUSEHOLD && crew < staffTarget; round++) {
      for (const h of byDist) {
        if (crew >= staffTarget) break;
        const m = freeOf.get(h.index)!.shift();
        if (m === undefined) continue;
        const jobs = out.get(h.index) ?? [];
        jobs.push({ member: m, work: w, window });
        out.set(h.index, jobs);
        crew++;
      }
    }
  });
  return out;
}

// ── Attendance — jobs IMPACT the economy (street-level coupling) ────────────
// The aggregate models production; the street renders it. What the street CAN
// truthfully feed back is DISRUPTION: a worker recruited, commanded, or pulled
// off by the live need loop during its shift is ABSENT, and yesterday's absence
// thins today's dawn shelf. Off-screen scheduled workers are present by
// definition (the schedule is the estimate that holds unless interfered).

/** Per-work absence tally: seconds absent TODAY, plus the finished tally of
 *  the PREVIOUS day (what dawn stocking reads). Same day-bucket discipline as
 *  the store consumed-offset. */
export interface WorkAttendance {
  day: number;
  seconds: number;
  prevSeconds: number;
}

/** Accumulate `dt` seconds of absence at time `t` (street-day buckets). A day
 *  rollover banks the finished tally into `prevSeconds` (a gap of more than one
 *  day banks nothing — absence expires). */
export function noteAbsence(
  rec: WorkAttendance | undefined,
  t: number,
  dt: number,
  daySec: number,
): WorkAttendance {
  const day = Math.floor(t / daySec);
  if (!rec || rec.day !== day) {
    return { day, seconds: dt, prevSeconds: rec && rec.day === day - 1 ? rec.seconds : 0 };
  }
  return { day, seconds: rec.seconds + dt, prevSeconds: rec.prevSeconds };
}

/** Attendance floor — a fully-abandoned workplace still gets SOME goods out
 *  (the aggregate's other hands); the shelf never zeroes from absence alone. */
export const ATTENDANCE_FLOOR = 0.25;

/** Yesterday's attendance factor for one work at day `day`: 1 − absent/scheduled,
 *  clamped to [ATTENDANCE_FLOOR, 1]. `scheduledSec` = staff × shift seconds. */
export function attendanceFactor(
  rec: WorkAttendance | undefined,
  day: number,
  scheduledSec: number,
): number {
  if (!rec || scheduledSec <= 0) return 1;
  const absent = rec.day === day ? rec.prevSeconds : rec.day === day - 1 ? rec.seconds : 0;
  return Math.max(ATTENDANCE_FLOOR, Math.min(1, 1 - absent / scheduledSec));
}

/** A member's JOB duty (shift), or undefined. */
export function jobDutyOf(duties: readonly Duty[] | undefined): { work: number; window: { start: number; len: number } } | undefined {
  for (const d of duties ?? []) {
    if (d.activity.kind === "job" && d.window) return { work: d.activity.work, window: d.window };
  }
  return undefined;
}

/** Is a street-day clock second inside a shift window? (`start` may wrap.) */
export function inShiftWindow(window: { start: number; len: number }, t: number, daySec: number): boolean {
  const u = ((t / daySec) % 1 + 1) % 1;
  const rel = ((u - window.start) % 1 + 1) % 1;
  return rel < window.len;
}

/** A member's SHOP duty (one per member today), or undefined for a homebody. */
export function shopDutyOf(duties: readonly Duty[] | undefined): { good: string; role: number } | undefined {
  for (const d of duties ?? []) {
    if (d.activity.kind === "shop") return { good: d.activity.good, role: d.activity.role };
  }
  return undefined;
}

/** The member holding a good's SHOP duty, or null (nobody left to run it). */
export function shopMemberOf(roster: readonly (readonly Duty[])[], goodKey: string): number | null {
  for (let m = 0; m < roster.length; m++) {
    if (roster[m]!.some((d) => d.activity.kind === "shop" && d.activity.good === goodKey)) return m;
  }
  return null;
}
