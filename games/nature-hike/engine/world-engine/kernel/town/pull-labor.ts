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
// reservation HOLDER namespace a puller books under, and the ONE derivation
// of the `pullLabor` capability. Nothing here reads a session, a ledger or a
// body: every consumer passes what it has.

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
 * ⚖️ SPOKEN ONLY. The household's inventory rotation and its program crafts
 * are the family's own appetite, not the settlement's; they keep the direct
 * haul untouched (C4: "v1 IS THE SPOKEN `make cart`"). So this list is empty
 * off the capability AND empty for every automated job.
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
  /** Always true today (only spoken jobs are enumerated) — carried rather than
   *  assumed so the weight is read where every other bill reads it. */
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
 */
export type ContributeLink = "build" | "haul" | "refine" | "fell";

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
