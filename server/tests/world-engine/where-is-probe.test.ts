// THE HOST HALF of household-economy-and-where-is.md — Fix C (§4) and the
// READ-ONLY probe behind Fix B (§5.1), against the REAL shipped dollhouse
// document, headless (no GL, no DOM).
//
// Two claims, both of which the reported "fridge blindness" run falsified:
//
//  ① `session.placeFacts` is populated in a household with NO QUEST CAST. The
//     dollhouse spec has no `questCount`, so `creatureWorldFromGame` is null at
//     boot and the old `!session.creatures` guard bailed out of the WHOLE
//     builder — including the ambient `buy:good:<key>` block, which needs only
//     `town.stage`. A town knows where its own market is whether or not anybody
//     has been cast in a quest. (§4)
//
//  ② A household member asked "where is the food?" answers from its OWN acquire
//     resolution — the refrigerator its own hunger row would open — and asking
//     MOVES NOTHING. Law ③ is a law about the sim: a question that reserved
//     units or parked a row would make asking a creature something a way of
//     PUSHING it. (§2 law ③, §5.1)
//
// Cost note (headless-quest-boot.test.ts documents the measurements): the BOOT
// is the expensive part, so this file boots ONCE and the arc is a couple of sim
// seconds. Long play arcs belong in the tsx text-mode CLI, not in jest.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import { knownProvider } from "@shared/world-engine/interaction/behavior/creatures.js";
import {
  selectAct,
  type DialogueAct,
  type ProjectionOpts,
} from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";

const specPath = join(process.cwd(), "games", "dollhouse", "src", "game.spec.json");
const doc = JSON.parse(readFileSync(specPath, "utf8"));
const DT = 1 / 20;

let run: TextQuestRun;
/** The place-fact keys as they stood AT BOOT — before a frame, before any
 *  resident was streamed in, with no cast in the document at all. */
let factsAtBoot: string[];

beforeAll(() => {
  run = bootTextQuest({ world: doc, dt: DT });
  factsAtBoot = [...run.session.placeFacts.keys()];
  run.advance(40); // ~2 sim seconds: the streamer stands the household up
});

afterAll(() => run?.dispose());

describe("Fix C — the ambient place facts do not depend on a quest cast", () => {
  it("a dollhouse boot (no questCount) knows where its goods are bought", () => {
    expect(run.session.town).not.toBeNull();
    expect(factsAtBoot).toContain("buy:good:food");
    // `directionsForNeed({ category: "food" })` IS this predicate — the whole of
    // its body is "is `buy:good:<category>` a fact this town holds?".
    expect(run.session.placeFacts.has("buy:good:food")).toBe(true);
  });

  it("…so a streamed resident learns a PROVIDER for food", () => {
    const hi = run.session.dollhouse!;
    const members = Object.keys(run.state.avatars)
      .filter((id) => id.startsWith(`resident_${hi}_`))
      .sort();
    expect(members.length).toBeGreaterThan(0);
    // The seeding in `ensureResidentCreature` reads these very subjects, so it
    // used to seed nothing at all. Members get creature rows lazily, on contact;
    // whichever ones exist must all carry the fact.
    const withCreature = members.filter((id) => !!run.session.creatures?.world.creatures[id]);
    expect(withCreature.length).toBeGreaterThan(0);
    for (const cid of withCreature) {
      const creature = run.session.creatures!.world.creatures[cid]!;
      expect(knownProvider(creature, ["food"])).toBe("buy:good:food");
    }
  });
});

describe("Fix B — the probe IS the body's own acquire resolution, and it is read-only", () => {
  const memberCid = (): string => {
    const hi = run.session.dollhouse!;
    return Object.keys(run.state.avatars)
      .filter((id) => id.startsWith(`resident_${hi}_`))
      .sort()[0]!;
  };

  it("a stocked house answers with the REFRIGERATOR — the box its own row would open", () => {
    const cid = memberCid();
    const fridgeId = `furn_${run.session.dollhouse}_chest_food`;
    // The house's food chest is stocked at boot (the reported run had it at
    // 9/15 units while everyone walked to market).
    const stock = run.session.containerStock.get(fridgeId) ?? {};
    expect(Object.values(stock).reduce((s, n) => s + n, 0)).toBeGreaterThan(0);

    expect(run.host.sourceProbe(cid, { category: "food" })).toEqual({
      kind: "container",
      objId: fridgeId,
      // The WORD, never the id: `furn_<n>_chest_food` is a refrigerator
      // (stations.ts `kindByGood`), and "chest" is not in the vocabulary.
      glyph: "refrigerator",
    });
  });

  it("a KIND resolves through the same row as its category; an unknown sort answers nothing", () => {
    const cid = memberCid();
    // "where is an apple?" is answered by the box the hunger row would open.
    expect(run.host.sourceProbe(cid, { kind: "apple" })).toMatchObject({ kind: "container" });
    // A sort this body runs NO row for is `undefined` — "ask somebody else",
    // which is a different fact from "there is none".
    expect(run.host.sourceProbe(cid, { category: "gold" })).toBeUndefined();
  });

  it("the dialogue layer speaks it: the verbless locative naming the fridge", () => {
    const cid = memberCid();
    const world = run.session.creatures!.world;
    const other = Object.keys(world.creatures).find((id) => id !== cid) ?? cid;
    const res = selectAct(world, cid, other, foodAsk(), "c", hostOpts());
    expect(res.responseGlyph).toBe("food + in + refrigerator");
  });

  it("READ-ONLY IS A LAW — an answered ask leaves claims, steps, parks and meters untouched", () => {
    const cid = memberCid();
    const world = run.session.creatures!.world;
    const other = Object.keys(world.creatures).find((id) => id !== cid) ?? cid;
    const snapshot = () => ({
      claims: JSON.stringify(run.session.needClaims.toJSON()),
      step: JSON.stringify([...run.session.needStep.entries()]),
      parks: JSON.stringify([...run.session.needParks.entries()]),
      meters: JSON.stringify([...run.session.needMeters.entries()]),
      clock: run.session.taskClock,
    });
    const before = snapshot();
    for (let i = 0; i < 8; i++) {
      run.host.sourceProbe(cid, { category: "food" });
      run.host.sourceProbe(cid, { category: "water" });
      selectAct(world, cid, other, foodAsk(), "c", hostOpts());
    }
    expect(snapshot()).toEqual(before);
  });

  /** The ambient ask exactly as an NPC projects it. */
  function foodAsk(): DialogueAct {
    return {
      kind: "where-is",
      itemId: "good:food",
      target: { category: "food" },
      glyph: "place#question + food",
    };
  }
  /** Projection opts wired to the REAL host probe — the join under test. */
  function hostOpts(): ProjectionOpts {
    return {
      symbolOf: (id) => id,
      resolveSourceFor: (who, target) => run.host.sourceProbe(who, target),
    };
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// §8 FIX D — THE LOCATE LADDER, over the live household
//
// *"'Where' should be able to apply to anything with a location — an object, a
// creature, furniture, a room or a building."* Rung 1 (law ③) is pinned above;
// this is rungs 2-7, each asked of the SAME booted dollhouse with the one fact
// it is about planted and then taken away again. The ladder is a READ, so
// planting is the only writing anybody does here.
// ═══════════════════════════════════════════════════════════════════════════

describe("Fix D — the locate ladder searches the answerer's own ken", () => {
  const hi = () => run.session.dollhouse!;
  const memberCid = (): string =>
    Object.keys(run.state.avatars)
      .filter((id) => id.startsWith(`resident_${hi()}_`))
      .sort()[0]!;
  const fridgeId = () => `furn_${hi()}_chest_food`;
  const probe = (target: { kind?: string; category?: string }) => run.host.sourceProbe(memberCid(), target);
  const stockOf = (objId: string) => run.session.containerStock.get(objId) ?? {};
  /** The dollhouse's own footprint, from the town plan the host reads. */
  const houseSpot = (): { x: number; y: number } => {
    const town = run.session.town!;
    const house = town.plan.houses[hi()]!;
    const c = town.stage.center;
    return { x: c.x + house.dx + house.w / 2, y: c.y + house.dy + house.h / 2 };
  };
  /** Plant a loose prop (optionally in somebody's hands) and hand back its
   *  removal. Cloned off a live object so every ObjectState field is real. */
  function plantProp(glyph: string, over: { carriedBy?: string; at?: { x: number; y: number } } = {}) {
    const objId = `small:test_${glyph}`;
    const proto = Object.values(run.state.objects)[0]!;
    const at = over.at ?? houseSpot();
    run.state.objects[objId] = {
      ...proto,
      id: objId,
      x: at.x,
      y: at.y,
      carriedBy: over.carriedBy ?? null,
      containedIn: null,
    };
    run.session.smallProps.set(objId, { entityId: objId, glyph });
    return () => {
      delete run.state.objects[objId];
      run.session.smallProps.delete(objId);
    };
  }
  /** Put units of a glyph in a box, restoring the previous stack afterwards. */
  function planted(objId: string, stack: Record<string, number>) {
    const before = { ...stockOf(objId) };
    run.session.containerStock.set(objId, stack);
    return () => run.session.containerStock.set(objId, before);
  }

  it("rung 2 — the fridge answers an APPLE ask only because it holds apples", () => {
    expect(Object.keys(stockOf(fridgeId()))).toContain("apple");
    expect(probe({ kind: "apple" })).toMatchObject({ kind: "container", objId: fridgeId() });
  });

  it("rung 2 — a fridge of nothing but bananas does NOT answer an apple ask", () => {
    // The row still resolves to the refrigerator (there IS food in it), so this
    // is precisely the check that must override rung 1: "the apple is in the
    // refrigerator" would be a lie about the one thing that was asked.
    const restore = planted(fridgeId(), { banana: 6 });
    try {
      const ans = probe({ kind: "apple" });
      expect(ans?.kind === "container" && ans.objId === fridgeId()).toBe(false);
      // Whatever it DOES answer, if it names a box that box really holds one.
      if (ans?.kind === "container") expect(Object.keys(stockOf(ans.objId))).toContain("apple");
      // …and the CATEGORY ask is untouched: a fridge of bananas is still where
      // the food is (law ③ — the row's own resolution).
      expect(probe({ category: "food" })).toMatchObject({ kind: "container", objId: fridgeId() });
    } finally {
      restore();
    }
  });

  it("rung 2 — a ball banked in a household box answers with that box", () => {
    const box = [...run.session.containerStock.keys()].filter((id) => id.startsWith(`furn_${hi()}_`)).sort()[0]!;
    const restore = planted(box, { ball: 1 });
    try {
      expect(probe({ kind: "ball" })).toEqual({
        kind: "container",
        objId: box,
        glyph: expect.any(String),
      });
    } finally {
      restore();
    }
  });

  it("rung 3 — a ball in the PET's mouth answers with the holder, not a box", () => {
    const pet =
      Object.keys(run.state.avatars)
        .filter((id) => id.startsWith("pet_"))
        .sort()[0] ?? `resident_${hi()}_1`;
    const remove = plantProp("ball", { carriedBy: pet });
    try {
      expect(probe({ kind: "ball" })).toEqual({ kind: "holder", cid: pet });
    } finally {
      remove();
    }
  });

  it("rung 3 — the answerer's OWN hands count (it is a household body too)", () => {
    const remove = plantProp("ball", { carriedBy: memberCid() });
    try {
      expect(probe({ kind: "ball" })).toEqual({ kind: "holder", cid: memberCid() });
    } finally {
      remove();
    }
  });

  it("rung 4 — a ball lying on the floor answers with an at: point", () => {
    // The shipped dollhouse already has a toy on the floor, which is exactly the
    // case: nobody is holding it, no box has it, and the honest answer is to
    // point at where it lies.
    const ans = probe({ kind: "ball" });
    expect(ans?.kind).toBe("place");
    const objId = (ans as { subjectId: string }).subjectId.replace(/^at:/, "");
    const prop = run.session.smallProps.get(objId);
    expect(prop).toBeDefined(); // a LOOSE prop, not a fixture
    expect(run.state.objects[objId]?.carriedBy ?? null).toBeNull();
  });

  it("rung 7 — a sort that is nowhere at all is answered by nothing (honest)", () => {
    // No lie, and no "I don't have any" either: the ladder simply cannot place
    // it, and the evaluator says so ("I don't know" — never a shrug about a
    // stranger's ball, never a town-wide search).
    expect(probe({ kind: "unicorn" })).toBeUndefined();
  });

  it("rung 5 — a FURNITURE WORD points at the piece itself", () => {
    expect(probe({ kind: "refrigerator" })).toEqual({ kind: "place", subjectId: `at:${fridgeId()}` });
  });

  it("SCOPE LAW — a body with no household of its own answers nothing", () => {
    expect(run.host.sourceProbe("wanter_nobody", { kind: "ball" })).toBeUndefined();
  });

  // §9 E3 names this explicitly: *"Biscuit-the-pet asking 'Where is the food?'
  // is CORRECT behavior (grasp=false so its own resolution is blocked) — do not
  // suppress it."* E2's gate drops an ask only on `container`/`place`, so what
  // keeps the pet's question alive is that its own probe answers NEITHER.
  it("§9 E3 — the PET's own food resolution is a genuine GAP, so its ask survives", () => {
    const pet = Object.keys(run.state.avatars)
      .filter((id) => id.startsWith("pet_"))
      .sort()[0];
    expect(pet).toBeDefined();
    const ans = run.host.sourceProbe(pet!, { category: "food" });
    expect(ans?.kind === "container" || ans?.kind === "place").toBe(false);
  });

  it("READ-ONLY holds across the WHOLE ladder, not just rung 1", () => {
    const snapshot = () => ({
      claims: JSON.stringify(run.session.needClaims.toJSON()),
      step: JSON.stringify([...run.session.needStep.entries()]),
      parks: JSON.stringify([...run.session.needParks.entries()]),
      meters: JSON.stringify([...run.session.needMeters.entries()]),
      props: run.session.smallProps.size,
      stock: JSON.stringify([...run.session.containerStock.entries()]),
      clock: run.session.taskClock,
    });
    const remove = plantProp("ball");
    try {
      const before = snapshot();
      for (const t of [
        { kind: "apple" },
        { kind: "ball" },
        { kind: "refrigerator" },
        { category: "food" },
        { kind: "unicorn" },
      ]) {
        for (let i = 0; i < 4; i++) probe(t);
      }
      expect(snapshot()).toEqual(before);
    } finally {
      remove();
    }
  });

  it("DETERMINISM — two identical asks give byte-identical answers", () => {
    const remove = plantProp("ball");
    try {
      for (const t of [{ kind: "apple" }, { kind: "ball" }, { category: "food" }, { kind: "refrigerator" }]) {
        expect(JSON.stringify(probe(t))).toBe(JSON.stringify(probe(t)));
      }
    } finally {
      remove();
    }
  });
});
