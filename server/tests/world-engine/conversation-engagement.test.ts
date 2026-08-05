// ⑫⑧ — `ConvoMember.engagement` AS HONEST STATE
// (planning-docs/games/world-engine/conversation-in-motion.md §4 ⑧).
//
// The field shipped with the roster in ⑥, was READ from the very first day
// (`attend`'s live term, so it reaches every response urge, the channel choice
// and — through `engagementToward` — the spark's directable set) and was never
// once WRITTEN: `DEFAULT_ENGAGEMENT = 1` at join, forever after. Every member of
// every circle claimed the conversation's whole attention, including the one
// hauling a crate past it.
//
// 🚨 AND THE ONE THING THIS MUST NOT BECOME IS A PENALTY. The user's direction
// for this phase, verbatim: *"I meant that it costs in a decision-making sense.
// A creature must decide if it is worth stopping its activity to focus on the
// conversation."* So every assertion below is about a number telling the truth,
// and the two that matter most are the FLOOR pins: a busy member is quieter, and
// a busy member never drops out.
//
// DB-free / GL-free — runs in `npm run test:engine`.

import { describe, it, expect } from "@jest/globals";
import {
  ARBITRATION,
  ENGAGEMENT,
  engagementOf,
  responseUrge,
} from "@shared/world-engine/interaction/dialogue/respond.js";
import { attend } from "@shared/world-engine/interaction/behavior/willingness.js";
import { makePersonality, NEUTRAL_PERSONALITY } from "@shared/world-engine/interaction/behavior/personality.js";
import { DEFAULT_RELATION } from "@shared/world-engine/interaction/behavior/relations.js";
import { engagementToward } from "@shared/world-engine/interaction/behavior/spark-attention.js";
import {
  createConversation,
  joinConversation,
  recordUtterance,
  DEFAULT_ENGAGEMENT,
  type ConversationState,
  type ConvoMember,
} from "@shared/world-engine/interaction/dialogue/conversation.js";
import { LOCAL_PLAYER_CID, isPlayerCid } from "@shared/world-engine/interaction/quest/player-identity.js";
import type { DialogueAct } from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";

/** MIRROR of quest-host's `ENGAGE_MIN` — the engagement a creature must clear
 *  before the spark will direct it at all (`authorEngagement(…) >= ENGAGE_MIN`).
 *  Copied, not imported: quest-host cannot be value-imported here. */
const ENGAGE_MIN = 0.4;

const ANN = LOCAL_PLAYER_CID;
const MARA = "resident_0_0";
const BRAM = "resident_0_2";

const dials = (patience: number, assertiveness: number) => makePersonality({ patience, assertiveness });

// ---------------------------------------------------------------------------
// The shape of the function
// ---------------------------------------------------------------------------

describe("engagementOf — a free body is wholly here", () => {
  it("a body with nothing else claiming its heading reads exactly 1", () => {
    for (const p of [dials(0, 1), NEUTRAL_PERSONALITY, dials(1, 0)]) {
      expect(engagementOf({ busy: false, personality: p, tick: 0 })).toBe(1);
      // …and being addressed cannot raise what is already the ceiling.
      expect(engagementOf({ busy: false, personality: p, tick: 0, lastAddressedTick: 0 })).toBe(1);
    }
    // Which is also the value a JOIN writes, so the writer agrees with the
    // default it replaces for the ordinary standing member.
    expect(DEFAULT_ENGAGEMENT).toBe(1);
  });

  it("a busy body falls, and it is the ONLY thing that makes it fall", () => {
    const free = engagementOf({ busy: false, personality: NEUTRAL_PERSONALITY, tick: 0 });
    const busy = engagementOf({ busy: true, personality: NEUTRAL_PERSONALITY, tick: 0 });
    expect(busy).toBeLessThan(free);
    expect(busy).toBe(ENGAGEMENT.busyFloor); // neutral dials ⇒ the floor itself
  });
});

// ---------------------------------------------------------------------------
// Monotone in each input — the property that makes it a MODEL and not a table
// ---------------------------------------------------------------------------

describe("engagementOf is monotone in every input it has", () => {
  it("PATIENCE raises it: the temperament that lets a pause sit stays in the room", () => {
    let prev = -1;
    for (const patience of [0, 0.25, 0.5, 0.75, 1]) {
      const e = engagementOf({ busy: true, personality: dials(patience, 0.5), tick: 0 });
      expect(e).toBeGreaterThanOrEqual(prev);
      prev = e;
    }
    // …and it genuinely moves, rather than being monotone by being constant.
    expect(engagementOf({ busy: true, personality: dials(1, 0), tick: 0 })).toBeGreaterThan(
      engagementOf({ busy: true, personality: dials(0, 1), tick: 0 }),
    );
  });

  it("ASSERTIVENESS lowers it: the temperament that would rather get on with the job", () => {
    let prev = Infinity;
    for (const assertiveness of [0, 0.25, 0.5, 0.75, 1]) {
      const e = engagementOf({ busy: true, personality: dials(0.5, assertiveness), tick: 0 });
      expect(e).toBeLessThanOrEqual(prev);
      prev = e;
    }
  });

  it("RECENCY of being addressed raises it, and decays back out", () => {
    const p = NEUTRAL_PERSONALITY;
    const at = (since: number) => engagementOf({ busy: true, personality: p, tick: since, lastAddressedTick: 0 });
    let prev = Infinity;
    for (const since of [0, 1, 2, 4, 8, 16, 64]) {
      const e = at(since);
      expect(e).toBeLessThanOrEqual(prev);
      prev = e;
    }
    // Just asked ⇒ fully back in the conversation; long ago ⇒ the floor again.
    expect(at(0)).toBeCloseTo(1, 10);
    expect(at(1000)).toBeCloseTo(ENGAGEMENT.busyFloor, 10);
    // 🚨 THE SAME CURVE COURTESY USES — one clock read from both ends ("I just
    // spoke" / "somebody just spoke to me"), so a half-life here is a half-life
    // there. Pinned by construction rather than by a second constant.
    const oneConstant = at(ARBITRATION.courtesyTicks);
    const lift = (v: number) => (v - ENGAGEMENT.busyFloor) / (1 - ENGAGEMENT.busyFloor);
    expect(lift(oneConstant)).toBeCloseTo(Math.exp(-1), 10);
  });

  it("NEVER ADDRESSED is not a debt — it is simply no lift, exactly as in `courtesy`", () => {
    const p = dials(0.7, 0.2);
    expect(engagementOf({ busy: true, personality: p, tick: 500 })).toBe(
      engagementOf({ busy: true, personality: p, tick: 500, lastAddressedTick: -1e9 }),
    );
  });

  it("is TOTAL — a future `lastAddressedTick` reads as 'just now', never as a blow-up", () => {
    const e = engagementOf({ busy: true, personality: NEUTRAL_PERSONALITY, tick: 0, lastAddressedTick: 40 });
    expect(e).toBeCloseTo(1, 10);
    expect(Number.isFinite(e)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 🚨 THE FLOOR — the assertion this file exists for
// ---------------------------------------------------------------------------

describe("🚨 the floor: a working member is still IN the conversation", () => {
  it("never returns 0, at any dials, at any distance from being addressed", () => {
    for (const patience of [0, 0.5, 1]) {
      for (const assertiveness of [0, 0.5, 1]) {
        for (const since of [0, 5, 50, 5000]) {
          const e = engagementOf({
            busy: true,
            personality: dials(patience, assertiveness),
            tick: since,
            lastAddressedTick: 0,
          });
          expect(e).toBeGreaterThan(0);
          expect(e).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("🚨 NEVER SINKS BELOW `ENGAGE_MIN` — or a working member silently leaves the spark's directable set", () => {
    // The bug this pins: `engagementToward` answers off THIS FIELD for two
    // creatures in one roster, and the host gates every directed gesture on
    // `>= ENGAGE_MIN`. A floor under 0.4 would leave the member on the roster,
    // on the board and on screen — and make the child's pointing do nothing.
    const worst = Math.min(
      ENGAGEMENT.floorMin,
      ENGAGEMENT.busyFloor - ENGAGEMENT.temperSpan, // the most assertive, least patient body
    );
    expect(worst).toBeGreaterThanOrEqual(ENGAGE_MIN);

    // …and the same thing said through the real functions, end to end.
    const c = createConversation("conv:1", 0);
    joinConversation(c, ANN, 0, "b");
    const mara = joinConversation(c, MARA, 0, "b");
    joinConversation(c, BRAM, 0, "b");
    mara.engagement = engagementOf({ busy: true, personality: dials(0, 1), tick: 9999, lastAddressedTick: 0 });
    expect(engagementToward(c.members, new Map(), ANN, MARA)).toBeGreaterThanOrEqual(ENGAGE_MIN);
  });
});

// ---------------------------------------------------------------------------
// What it composes into — `attend`, and then the urge
// ---------------------------------------------------------------------------

describe("the composed effect: a lean, not a wall", () => {
  const neutralAttend = (engagement: number) => attend(NEUTRAL_PERSONALITY, DEFAULT_RELATION, engagement);

  it("costs a neutral busy member ~13% of its willingness to answer — MEASURED, not asserted", () => {
    const whole = neutralAttend(1);
    const working = neutralAttend(engagementOf({ busy: true, personality: NEUTRAL_PERSONALITY, tick: 0 }));
    expect(whole).toBeCloseTo(0.6, 10); // the ADDRESS_CHANNEL doc's own reference point
    const drop = 1 - working / whole;
    expect(drop).toBeGreaterThan(0.1);
    expect(drop).toBeLessThan(0.16);
  });

  it("…and at most ~18%, for the most assertive body there is", () => {
    const whole = neutralAttend(1);
    const stubborn = neutralAttend(engagementOf({ busy: true, personality: dials(0, 1), tick: 0 }));
    const drop = 1 - stubborn / whole;
    expect(drop).toBeLessThan(0.2); // never a wall — the whole point of the floor
    expect(drop).toBeGreaterThan(0.15);
  });

  it("the urge to answer falls by the same proportion, and never to silence", () => {
    const c = createConversation("conv:2", 0);
    joinConversation(c, MARA, 0, "b");
    joinConversation(c, BRAM, 0, "b");
    joinConversation(c, ANN, 0, "b");
    const act: DialogueAct = { kind: "how-are-you", glyph: "hi" };
    const utterance = recordUtterance(c, { tick: 10, speakerId: ANN, addresseeIds: [MARA], act });

    const urgeAt = (engagement: number) => {
      const member: ConvoMember = { id: MARA, joinedTick: 0, level: "b", engagement };
      return responseUrge({
        member,
        utterance,
        tick: 10,
        personality: NEUTRAL_PERSONALITY,
        relation: DEFAULT_RELATION,
        relevance: 0.5,
      });
    };
    const whole = urgeAt(1);
    const working = urgeAt(engagementOf({ busy: true, personality: NEUTRAL_PERSONALITY, tick: 10 }));
    expect(working).toBeLessThan(whole);
    expect(working).toBeGreaterThan(0.5 * whole); // A LEAN. Never a mute button.
  });

  it("being asked something buys the whole lean back, on the spot", () => {
    // The mechanism `lastAddressedTick` was written for in ⑦ and, until now,
    // never read by anything: a busy creature spoken to DIRECTLY answers as
    // readily as an idle one, and then drifts back to its work.
    const p = NEUTRAL_PERSONALITY;
    const cold = engagementOf({ busy: true, personality: p, tick: 100 });
    const asked = engagementOf({ busy: true, personality: p, tick: 100, lastAddressedTick: 100 });
    expect(attend(p, DEFAULT_RELATION, asked)).toBeCloseTo(attend(p, DEFAULT_RELATION, 1), 10);
    expect(attend(p, DEFAULT_RELATION, asked)).toBeGreaterThan(attend(p, DEFAULT_RELATION, cold));
  });
});

// ---------------------------------------------------------------------------
// THE ONE WRITER — mirrored from `stepEngagement` (quest-host)
// ---------------------------------------------------------------------------

/** MIRROR of `stepEngagement(session, c)` — the per-frame per-circle roster walk
 *  that is now the ONLY place `ConvoMember.engagement` is assigned. */
function stepEngagement(
  c: ConversationState,
  tick: number,
  busyOf: (cid: string) => boolean,
  moodOf: (cid: string) => ReturnType<typeof makePersonality>,
): void {
  for (const m of c.members) {
    if (isPlayerCid(m.id)) continue;
    m.engagement = engagementOf({
      busy: busyOf(m.id),
      personality: moodOf(m.id),
      tick,
      ...(m.lastAddressedTick !== undefined ? { lastAddressedTick: m.lastAddressedTick } : {}),
    });
  }
}

describe("the one writer — what a frame of the circle leaves on the roster", () => {
  const mood = () => NEUTRAL_PERSONALITY;
  const circle = () => {
    const c = createConversation("conv:3", 0);
    joinConversation(c, ANN, 0, "b");
    joinConversation(c, MARA, 0, "b");
    joinConversation(c, BRAM, 0, "b");
    return c;
  };

  it("writes every creature member and leaves the PLAYER alone", () => {
    const c = circle();
    stepEngagement(c, 0, () => true, mood);
    const by = Object.fromEntries(c.members.map((m) => [m.id, m.engagement]));
    expect(by[MARA]).toBe(ENGAGEMENT.busyFloor);
    expect(by[BRAM]).toBe(ENGAGEMENT.busyFloor);
    // 🚨 A child's engagement is not something the sim grades (⑩, and §6's
    // exemption from the heading rung for the same reason).
    expect(by[ANN]).toBe(DEFAULT_ENGAGEMENT);
  });

  it("is IDEMPOTENT — the same frame twice leaves the same number (it is state, not an integrator)", () => {
    const c = circle();
    stepEngagement(c, 7, (cid) => cid === MARA, mood);
    const once = c.members.map((m) => m.engagement);
    stepEngagement(c, 7, (cid) => cid === MARA, mood);
    expect(c.members.map((m) => m.engagement)).toEqual(once);
  });

  it("RECOVERS: a member that puts its load down is wholly back in the conversation", () => {
    const c = circle();
    let busy = true;
    stepEngagement(c, 0, () => busy, mood);
    expect(c.members.find((m) => m.id === MARA)!.engagement).toBeLessThan(1);
    busy = false;
    stepEngagement(c, 1, () => busy, mood);
    expect(c.members.find((m) => m.id === MARA)!.engagement).toBe(1);
  });

  it("reads `lastAddressedTick` off the roster, which `recordUtterance` is the one writer of", () => {
    const c = circle();
    recordUtterance(c, {
      tick: 20,
      speakerId: BRAM,
      addresseeIds: [MARA],
      act: { kind: "how-are-you", glyph: "hi" },
    });
    expect(c.members.find((m) => m.id === MARA)!.lastAddressedTick).toBe(20);
    stepEngagement(c, 20, () => true, mood);
    const [mara, bram] = [MARA, BRAM].map((id) => c.members.find((m) => m.id === id)!);
    // Both are equally busy; only one of them was just spoken to.
    expect(mara.engagement).toBeGreaterThan(bram.engagement);
    expect(mara.engagement).toBeCloseTo(1, 10);
    // …and a few decay constants later the lift has gone and the member is
    // back at the working floor — the conversation still has it, and no more
    // than it has anybody else who is busy.
    stepEngagement(c, 20 + ARBITRATION.courtesyTicks * 6, () => true, mood);
    expect(c.members.find((m) => m.id === MARA)!.engagement).toBeCloseTo(ENGAGEMENT.busyFloor, 2);
  });
});
