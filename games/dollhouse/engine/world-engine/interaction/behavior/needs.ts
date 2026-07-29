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
// PURE (no world coordinates, no RNG, no time): the caller resolves the template's roles
// against the live world — which containers match the role, which sources sell the type,
// which stations afford the satisfy — pre-filtered to KNOWN + PERMITTED and ordered
// nearest-first, exactly the contract the old EatingCtx had. The walker only chooses.
// Ticking the meter (rate × dt) is also the caller's job; `rate` here is data.
//
// The founding instances are FOOD (npc-behavior-and-town-economy.md §13a): `hunger`
// (meter → pantry-or-market → eat at the table) and `provision` (pantry below buffer →
// buy at the market → deposit at home). Their interplay is the emergent story: steal a
// pantry dry and the hungry member buys its meal while the runner restocks; gift food
// and the carried units get put away at home instead of a store trip (a deposit need
// fires whenever the creature is CARRYING matching units — housekeeping falls out).

import type { NeedTarget } from "@shared/world-engine/interaction/behavior/creatures.js";
import type { PlaceRef } from "@shared/world-engine/interaction/behavior/rules.js";

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
  /** Remaining capacity for deposits; absent = unbounded. */
  room?: number;
}

/** A resolved satisfy-station (a table…): `kind` matches `satisfy.at`; `waiting` is an
 *  unclaimed matching unit count already AT the station (lets acquire+consume combine —
 *  go straight there and eat). */
export interface StationCandidate {
  id: string;
  place: PlaceRef;
  kind: string;
  waiting: number;
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
  /** How many more units this body can physically take on (hands + inventory
   *  slots left — `inventoryRoom`). Absent = unbounded (the old behaviour, and
   *  what headless callers that model no bag get). Every take is capped by it,
   *  so a bounded bag is a bounded shopping trip. */
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

/** The first acquire branch that can supply now → where to take from, and WHICH
 *  branch kind it was (the caller sizes a `source` take differently — see
 *  `takeUnits`). Branch order is the template's preference; within a branch the
 *  ctx lists are already nearest-first. */
function acquireFrom(
  tpl: NeedTemplate,
  ctx: NeedCtx,
): { from: StockCandidate; branch: AcquireSpec["kind"] } | undefined {
  for (const branch of tpl.acquire) {
    if (branch.kind === "container") {
      const c = ctx.containers[branch.role];
      if (c && c.units > 0) return { from: c, branch: "container" };
    } else if (branch.kind === "loose") {
      const l = (ctx.loose ?? []).find((x) => x.units > 0);
      if (l) return { from: l, branch: "loose" };
    } else {
      const s = ctx.sources.find((x) => x.units > 0);
      if (s) return { from: s, branch: "source" };
    }
  }
  return undefined;
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
): number {
  const capacity = Math.min(from.units, ctx.room ?? Infinity);
  const target = branch === "source" ? Math.max(want, ctx.restock ?? 0) : want;
  // Never round DOWN to zero: a body with a full bag still takes the one unit
  // it came for, or the walker would spin (fire → take 0 → fire).
  return Math.max(1, Math.min(target, capacity));
}

/**
 * Decide the next intent for ONE need from current state. Re-run every step — that IS
 * the robustness: lose the item and the next call routes back to acquisition; find one
 * already waiting at a station and it goes straight to consuming; get handed a stack
 * and a deposit need walks it home.
 */
export function decideNeed(tpl: NeedTemplate, ctx: NeedCtx): NeedIntent {
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
    const got = acquireFrom(tpl, ctx);
    if (!got) return { kind: "blocked" };
    return { kind: "take", from: got.from, units: takeUnits(ctx, got.from, got.branch, 1) };
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
    const got = acquireFrom(tpl, ctx);
    if (!got) return { kind: "blocked" };
    return { kind: "take", from: got.from, units: 1 };
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
    const got = acquireFrom(tpl, ctx);
    if (!got) return { kind: "blocked" };
    // ONE unit per pass, whatever the branch: the cook's drive is paced by
    // what the table still wants, and a bag full of raw food would just make
    // the transform loop fire until the bag emptied.
    return { kind: "take", from: got.from, units: 1 };
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
    const got = acquireFrom(tpl, ctx);
    if (!got) return { kind: "blocked" };
    return { kind: "take", from: got.from, units: takeUnits(ctx, got.from, got.branch, 1) };
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
    // PUT IT AWAY if there is anywhere to put it; else PUT IT DOWN (orDrop).
    // A graspless body reaches this every time — it can hold a ball but can
    // never open the box — and without the drop it would carry the ball for
    // the rest of the session.
    if (!home) return mayDrop ? { kind: "dropHere", units: ctx.carried } : { kind: "blocked" };
    const units = Math.min(ctx.carried, home.room ?? ctx.carried);
    if (units > 0) return { kind: "deposit", into: home, units };
    return mayDrop ? { kind: "dropHere", units: ctx.carried } : { kind: "blocked" };
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
  const got = acquireFrom(tpl, ctx);
  if (!got) return { kind: "blocked" };
  // The restock row already wanted the whole shortfall; `takeUnits` now also
  // caps it by what the body can actually carry (a bounded bag = a bounded
  // trip, and the leftover shortfall simply fires the row again next trip).
  return { kind: "take", from: got.from, units: takeUnits(ctx, got.from, got.branch, shortfall) };
}

/**
 * Across a creature's templates: resolve each, keep the firing ones, act on the highest
 * priority (ties → earlier template). Returns the chosen template + its intent, or null
 * when nothing fires — the caller drives ONE intent at a time, then re-decides.
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
 */
/** THE BANKING PRIORITY — the effective rank of a deposit row that fired
 *  because units are ALREADY IN HAND (the put-it-away rule), as opposed to its
 *  trip. The trip is a chore (shop when comfortable — the row's own low
 *  priority); the BANK is finishing a haul that is otherwise lost to the
 *  economy. Observed famine trap: a body drew a restock-sized water haul at
 *  the well, and the leftover rode its bag for sim-minutes while rest-family
 *  motives (a 384 s sleep!) outranked provision's 3 every decide — the barrel
 *  never filled, so the household kept trekking to the well one throat at a
 *  time. 4.2 banks the haul ABOVE energy (4) but below waste (4.5) — the
 *  toilet doesn't wait — and below thirst/hunger (the starving body still
 *  serves itself first). */
export const BANK_PRIORITY = 4.2;

export function decideNeeds(
  templates: readonly NeedTemplate[],
  ctxOf: (tpl: NeedTemplate) => NeedCtx,
): {
  tpl: NeedTemplate;
  intent: NeedIntent;
  /** The top FIRING-but-unservable row, whether or not it was chosen to act on. */
  blocked?: { tpl: NeedTemplate; intent: NeedIntent };
} | null {
  // ⚠️ THE LIVELOCK INVARIANT, kept STRUCTURAL under the banking boost: a
  // banked deposit must never outrank a row on THIS creature that ACQUIRES the
  // same category, or the boost re-opens the take⇄deposit spin (adoption's
  // carried unit hijacked back into the chest; the dress fetch banked back
  // into the wardrobe). Floor the boost just under the lowest same-category
  // acquirer — computed from the member's own row set, so the cook exemption,
  // adoption rows appearing and vanishing, and per-species sets all stay
  // correct without hand-maintained constants.
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
  let best: { tpl: NeedTemplate; intent: NeedIntent; prio: number } | null = null;
  let blocked: { tpl: NeedTemplate; intent: NeedIntent } | null = null;
  for (const tpl of templates) {
    const ctx = ctxOf(tpl);
    const intent = decideNeed(tpl, ctx);
    if (intent.kind === "idle") continue;
    if (intent.kind === "blocked") {
      if (!blocked || tpl.priority > blocked.tpl.priority) blocked = { tpl, intent };
      continue;
    }
    let prio = tpl.priority;
    if (
      tpl.satisfy.kind === "deposit" &&
      ctx.carried > 0 &&
      (intent.kind === "deposit" || intent.kind === "dropHere")
    ) {
      const floor = acquirerFloor(tpl);
      prio = Math.max(prio, Math.min(BANK_PRIORITY, floor !== undefined ? floor - 0.05 : BANK_PRIORITY));
    }
    if (!best || prio > best.prio) best = { tpl, intent, prio };
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

/** Hunger: a meter rising at `rate`/sec fires at one ration; eat at the preferred
 *  station kinds (species data — people at the table, a pet at its bowl; else in
 *  place), getting the unit from the own-house box first, else buying at a source.
 *  The acquire branches are UNIVERSAL — a creature that can't open the box or pay
 *  (no grasp) simply resolves no candidates and the need surfaces (adoption). */
export function hungerTemplate(goodKey: string, rate: number, at: readonly string[] = ["table"]): NeedTemplate {
  return {
    key: `hunger:${goodKey}`,
    item: { category: goodKey },
    drive: { kind: "meter", rate, threshold: 1 },
    satisfy: { kind: "consume", at },
    acquire: [{ kind: "container", role: "home" }, { kind: "source" }],
    priority: 5,
  };
}

/** Provisioning: the household's shopping errand as a need — fires when the home box
 *  falls below the SURPLUS buffer (the same threshold that paces the scheduled clock,
 *  goods.ts `shopPeriod`), buys the shortfall at a source, deposits it at home. Also
 *  how a GIFT gets put away: carrying matching units fires the deposit directly. */
export function provisionTemplate(goodKey: string, surplusUnits: number, capUnits: number): NeedTemplate {
  return {
    key: `provision:${goodKey}`,
    item: { category: goodKey },
    drive: { kind: "stock", container: "home", below: surplusUnits },
    satisfy: { kind: "deposit", container: "home", upTo: capUnits },
    acquire: [{ kind: "source" }],
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
 *  house water barrel first, else the town well (a free source). Sits just
 *  under hunger: a starving body eats before it drinks. */
export function thirstTemplate(rate: number, at: readonly string[] = ["table"]): NeedTemplate {
  return {
    key: "thirst:water",
    item: { category: "water" },
    drive: { kind: "meter", rate, threshold: 1 },
    satisfy: { kind: "consume", at },
    acquire: [{ kind: "container", role: "home" }, { kind: "source" }],
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
 *  a bored body plays before it tidies someone else's mess. */
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
