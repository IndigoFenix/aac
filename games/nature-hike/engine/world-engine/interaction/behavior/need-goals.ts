// shared/world-engine/interaction/behavior/need-goals.ts
//
// NEED → SELF-ASSIGNED COMMAND (action-consolidation S2): the pure mapping from
// a decided need (template + intent, the walker's own choice) to the GoalSpec a
// unified pursuit drives. The consolidation's north star made literal — "a
// need-derived action is essentially a self-assigned command": SELECTION stays
// with `decideNeeds` (meters, priorities, claims, blocked surfacing), and the
// DRIVE becomes the same `pursue` loop a spoken command runs.
//
// Deliberately PARTIAL — this is the S2 slice, behind a flag:
//   • Only the CLEAN motives route (NEED_PURSUIT_MOTIVES): hunger/thirst
//     (consume-shaped), energy/waste/hygiene (rest-shaped), social (converse).
//     The stack-economy motives (provision, tidy, laundry, dress, cook, fun's
//     affordance acquire…) return [] and stay on the legacy needStep walker
//     until S3 puts `units` + reach budgets on the goal vocabulary.
//   • A body already carrying matching units RETURNS [] too: the item resolver
//     sees loose props and container stocks in the world, never what is on a
//     body (its hands, its basket, its satchel — scope-unification.md §2.1), so
//     the legacy walker keeps those eats (seat show intact).
//   • The caller must COMPILE-CHECK the returned candidates in order and fall
//     through to the legacy path when none plans — that is the degradation
//     seam: market shelves and the town well are invisible to the resolver on
//     purpose (a hungry body with an empty pantry still takes its legacy
//     shopping trip, restock sizing and purse accounting included).
//
// Candidates are ORDERED (first compilable wins). A food want prefers a HOT
// unit — the cook's work is worth eating (round 7's eatOrder) — so it tries
// `state: "hot"` before plain; stacked units carry no states, so the hot pass
// finds only VISIBLE served meals (the dinner on the table), exactly the units
// the preference exists for.

import type { NeedIntent, NeedTemplate } from "@shared/world-engine/interaction/behavior/needs.js";
import type { GoalSpec, PursuitGoal } from "@shared/world-engine/interaction/behavior/rules.js";

/** Motives (the template key's prefix before ":") that ride the unified pursuit
 *  engine. THE S2 FLAG: remove a motive to revert it to the legacy walker. */
export const NEED_PURSUIT_MOTIVES: ReadonlySet<string> = new Set([
  "hunger",
  "thirst",
  "energy",
  "waste",
  "hygiene",
  "social",
  // ⑫⑧ — STOPPING TO FACE SOMEBODY, the conversation-in-motion duty row. It
  // rides the pursuit for the same reason `attend` does: the price the chapter
  // is about (`ADDRESS_DWELL_S`) is a PLAN price, and only the pursuit path
  // carries one. Its `satisfy` is `social` — the partner IS the station — so
  // the walker's own social arm decides it and this file only says which goal
  // that decision names.
  "address",
  // ATTENDING a ritual (rituals.ts) — a rest at a named station, the same shape
  // as the toilet and the bath, and it belongs here for a specific reason: the
  // pursuit is the path that carries the ON-FIXTURE ARRIVAL CONTRACT
  // (`onFixtureUseTargetOf`), which exists because a body sitting on a piece
  // must land somewhere the furniture anchor can pick it up, not merely near a
  // stand spot. The legacy walker's `standPointFor` judges a chair's general
  // clearance instead, and for a chair tucked under a table it answered with
  // the far side of the TABLE — 2.5 m away, tabletop in between — so the head
  // dwelt out its whole sit across the room and the gathering never counted it
  // as seated. The claim is honoured because the caller narrows this row's
  // station list to THIS body's seat, so the goal's named place is that chair.
  "attend",
]);

/** STACK-ECONOMY motives whose decided legs ride the pursuit as stack
 *  micro-goals (S3): `takeUnits`/`putUnits` (slice 1), and `processUnits`/
 *  `equipUnits`/`dropUnits` (slice 2 — the wash/cook dwell, the change of
 *  clothes, the put-it-down). THE S3 FLAG — per-motive, same contract as
 *  above. Fun's set-out (`setOutHere`) stays legacy — the thing being put down
 *  is what BECOMES the station, so there is nothing to plan toward. */
export const NEED_PURSUIT_STACK_MOTIVES: ReadonlySet<string> = new Set([
  "provision",
  "tidy",
  "stow",
  // A ritual's PREP row — laying the table for the heads coming (rituals.ts).
  // Its deposit leg is an ordinary putUnits haul, exactly as `serve`'s was.
  "prep",
  "dress",
  "fun",
  "unload",
  // The put-down row (needs.ts `relieveTemplate`): its deposit is an ordinary
  // putUnits leg and its drop an ordinary dropUnits one — the difference is
  // only what the effect finds in the hands (a whole object, possibly a bag).
  "relieve",
  "laundry",
  "cook",
  // Adoption rows ("adopt:<wanter>|<tpl>") are deposit-shaped supply runs into
  // the SAME household (adoptionTemplates gates by house), so their take/
  // deposit legs ride the stack micro-goals like any provision trip (S4).
  "adopt",
]);

/**
 * WHAT A COOKED MEAL IS WORTH OVER RAW FOOD, in hand-seconds — the ONE taste
 * term this pass introduces, and the reason the hot-first ordering above
 * survives becoming an argmax (step ④, `chooseNeedGoal` in quest-host).
 *
 * Before costs, "hot first" was absolute: the served dinner won however far off
 * it stood. Priced, the two candidates differ only in their walk, so without a
 * taste term a raw apple in the pantry beside you would always beat the meal
 * somebody cooked — and the cook's work would go cold on the table.
 *
 * 30 s is the exchange rate, stated as a distance: at the villager's 1.6 m/s a
 * body will walk **≈48 m further** for the dinner than for the raw unit, and no
 * further. That is three quarters of one pressure point (`NEED_PRESSURE_S` 40 —
 * the seconds one rung of the ladder buys), which is about what the cook row
 * (3.3) puts into a meal over what the raw unit was already worth: enough to
 * cross a house for dinner, not enough to cross the town.
 */
export const HOT_MEAL_TASTE_S = 30;

/** The taste bonus this candidate carries, in hand-seconds — the value side of
 *  the pursuit argmax. Zero for everything but a cooked meal; the knowledge of
 *  WHICH candidate is the hot one stays here, beside the ordering it replaces,
 *  rather than leaking into the host as a peek at `goal.item.match.state`. */
export function tasteBonusS(goal: PursuitGoal): number {
  if (goal.kind !== "consume") return 0;
  const m = "match" in goal.item ? goal.item.match : undefined;
  return m?.state === "hot" ? HOT_MEAL_TASTE_S : 0;
}

export interface NeedGoalOpts {
  /** Units ON THE BODY matching the template's item (its hands plus the
   *  containers it holds — `bodyCarryView`). > 0 keeps the eat on the legacy
   *  walker: what a body is carrying is invisible to the item resolver, which
   *  only sees things standing in the world. */
  carriedMatching: number;
  /** The motive's dwell length (restDwellFor) — a nap, the toilet, the scrub. */
  restDwellS: number;
  /** Where the body stands now (a restHere doze dwells in place). */
  body: { x: number; y: number };
}

/**
 * The GoalSpec candidates for one decided need, best first — [] means "not this
 * slice; run the legacy needStep path". The caller tries each with compileGoal
 * and installs the first that plans (source: "need").
 */
export function needPursuitGoals(tpl: NeedTemplate, intent: NeedIntent, opts: NeedGoalOpts): PursuitGoal[] {
  const motive = tpl.key.split(":")[0]!;
  const stack = NEED_PURSUIT_STACK_MOTIVES.has(motive);
  if (!NEED_PURSUIT_MOTIVES.has(motive) && !stack) return [];
  // The decided take/deposit leg as a stack micro-goal — the walk-and-move-N
  // the legacy walker would have run, carrying the row's key for kind
  // selection, strike keys and the household claim's audit trail.
  const takeLeg = (i: Extract<NeedIntent, { kind: "take" }>): GoalSpec => ({
    kind: "takeUnits",
    from: i.from.place,
    category: tpl.item.category ?? "",
    units: i.units,
    ...(tpl.item.affords ? { affords: tpl.item.affords } : {}),
    tplKey: tpl.key,
  });
  switch (intent.kind) {
    case "take":
    case "consumeAt": {
      // The acquire-and-eat family (hunger/thirst): the WHOLE chain as one
      // consume goal (pantry pick → dining leg → eat). A take for a STACK
      // motive (provision's buy, tidy's pickup, dress/fun's fetch) is instead
      // one bounded takeUnits leg.
      if (tpl.satisfy.kind !== "consume") {
        return stack && intent.kind === "take" ? [takeLeg(intent)] : [];
      }
      const cat = tpl.item.category;
      if (!cat) return [];
      const at = tpl.satisfy.at;
      // A unit already ON THE BODY (S4): eat IT — walk to the dining station
      // when one resolves (the seat show), else in place. The single-item
      // consume plans against things standing in the world and cannot see a
      // body's own carry, so this is its own micro-goal.
      if (opts.carriedMatching > 0) {
        return [{ kind: "consumeUnits", category: cat, ...(at ? { at } : {}), tplKey: tpl.key }];
      }
      const mk = (match: { category: string; state?: string }): GoalSpec => ({
        kind: "consume",
        item: { match },
        ...(at ? { at } : {}),
      });
      // Food reaches for the served HOT meal first, raw as the fallback — and a
      // decided TAKE adds the stack leg LAST (S3): when no supply is visible to
      // the item resolver (a market shelf, the well — derived stock), the walk-
      // and-buy still rides the pursuit; the carry eat that follows re-decides.
      const eats = cat === "food" ? [mk({ category: cat, state: "hot" }), mk({ category: cat })] : [mk({ category: cat })];
      return intent.kind === "take" ? [...eats, takeLeg(intent)] : eats;
    }
    case "deposit":
      // Put the carried units away (provision's bank, tidy's return, serve's
      // plating, stow's wardrobe, unload's shelf) — one bounded putUnits leg.
      if (!stack) return [];
      return [
        {
          kind: "putUnits",
          into: intent.into.place,
          category: tpl.item.category ?? "",
          units: intent.units,
          tplKey: tpl.key,
        },
      ];
    case "restAt":
      // A `use` row's station is a PLAY AREA — a thing set out on the floor,
      // not a rest FIXTURE. The pursuit's rest primitive resolves its station
      // against the fixture table (bed/chair/bath/toilet), so a floor station
      // would resolve to nothing there and pose the body `sit` beside whatever
      // furniture happened to be nearest. The legacy step knows how to ring a
      // floor station and how to hold the play pose, so play stays on it.
      if (tpl.satisfy.kind === "use") return [];
      return [{ kind: "rest", place: { kind: "named", id: intent.station.id }, dwellS: opts.restDwellS }];
    case "restHere": {
      // No station — dwell where the body stands. The POSE can't be derived
      // from a fixture out in the open, so the motive says it: fun's
      // toy-in-hand dwell is a PLAY, an energy doze is a SLEEP, the rest sit.
      const pose = motive === "fun" ? "play" : motive === "energy" ? "sleep" : "sit";
      return [{ kind: "rest", place: { kind: "point", x: opts.body.x, y: opts.body.y }, dwellS: opts.restDwellS, pose }];
    }
    case "socialize":
      // The partner IS the station candidate (the ctx lists housemates there).
      //
      // ⑫⑧ — …and the ADDRESS row is the same shape with the journey taken
      // out. Both are "go and be social with THAT person"; they differ in
      // whether you have to go, which is exactly the difference the chapter
      // prices. Reading the motive rather than adding a second satisfy kind
      // keeps the walker's social arm the one decision for both.
      return motive === "address"
        ? [{ kind: "address", target: intent.station.id }]
        : [{ kind: "converse", target: intent.station.id }];
    case "processAt":
      // The wash at the tub / the pot at the oven: walk to the decided station
      // and dwell the work out — the facet edit comes from the template's own
      // transform spec, the dwell from the motive.
      if (!stack || tpl.satisfy.kind !== "transform") return [];
      return [
        {
          kind: "processUnits",
          at: { kind: "named", id: intent.station.id },
          category: tpl.item.category ?? "",
          ...(tpl.satisfy.drop ? { drop: tpl.satisfy.drop } : {}),
          ...(tpl.satisfy.add ? { add: tpl.satisfy.add } : {}),
          dwellS: opts.restDwellS,
          tplKey: tpl.key,
        },
      ];
    case "equipHere":
      // The change of clothes where the body stands (beside the wardrobe the
      // take leg just visited).
      if (!stack) return [];
      return [{ kind: "equipUnits", category: tpl.item.category ?? "", tplKey: tpl.key }];
    case "dropHere":
      // Nowhere to put it away — set the units down as real loose props.
      if (!stack) return [];
      return [{ kind: "dropUnits", category: tpl.item.category ?? "", units: intent.units, tplKey: tpl.key }];
    case "setOutHere":
      // GETTING THE TOY OUT is an act in place with no walk and no station to
      // plan toward — the thing being set out is what BECOMES the station. The
      // legacy step performs it atomically (the unit leaves the hands, the prop
      // lands, the setter is installed as its first player) and the NEXT decide
      // finds the area under `stations` and rings the body round it.
      return [];
    default:
      // consumeHere only fires while carrying (bag — the legacy seat eat).
      return [];
  }
}
