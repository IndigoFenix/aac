/**
 * skill-prior.ts — WHAT A BODY'S PRACTICE BECOMES WHEN ITS HOUSEHOLD DEMOTES
 * TO A STATISTIC, AND WHAT A REGION'S "AVERAGE SKILL" IS
 * (skill-learning-quality.md §Owner's notes; skill-learning-round.md, the
 * REGIONAL slice).
 *
 * THE OWNER'S ASK, verbatim: *"account for folding and expansion of skills,
 * how to determine their distribution, and how specialized they are. Regions
 * have 'average skills'. This will figure into the trading arc. … A town with
 * a lot of forests will have more skilled loggers and carpenters, while a town
 * with mineral resources will have more skilled miners, masons, and smiths.
 * But not everyone in town will have experience in these fields."*
 *
 * PURE arithmetic: no host, no clock, no RNG, no world — the `cohort-needs.ts`
 * / `regard-prior.ts` precedent, and for the same reason: BOTH DOORS LIVE IN
 * ONE MODULE so the fold and the unfold cannot drift apart. `cohort-needs.ts`
 * does this for a body METER, `regard-prior.ts` for the relation BOOK; this
 * does it for the PRACTICE LEDGER (`skills.ts` `BodySkillRow`).
 *
 * ⚖️ THE FOLDED FORM IS A DISTRIBUTION, NOT A SCALAR. Per skill key a
 * household folds to `{ share, meanS, n }`: the fraction of its members with
 * ANY practice, the mean practice seconds AMONG THOSE, and how many rows
 * folded. "Not everyone in town will have experience" is therefore a
 * PARAMETER (`share`), never a roster — a hamlet with one smith and a city
 * with a guild are the same shape with a different share. Specialisation is
 * that share; competence is the mean.
 *
 * ⚖️ CONSERVATION: THE MOMENTS, NOT THE ROWS. 🚨 THE RAW FACT IS PRACTICE
 * SECONDS (skills.ts), so seconds are what the round trip conserves EXACTLY:
 * the unfold hands `round(share × members)` members practice, staggered
 * symmetrically about the mean (`SKILL_UNFOLD_SPREAD`), and the stagger sums
 * to zero by construction — `Σ practiceS` after an unfold equals `k × meanS`
 * to floating precision, and a second fold reads the SAME prior back. A
 * derived level is not conserved (the curve is concave), and is not claimed.
 *
 * ⚖️ PIN ON DEVIATION — "no scope is special" (ruling ④), at the household
 * rung, the regard fold's own trim: a member whose practice the prior cannot
 * rebuild (a master among apprentices) keeps its rows VERBATIM; the prior is
 * re-folded from the members that remain; the loop pins the single worst
 * deviant per pass, so one outlier cannot make the pin contagious. The test
 * is on the LEVEL scale (`skillLevel` over the world's own curve and dial),
 * because two masters at 800 h and 2 000 h are the same body to every reader
 * in the engine and must not pin each other.
 *
 * ⚖️ THE REGIONAL AVERAGE IS A POPULATION MEAN, read through THE ONE READER.
 * `regionalSkills` projects every pooled household back into rows and asks
 * `skillMultiplier` for every head, live or pooled, novice or not — so the
 * region's number for a skill is exactly the mean of what its people would
 * read at the seats that already exist. Nothing here re-implements the curve.
 *
 * ⚖️ A TOWN NOBODY RUNS HAS THE SKILLS ITS LAND CALLS FOR. A streamed city is
 * a `TownRecord` whose scarcity is already a closed form off its terrain
 * (`stubPartnerSignals`); its skills are the same evidence read the same way:
 * the charter box's COMPOSITION (farmland : ore : timberland — sums node-typing
 * already compares to each other) is the workforce split, and a settled
 * town's practitioners are at mastery (they have worked their trade for
 * years, whatever the `learning` dial says a day is). No number per town is
 * authored; `geographySkillMultipliers` is a function of the founding scan.
 *
 * 🚨 DAY ONE IS BYTE-IDENTICAL. A household with no practice folds to NO
 * payload (`skills` absent, exactly as `needs`/`regard` are absent for an
 * unmeasured house); a region of novices averages exactly 1; a partner with no
 * charter reads exactly 1. Every seat that reads this multiplies or divides by
 * 1 on day one — the pre-slice tree, verbatim.
 */

import type { CreatureId } from "../../interaction/behavior/creatures.js";
import type { PartnerGeography } from "./barter.js";
import {
  DEFAULT_SKILL_CATALOGUE,
  masteryS,
  multiplierOf,
  skillEffectiveLevel,
  skillLevel,
  skillMultiplier,
  skillOfGood,
  type BodySkillRow,
  type SkillCatalogue,
  type SkillState,
} from "./skills.js";

// ---------------------------------------------------------------------------
// The prior
// ---------------------------------------------------------------------------

/** One household's folded practice in ONE skill. */
export interface SkillPrior {
  /** Fraction of the folded members with ANY practice in this key, (0..1]. */
  share: number;
  /** Mean practice SECONDS among those members (the raw fact, conserved). */
  meanS: number;
  /** How many members folded into this prior (provenance, never a weight). */
  n: number;
}

/** The world's curve, as the fold reads it: the catalogue and the `learning`
 *  dial — the two `SkillState` fields a level is derived from. */
export type SkillCurve = Pick<SkillState, "skills" | "scale">;

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const finitePractice = (row: BodySkillRow | undefined): number =>
  row && Number.isFinite(row.practiceS) && row.practiceS > 0 ? row.practiceS : 0;

/** A key's level for `practiceS` under this world's curve; 0 for a key the
 *  catalogue does not carry (a world that removed the row reads it as nothing,
 *  exactly as `practiceSkill` refuses to accrue it). */
function levelOf(curve: SkillCurve, key: string, practiceS: number): number {
  const def = (curve.skills ?? DEFAULT_SKILL_CATALOGUE).get(key);
  return def ? skillLevel(practiceS, masteryS(def, curve.scale)) : 0;
}

/**
 * FOLD: N members' practice rows → one prior per key, over EXACTLY the
 * members given (an absent map is a novice — it counts in the denominator,
 * because it is a member; it holds no key, so it is in nobody's `share`).
 * Keys come back sorted so the serialized payload is byte-stable across
 * replays. Non-finite readings are dropped, never propagated.
 */
export function foldSkillPriors(
  rowsPerMember: ReadonlyArray<ReadonlyMap<string, BodySkillRow> | undefined>,
): Record<string, SkillPrior> {
  const n = rowsPerMember.length;
  if (n === 0) return {};
  const sums = new Map<string, { sum: number; k: number }>();
  for (const rows of rowsPerMember) {
    if (!rows) continue;
    for (const [key, row] of rows) {
      const p = finitePractice(row);
      if (!(p > 0)) continue;
      const e = sums.get(key) ?? { sum: 0, k: 0 };
      e.sum += p;
      e.k += 1;
      sums.set(key, e);
    }
  }
  const out: Record<string, SkillPrior> = {};
  for (const key of [...sums.keys()].sort()) {
    const e = sums.get(key)!;
    if (e.k > 0) out[key] = { share: e.k / n, meanS: e.sum / e.k, n };
  }
  return out;
}

/**
 * HOW FAR one member's practice sits from what its household's prior would
 * re-project — the largest absolute LEVEL difference on any key the member
 * has practised. A key the member holds that the prior does not is
 * unreconstructable ⇒ Infinity (the regard fold's own rule). A member with no
 * practice deviates 0: it is the `1 − share` part of every key.
 */
export function skillDeviation(
  rows: ReadonlyMap<string, BodySkillRow> | undefined,
  priors: Readonly<Record<string, SkillPrior>>,
  curve: SkillCurve,
): number {
  if (!rows) return 0;
  let dev = 0;
  for (const [key, row] of rows) {
    const p = finitePractice(row);
    if (!(p > 0)) continue;
    const prior = priors[key];
    if (!prior) return Infinity;
    dev = Math.max(dev, Math.abs(levelOf(curve, key, p) - levelOf(curve, key, prior.meanS)));
  }
  return dev;
}

/**
 * ⚖️ THE PIN THRESHOLD — how far a member's level may sit from the household
 * mean before the fold keeps its rows verbatim. A quarter of the level scale,
 * the same `PIN_EPS` the regard fold uses: wide enough that practitioners
 * staggered by the unfold's own spread re-fold cleanly (±25 % of the mean's
 * seconds is < 0.1 of level anywhere on the curve), narrow enough that a
 * master among apprentices comes back as the master.
 */
export const SKILL_PIN_EPS = 0.25;

export interface HouseSkillFold {
  /** key → the household's prior for it (sorted keys). Empty ⇒ no payload. */
  skills: Record<string, SkillPrior>;
  /** member → its VERBATIM rows, for the members the prior cannot rebuild. */
  pinned: Record<CreatureId, Record<string, BodySkillRow>>;
}

/**
 * FOLD a household's practice (the demote door).
 *
 * `rowsOf` answers a member's live rows (or nothing — a novice); `members` is
 * the whole household, whether or not each was ever ticked. The trim loop is
 * `foldHouseRegard`'s: fold everyone, pin the SINGLE WORST deviant past
 * `SKILL_PIN_EPS`, re-fold from the rest, ask again — order-free (every pass
 * measures every candidate against the SAME prior, ties break on the sorted
 * cid), converging in at most one pass per member.
 *
 * The prior describes the UNPINNED members only: `share` is over them, so the
 * unfold's `round(share × unpinned)` is an integer identity, not a rounding.
 */
export function foldHouseSkills(
  rowsOf: (cid: CreatureId) => ReadonlyMap<string, BodySkillRow> | undefined,
  members: readonly CreatureId[],
  curve: SkillCurve,
): HouseSkillFold {
  const ordered = [...members].sort();
  const pinnedSet = new Set<CreatureId>();
  const priorsOf = (): Record<string, SkillPrior> =>
    foldSkillPriors(ordered.filter((m) => !pinnedSet.has(m)).map(rowsOf));
  let priors = priorsOf();
  for (let pass = 0; pass < ordered.length; pass++) {
    let worst: { cid: CreatureId; dev: number } | null = null;
    for (const cid of ordered) {
      if (pinnedSet.has(cid)) continue;
      const dev = skillDeviation(rowsOf(cid), priors, curve);
      if (dev > SKILL_PIN_EPS && (worst === null || dev > worst.dev)) worst = { cid, dev };
    }
    if (!worst) break;
    pinnedSet.add(worst.cid);
    priors = priorsOf();
  }
  const pinned: Record<CreatureId, Record<string, BodySkillRow>> = {};
  for (const cid of ordered) {
    if (!pinnedSet.has(cid)) continue;
    const rows = rowsOf(cid);
    if (!rows) continue;
    const verbatim: Record<string, BodySkillRow> = {};
    for (const key of [...rows.keys()].sort()) {
      const p = finitePractice(rows.get(key));
      if (p > 0) verbatim[key] = { practiceS: p };
    }
    if (Object.keys(verbatim).length) pinned[cid] = verbatim;
  }
  return { skills: priors, pinned };
}

// ---------------------------------------------------------------------------
// The unfold
// ---------------------------------------------------------------------------

/**
 * How far the unfold staggers practitioners about the mean: ±25 % of the
 * mean's seconds (`1 ± SPREAD/2`). People are not identical, and five bodies
 * with byte-equal practice would all cross a mastery rung in one frame. The
 * stagger is SYMMETRIC in rank and sums to zero, so the household's seconds
 * are conserved exactly; it is applied on the SECONDS scale, where a quarter
 * is under a tenth of a level anywhere on the curve, so it never pins.
 */
export const SKILL_UNFOLD_SPREAD = 0.5;

export interface ProjectedSkillRows {
  cid: CreatureId;
  rows: Map<string, BodySkillRow>;
  /** True when these rows came back VERBATIM off a pin rather than the prior. */
  pinned: boolean;
}

/**
 * RE-PROJECT a pooled household's practice (the promote door).
 *
 * A PINNED member gets its rows back byte-for-byte. Every other member is
 * dealt from the prior: per key, `round(share × unpinned)` members receive
 * practice — the ones ranked lowest by `phi` (the caller supplies the SAME
 * seeded hash the meter and regard unfolds stagger by, so a frozen prior
 * re-projects byte-identically on every replay: the field is the memory, and
 * people do not flicker) — at `meanS × (1 + SPREAD × (u − ½))`, `u` the
 * receiver's mid-rank `(j + ½) / k`, which sums to zero over the receivers.
 *
 * Rows come out in member order; members that received nothing are omitted
 * (a novice has no map, exactly as before it folded).
 */
export function projectHouseSkills(
  house: {
    skills?: Readonly<Record<string, SkillPrior>>;
    skillPins?: Readonly<Record<CreatureId, Readonly<Record<string, BodySkillRow>>>>;
  },
  members: readonly CreatureId[],
  phi: (member: CreatureId, key: string, index: number) => number,
): ProjectedSkillRows[] {
  const out = new Map<CreatureId, ProjectedSkillRows>();
  const unpinned: Array<{ cid: CreatureId; index: number }> = [];
  members.forEach((cid, index) => {
    const pin = house.skillPins?.[cid];
    if (pin) {
      const rows = new Map<string, BodySkillRow>();
      for (const key of Object.keys(pin).sort()) {
        const p = finitePractice(pin[key]);
        if (p > 0) rows.set(key, { practiceS: p });
      }
      if (rows.size) out.set(cid, { cid, rows, pinned: true });
      return;
    }
    unpinned.push({ cid, index });
  });
  const M = unpinned.length;
  const keys = house.skills ? Object.keys(house.skills).sort() : [];
  for (const key of keys) {
    const prior = house.skills![key]!;
    const meanS = Number.isFinite(prior.meanS) ? Math.max(0, prior.meanS) : 0;
    const k = Math.round(clamp01(Number.isFinite(prior.share) ? prior.share : 0) * M);
    if (!(k > 0) || !(meanS > 0)) continue;
    const ranked = unpinned
      .map((m) => {
        const ph = phi(m.cid, key, m.index);
        return { ...m, phi: Number.isFinite(ph) ? clamp01(ph) : 0.5 };
      })
      .sort((a, b) => a.phi - b.phi || a.index - b.index)
      .slice(0, k);
    ranked.forEach((m, j) => {
      const u = (j + 0.5) / k;
      const practiceS = meanS * (1 + SKILL_UNFOLD_SPREAD * (u - 0.5));
      const entry = out.get(m.cid) ?? { cid: m.cid, rows: new Map<string, BodySkillRow>(), pinned: false };
      entry.rows.set(key, { practiceS });
      out.set(m.cid, entry);
    });
  }
  return members.filter((cid) => out.has(cid)).map((cid) => out.get(cid)!);
}

// ---------------------------------------------------------------------------
// The regional average — the owner's "average skills"
// ---------------------------------------------------------------------------

/** One skill's standing in a region. */
export interface RegionalSkill {
  /** Fraction of the region's heads with ANY own practice in the key. */
  share: number;
  /** Mean effective level AMONG the practitioners (0..1). */
  level: number;
  /** ⚖️ THE POPULATION-MEAN MULTIPLIER, ≥ 1 — what the readers consume: a
   *  region of novices reads exactly 1, a region where a third are masters at
   *  gain 2 reads 1⅓. Includes the tree's inherited share, because it is read
   *  through `skillMultiplier` for every head. */
  multiplier: number;
}

/** A pooled household as the average needs to see it — `CohortHouse`'s two
 *  skill fields plus its head count, structurally. */
export interface PooledSkillHouse {
  members: number;
  skills?: Readonly<Record<string, SkillPrior>>;
  skillPins?: Readonly<Record<CreatureId, Readonly<Record<string, BodySkillRow>>>>;
}

export interface RegionalSkillInput {
  /** The live practice ledger — every body with rows (`session.bodySkills`). */
  live: Iterable<readonly [CreatureId, ReadonlyMap<string, BodySkillRow>]>;
  /** Live heads in the region, rows or not (a novice counts, at 1). Raised to
   *  at least the number of live rows, so a ledger larger than the head count
   *  a caller quoted is never averaged over fewer people than it has. */
  liveHeads: number;
  /** The pooled households (`CohortRow.houses`, over every district). */
  pooled: Iterable<PooledSkillHouse>;
  curve: SkillCurve;
}

/** FNV-1a over a string → [0, 1). A projection stagger only has to be
 *  deterministic for the AVERAGE to be — which member of a pooled house gets
 *  the practice cannot move a mean over the house. */
function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * ⚖️ A REGION'S AVERAGE SKILLS — per key, the population mean over EVERY
 * head: live bodies read through `skillMultiplier` on their own rows, pooled
 * households through the rows their prior would re-project (`projectHouseSkills`
 * on synthetic members — the average is invariant to who gets what), novices
 * at exactly 1. Keys with no practitioner anywhere are omitted; a reader
 * asking for one gets 1 (`regionalSkillMultiplier`).
 *
 * Deterministic: the live ledger is read in sorted cid order, pooled houses in
 * the order given, and every projected row is dealt by a hash of its own ids.
 */
export function regionalSkills(input: RegionalSkillInput): Record<string, RegionalSkill> {
  const virt = new Map<string, Map<string, BodySkillRow>>();
  for (const [cid, rows] of input.live) {
    const copy = new Map<string, BodySkillRow>();
    for (const [key, row] of rows) {
      const p = finitePractice(row);
      if (p > 0) copy.set(key, { practiceS: p });
    }
    if (copy.size) virt.set(cid, copy);
  }
  let heads = Math.max(Number.isFinite(input.liveHeads) ? Math.max(0, input.liveHeads) : 0, virt.size);
  let hi = 0;
  for (const house of input.pooled) {
    const members = Number.isFinite(house.members) ? Math.max(0, Math.floor(house.members)) : 0;
    heads += members;
    if (members > 0 && (house.skills || house.skillPins)) {
      const pinnedIds = Object.keys(house.skillPins ?? {}).sort().slice(0, members);
      const ids: string[] = [...pinnedIds];
      for (let m = ids.length; m < members; m++) ids.push(`~pool${hi}:${m}`);
      for (const r of projectHouseSkills(house, ids, (cid, key) => hash01(`${cid}|${key}`))) {
        virt.set(`~pool${hi}|${r.cid}`, r.rows);
      }
    }
    hi++;
  }
  if (!(heads > 0)) return {};
  const state: SkillState = { bodySkills: virt, skills: input.curve.skills, scale: input.curve.scale };
  const catalogue = input.curve.skills ?? DEFAULT_SKILL_CATALOGUE;
  // EVERY catalogue row is asked, not only the practised ones: a competence
  // can be INHERITED (a master refiner reads > 1 at carpentry with no carpentry
  // row anywhere), and the reader below is what says so.
  const keys = catalogue.rows.map((r) => r.key).sort();
  const cids = [...virt.keys()].sort();
  const out: Record<string, RegionalSkill> = {};
  if (cids.length === 0) return out; // a region of novices, fast — every key reads 1
  for (const key of keys) {
    let sumM = 0;
    let practitioners = 0;
    let sumLevel = 0;
    for (const cid of cids) {
      sumM += skillMultiplier(state, cid, key);
      if (finitePractice(virt.get(cid)!.get(key)) > 0) {
        practitioners += 1;
        sumLevel += skillEffectiveLevel(state, cid, key);
      }
    }
    // Every head without rows reads exactly 1 — the novice, the pre-slice tree.
    const multiplier = (sumM + (heads - cids.length)) / heads;
    if (!(practitioners > 0) && !(multiplier > 1)) continue;
    out[key] = {
      share: practitioners / heads,
      level: practitioners > 0 ? sumLevel / practitioners : 0,
      multiplier,
    };
  }
  return out;
}

/**
 * ⚖️ THE CENSUS CADENCE. A region's average is a slow statistic — practice
 * accrues a second per second and a household folds every few hundred — so
 * it is taken at most once per `REGIONAL_CENSUS_PERIOD_S` of the caller's
 * clock and read from the same table until then. The hot seats (the
 * director's clock arm every frame, the barter signals every quote) would
 * otherwise walk the whole ledger and re-project every pooled household
 * per frame, which is a census per frame for a number that cannot move
 * inside one. Sixty sim-seconds is far below any mastery rung on any shipped
 * dial (the shortest is `hauling`, 100 h ÷ 180 = 2 000 s), so nothing a reader
 * can see moves between two censuses.
 *
 * Keyed on the caller's own object (a session), never on time alone, so two
 * sessions in one process (a test, a cluster) never read each other's table.
 * Byte-deterministic in the clock sequence: the same frames take the same
 * censuses.
 */
export const REGIONAL_CENSUS_PERIOD_S = 60;

const CENSUS = new WeakMap<object, { at: number; value: Record<string, RegionalSkill> }>();

/** The region's average, cached per `key` for `REGIONAL_CENSUS_PERIOD_S` of
 *  `clock`; `input` is only called when the census is retaken. A clock that
 *  runs backwards (a reload, a rewind) retakes it. */
export function regionalSkillsAt(
  key: object,
  clock: number,
  input: () => RegionalSkillInput,
): Record<string, RegionalSkill> {
  const now = Number.isFinite(clock) ? clock : 0;
  const hit = CENSUS.get(key);
  if (hit && now >= hit.at && now - hit.at < REGIONAL_CENSUS_PERIOD_S) return hit.value;
  const value = regionalSkills(input());
  CENSUS.set(key, { at: now, value });
  return value;
}

/** THE ONE REGIONAL READER — ≥ 1 always; an unlisted key is a region of
 *  novices at it. */
export function regionalSkillMultiplier(
  regional: Readonly<Record<string, RegionalSkill | number>> | null | undefined,
  key: string | null | undefined,
): number {
  if (!regional || !key) return 1;
  const v = regional[key];
  const m = typeof v === "number" ? v : v?.multiplier;
  return typeof m === "number" && Number.isFinite(m) && m > 1 ? m : 1;
}

// ---------------------------------------------------------------------------
// The closed form — a town nobody runs has the skills its land calls for
// ---------------------------------------------------------------------------

/**
 * ⚖️ THE CLOSED FORM: a never-run settlement's average multiplier per skill
 * off WHAT ITS LAND YIELDS, per good (`PartnerGeography.yields` — the packed
 * catalogue at its cell, `planet/packing.ts landYieldsAt`). Every good names
 * the skill that makes it through `skillOfGood` — the SAME catalogue function
 * the trade seat prices with — and a skill's workforce share is the presence
 * of the goods it makes over the presence of everything the land yields. The
 * practitioners are at mastery (a settled town has worked its trade for
 * years), so the multiplier is `1 + (gain − 1) × share`.
 *
 * NO TABLE. A forest cell packs oaks ⇒ wood ⇒ felling (and block ⇒ carpentry
 * over the ratio); a banana grove ⇒ banana ⇒ foraging; a cell where the rock
 * row one day declares its ore tolerance ⇒ stone ⇒ mining, once the catalogue
 * carries that row — nothing here changes for any of it. User law 2026-09-11:
 * "all simulation should treat each good as its own thing individually".
 *
 * A record with no yields, or none above zero, reads `{}`: a region of
 * novices, byte for byte as the stub shipped — a tier that knows nothing
 * about its neighbour must not be made to pretend it does.
 *
 * Pure in `(geo, catalogue)`; keys sorted.
 */
export function geographySkillMultipliers(
  geo: PartnerGeography | null | undefined,
  catalogue: SkillCatalogue = DEFAULT_SKILL_CATALOGUE,
): Record<string, number> {
  const yields = geo?.yields;
  if (!yields) return {};
  const bySkill = new Map<string, number>();
  let total = 0;
  for (const good of Object.keys(yields).sort()) {
    const v = yields[good];
    if (typeof v !== "number" || !Number.isFinite(v) || !(v > 0)) continue;
    total += v;
    const key = skillOfGood(good, catalogue);
    if (!key) continue;
    bySkill.set(key, (bySkill.get(key) ?? 0) + v);
  }
  if (!(total > 0)) return {};
  const out: Record<string, number> = {};
  for (const key of [...bySkill.keys()].sort()) {
    const def = catalogue.get(key);
    if (!def) continue;
    const share = bySkill.get(key)! / total;
    const m = 1 + (multiplierOf(1, def.gain) - 1) * share;
    if (m > 1) out[key] = m;
  }
  return out;
}
