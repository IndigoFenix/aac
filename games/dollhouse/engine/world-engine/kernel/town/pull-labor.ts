// shared/world-engine/kernel/town/pull-labor.ts
//
// ⚖️ PULL-MODEL LABOR — THE SEAM (task #51, planning-docs/games/world-engine/
// pull-labor-round.md, Stage 1). Import-free on purpose: the two sides of the
// round — the BOOKKEEPER (construction-director) and the DECIDER (quest-host +
// interaction/quest/contribute.ts) — meet here and nowhere else.
//
// USER RULING (2026-09-04, near-verbatim): "it's not an order, it's a
// PERSONAL DECISION." A need exists as a QUANTITY (a stocking bill with its
// full chain); an individual with no urgent personal need SEES the bill,
// determines its own contribution and ISSUES THE TASK TO ITSELF through the
// same pursuit loop a spoken order runs. The director posts nothing; it keeps
// the books. Caps become SEATS (Stage 2). Trips size themselves from the
// body's own carry. De-confliction stays on the reservation ledger.
//
// WHAT THIS FILE HOLDS: the vocabulary a self-issued slice is written in —
// the pursuit's `tplKey`, the `bill` a contribute pursuit carries, the
// reservation HOLDER namespace a puller books under, the SCHEMA the cascade's
// order is derived from, and the ONE derivation of the `pullLabor` capability.
// Nothing here reads a session, a ledger or a body: every consumer passes what
// it has.
//
// 🚨 THE IMPORT LAW, AND ITS ONE EXCEPTION. This file imports exactly ONE
// module — `kernel/means-ends.ts`, which itself imports nothing at all (not
// even a type). So the seam stays cycle-free by the same argument it always
// was: neither side of the round can reach this file through it.

import { depthOf, type Operator } from "../means-ends.js";

/** The `tplKey` every contribute pursuit carries — the ONE discriminator the
 *  hand census, the warp guard, the streamer pin and the why-chain read. A
 *  pursuit whose `tplKey` is this and whose `bill` is present is a body
 *  working a bill it chose. */
export const CONTRIBUTE_TPL_KEY = "contribute";

/**
 * ⚖️ CONTRIBUTION IS A NEED ROW WITH A DECLARED PRIORITY — its rung on the
 * SAME priority ladder every other motive is written on (MAIN RULING on F2,
 * 2026-09-04, pull-labor-round.md).
 *
 * 🚨 WHAT WENT WRONG WITHOUT IT (measured, 1b's F2). A slice used to be priced
 * at the TOWN rung — `goodsValueS(units, 1, townFillS)`, i.e. one block is
 * worth a whole street-day of a hand's time (240 s at the frontier scale, ×8
 * for a basket trip) — while a full hunger is priced at the BODY rung and
 * capped by its own fill clock (~80 s). An open bill therefore outbid every
 * personal need by 3-24× and ruling ③'s "a bored resident works and a HUNGRY
 * ONE EATS FIRST" was false at the shipped constants: `SAY` fell 135 → 5 on
 * the frontier arc, the food and water bubbles largely gone for the whole
 * build window. Two rungs cannot be compared; a motive must be priced in the
 * currency of the body that is choosing.
 *
 * SO THIS NUMBER IS THE EXCHANGE RATE, STATED ONCE, exactly as every need
 * template states its own `priority`:
 *
 *     valueS = CONTRIBUTE_PRIORITY × NEED_PRESSURE_S × urgency(bill) × w × salience
 *
 * with `NEED_PRESSURE_S` (40 s per priority point) left at its ONE definition
 * in `interaction/behavior/needs.ts` — never mirrored here, or the ladder
 * would have two rungs' worth of truth. `urgency(bill)` is the bill's own
 * SHORTFALL FRACTION (1 while nothing has landed), the same reading
 * `urgencyOf`'s `stock` arm gives a half-empty shelf. `w` is 1 for a civic
 * bill and `1 + compliance(relationToward(cid, issuer))` for a spoken one.
 *
 * WHERE 2 PUTS IT ON THE SHIPPED LADDER (× 40 s each): hunger 5 (200 s),
 * thirst 4.8, energy 4, tidy 1.2. A CHORE — below hunger and thirst, above a
 * blocked or mild want. A SPOKEN bill at family compliance (≈ 1.68) reaches
 * ≈ 3.4 (≈ 134 s): above a mild need, still below a hungry body. That is the
 * whole of the ruling, and it is one integer rather than a special case.
 *
 * ⚖️ THE TOWN RUNG IS NOT DELETED — it ranks LINKS AGAINST EACH OTHER (which
 * of this bill's chain is worth most to the town) and gates whether a link is
 * worth doing at all. It never again meets a need across the rungs.
 */
export const CONTRIBUTE_PRIORITY = 2;

/**
 * 🧺 HOW LONG A PORTER MAY GO ON HOLDING ITS EMPTY BASKET before the put-down
 * row is allowed to want it — main's ruling on the basket (2026-09-06).
 *
 * 🚨 THE DEFECT THIS ANSWERS. Measured on the frontier arc at both dts: every
 * porter ended the run holding an empty basket, 278–296 s after its last haul
 * landed, and six were still holding one when the run stopped. The unload's own
 * comment calls that the design (*"the basket rides on until this body's own
 * relieve row sets it down"*) — but on a founded site NO body carries a relieve
 * row at all (`residentNeedTemplates` pushed it only inside the dollhouse
 * gate), so the emergent put-back had nothing to emerge from. The row is now
 * carried wherever `pullLaborOn` holds, and this is the pause in front of it.
 *
 * ⚖️ WHY THERE IS A GRACE AT ALL. A porter that has just delivered re-decides
 * on the next tick and, with a bill still standing, takes another slice — and
 * the basket is the TOOL for that next trip (`haulBagLeg` prices a trip with
 * one against a trip without). Set the grace to zero and the body puts the
 * basket down and picks the same basket straight back up: the take-out/put-in
 * flap `TIDY_GRACE_S` exists to stop, one motive over.
 *
 * ⚖️ WHY 20. It is half of `NEED_PRESSURE_S` (40 s — the seconds one rung of
 * the need ladder buys; its ONE definition stays in needs.ts and is never
 * mirrored here). So waiting costs the put-down row half a rung of hesitation
 * and no more, which is the right order of magnitude for a row that is itself
 * worth 0.8 rungs. It is comfortably longer than a decide (a body re-decides
 * every tick once its pursuit clears) and two orders shorter than the 296 s
 * observed. A porter that takes another slice inside 20 s keeps its basket for
 * the whole shift, exactly as intended; one that has genuinely run out of work
 * puts it down and walks away with its hands free.
 *
 * Not a second put-down PATH: the act is the shipped `relieve` row's own drop
 * (which already knows how to set a held bag down), and this is only how long
 * that row waits before it is allowed to look.
 */
export const BAG_RETURN_GRACE_S = 20;

/**
 * ⚖️ HOW LONG ONE FELLING TAKES A BODY — the chop, as a work beat (task #51
 * item 1d).
 *
 * 🚨 THERE WAS NO FELLING-COST SEAT TO DERIVE THIS FROM, and the search for
 * one is worth recording: `takeUnitsOf` (products.ts) prices a cut in UNITS
 * PER ACT (the tool multiplier, squared once the trunk is down) and
 * `laborRatePerS` prices BUILD-DAYS per second — neither is a duration for the
 * act of felling, because until this item the fell had no duration at all: it
 * happened in the frame the button was pressed. So this is a NEW number, named
 * once, here, rather than five dwell literals across the host.
 *
 * ⚖️ THE TRANSACTION-TIME LAW (feedback_transaction_time_from_needs) says
 * pacing must EMERGE from the transacting entities rather than from an
 * authored constant — a felling's real time is the tree's girth against the
 * body's tool and strength, and that is what a later round will supply
 * (`takeUnitsOf`'s multiplier is already the tool half of it). Until then this
 * is an ANCHORED DEFAULT and it is anchored deliberately: one site work beat
 * (`BUILD_WORK_DWELL_S` = 30 s — not imported, because this file is
 * import-free and the two numbers answer different questions). A body that
 * walks 70 m to a tree therefore spends its time mostly walking, which is the
 * honest shape of the act.
 */
export const CHOP_DWELL_S = 30;

/**
 * 🔭 WHAT A HOVER IS WORTH — the weight the attention spark puts on the links
 * that touch the object an ENGAGED creature is being shown (task #51 item 1e;
 * spark-attention.ts's engagement model).
 *
 * It multiplies the link's value, so it re-ORDERS what a body would have done
 * anyway; it never commands. 3 is chosen to beat the ordinary distance
 * ranking without beating a personal need: at the shipped ladder a civic bill
 * presses `2 × 40 × urgency` and this lifts it to `6 × 40 × urgency` — above a
 * mild want, still under a hungry body (hunger 5 × 40, and urgency decays
 * while hunger climbs). "Look at THAT one" is a strong hint, not an order.
 */
export const SPARK_SALIENCE = 3;

/**
 * ⚖️ THE BILL ID OF A FELLING DESIGNATION — `fell:<featureId>`.
 *
 * 🚨 DELIBERATELY NOT `orderSiteId(ord)`. That spelling (`o:<ord>`) is the
 * CONSTRUCTION row's, and it is the exact string `workSite` keys presence on
 * (1a's contract): a designation minted with a construction ordinal would
 * collide with the site of the same number, and `contributeCrewAt` would count
 * a body chopping a tree as a body standing at a build site. The mark's
 * identity is THE THING, not a number in somebody else's sequence — which
 * also gives the seat count what it wants for free: one tree, one chopper.
 */
export const FELL_SITE_PREFIX = "fell:";
export function fellSiteId(featureId: string): string {
  return `${FELL_SITE_PREFIX}${featureId}`;
}

/** ⚖️ THE BILL ID OF A LOT-CLEARING BILL — `clear:<featureId>`. The same
 *  identity rule as a mark (the THING, not a number), spelled apart from it so
 *  a transcript says which of the two put a body on that tree: the child's
 *  press, or the builders' prerequisite. */
export const CLEAR_SITE_PREFIX = "clear:";
export function clearSiteId(featureId: string): string {
  return `${CLEAR_SITE_PREFIX}${featureId}`;
}

/**
 * ⚖️ A THING SOMEBODY MARKED TO COME DOWN (task #51 item 1d) — the row the
 * BOOKKEEPER hands the DECIDER, and the reason it lives in the seam: the
 * construction director mints them (lot clearing) and so does the host (the
 * player's own marks), and the reader consumes them. Neither side imports the
 * other.
 *
 * `standing` IS the cascade in one boolean: on its feet ⇒ the FELL link (chop
 * it); already a heap ⇒ the HAUL link that carries it off. Nobody schedules
 * the two — the second is what the row means once the first has happened.
 */
export interface FellRow {
  /** The bill's id — `fellSiteId` for a mark, `clearSiteId` for a lot bill.
   *  The seat count keys on it: one thing, one chopper. */
  siteId: string;
  /** The feature's ENDPOINT (its container id): what the chop acts on and what
   *  a haul draws from. */
  objId: string;
  /** Where it stands (the claim's price is measured to this point; the
   *  executor resolves the standable spot beside it). */
  at: { x: number; y: number };
  /** 🚨 The spoken word for the thing, never a species id. */
  word: string;
  /** Still on its feet ⇒ FELL; already a heap ⇒ HAUL. */
  standing: boolean;
  /** Whether a PLAYER asked for it (the "you asked" weight). */
  spoken: boolean;
  issuer: string;
  /** THE CARRY HALF, when this bill has one: the agreement the bookkeeper
   *  already posted and reserved against this thing (a puller ADOPTS it rather
   *  than posting a second row over the same units). */
  haul?: { agreementId: string; to: string; destWord: string; head: string; units: number };
}

/**
 * ⚖️ THE BILL ID OF A SPOKEN MAKE — `craft:<houseIndex>` (Stage 2d).
 *
 * 🚨 NOT `orderSiteId(ord)`, for the felling designation's reason exactly: a
 * `CraftJob` has no construction ordinal, it is keyed by the HOUSE INDEX whose
 * one craft slot it occupies (`TownDeltas.craftJobs`), and borrowing a
 * construction number would make `contributeCrewAt` count a body at a bench as
 * a body on a build site of the same ordinal. The house index IS the job's
 * identity — one slot per house — so it is also what gives the bench its one
 * seat for free.
 *
 * (The community slot is `COMMUNITY_CRAFT_HI`, a negative index, and spells
 * itself `craft:-1`. That is a legal key and a distinct one, which is the whole
 * requirement.)
 */
export const CRAFT_SITE_PREFIX = "craft:";
export function craftSiteId(houseIndex: number): string {
  return `${CRAFT_SITE_PREFIX}${houseIndex}`;
}
/** The house index of a `craft:` site id, or null when the id is some other
 *  family's. Total — the director switches on it. */
export function hiOfCraftSiteId(siteId: string): number | null {
  if (!siteId.startsWith(CRAFT_SITE_PREFIX)) return null;
  const tail = siteId.slice(CRAFT_SITE_PREFIX.length);
  // 🚨 `Number("")` IS 0, so an empty tail would answer HOUSE 0 — the bare
  // prefix must be a non-answer, not the first house's craft slot.
  if (!/^-?\d+$/.test(tail)) return null;
  return Number(tail);
}

/**
 * ⚖️ A SPOKEN `make`, READ AS A BILL (Stage 2d) — the row the BOOKKEEPER hands
 * the DECIDER for a standing `CraftJob`, and the reason it lives in the seam:
 * the construction director owns the job and the reader consumes it, and
 * neither imports the other.
 *
 * 🚨 THE PROBLEM IT ANSWERS. A craft's gathering was a HOUSEHOLD PUSH LANE —
 * one named body (`resident_<hi>_0`) carrying one draw per sweep, and only
 * while its house was watched — so the player's own `make cart` on a founded
 * frontier was served DEAD LAST behind every town-wide pull slice (2c: t≈440,
 * after all 16 site hauls), and on a quiet frontier not at all (measured: 0
 * deliveries in 408 s; 2b saw 0 in 900 s). Under the capability the materials
 * become an ordinary bill and the labour an ordinary seat, so the SAME argmax
 * that staffs a house staffs the bench.
 *
 * ⚖️ THE SETTLEMENT'S BUSINESS ONLY. The household's inventory rotation and its
 * program crafts are the family's own appetite, not the settlement's; they keep
 * the direct haul untouched (C4: "v1 IS THE SPOKEN `make cart`"). So this list
 * is empty off the capability AND empty for every automated job.
 *
 * 🧺 TWO KINDS REACH IT (baskets makeable, 2026-09-09): a SPOKEN `make`, and a
 * SELF-ISSUED DEMAND — a body whose own collection plan wanted an enabler the
 * world does not contain, priced against what making one costs. They differ in
 * exactly one field, `spoken`, which is the weight; everything downstream of
 * this row reads one kind of thing.
 */
export interface CraftBillRow {
  /** `craftSiteId(hi)` — what the seat and the presence count key on. */
  siteId: string;
  /** The house index the job's slot belongs to (negative = the community slot). */
  hi: number;
  /** The container the inputs pile into and the finished stack lands in. */
  spotId: string;
  /** The spot's own world anchor — where a haul delivers. */
  at: { x: number; y: number };
  /** head → units still wanted ON THE SPOT, ignoring hauls in flight (the
   *  reader nets those itself with `pileShortfall`, exactly as it does for a
   *  construction pile, so both families press on what has LANDED). */
  missing: Record<string, number>;
  /** head → the recipe's own folded total: the urgency denominator. */
  required: Record<string, number>;
  /** The dwell this row offers RIGHT NOW, or null when it is not workable yet
   *  (materials still short) or not workable any more (the job is gone).
   *  `leftS` is the labour still owed in seconds — the same currency a build
   *  row's `left × dayLengthS` is in. */
  work: { at: { x: number; y: number }; leftS: number; urgency: number } | null;
  /** The place word a haul to the spot announces ("house", "yard"). */
  destWord: string;
  /** Whether a PLAYER asked for it (the "you asked" weight). TRUE for a spoken
   *  `make`; FALSE for a self-issued DEMAND (`CraftJob.demand` — a body whose
   *  collection plan wanted an enabler the world does not contain), which is an
   *  ordinary civic bill and must not borrow the player's compliance weight.
   *  Carried rather than assumed so the weight is read where every other bill
   *  reads it. */
  spoken: boolean;
}

/** ⚖️ THE BILL ID OF A COLLECT — `collect:<endpoint>` (item 1e). A collect has
 *  no construction row either: its whole bill is "this loose thing belongs in
 *  that container", so it is keyed by the DESTINATION, and two bodies asked to
 *  tidy into the same crate share one seat count. */
export const COLLECT_SITE_PREFIX = "collect:";
export function collectSiteId(destEndpointId: string): string {
  return `${COLLECT_SITE_PREFIX}${destEndpointId}`;
}

/**
 * THE FOUR LINKS OF A BILL'S CHAIN, most downstream first. A reader lists
 * them in this order and a decider takes the most downstream one whose input
 * is available — that cascade is what makes the chain FLOW without anybody
 * ordering it:
 *   build  — labour at the site: materials staged, work left, a seat free.
 *   haul   — move `units` of `head` from `from` to `to` (site pile or bench
 *            pile). The source may be a container, a donor pile's SURPLUS, a
 *            standing feature's shelf or a folded area record's shelf.
 *   refine — labour at the bench: raw pile stocked, work left, a seat free.
 *   fell   — draw standing timber / a folded record onto its shelf, then
 *            haul (one leg: the puller draws the shelf ITSELF before posting
 *            the agreement — the director used to do that in the poster).
 *
 * 🚨 THE ORDER ABOVE IS NOW DERIVED, NOT DECLARED (emergent-plans-round.md D8).
 * "Most downstream first" used to be a literal rank table in the reader
 * (`contribute.ts` `LINK_RANK = {build:0, haul:1, refine:2, fell:3}`); it is
 * now `cascadeRank()` — `depthOf(CASCADE_SCHEMA, CASCADE_ROOT)` folded onto
 * these four names. Adding a link to the chain is adding a ROW to
 * `CASCADE_SCHEMA` below; nothing re-numbers by hand, and nothing may write a
 * rank literal again.
 */
export type ContributeLink = "build" | "haul" | "refine" | "fell";

// ── THE CASCADE AS A SCHEMA (emergent-plans-round.md D3/D8, erratum E-7) ─────
//
// ⚖️ WHAT THIS BLOCK IS. The four links above are the ACTIONS; the block below
// says what each action MAKES TRUE and what must hold before it can be taken.
// That is the whole means-ends vocabulary (`kernel/means-ends.ts`), and with it
// the cascade's order stops being an assertion and becomes an arithmetic
// consequence of the rows.
//
// 🚨 PRIMITIVES-ONLY. Every `StockKind` is a PREDICATE KIND — a question the
// bookkeeper already answers about a bill — never a good's head. There is no
// "block" and no "wood" anywhere in this schema, which is exactly why the same
// rows describe a stone site, a timber site and a world with neither.
//
// 🚨 IT DECIDES NOTHING. No reservation, no seat, no slice and no weight is
// read here. The reader (`contribute.ts`) still enumerates its rows exactly as
// it did, and the DECIDER's two rungs (town argmax / body beat), the
// worthwhile sign, the trip damper and the atomic reserve are untouched: this
// block only supplies the sort's FIRST key and names the rows the reader
// instantiates.

/**
 * THE PREDICATE KINDS OF A BILL'S CHAIN — each one a NON-RESERVING BOOKKEEPER
 * READ, named here for the first time (D2's tier T2). The read in brackets is
 * the one that decides the kind; nothing else may be invented to answer it.
 *
 *  · `built`       — [`buildworkSiteAt(session, siteId)`] the site has no dwell
 *                    work left: staged, labour done, geometry alive. FALSE for
 *                    as long as that read answers a spot to stand on. THE ROOT.
 *  · `staged`      — [`pileShortfall(stagingMissing(order))`] the site pile
 *                    holds the bill: no head is still short of it.
 *  · `refinedFree` — [`freeHeadStockWithinReach(session, pileAt, head, viewer)`]
 *                    for a REFINED head at the site pile: finished material
 *                    stands unspoken-for within this body's reach.
 *  · `stocked`     — [the refine order's own raw pile: the same
 *                    `pileShortfall ∘ stagingMissing` read, asked of the bench's
 *                    row] the bench holds what the mill needs to run.
 *  · `rawFree`     — [`freeHeadStockWithinReach(...)`] for a RAW head at the
 *                    BENCH: cut timber stands unspoken-for within reach.
 *  · `standing`    — [`fellRows(session)` with `standing === true`, or a source
 *                    whose ref `parseScopeId(...).kind === "wild"`] the material
 *                    is still IN THE WORLD, uncut. A PRIMITIVE: no row in this
 *                    schema makes a tree grow.
 *  · `seat`        — [`seatsOf(session, siteId)` minus `seatTaken`] there is a
 *                    free place to stand at this work. A PRIMITIVE: no action
 *                    here creates a seat (labour raising a bay does, and that
 *                    is the DIRECTOR's arithmetic, not a link).
 *  · `loose`       — [`looseGoodOf(objId)`] a thing is lying about with no bill
 *                    already drawing on it. A PRIMITIVE: the world drops it.
 */
export type StockKind =
  | "built"
  | "staged"
  | "refinedFree"
  | "stocked"
  | "rawFree"
  | "standing"
  | "seat"
  | "loose";

/**
 * THE ROW IDS OF THE SCHEMA — one per OPERATOR, which is NOT one per
 * `ContributeLink`.
 *
 * 🚨 E-7, AND IT IS THE WHOLE REASON THESE IDS EXIST. Two different hauls sit
 * at two different distances from a finished house: blocks onto the SITE pile
 * are one rung below `built`, raw timber onto the BENCH is three. They are the
 * same `ContributeLink` ("haul") to every consumer — one executor, one bound,
 * one bill shape — but they are NOT the same schema row, and a schema that
 * merged them into one `sourceFree` kind is CYCLIC (haul needs it, refine
 * achieves it, the raw haul needs it again — pinned in `cascade-schema.test.ts`
 * as the erratum). So the ROWS carry distinct ids and `contributeLinkOf` folds
 * them back down to the four names the rest of the engine speaks.
 */
export type CascadeRowLink =
  | "build"
  | "haul:site"
  | "refine"
  | "haul:bench"
  | "fell"
  | "fell:mark"
  | "collect";

/**
 * THE CHAIN, AS SEVEN ROWS. Read each as *"this action makes THAT true, once
 * THESE hold"* — the whole of `build → haul → refine → fell` and both of the
 * chain's side doors, with nothing left implicit.
 *
 * ⚖️ ROW ORDER IS THE TIE-BREAK (FIRST-WINS, Scout B risk 1): `frontier` and
 * every other consumer of this array keep it, so the array is written most
 * downstream first, exactly as the reader enumerates.
 *
 * ⚖️ `refine` NAMES THE EDGE; THE BOOKKEEPER STILL POSTS THE ROW (E-3). "Blocks
 * come from wood" is `rawsForRefined` (`products.ts`) and the refine ORDER is
 * minted by `ensureRefineOrders` with its 1+1 gather-ahead bound, which guards
 * a MEASURED four-concurrent-rows defect. This schema says only that a refined
 * head in reach can be produced by labour at a stocked bench; it does not mint,
 * and moving the mint into a walker is a later lift.
 *
 * ⚖️ `fell:mark` IS THE FELL LINK'S SECOND PROVENANCE, and it achieves
 * `rawFree` — the same shelf `fell` fills. A mark is a player's (or the
 * clearing sweep's) designation on a standing thing; cutting it leaves TIMBER
 * on a shelf, never finished material, so `rawFree` is the honest effect and
 * `refinedFree` would be a lie about what falls out of a tree. A mark with
 * nothing to carry (a bush in the way) buys GROUND rather than goods — it still
 * needs `standing` and still ends standing-less, so the same row describes it.
 *
 * ⚖️ `collect` IS A HAUL WITH NO BILL — a loose thing tidied into the place the
 * bill would have drawn from. It achieves `staged` like the site haul does,
 * from a PRIMITIVE (`loose`) instead of from a producible one, which is exactly
 * why it can never lengthen the chain.
 */
export const CASCADE_SCHEMA: readonly Operator<StockKind, CascadeRowLink>[] = [
  { link: "build", achieves: "built", needs: ["staged", "seat"] },
  { link: "haul:site", achieves: "staged", needs: ["refinedFree"] },
  { link: "refine", achieves: "refinedFree", needs: ["stocked", "seat"] },
  { link: "haul:bench", achieves: "stocked", needs: ["rawFree"] },
  { link: "fell", achieves: "rawFree", needs: ["standing"] },
  { link: "fell:mark", achieves: "rawFree", needs: ["standing"] },
  { link: "collect", achieves: "staged", needs: ["loose"] },
];

/** THE GOAL THE CHAIN HANGS OFF — "the thing is built". Every depth in the
 *  cascade is a distance from this one predicate, which is why a bill's chain
 *  can be read without knowing what is being built or out of what. */
export const CASCADE_ROOT: StockKind = "built";

/**
 * THE FOLD: which of the four spoken links a schema row IS.
 *
 * The rest of the engine — the bill, the executor routing, the transcript, the
 * seat ledger, `contributeCrewAt` — knows four links, and that is deliberate:
 * a haul is one act whichever pile it fills. This function is the ONLY place
 * the row vocabulary meets the link vocabulary.
 */
export function contributeLinkOf(row: CascadeRowLink): ContributeLink {
  switch (row) {
    case "haul:site":
    case "haul:bench":
    // ⚖️ A COLLECT IS A HAUL. It has always been offered as one (`decideCollect`
    // posts a `haul` bill against a `collect:<endpoint>` site) — the schema
    // gives it its own ROW because its input is a different fact, not because
    // it is a different act.
    case "collect":
      return "haul";
    // ⚖️ A MARK AND A WILD SOURCE ARE ONE LINK. Two provenances, one act:
    // "cut the standing thing down". The reader offers both as `fell` today.
    case "fell:mark":
      return "fell";
    default:
      return row;
  }
}

/**
 * THE CASCADE'S RANK — the sort key that used to be a literal.
 *
 * 🚨 THE FOLD IS **MIN**, and the literal's own wording is why. `LINK_RANK` was
 * documented as "the most downstream link", and `depthOf` folds a link shared
 * by two rows to its DEEPEST row (P's ruling, pinned in `means-ends.test.ts`) —
 * the opposite reading. A body that can serve either haul is standing one rung
 * below the finished house, not three, so the MIN over a link's rows is the
 * honest answer and it is taken HERE rather than in `means-ends.ts`: the fold
 * is a fact about these four names, not about schemas in general.
 *
 * The numbers come out `{build: 0, haul: 1, refine: 2, fell: 4}` where the
 * literal said `fell: 3`. THAT IS THE SAME ORDER — the value is only ever a
 * sort key (`contribute.ts`' first comparator term), never an index, a count or
 * a weight, so the arcs are byte-identical and the pin is ORDINAL.
 *
 * Cheap and pure (seven rows, no world), and computed ONCE at the reader's
 * module load.
 */
export function cascadeRank(): Record<ContributeLink, number> {
  const rowDepth = depthOf(CASCADE_SCHEMA, CASCADE_ROOT);
  const out = {} as Record<ContributeLink, number>;
  for (const row of Object.keys(rowDepth) as CascadeRowLink[]) {
    const d = rowDepth[row];
    const link = contributeLinkOf(row);
    const had = out[link] as number | undefined;
    if (had === undefined || d < had) out[link] = d;
  }
  return out;
}

/**
 * WHAT A CONTRIBUTE PURSUIT IS FOR — the slice a body issued to itself. Small
 * and flat on purpose: a pursuit is session-lived and never serialized, so a
 * reload simply re-decides (the why-chain is DERIVED from this, never stored
 * — `PooledTask.need` was cosmetic and died at reload; this does not).
 */
export interface ContributeBill {
  /** The director's OWN site id for the row this slice serves — the exact
   *  string `workSite(siteId, …)` is called with in construction-director.
   *  ⚠️ It is `orderSiteId(ord)` = `o:<ord>` for FOUNDED, ANNEX and REFINE
   *  rows ALIKE (construction-director `orderSiteId`, c-d:~3034); the
   *  pre-phase-2 `f:` / `a:` / `d:` spellings are gone from the engine and no
   *  reader should look for them. The bookkeeper's presence count matches on
   *  this exact string. */
  siteId: string;
  link: ContributeLink;
  /** The stack head this slice moves or mills. Absent for `build`. */
  head?: string;
  /** Units this body committed to — its reserved slice. Absent for the two
   *  dwell links (`build`, `refine`). */
  units?: number;
  /** The transfer agreement a `haul`/`fell` slice rides (posted with NO pool
   *  row; `issueTransferHaul` executes it). Absent for the dwell links. */
  agreementId?: string;
  /** ⚖️ THE THING THIS SLICE ACTS ON (task #51 item 1d/1e) — the endpoint of
   *  the feature a CHOP fells, or of the loose good a COLLECT lifts. Present
   *  ⇔ the body walks to a THING rather than to a pile: it is what tells the
   *  retirement test to ask "is it still standing?" instead of asking the
   *  agreement, and what the hover's salience is keyed on. */
  objId?: string;
  /** Whether a PLAYER spoke the order this bill descends from — the source of
   *  the "you asked" weight (relation × compliance). Civic bills are false. */
  spoken: boolean;
  /** The bill's issuer cid — read ONLY through `relationToward`. 🚨 Never a
   *  weight by itself: every civic sweep posts as LOCAL_PLAYER_CID. */
  issuer: string;
  /** ⚖️ THE SEAT THIS BODY IS STANDING ON (Stage 2, S1) — the ledger endpoint
   *  its `pull:<cid>` claim is spoken on (`seatKey`). Present ⇔ this slice
   *  holds a place at the work: a build bay, a bench, a tree. Absent for a
   *  HAUL (the reservation IS a haul's bound — S1/co:598) and for any slice
   *  that lost its seat and never got another. Carried on the pursuit so the
   *  sweep, the re-issue and the transcript can ask a BODY which seat it holds
   *  without walking the ledger. */
  seatKey?: string;
}

/**
 * ⚖️ M1 AT THE SLICE (politics-substrate, round-lead ruling on P-S3-1) — DID
 * THIS SLICE'S WORK LAND? The unit-grain answer to "they acted on your word AND
 * the need dropped", asked at the moment a contribute pursuit dies.
 *
 * 🚨 IT MIRRORS `contributeStillWorking`'s BRANCH ORDER EXACTLY, because it is
 * the same question asked one tick later — chop, then agreement, then site. Two
 * different orderings would price a slice the retirement test never retired.
 *
 * `null` means UNKNOWABLE, and unknowable never earns or costs anybody
 * authority (⚖️ the whole point of M1 is that the evidence is real):
 *  • A CHOP retires when the ERRAND ends, and the mark retires whether the tree
 *    came down or could not be cut at all — the host has nothing to read.
 *  • A DWELL at something that is not an order row (a craft bench) stops
 *    offering work when its raw stock runs out exactly as it does when the
 *    batch is milled. The caller passes `siteLanded: null` and this says
 *    nothing rather than guessing.
 */
export function sliceOutcome(
  bill: Pick<ContributeBill, "objId" | "units" | "agreementId">,
  ctx: {
    /** The transfer agreement's status is `done` — the units landed. */
    agreementDone?: boolean;
    /** The dwell site banked its labour (true), stopped without it (false), or
     *  cannot be asked (null/undefined). */
    siteLanded?: boolean | null;
  },
): "order-done" | "order-failed" | null {
  if (bill.objId !== undefined && bill.units === undefined) return null; // the chop
  if (bill.agreementId) return ctx.agreementDone ? "order-done" : "order-failed";
  if (ctx.siteLanded === null || ctx.siteLanded === undefined) return null;
  return ctx.siteLanded ? "order-done" : "order-failed";
}

/** The reservation-ledger HOLDER a puller books its slice under. One holder
 *  per body — a body works one slice at a time (`session.pursuits` is one
 *  slot per cid), so releasing the holder releases the slice. GC'd like
 *  `bag:` rows: a `pull:` row whose body holds no contribute pursuit is a
 *  leak, swept by the bookkeeper. */
export const PULL_HOLDER_PREFIX = "pull:";
export function pullHolder(cid: string): string {
  return `${PULL_HOLDER_PREFIX}${cid}`;
}
export function cidOfPullHolder(holder: string): string | null {
  return holder.startsWith(PULL_HOLDER_PREFIX) ? holder.slice(PULL_HOLDER_PREFIX.length) : null;
}

// ── ⚖️ SEATS, NOT CAPS (Stage 2, rulings S1–S5) ─────────────────────────────
//
// USER RULING (#50/#51): caps become SEATS. A cap is a number somebody wrote
// down; a seat is a PLACE — a bay of the shell, the bench, the tree — and a
// body that finds it taken takes the next link instead. So "how many may work
// here" stops being an integer and becomes a question about the work itself.
//
// 🚨 S1 — A SEAT IS A LEDGER CLAIM ON A SYNTHETIC ENDPOINT, NEVER ON A WORLD
// OBJECT. The claim is `reserve(pullHolder(cid), seatKey, "@tool", 1)`, and
// `seatKey` is `"<siteId>#seat<i>"` — a string NOTHING in the world answers to.
// A `@tool` unit on the bench OBJECT would be read by every `toolClaimed` /
// `freeUnits` consumer there is (`bagHolder`, `resolveMaterials` on the craft
// rotation), which is exactly the cross-talk that would move the dollhouse
// bench: the craft rotation resolves materials at the very spot a refine seat
// would sit on. A `#seat` endpoint is read by nothing but the seat code.
//
// ⚖️ LEDGER-BACKED, not a session map, because the occupancy record has to
// survive a reload, THREE decider entry points (`decideContribution` /
// `idleContribute` / `stepSettlerContribution` are separate sweeps) and a peer.
// Stage 1's `seatedOn` was a scan of `session.pursuits` — session-local, and
// blind to everything that is not a live pursuit.

/** The glyph a seat claim is spoken under — reservations.ts's
 *  `TOOL_CLAIM_GLYPH`, spelled out because this file is IMPORT-FREE by law
 *  (the header states why). The two are pinned equal in
 *  `pull-labor-seats.test.ts`, so they cannot drift in silence. */
export const SEAT_CLAIM_GLYPH = "@tool";

/**
 * A CLAIMABLE PLACE TO STAND AND WORK.
 *
 * `key` is the ledger ENDPOINT the claim is spoken on; `at` is where the body
 * actually stands; `index` is stable in `shellGhostPieces` build order (floor,
 * then walls, then roof) — and INDEX is what a body claims, never a point,
 * because the offered set MOVES as labour banks (S2: a bay raised under a body
 * simply drops out of the offer, and the body re-claims the next free index).
 */
export interface WorkSeat {
  siteId: string;
  link: ContributeLink;
  key: string;
  at: { x: number; y: number };
  index: number;
}

/**
 * THE RESERVATION LEDGER, structurally typed — the seam stays import-free, so
 * it names the four methods it uses rather than importing `ReservationLedger`.
 *
 * ⚠️ THE FIELD NAMES ARE THE REAL LEDGER'S (`endpoint` / `qty`), not a prettier
 * pair: structural assignability is the whole mechanism here, and a row shaped
 * `{ objId, units }` would simply refuse the real `ReservationRow`.
 */
export interface SeatLedger {
  reserve(holder: string, endpoint: string, glyph: string, qty: number): unknown;
  release(holder: string): void;
  reservedUnits(endpoint: string, glyph: string): number;
  holderRows(holder: string): ReadonlyArray<{ endpoint: string; glyph: string; qty: number }>;
}

/** `"<siteId>#seat<i>"` — the ONE spelling. A build bay's `i` is its index in
 *  `shellGhostPieces` order; a bench and a tree have exactly one seat, `i = 0`
 *  (so a mark's seat is `fell:<featureId>#seat0`). */
export function seatKey(siteId: string, index: number): string {
  return `${siteId}#seat${index}`;
}

/** Is this seat spoken for — by ANYBODY, this body included? */
export function seatTaken(ledger: SeatLedger, key: string): boolean {
  return ledger.reservedUnits(key, SEAT_CLAIM_GLYPH) > 0;
}

/** Every seat this body currently holds, in claim order. One holder per body
 *  by construction (`pull:<cid>`), so this is the whole of its occupancy. */
export function heldSeats(ledger: SeatLedger, cid: string): string[] {
  return ledger
    .holderRows(pullHolder(cid))
    .filter((r) => r.glyph === SEAT_CLAIM_GLYPH && r.qty > 0)
    .map((r) => r.endpoint);
}

/** Does THIS body hold this exact seat? */
export function seatHeldBy(ledger: SeatLedger, cid: string, key: string): boolean {
  return ledger
    .holderRows(pullHolder(cid))
    .some((r) => r.endpoint === key && r.glyph === SEAT_CLAIM_GLYPH && r.qty > 0);
}

/**
 * ⚖️ TAKE IT — READ AND RESERVE IN ONE SYNCHRONOUS STEP (the Stage 1 haul law,
 * contribute.ts:744-751). `reserve` CANNOT FAIL (reservations.ts: it merges,
 * there is no stack check and no compare-and-swap), so the free-check and the
 * claim must be one expression with nothing between them, and the callers must
 * visit bodies in one sorted-cid pass. Returns false ⇔ somebody else got there
 * first.
 *
 * IDEMPOTENT FOR ITS OWN HOLDER: a body re-issuing its standing dwell asks for
 * the seat it is already on and is told yes, rather than being bounced onto a
 * second bay and holding two.
 */
export function claimSeat(ledger: SeatLedger, cid: string, key: string): boolean {
  if (seatHeldBy(ledger, cid, key)) return true;
  if (seatTaken(ledger, key)) return false;
  ledger.reserve(pullHolder(cid), key, SEAT_CLAIM_GLYPH, 1);
  return true;
}

/** ⚖️ S4 — DROP EVERY SEAT THIS BODY HOLDS. One holder per body, so this is
 *  one `release`, and it is idempotent exactly like `release(agrHolder)`:
 *  call it on EVERY release door, unconditionally, rather than reasoning about
 *  which door a pursuit left by. */
export function releaseSeats(ledger: SeatLedger, cid: string): void {
  ledger.release(pullHolder(cid));
}

/**
 * ⚖️ S2 — HOW MANY BAYS LABOUR HAS ALREADY RAISED: `floor(f × n)`.
 *
 * 🚨 THERE IS NO PER-BAY BUILD RECORD ANYWHERE. A shell rises as a SCALAR
 * fraction (`labor / buildDays`), so a bay has a position but no "raised" bit —
 * which means the raised set is DERIVED, and it moves under the bodies as the
 * fraction climbs. That is the taper the ruling wants: many hands on the first
 * courses, one on the ridge, with nobody scheduling it.
 *
 * Clamped both ways. `f < 1` on any unfinished row, and `floor(f × n) ≤ n - 1`
 * there, so an unfinished site ALWAYS offers at least one seat — the site can
 * never starve itself of the hands that finish it.
 */
export function raisedBays(laborFraction: number, bayCount: number): number {
  if (!(bayCount > 0)) return 0;
  const f = Math.max(0, Math.min(1, laborFraction));
  return Math.max(0, Math.min(bayCount, Math.floor(f * bayCount)));
}

/** The structural shape every consumer needs of a pursuit to recognise a
 *  contribute one — quest-host's `Pursuit` satisfies it; the director never
 *  imports that type. */
export interface ContributePursuitLike {
  tplKey?: string;
  bill?: ContributeBill;
}

/** True ⇔ `p` is a body working a bill it chose. */
export function isContributePursuit(
  p: ContributePursuitLike | undefined | null,
): p is ContributePursuitLike & { tplKey: string; bill: ContributeBill } {
  return !!p && p.tplKey === CONTRIBUTE_TPL_KEY && p.bill !== undefined;
}

/**
 * ⚖️ THE `pullLabor` CAPABILITY — ONE derivation, fail-closed (the
 * feedback_context_via_scope_walk 08-25 idiom: a positively-named capability
 * derived in ONE place; no use site ever enumerates scope-type fields).
 *
 * Stage 1 grants it to THE HOMESTEAD and nothing else:
 *   · a FOUNDED SITE stands (the GL `frontier-planet` wild session once the
 *     founding premise lands — founding is a mid-session act in a wild
 *     session, which is why this is a read and not a boot-time boolean), or
 *   · a TOWN with a WILDERNESS scatter (the text `frontier.spec`
 *     `wilderness:true` young town; the planet-mounted town a founded site
 *     grows into).
 * The dollhouse (town, no scatter — the jx-doll-bench world) reads FALSE, so
 * every pull-model line is UNTAKEN there and the bench holds byte-identical
 * by construction. A bare wilderness session with no site and no town
 * (nature-hike) reads FALSE — nothing there has a bill.
 *
 * When the session's scope stack lands, this becomes a question the
 * containing scope answers; until then it is the one site that asks.
 */
export function pullLaborOn(s: {
  foundedSite?: unknown | null;
  town?: unknown | null;
  wilderness?: unknown | null;
}): boolean {
  // 🚨 ABSENT READS AS ABSENT — `!= null`, never `!== null`. A real
  // `QuestSession` initializes all three fields to null, but a PARTIAL session
  // is the normal shape of a unit fixture, and there they are simply MISSING:
  // `undefined !== null` is TRUE, so a strict read would hand the capability
  // to every fixture in every suite — the opposite of fail-closed, and
  // invisible until a dollhouse pin moved. (1a hit this and wrapped it
  // locally; the wrapper belongs here, at the ONE derivation.)
  return s.foundedSite != null || (s.town != null && s.wilderness != null);
}

/**
 * ⚖️ THE `bodyNeeds` CAPABILITY — HOUSEHOLDS AS SATISFIERS
 * (body-needs-round.md D4). ONE derivation, fail-closed, and DELIBERATELY the
 * same one `pullLaborOn` answers with, spelled as its own name so every use
 * site says what it is asking about.
 *
 * WHY THE SAME QUESTION. The three things this gates — a non-dollhouse
 * resident carrying an `energy` row, a live-but-dark body's meters ticking
 * instead of freezing, and a housed body going HOME when its satisfier is a
 * dark household — are all consequences of ONE fact about a world: that bodies
 * outside the observed household are being SIMULATED as bodies rather than
 * played by the schedule. That is exactly what pull-model labour asserts when
 * it lets a body off the clock's leash to take a piece of a bill. A world where
 * nobody self-issues work has no dark body worth ticking: its residents ARE
 * their schedule, and giving them a tiredness meter nobody would ever satisfy
 * is the "ungroundable need" the affordance law forbids.
 *
 * 🚫 THE DOLLHOUSE READS FALSE (town, no wilderness scatter, no founded site —
 * the jx-doll-bench world), so every D4 hunk is UNTAKEN there and the bench
 * holds byte-identical BY CONSTRUCTION, not by measurement. Nature-hike (no
 * town, no site) reads false too.
 *
 * ⚠️ AN ALIAS, NOT A COPY. It delegates rather than restating the predicate:
 * the two must never be able to drift, and when the session's SCOPE STACK
 * lands, both become a question the containing scope answers — at which point
 * they may legitimately diverge, and this is the one line that has to change.
 */
export function bodyNeedsOn(s: {
  foundedSite?: unknown | null;
  town?: unknown | null;
  wilderness?: unknown | null;
}): boolean {
  return pullLaborOn(s);
}
