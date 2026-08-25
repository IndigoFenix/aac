// shared/world-engine/interaction/behavior/needs.ts
//
// NEED TEMPLATES — needs as DATA over one generic walker (semantic-behavior.md,
// elemental-actions-emergent-plans.md §3: bounded physical substrate + open, moddable
// needs). This replaces the hard-coded eating brain (the old eating.ts `decideEating`)
// with the general machine it was one hand-compiled instance of:
//
//   a TEMPLATE says WHAT the creature wants — an item TYPE (`NeedTarget`, the same
//   vocabulary the economy's goods and `ItemRef` speak), what makes the want fire (a
//   rising METER like hunger, or a STOCK condition like "pantry below the surplus
//   buffer"), how it is SATISFIED (an elemental effect: consume at a preferred station,
//   or deposit into a container role), and the ordered OR-BRANCHES for ACQUIRING the
//   item (own container first, then buy at a source).
//
//   the WALKER (`decideNeed`) re-decides ONE intent per step from current state — never
//   a stored script — so any disruption (item gifted, stolen, already waiting) simply
//   re-routes on the next call. Adding a need (thirst, warmth, restocking wares) is a
//   new template row, not new code.
//
// PURE (no world geometry, no RNG, no time): the caller resolves the template's roles
// against the live world — which containers match the role, which sources sell the type,
// which stations afford the satisfy — pre-filtered to KNOWN + PERMITTED and ordered
// nearest-first, exactly the contract the old EatingCtx had. The walker only chooses.
// Ticking the meter (rate × dt) is also the caller's job; `rate` here is data.
//
// Step ④ (scope-behaviors.md) hands the ctx two more RESOLVED FACTS and no new
// world access: how far each candidate is (`StockCandidate.d` — the sort key
// the caller already computed) and the PRICE BOARD (`NeedPrice`) that says what
// a second of walking and a unit of goods are worth here. The choosing is still
// all this module does; it now subtracts a cost while it does it.
//
// The founding instances are FOOD (npc-behavior-and-town-economy.md §13a): `hunger`
// (meter → pantry-or-market → eat at the table) and `provision` (pantry below buffer →
// buy at the market → deposit at home). Their interplay is the emergent story: steal a
// pantry dry and the hungry member buys its meal while the runner restocks; gift food
// and the carried units get put away at home instead of a store trip (a deposit need
// fires whenever the creature is CARRYING matching units — housekeeping falls out).

import type { NeedTarget } from "@shared/world-engine/interaction/behavior/creatures.js";
import type { PlaceRef } from "@shared/world-engine/interaction/behavior/rules.js";
import {
  driveValueS,
  goodsValueS,
  journeyTimeS,
  netValueS,
  priceOf,
} from "@shared/world-engine/kernel/town/pricing.js";
import type { VerbCost } from "@shared/world-engine/kernel/town/scope-shape.js";

// ---------------------------------------------------------------------------
// The template — data, not code
// ---------------------------------------------------------------------------

/** WHEN a need fires. A `meter` rises over time (the caller ticks it at `rate`/sec) and
 *  fires at `threshold`; a `stock` need fires while the role container holds fewer than
 *  `below` matching units; a `mess` need fires while more than `above` matching LOOSE
 *  units lie around (the tidying chore — the caller lists them under `ctx.loose`).
 *  A deposit-satisfy need ALSO fires whenever the creature is carrying matching units
 *  (put them away), regardless of the drive. */
export type NeedDrive =
  | { kind: "meter"; rate: number; threshold: number }
  /** `of` (round 7): measure the container — and the hands, via
   *  `ctx.carriedOf` — in THIS category instead of the template's item
   *  category. The cook's drive watches MEALS at the table while the
   *  template acquires and transforms RAW food; counting the just-cooked
   *  meal still in hand is what stops the row from firing again before
   *  the serve row tables it (the loop's brake). */
  | { kind: "stock"; container: string; below: number; of?: string }
  | { kind: "mess"; above: number };

/** HOW the need is satisfied — an ELEMENTAL effect.
 *  `consume`: use one unit up, preferring stations of the listed kinds in order (a
 *  table — its food is visible), else consume in place. `deposit`: carry the units to
 *  the role container and put them in, topping it up to `upTo`. `rest`: dwell at a
 *  station of the listed kinds (a bed), else doze in place — no item involved —
 *  unless `requireStation` (a wash NEEDS the tub; nowhere to do it = blocked, never
 *  "in place"). `social`: seek a PARTNER (the caller resolves housemates as
 *  stations) and talk. `equip`: put the acquired unit ON the body (wear it) where
 *  you stand — the caller's effect swaps the worn garment out as a `.dirty` unit in
 *  hand, which is what feeds the laundry flow. `transform`: PROCESS carried units at
 *  a station of the listed kinds — the elemental effect drops/adds a STATE FACET on
 *  each unit's glyph (`drop: "dirty"` is the wash; `add: "hot"` will be the cook).
 *  Station-required by nature: no station = blocked, never "in place". `use`:
 *  fetch a unit through the acquire branches, SET IT OUT on open ground, and
 *  use it from around it — the eat shape minus the consumption, plus a place.
 *  This is how an AFFORDANCE-driven need is served (play with a toy, read a
 *  book): the thing used carries the function, so it may be taken out ANYWHERE,
 *  and it survives the using. What it becomes while out is a TEMPORARY STATION
 *  — anyone whose own want fires may join it from a free side, it counts as in
 *  use while ANY of them is still playing, and when the last one stops it is
 *  ordinary clutter again and the tidy chore puts it back. */
export type SatisfySpec =
  | { kind: "consume"; at?: readonly string[] }
  /** `orDrop`: when no container can take the units (none reachable, none this
   *  body may open, or the box is full), SET THEM DOWN where you stand instead
   *  of blocking. Getting rid of a thing has two honest answers — "put it away"
   *  and "put it down" — and a body that can't do the first must still manage
   *  the second, or it holds the thing forever. Essential for a GRASPLESS body
   *  (a dog can carry a ball in its mouth but can never open the toybox), and
   *  the general escape hatch for the unload row. */
  | { kind: "deposit"; container: string; upTo: number; orDrop?: boolean }
  | { kind: "rest"; at?: readonly string[]; requireStation?: boolean }
  | { kind: "social" }
  | { kind: "equip" }
  | { kind: "use" }
  | { kind: "transform"; at: readonly string[]; drop?: string; add?: string };

/** WHERE the item may be acquired — OR-branches tried in template order (the caller
 *  orders candidates within a branch nearest-first). `container` names a container
 *  ROLE the caller resolves ("home" = the creature's own house box for the item's
 *  type); `source` is any known store/stall selling the type (a buy); `loose` is a
 *  matching unit lying around (`ctx.loose` — the tidying pickup). */
export type AcquireSpec =
  | { kind: "container"; role: string }
  | { kind: "source" }
  | { kind: "loose" };

export interface NeedTemplate {
  /** Stable key, unique per creature ("hunger:food", "provision:food"). */
  key: string;
  /** The item TYPE that satisfies this need — the shared resource vocabulary. */
  item: NeedTarget;
  drive: NeedDrive;
  satisfy: SatisfySpec;
  acquire: readonly AcquireSpec[];
  /** When several needs fire at once, highest priority acts first (hunger beats
   *  restocking — comparable to CreatureNeed values, ~2–5). */
  priority: number;
  /** HOUSEHOLD-EXCLUSIVE: the ACQUISITION TRIP for this row is an errand the
   *  home needs done ONCE, not once per body — restocking the pantry. The row
   *  is open to every member (anyone may go), but exactly one CLAIMS it and
   *  the rest read `claimed: "other"` and stand down, so an empty pantry
   *  doesn't send the whole family to market. The caller owns the claim (and
   *  its release on completion/eviction); the walker only obeys it.
   *
   *  ⚠️ Gates the TRIP ONLY. A body already CARRYING units always deposits
   *  them regardless of who holds the claim — otherwise an unclaimed hauler
   *  would stand there holding its load forever. */
  exclusive?: boolean;
}

// ---------------------------------------------------------------------------
// The resolved context — the caller's step-by-step snapshot
// ---------------------------------------------------------------------------

/** A resolved container/source candidate: how many MATCHING units it holds now, and
 *  (for deposit targets) how many more it can take. */
export interface StockCandidate {
  id: string;
  place: PlaceRef;
  units: number;
  /** Units NOT SPOKEN FOR by another body (scope-behaviors.md §2.6 CLAIM):
   *  what an ACQUIRE branch may honestly plan against, as opposed to what is
   *  physically there. Absent = nobody has claimed anything, so it IS `units`.
   *
   *  ⚠️ The split is deliberate and both halves are load-bearing. `units` stays
   *  the real count because that is what a THRESHOLD means — a pantry below its
   *  floor is short whether or not a housemate has claimed the market's apples,
   *  and reading claims into the fire check would silence the very row that
   *  fixes the shortage. `free` is what a PLAN may draw, because two bodies
   *  reading the same three apples is the arrival race this exists to kill. */
  free?: number;
  /** Remaining capacity for deposits; absent = unbounded. */
  room?: number;
  /** ⚖️ WHAT THIS UNIT IS WORTH *WHERE IT LIES*, in hand-seconds — the resolved
   *  side of `forgoneS` (scope-behaviors.md §3), and the first real one in the
   *  engine. Not "who owns it" but "what does it SERVE here": a teddy on the
   *  floor of a room with a bored body in it is a game in progress, and the box
   *  it belongs in is worth less than the game.
   *
   *  The CALLER answers it, because the caller is the only side that can match
   *  a glyph against another row's item spec / affordance — it walks the
   *  household's own row set, exactly the way `inUseByLiveNeed` walks it for
   *  the boolean this number generalizes. Absent = nothing is served by this
   *  unit lying here, which is the ordinary case and prices at zero.
   *
   *  Charged to REMOVING plans only (`forgoneOf`), so the row that wants the
   *  thing where it is never pays for wanting it. */
  servesS?: number;
  /** METRES from the deciding body (step ④): the ONE new fact the comparison
   *  needs. The lists were already ordered nearest-first, so the number was
   *  always computed and then thrown away — keeping it is what lets a trip be
   *  PRICED instead of merely sorted. Absent = the caller models no geometry,
   *  and the leg prices at zero (a headless probe compares value only). */
  d?: number;
  /** ⚖️ IS DRAWING FROM HERE *IMPROPER* FOR THE ROW THAT IS DECIDING? — the
   *  resolved side of `PROPRIETY_PENALTY_S`, and the third fact the caller
   *  hands over on a candidate (`d`, `free`/`servesS` are the others).
   *
   *  Propriety is a question about a BOX, not about a unit: a pantry chest is
   *  where the household's food LIVES, a set-down basket is a tool somebody
   *  left standing, a housemate's private box is somebody else's. All three
   *  may hold an apple; only the first is where a meal is supposed to come
   *  from. Which is which is a world question — roles, ownership, whose place
   *  at the table this is — so the CALLER answers it per ROW and this module
   *  only reads the flag, exactly as it reads `servesS`.
   *
   *  ⚠️ NOT A PERMISSION. `mayUse` has already refused everything this body may
   *  not touch before a candidate is listed at all; what is left here is
   *  PERMITTED-BUT-MAKESHIFT, and it is priced, never vetoed (see
   *  `PROPRIETY_PENALTY_S`). Absent = proper, which is the ordinary case and
   *  costs nothing. */
  improper?: boolean;
}

/** A resolved satisfy-station (a table…): `kind` matches `satisfy.at`; `waiting` is an
 *  unclaimed matching unit count already AT the station (lets acquire+consume combine —
 *  go straight there and eat). */
export interface StationCandidate {
  id: string;
  place: PlaceRef;
  kind: string;
  waiting: number;
  /** METRES from the deciding body — see `StockCandidate.d`. */
  d?: number;
}

/** THE PRICE BOARD (scope-behaviors.md §3, step ④) — the four numbers a row
 *  needs before `value − cost` can be spoken in HAND-SECONDS. The caller owns
 *  every one of them (they are world facts: a gait, a fill clock, a shelf's
 *  emptiness, a dwell), so this module stays pure arithmetic over them.
 *
 *  ABSENT = UNPRICED, and that is a first-class state: a row with no price
 *  board scores value 0 against cost 0, so a whole set of unpriced rows TIES
 *  and the tie-break — `tpl.priority`, then template order — decides exactly
 *  as it always has. Headless probes and the pure walker tests therefore keep
 *  the shipped behaviour byte for byte whether the flag is on or off; only a
 *  caller that hands over real geometry buys the arithmetic. */
export interface NeedPrice {
  /** The body's gait — `journeyS = d / walkMps`. */
  walkMps: number;
  /** The drive's own fill clock (scale.ts `needFillS`): the CEILING on what
   *  serving it can be worth, per the chapter's "over-urgent never buys more
   *  than the whole clock". */
  fillS: number;
  /** What ONE unit of this row's good is worth to whoever it is destined for,
   *  in hand-seconds — the value of the drive that unit will serve. This is
   *  the JOIN the chapter names (§3): a ration's worth to a hungry body and to
   *  the household's shelf are the same number, discounted by `shortage`. */
  unitValueS: number;
  /** How badly the destination wants units: `room / capacity` on the shelf
   *  this row fills (1 = empty, 0 = full) — the same `1 − got/need` shape
   *  barter's scarcity reads. */
  shortage: number;
  /** Hand-seconds each act occupies, by where it happens: reaching into a
   *  box, buying at a stall, bending for a loose thing, and the satisfying
   *  act itself (the nap, the meal, the scrub). */
  handsS: { container: number; source: number; loose: number; satisfy: number };
  /**
   * ⚖️ THE FREED-HANDS TERM — what EMPTYING THE HANDS is worth to this body,
   * in hand-seconds (stocking-offload-and-carry.md §3.2, mechanism ①).
   *
   * *(user direction, 2026-08-07, verbatim)*: "Continuing to hold an item
   * should be treated as a cost — dropping the item should be cheaper than
   * carrying it… they should drop it by default."
   *
   * The 2026-08-02 put-down row already spelled the cost as a WANT worth its
   * own ladder rung (`relieveTemplate`, 0.8 × NEED_PRESSURE_S = 32 s), and the
   * dirty-shirt arc is the bill for that number: 32 hand-seconds loses to every
   * real motive, so the shirt rode the hands to the toilet, through sleep, and
   * was washed only after waking. What was missing is not a bigger constant —
   * it is the OTHER SIDE of the trade. A body whose hands are its whole
   * inventory (`stackRoom` 0 with a thing in them) cannot take anything at all
   * while it holds one, so the carry is charged against WHATEVER IT IS ABOUT TO
   * DO. This is that charge, moved onto the row that removes it: the put-down's
   * value includes what the hands are worth free.
   *
   * The CALLER resolves it, like every other term here — it is a question about
   * this body's live wants, and this module holds no meters. Absent (or 0) ⇒
   * the row is worth exactly its own rung, which is the shipped number, so a
   * headless probe and an idle body decide precisely as they always did.
   *
   * ⚠️ Only ever added to an intent that actually EMPTIES the hands (`dropHere`
   * / `deposit` — see `rowValueS`). A row that merely walks somewhere frees
   * nothing and must not be paid for it.
   */
  freedHandsS?: number;
}

/** Everything `decideNeed` reads for ONE template, resolved fresh each step. Candidate
 *  lists are pre-filtered (known + permitted + matching the template's item type) and
 *  ordered nearest-first; `containers` is keyed by role. */
export interface NeedCtx {
  /** Current meter value (meter drives; ignored for stock drives). */
  meter?: number;
  /** Matching units the creature is carrying right now. */
  carried: number;
  /** Carried units of a stock drive's `of` category (the caller resolves
   *  it when the drive names one) — see NeedDrive. */
  carriedOf?: number;
  /** Role → that container, resolved (own pantry under "home"…). Missing role = the
   *  creature knows no such container. */
  containers: Readonly<Record<string, StockCandidate>>;
  /** Known sources selling the item type, nearest-first. */
  sources: readonly StockCandidate[];
  /** Stations affording the satisfy, nearest-first (consume needs only). */
  stations: readonly StationCandidate[];
  /** Matching LOOSE units lying around, nearest-first (mess drives / `loose`
   *  acquire branches — each candidate is one pickup, usually `units: 1`). */
  loose?: readonly StockCandidate[];
  /** How many more units this body can physically take on — the room left in
   *  the container it is carrying or wearing, else ONE if its hands are free
   *  (scope-shape.ts `stackRoom`). Absent = unbounded (what headless callers
   *  that model no body get). Every take is capped by it, so "bring a basket
   *  to market" is a real decision rather than a script. */
  room?: number;
  /** THE RESTOCK TARGET: how many units of this item the HOUSEHOLD wants on
   *  hand. It is what makes a trip worth taking — a body that has walked all
   *  the way to the market fills the bag to this, instead of buying the single
   *  bite it happens to want right now and walking home. Only ever applied to
   *  a `source` branch (a trip off the property); taking from your own pantry
   *  stays one unit, because the pantry is already home. */
  restock?: number;
  /** For an `exclusive` template: does THIS body hold the household's claim on
   *  the errand? `"other"` = a housemate has it, so this row stands down. */
  claimed?: "self" | "other";
  /**
   * ⚖️ THE DROP LAW'S WORLD QUESTION (stocking-offload-and-carry.md §3.1),
   * resolved by the caller: **would setting this thing down WHERE THE BODY
   * STANDS still leave it counted by the scope that owns it?**
   *
   * The user asked for the concept in a scope-ambiguous shape — *"if dropping
   * the item would not constitute losing it (consider a scope-ambiguous way of
   * expressing this concept)"* — so the answer is a scope-tree question the
   * host owns (`dropKeepsItem`), never an interior test, and this module only
   * reads the boolean.
   *
   * THREE STATES, and the third is the shipped one:
   *   `true`   a drop here keeps it ⇒ the put-down row takes the FLOOR rather
   *            than walking to a box (a drop's leg is never dearer than a
   *            deposit's — 0 ≤ d — so the comparison is settled once, here).
   *   `false`  a drop here LOSES it ⇒ the row may not drop at all: it deposits
   *            if it has anywhere to, else the want simply surfaces. (The
   *            market walk keeps the basket.)
   *   absent   NOT ASKED — every row but the put-down one, and every unpriced
   *            probe. `orDrop` behaves exactly as it always has.
   */
  dropKeepsItem?: boolean;
  /** THE PRICE BOARD (step ④) — absent = unpriced, see `NeedPrice`. */
  price?: NeedPrice;
}

// ---------------------------------------------------------------------------
// Intents — one bounded step, re-decided every call
// ---------------------------------------------------------------------------

export type NeedIntent =
  | { kind: "idle" } // the need isn't firing
  | { kind: "take"; from: StockCandidate; units: number } // go there, take/buy this many
  | { kind: "consumeAt"; station: StationCandidate } // go there, consume one unit (carried or waiting)
  | { kind: "consumeHere" } // no station — consume where you stand
  | { kind: "deposit"; into: StockCandidate; units: number } // go there, put the carried units in
  | { kind: "dropHere"; units: number } // nowhere to put them away — set them down where you stand
  | { kind: "restAt"; station: StationCandidate } // go there, dwell out the rest (a bed)
  | { kind: "restHere" } // no bed — doze where you stand
  | { kind: "setOutHere" } // set the carried item out on the floor here — a play area others may join
  | { kind: "socialize"; station: StationCandidate } // go to this partner and talk
  | { kind: "equipHere" } // put the carried unit on where you stand (wear it)
  | { kind: "processAt"; station: StationCandidate } // go there, transform the carried units
  | { kind: "blocked" }; // firing, but no branch can supply — surfaces (never crashes)

/** Does the need FIRE right now? (Deposit needs also fire while carrying — put it away.)
 *
 *  ⚠️ THE LIVELOCK INVARIANT: the put-it-away rule fires on ANY matching
 *  carried unit — it cannot know WHY the unit is in hand (the walker is
 *  stateless by design). So any template that ACQUIRES type-X units for its
 *  own ends MUST carry a HIGHER priority than every deposit-shaped template
 *  for X, or the moment it picks the unit up, the deposit row outranks it and
 *  banks the unit right back where it came from — a take⇄deposit spin, forever
 *  (hunger 5 > provision 3 obeys this; adoption rows must sit above 3 too). */
export function needFires(tpl: NeedTemplate, ctx: NeedCtx): boolean {
  if (tpl.satisfy.kind === "deposit" && ctx.carried > 0) return true;
  // A transform need also fires while carrying — units in hand that want
  // processing (the doffed dirty shirt walks itself to the tub).
  if (tpl.satisfy.kind === "transform" && ctx.carried > 0) return true;
  switch (tpl.drive.kind) {
    case "meter":
      return (ctx.meter ?? 0) >= tpl.drive.threshold;
    case "stock": {
      const c = ctx.containers[tpl.drive.container];
      // An unknown/missing container reads as empty — the need fires and the walker
      // routes to acquisition (or blocks), rather than silently never firing.
      // A drive measured in another category (`of`) counts THAT category's
      // carried units instead (the cook's in-hand meal counts, its raw
      // apple doesn't).
      const inHand = tpl.drive.of !== undefined ? ctx.carriedOf ?? 0 : ctx.carried;
      return (c?.units ?? 0) + inHand < tpl.drive.below;
    }
    case "mess":
      // Clutter on the floor — fires while more than `above` loose units lie
      // around. (Carried units already fire the deposit rule above.)
      return (ctx.loose ?? []).reduce((s, c) => s + c.units, 0) > tpl.drive.above;
  }
}

// ---------------------------------------------------------------------------
// THE COMPARISON — value − cost, in hand-seconds (scope-behaviors.md §2.3
// PREFER, §3 the currency, §5 seats 1–2; step ④ of scope-unification.md)
// ---------------------------------------------------------------------------
//
// The surveys' verdict on this file was blunt: "No cost, no value, no
// comparison" — an 18-constant hand-authored ladder, a first-match branch
// order, and five timers standing in for economics. What follows is the
// missing subtraction, and NOTHING ELSE: the formulas live once, in
// kernel/town/pricing.ts (`journeyTimeS`/`driveValueS`/`goodsValueS`/
// `netValueS`), so a body's market trip and a caravan's route are the same
// arithmetic at different constants. This module only ASSEMBLES the terms
// from the ctx the caller resolved.
//
// 🚨 WHAT THE MODEL DOES *NOT* HAVE, stated out loud. The value of serving a
// drive is `urgency × the drive's own fill clock` (§3), and the fill clock
// says how OFTEN a need comes back, never how BADLY it presses. Taken alone
// it INVERTS the ladder — hygiene's 700 s clock would outrank hunger's 240 s,
// so a starving body would go and bathe. The engine holds exactly one datum
// that ranks drives against each other, and it is `NeedTemplate.priority`.
// So the ladder is what the value side CONVERTS INTO SECONDS
// (`NEED_PRESSURE_S`) rather than what it replaces, and the fill clock plays
// the role the chapter actually gives it: the CEILING ("over-urgent never
// buys more than the whole clock"). The ladder therefore does not die in this
// pass — it changes units, and the cost it never had is now subtracted from
// it. §4's indictment list is only partly collected; the report says which.

/** STEP ④'S MASTER SWITCH (the `NEED_PURSUITS_ENABLED` pattern): rank rows and
 *  acquire branches by `value − cost` instead of by the priority ladder and
 *  first-match branch order. OFF reverts BOTH seats to the shipped behaviour,
 *  byte for byte — the kill-switch, and the reason every new test pins both
 *  paths. Callers may override per decide (`NeedDecideOpts.costSelection`). */
export const NEED_COST_SELECTION = true;

/** Per-call override of the module switch — the tests' handle on both paths. */
export interface NeedDecideOpts {
  costSelection?: boolean;
  /**
   * SEAT 5 — DEFER (scope-behaviors.md §2.5, §7 step 5). "Is this row PARKED
   * on a wake condition?" — asked BEFORE the row is resolved, so a parked row
   * costs nothing at all: no ctx, no world search, no pricing.
   *
   * The chapter's form is "a failed plan prices at ∞ and loses the argmax
   * until the world changes". Pricing it at ∞ would still pay for the ctx that
   * discovers the ∞, every decide, forever — and the ctx is the expensive half
   * (a market read, a container sweep, a loose-prop scan). So the ∞ is applied
   * one level up, as a skip, and the CALLER owns both the park and the wake
   * condition, because "the world changed" is a world question.
   *
   * ⚠️ A PARKED ROW IS STILL A WANT. It surfaces as `blocked` — the top unmet
   * want the caller reads for adoption, the beg bubble and diagnostics — for
   * exactly the reason a shelf with nothing on it does: the drive is real and
   * nothing here can serve it. Silently dropping it would make a parked hunger
   * invisible to the housemate who would have brought it food, which is the
   * one thing the cooldowns this replaces never did.
   */
  parked?: (tpl: NeedTemplate) => boolean;
}

const costed = (opts?: NeedDecideOpts): boolean => opts?.costSelection ?? NEED_COST_SELECTION;

/**
 * SECONDS OF HAND-TIME ONE POINT OF DRIVE PRESSURE IS WORTH — the exchange
 * rate that turns the priority ladder into the currency (see the block note
 * above). 40 s/point puts the whole shipped ladder inside one hunger clock
 * (hunger 5 × 40 = 200 < 240), so the fill-clock ceiling only ever binds on a
 * drive left to run PAST its threshold — which is exactly when it should.
 *
 * The spacing it produces is the thing to judge it by, because the spacing IS
 * the exchange between a want and a walk: neighbouring rungs sit 8 s apart
 * (hunger 200 / thirst 192) ⇒ a drink 13 m nearer than a meal is drunk first;
 * hunger to energy is 40 s ⇒ a nap wins over food more than ~64 m away, and
 * then the meter climbs and the trip wins on the next decide. Chores stay
 * chores: tidy (48) cannot outbid hunger until the meal is 240 m off.
 */
export const NEED_PRESSURE_S = 40;

/**
 * ⚖️ THE PRICE OF DRAWING FROM SOMEWHERE YOU SHOULDN'T — one ladder rung, in
 * hand-seconds, charged to a candidate the deciding row has no business
 * treating as a larder (`StockCandidate.improper`).
 *
 * *(user direction, 2026-08-03, verbatim)*: "It shouldn't be invisible to
 * them, but they should have a reduced tendency to use them. For now, a
 * constant reduction in priority will do; **we'll expand on this once we get
 * into more detailed private property and personality rules**."
 *
 * WHAT THIS IS A PLACEHOLDER FOR, stated so the next pass doesn't have to
 * guess: the expansion axis is a PER-RELATIONSHIP / PER-PERSONALITY GRADING OF
 * THIS SAME TERM. A body that gets on badly with the housemate whose box it is
 * eyeing pays more; a brazen one pays less; a starving stranger in a famine
 * pays less again. Nothing about the seat changes when that lands — the number
 * stops being a constant and starts being a function of (taker, owner,
 * disposition), and it goes on being subtracted in exactly this one place.
 * That is why it is a CONSTANT and not a filter: a filter would have to be
 * rewritten to grade, and would meanwhile make the basket invisible, which is
 * the one thing the direction rules out.
 *
 * THE EXCHANGE, which is what to judge the number by: at `NEED_PRESSURE_S = 40`
 * one point of the priority ladder is 40 hand-seconds, so this is **exactly one
 * full priority point** — the direction's "constant reduction in priority",
 * spelled in the currency. At the shipped villager gait (1.6 m/s) it buys about
 * **64 m of extra walking**: a body will go two thirds of a street further to
 * eat out of the pantry than out of the basket at its feet, and no further. It
 * is a PREFERENCE, never a wall — an improper candidate that is the only offer
 * in the world is still taken, and the row never blocks on propriety alone.
 */
export const PROPRIETY_PENALTY_S = 40;

/** Two priced rows are "equal" inside this many hand-seconds — the tie the
 *  ladder then breaks, and the gap a capped bank row keeps below its acquirer. */
const RANK_EPS = 1e-3;

/**
 * THE DRIVE'S PRESSURE — how hard this row is pushing, in units of its own
 * threshold. 1 at the firing point by construction, and it KEEPS GROWING past
 * it (a body that could not eat is hungrier every second), which is what makes
 * a neglected want eventually outbid a fresh one. `driveValueS` clamps it, so
 * the growth buys at most the whole fill clock.
 *
 *   meter  `meter / threshold` — the meter IS the deficit, in cycles owed. A
 *          zero threshold (an always-firing derived row — `attend` at a ritual,
 *          `address:<who>` in a conversation) presses exactly once: there is no
 *          deficit to measure, only a duty. Which is why such a row is decided
 *          entirely by its PRIORITY, and why the ⑫⑧ address row carries its
 *          "somebody just asked me" bonus there rather than in a meter nobody
 *          would ever tick down.
 *   stock  `1 − held / below` — the shortfall FRACTION, so a shelf one unit
 *          short presses gently and an empty one presses flat out. Counts what
 *          is in hand (the drive's `of` category when it names one) exactly as
 *          `needFires` does, or the cook's own pot would read as missing.
 *   mess   `loose / above − 1` — how far past the tolerated clutter the room
 *          is. A zero tolerance (`above: 0`, the tidy/laundry rows) has no
 *          fraction to take: any unit at all is full pressure. Carried units
 *          count, because carrying one is a firing reason in its own right.
 */
export function urgencyOf(tpl: NeedTemplate, ctx: NeedCtx): number {
  switch (tpl.drive.kind) {
    case "meter": {
      const threshold = tpl.drive.threshold;
      if (!(threshold > 0)) return 1;
      return Math.max(0, (ctx.meter ?? 0) / threshold);
    }
    case "stock": {
      const below = tpl.drive.below;
      if (!(below > 0)) return 1;
      const inHand = tpl.drive.of !== undefined ? ctx.carriedOf ?? 0 : ctx.carried;
      const held = (ctx.containers[tpl.drive.container]?.units ?? 0) + inHand;
      return Math.max(0, Math.min(1, 1 - held / below));
    }
    case "mess": {
      const loose = (ctx.loose ?? []).reduce((s, c) => s + c.units, 0) + ctx.carried;
      if (!(tpl.drive.above > 0)) return loose > 0 ? 1 : 0;
      return Math.max(0, loose / tpl.drive.above - 1);
    }
  }
}

/** What a PLAN may draw from a candidate: the units nobody else has spoken
 *  for. Every acquisition path goes through this; every THRESHOLD path reads
 *  `units` instead (see `StockCandidate.free`). */
const availableUnits = (c: StockCandidate): number => c.free ?? c.units;

/** Which acquire branch a resolved candidate came from. The ctx lists hold the
 *  very objects the intent carries, so identity answers it — which keeps the
 *  branch off `NeedIntent` (its shape is pinned by callers and tests). */
function branchOfCandidate(ctx: NeedCtx, c: StockCandidate): AcquireSpec["kind"] {
  if (ctx.sources.includes(c)) return "source";
  if ((ctx.loose ?? []).includes(c)) return "loose";
  return "container";
}

/** One priced leg: the walk there, the hands the act occupies, and — for a
 *  plan that LIFTS A UNIT OUT OF ITS PLACE — what that placement was serving
 *  (`forgoneOf`). `spoilageS` is still 0 everywhere (chapter §3). */
function legCost(ctx: NeedCtx, d: number | undefined, handsS: number, forgoneS = 0): VerbCost {
  const p = ctx.price;
  if (!p) return priceOf({});
  return priceOf({ journeyS: journeyTimeS(d ?? 0, p.walkMps), handsS, forgoneS });
}

/**
 * THE FORGONE TERM (scope-behaviors.md §3) — what a plan DESTROYS by taking a
 * unit out of the place it lies in. Chapter §3 left it at 0 with a note that
 * the argmax would produce it; the reported container → floor → container loop
 * is what proved the note wrong. Both rows there reach for the SAME teddy at
 * the SAME distance, so the legs cancel exactly and nothing anywhere says the
 * toy is worth more on the floor, mid-game, than filed in the box. This is
 * that number.
 *
 * Two halves, and the split is the whole design:
 *   • WHAT the unit serves where it lies is a world question about glyphs,
 *     affordances and housemates' meters — so the caller answers it and hands
 *     the answer over on the candidate (`StockCandidate.servesS`), exactly as
 *     it hands over `d` and `free`.
 *   • WHO PAYS is a decision question and lives here: only a REMOVING plan.
 *     A `deposit` satisfy is the whole relocate family (tidy's sweep, a stow,
 *     a bank) — it moves the unit somewhere else, so whatever it was doing
 *     where it lay stops. Every other satisfy USES the unit where the value
 *     is; that value is the thing being protected, never the thing being
 *     spent, so it is charged nothing. Charging both sides would deadlock the
 *     pair instead of deciding between them.
 *
 * Unpriced ctx ⇒ 0, like every other term, so the flag-off ladder and the
 * headless probes stay byte-identical.
 */
function forgoneOf(tpl: NeedTemplate, ctx: NeedCtx, from: StockCandidate): number {
  if (!ctx.price || tpl.satisfy.kind !== "deposit") return 0;
  return Math.max(0, from.servesS ?? 0);
}

/**
 * ⚖️ THE PROPRIETY TERM — what this candidate costs for being the WRONG PLACE
 * to draw from, as opposed to a far one or an empty one.
 *
 * Symmetrical with `forgoneOf` in shape and deliberately so: the caller
 * resolves the world question onto the candidate (`improper`), and the
 * decision question — WHEN it is charged — lives here. It is charged on EVERY
 * acquiring row, not just the removing family, because "where may I properly
 * take this from" is a question a meal asks as much as a chore does.
 *
 * Unpriced ctx ⇒ 0, like every other term, so a headless probe and the
 * flag-off ladder stay byte-identical.
 */
function proprietyOf(ctx: NeedCtx, from: StockCandidate): number {
  return ctx.price && from.improper ? PROPRIETY_PENALTY_S : 0;
}

/**
 * THE PRICE OF AN INTENT — the `VerbCost` of doing this one bounded thing.
 * Unpriced ctx ⇒ every term is 0, which is what keeps the flag-on path
 * identical to the flag-off one for callers that model no world.
 */
export function intentCost(tpl: NeedTemplate, ctx: NeedCtx, intent: NeedIntent): VerbCost {
  const h = ctx.price?.handsS;
  switch (intent.kind) {
    case "take": {
      const branch = branchOfCandidate(ctx, intent.from);
      return legCost(ctx, intent.from.d, h ? h[branch] : 0, forgoneOf(tpl, ctx, intent.from));
    }
    case "deposit":
      return legCost(ctx, intent.into.d, h?.container ?? 0);
    case "consumeAt":
    case "restAt":
    case "processAt":
    case "socialize":
      return legCost(ctx, intent.station.d, h?.satisfy ?? 0);
    case "consumeHere":
    case "restHere":
    case "equipHere":
    case "setOutHere":
    case "dropHere":
      // No leg — the act happens where the body already stands.
      return legCost(ctx, 0, h?.satisfy ?? 0);
    default:
      return priceOf({});
  }
}

/**
 * ⚖️ LAW ② — ONE ECONOMY, TWO ROLES (household-economy-and-where-is.md §2).
 *
 * *"Every acquire decision is made by either a CUSTOMER (a drive-serving row:
 * its want is its own — one ration, one drink) or an INVENTORY MANAGER (a
 * goods-moving/deposit row: its want is a shelf's shortfall). A customer
 * selects its source by COST alone; an inventory manager by `units ×
 * destination shortage × unit value − trip`."*
 *
 * THE DISCRIMINATOR IS THIS ONE LINE, and it is the one `goodsUnitsOf` has
 * always encoded: a `deposit` satisfy is the whole goods family — its trip, its
 * bank and its put-it-down all move stock for somebody else's shelf. Everything
 * else USES what it takes, for itself, right now.
 *
 * 🚨 NAMED ONCE so the seats can never drift. Three of them read it —
 * `goodsUnitsOf` (what a row's act is WORTH), `acquireFrom` (which stock to
 * draw from) and the host's `needShortageOf` (whether a destination's emptiness
 * discounts the row at all) — and the reported fridge stampede was exactly what
 * a disagreement between them costs: a below-capacity fridge outbid by the
 * market ~restock:1 for every member of the household independently.
 */
export function isGoodsRow(tpl: NeedTemplate): boolean {
  return tpl.satisfy.kind === "deposit";
}

/** The units a GOODS-shaped act moves, or null when the row is serving a drive
 *  directly (`isGoodsRow` is the rule). */
function goodsUnitsOf(tpl: NeedTemplate, intent: NeedIntent): number | null {
  if (!isGoodsRow(tpl)) return null;
  if (intent.kind === "take" || intent.kind === "deposit" || intent.kind === "dropHere") return intent.units;
  return null;
}

/**
 * WHAT THIS ROW'S ACT IS WORTH, in hand-seconds. Two arms, and the chapter's
 * §3 join is that they agree where they meet:
 *
 *   drive-serving  `urgency × the drive's own clock`, with the ladder as the
 *                  pressure weight (see the block note) — a full-blown want is
 *                  worth walking for, a barely-fired one is not.
 *   goods-moving   `units × shortage × what one unit is worth to whoever gets
 *                  it` — the same number the drive arm would produce for the
 *                  want that unit will serve, discounted by how little the
 *                  destination still needs it. `unitsPerFill` is 1 at the body
 *                  rung: one ration serves one hunger cycle, one bucket one
 *                  thirst. (A town shelf's draw is many-per-cycle; that is the
 *                  town rung's own pass.)
 *
 * …plus, on an act that EMPTIES THE HANDS, what the hands are worth free
 * (`NeedPrice.freedHandsS`). It is added to both arms because it is a fact
 * about the BODY, not about the goods: a put-down row that files a unit and one
 * that sets it on the floor free the same pair of hands.
 */
export function rowValueS(tpl: NeedTemplate, ctx: NeedCtx, intent: NeedIntent): number {
  const p = ctx.price;
  if (!p) return 0;
  // ⚖️ THE FREED-HANDS TERM (§3.2 mechanism ①) — see `NeedPrice.freedHandsS`.
  // Charged ONLY where the hands actually empty; a walk frees nothing.
  const freed =
    intent.kind === "dropHere" || intent.kind === "deposit" ? Math.max(0, p.freedHandsS ?? 0) : 0;
  const units = goodsUnitsOf(tpl, intent);
  if (units !== null) return goodsValueS(units, p.shortage, p.unitValueS, 1) + freed;
  const fillS = Math.max(1, p.fillS);
  return driveValueS((urgencyOf(tpl, ctx) * tpl.priority * NEED_PRESSURE_S) / fillS, fillS) + freed;
}

/** Best consume-station: the template's `at` kinds in preference order, else the nearest
 *  offered station of any kind. `needWaiting` restricts to stations with a unit ALREADY
 *  there (the combine case). */
function bestStation(
  tpl: NeedTemplate,
  stations: readonly StationCandidate[],
  needWaiting: boolean,
): StationCandidate | undefined {
  const pool = needWaiting ? stations.filter((s) => s.waiting > 0) : stations;
  const prefer =
    tpl.satisfy.kind === "consume" || tpl.satisfy.kind === "rest" || tpl.satisfy.kind === "transform"
      ? (tpl.satisfy.at ?? [])
      : [];
  for (const kind of prefer) {
    const hit = pool.find((s) => s.kind === kind);
    if (hit) return hit;
  }
  return pool[0];
}

/** A resolved draw: the candidate and the branch it came from. */
type Acquisition = { from: StockCandidate; branch: AcquireSpec["kind"] };

/** `acquireFrom`'s THIRD answer, new with `forgoneS`: there WERE candidates,
 *  and every one of them is worth more where it lies than the plan that would
 *  move it. "Nothing to tidy" and "nothing here worth tidying" are different
 *  facts and the walker must not confuse them — the first is a want with no
 *  supply (blocked), the second is no want at all (idle). */
const NOT_WORTH_IT = "notWorthIt" as const;

/** SEAT 2 (scope-behaviors.md §5.2) — WHERE TO DRAW FROM.
 *
 *  Flag OFF (the shipped rule): the FIRST acquire branch that can supply now,
 *  in the template's own preference order, first candidate within it. The
 *  survey's indictment of that rule, verbatim: "a pantry with 1 unit beats a
 *  market with 50, distance never enters".
 *
 *  Flag ON: argmax over EVERY non-empty candidate of
 *  `netValueS(goodsValueS(what this branch would actually move), the trip)`.
 *  Six lines, and "pantry 1 vs market 50" becomes arithmetic: the pantry's one
 *  unit is one unit however near it is, and a household five short outbids the
 *  walk.
 *
 *  ⚖️ AND WHICH OF THE TWO SEATS IS DECIDING (`isGoodsRow`, law ②). The
 *  valuation used to be GOODS-side for EVERY row — "the question this seat
 *  answers is 'which stock', not 'which want'" — and the reported dollhouse
 *  fridge stampede is the bill for that category error. A hunger row is a
 *  CUSTOMER: it wants one ration, so every offer that can hand it one is worth
 *  the same ration, and what separates them is the trip. Pricing its draw as a
 *  restock-sized haul discounted by the HOME shelf's emptiness made the market
 *  outbid a half-full fridge ~restock:1, for each member independently (hunger
 *  carries no `exclusive`), and four people walked out of a stocked house.
 *
 *  So the two roles value differently and nothing else changes:
 *    goods row   `takeUnits × p.shortage × unitValueS` — the shelf's shortfall
 *                is the want, and how empty the destination is IS the price.
 *    drive row   `min(want, available, room) × 1 × unitValueS` — the row's own
 *                want, never restock-inflated, and never discounted by how full
 *                its pantry happens to be. Offers that fully supply the want
 *                tie on value, so the argmax decides by COST — leg + hands +
 *                forgone + propriety — which is the customer law.
 *
 *  🚨 EXECUTION SIZING IS UNTOUCHED. `takeIntent`/`takeUnits` still fill the bag
 *  to the restock target at a source, so a body legitimately sent to the market
 *  by an EMPTY pantry still comes home with the week's food (the famine-fix
 *  banking behaviour). Only what the offers are WORTH to the comparison moved.
 *
 *  Enumeration order is unchanged either way (branches in template order,
 *  candidates nearest-first) and the argmax keeps the FIRST maximum, so an
 *  unpriced ctx scores every candidate 0 and lands on the same pick as the
 *  first-match rule — the byte-identical property the flag promises.
 *
 *  ⚖️ AND THE THIRD TERM: PROPRIETY (`PROPRIETY_PENALTY_S`). The food rows now
 *  reach places that are not larders — a set-down basket, the pet's bowl, a
 *  box that is somebody's own — and the direction is that those are seen and
 *  mildly avoided, never hidden. So an IMPROPER candidate simply prices one
 *  ladder rung worse and usually loses to the pantry; when the pantry is empty
 *  it wins, because an offer of nothing is still nothing. Flag OFF the same
 *  intent is carried by BRANCH ORDER instead — the makeshift branches sit last
 *  in every template, so first-match reaches them only as a last resort. */
function acquireFrom(
  tpl: NeedTemplate,
  ctx: NeedCtx,
  want: number,
  opts?: NeedDecideOpts,
): Acquisition | typeof NOT_WORTH_IT | undefined {
  const offers: Acquisition[] = [];
  for (const branch of tpl.acquire) {
    if (branch.kind === "container") {
      const c = ctx.containers[branch.role];
      if (c && availableUnits(c) > 0) offers.push({ from: c, branch: "container" });
    } else if (branch.kind === "loose") {
      for (const l of ctx.loose ?? []) if (availableUnits(l) > 0) offers.push({ from: l, branch: "loose" });
    } else {
      for (const s of ctx.sources) if (availableUnits(s) > 0) offers.push({ from: s, branch: "source" });
    }
    // FIRST-MATCH: the shipped rule stops at the first branch that offers
    // anything at all, and never looks at the ones behind it.
    if (!costed(opts) && offers.length > 0) return offers[0];
  }
  if (offers.length === 0) return undefined;
  const p = ctx.price;
  // WHICH SEAT IS DECIDING — asked once for the row, not per candidate (law ②,
  // `isGoodsRow`). An inventory manager prices a HAUL; a customer prices the
  // one thing it came for.
  const goodsRow = isGoodsRow(tpl);
  let best: Acquisition | undefined;
  let bestNet = -Infinity;
  for (const offer of offers) {
    // ⚠️ VALUATION UNITS, NOT THE TAKE. What the plan is worth and what the
    // hands come home with are the same number for a goods row and are NOT for
    // a customer: the drive's want is one ration whatever the trip brings back.
    const units = goodsRow
      ? takeUnits(ctx, offer.from, offer.branch, want, opts)
      : Math.min(want, availableUnits(offer.from), ctx.room ?? Infinity);
    const value = p ? goodsValueS(units, goodsRow ? p.shortage : 1, p.unitValueS, 1) : 0;
    const forgone = forgoneOf(tpl, ctx, offer.from);
    const worth = netValueS(value, legCost(ctx, offer.from.d, p ? p.handsS[offer.branch] : 0, forgone));
    // ⚖️ NEVER DESTROY MORE THAN YOU MAKE. A sweep whose forgone term swallows
    // its own value is not merely an expensive plan — it leaves the household
    // poorer than it found it, so it is not an OFFER at all, exactly as an
    // empty shelf is not an offer. Gated on a REAL charge, so every candidate
    // the engine could already see is priced and picked exactly as before.
    //
    // ⚠️ ASKED BEFORE THE PROPRIETY TERM, ON PURPOSE. This gate is the one
    // place a candidate can stop being an offer, and propriety must never be
    // able to reach it: "a reduced tendency" is a preference and a refusal is
    // a wall. So the placement question is settled on the plan's own worth,
    // and only then does the makeshift box pay for being makeshift.
    if (forgone > 0 && worth <= 0) continue;
    const net = worth - proprietyOf(ctx, offer.from);
    if (!best || net > bestNet) {
      bestNet = net;
      best = offer;
    }
  }
  return best ?? NOT_WORTH_IT;
}

/**
 * HOW MANY to take, given the branch that supplies it. This is the whole of
 * "creatures should keep stockpiles up":
 *
 *   a trip to a SOURCE is expensive — the walk is the cost, not the goods — so
 *   a body that gets there fills up to the household's RESTOCK target (bounded
 *   by what the shelf holds and by what the body can carry). One trip then
 *   feeds the family for days, and the surplus rides home in the bag where the
 *   deposit rows bank it.
 *
 *   taking from your OWN container (or picking one thing off the floor) stays
 *   at ONE: the pantry is already home, so hauling its contents around in a bag
 *   buys nothing and would just fight the deposit rows.
 *
 * `want` is the row's own minimum (1 for a bite, the shortfall for a deposit).
 */
function takeUnits(
  ctx: NeedCtx,
  from: StockCandidate,
  branch: AcquireSpec["kind"],
  want: number,
  opts?: NeedDecideOpts,
): number {
  const capacity = Math.min(availableUnits(from), ctx.room ?? Infinity);
  const target = branch === "source" ? Math.max(want, ctx.restock ?? 0) : want;
  const n = Math.min(target, capacity);
  // ⚠️ THE PHANTOM UNIT. Flag OFF, the take never rounds down to zero: a body
  // with a full bag still takes the one unit it came for, or the walker would
  // spin (fire → take 0 → fire). The survey found what that floor really buys
  // — "a body with zero room still ranks the take top and walks to the
  // source" — so under the comparison it DIES: a take that moves nothing is
  // worth nothing, loses the argmax honestly, and the row resolves BLOCKED
  // (the want surfaces, which is what a body with no free hands should do)
  // rather than walking a leg it cannot use. The spin is impossible here
  // because zero units is no longer an actionable intent at all.
  return costed(opts) ? Math.max(0, n) : Math.max(1, n);
}

/** The acquire leg as an intent — or BLOCKED when it would move nothing (see
 *  the phantom-unit note in `takeUnits`; only reachable under the flag). */
function takeIntent(
  ctx: NeedCtx,
  got: { from: StockCandidate; branch: AcquireSpec["kind"] },
  want: number,
  opts?: NeedDecideOpts,
): NeedIntent {
  const units = takeUnits(ctx, got.from, got.branch, want, opts);
  return units > 0 ? { kind: "take", from: got.from, units } : { kind: "blocked" };
}

/** A ONE-UNIT pickup (a toy, a raw unit for the pot): the same phantom-unit
 *  rule for the paths that never sized their take at all. */
function takeOne(ctx: NeedCtx, from: StockCandidate, opts?: NeedDecideOpts): NeedIntent {
  if (costed(opts) && (ctx.room ?? Infinity) <= 0) return { kind: "blocked" };
  return { kind: "take", from, units: 1 };
}

/**
 * Decide the next intent for ONE need from current state. Re-run every step — that IS
 * the robustness: lose the item and the next call routes back to acquisition; find one
 * already waiting at a station and it goes straight to consuming; get handed a stack
 * and a deposit need walks it home.
 */
export function decideNeed(tpl: NeedTemplate, ctx: NeedCtx, opts?: NeedDecideOpts): NeedIntent {
  if (!needFires(tpl, ctx)) return { kind: "idle" };

  // Rest: dwell at the preferred station (a bed); nowhere → doze in place —
  // unless the satisfy REQUIRES its station (a wash without a tub just blocks).
  if (tpl.satisfy.kind === "rest") {
    const st = bestStation(tpl, ctx.stations, false);
    if (st) return { kind: "restAt", station: st };
    return tpl.satisfy.requireStation ? { kind: "blocked" } : { kind: "restHere" };
  }
  // Social: seek the nearest PARTNER (the caller lists housemates as stations);
  // alone, the want just surfaces (blocked) until someone is around.
  if (tpl.satisfy.kind === "social") {
    const st = ctx.stations[0];
    return st ? { kind: "socialize", station: st } : { kind: "blocked" };
  }
  // Equip: a unit in hand goes ON where you stand (the change of clothes);
  // else fetch one through the acquire branches, and the next step wears it.
  if (tpl.satisfy.kind === "equip") {
    if (ctx.carried > 0) return { kind: "equipHere" };
    const got = acquireFrom(tpl, ctx, 1, opts);
    if (!got || got === NOT_WORTH_IT) return { kind: "blocked" };
    return takeIntent(ctx, got, 1, opts);
  }
  // Use: the item is USED rather than used up — and it is used AT A PLACE, not
  // in the hands. A toy comes out of the box, gets SET OUT in open ground, and
  // is played with from around it; that set-out thing is a TEMPORARY STATION
  // (the caller lists the ones currently in play under `stations`), which is
  // what lets several bodies share one toy from different sides instead of each
  // needing its own. Three states, re-decided every step:
  //
  //   • a play area already stands — mine, or one a housemate set out → GO AND
  //     JOIN IT. Station-first is what makes play social: the second bored body
  //     walks to the game rather than fetching a second ball.
  //   • the thing is in hand → SET IT OUT here, which is what makes the area.
  //   • empty-handed → fetch one through the acquire branches (the box, the
  //     floor), one at a time — you play with a ball, you don't buy six.
  //
  // The dwell reuses `restAt` so the host needs no new arrival branch; what
  // makes it PLAY rather than dozing is the motive, and the area retires by
  // itself when the last player stops (it stops being in use, so it is ordinary
  // clutter again and the tidy chore puts it away).
  if (tpl.satisfy.kind === "use") {
    const area = bestStation(tpl, ctx.stations, false);
    if (area) return { kind: "restAt", station: area };
    if (ctx.carried > 0) return { kind: "setOutHere" };
    const got = acquireFrom(tpl, ctx, 1, opts);
    if (!got || got === NOT_WORTH_IT) return { kind: "blocked" };
    return takeOne(ctx, got.from, opts);
  }
  // Transform: carried units get processed at the station (station-required —
  // no tub, no wash); empty-handed, fetch a unit first (the hamper/floor pile).
  // The station is checked BEFORE acquiring (round 7): never fetch what
  // can't be processed — a oven-less house's cook row blocks with empty
  // hands instead of standing forever holding a raw apple.
  if (tpl.satisfy.kind === "transform") {
    const st = bestStation(tpl, ctx.stations, false);
    if (ctx.carried > 0) return st ? { kind: "processAt", station: st } : { kind: "blocked" };
    if (!st) return { kind: "blocked" };
    const got = acquireFrom(tpl, ctx, 1, opts);
    if (!got || got === NOT_WORTH_IT) return { kind: "blocked" };
    // ONE unit per pass, whatever the branch: the cook's drive is paced by
    // what the table still wants, and a bag full of raw food would just make
    // the transform loop fire until the bag emptied.
    return takeOne(ctx, got.from, opts);
  }

  if (tpl.satisfy.kind === "consume") {
    // Carrying a unit → consume it, preferring the template's stations; nowhere → here.
    if (ctx.carried > 0) {
      const st = bestStation(tpl, ctx.stations, false);
      return st ? { kind: "consumeAt", station: st } : { kind: "consumeHere" };
    }
    // A unit already waiting at a station → acquire + consume COMBINE.
    const ready = bestStation(tpl, ctx.stations, true);
    if (ready) return { kind: "consumeAt", station: ready };
    // Otherwise acquire from the first branch that has any. THE STOCKPILE
    // RULE: one unit from your own pantry (it's already home), but a trip to
    // a SOURCE fills to the restock target — the walk to the market is the
    // expensive part, so you come back with the week's food, not one apple.
    const got = acquireFrom(tpl, ctx, 1, opts);
    if (!got || got === NOT_WORTH_IT) return { kind: "blocked" };
    return takeIntent(ctx, got, 1, opts);
  }

  // Deposit: carrying → put it away (bounded by the container's room); else acquire the
  // shortfall (bounded by what the branch holds) and the NEXT step deposits it.
  // A FULL container (room 0) with units in hand is BLOCKED, not idle: a full
  // pantry must be distinguishable from contentment — the want surfaces (beg,
  // adoption, diagnostics) instead of the haul silently living in the hands
  // forever (DEBUG-CREATURE-BEHAVIOR §4 — the "carries it around forever" bug).
  const home = ctx.containers[tpl.satisfy.container];
  const mayDrop = tpl.satisfy.orDrop === true;
  if (ctx.carried > 0) {
    // ⚖️ THE DROP LAW (§3.2): *"DROP-HERE beats the deposit WALK when both
    // fire."* A drop's leg is 0 by construction and a deposit's is `d ≥ 0`, so
    // there is nothing to recompute per decide — when the caller has answered
    // that a drop HERE keeps the thing, the floor is the cheaper answer to the
    // same question and the row takes it.
    //
    // 🚨 GATED ON `acquire.length === 0`, which is THE LIVELOCK INVARIANT this
    // file already runs on (`unloadTemplate`/`relieveTemplate`: "NO acquire
    // branches — it can never take anything, so it can never spin against the
    // row that did"). A row that can pick things up must never prefer the floor
    // to the box, or it would sweep a thing up and put it straight back down.
    // Belt and braces with the caller, which asks the question only for the row
    // whose subject is the idle held object.
    const dropsHere = mayDrop && ctx.dropKeepsItem === true && tpl.acquire.length === 0;
    // PUT IT AWAY if there is anywhere to put it; else PUT IT DOWN (orDrop).
    // A graspless body reaches this every time — it can hold a ball but can
    // never open the box — and without the drop it would carry the ball for
    // the rest of the session.
    //
    // ⚠️ …unless a drop here would LOSE it (`dropKeepsItem === false` — the
    // street, a stranger's house). Then "nowhere to put it" is the honest
    // BLOCKED: the want surfaces and the thing stays in hand until the body is
    // somewhere its own scope still counts it. Only the caller that asked the
    // question can reach this; every other row keeps `orDrop`'s old promise.
    const dropOrStuck = (): NeedIntent =>
      mayDrop && ctx.dropKeepsItem !== false
        ? { kind: "dropHere", units: ctx.carried }
        : { kind: "blocked" };
    if (!home) return dropOrStuck();
    const units = Math.min(ctx.carried, home.room ?? ctx.carried);
    if (units > 0) {
      return dropsHere ? { kind: "dropHere", units: ctx.carried } : { kind: "deposit", into: home, units };
    }
    return dropOrStuck();
  }
  // NEVER PICK SOMETHING UP TO PUT IT AWAY WHEN THERE IS NOWHERE TO PUT IT.
  // Without this, a tidier with no reachable box lifts the clutter, fails to
  // deposit, and a drop-capable row sets it down again — a pick-up/put-down
  // loop over the same object, forever. Empty-handed with no destination, the
  // chore simply doesn't start. (Carrying is handled above: units already in
  // hand must always be resolvable, which is what `orDrop` guarantees.)
  if (!home) return { kind: "blocked" };
  const shortfall = tpl.satisfy.upTo - (home.units ?? 0);
  if (shortfall <= 0) return { kind: "idle" };
  // THE HOUSEHOLD CLAIM — gates the TRIP, never the put-away. Restocking is a
  // job the home wants done once, not once per body, so a member whose
  // housemate is already out shopping stands down here. It is deliberately
  // below the carrying branch above: a body holding units ALWAYS gets to bank
  // them, claim or no claim, or an unclaimed hauler would carry its load
  // forever (the §4 "carries it around forever" bug, re-introduced by the
  // back door).
  if (tpl.exclusive && ctx.claimed === "other") return { kind: "idle" };
  const got = acquireFrom(tpl, ctx, shortfall, opts);
  // ⚖️ NOTHING WORTH TAKING IS NOT NOTHING TO TAKE. The clutter is there; it is
  // simply doing more good where it lies than it would in the box
  // (`forgoneOf`). So the chore doesn't start — and it must not surface as a
  // BLOCKED want either, because nothing is unservable: the moment the wanter's
  // meter empties, the very next decide sweeps the same unit with no cooldown,
  // no grace and no memory of having declined.
  if (got === NOT_WORTH_IT) return { kind: "idle" };
  if (!got) return { kind: "blocked" };
  // The restock row already wanted the whole shortfall; `takeUnits` now also
  // caps it by what the body can actually carry (a bounded bag = a bounded
  // trip, and the leftover shortfall simply fires the row again next trip).
  return takeIntent(ctx, got, shortfall, opts);
}

/**
 * SEAT 1 (scope-behaviors.md §5.1) — WHICH ROW ACTS. Across a creature's
 * templates: resolve each, keep the firing ones, act on the best. Returns the
 * chosen template + its intent, or null when nothing fires — the caller drives
 * ONE intent at a time, then re-decides.
 *
 * TWO RANKINGS, one switch (`NEED_COST_SELECTION`):
 *
 *   flag OFF  the shipped ladder — highest `tpl.priority` (ties → earlier
 *             template), with `BANK_PRIORITY` boosting a deposit row that
 *             fired because units are already in hand.
 *   flag ON   highest `netValueS(rowValueS, intentCost)` — what the act is
 *             worth minus what it costs, both in hand-seconds. Exact ties fall
 *             back to `tpl.priority`, then to template order, so a set of rows
 *             the arithmetic cannot separate (an UNPRICED ctx — see
 *             `NeedPrice` — separates none of them) decides exactly as it
 *             always did, BANKING BOOST INCLUDED. `BANK_PRIORITY` therefore
 *             stops deciding anything the arithmetic can settle: a haul in
 *             hand outbids a nap because the units are worth what they will
 *             serve and the walk home is short, which is the whole point.
 *
 * ⚠️ A BLOCKED ROW MUST NEVER SHADOW A SERVABLE ONE. `blocked` is a FIRING
 * intent — the want is real, it just can't be supplied here (no table for the
 * meal, no oven in the house, nobody home to talk to). Ranking it against the
 * actionable rows froze the body outright: one unservable row at priority 2.8
 * silenced fun (1), tidy (1.2) and every other row beneath it, and since a
 * block is self-sustaining (nothing about standing still un-blocks it) the
 * creature stood there doing nothing for the rest of the session — the
 * reported "BLOCKED / can't be served here, and they just stand there".
 *
 * So the two rankings are SEPARATE: `intent` is the best thing the body can
 * actually DO right now, and `blocked` is the top unmet want, returned
 * alongside for the caller to surface (adoption, the beg bubble, diagnostics).
 * Only when NOTHING is actionable does the blocked row become the decision —
 * which is the old behaviour, preserved for the genuinely stuck body.
 *
 * ⏸️ AND A PARKED ROW IS NEVER RESOLVED AT ALL (`NeedDecideOpts.parked`, §2.5
 * DEFER): it joins the blocked competition on template data alone, so a want
 * the world cannot serve yet costs one predicate instead of a ctx.
 */
/** THE BANKING PRIORITY — THE FLAG-OFF PATH ONLY (see `decideNeeds`). The
 *  effective rank of a deposit row that fired because units are ALREADY IN
 *  HAND (the put-it-away rule), as opposed to its trip. The trip is a chore
 *  (shop when comfortable — the row's own low priority); the BANK is finishing
 *  a haul that is otherwise lost to the economy. Observed famine trap: a body
 *  drew a restock-sized water haul at the well, and the leftover rode its bag
 *  for sim-minutes while rest-family motives (a 384 s sleep!) outranked
 *  provision's 3 every decide — the barrel never filled, so the household kept
 *  trekking to the well one throat at a time. 4.2 banks the haul ABOVE energy
 *  (4) but below waste (4.5) — the toilet doesn't wait — and below
 *  thirst/hunger (the starving body still serves itself first).
 *
 *  ⚠️ IT IS A COMPARISON SPELLED AS A MAGIC NUMBER (chapter §4.2), and under
 *  `NEED_COST_SELECTION` it is DEAD: a bucket in hand is worth what a thirst
 *  is worth (`NeedPrice.unitValueS`) times how empty the barrel is, which
 *  already outbids a nap by ~30 s of hand-time without anyone choosing 4.2.
 *  What survives the switch is the FLOOR under it — see `acquirerFloor`. */
export const BANK_PRIORITY = 4.2;

export function decideNeeds(
  templates: readonly NeedTemplate[],
  ctxOf: (tpl: NeedTemplate) => NeedCtx,
  opts?: NeedDecideOpts,
): {
  tpl: NeedTemplate;
  intent: NeedIntent;
  /** The top FIRING-but-unservable row, whether or not it was chosen to act on. */
  blocked?: { tpl: NeedTemplate; intent: NeedIntent };
} | null {
  const byCost = costed(opts);
  // ⚠️ THE LIVELOCK INVARIANT, kept STRUCTURAL in BOTH paths: a banked deposit
  // must never outrank a row on THIS creature that ACQUIRES the same category,
  // or it re-opens the take⇄deposit spin (adoption's carried unit hijacked back
  // into the chest; the dress fetch banked back into the wardrobe). Flag off,
  // that means flooring the BANK_PRIORITY boost just under the lowest
  // same-category acquirer's priority; flag on, capping the banked row's PRICED
  // rank just under the cheapest same-category acquirer's — belt and braces,
  // because a shortage of 1 makes a bank worth exactly what the drive it feeds
  // is worth, and "exactly" is one rounding away from a spin. Both are computed
  // from the member's own row set, so the cook exemption, adoption rows
  // appearing and vanishing, and per-species sets stay correct without
  // hand-maintained constants.
  const acquirerFloor = (self: NeedTemplate): number | undefined => {
    const cat = self.item.category;
    if (!cat) return undefined;
    let low: number | undefined;
    for (const t of templates) {
      if (t === self || t.acquire.length === 0 || t.item.category !== cat) continue;
      if (low === undefined || t.priority < low) low = t.priority;
    }
    return low;
  };
  /** Did this row fire because units are ALREADY IN HAND? (The put-it-away
   *  rule — the only case either floor applies to.) */
  const isBank = (tpl: NeedTemplate, ctx: NeedCtx, intent: NeedIntent): boolean =>
    tpl.satisfy.kind === "deposit" &&
    ctx.carried > 0 &&
    (intent.kind === "deposit" || intent.kind === "dropHere");
  const rows: { tpl: NeedTemplate; intent: NeedIntent; bank: boolean; rank: number; ladder: number }[] = [];
  let blocked: { tpl: NeedTemplate; intent: NeedIntent } | null = null;
  for (const tpl of templates) {
    // ── DEFER (§2.5): A PARKED ROW IS NOT PRICED AT ALL ────────────────────
    // The plan this row last made failed for a reason that NAMES A CONDITION
    // (no units on the shelf, no room in the box, the station taken), and that
    // condition has not moved since. Reconsidering it would resolve a whole
    // ctx to rediscover the same ∞, so it is skipped outright — and skipped
    // WITHOUT a stopwatch: the caller wakes it when the world changes, never
    // when a clock runs out. The want still surfaces (see `parked`).
    if (opts?.parked?.(tpl)) {
      if (!blocked || tpl.priority > blocked.tpl.priority) blocked = { tpl, intent: { kind: "blocked" } };
      continue;
    }
    const ctx = ctxOf(tpl);
    const intent = decideNeed(tpl, ctx, opts);
    if (intent.kind === "idle") continue;
    if (intent.kind === "blocked") {
      if (!blocked || tpl.priority > blocked.tpl.priority) blocked = { tpl, intent };
      continue;
    }
    const bank = isBank(tpl, ctx, intent);
    // THE SHIPPED EFFECTIVE RANK — the ladder plus the banking boost. It is the
    // whole decision flag-off, and flag-on it is the TIE-BREAK, which is what
    // makes "unpriced ⇒ unchanged" true down to the boost rather than only down
    // to the raw priority.
    let ladder = tpl.priority;
    if (bank) {
      const floor = acquirerFloor(tpl);
      ladder = Math.max(ladder, Math.min(BANK_PRIORITY, floor !== undefined ? floor - 0.05 : BANK_PRIORITY));
    }
    const rank = byCost ? netValueS(rowValueS(tpl, ctx, intent), intentCost(tpl, ctx, intent)) : ladder;
    rows.push({ tpl, intent, bank, rank, ladder });
  }
  if (byCost) {
    // THE CAP, over a SNAPSHOT of the ranks so two banked rows can never chase
    // each other down (determinism: same inputs, same choice).
    const base = rows.map((r) => r.rank);
    for (let i = 0; i < rows.length; i++) {
      const self = rows[i]!;
      if (!self.bank || !self.tpl.item.category) continue;
      let low: number | undefined;
      for (let j = 0; j < rows.length; j++) {
        const other = rows[j]!;
        if (j === i || other.tpl.acquire.length === 0) continue;
        if (other.tpl.item.category !== self.tpl.item.category) continue;
        if (low === undefined || base[j]! < low) low = base[j]!;
      }
      if (low !== undefined) self.rank = Math.min(self.rank, low - RANK_EPS);
    }
  }
  // ARGMAX: rank, then the ladder as the tie-break, then template order. Flag
  // off the rank IS the priority, so the tie-break can never fire and the pick
  // is the shipped one, row for row.
  let best: (typeof rows)[number] | null = null;
  for (const row of rows) {
    if (!best) {
      best = row;
      continue;
    }
    const gap = row.rank - best.rank;
    if (gap > RANK_EPS || (Math.abs(gap) <= RANK_EPS && row.ladder > best.ladder)) {
      best = row;
    }
  }
  if (best) {
    const chosen = { tpl: best.tpl, intent: best.intent };
    return blocked ? { ...chosen, blocked } : chosen;
  }
  return blocked ? { ...blocked, blocked } : null;
}

/**
 * ON-THE-CLOCK DORMANCY (view-distance-lod-tiers.md step 2): how long a body whose
 * decide just found nothing may sleep before anything could change the answer.
 * The earliest meter crossing is an exact timer; a non-meter drive in the set
 * (stock/mess — no closed-form timer) bounds the sleep at `capS`. `homeGraceLeftS`
 * bounds it again while a walk-home grace is still pending: that check lives in
 * the same decide slot, so a sleep armed past it left a commanded creature
 * standing at its errand's endpoint until its next need fired ("went out and
 * never came back") instead of walking home when the grace expired.
 */
export function needDormDueIn(
  templates: readonly NeedTemplate[],
  meterOf: (tplKey: string) => number,
  capS: number,
  homeGraceLeftS = Infinity,
): number {
  let dueIn = templates.some((t) => t.drive.kind !== "meter") ? capS : Infinity;
  for (const tpl of templates) {
    if (tpl.drive.kind !== "meter" || tpl.drive.rate <= 0) continue;
    const left = (tpl.drive.threshold - meterOf(tpl.key)) / tpl.drive.rate;
    if (left < dueIn) dueIn = Math.max(0, left);
  }
  if (!Number.isFinite(dueIn)) dueIn = capS;
  return Math.min(dueIn, homeGraceLeftS);
}

// ---------------------------------------------------------------------------
// Founding templates — FOOD (parameterized by good key; cloth etc. reuse the shapes)
// ---------------------------------------------------------------------------

// ── 🧺 THE MAKESHIFT BRANCHES (2026-08-03) ────────────────────────────────
//
// The food and water rows below carry FOUR acquire branches, and the last two
// are new. Until this pass they had two — the house box and a source — so
// everything else a household actually keeps food in was invisible to them: a
// basket somebody set down with an apple still in it, the pet's bowl, a box
// that is somebody's own. The gap was pinned rather than smuggled (pass 4:
// "hunger/provision have neither a `loose` nor a `storage` branch, so they
// still walk past a floor basket") and left as a decision for the user, who
// made it:
//
//   *(user direction, 2026-08-03, verbatim)*: "It shouldn't be invisible to
//   them, but they should have a reduced tendency to use them. For now, a
//   constant reduction in priority will do; we'll expand on this once we get
//   into more detailed private property and personality rules."
//
// So the branches land, and the "reduced tendency" is carried TWICE, once per
// flag path — which is why the ORDER below is load-bearing:
//   priced   `PROPRIETY_PENALTY_S` on the improper candidates (`acquireFrom`).
//            Arithmetic: the makeshift box loses to a stocked pantry, and wins
//            the moment the pantry has nothing in it.
//   unpriced FIRST-MATCH IN TEMPLATE ORDER, so the makeshift branches must come
//            LAST — after `home`, after `source`. Flag off there is no penalty
//            to pay, and branch order is the only voice the direction has.
//
// `storage` is the role that enumerates the house's OWN boxes plus the
// containers standing on its floor; `loose` is a matching unit lying out (and,
// for an item-typed row, the floor containers again as real stack draws). What
// counts as improper is decided where the ctx is built, per ROW — see
// `StockCandidate.improper`.

/** ⚖️ ONE FIRING IS ONE PERSON-DAY, AND THAT SURVIVES THE RATION SPLIT
 *  (food-scale-round.md Q2). The meter fills over `NEED_FILL_DAYS.hunger` — one
 *  game-day — and that period is what `serviceRadiusM` (and through it every
 *  district, `shopPeriod` and `FOOD_DAY_SEC` schedule) is derived from. The
 *  round that lets a glyph clear a FRACTION of the meter
 *  (`kernel/town/goods-kinds.ts satiationDaysOf`, live since Phase B) therefore
 *  has the NPC eat a MEAL at the table — as many units as the meter costs, one
 *  arrival, meter to 0 — and only the PLAYER's hand-fed unit moves the meter a
 *  fraction. If the autonomous body ate one unit per firing instead, the eating
 *  interval would collapse to a fifth and the honest service radius with it
 *  (96 m → 19 m: no body could leave its own street). Do not "simplify" that
 *  asymmetry away.
 *
 *  Hunger: a meter rising at `rate`/sec fires at one ration; eat at the preferred
 *  station kinds (species data — people at the table, a pet at its bowl; else in
 *  place), getting the unit from the own-house box first, else buying at a source,
 *  else — mildly avoided — from whatever else in the house happens to hold food.
 *  The acquire branches are UNIVERSAL — a creature that can't open the box or pay
 *  (no grasp) simply resolves no candidates and the need surfaces (adoption). */
export function hungerTemplate(goodKey: string, rate: number, at: readonly string[] = ["table"]): NeedTemplate {
  return {
    key: `hunger:${goodKey}`,
    item: { category: goodKey },
    drive: { kind: "meter", rate, threshold: 1 },
    satisfy: { kind: "consume", at },
    acquire: [
      { kind: "container", role: "home" },
      { kind: "source" },
      // …and only then the makeshift stores: another box in the house, a
      // basket on the floor, and finally food simply lying out.
      { kind: "container", role: "storage" },
      { kind: "loose" },
    ],
    priority: 5,
  };
}

/** Provisioning: the household's shopping errand as a need — fires when the home box
 *  falls below the SURPLUS buffer (the same threshold that paces the scheduled clock,
 *  goods.ts `shopPeriod`), buys the shortfall at a source, deposits it at home. Also
 *  how a GIFT gets put away: carrying matching units fires the deposit directly.
 *
 *  🧺 AND THE MAKESHIFT BRANCHES DO A SECOND JOB HERE, which is the best thing
 *  about giving them to a DEPOSIT row: what this row draws it carries HOME. So
 *  the household's own basket gets emptied into the larder by the ordinary
 *  restocking loop — the tool ends up empty and the food ends up where food
 *  lives — instead of the apple sitting in the basket until somebody happens to
 *  pick the whole thing up. One way only: `designatedContainerFor` names
 *  furniture homes, so a floor container is a source of opportunity and never a
 *  destination, and there is no cycle to spin. */
export function provisionTemplate(goodKey: string, surplusUnits: number, capUnits: number): NeedTemplate {
  return {
    key: `provision:${goodKey}`,
    item: { category: goodKey },
    drive: { kind: "stock", container: "home", below: surplusUnits },
    satisfy: { kind: "deposit", container: "home", upTo: capUnits },
    // The stall FIRST (flag off, first-match: a restock is a shopping trip),
    // then what the house already has standing about.
    acquire: [{ kind: "source" }, { kind: "container", role: "storage" }, { kind: "loose" }],
    priority: 3,
  };
}

// ── Sims-mode motives (household-duties-and-sims-mode.md §3) — data rows, no
// new machinery: a meter drive + a station satisfy each.

/** Energy: tiredness rises at `rate`/sec and is slept off at a BED (else a doze
 *  in place). Below hunger (a starving creature eats first), above shopping. */
export function energyTemplate(rate: number): NeedTemplate {
  return {
    key: "energy",
    item: {},
    drive: { kind: "meter", rate, threshold: 1 },
    satisfy: { kind: "rest", at: ["bed"] },
    acquire: [],
    priority: 4,
  };
}

/** Social: loneliness rises at `rate`/sec; satisfied by SEEKING a housemate and
 *  talking (the caller lists partners as stations and runs the real dialogue
 *  exchange on arrival — gossip spreads, relations warm). Bodies eat, sleep and
 *  work before they mingle. */
export function socialTemplate(rate: number): NeedTemplate {
  return {
    key: "social",
    item: {},
    drive: { kind: "meter", rate, threshold: 1 },
    satisfy: { kind: "social" },
    acquire: [],
    priority: 2,
  };
}

/** Fun (household-duties-and-sims-mode.md §3): restlessness rises at `rate`/sec
 *  and is played off by FETCHING A TOY AND USING IT — anywhere. The need selects
 *  on the `play` AFFORDANCE, not on a location: play is a function objects
 *  carry, so a body takes one out and plays with it wherever it stands, exactly
 *  as it takes food out to eat. Nothing is consumed; the toy is left loose and
 *  the tidy chore returns it. The lightest motive: everything else comes first. */
export function funTemplate(rate: number): NeedTemplate {
  return {
    key: "fun",
    item: { affords: "play" },
    drive: { kind: "meter", rate, threshold: 1 },
    satisfy: { kind: "use" },
    // A toy already lying out is the nearest fun; else open a container.
    acquire: [{ kind: "loose" }, { kind: "container", role: "storage" }],
    priority: 1,
  };
}

// ── Sims-mode round 2 (creature-behavior-brainstorming.md V1): the remaining
// BASIC needs — thirst, hygiene, waste — plus the tidying CHORE and pet care.
// Data rows again; the only new machinery is the `mess` drive / `loose` branch.

/** Thirst: exactly hunger's shape over WATER — drink at the preferred station
 *  (species data: people at the table, a pet from its bowl), drawing from the
 *  house water barrel first, else the town well (a free source), else — mildly
 *  avoided — a bucket somebody set down or another vessel in the house. Sits
 *  just under hunger: a starving body eats before it drinks. */
export function thirstTemplate(rate: number, at: readonly string[] = ["table"]): NeedTemplate {
  return {
    key: "thirst:water",
    item: { category: "water" },
    drive: { kind: "meter", rate, threshold: 1 },
    satisfy: { kind: "consume", at },
    acquire: [
      { kind: "container", role: "home" },
      { kind: "source" },
      { kind: "container", role: "storage" },
      { kind: "loose" },
    ],
    priority: 4.8,
  };
}

/** Waste: rises slowly (the caller also BUMPS it on meals/drinks) and is seen
 *  to at the TOILET — never "in place" (requireStation): a house without one
 *  simply surfaces the want. Urgent when it fires: above energy, below food. */
export function wasteTemplate(rate: number): NeedTemplate {
  return {
    key: "waste",
    item: {},
    drive: { kind: "meter", rate, threshold: 1 },
    satisfy: { kind: "rest", at: ["toilet"], requireStation: true },
    acquire: [],
    priority: 4.5,
  };
}

/** Hygiene: grime rises slowly and is WASHED off at the bath (a dwell — the
 *  scrub). Station-required like waste; a low-urgency comfort motive. */
export function hygieneTemplate(rate: number): NeedTemplate {
  return {
    key: "hygiene",
    item: {},
    drive: { kind: "meter", rate, threshold: 1 },
    satisfy: { kind: "rest", at: ["bath"], requireStation: true },
    acquire: [],
    priority: 1.8,
  };
}

/** Tidying: the housekeeping CHORE as a need — fires while loose clutter lies
 *  around the room (`mess` drive over `ctx.loose`; the caller lists props that
 *  are uncontained and NOT IN USE — sat out past a grace period and not in
 *  anyone's hands — so a toy mid-game isn't snatched), picks one unit up and
 *  returns it to its DESIGNATED container. The "storage" role is resolved per
 *  ITEM by the host, not to one fixed box: food goes back to the pantry, a
 *  garment to the wardrobe, a toy to its owner's box. Between fun and hygiene:
 *  a bored body plays before it tidies someone else's mess.
 *
 *  ⚖️ THE SWEEP IS NOW PRICED (`forgoneOf`): lifting a unit costs whatever that
 *  unit was serving where it lay, so a toy somebody is bored enough to want
 *  stays out and one nobody wants goes in the box — arithmetic, not a filter.
 *  The three stand-in mechanisms the caller still applies to this row's `loose`
 *  list (chapter §4.4: `TIDY_GRACE_S`, the play-area exemption,
 *  `inUseByLiveNeed`) are the boolean this number generalizes; they are
 *  REDUNDANT once the charge is trusted live, and are deliberately left
 *  standing until it is. */
export function tidyTemplate(): NeedTemplate {
  return {
    key: "tidy",
    item: {},
    drive: { kind: "mess", above: 0 },
    satisfy: { kind: "deposit", container: "storage", upTo: 99 },
    acquire: [{ kind: "loose" }],
    priority: 1.2,
  };
}

/** UNLOAD — the "don't walk around holding things" rule, as a need.
 *
 *  A body should have a HIGH priority to get rid of whatever is in its hands
 *  UNLESS it is using it, wearing it, or transporting it somewhere. Those three
 *  exceptions are precisely "some other row wants this unit", so the caller
 *  resolves `carried` here to the ORPHAN units only — what is in hand that no
 *  other row on this body claims (`carriedClutter`). A gift nobody has a use
 *  for, a treat, a thing picked up and forgotten: those get put away NOW rather
 *  than riding the hands until the episode ends.
 *
 *  ⚠️ THE LIVELOCK INVARIANT, satisfied STRUCTURALLY: this row has NO acquire
 *  branches. It can never take anything, so it can never spin against the row
 *  that did — which is what lets it sit ABOVE the acquiring rows in priority
 *  without breaking the law every other deposit row has to obey. Its high
 *  priority is safe only because its hands are, by construction, tied.
 *
 *  Distinct from `tidy`, deliberately: tidying the FLOOR is a low-priority
 *  chore you do when idle; emptying your own HANDS is not a chore, it is what
 *  you do before doing anything else. */
export function unloadTemplate(): NeedTemplate {
  return {
    key: "unload",
    item: {},
    // Never fires on its own — the deposit-while-carrying rule in `needFires`
    // is its only trigger, and `carried` counts orphans only.
    drive: { kind: "mess", above: 99 },
    // orDrop: the row must ALWAYS have an answer. Its whole purpose is that a
    // body never holds a thing it isn't using, so "there's no box" cannot be
    // allowed to mean "keep holding it" — it means set it down.
    satisfy: { kind: "deposit", container: "storage", upTo: 99, orDrop: true },
    acquire: [],
    priority: 4.6,
  };
}

/** RELIEVE — "put down whatever you're holding", as the WEAKEST need there is.
 *
 *  *(user direction, 2026-08-02, verbatim)*: "I think 'put down whatever you're
 *  holding' should be treated as a need — just one that is weaker than most
 *  other needs, so it only happens if they aren't doing anything with the item
 *  they are using."
 *
 *  DISTINCT FROM `unload`, and the difference is WHAT LEAVES. `unload` (4.6)
 *  empties the STACK — orphan units riding a bag or a bare hand, which are
 *  goods somebody's shelf wants back. This row releases the ONE WHOLE OBJECT in
 *  the hands: the basket a body was told to pick up, the thing it lifted and
 *  forgot. A held container is not a unit in ANY carry view (scope-shape.ts
 *  `bodyCarryView` — "the bag OBJECT itself is not a row: it is the shelf, not
 *  the goods"), so before this row existed NOTHING on a body could see one, and
 *  a basket that reached a pair of hands stayed there for the rest of the
 *  session.
 *
 *  ⚠️ 0.8 — BELOW FUN (1), which is the floor of the real motives. At
 *  `NEED_PRESSURE_S = 40` that is the whole exchange rate in one number: tidying
 *  your own hands is worth **32 hand-seconds**, so it buys about half a minute
 *  of walking and NOTHING outbids a want (fun's own 40 beats it, and every rung
 *  above fun beats it by more). It fires when the body would otherwise be idle,
 *  which is exactly what the direction asks for.
 *
 *  ⚖️ …AND THAT IS ONLY HALF THE PRICE (2026-08-07, stocking-offload-and-carry.md
 *  §3). The rung says what putting a thing down is worth; it says nothing about
 *  what going on holding it COSTS, and the reported arcs — a dirty shirt carried
 *  to the toilet and through a night's sleep, the household basket riding along
 *  all day — are 32 hand-seconds losing to every real motive, every decide. The
 *  missing half now arrives on the price board as `NeedPrice.freedHandsS`: what
 *  this body's hands are worth FREE, added to this row's value by `rowValueS`
 *  whenever its act actually empties them. The rung is untouched, so an idle
 *  body with nothing pressing decides exactly as it did; a body with a live want
 *  now puts the thing down FIRST and serves the want unencumbered, which is what
 *  "dropping should be cheaper than carrying" means in this currency.
 *
 *  ⚠️ THE LIVELOCK INVARIANT, satisfied STRUCTURALLY as `unload`'s is: NO
 *  acquire branches. It can never pick anything up, so it can never spin
 *  against the row that did — and the caller resolves `carried` to the IDLE
 *  held object only (nothing in use, nothing being transported), so a row that
 *  wants the thing always wins by simply not letting this one fire. */
export function relieveTemplate(): NeedTemplate {
  return {
    key: "relieve",
    item: {},
    // Never fires on its own — the deposit-while-carrying rule in `needFires`
    // is its only trigger, and `carried` counts the idle held object only.
    drive: { kind: "mess", above: 99 },
    // orDrop, and for a portable container the drop is the ONLY answer: a
    // basket has no box (container-home.ts `livesOnTheFloor`), so it is set
    // down on the floor rather than buried in a chest.
    satisfy: { kind: "deposit", container: "storage", upTo: 99, orDrop: true },
    acquire: [],
    priority: 0.8,
  };
}

// ── Clothing (creature-behavior-brainstorming.md V1 "wearing clothes" — done
// properly: garments are ITEMS with a clean/dirty state, not a baked look).
// Three data rows over two new elemental shapes (`equip`, `transform`):
//
//   dress    wear-and-tear as a METER (the worn garment's dirt — the caller
//            ticks it); at threshold, fetch a CLEAN garment from the wardrobe
//            (else buy one) and EQUIP it. The caller's equip effect hands the
//            doffed garment back as a `.dirty` unit — which is all it takes to
//            start the laundry chain.
//   laundry  fires while dirty garments exist (in hand — the doffed one — or
//            lying/banked anywhere the caller lists under `loose`); carries
//            them to the TUB and the transform strips the `dirty` facet. The
//            washed unit is now CLEAN CLOTHING — a different type — so this
//            row stops firing on it and the stow row below takes over: the
//            type change itself hands off between templates, no livelock.
//   stow     the put-it-away row for clean clothing: fires while carrying any
//            (the deposit rule — a just-washed shirt, a player gift) or while
//            clean garments lie on the floor, and banks them in the wardrobe.
//
// ⚠️ LIVELOCK INVARIANT check: dress ACQUIRES clothing units, so it MUST
// outrank every deposit row for clothing — stow (2.8) and a clothing runner's
// provision row (3) — hence 3.2. laundry acquires `laundry`-typed units and no
// deposit row exists for that type; the wash's type change is its exit.

/** Dress: wear-and-tear on the worn garment as a meter; at threshold, take a
 *  clean garment (wardrobe first, else a store) and put it on. */
export function dressTemplate(rate: number): NeedTemplate {
  return {
    key: "dress",
    item: { category: "clothing" },
    drive: { kind: "meter", rate, threshold: 1 },
    satisfy: { kind: "equip" },
    acquire: [{ kind: "container", role: "home" }, { kind: "source" }],
    priority: 3.2,
  };
}

/** Laundry: while dirty garments exist (carried or listed loose), carry them
 *  to the tub and wash the `dirty` facet off. Between hygiene and tidy: a
 *  grimy body scrubs itself before the clothes. */
export function laundryTemplate(): NeedTemplate {
  return {
    key: "laundry",
    item: { category: "laundry" },
    drive: { kind: "mess", above: 0 },
    satisfy: { kind: "transform", at: ["bath"], drop: "dirty" },
    acquire: [{ kind: "loose" }],
    priority: 1.4,
  };
}

/** Stow: put carried clean garments away in the wardrobe (a just-washed
 *  shirt, a gift), and pick loose ones off the floor. The tidy chore skips
 *  provisioned heads, so without this row a clean shirt on the floor would
 *  be nobody's job. */
export function stowTemplate(goodKey: string, capUnits: number): NeedTemplate {
  return {
    key: `stow:${goodKey}`,
    item: { category: goodKey },
    drive: { kind: "mess", above: 0 },
    satisfy: { kind: "deposit", container: "home", upTo: capUnits },
    acquire: [{ kind: "loose" }],
    priority: 2.8,
  };
}

// ── PREPARING A RITUAL (rituals.ts) — the meal chain, the laundry chain's
// mirror but EVENT-paced. Two data rows over the existing shapes, and both
// exist only while a ritual is actually being got ready:
//
//   cook   fires while the ritual's PLACE holds fewer than `below` MEALS (a
//          stock drive measured in the OUTPUT category via `of` — a meal
//          still in hand counts, which is the loop's brake), takes ONE raw
//          unit (pantry first, else a market buy) and processes it at the
//          OVEN — the transform ADDS the `hot` facet, so the unit leaves
//          the raw category and this row stops firing on it: the type
//          change hands off to prep, exactly the wash → stow seam.
//   prep   the put-it-away row for the ritual's items: fires while carrying
//          any (the just-cooked unit, a player gift) or while they lie
//          loose, and sets them ON the place — where a head's own walker
//          finds them WAITING (the combine case: the dinner scene).
//
// ⚠️ `below` IS THE RITUAL'S BILL — one portion per head coming — never a
// standing buffer. The table used to be a LARDER the household was obliged
// to keep topped up forever, whether or not anyone was about to eat, so
// nobody ever decided to have dinner: food accumulated on a surface and
// bodies drifted past it. Cooking for the heads at the table is the whole
// difference, and it is why these rows are derived per live ritual.
//
// ⚠️ LIVELOCK INVARIANT check: cook ACQUIRES food units, so it MUST
// outrank every deposit row for food — provision (3) — hence 3.3; and it
// must sit UNDER adoption (3.5): a blocked housemate's want outranks
// dinner prep (the carried apple goes to the hungry pet's bowl, not the
// pot). prep deposits MEAL units, which nothing acquires (hunger eats them
// from the place's stock without carrying) — no cycle.

/** Cook: fill the ritual's bill — take raw food (home box, else a store)
 *  and turn it hot at the oven. Give this row to a member who does NOT
 *  shop for food (its priority beats provision, and a transform fires on
 *  ANY matching carried unit — on the food shopper it would hijack the
 *  grocery haul into the pot one apple at a time). */
export function cookTemplate(goodKey: string, mealKey: string, below: number): NeedTemplate {
  return {
    key: `cook:${goodKey}`,
    item: { category: goodKey },
    drive: { kind: "stock", container: "ritual", below, of: mealKey },
    satisfy: { kind: "transform", at: ["oven"], add: "hot" },
    acquire: [{ kind: "container", role: "home" }, { kind: "source" }],
    priority: 3.3,
  };
}

/** Prep: carried or loose ritual items go ON the place (visible — a table
 *  shows its contents), where the heads' own needs find them waiting.
 *  `bill` is the ritual's, so this row stops the moment the table is laid
 *  for the people actually coming. */
export function ritualPrepTemplate(itemKey: string, bill: number): NeedTemplate {
  return {
    key: `prep:${itemKey}`,
    item: { category: itemKey },
    drive: { kind: "mess", above: 0 },
    satisfy: { kind: "deposit", container: "ritual", upTo: bill },
    acquire: [{ kind: "loose" }],
    priority: 2.8,
  };
}

/** ATTEND: take your place at the ritual and stay there. A `rest` at the
 *  claimed station (the caller resolves it to THIS body's own seat, never
 *  any free chair), station-required — a ritual you cannot reach is one you
 *  are not at.
 *
 *  ⚠️ Priority 1.5 is load-bearing. It sits ABOVE the idle chores (tidy 1.2,
 *  fun 1) so a head with nothing pressing goes and sits down, and BELOW the
 *  prep rows (2.8/3.3) so the cook cooks instead of sitting — the food gets
 *  made and only then does its maker come to the table. It is also below
 *  waste/hygiene: nobody is held at dinner by a ritual. */
export function ritualAttendTemplate(ritualKey: string, station: string): NeedTemplate {
  return {
    key: `attend:${ritualKey}`,
    item: {},
    drive: { kind: "meter", rate: 0, threshold: 0 }, // always firing while the row exists
    satisfy: { kind: "rest", at: [station], requireStation: true },
    acquire: [],
    priority: 1.5,
  };
}

// NOTE deliberately absent: a "feed the pet" template. A graspless creature's
// own hunger row BLOCKS when it can't open anything (the capability gate in the
// caller's ctx resolution) — the want surfaces, and a housemate ADOPTS it
// through the general on-behalf rule (adoption). Same rule feeds the sick and
// answers the `help` verb; hard-coding petcare here would shadow all of that.
