// THE EXPANDABLE CREATURE READOUT (stocking-offload-and-carry.md §2) — the
// projection behind every expanded row of the world-lab debug menu, pinned.
//
// What is being defended:
//   ① OFF-SCREEN AND ABSTRACTED BODIES ARE THE POINT. Clicking a creature needs
//      a body under the pointer, which is exactly what a shopper that vanished
//      mid-trip does not have. An abstracted resident is listed, says so, and
//      reports its SCHEDULE PHASE where an embodied one reports a position.
//   ② A CROWD IS SUMMARIZED, AN INDIVIDUAL IS NAMED. `inspectRoster` enumerates
//      the family, the pets and the registered creatures; the rest of the town
//      is a COUNT.
//   ③ ASKING MOVES NOTHING. A full pass over every listed creature leaves the
//      reservation ledger's serial — and every other read structure — untouched.
//   ④ THE COLLAPSED ROW IS CHEAP. `summarizeCreature` asks NONE of the expensive
//      probes, so a hundred unopened rows never walk a why-chain.
//   ⑤ HANDS COME FROM `carriedBy`, NEVER `carryOf()` (text-mode watch.ts's rule,
//      which this readout used to break). `carryOf` is `bodyCarryView`, which
//      DELIBERATELY drops the held bag — "the shelf, not the goods" — so an
//      empty basket in the hands read "(nothing)" and a full one never named
//      the basket at all: the one object that explains a stalled errand was the
//      one object the panel could not show.
//   ⑥ 🚨 THE HOUSES ARRAY HAS GAPS. `TownHouse.index` is the LOT id, not the
//      array position (stall conversions are filtered out), so every household
//      lookup is `houses.find(h => h.index === idx)`. Positional indexing
//      reported "138.4 m from home" for a body in its own kitchen, and printed
//      a NEIGHBOUR's schedule phase beside it.
//
// Part 1 is pure over a STUBBED probe set + a hand-built town (no boot). Part 2
// runs the identical projection against the REAL shipped dollhouse, headless,
// which is the only way to prove the abstracted arm fires on real data.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  carryText,
  goingText,
  homePointOf,
  inspectCreature,
  inspectRoster,
  summarizeCreature,
  whyLines,
  type InspectProbes,
} from "@shared/world-engine/interaction/quest/creature-inspect.js";
import { createReservationLedger } from "@shared/world-engine/kernel/town/reservations.js";
import { houseDoorstep } from "@shared/world-engine/kernel/town/goods.js";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import type { ReasonLink } from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — the projection, over a stubbed probe set
// ═══════════════════════════════════════════════════════════════════════════

const CENTER = { x: 100, y: 200 };
const HOUSE = {
  index: 0,
  dx: -12,
  dy: -10,
  w: 12,
  h: 10,
  door: "south" as const,
  color: "#888888",
  floors: 1,
};
/** Doorstep of HOUSE: south door, 1.2 m out (goods.ts houseDoorstep). */
const DOORSTEP = { x: CENTER.x + HOUSE.dx + HOUSE.w / 2, y: CENTER.y + HOUSE.dy + HOUSE.h + 1.2 };
/** A point well inside the house footprint. */
const INSIDE = { x: CENTER.x + HOUSE.dx + 3, y: CENTER.y + HOUSE.dy + 3 };
/** The market's footprint, a walk away. */
const WORK = { type: "market", dx: 20, dy: 20, w: 10, h: 10, door: "north" as const, color: "#777777" };

/** The same lot shape at another LOT ID and another place on the map. */
const houseAt = (index: number, dx: number, dy: number) => ({ ...HOUSE, index, dx, dy });

interface StubOpts {
  /** The town's houses, IN PLAN ORDER — indexes need not be contiguous. */
  houses?: Array<typeof HOUSE>;
  /** Registered loose props, by object id (`session.smallProps`). */
  smallProps?: Map<string, { entityId: string; glyph: string }>;
  needStep?: QuestSession["needStep"] extends Map<string, infer V> ? Map<string, V> : never;
  pursuits?: Map<string, unknown>;
  claimedTask?: unknown;
  blocked?: Map<string, unknown>;
  meters?: Map<string, number>;
  errandClaims?: Map<string, string>;
  liveNeedBodies?: Set<string>;
  npcGoing?: Map<string, unknown>;
  creatures?: Record<string, unknown>;
  family?: unknown;
}

/** A QuestSession with EXACTLY the fields this readout reads. Cast rather than
 *  booted: the module's contract is "get, never set", so a stub is a fair
 *  stand-in and costs no world build. */
function stubSession(o: StubOpts = {}): QuestSession {
  const goods = [
    {
      good: { key: "food", slot: 0 },
      // The phase NAMES THE HOUSE it was computed for — the errand is a
      // function of the household's own lot, so a readout that resolved the
      // wrong house prints the wrong lot id here and the pin catches it.
      errand: (h: { index: number }) => ({ phase: `to_source@${h.index}` }),
    },
  ];
  const session = {
    town: {
      config: {
        seed: 7,
        family: o.family ?? {
          mode: "some",
          members: [{ name: "Mara" }, { name: "Tomas" }],
          pets: [{ name: "Bru" }],
        },
      },
      familyHouse: 0,
      plan: { houses: o.houses ?? [HOUSE], works: [WORK] },
      stage: { center: CENTER, goods },
      deltas: { get: () => undefined },
    },
    townClock: 0,
    creatures: { world: { creatures: o.creatures ?? {}, items: {} } },
    npcGoing: o.npcGoing ?? new Map(),
    needStep: o.needStep ?? new Map(),
    pursuits: o.pursuits ?? new Map(),
    taskPool: { claimedBy: () => o.claimedTask },
    actionHold: new Map(),
    blockedNeeds: o.blocked ?? new Map(),
    helpOrders: new Map(),
    errandClaims: o.errandClaims ?? new Map(),
    needClaims: createReservationLedger(),
    needMeters: o.meters ?? new Map(),
    liveNeedBodies: o.liveNeedBodies ?? new Set(),
    party: new Set(),
    escorting: new Set(),
    bondedCreatures: new Set(),
    addressedFamily: null,
    wornBags: new Map(),
    smallProps: o.smallProps ?? new Map(),
  };
  return session as unknown as QuestSession;
}

const rowOf = (rows: Array<{ label: string; value: string }>, label: string): string | undefined =>
  rows.find((r) => r.label === label)?.value;

const EMBODIED_PROBES = (at: { x: number; y: number }, extra: Partial<InspectProbes> = {}): InspectProbes => ({
  state: { avatars: { resident_0_0: { x: at.x, y: at.y, vx: 0, vy: 0 } } },
  ...extra,
});

describe("§2 ① an ABSTRACTED body is a first-class answer", () => {
  it("says ABSTRACTED, gives no position, and reports the schedule phase instead", () => {
    const s = stubSession();
    // No `state` at all — the streamer took the body away mid-trip.
    const ins = inspectCreature(s, "resident_0_0", {});
    expect(ins.embodied).toBe(false);
    expect(rowOf(ins.rows, "body")).toMatch(/ABSTRACTED/);
    expect(rowOf(ins.rows, "position")).toBeUndefined();
    // The goods clock answers with no body to ask — this is the whole point.
    expect(rowOf(ins.rows, "schedule")).toBe("food:to_source@0");
    expect(ins.summary).toContain("⏸ abstracted");
  });

  it("an EMBODIED body reports position, the place word and distance from home", () => {
    const s = stubSession();
    const ins = inspectCreature(s, "resident_0_0", EMBODIED_PROBES(INSIDE));
    expect(ins.embodied).toBe(true);
    expect(rowOf(ins.rows, "body")).toMatch(/embodied/);
    const pos = rowOf(ins.rows, "position")!;
    expect(pos).toContain(`${INSIDE.x}, ${INSIDE.y}`);
    expect(pos).toMatch(/m from home/);
    // Inside its own house footprint, the point HAS a word (a room, else "home").
    expect(pos.split(" · ")[1]).toBeTruthy();
    // …and the schedule still shows beside it: the clock the body may not be keeping.
    expect(rowOf(ins.rows, "schedule")).toBe("food:to_source@0");
  });

  it("distance from home is measured to the doorstep", () => {
    const s = stubSession();
    const ins = inspectCreature(s, "resident_0_0", EMBODIED_PROBES(DOORSTEP));
    expect(rowOf(ins.rows, "position")).toMatch(/ 0 m from home$/);
  });

  it("names the building a body is standing in when it is not its own", () => {
    const s = stubSession();
    const at = { x: CENTER.x + WORK.dx + 5, y: CENTER.y + WORK.dy + 5 };
    const ins = inspectCreature(s, "resident_0_0", EMBODIED_PROBES(at));
    expect(rowOf(ins.rows, "position")).toContain("market");
  });

  it("a DWELLED errand waypoint reads as standing still, not walking", () => {
    const s = stubSession();
    const walking = inspectCreature(s, "resident_0_0", {
      state: { avatars: { resident_0_0: { x: INSIDE.x, y: INSIDE.y, vx: 1, vy: 0 } } },
    });
    expect(rowOf(walking.rows, "motion")).toMatch(/walking/);
    const dwelling = inspectCreature(s, "resident_0_0", {
      state: { avatars: { resident_0_0: { x: INSIDE.x, y: INSIDE.y, vx: 1, vy: 0 } } },
      errandPath: () => ({ dwelling: true }),
    });
    expect(rowOf(dwelling.rows, "motion")).toMatch(/dwelling/);
  });
});

describe("§2 the detail block, field by field — all from EXISTING probes", () => {
  it("renders the why-chain as its clause list, in the order reasonChainOf walked it", () => {
    const chain: ReasonLink[] = [
      { kind: "activity", clause: { subject: "i_me", verb: "get", object: "bread" } },
      { kind: "because", clause: { subject: "house", verb: "want", object: "bread" } },
      { kind: "authority", clause: { subject: "you", verb: "ask" } },
      { kind: "end" },
    ];
    const s = stubSession();
    const ins = inspectCreature(s, "resident_0_0", { whyProbe: () => chain });
    expect(ins.why).toEqual([
      "activity: i_me get bread",
      "because: house want bread",
      "authority: you ask",
      "end",
    ]);
  });

  it("an absent chain is an empty clause list, never a fabricated one", () => {
    expect(whyLines(undefined)).toEqual([]);
    expect(whyLines([])).toEqual([]);
  });

  it("carried items come from carryOf, empty hands say so", () => {
    const s = stubSession();
    const full = inspectCreature(s, "resident_0_0", { carryOf: () => ({ bread: 2, basket: 1 }) });
    expect(rowOf(full.rows, "carrying")).toBe("bread×2, basket×1");
    const empty = inspectCreature(s, "resident_0_0", { carryOf: () => ({}) });
    expect(rowOf(empty.rows, "carrying")).toBe("(nothing)");
    expect(carryText({ bread: 0 })).toBe(""); // a zero stack is not a carry
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ⑤ THE HANDS — `carriedBy`, never `carryOf()`
// ─────────────────────────────────────────────────────────────────────────

/** A body holding `props` (object id → glyph), as the panel sees it: the
 *  avatars table plus the object table's `carriedBy` stamps. */
const HOLDING = (props: Record<string, string>, carry: Record<string, number> = {}): [QuestSession, InspectProbes] => {
  const smallProps = new Map(Object.entries(props).map(([id, glyph]) => [id, { entityId: `e_${id}`, glyph }]));
  const objects = Object.fromEntries(Object.keys(props).map((id) => [id, { carriedBy: "resident_0_0" }]));
  return [
    stubSession({ smallProps }),
    {
      state: { avatars: { resident_0_0: { x: INSIDE.x, y: INSIDE.y } }, objects },
      carryOf: () => carry,
    },
  ];
};

describe("§2 ⑤ the hands come from `carriedBy`, never from the merged view", () => {
  it("an EMPTY BASKET is the whole story of a failed errand — never “(nothing)”", () => {
    const [s, p] = HOLDING({ prop_1: "basket" });
    // The bug: `bodyCarryView` drops the bag object ("the shelf, not the
    // goods"), so a body walking home with nothing in its basket read as a
    // body carrying nothing at all.
    expect(rowOf(inspectCreature(s, "resident_0_0", p).rows, "carrying")).toBe("basket (empty)");
  });

  it("a FULL basket names the bag AND what is in it", () => {
    const [s, p] = HOLDING({ prop_1: "basket" }, { apple: 1, water: 1 });
    expect(rowOf(inspectCreature(s, "resident_0_0", p).rows, "carrying")).toBe("basket [apple×1, water×1]");
  });

  it("a PORTABLE CONTAINER wins the hands slot over anything else held", () => {
    const [s, p] = HOLDING({ prop_1: "apple", prop_2: "basket" }, { apple: 2 });
    expect(rowOf(inspectCreature(s, "resident_0_0", p).rows, "carrying")).toBe("basket [apple×2]");
  });

  it("a LOOSE thing in the hand is counted once, with the rest of the body behind it", () => {
    const [only] = HOLDING({ prop_1: "apple" }, { apple: 1 });
    const [, onlyP] = HOLDING({ prop_1: "apple" }, { apple: 1 });
    // The merged view ALREADY counts the hands instance — saying it twice
    // would read as two apples.
    expect(rowOf(inspectCreature(only, "resident_0_0", onlyP).rows, "carrying")).toBe("apple");
    const [s, p] = HOLDING({ prop_1: "apple" }, { apple: 1, bread: 2 });
    expect(rowOf(inspectCreature(s, "resident_0_0", p).rows, "carrying")).toBe("apple · bread×2");
  });

  it("a prop held by SOMEONE ELSE is not in this body's hands", () => {
    const s = stubSession({ smallProps: new Map([["prop_1", { entityId: "e", glyph: "basket" }]]) });
    const ins = inspectCreature(s, "resident_0_0", {
      state: {
        avatars: { resident_0_0: { x: INSIDE.x, y: INSIDE.y } },
        objects: { prop_1: { carriedBy: "resident_0_1" } },
      },
      carryOf: () => ({}),
    });
    expect(rowOf(ins.rows, "carrying")).toBe("(nothing)");
  });

  it("a state with no object table still reads — the merged view stands in", () => {
    const s = stubSession({ smallProps: new Map([["prop_1", { entityId: "e", glyph: "basket" }]]) });
    const ins = inspectCreature(s, "resident_0_0", {
      state: { avatars: { resident_0_0: { x: INSIDE.x, y: INSIDE.y } } },
      carryOf: () => ({ bread: 1 }),
    });
    expect(rowOf(ins.rows, "carrying")).toBe("bread×1");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ⑥ 🚨 THE HOUSES ARRAY HAS GAPS — lookups are by LOT ID
// ─────────────────────────────────────────────────────────────────────────

describe("§2 ⑥ a gapped houses array resolves the body's OWN household", () => {
  // Lots 0, 2 and 3 survive; lot 1 was converted to a stall and filtered out.
  // So `houses[2]` is LOT 3 — a hundred metres from lot 2's kitchen.
  const HOUSES = [houseAt(0, -12, -10), houseAt(2, 40, 40), houseAt(3, 140, 140)];
  const OWN = HOUSES[1]!; // lot 2, at array position 1
  const inOwnKitchen = { x: CENTER.x + OWN.dx + 3, y: CENTER.y + OWN.dy + 3 };

  it("measures “from home” to its OWN doorstep, not the array slot's", () => {
    const s = stubSession({ houses: HOUSES });
    expect(homePointOf(s, "resident_2_0")).toEqual(houseDoorstep(CENTER, OWN));
    const ins = inspectCreature(s, "resident_2_0", {
      state: { avatars: { resident_2_0: { x: inOwnKitchen.x, y: inOwnKitchen.y } } },
    });
    // The reported symptom: "138.4 m from home" for a body in its own kitchen.
    const metres = Number(/([\d.]+) m from home/.exec(rowOf(ins.rows, "position")!)![1]);
    expect(metres).toBeLessThan(Math.hypot(OWN.w, OWN.h) + 2);
  });

  it("reports its OWN household's schedule phase, not a neighbour's", () => {
    const s = stubSession({ houses: HOUSES });
    expect(rowOf(inspectCreature(s, "resident_2_0", {}).rows, "schedule")).toBe("food:to_source@2");
    expect(rowOf(inspectCreature(s, "resident_3_0", {}).rows, "schedule")).toBe("food:to_source@3");
  });

  it("a lot id past the end of the array is a homebody, never a crash", () => {
    const s = stubSession({ houses: HOUSES });
    const ins = inspectCreature(s, "resident_9_0", {});
    expect(rowOf(ins.rows, "schedule")).toBe("homebody (no duty)");
    expect(homePointOf(s, "resident_9_0")).toBeUndefined();
  });
});

describe("§2 the detail block, continued — the task, the claims, the meters", () => {
  it("the activity and the destination come off the host's own readings", () => {
    const s = stubSession({ npcGoing: new Map([["resident_0_0", { kind: "fetch", good: "bread" }]]) });
    const ins = inspectCreature(s, "resident_0_0", {
      activityOf: () => ({ verb: "get", object: "bread" }),
    });
    expect(rowOf(ins.rows, "activity")).toBe("get bread");
    expect(rowOf(ins.rows, "going")).toBe("get bread");
    expect(goingText({ kind: "room", room: "bedroom" })).toBe("bedroom");
    expect(goingText(undefined)).toBe("");
  });

  it("the TASK line follows the loop's own priority: pooled task over pursuit over step", () => {
    const step = new Map([
      ["resident_0_0", { tplKey: "eat", kind: "take", goodKey: "bread", units: 1, objId: "chest_1", pos: INSIDE }],
    ]);
    const stepOnly = inspectCreature(stubSession({ needStep: step as never }), "resident_0_0", {});
    expect(rowOf(stepOnly.rows, "task")).toContain("need step take bread×1 @ chest_1");

    const pursued = inspectCreature(
      stubSession({
        needStep: step as never,
        pursuits: new Map([["resident_0_0", { source: "command", glyph: "get + bread", goal: { kind: "fetch" }, acts: 1 }]]),
      }),
      "resident_0_0",
      {},
    );
    expect(rowOf(pursued.rows, "task")).toContain('command pursuit "get + bread"');

    const claimed = inspectCreature(
      stubSession({
        needStep: step as never,
        pursuits: new Map([["resident_0_0", { source: "command", glyph: "get + bread", goal: { kind: "fetch" } }]]),
        claimedTask: { sourceGlyph: "build + bedroom", goal: { kind: "buildwork" }, issuer: "player" },
      }),
      "resident_0_0",
      {},
    );
    expect(rowOf(claimed.rows, "task")).toContain('pooled task "build + bedroom" from player');
  });

  it("a BLOCKED want is reported rather than left blank", () => {
    const s = stubSession({ blocked: new Map([["resident_0_0", { tplKey: "eat", goodKey: "bread" }]]) });
    expect(rowOf(inspectCreature(s, "resident_0_0", {}).rows, "task")).toMatch(/BLOCKED want bread/);
  });

  it("shows the household errand claim AND the body's unit reservations", () => {
    const s = stubSession({ errandClaims: new Map([["0|restock", "resident_0_0"]]) });
    s.needClaims.reserve("need:resident_0_0", "chest_1", "bread", 3);
    s.needClaims.reserve("need:resident_0_1", "chest_1", "bread", 1); // somebody else's
    const claims = rowOf(inspectCreature(s, "resident_0_0", {}).rows, "claims")!;
    expect(claims).toContain("errand 0|restock");
    expect(claims).toContain("bread×3 @ chest_1");
    expect(claims).not.toContain("bread×1");
  });

  it("shows meters, condition and unfulfilled wants", () => {
    const s = stubSession({
      meters: new Map([
        ["resident_0_0|eat", 0.42],
        ["resident_0_1|eat", 0.9],
      ]),
      creatures: {
        resident_0_0: {
          condition: "dirty",
          needs: [
            { fulfilled: false, target: { category: "food" } },
            { fulfilled: true, target: { category: "fun" } },
          ],
        },
      },
    });
    const rows = inspectCreature(s, "resident_0_0", {}).rows;
    expect(rowOf(rows, "meters")).toBe("eat 0.42"); // only this body's
    expect(rowOf(rows, "condition")).toBe("dirty");
    expect(rowOf(rows, "wants")).toBe("food");
  });
});

describe("§2 ② the list: named individuals, a counted crowd", () => {
  it("lists the family and its pets even when nothing has registered them", () => {
    const { named } = inspectRoster(stubSession(), {});
    expect(named).toEqual(["resident_0_0", "resident_0_1", "pet_0_0"]);
  });

  it("adds every REGISTERED creature and every live-needs body, without duplicates", () => {
    const { named } = inspectRoster(
      stubSession({
        creatures: { resident_0_0: {}, npc_guard: {} },
        liveNeedBodies: new Set(["resident_9_3", "resident_0_1"]),
      }),
      {},
    );
    expect(named).toEqual(["resident_0_0", "resident_0_1", "pet_0_0", "npc_guard", "resident_9_3"]);
  });

  it("COUNTS the ambient cohort instead of enumerating it (law ⑤)", () => {
    const avatars: Record<string, { x: number; y: number }> = {};
    for (let i = 0; i < 40; i++) avatars[`resident_${5 + i}_0`] = { x: 0, y: 0 };
    avatars["resident_0_0"] = { x: 0, y: 0 }; // a named one — not ambient
    const roster = inspectRoster(stubSession(), { state: { avatars } });
    expect(roster.named).toHaveLength(3);
    expect(roster.ambient).toBe(40);
    for (const id of roster.named) expect(id.startsWith("resident_5")).toBe(false);
  });
});

describe("§2 ④ the collapsed row is cheap", () => {
  it("summarizeCreature asks none of the expensive probes", () => {
    let why = 0;
    let carry = 0;
    const s = stubSession({
      creatures: { resident_0_0: { condition: "cold", needs: [{ fulfilled: false, target: { category: "warm" } }] } },
    });
    const line = summarizeCreature(s, "resident_0_0", {
      nameOf: () => "Mara",
      whyProbe: () => {
        why++;
        return [];
      },
      carryOf: () => {
        carry++;
        return {};
      },
    });
    expect(why).toBe(0);
    expect(carry).toBe(0);
    expect(line).toContain("resident_0_0");
    expect(line).toContain("“Mara”");
    expect(line).toContain("[cold]");
    expect(line).toContain("want:warm");
    expect(line).toContain("⏸ abstracted"); // no state handed over ⇒ no body
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — the same projection over the REAL shipped dollhouse, headless
// ═══════════════════════════════════════════════════════════════════════════

const specPath = join(process.cwd(), "games", "dollhouse", "src", "game.spec.json");
const doc = JSON.parse(readFileSync(specPath, "utf8"));

let run: TextQuestRun;

describe("§2 the readout against the real dollhouse", () => {
  beforeAll(() => {
    run = bootTextQuest({ world: doc, dt: 1 / 20 });
    run.advance(60); // ~3 sim seconds: the streamer stands the household up
  });
  afterAll(() => run?.dispose());

  const probes = (): InspectProbes => ({
    state: run.host.world?.state ?? null,
    activityOf: (cid) => run.host.activityOf(cid),
    whyProbe: (cid) => run.host.whyProbe(cid),
    carryOf: (cid) => run.host.carryOf(cid),
    nameOf: (cid) => run.host.nameOf(cid),
    errandPath: (id) => run.host.world?.npcErrandPath(id) ?? null,
  });

  it("lists the whole focus family by name and counts the rest of the town", () => {
    const roster = inspectRoster(run.session, probes());
    const house = run.session.town!.familyHouse!;
    const members = run.session.town!.config.family?.members ?? [];
    expect(members.length).toBeGreaterThan(0); // the dollhouse HAS a family
    for (const [i] of members.entries()) {
      expect(roster.named).toContain(`resident_${house}_${i}`);
    }
    expect(roster.named.length).toBeLessThan(40); // never the whole town
    expect(roster.ambient).toBeGreaterThanOrEqual(0);
  });

  it("① a resident the streamer has NOT embodied still reports where it is in its day", () => {
    // The dollhouse camera is parked at the focus house, so residents of the
    // far houses have no body at all — the exact creature the old panel could
    // not show, because clicking needs something to click on.
    const state = run.host.world!.state;
    const abstracted = run.session
      .town!.plan.houses.map((h) => `resident_${h.index}_0`)
      .find((cid) => !state.avatars[cid]);
    expect(abstracted).toBeTruthy();
    const ins = inspectCreature(run.session, abstracted!, probes());
    expect(ins.embodied).toBe(false);
    expect(rowOf(ins.rows, "position")).toBeUndefined();
    expect(rowOf(ins.rows, "schedule")).toBeTruthy(); // the clock answers instead
    expect(ins.summary).toContain("⏸ abstracted");
  });

  it("every listed creature yields a readout — embodied or not — and no row is blank", () => {
    const roster = inspectRoster(run.session, probes());
    for (const cid of roster.named) {
      const ins = inspectCreature(run.session, cid, probes());
      expect(ins.cid).toBe(cid);
      expect(ins.summary.startsWith(cid)).toBe(true);
      expect(ins.rows.length).toBeGreaterThan(0);
      for (const row of ins.rows) expect(row.value).not.toBe("");
      // The body arm is exclusive and total: a position XOR the ABSTRACTED note.
      const body = rowOf(ins.rows, "body")!;
      expect(ins.embodied ? body.startsWith("embodied") : body.startsWith("ABSTRACTED")).toBe(true);
      expect(!!rowOf(ins.rows, "position")).toBe(ins.embodied);
    }
  });

  it("③ ASKING MOVES NOTHING — a full inspection pass leaves the sim untouched", () => {
    const digest = () =>
      JSON.stringify({
        claims: run.session.needClaims.toJSON(),
        steps: [...run.session.needStep].map(([c, s]) => [c, s.tplKey, s.kind, s.goodKey, s.objId ?? null]),
        errands: [...run.session.errandClaims],
        live: [...run.session.liveNeedBodies].sort(),
        meters: [...run.session.needMeters].sort(),
        clock: run.session.townClock,
        going: [...run.session.npcGoing].map(([c, g]) => [c, g.kind]),
      });
    const before = digest();
    const roster = inspectRoster(run.session, probes());
    for (const cid of roster.named) {
      inspectCreature(run.session, cid, probes());
      summarizeCreature(run.session, cid, probes());
    }
    expect(digest()).toBe(before);
    // The pinned form of the promise: the reservation ledger's own serial.
    expect(run.session.needClaims.toJSON().serial).toBe(
      JSON.parse(before).claims.serial as number,
    );
  });

  // ⚠️ LAST IN THE FILE — this one PUTS A BASKET on a real body, so it must not
  // run before the read-only pins above.
  it("⑤ a real body given a real basket says so — the host's own `handsOf` agrees", () => {
    const cid = `resident_${run.session.dollhouse!}_0`;
    // Whatever the readout claims is in the hands, the host must claim too:
    // one rule (`carriedBy`), two readers.
    for (const other of inspectRoster(run.session, probes()).named) {
      const hands = run.host.handsOf(other);
      if (hands) expect(rowOf(inspectCreature(run.session, other, probes()).rows, "carrying")!).toContain(hands.glyph);
    }
    const bag = run.host.giveBag(cid, "basket");
    expect(bag).not.toBeNull();
    expect(run.host.handsOf(cid)).toMatchObject({ objId: bag!, glyph: "basket", bag: true });
    // The empty basket the merged view could not see — the reported lie, on
    // real data. (`carryOf` still reports nothing, which is its own law.)
    expect(run.host.carryOf(cid)).toEqual({});
    expect(rowOf(inspectCreature(run.session, cid, probes()).rows, "carrying")).toBe("basket (empty)");
  });
});
