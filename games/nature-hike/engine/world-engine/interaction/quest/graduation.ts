/**
 * ⚖️ SETTLER GRADUATION — the PURE arithmetic of a conservation handover
 * (body-needs-round.md D6: "GRADUATION = A CONSERVATION HANDOVER").
 *
 * When the founding group's first house is finished, the household that moves
 * in IS the settlers — nobody new arrives and nobody is minted. The host half
 * of that (banking carried stock, handing body meters into the household view,
 * re-keying relations, retiring the bodies) lives in `quest-host.ts`; what
 * lives HERE is the part that is arithmetic and can be pinned without booting
 * a world: WHO becomes WHOM, and whether the units still add up.
 *
 * Three laws this module exists to keep:
 *
 *  ① THE MAP IS SORTED AND CONTIGUOUS. A household's member slots run
 *    `0 … n−1` with no gaps — `familyExcludedMembers` excludes the TAIL
 *    `[n, HOUSEHOLD)` and the resident streamer walks `m ∈ [0, HOUSEHOLD)` —
 *    so a graduating group is mapped by POSITION in the sorted list, never by
 *    the settler's own ordinal. (And the sort is NUMERIC: `settlersOf`'s own
 *    `.sort()` is lexical, which is safe at `SETTLER_MAX = 8` and wrong at 10+
 *    — recorded as R-A7 in the round. This door does not inherit the trap.)
 *
 *  ② A HOUSE HOLDS AT MOST `HOUSEHOLD` SOULS. `SETTLER_MAX` is 8 and
 *    `HOUSEHOLD` is 5, so an over-large founding group cannot all be admitted
 *    by one move-in; the plan says so explicitly rather than silently minting
 *    `resident_<h>_5`, a cid no census, roster or streamer would ever visit.
 *
 *  ③ CONSERVATION IS A SUBTRACTION, and it is stated so it can be MEASURED.
 *    Units that left the bodies must equal units that appeared in the
 *    household's boxes: `conservationBreach` is zero on a legal handover and
 *    signed on an illegal one (positive = minted, negative = lost).
 *
 * PURE: no host, no world, no clock, no RNG. `HOUSEHOLD` is imported, not
 * redeclared — one spelling of how many souls a house holds.
 */
import { HOUSEHOLD } from "../../kernel/town/stations.js";

/** `settler_<i>` — `settlersOf`'s id shape, the one spelling this door uses. */
const SETTLER_CID = /^settler_(\d+)$/;

/** One handover: the settler that walks in, and the resident it becomes. */
export interface GraduationStep {
  /** The settler creature id (`settler_<i>`). */
  from: string;
  /** The resident creature id it becomes (`resident_<house>_<member>`). */
  to: string;
  /** The household member slot — the POSITION in the sorted group (law ①). */
  member: number;
}

/** The ordinal in `settler_<i>`, or null when `cid` is not a settler id. */
export function settlerOrdinalOf(cid: string): number | null {
  const m = SETTLER_CID.exec(cid);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The resident cid for a household slot — the ONE spelling of the id shape
 *  every consumer (`needMeters` keys, the streamer, `houseIndexOfCid`) parses. */
export function residentCidFor(houseIndex: number, member: number): string {
  return `resident_${houseIndex}_${member}`;
}

/** The `needMeters` / `bodyNeeds` map key for a row — `"<cid>|<tplKey>"`. */
export function meterKeyOf(cid: string, tplKey: string): string {
  return `${cid}|${tplKey}`;
}

/**
 * THE PLAN: which settler becomes which member of `houseIndex`, in the order
 * the handover must run (sorted, so every peer over the same clock hands the
 * same body into the same slot — the multiplayer law the seat and errand
 * claims are already taken under).
 *
 * Non-settler ids, duplicates and a negative/non-integer `houseIndex` are
 * dropped rather than mapped: a graduation that cannot name its house has
 * nowhere conserving to put anything, and the empty plan is the refusal.
 * At most `HOUSEHOLD` steps come back (law ②).
 */
export function graduationPlan(
  settlerCids: readonly string[],
  houseIndex: number,
): GraduationStep[] {
  if (!Number.isInteger(houseIndex) || houseIndex < 0) return [];
  const seen = new Set<string>();
  const ordered: Array<{ cid: string; ord: number }> = [];
  for (const cid of settlerCids) {
    const ord = settlerOrdinalOf(cid);
    if (ord === null || seen.has(cid)) continue;
    seen.add(cid);
    ordered.push({ cid, ord });
  }
  // NUMERIC, not lexical — `settler_10` sorts after `settler_2`, which is the
  // trap `settlersOf(...).sort()` still carries at a raised `SETTLER_MAX`.
  ordered.sort((a, b) => a.ord - b.ord);
  return ordered
    .slice(0, HOUSEHOLD)
    .map(({ cid }, member) => ({ from: cid, to: residentCidFor(houseIndex, member), member }));
}

/** How many souls the founded household actually holds — the group, capped by
 *  what a house can hold. This is what `membersOfHouse` must answer for a
 *  graduated house, so the town counts these mouths ONCE (scout B's
 *  double-count ③: five minted residents beside two surviving settlers). */
export function graduationSouls(settlerCids: readonly string[]): number {
  const distinct = new Set(settlerCids.filter((cid) => settlerOrdinalOf(cid) !== null));
  return Math.min(HOUSEHOLD, distinct.size);
}

/** The measurement a graduation must pass: what left the bodies against what
 *  arrived in the household's boxes. */
export interface GraduationLedger {
  /** Units `bankCarried` reported moving off the graduating bodies. */
  banked: number;
  /** Units in the household's boxes BEFORE the handover. */
  chestBefore: number;
  /** Units in the household's boxes AFTER it. */
  chestAfter: number;
}

/**
 * ⚖️ ITEM CONSERVATION, as a number. Zero ⇒ every unit that left a body
 * arrived in a box. POSITIVE ⇒ units were MINTED (the chest gained more than
 * the bodies gave up — the pantry sawtooth reseeding over a real stack is
 * exactly how that happens). NEGATIVE ⇒ units were LOST.
 */
export function conservationBreach(l: GraduationLedger): number {
  return l.chestAfter - l.chestBefore - l.banked;
}
