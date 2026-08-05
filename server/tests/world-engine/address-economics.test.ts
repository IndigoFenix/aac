// ⑫⑧ — THE DECISION ECONOMICS: stopping to face somebody as a PRICED ROW
// (planning-docs/games/world-engine/conversation-in-motion.md §4 ⑧).
//
// *(user direction, verbatim)*: "In a conversation with multiple strong users,
// working while conversing should have a cost… I meant that it costs in a
// decision-making sense. A creature must decide if it is worth stopping its
// activity to focus on the conversation, or ending the conversation to perform
// its work."
//
// 🚨 SO THERE IS NO PENALTY ANYWHERE IN HERE, and the negative pins matter as
// much as the positive ones: nothing multiplies work slower, nothing fines a
// distracted creature, an outbid row never parks, and `forgoneS` stays zero
// because the argmax IS the opportunity cost. Everything below is one more row
// in the comparison that has decided every other thing a body does since
// step ④.
//
// WHY THIS IS A MIRROR TEST. `quest-host.ts` cannot be value-imported here: its
// import chain reaches JSX, which this jest project does not compile. So each
// host rule below is re-stated as the host's OWN expression — copied, not
// paraphrased, and labelled with the function it copies — and then driven
// through the very modules the host drives (`needs.ts`, `need-goals.ts`,
// `action-planner.ts`, `conversation.ts`). Same discipline as
// `conversation-host-membership.test.ts` and `conversation-groups.test.ts`.
//
// DB-free / GL-free — runs in `npm run test:engine`.

import { describe, it, expect } from "@jest/globals";
import {
  decideNeed,
  decideNeeds,
  intentCost,
  rowValueS,
  urgencyOf,
  needFires,
  energyTemplate,
  funTemplate,
  hungerTemplate,
  socialTemplate,
  thirstTemplate,
  hygieneTemplate,
  laundryTemplate,
  dressTemplate,
  ritualAttendTemplate,
  NEED_PRESSURE_S,
  type NeedCtx,
  type NeedIntent,
  type NeedTemplate,
} from "@shared/world-engine/interaction/behavior/needs.js";
import {
  needPursuitGoals,
  NEED_PURSUIT_MOTIVES,
} from "@shared/world-engine/interaction/behavior/need-goals.js";
import { compileGoal, type WorldResolver, type GoalStep } from "@shared/world-engine/interaction/behavior/goal-selection.js";
import type { GoalSpec, PursuitGoal } from "@shared/world-engine/interaction/behavior/rules.js";
import { ARBITRATION } from "@shared/world-engine/interaction/dialogue/respond.js";
import {
  addressingOf,
  createConversation,
  joinConversation,
  leaveConversation,
  memberOf,
  recordUtterance,
  type ConversationState,
} from "@shared/world-engine/interaction/dialogue/conversation.js";
import { DOLLHOUSE_SCALE, needFillS, needRate, restDwellS, walkSpeedMps } from "@shared/world-engine/scale.js";
import { LOCAL_PLAYER_CID } from "@shared/world-engine/interaction/quest/player-identity.js";
import type { Vec2 } from "@shared/world-engine/types.js";

// ---------------------------------------------------------------------------
// The host's own constants, mirrored
// ---------------------------------------------------------------------------

/** MIRROR of `GROUP_TURN_GAP_S` — seconds between turns in a talking circle. */
const GROUP_TURN_GAP_S = 4;
/** MIRROR of `ADDRESS_DWELL_S`. **Derived, not invented** — see the identity
 *  pin below: the price of facing somebody IS the length of the thing you are
 *  buying, so it is written as the turn gap and not as a second number. */
const ADDRESS_DWELL_S = GROUP_TURN_GAP_S;
/** MIRROR of `ADDRESS_ASKED_BONUS` — one full priority rung. */
const ADDRESS_ASKED_BONUS = 1;
/** MIRROR of `OUTBID_LEAVE_S` and of `CHAT_INTERVAL` (the sweep's cadence). */
const OUTBID_LEAVE_S = 20;
const CHAT_INTERVAL = 9;
/** MIRROR of the host's dwell constants (quest-host module scope). */
const BOX_ACT_DWELL_S = 1.1;
const EAT_SHOW_S = 2;
const FUN_DWELL_S = 7;
const WALK_MPS = walkSpeedMps(DOLLHOUSE_SCALE);
const SLEEP_S = restDwellS(DOLLHOUSE_SCALE);

const MARA = "resident_0_0";
const BRAM = "resident_0_1";
const CAL = "resident_0_2";
const ANN = LOCAL_PLAYER_CID;
const hi = { kind: "how-are-you" as const, glyph: "hi" };

// ---------------------------------------------------------------------------
// The host's ⑫⑧ block, mirrored
// ---------------------------------------------------------------------------

/** MIRROR of `isAddressKey` / `addressTargetOf`. */
const isAddressKey = (k: string) => k.startsWith("address:");
const addressTargetOf = (k: string) => k.slice("address:".length);

/** MIRROR of `addressPriority(session, c, cid)` — the loneliness row's own rung
 *  plus a decaying "somebody just asked me something", on `courtesy`'s curve. */
function addressPriority(c: ConversationState, cid: string, tick: number): number {
  const base = socialTemplate(0).priority;
  const asked = memberOf(c, cid)?.lastAddressedTick;
  if (asked === undefined) return base;
  const since = Math.max(0, tick - asked);
  return base + ADDRESS_ASKED_BONUS * Math.exp(-since / ARBITRATION.courtesyTicks);
}

/** MIRROR of `lastOtherSpeakerIn(c, cid)`. */
function lastOtherSpeakerIn(c: ConversationState, cid: string): string | undefined {
  for (let i = c.history.length - 1; i >= 0; i--) {
    const u = c.history[i]!;
    if (u.speakerId === cid) continue;
    if (!memberOf(c, u.speakerId)) continue;
    return u.speakerId;
  }
  return undefined;
}

/** MIRROR of `addressRowsFor(session, cid)` — the derived duty row. */
function addressRowsFor(c: ConversationState | null, cid: string, tick: number): NeedTemplate[] {
  if (!c || c.members.length < 3) return []; // law ④ — a dyad charges nothing
  const target = lastOtherSpeakerIn(c, cid);
  if (!target) return [];
  if (addressingOf(c, cid) === target) return []; // paid already — an address is durable
  return [
    {
      key: `address:${target}`,
      item: {},
      drive: { kind: "meter", rate: 0, threshold: 0 },
      satisfy: { kind: "social" },
      acquire: [],
      priority: addressPriority(c, cid, tick),
    },
  ];
}

/** MIRROR of `addressNeedCtx(session, cid, tpl)`. */
function addressNeedCtx(tpl: NeedTemplate): NeedCtx {
  const target = addressTargetOf(tpl.key);
  return {
    carried: 0,
    containers: {},
    sources: [],
    stations: [{ id: target, place: { kind: "creature", id: target }, kind: "member", waiting: 0, d: 0 }],
    price: {
      walkMps: WALK_MPS,
      fillS: needFillS(DOLLHOUSE_SCALE, "social"), // `needClockKeyOf("address:…") === "social"`
      unitValueS: 0,
      shortage: 0,
      handsS: { container: 0, source: 0, loose: 0, satisfy: ADDRESS_DWELL_S },
    },
  };
}

/** MIRROR of `noteAddressOutcome(session, cid, templates, decided?.tpl)`. */
function noteAddressOutcome(
  outbid: Map<string, number>,
  cid: string,
  templates: readonly NeedTemplate[],
  won: NeedTemplate | undefined,
  tick: number,
): void {
  const row = templates.find((t) => isAddressKey(t.key));
  if (!row || (won && isAddressKey(won.key))) {
    outbid.delete(cid);
    return;
  }
  if (!outbid.has(cid)) outbid.set(cid, tick);
}

/** MIRROR of `sweepGroups`'s ⑫⑧ arm — the outbid deadline, read on the 9 s
 *  sweep, marking `leaving` (never departing: the goodbye is owed). */
function sweepOutbid(outbid: Map<string, number>, roster: readonly string[], leaving: Set<string>, tick: number): void {
  for (const cid of roster) {
    const since = outbid.get(cid);
    if (since !== undefined && tick - since >= OUTBID_LEAVE_S) {
      outbid.delete(cid);
      leaving.add(cid);
    }
  }
}

/** MIRROR of `parkNeed`'s ⑫⑧ guard — the whole of the no-park law. */
function parkNeed(parks: Set<string>, cid: string, tplKey: string): void {
  if (isAddressKey(tplKey)) return; // 🚨 AN OUTBID ROW MUST NOT PARK
  parks.add(`row|${cid}|${tplKey}`);
}

/** MIRROR of `stepPlanHandsS`'s `address` arm plus the two it sits beside. */
function stepPlanHandsS(step: GoalStep): number {
  switch (step.kind) {
    case "moveTo":
    case "faceHold":
      return 0;
    case "address":
      return ADDRESS_DWELL_S;
    case "eat":
    case "consumeStack":
      return EAT_SHOW_S;
    default:
      return BOX_ACT_DWELL_S;
  }
}

/** A resolver with just enough world to plan a turn: everybody stands somewhere. */
function resolverAt(positions: Record<string, Vec2>): WorldResolver {
  return {
    positionOf: (id) => positions[id] ?? null,
    homeOf: () => null,
    place: () => null,
    resolveItem: () => null,
    itemPosition: () => null,
    stationFor: () => null,
    price: { walkMps: WALK_MPS, handsS: stepPlanHandsS },
  };
}

// ---------------------------------------------------------------------------
// A circle of three, with somebody having just said something
// ---------------------------------------------------------------------------

function circle(speaker = BRAM, tick = 0): ConversationState {
  const c = createConversation("conv:1", tick);
  for (const id of [MARA, BRAM, CAL]) joinConversation(c, id, tick, "b");
  recordUtterance(c, { tick, speakerId: speaker, act: hi });
  return c;
}

// ---------------------------------------------------------------------------
// The row shape
// ---------------------------------------------------------------------------

describe("the address row — a duty, derived from the live conversation", () => {
  it("always fires and always presses exactly once: a duty has no deficit to measure", () => {
    const c = circle();
    const [row] = addressRowsFor(c, MARA, 0);
    expect(row).toBeDefined();
    const ctx = addressNeedCtx(row!);
    expect(needFires(row!, ctx)).toBe(true);
    expect(urgencyOf(row!, ctx)).toBe(1);
    // …and it is the same shape the ritual seat already uses, which is why no
    // new machinery was needed for it.
    expect(row!.drive).toEqual(ritualAttendTemplate("meal", "chair").drive);
  });

  it("law ④ — A CONVERSATION OF TWO NEEDS NO ADDRESSING, so a dyad grows no row at all", () => {
    const c = createConversation("conv:2", 0);
    joinConversation(c, MARA, 0, "b");
    joinConversation(c, BRAM, 0, "b");
    recordUtterance(c, { tick: 0, speakerId: BRAM, act: hi });
    expect(addressRowsFor(c, MARA, 0)).toEqual([]);
    // …and it appears the moment a third person arrives.
    joinConversation(c, CAL, 1, "b");
    expect(addressRowsFor(c, MARA, 1)).toHaveLength(1);
  });

  it("AN ADDRESS IS DURABLE, so the row retires the moment the beat lands", () => {
    const c = circle();
    expect(addressRowsFor(c, MARA, 0)).toHaveLength(1);
    memberOf(c, MARA)!.addressing = BRAM; // what `setMemberAddress` writes
    expect(addressRowsFor(c, MARA, 0)).toEqual([]);
    // …and it comes back when the address stops being a live fact.
    leaveConversation(c, BRAM);
    joinConversation(c, "resident_0_3", 1, "b");
    recordUtterance(c, { tick: 1, speakerId: CAL, act: hi });
    expect(addressRowsFor(c, MARA, 1)).toHaveLength(1);
    expect(addressRowsFor(c, MARA, 1)[0]!.key).toBe(`address:${CAL}`);
  });

  it("nobody has spoken yet ⇒ nobody to face ⇒ no row (never a row aimed at nobody)", () => {
    const c = createConversation("conv:3", 0);
    for (const id of [MARA, BRAM, CAL]) joinConversation(c, id, 0, "b");
    expect(addressRowsFor(c, MARA, 0)).toEqual([]);
  });

  it("rides the unified pursuit as a TURN, never as the walk `converse` is", () => {
    const c = circle();
    const [row] = addressRowsFor(c, MARA, 0);
    const ctx = addressNeedCtx(row!);
    const intent = decideNeed(row!, ctx);
    expect(intent).toEqual({ kind: "socialize", station: ctx.stations[0] });
    expect(NEED_PURSUIT_MOTIVES.has("address")).toBe(true);
    const goals = needPursuitGoals(row!, intent, { carriedMatching: 0, restDwellS: 0, body: { x: 0, y: 0 } });
    expect(goals).toEqual([{ kind: "address", target: BRAM }]);
    // The same intent from the ordinary loneliness row is the walk — one
    // decision, two prices, and the motive is what tells them apart.
    const social = socialTemplate(needRate(DOLLHOUSE_SCALE, "social"));
    expect(needPursuitGoals(social, intent, { carriedMatching: 0, restDwellS: 0, body: { x: 0, y: 0 } })).toEqual([
      { kind: "converse", target: BRAM },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 🚨 `ADDRESS_DWELL_S` prices what it claims to price
// ---------------------------------------------------------------------------

describe("🚨 the price of facing somebody is the length of the thing you are buying", () => {
  it("IS the circle's turn gap — derived, not invented", () => {
    expect(ADDRESS_DWELL_S).toBe(GROUP_TURN_GAP_S);
  });

  it("the compiled plan is ONE step, priced at the dwell with NO journey", () => {
    const r = resolverAt({ [MARA]: { x: 0, y: 0 }, [BRAM]: { x: 30, y: 40 } }); // 50 m apart
    const plan = compileGoal({ kind: "address", target: BRAM }, MARA, r);
    expect(plan).not.toBeNull();
    expect(plan!.steps).toEqual([{ kind: "address", target: BRAM }]);
    // 🚨 THE JOURNEY IS ZERO EVEN AT 50 m, and that is the point: addressing is
    // the channel you buy WITHOUT going anywhere (law ②). A walk leg here would
    // quietly turn it into `converse` and price it as one.
    expect(plan!.cost.journeyS).toBe(0);
    expect(plan!.cost.handsS).toBe(ADDRESS_DWELL_S);
    expect(plan!.cost.spoilageS).toBe(0);
    // 🚨 `forgoneS` STAYS 0 — the argmax IS the opportunity cost. Charging the
    // displaced work inside the row would double-count it.
    expect(plan!.cost.forgoneS).toBe(0);
  });

  it("…and the ROW's own price says the same thing, so the two seats cannot disagree", () => {
    const c = circle();
    const [row] = addressRowsFor(c, MARA, 0);
    const ctx = addressNeedCtx(row!);
    const cost = intentCost(row!, ctx, decideNeed(row!, ctx));
    expect(cost).toEqual({ journeyS: 0, handsS: ADDRESS_DWELL_S, spoilageS: 0, forgoneS: 0 });
  });

  it("a body that is not there cannot be faced — the plan blocks rather than turning at nothing", () => {
    const r = resolverAt({ [MARA]: { x: 0, y: 0 } }); // BRAM is a formless spirit
    expect(compileGoal({ kind: "address", target: BRAM }, MARA, r)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE MEASURED RUNG SPACING — what this row actually beats
// ---------------------------------------------------------------------------

describe("the measured ladder — what turning to somebody is worth against the drives", () => {
  /** Every DRIVE-SERVING row's worth at its firing point, in hand-seconds:
   *  `min(priority × NEED_PRESSURE_S, its own fill clock)`. (The deposit family
   *  — tidy, provision, stow… — prices on the GOODS arm instead, so its rows
   *  move with shortage and are not on this ladder.) */
  const worthOf = (tpl: NeedTemplate, ctx: NeedCtx, intent: NeedIntent) => rowValueS(tpl, ctx, intent);
  const driveWorth = (tpl: NeedTemplate, key: Parameters<typeof needFillS>[1]): number => {
    const fillS = needFillS(DOLLHOUSE_SCALE, key);
    const ctx: NeedCtx = {
      meter: tpl.drive.kind === "meter" ? tpl.drive.threshold : 0,
      carried: 0,
      containers: {},
      sources: [],
      stations: [],
      price: { walkMps: WALK_MPS, fillS, unitValueS: 0, shortage: 0, handsS: { container: 0, source: 0, loose: 0, satisfy: 0 } },
    };
    return worthOf(tpl, ctx, { kind: "restHere" });
  };

  const rate = (k: Parameters<typeof needRate>[1]) => needRate(DOLLHOUSE_SCALE, k);

  it("the address row's own worth: one social rung, and two with a fresh question", () => {
    const c = circle();
    const cold = addressRowsFor(c, MARA, 0)[0]!;
    const coldCtx = addressNeedCtx(cold);
    expect(worthOf(cold, coldCtx, decideNeed(cold, coldCtx))).toBeCloseTo(
      socialTemplate(0).priority * NEED_PRESSURE_S,
      6,
    ); // 80

    memberOf(c, MARA)!.lastAddressedTick = 0; // somebody just asked ME something
    const hot = addressRowsFor(c, MARA, 0)[0]!;
    const hotCtx = addressNeedCtx(hot);
    expect(worthOf(hot, hotCtx, decideNeed(hot, hotCtx))).toBeCloseTo(
      (socialTemplate(0).priority + ADDRESS_ASKED_BONUS) * NEED_PRESSURE_S,
      6,
    ); // 120
  });

  it("BEATS the idle wants: play, the wash, the laundry scrub, a ritual seat", () => {
    const cold = 80;
    expect(driveWorth(funTemplate(rate("fun")), "fun")).toBeLessThan(cold); // 40
    expect(driveWorth(hygieneTemplate(rate("hygiene")), "hygiene")).toBeLessThan(cold); // 72
    expect(driveWorth(laundryTemplate(), "hunger")).toBeLessThan(cold); // 56 (the default clock)
    expect(driveWorth(ritualAttendTemplate("meal", "chair"), "hunger")).toBeLessThan(cold); // 60
  });

  it("TIES the loneliness row it takes its rung from — the same want, honestly", () => {
    expect(driveWorth(socialTemplate(rate("social")), "social")).toBe(80);
  });

  it("🚨 NEVER OUTBIDS A FIRING SURVIVAL WANT — a creature does not stop starving to be polite", () => {
    const hot = (socialTemplate(0).priority + ADDRESS_ASKED_BONUS) * NEED_PRESSURE_S; // 120
    expect(driveWorth(dressTemplate(rate("dirt")), "dirt")).toBeGreaterThan(hot); // 128
    expect(driveWorth(energyTemplate(rate("energy")), "energy")).toBeGreaterThan(hot); // 160
    expect(driveWorth(thirstTemplate(rate("thirst")), "thirst")).toBeGreaterThan(hot); // 192
    expect(driveWorth(hungerTemplate("food", rate("hunger")), "hunger")).toBeGreaterThan(hot); // 200
  });
});

// ---------------------------------------------------------------------------
// THE ARGMAX — the one decision, in `decideNeeds`
// ---------------------------------------------------------------------------

/** A play-area ctx for the fun row (`use` → `restAt` at the thing set out). */
const funCtx = (meter: number, d: number): NeedCtx => ({
  meter,
  carried: 0,
  containers: {},
  sources: [],
  stations: [{ id: "toy_1", place: { kind: "named", id: "toy_1" }, kind: "toy", waiting: 0, d }],
  price: {
    walkMps: WALK_MPS,
    fillS: needFillS(DOLLHOUSE_SCALE, "fun"),
    unitValueS: 0,
    shortage: 0,
    handsS: { container: BOX_ACT_DWELL_S, source: 0, loose: BOX_ACT_DWELL_S, satisfy: FUN_DWELL_S },
  },
});

/** A meal-in-hand ctx for the hunger row (`consume` → `consumeAt` the table). */
const hungerCtx = (meter: number, d: number): NeedCtx => ({
  meter,
  carried: 1,
  containers: {},
  sources: [],
  stations: [{ id: "table_1", place: { kind: "named", id: "table_1" }, kind: "table", waiting: 1, d }],
  price: {
    walkMps: WALK_MPS,
    fillS: needFillS(DOLLHOUSE_SCALE, "hunger"),
    unitValueS: 0,
    shortage: 0,
    handsS: { container: BOX_ACT_DWELL_S, source: 0, loose: BOX_ACT_DWELL_S, satisfy: EAT_SHOW_S },
  },
});

/** A bed-across-the-village ctx for the energy row (`rest` → `restAt`). */
const energyCtx = (meter: number, d: number): NeedCtx => ({
  meter,
  carried: 0,
  containers: {},
  sources: [],
  stations: [{ id: "bed_1", place: { kind: "named", id: "bed_1" }, kind: "bed", waiting: 0, d }],
  price: {
    walkMps: WALK_MPS,
    fillS: needFillS(DOLLHOUSE_SCALE, "energy"),
    unitValueS: 0,
    shortage: 0,
    handsS: { container: BOX_ACT_DWELL_S, source: 0, loose: BOX_ACT_DWELL_S, satisfy: SLEEP_S },
  },
});

const rate = (k: Parameters<typeof needRate>[1]) => needRate(DOLLHOUSE_SCALE, k);

describe("the between-rows argmax — 'keep working or turn and talk', decided once", () => {
  const fun = funTemplate(rate("fun"));
  const hunger = hungerTemplate("food", rate("hunger"));
  const energy = energyTemplate(rate("energy"));

  const decide = (templates: readonly NeedTemplate[], ctxs: Record<string, NeedCtx>) =>
    decideNeeds(templates, (tpl) => (isAddressKey(tpl.key) ? addressNeedCtx(tpl) : ctxs[tpl.key]!));

  it("BEATS a chore: the toy on the floor waits, the person talking to you does not", () => {
    const c = circle();
    const templates = [fun, ...addressRowsFor(c, MARA, 0)];
    const decided = decide(templates, { fun: funCtx(1, 2) });
    expect(decided!.tpl.key).toBe(`address:${BRAM}`);
  });

  it("LOSES to a firing hunger — and the meal is a step away, so it is not the walk deciding", () => {
    const c = circle();
    const templates = [hunger, ...addressRowsFor(c, MARA, 0)];
    const decided = decide(templates, { "hunger:food": hungerCtx(1, 4) });
    expect(decided!.tpl.key).toBe("hunger:food");
  });

  it("…and wins again the moment the hunger is fed — no cooldown, no memory of having lost", () => {
    const c = circle();
    const templates = [hunger, ...addressRowsFor(c, MARA, 0)];
    const decided = decide(templates, { "hunger:food": hungerCtx(0, 4) }); // fed: the row idles
    expect(decided!.tpl.key).toBe(`address:${BRAM}`);
  });

  it("THE JUST-ASKED BONUS FLIPS A MARGINAL CASE — and decays back out of it", () => {
    // The marginal case, constructed rather than hoped for: a nap 85 m off is
    // worth 160 − (53.1 s of walking + a 12 s sleep) ≈ 95 hand-seconds. The
    // address row nets 76 cold and 116 hot, so the bonus is exactly what stands
    // between "finish the walk to bed" and "turn round and answer".
    const c = circle();
    const bed = { energy: energyCtx(1, 85) };
    const nap = rowValueS(energy, bed.energy, { kind: "restAt", station: bed.energy.stations[0]! });
    const napCost = intentCost(energy, bed.energy, { kind: "restAt", station: bed.energy.stations[0]! });
    const napNet = nap - (napCost.journeyS + napCost.handsS);
    expect(napNet).toBeGreaterThan(76);
    expect(napNet).toBeLessThan(116);

    // COLD — nobody has said anything TO this creature. The nap wins.
    expect(decide([energy, ...addressRowsFor(c, MARA, 0)], bed)!.tpl.key).toBe("energy");

    // …and then somebody asks it something.
    recordUtterance(c, { tick: 10, speakerId: BRAM, addresseeIds: [MARA], act: hi });
    expect(memberOf(c, MARA)!.lastAddressedTick).toBe(10); // ⑦'s field, finally read
    expect(decide([energy, ...addressRowsFor(c, MARA, 10)], bed)!.tpl.key).toBe(`address:${BRAM}`);

    // DECAY: a few `courtesyTicks` later the question has gone cold and the bed
    // wins again. Nothing was reset and nothing remembers — the row is simply
    // re-priced, which is the same reason it came back after the meal above.
    const late = 10 + ARBITRATION.courtesyTicks * 3;
    expect(decide([energy, ...addressRowsFor(c, MARA, late)], bed)!.tpl.key).toBe("energy");
  });

  it("the bonus is worth ONE RUNG and no more — it cannot buy a nap that is close by", () => {
    const c = circle();
    recordUtterance(c, { tick: 0, speakerId: BRAM, addresseeIds: [MARA], act: hi });
    const bed = { energy: energyCtx(1, 4) }; // the bed is right there
    expect(decide([energy, ...addressRowsFor(c, MARA, 0)], bed)!.tpl.key).toBe("energy");
  });
});

// ---------------------------------------------------------------------------
// 🚨 THE NO-PARK PIN (negative) — an outbid row re-decides at full price
// ---------------------------------------------------------------------------

describe("🚨 an outbid row must NOT park", () => {
  it("`parkNeed` refuses an address key, and takes any other row it is given", () => {
    const parks = new Set<string>();
    parkNeed(parks, MARA, "hunger:food");
    parkNeed(parks, MARA, `address:${BRAM}`);
    expect([...parks]).toEqual([`row|${MARA}|hunger:food`]);
  });

  it("losing the argmax leaves NOTHING behind: the next tick prices it in full again", () => {
    const c = circle();
    const hunger = hungerTemplate("food", rate("hunger"));
    const templates = () => [hunger, ...addressRowsFor(c, MARA, 0)];
    const decide = (ctxs: Record<string, NeedCtx>) =>
      decideNeeds(templates(), (tpl) => (isAddressKey(tpl.key) ? addressNeedCtx(tpl) : ctxs[tpl.key]!));

    const lost = decide({ "hunger:food": hungerCtx(1, 4) });
    expect(lost!.tpl.key).toBe("hunger:food");
    // The row it beat is still there, still firing, still worth exactly what it
    // was worth — no park, no cooldown, no grace. This is what sends a creature
    // back to the conversation when the work runs out.
    const row = templates().find((t) => isAddressKey(t.key))!;
    const ctx = addressNeedCtx(row);
    expect(needFires(row, ctx)).toBe(true);
    expect(rowValueS(row, ctx, decideNeed(row, ctx))).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// 🚨 AN ORDER IS NOT NEGOTIABLE — the second free consequence
// ---------------------------------------------------------------------------

describe("🚨 an order is not negotiable — a commanded body never buys the pause", () => {
  /** MIRROR of `stepNeeds`'s opening gate: a body running a spoken command, on
   *  an errand, or recruited into the party is handed to `stepPursuit` and
   *  never reaches `decideNeeds` at all. */
  const reachesTheDecideLoop = (pursuit?: { source: "command" | "need" }, tasks = 0, party = false): boolean =>
    !(party || tasks > 0 || pursuit?.source === "command");

  it("a `source: \"command\"` pursuit is handed straight to the pursuit loop", () => {
    expect(reachesTheDecideLoop({ source: "command" })).toBe(false);
    expect(reachesTheDecideLoop({ source: "need" })).toBe(true);
    expect(reachesTheDecideLoop(undefined)).toBe(true);
  });

  it("so it works, and talks to the room: only a SELF-DIRECTED body gets the choice", () => {
    const c = circle();
    // The row would exist for this creature…
    expect(addressRowsFor(c, MARA, 0)).toHaveLength(1);
    // …and the commanded body never asks for it, because the decide loop it
    // lives in is not reached. (The consolidation's north star read backwards:
    // only a self-assigned command can be un-assigned.)
    expect(reachesTheDecideLoop({ source: "command" })).toBe(false);
  });

  it("STRUCTURAL: `address` is not in the vocabulary a command is written in", () => {
    // `AddressGoal` is deliberately outside `GoalSpec` — the closed set a rule
    // action or a spoken order may compile to — so a commanded pursuit cannot
    // carry one even by accident. The compiler enforces it; this pins the fact
    // for a reader.
    const commandable: GoalSpec[] = [{ kind: "converse", target: BRAM }, { kind: "goHome" }];
    const pursued: PursuitGoal[] = [...commandable, { kind: "address", target: BRAM }];
    expect(commandable.some((g) => g.kind === "address")).toBe(false);
    expect(pursued.some((g) => g.kind === "address")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LEAVING IS A DECISION — the integral of the row losing
// ---------------------------------------------------------------------------

describe("leaving is a decision, not an eviction", () => {
  const roster = [MARA];

  it("the counter crosses the deadline AT THE SWEEP CADENCE, and marks `leaving` (never departs)", () => {
    const c = circle();
    const outbid = new Map<string, number>();
    const leaving = new Set<string>();
    const templates = addressRowsFor(c, MARA, 0);
    const hunger = hungerTemplate("food", rate("hunger"));

    // Every tick the address row loses; every 9 s the sweep looks.
    for (let t = 0; t <= 27; t++) {
      noteAddressOutcome(outbid, MARA, [hunger, ...templates], hunger, t);
      if (t > 0 && t % CHAT_INTERVAL === 0) {
        sweepOutbid(outbid, roster, leaving, t);
        // 18 s of losing is not yet 20.
        if (t < OUTBID_LEAVE_S) expect(leaving.has(MARA)).toBe(false);
      }
    }
    // The third sweep (27 s) is the first one past the 20 s deadline.
    expect(leaving.has(MARA)).toBe(true);
    // 🚨 MARKED, NOT REMOVED. The member is still on the roster — it goes
    // through the unchanged leaver branch and says goodbye on its next turn.
    expect(c.members.map((m) => m.id)).toContain(MARA);
    // …and the clock is spent, so a second sweep cannot re-mark it.
    expect(outbid.has(MARA)).toBe(false);
  });

  it("WINNING WIPES THE CLOCK — the integral is the unbroken run of losing", () => {
    const outbid = new Map<string, number>();
    const leaving = new Set<string>();
    const c = circle();
    const templates = addressRowsFor(c, MARA, 0);
    const hunger = hungerTemplate("food", rate("hunger"));

    for (let t = 0; t <= 15; t++) noteAddressOutcome(outbid, MARA, [hunger, ...templates], hunger, t);
    expect(outbid.get(MARA)).toBe(0);
    noteAddressOutcome(outbid, MARA, [hunger, ...templates], templates[0], 16); // it turned
    expect(outbid.has(MARA)).toBe(false);
    for (let t = 17; t <= 30; t++) noteAddressOutcome(outbid, MARA, [hunger, ...templates], hunger, t);
    sweepOutbid(outbid, roster, leaving, 30);
    expect(leaving.has(MARA)).toBe(false); // only 14 s of losing since it last looked up
  });

  it("NO ROW, NO CLOCK — a member with nothing to buy is never on its way out", () => {
    const outbid = new Map<string, number>();
    const leaving = new Set<string>();
    // A dyad: law ④ means there is no row, so there is nothing to lose and
    // nothing to leave over.
    const pair = createConversation("conv:4", 0);
    joinConversation(pair, MARA, 0, "b");
    joinConversation(pair, BRAM, 0, "b");
    recordUtterance(pair, { tick: 0, speakerId: BRAM, act: hi });
    const hunger = hungerTemplate("food", rate("hunger"));
    for (let t = 0; t <= 40; t++) {
      noteAddressOutcome(outbid, MARA, [hunger, ...addressRowsFor(pair, MARA, t)], hunger, t);
    }
    sweepOutbid(outbid, roster, leaving, 40);
    expect(leaving.has(MARA)).toBe(false);
  });

  it("and a member ALREADY facing whoever is talking is not losing anything either", () => {
    const outbid = new Map<string, number>();
    const leaving = new Set<string>();
    const c = circle();
    memberOf(c, MARA)!.addressing = BRAM; // the beat was bought; the row retired
    const hunger = hungerTemplate("food", rate("hunger"));
    for (let t = 0; t <= 40; t++) {
      noteAddressOutcome(outbid, MARA, [hunger, ...addressRowsFor(c, MARA, t)], hunger, t);
    }
    sweepOutbid(outbid, roster, leaving, 40);
    expect(leaving.has(MARA)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The player is a member like any other
// ---------------------------------------------------------------------------

describe("the child is somebody a creature decides to turn to", () => {
  it("a creature's address row names the PLAYER when the player is who last spoke", () => {
    const c = createConversation("conv:5", 0);
    for (const id of [MARA, BRAM, ANN]) joinConversation(c, id, 0, "b");
    recordUtterance(c, { tick: 0, speakerId: ANN, addresseeIds: [MARA], act: hi });
    const [row] = addressRowsFor(c, MARA, 0);
    expect(row!.key).toBe(`address:${ANN}`);
    // …and being asked directly buys the bonus, so a child who speaks to a
    // working creature is the case most likely to make it stop.
    expect(row!.priority).toBeCloseTo(socialTemplate(0).priority + ADDRESS_ASKED_BONUS, 6);
  });
});
