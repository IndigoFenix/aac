/**
 * CONVERSATION IN MOTION ⑫④ — WHICH CHANNEL, AND WHAT IT COSTS.
 *
 * `chooseAddressChannel` (respond.ts) is the whole of law ② as one pure
 * function: with three or more people in a room, how does a speaker say WHOM it
 * is talking to?
 *
 *   | Channel | Price          | Available when                              |
 *   |---------|----------------|---------------------------------------------|
 *   | dyad    | free           | exactly one other member (law ④)            |
 *   | look    | a beat         | the body can afford to stop                 |
 *   | name    | a glyph slot   | always: hands full, facing away, walking    |
 *   | floor   | —              | no channel spent; the room may not answer   |
 *
 * The one interesting rung is the BUSY one, and it is the user's decision in a
 * single seeded draw: *"a creature must decide if it is worth stopping its
 * activity to focus on the conversation."* It draws through the same `attend`
 * gate arbitration is weighted by, read through the same soft edge
 * (`gateProbability`) the rest of the willingness family uses — so an EXPRESSIVE
 * creature interrupts itself to turn, a STOLID one names them and keeps working.
 * No new machinery, and nothing here punishes either of them: they are two
 * channels, not a success and a failure.
 *
 * THE BYTE-IDENTITY BAR (chapter §5): every default path must draw NO rng at
 * all, so the seeded suites elsewhere stay green unedited. Pinned below with a
 * counting stream.
 *
 * Pure — no world, no host, no clock. DB-free / GL-free: `npm run test:engine`.
 */
import { describe, it, expect } from "@jest/globals";
import { mulberry32, hashSeed } from "@shared/prng.js";
import {
  ADDRESS_CHANNEL,
  chooseAddressChannel,
  type AddressChannel,
  type AddressChannelInput,
} from "@shared/world-engine/interaction/dialogue/respond.js";
import { attend, gateProbability, gateTemperature } from "@shared/world-engine/interaction/behavior/willingness.js";
import {
  ADDRESSEE_REQUIRED_ACTS,
  type DialogueAct,
} from "@shared/world-engine/interaction/index.js";
import { NEUTRAL_PERSONALITY, makePersonality } from "@shared/world-engine/interaction/behavior/personality.js";
import { DEFAULT_RELATION, makeRelation } from "@shared/world-engine/interaction/behavior/relations.js";

const ADA = "resident_0_0";
const BEN = "resident_0_1";

/** A stream that always answers the same number — the way to ask "what would a
 *  creature do at THIS point on the curve?" without a distribution. */
const fixed = (v: number) => () => v;

/** A stream that counts how many times it was drawn from. The byte-identity bar
 *  is a claim about this counter, not about an outcome. */
function counting(v = 0.5) {
  let draws = 0;
  return {
    rng: () => {
      draws++;
      return v;
    },
    get draws() {
      return draws;
    },
  };
}

/** THE BUSY THREE-PERSON CASE — the only shape where anything is decided. Every
 *  other field is the neutral, fully-engaged creature the bar is calibrated
 *  against (see `ADDRESS_CHANNEL.interruptBar`). */
function busyCase(over: Partial<AddressChannelInput> = {}): AddressChannelInput {
  return {
    others: 2,
    intended: BEN,
    busy: true,
    requiresAddressee: false,
    personality: NEUTRAL_PERSONALITY,
    relation: DEFAULT_RELATION,
    engagement: 1,
    rng: fixed(0.5),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// ① THE DYAD EXEMPTION — law ④, and it is asked first
// ---------------------------------------------------------------------------

describe("① a dyad NEVER pays — law ④, and nothing below it can override it", () => {
  it("one other person answers `dyad` however busy, hostile or urgent it is", () => {
    for (const busy of [true, false]) {
      for (const requiresAddressee of [true, false]) {
        expect(
          chooseAddressChannel(
            busyCase({
              others: 1,
              busy,
              requiresAddressee,
              personality: makePersonality({ expressiveness: 0, stability: 1 }),
              relation: makeRelation({ affinity: -1 }),
              engagement: 0,
            }),
          ),
        ).toBe("dyad");
      }
    }
  });

  it("…and it draws NOTHING: a free channel touches no stream", () => {
    const c = counting();
    chooseAddressChannel(busyCase({ others: 1, rng: c.rng }));
    expect(c.draws).toBe(0);
  });

  it("a roster with NOBODY else in it is exempt too — there is even less to say", () => {
    // `<= 1`, not `=== 1`. A speaker alone must not fall through to a branch
    // that would charge a beat for turning to a person who is not there.
    expect(chooseAddressChannel(busyCase({ others: 0 }))).toBe("dyad");
    expect(chooseAddressChannel(busyCase({ others: 0, intended: undefined }))).toBe("dyad");
  });

  it("THREE is not a dyad — this is where the chapter starts", () => {
    expect(chooseAddressChannel(busyCase({ others: 2, busy: false }))).toBe("look");
  });
});

// ---------------------------------------------------------------------------
// ② NOBODY IN MIND — the floor is what you get, never what you buy
// ---------------------------------------------------------------------------

describe("② a line aimed at nobody goes to the floor, and buys nothing", () => {
  it("no `intended` ⇒ `floor`, busy or not, needed or not", () => {
    for (const busy of [true, false]) {
      for (const requiresAddressee of [true, false]) {
        expect(
          chooseAddressChannel(busyCase({ intended: undefined, busy, requiresAddressee })),
        ).toBe("floor");
      }
    }
  });

  it("…without a draw, and WITHOUT reading two absences as a match", () => {
    // The trap this rung closes: `already === intended` is true when both are
    // undefined, which would answer `look` — a paid channel nobody bought, for
    // a person nobody named.
    const c = counting();
    expect(
      chooseAddressChannel(busyCase({ intended: undefined, already: undefined, rng: c.rng })),
    ).toBe("floor");
    expect(c.draws).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ③ PAID ALREADY — what "durable" actually buys
// ---------------------------------------------------------------------------

describe("③ already addressing them ⇒ `look`, free", () => {
  it("a standing address is not re-bought, however busy the body is", () => {
    // The bug this rung prevents: a creature charged a beat every turn would
    // spin in place for as long as it kept talking to the same person.
    expect(
      chooseAddressChannel(busyCase({ already: BEN, intended: BEN, busy: true })),
    ).toBe("look");
  });

  it("…and draws nothing — a bought channel is not re-decided", () => {
    const c = counting();
    chooseAddressChannel(busyCase({ already: BEN, intended: BEN, rng: c.rng }));
    expect(c.draws).toBe(0);
  });

  it("an address at SOMEBODY ELSE is not this channel — looking away costs again", () => {
    const c = counting(0.99); // a draw this high fails at neutral
    expect(
      chooseAddressChannel(busyCase({ already: ADA, intended: BEN, rng: c.rng, requiresAddressee: true })),
    ).toBe("name");
    expect(c.draws).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ④ A FREE BODY TURNS
// ---------------------------------------------------------------------------

describe("④ a body that can afford to stop, stops", () => {
  it("`!busy` ⇒ `look`, whatever the temperament", () => {
    for (const expressiveness of [0, 0.5, 1]) {
      expect(
        chooseAddressChannel(
          busyCase({ busy: false, personality: makePersonality({ expressiveness }) }),
        ),
      ).toBe("look");
    }
  });

  it("…and draws nothing: there is no decision when there is no cost", () => {
    const c = counting();
    chooseAddressChannel(busyCase({ busy: false, rng: c.rng }));
    expect(c.draws).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ⑤ THE DRAW — the one decision, and the only place an rng is touched
// ---------------------------------------------------------------------------

describe("⑤ the busy body decides — ONE seeded draw", () => {
  it("exactly one draw, and only here", () => {
    const c = counting();
    chooseAddressChannel(busyCase({ rng: c.rng }));
    expect(c.draws).toBe(1);
  });

  it("a draw under the curve interrupts the work; one over it does not", () => {
    // At neutral, `attend` sits exactly on the bar, so the curve is a coin flip
    // — which is what "just barely willing" always meant.
    expect(chooseAddressChannel(busyCase({ rng: fixed(0.4) }))).toBe("look");
    expect(chooseAddressChannel(busyCase({ rng: fixed(0.6), requiresAddressee: true }))).toBe("name");
  });

  it("🚨 THE BAR IS `attend` AT NEUTRAL — a fully engaged neutral creature is a coin flip", () => {
    expect(attend(NEUTRAL_PERSONALITY, DEFAULT_RELATION, 1)).toBeCloseTo(ADDRESS_CHANNEL.interruptBar, 10);
    expect(
      gateProbability(ADDRESS_CHANNEL.interruptBar, ADDRESS_CHANNEL.interruptBar, gateTemperature(NEUTRAL_PERSONALITY)),
    ).toBeCloseTo(0.5, 10);
  });

  it("an EXPRESSIVE creature interrupts itself; a STOLID one keeps working", () => {
    // The behaviour the chapter names, on the SAME draw — the difference is the
    // creature, not the luck.
    const talkative = makePersonality({ expressiveness: 1 });
    const stolid = makePersonality({ expressiveness: 0 });
    const coin = fixed(0.5);
    expect(chooseAddressChannel(busyCase({ personality: talkative, rng: coin }))).toBe("look");
    expect(
      chooseAddressChannel(busyCase({ personality: stolid, rng: coin, requiresAddressee: true })),
    ).toBe("name");
  });

  it("a STABLE creature is near-deterministic; a VOLATILE one has a real maybe", () => {
    // `gateTemperature` reads `stability`, exactly as the give/join gates do —
    // no new dial. Well clear of the bar, the even creature is a certainty and
    // the volatile one is still a gamble.
    const even = makePersonality({ expressiveness: 0.9, stability: 1 });
    const volatile = makePersonality({ expressiveness: 0.9, stability: 0 });
    // 0.98 is a draw only a wide edge can fail.
    expect(chooseAddressChannel(busyCase({ personality: even, rng: fixed(0.98) }))).toBe("look");
    expect(
      chooseAddressChannel(busyCase({ personality: volatile, rng: fixed(0.98), requiresAddressee: true })),
    ).toBe("name");
  });
});

// ---------------------------------------------------------------------------
// ⑥ WHAT A CREATURE THAT KEPT WORKING DOES INSTEAD
// ---------------------------------------------------------------------------

describe("⑥ the name is the channel that survives a busy body", () => {
  it("an act that NEEDS a named person gets one: `name`", () => {
    expect(
      chooseAddressChannel(busyCase({ rng: fixed(0.99), requiresAddressee: true })),
    ).toBe("name");
  });

  it("an act that does not, goes to the FLOOR — a consequence, never a fine (law ③)", () => {
    expect(
      chooseAddressChannel(busyCase({ rng: fixed(0.99), requiresAddressee: false })),
    ).toBe("floor");
  });

  it("every branch of the table is reachable, and nothing else is", () => {
    const seen = new Set<AddressChannel>([
      chooseAddressChannel(busyCase({ others: 1 })),
      chooseAddressChannel(busyCase({ intended: undefined })),
      chooseAddressChannel(busyCase({ already: BEN })),
      chooseAddressChannel(busyCase({ busy: false })),
      chooseAddressChannel(busyCase({ rng: fixed(0) })),
      chooseAddressChannel(busyCase({ rng: fixed(0.99), requiresAddressee: true })),
      chooseAddressChannel(busyCase({ rng: fixed(0.99) })),
    ]);
    expect([...seen].sort()).toEqual(["dyad", "floor", "look", "name"]);
  });
});

// ---------------------------------------------------------------------------
// DETERMINISM — a replay is a replay, and two devices agree
// ---------------------------------------------------------------------------

describe("the same seed reaches the same channel", () => {
  it("two runs of the same stream answer identically, every time", () => {
    const run = () => {
      const rng = mulberry32(hashSeed("world-7", "convo", "conv:3", 12));
      return Array.from({ length: 24 }, () => chooseAddressChannel(busyCase({ rng, requiresAddressee: true })));
    };
    const a = run();
    expect(run()).toEqual(a);
    // …and it is a genuine mix, not a constant dressed up as a draw.
    expect(new Set(a).size).toBe(2);
  });

  it("a DIFFERENT seed is a different transcript — the draw is real", () => {
    const roll = (seed: string) => {
      const rng = mulberry32(hashSeed(seed, "convo", "conv:3", 12));
      return Array.from({ length: 24 }, () => chooseAddressChannel(busyCase({ rng, requiresAddressee: true })));
    };
    expect(roll("world-7")).not.toEqual(roll("world-8"));
  });
});

// ---------------------------------------------------------------------------
// MONOTONE IN `attend`'s INPUTS — nothing this chapter tunes inverts a decision
// ---------------------------------------------------------------------------

describe("monotone in every input `attend` reads", () => {
  /** With the draw PINNED, a rising `attend` score may only move a creature
   *  toward looking — never back. `gateProbability` is strictly increasing, so
   *  the only ordering that can appear is name…name…look…look. */
  const sweep = (make: (t: number) => Partial<AddressChannelInput>) => {
    const steps = Array.from({ length: 21 }, (_, i) => i / 20);
    return steps.map((t) =>
      chooseAddressChannel(busyCase({ ...make(t), rng: fixed(0.5), requiresAddressee: true })),
    );
  };

  const nonDecreasing = (channels: AddressChannel[]) => {
    let flipped = false;
    for (const ch of channels) {
      if (ch === "look") flipped = true;
      else if (flipped) return false; // went back to `name` after looking
    }
    return true;
  };

  it("EXPRESSIVENESS — the dial for being the sort that speaks", () => {
    const out = sweep((t) => ({ personality: makePersonality({ expressiveness: t, stability: 1 }) }));
    expect(nonDecreasing(out)).toBe(true);
    expect(out[0]).toBe("name");
    expect(out[out.length - 1]).toBe("look");
  });

  it("AFFINITY — whether it cares who is asking", () => {
    const out = sweep((t) => ({
      relation: makeRelation({ affinity: t * 2 - 1 }),
      personality: makePersonality({ expressiveness: 0.65, stability: 1 }),
    }));
    expect(nonDecreasing(out)).toBe(true);
    expect(out[0]).toBe("name");
    expect(out[out.length - 1]).toBe("look");
  });

  it("ENGAGEMENT — the one LIVE term: how much of it this conversation holds", () => {
    const out = sweep((t) => ({
      engagement: t,
      personality: makePersonality({ expressiveness: 0.75, stability: 1 }),
    }));
    expect(nonDecreasing(out)).toBe(true);
    expect(out[0]).toBe("name");
    expect(out[out.length - 1]).toBe("look");
  });

  it("…and the ordering is `attend`'s own, so no tuning already done is undone", () => {
    // Read straight off the gate: any two inputs whose `attend` scores order one
    // way order the same way here, at a pinned draw.
    const low = makePersonality({ expressiveness: 0.2, stability: 1 });
    const high = makePersonality({ expressiveness: 0.8, stability: 1 });
    expect(attend(low, DEFAULT_RELATION, 1)).toBeLessThan(attend(high, DEFAULT_RELATION, 1));
    expect(chooseAddressChannel(busyCase({ personality: low, rng: fixed(0.5), requiresAddressee: true })))
      .toBe("name");
    expect(chooseAddressChannel(busyCase({ personality: high, rng: fixed(0.5) })))
      .toBe("look");
  });
});

// ---------------------------------------------------------------------------
// HOST MIRROR — what each channel actually DOES to a circle's turn
// ---------------------------------------------------------------------------
//
// `quest-host.ts` cannot be value-imported here (its import chain reaches JSX,
// which this jest project does not compile), so `planAddress` is pinned by
// re-stating the host's OWN expression around the REAL `chooseAddressChannel`.
// Same discipline as `conversation-addressee.test.ts`.

describe("planAddress (host mirror) — the beat, the name and the floor", () => {
  type Move = { act: DialogueAct; addresseeId?: string };
  type Plan = { speakNow: false } | { speakNow: true; move: Move };

  /** The host's state this decision touches, and nothing else. */
  class TurnMirror {
    /** MIRROR of `ConvoMember.addressing` for the one speaker under test. */
    addressing?: string;
    /** MIRROR of `sess.actionHold` ∪ `headingHeldByLegs` on that body. */
    busy = false;
    /** Can the beat actually be taken? False stands in for BOTH refusals the
     *  host has that are not "paid already": hands mid-action
     *  (`session.actionHold` — `beginAction` would clobber a half-done hold and
     *  silently drop what the creature was picking up) and no body to turn. */
    canTurn = true;
    /** Every `beginAddress` that charged, in order. */
    readonly beats: string[] = [];
    /** Every `setMemberAddress` write, in order. */
    readonly written: string[] = [];

    /** MIRROR of `beginAddress(session, cid, targetCid)`. */
    beginAddress(target: string): boolean {
      if (!this.canTurn) return false;
      if (this.addressing === target) return false; // paid already
      this.beats.push(target);
      this.addressing = target; // the effect lands at `effectAt: 0`
      return true;
    }

    /** ★ MIRROR of `planAddress(session, c, cid, move, rng)`. ★ */
    plan(move: Move, others: number, rng: () => number): Plan {
      const target = move.addresseeId;
      const channel = chooseAddressChannel({
        others,
        ...(target ? { intended: target } : {}),
        ...(this.addressing ? { already: this.addressing } : {}),
        busy: this.busy,
        requiresAddressee: ADDRESSEE_REQUIRED_ACTS.has(move.act.kind),
        personality: NEUTRAL_PERSONALITY,
        relation: DEFAULT_RELATION,
        engagement: 1,
        rng,
      });
      if (!target || channel === "dyad") return { speakNow: true, move };
      const keepWorking = (): Plan => {
        if (!ADDRESSEE_REQUIRED_ACTS.has(move.act.kind)) return { speakNow: true, move: { act: move.act } };
        if (this.addressing !== target) this.written.push(target);
        this.addressing = target;
        return { speakNow: true, move };
      };
      if (channel === "floor" || channel === "name") return keepWorking();
      if (this.beginAddress(target)) return { speakNow: false };
      // Bought already ⇒ speak, free. Could not be taken ⇒ the look was never
      // paid, so fall back rather than address for free.
      return this.addressing === target ? { speakNow: true, move } : keepWorking();
    }
  }

  const ask: DialogueAct = { kind: "request", glyph: "cookie", itemId: "cookie_1" };
  const chat: DialogueAct = { kind: "how-are-you", glyph: "how" };

  it("★ STOP, TURN, THEN SPEAK — the beat IS the turn, and the line lands on the next one", () => {
    const h = new TurnMirror();
    h.busy = true;
    // Turn 1: the body is busy and willing, so it buys the look and says nothing.
    expect(h.plan({ act: ask, addresseeId: BEN }, 2, fixed(0))).toEqual({ speakNow: false });
    expect(h.beats).toEqual([BEN]);
    // Turn 2: `convoRng` keys on `nextSeq`, and a beat records no utterance, so
    // the stream replays and the same mover picks the same move — but now the
    // channel is already paid for, so the line goes out and nothing is charged.
    const again = h.plan({ act: ask, addresseeId: BEN }, 2, fixed(0));
    expect(again).toEqual({ speakNow: true, move: { act: ask, addresseeId: BEN } });
    expect(h.beats).toEqual([BEN]); // 🚨 charged ONCE, not once per turn
  });

  it("a FREE body turns and speaks — the beat is still taken, the turn is still spent", () => {
    const h = new TurnMirror();
    expect(h.plan({ act: chat, addresseeId: BEN }, 2, fixed(0.99))).toEqual({ speakNow: false });
    expect(h.beats).toEqual([BEN]);
  });

  it("a DYAD speaks straight through, and records nothing (law ④)", () => {
    const h = new TurnMirror();
    h.busy = true;
    expect(h.plan({ act: ask, addresseeId: BEN }, 1, fixed(0.99)))
      .toEqual({ speakNow: true, move: { act: ask, addresseeId: BEN } });
    expect(h.beats).toEqual([]);
    expect(h.addressing).toBeUndefined();
  });

  it("`name` records the address and keeps working — no beat", () => {
    // 🚧 The NAME ITSELF is ⑫⑦ and is gated on the lang rulesets, so this is an
    // address without its vocative today: the record and the arbitration agree
    // about who is being spoken to, and nothing is said out loud about it.
    const h = new TurnMirror();
    h.busy = true;
    expect(h.plan({ act: ask, addresseeId: BEN }, 2, fixed(0.99)))
      .toEqual({ speakNow: true, move: { act: ask, addresseeId: BEN } });
    expect(h.beats).toEqual([]);
    expect(h.written).toEqual([BEN]);
  });

  it("🚨 `floor` RE-AIMS THE LINE AT THE ROOM — the consequence, never a fine (law ③)", () => {
    // The creature would not stop working and the act does not need a named
    // person, so the line goes to the floor and may go unanswered. The ACT is
    // untouched; only who it is said TO.
    const h = new TurnMirror();
    h.busy = true;
    expect(h.plan({ act: chat, addresseeId: BEN }, 2, fixed(0.99)))
      .toEqual({ speakNow: true, move: { act: chat } });
    expect(h.beats).toEqual([]);
    expect(h.addressing).toBeUndefined();
  });

  it("a move aimed at nobody is spoken unchanged, and buys nothing", () => {
    const h = new TurnMirror();
    h.busy = true;
    expect(h.plan({ act: chat }, 2, fixed(0))).toEqual({ speakNow: true, move: { act: chat } });
    expect(h.beats).toEqual([]);
  });

  it("a beat that CANNOT be taken never stalls the circle — it FALLS BACK", () => {
    // Hands mid-action, or no body to turn. The turn must still be spoken (or
    // the same move would be re-planned forever) — but through the channel a
    // busy body actually has, not by addressing for free.
    const h = new TurnMirror();
    h.canTurn = false;
    expect(h.plan({ act: ask, addresseeId: BEN }, 2, fixed(0)))
      .toEqual({ speakNow: true, move: { act: ask, addresseeId: BEN } });
    expect(h.beats).toEqual([]);
    expect(h.written).toEqual([BEN]); // …the NAME, recorded but not spoken (⑫⑦)
  });

  it("🚨 …and an un-payable look on a FLOOR-SAFE act goes to the floor, not free", () => {
    // The bug this closes: a body that could not take the beat used to speak
    // with its addressee intact, which is addressing for free — the exact thing
    // the chapter removes.
    const h = new TurnMirror();
    h.canTurn = false;
    expect(h.plan({ act: chat, addresseeId: BEN }, 2, fixed(0)))
      .toEqual({ speakNow: true, move: { act: chat } });
    expect(h.beats).toEqual([]);
  });

  it("`request` is in ADDRESSEE_REQUIRED_ACTS and `how-are-you` is not — the two arms above", () => {
    expect(ADDRESSEE_REQUIRED_ACTS.has("request")).toBe(true);
    expect(ADDRESSEE_REQUIRED_ACTS.has("how-are-you")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PURITY
// ---------------------------------------------------------------------------

describe("it is a decision and nothing else", () => {
  it("reads its input and writes nothing back", () => {
    const input = busyCase({ personality: makePersonality({ expressiveness: 0.3 }) });
    const before = JSON.stringify({ ...input, rng: undefined });
    chooseAddressChannel(input);
    expect(JSON.stringify({ ...input, rng: undefined })).toBe(before);
  });

  it("is total — an out-of-range engagement is clamped, never a throw", () => {
    for (const engagement of [-5, 0, 1, 7, Number.NaN]) {
      expect(() => chooseAddressChannel(busyCase({ engagement }))).not.toThrow();
    }
  });
});
