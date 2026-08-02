// CONSTRUCTION PHASE 4 (construction-phase4-plan.md) — DESIGNATIONS ARE
// REMOVABLE, and the two unmaking verbs are sayable.
//
// The load-bearing reversal: room programs used to be APPEND-ONLY (pipeline
// ④ pushed, nothing ever deleted), so a demolished bedroom re-ordered itself
// the next sweep — the house healed what the player deliberately tore out.
// Phase 4 gives programs their FIRST delete path (`removeProgram`), and the
// commit of every removal act (demolish / empty / break) drops the row the
// removed thing stood for. Alongside it: `emptyRoom` (the stow-half of
// demolishRoom — furniture out, WALLS STAY), the `mode: "empty"` demolition
// order that rides the same ladder, the persisted craft QUEUE (a second
// make-order waits instead of being dropped), and the spoken `break`/`empty`
// compile arms. No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  annexOptions,
  bankLabor,
  createTownDeltas,
  demolishCheck,
  demolishRoom,
  demolitionLaborDone,
  demolitionStage,
  emptyRoom,
  nextAnnexWant,
  orderDone,
  orderStage,
  removeProgram,
  requestAnnex,
  type PendingDemolition,
  type QueuedCraft,
  type SerializedTownDeltas,
} from "@shared/world-engine/kernel/town/construction.js";
import { houseRoomPlan, type HouseRoom } from "@shared/world-engine/kernel/town/rooms.js";
import { buildTownPlay, TOWN_PLAY_STRUCTURES } from "@shared/world-engine/interaction/town/town-play.js";
import { houseFurniture } from "@shared/world-engine/kernel/town/furniture.js";
import { ROOM_GLYPH } from "@shared/world-engine/interaction/town/structure-board.js";
import { DEFAULT_ROOM_PROGRAMS } from "@shared/world-engine/kernel/town/programs.js";
import { resolveStructure } from "@shared/world-engine/kernel/town/structures.js";
import { FURNITURE_ITEMS, type StationKind } from "@shared/world-engine/kernel/town/stations.js";
import { fixtureKindForWord } from "@shared/world-engine/types.js";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import {
  compileIntent,
  defaultBinder,
  type IntentBinder,
} from "@shared/world-engine/interaction/intent/intent-compile.js";
import {
  createConstructionDirector,
  CRAFT_QUEUE_CAP,
  type ConstructionDirectorCtx,
} from "@shared/world-engine/interaction/quest/construction-director.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import { REAL_SCALE } from "@shared/world-engine/scale.js";

const CONFIG = { seed: 5, days: 30, questCount: 0, key: "smalltown", startPop: 20 };

/** The demolition suite's fixture, verbatim — a lived-in town with houses
 *  whose plans are real (annex specs, base partitions, generated furniture). */
function established() {
  const play = buildTownPlay(CONFIG);
  expect(play.plan.houses.length).toBeGreaterThanOrEqual(6);
  return play;
}

function neighborRectsOf(play: ReturnType<typeof buildTownPlay>, index: number) {
  const c = play.stage.center;
  return [
    ...play.plan.houses
      .filter((h) => h.index !== index)
      .map((h) => ({ x: c.x + h.dx, y: c.y + h.dy, w: h.w, h: h.h })),
    ...play.plan.works.map((w) => ({ x: c.x + w.dx, y: c.y + w.dy, w: w.w, h: w.h })),
  ];
}

/** The first house of the fixture, with its live (delta-applied) plan. */
function firstHouse(play: ReturnType<typeof buildTownPlay>) {
  const house = play.plan.houses[0]!;
  const key = `h_${house.index}`;
  const planOf = () => houseRoomPlan(play.stage.center, house, play.deltas.get(key));
  return { house, key, planOf };
}

const inRect = (r: HouseRoom, x: number, y: number) =>
  x >= r.rect.x && x <= r.rect.x + r.rect.w && y >= r.rect.y && y <= r.rect.y + r.rect.h;

/** GENERATED (worldgen, not delta-placed) pieces standing in one room — the
 *  director's `generatedPiecesIn`, mirrored: what it computes and hands to
 *  `emptyRoom`. STREET-GOOD BOXES are excluded on both sides — furnishPlan's
 *  goodsCorner arm re-emits them whatever `removedPieces` says (the economy's
 *  wiring), so stowing one would mint a duplicate unit. */
function generatedIn(
  play: ReturnType<typeof buildTownPlay>,
  house: ReturnType<typeof firstHouse>["house"],
  room: HouseRoom,
): Array<{ id: string; kind: StationKind }> {
  const key = `h_${house.index}`;
  const delta = play.deltas.get(key);
  const placed = new Set((delta?.placed ?? []).map((p) => p.id));
  const goodDefs = play.stage.goods.map((g) => ({ key: g.good.key, slot: g.good.slot }));
  return houseFurniture(play.stage.center, house, goodDefs, "", delta)
    .filter((p) => !placed.has(p.id) && !p.good && inRect(room, p.x, p.y))
    .map((p) => ({ id: p.id, kind: p.kind }));
}

// ─────────────────────────────────────────────────────────────────────────
// STEP 1 — the kernel designation lifecycle
// ─────────────────────────────────────────────────────────────────────────

describe("removeProgram — the first delete path programs have ever had", () => {
  it("drops the named row, leaves the others, and bumps the revision", () => {
    const deltas = createTownDeltas();
    // The requestAnnex-side push: one row per ordered room kind.
    deltas.mutate("h_0", (d) => {
      d.programs = [
        { ord: 0, room: "bedroom" },
        { ord: 1, room: "kitchen", roomId: "h0_r2" },
        { ord: 2, room: "store" },
      ];
    });
    const v = deltas.version;
    const rev = deltas.get("h_0")!.rev;
    expect(removeProgram(deltas, "h_0", "kitchen")).toBe(true);
    expect(deltas.get("h_0")?.programs).toEqual([
      { ord: 0, room: "bedroom" },
      { ord: 2, room: "store" },
    ]);
    expect(deltas.version).toBeGreaterThan(v);
    expect(deltas.get("h_0")!.rev).toBeGreaterThan(rev);
  });

  it("an ABSENT room no-ops — no revision, no version, nothing touched", () => {
    const deltas = createTownDeltas();
    deltas.mutate("h_0", (d) => {
      d.programs = [{ ord: 0, room: "bedroom" }];
    });
    const v = deltas.version;
    const rev = deltas.get("h_0")!.rev;
    expect(removeProgram(deltas, "h_0", "workshop")).toBe(false);
    expect(deltas.version).toBe(v);
    expect(deltas.get("h_0")!.rev).toBe(rev);
    expect(deltas.get("h_0")?.programs).toEqual([{ ord: 0, room: "bedroom" }]);
    // An unknown BUILDING is the same no-op (and never mints a delta).
    expect(removeProgram(deltas, "h_9", "bedroom")).toBe(false);
    expect(deltas.version).toBe(v);
    expect(deltas.get("h_9")).toBeUndefined();
  });

  it("OTHER buildings' rows are untouched — the delete is building-scoped", () => {
    const deltas = createTownDeltas();
    deltas.mutate("h_0", (d) => { d.programs = [{ ord: 0, room: "bedroom" }]; });
    deltas.mutate("h_1", (d) => { d.programs = [{ ord: 0, room: "bedroom" }]; });
    expect(removeProgram(deltas, "h_0", "bedroom")).toBe(true);
    expect(deltas.get("h_0")?.programs).toEqual([]);
    expect(deltas.get("h_1")?.programs).toEqual([{ ord: 0, room: "bedroom" }]);
  });

  it("a PINNED row (roomId) rides the deltas round-trip", () => {
    // The empty-room-reuse push pins the want to a room the installers could
    // never find by kind-match (a bare room derives "hall").
    const deltas = createTownDeltas();
    deltas.mutate("h_3", (d) => {
      d.programs = [{ ord: 0, room: "bedroom", roomId: "h3_r1" }];
    });
    const back = createTownDeltas(JSON.parse(JSON.stringify(deltas.toJSON())) as SerializedTownDeltas);
    expect(back.get("h_3")?.programs).toEqual([{ ord: 0, room: "bedroom", roomId: "h3_r1" }]);
    expect(removeProgram(back, "h_3", "bedroom")).toBe(true);
  });
});

describe("NEVER SELF-HEALING — the want goes with the room (phase 4 step 1)", () => {
  it("a demolished programmed room re-rises UNTIL removeProgram runs, then never", () => {
    // The commit's contract, at the kernel: demolishRoom + removeProgram.
    // Before phase 4 the row was immortal, and this is precisely the loop it
    // caused — the house re-ordering what the player tore down.
    const play = established();
    // A house that can take a `store` annex — the store want is the one
    // nextAnnexWant's DEFAULT order reaches last, so a "store" answer can
    // only have come from the program row.
    let staked: { key: string; house: ReturnType<typeof firstHouse>["house"] } | null = null;
    for (const house of play.plan.houses) {
      const key = `h_${house.index}`;
      const plan = houseRoomPlan(play.stage.center, house, play.deltas.get(key));
      if (plan.rooms.some((r) => r.kind === "store")) continue;
      const c = annexOptions(
        play.stage.center, house, plan,
        neighborRectsOf(play, house.index), play.deltas.get(key), "store",
      )[0];
      if (!c) continue;
      expect(requestAnnex(play.deltas, key, c).ok).toBe(true);
      staked = { key, house };
      break;
    }
    expect(staked).not.toBeNull();
    const { key, house } = staked!;
    // The standing want the order left behind (director: pushProgramWant).
    play.deltas.mutate(key, (d) => { d.programs = [{ ord: 0, room: "store" }]; });
    const planNow = () => houseRoomPlan(play.stage.center, house, play.deltas.get(key));
    const store = planNow().rooms.find((r) => r.kind === "store")!;
    // Met: the want falls through to the default differentiation.
    expect(nextAnnexWant(planNow(), play.deltas.get(key)?.programs)).not.toBe("store");
    // The room comes down.
    expect(demolishRoom(play.deltas, key, planNow(), store.id).ok).toBe(true);
    expect(planNow().rooms.some((r) => r.kind === "store")).toBe(false);
    // THE OLD LAW, still visible while the row stands — the house wants it back.
    expect(nextAnnexWant(planNow(), play.deltas.get(key)?.programs)).toBe("store");
    // THE PHASE-4 COMMIT drops the row, and the want is gone for good.
    expect(removeProgram(play.deltas, key, "store")).toBe(true);
    expect(nextAnnexWant(planNow(), play.deltas.get(key)?.programs)).not.toBe("store");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// STEP 2 — the emptyRoom kernel (furniture out, walls stay)
// ─────────────────────────────────────────────────────────────────────────

describe("emptyRoom — the stow-half of demolishRoom", () => {
  it("stows the room's PLACED pieces by kind and leaves every other room's alone", () => {
    const play = established();
    const { house, key, planOf } = firstHouse(play);
    const plan = planOf();
    const [a, b] = [plan.rooms[0]!, plan.rooms[1]!];
    expect(b).toBeDefined();
    play.deltas.mutate(key, (d) => {
      d.placed.push(
        { id: `furn_${house.index}_p0`, kind: "chair", x: a.rect.x + 1, y: a.rect.y + 1, radius: 0.22, facing: 0, openable: false, roomId: a.id },
        { id: `furn_${house.index}_p1`, kind: "chair", x: a.rect.x + 2, y: a.rect.y + 1, radius: 0.22, facing: 0, openable: false, roomId: a.id },
        { id: `furn_${house.index}_p2`, kind: "bed", x: b.rect.x + 1, y: b.rect.y + 1, radius: 0.65, facing: 0, openable: false, roomId: b.id },
      );
    });
    const res = emptyRoom(play.deltas, key, plan, a.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stowed).toEqual({ chair: 2 });
    expect(play.deltas.get(key)!.placed.map((p) => p.id)).toEqual([`furn_${house.index}_p2`]);
  });

  it("WALLS STAY — annex specs, interior cuts and demolished rows are untouched, so the plan re-derives IDENTICALLY", () => {
    const play = established();
    const { house, key, planOf } = firstHouse(play);
    const room = planOf().rooms[0]!;
    play.deltas.mutate(key, (d) => {
      d.placed.push({
        id: `furn_${house.index}_p0`, kind: "chair",
        x: room.rect.x + 1, y: room.rect.y + 1,
        radius: 0.22, facing: 0, openable: false, roomId: room.id,
      });
    });
    const before = play.deltas.get(key)!;
    const wallsBefore = JSON.stringify({
      annexes: before.annexes, interior: before.interior ?? [], demolished: before.demolished,
    });
    const planBefore = JSON.stringify(planOf());
    expect(emptyRoom(play.deltas, key, planOf(), room.id).ok).toBe(true);
    const after = play.deltas.get(key)!;
    expect(JSON.stringify({
      annexes: after.annexes, interior: after.interior ?? [], demolished: after.demolished,
    })).toBe(wallsBefore);
    // The GEOMETRY is the claim: emptying tears nothing down.
    expect(JSON.stringify(planOf())).toBe(planBefore);
  });

  it("even the LIVING room may be emptied (no structural gate applies)", () => {
    // demolishCheck refuses rooms[0] outright — emptying has no such rule,
    // because every one of those rules is about walls.
    const play = established();
    const { key, planOf } = firstHouse(play);
    const living = planOf().rooms[0]!;
    expect(demolishCheck(play.deltas, key, planOf(), living.id).ok).toBe(false);
    expect(emptyRoom(play.deltas, key, planOf(), living.id).ok).toBe(true);
  });

  it("GENERATED pieces join removedPieces AND stow (worldgen furniture mints its item lazily)", () => {
    const play = established();
    const { house, key, planOf } = firstHouse(play);
    // A room the generator actually furnished.
    const room = planOf().rooms.find((r) => generatedIn(play, house, r).length > 0);
    expect(room).toBeDefined();
    const gen = generatedIn(play, house, room!);
    const expected: Partial<Record<StationKind, number>> = {};
    for (const g of gen) expected[g.kind] = (expected[g.kind] ?? 0) + 1;
    const res = emptyRoom(play.deltas, key, planOf(), room!.id, gen);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stowed).toEqual(expected);
    for (const g of gen) expect(play.deltas.get(key)!.removedPieces).toContain(g.id);
    // And a stowed id NEVER re-emits — anywhere in the house, not just in the
    // emptied room. (What the room holds afterwards is not pinned here: the
    // household honestly rearranges, so the goods boxes may re-flow into the
    // freed floor exactly as they do after a demolition.)
    const goodDefs = play.stage.goods.map((g) => ({ key: g.good.key, slot: g.good.slot }));
    const after = houseFurniture(play.stage.center, house, goodDefs, "", play.deltas.get(key)).map((p) => p.id);
    for (const g of gen) expect(after).not.toContain(g.id);
  });

  it("a STREET-GOOD box is not the household's furniture — it re-emits regardless, so it must never be stowed", () => {
    // WHY the director's `generatedPiecesIn` filters `p.good` out (and why
    // `orderBreakPiece` refuses one): furnishPlan's goodsCorner arm pushes the
    // pantry/wardrobe boxes UNCONDITIONALLY — `removedPieces` does not
    // withhold them, the same stance pinDisplacedFurniture takes when it
    // leaves goods-bound boxes to re-flow. Stowing one would mint its stack
    // while the box itself kept standing: a duplicated unit.
    const play = established();
    const { house, key } = firstHouse(play);
    const goodDefs = play.stage.goods.map((g) => ({ key: g.good.key, slot: g.good.slot }));
    const emit = () =>
      houseFurniture(play.stage.center, house, goodDefs, "", play.deltas.get(key));
    const box = emit().find((p) => p.good);
    expect(box).toBeDefined();
    play.deltas.mutate(key, (d) => { d.removedPieces.push(box!.id); });
    expect(emit().map((p) => p.id)).toContain(box!.id);
  });

  it("an ALREADY-BARE room returns ok with nothing stowed and NO version bump", () => {
    const play = established();
    const { house, key, planOf } = firstHouse(play);
    const room = planOf().rooms.find((r) => generatedIn(play, house, r).length > 0)!;
    const gen = generatedIn(play, house, room);
    expect(emptyRoom(play.deltas, key, planOf(), room.id, gen).ok).toBe(true);
    const v = play.deltas.version;
    const rev = play.deltas.get(key)!.rev;
    // The SAME generated list again: every id is already in removedPieces, so
    // there is nothing fresh — a re-run must not re-stow it or churn the rev
    // (the stage rebuilds off `rev`).
    const again = emptyRoom(play.deltas, key, planOf(), room.id, gen);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.stowed).toEqual({});
    expect(play.deltas.version).toBe(v);
    expect(play.deltas.get(key)!.rev).toBe(rev);
  });

  it("an unknown room refuses with `no-room`", () => {
    const play = established();
    const { key, planOf } = firstHouse(play);
    expect(emptyRoom(play.deltas, key, planOf(), "nope_r9")).toEqual({ ok: false, reason: "no-room" });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// STEP 2b — the mode:"empty" demolition order
// ─────────────────────────────────────────────────────────────────────────

describe("DemolishOrder mode:\"empty\" — the SAME row, the same ladder", () => {
  it("rides orderStage / orderDone identically to a plain demolition", () => {
    const deltas = createTownDeltas();
    const plain = deltas.postDemolitionSite({
      buildingKey: "h_0", roomId: "h0_r1", startedDay: 1, buildDays: 0.25,
    });
    const empty = deltas.postDemolitionSite({
      buildingKey: "h_1", roomId: "h1_r1", startedDay: 1, buildDays: 0.25, mode: "empty",
    });
    expect(empty.mode).toBe("empty");
    expect(plain.mode).toBeUndefined();
    for (const frac of [0, 0.5, 1]) {
      bankLabor(plain, frac * 0.25 - (plain.labor ?? 0));
      bankLabor(empty, frac * 0.25 - (empty.labor ?? 0));
      expect(orderStage(empty, 1)).toBe(orderStage(plain, 1));
      expect(orderDone(empty, 1)).toBe(orderDone(plain, 1));
      expect(demolitionStage(empty)).toBe(demolitionStage(plain));
      expect(demolitionLaborDone(empty)).toBe(demolitionLaborDone(plain));
    }
    expect(demolitionLaborDone(empty)).toBe(true);
  });

  it("round-trips byte-stably — the mode survives reload", () => {
    const deltas = createTownDeltas();
    const p = deltas.postDemolitionSite({
      buildingKey: "h_2", roomId: "h2_r0", startedDay: 3, buildDays: 0.1, mode: "empty",
    });
    bankLabor(p, 0.04); // half-cleared when the session dropped
    const json = deltas.toJSON();
    const back = createTownDeltas(JSON.parse(JSON.stringify(json)) as SerializedTownDeltas);
    const row = back.demolitionSites()[0] as PendingDemolition;
    expect(row).toEqual(p);
    expect(row.mode).toBe("empty");
    expect(JSON.stringify(back.toJSON().orders)).toBe(JSON.stringify(json.orders));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// STEP 5 — the persisted craft queue
// ─────────────────────────────────────────────────────────────────────────

const queued = (over: Partial<QueuedCraft> = {}): QueuedCraft => ({
  produces: "furn.chair",
  consumes: { block: 1 },
  at: "workbench",
  label: "chair",
  ...over,
});

describe("craftQueue persistence (phase 4 step 5)", () => {
  it("is absent-tolerant — every pre-phase-4 save loads with an empty line", () => {
    expect(createTownDeltas().craftQueue.size).toBe(0);
    expect(createTownDeltas({ version: 3, buildings: {} }).craftQueue.size).toBe(0);
  });

  it("round-trips the whole line in order, keyed by house", () => {
    const d = createTownDeltas();
    d.craftQueue.set(2, [queued(), queued({ produces: "furn.bed", label: "bed" })]);
    const back = createTownDeltas(JSON.parse(JSON.stringify(d.toJSON())) as SerializedTownDeltas);
    expect([...back.craftQueue.keys()]).toEqual([2]); // numeric keys survive the wire Record
    expect(back.craftQueue.get(2)).toEqual([
      queued(),
      queued({ produces: "furn.bed", label: "bed" }),
    ]);
  });

  it("a QueuedCraft is deliberately SPOT-LESS — the job is built at pop time", () => {
    // The row carries only the recipe: no spotId, no agreements, no labor —
    // so no stale reservation ever rides the wait (the spot follows the bench
    // standing at the moment the job actually starts).
    const d = createTownDeltas();
    d.craftQueue.set(0, [queued()]);
    const row = createTownDeltas(d.toJSON()).craftQueue.get(0)![0]! as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(["at", "consumes", "label", "produces"]);
  });

  it("an EMPTY line is not written at all (the save stays clean as jobs pop)", () => {
    const d = createTownDeltas();
    d.craftQueue.set(1, []);
    d.craftQueue.set(2, [queued()]);
    const json = d.toJSON();
    expect(json.craftQueue?.["1"]).toBeUndefined();
    expect(json.craftQueue?.["2"]).toHaveLength(1);
    const back = createTownDeltas(json);
    expect(back.craftQueue.has(1)).toBe(false);
    expect(back.craftQueue.has(2)).toBe(true);
  });

  it("clones on load — the store owns its state (no aliasing the JSON)", () => {
    const d = createTownDeltas();
    d.craftQueue.set(5, [queued()]);
    const json = d.toJSON();
    const back = createTownDeltas(json);
    back.craftQueue.get(5)![0]!.label = "mutated";
    back.craftQueue.set(6, [queued()]);
    expect(json.craftQueue?.["5"]?.[0]?.label).toBe("chair");
    expect(json.craftQueue?.["6"]).toBeUndefined();
  });

  it("serializes beside the craft JOB it queues behind, disturbing nothing", () => {
    const d = createTownDeltas();
    d.stock.block = 4;
    d.craftJobs.set(2, {
      produces: "furn.bed", consumes: { block: 1 }, at: "workbench",
      label: "bed", spotId: "furn_2_chest", agreements: [], laborS: 0,
    });
    d.craftQueue.set(2, [queued()]);
    const back = createTownDeltas(d.toJSON());
    expect(back.stock).toEqual({ block: 4 });
    expect(back.craftJobs.get(2)?.produces).toBe("furn.bed");
    expect(back.craftQueue.get(2)?.[0]?.produces).toBe("furn.chair");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// STEP 2 — the spoken verbs (intent-compile + the isStructure binding)
// ─────────────────────────────────────────────────────────────────────────

// The quest-host binder's two predicates, mirrored: `isFurniture` reads the
// furniture catalog through the fixture-word alias, `isStructure` reads the
// room words ⊕ the structure catalog (quest-host 17450 / 17474). The
// phase-4 fix is the second one — it was DECLARED and READ but never
// assigned, so every makeable word fell to the craft reading and a spoken
// "build a house" tried to whittle one.
const ROOM_WORDS = new Set<string>([
  ...Object.entries(ROOM_GLYPH).filter(([k]) => k !== "living").map(([, w]) => w),
  ...DEFAULT_ROOM_PROGRAMS.map((d) => d.word ?? d.kind),
]);

function phase4Binder(): IntentBinder {
  const binder = defaultBinder({ player: "child", listener: "bear" });
  binder.isFurniture = (ref) =>
    ref?.kind === "entity" &&
    FURNITURE_ITEMS.some((f) => f.kind === fixtureKindForWord(ref.symbol));
  binder.isStructure = (ref) =>
    ref?.kind === "entity" &&
    (ROOM_WORDS.has(ref.symbol) || !!resolveStructure(TOWN_PLAY_STRUCTURES, ref.symbol));
  return binder;
}

const compile4 = (s: string, b: IntentBinder = phase4Binder()) =>
  compileIntent(parseSentence(s), b, { id: "r1" });

describe("the unmaking verbs compile (phase 4 step 2)", () => {
  it("break + bed ⇒ breakPiece, carrying `place`'s own ItemRef", () => {
    // Furniture is the NARROWER reading and is tested first; a piece comes
    // apart where it stands, which is `place` run backwards.
    expect(compile4("break + bed")).toMatchObject({
      kind: "goal",
      goal: { kind: "breakPiece", item: { match: { kind: "bed" } } },
    });
  });

  it("break + bedroom ⇒ demolish (the board's demolish word, now sayable)", () => {
    expect(compile4("break + bedroom")).toMatchObject({
      kind: "goal",
      goal: { kind: "demolish", room: "bedroom" },
    });
  });

  it("empty + kitchen ⇒ emptyRoom — the walls stay up", () => {
    expect(compile4("empty + kitchen")).toMatchObject({
      kind: "goal",
      goal: { kind: "emptyRoom", room: "kitchen" },
    });
  });

  it("empty + box ⇒ the CONTAINER transform, exactly as before (regression)", () => {
    // Gaining the room sense must cost the box sense nothing: "empty the box"
    // is the `empty` state the default arm has always compiled.
    expect(compile4("empty + box")).toMatchObject({
      kind: "goal",
      goal: { kind: "transform", item: { match: { kind: "box" } }, state: "empty" },
    });
  });

  it("an unbindable break stays NOT-UNDERSTOOD, never a guessed demolition", () => {
    const bare = defaultBinder({ player: "child", listener: "bear" });
    // No isFurniture/isStructure bound at all (a townless session): a spoken
    // "break the bedroom" must not silently tear anything down.
    const c = compileIntent(parseSentence("break + bedroom"), bare, { id: "r1" });
    expect(c.kind).not.toBe("goal");
  });
});

describe("binder.isStructure — the phase-4 binding that makes `build` mean build", () => {
  it("build + house ⇒ build (it used to fall through to craft)", () => {
    expect(compile4("build + house")).toMatchObject({
      kind: "goal",
      goal: { kind: "build", structure: "house" },
    });
  });

  it("build + bedroom ⇒ build — a ROOM word is a structure too", () => {
    expect(compile4("build + bedroom")).toMatchObject({
      kind: "goal",
      goal: { kind: "build", structure: "bedroom" },
    });
  });

  it("make + chair ⇒ craft, and build + chair ⇒ craft as well", () => {
    // The binding only ever breaks a make/build TIE: a chair is no structure,
    // so BOTH verbs still reach the craft — "build a chair" is never a dead end.
    expect(compile4("make + chair")).toMatchObject({
      kind: "goal",
      goal: { kind: "craft", glyph: "furn.chair" },
    });
    expect(compile4("build + chair")).toMatchObject({
      kind: "goal",
      goal: { kind: "craft", glyph: "furn.chair" },
    });
  });

  it("make + house keeps whatever the makeable join says (only `build` changed)", () => {
    const c = compile4("make + house");
    expect(c.kind).toBe("goal");
    if (c.kind !== "goal") return;
    // Whichever it is, it is the SAME answer an unbound binder gives — the
    // structure binding must not have moved `make`.
    const unbound = compileIntent(parseSentence("make + house"), defaultBinder({ player: "child", listener: "bear" }), { id: "r1" });
    expect(c.goal).toEqual(unbound.kind === "goal" ? unbound.goal : null);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE DIRECTOR'S ORDER PATHS (steps 3 + 5) — a headless harness: the
// construction director over a real town-play fixture with a STUB context.
// Only the seams these two orders actually touch are supplied; everything
// else stays undefined (and unreached), which is exactly the point — the
// order handlers are meant to be reachable without a world.
// ─────────────────────────────────────────────────────────────────────────

function harness() {
  const play = established();
  const toasts: string[] = [];
  /** Which house a spoken order lands on (the host's `familyOf` answer). */
  const at = { house: null as number | null };
  const session = {
    town: play,
    townClock: 0,
    scale: REAL_SCALE, // the session default (quest-host 2185)
    containerStock: new Map<string, Record<string, number>>(),
    containers: new Map<string, "in" | "on">(),
    containerOwner: new Map<string, string | null>(),
    marketStore: new Map<string, unknown>(),
    produceBox: new Map<string, unknown>(),
    houseShown: new Set<number>(),
    // `transfers` / `reservations` ALIAS the deltas' ledgers on a town session
    // (quest-host 2206-2207) — the staking path reads both when it goes
    // looking for materials.
    transfers: play.deltas.transfers,
    reservations: play.deltas.reservations,
    taskClock: 0,
  } as unknown as QuestSession;
  const ctx = {
    presenter: { toast: (m: string) => { toasts.push(m); } },
    familyOf: () => (at.house === null ? null : { house: at.house, mode: "some", members: [] }),
    npcChatBubble: () => {},
    // Headless: nothing to drop a re-minted stack into, so break banks it.
    spawnLooseProp: () => null,
    removeLooseProp: () => {},
    postPooledTask: () => {},
    stockEndpointOf: () => null,
    containerAnchor: () => null,
    houseContainerKeys: () => [],
    playerWorldPos: () => null,
    playerFocusArea: () => null,
    townShortage: () => 0,
    invalidateTownJobs: () => {},
    questViewOf: () => null,
    spiritFocusOf: () => null,
    convoNodeId: () => null,
  } as unknown as ConstructionDirectorCtx;
  return { play, session, toasts, at, director: createConstructionDirector(ctx) };
}

describe("orderCraft — the second order WAITS, it is not dropped (phase 4 step 5)", () => {
  it("fills the one slot, then queues to the cap, then refuses honestly", () => {
    const { play, session, toasts, director } = harness();
    const hi = play.plan.houses[0]!.index;
    // The slot. (The host hands orderCraft the compiled goal's GLYPH.)
    expect(director.orderCraft(session, "furn.chair")).toBe(true);
    expect(play.deltas.craftJobs.get(hi)?.produces).toBe("furn.chair");
    expect(play.deltas.craftQueue.get(hi)).toBeUndefined();
    // The line, in spoken order — FIFO is the precedence contract
    // (`popQueuedCraft` shifts the head into the freed slot).
    for (const w of ["furn.bed", "furn.table", "furn.box", "furn.bin"]) {
      expect(director.orderCraft(session, w)).toBe(true);
    }
    expect(play.deltas.craftQueue.get(hi)?.map((q) => q.label)).toEqual([
      "bed", "table", "box", "bin",
    ]);
    expect(play.deltas.craftQueue.get(hi)).toHaveLength(CRAFT_QUEUE_CAP);
    // The first order still owns the slot — a later order never replaces it.
    expect(play.deltas.craftJobs.get(hi)?.produces).toBe("furn.chair");
    // Past the cap: HANDLED (true) and refused out loud, never silently lost.
    expect(director.orderCraft(session, "furn.chest")).toBe(true);
    expect(play.deltas.craftQueue.get(hi)).toHaveLength(CRAFT_QUEUE_CAP);
    expect(toasts.some((t) => t.includes("the list is full"))).toBe(true);
    expect(toasts.filter((t) => t.includes("waits its turn"))).toHaveLength(CRAFT_QUEUE_CAP);
  });

  it("the line rides the deltas — a reload keeps the player's second and third orders", () => {
    const { play, session, director } = harness();
    const hi = play.plan.houses[0]!.index;
    director.orderCraft(session, "furn.chair");
    director.orderCraft(session, "furn.bed");
    const back = createTownDeltas(JSON.parse(JSON.stringify(play.deltas.toJSON())) as SerializedTownDeltas);
    expect(back.craftJobs.get(hi)?.produces).toBe("furn.chair");
    expect(back.craftQueue.get(hi)?.map((q) => q.label)).toEqual(["bed"]);
    // The queued row is spot-less; the JOB in the slot carries the spot.
    expect(back.craftQueue.get(hi)![0]).not.toHaveProperty("spotId");
    expect(back.craftJobs.get(hi)?.spotId).toBeTruthy();
  });
});

/** A house holding a non-living room at least as big as one of its own
 *  `store` annex options — the pair the reuse rule compares (`spareRoomFor`
 *  measures the CANDIDATE's area against the standing floor). */
function reuseCase(play: ReturnType<typeof buildTownPlay>) {
  for (const house of play.plan.houses) {
    const key = `h_${house.index}`;
    const plan = houseRoomPlan(play.stage.center, house, play.deltas.get(key));
    if (plan.rooms.some((r) => r.kind === "store")) continue;
    const room = [...plan.rooms.slice(1)].sort(
      (a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h,
    )[0];
    if (!room) continue;
    const candidate = annexOptions(
      play.stage.center, house, plan,
      neighborRectsOf(play, house.index), play.deltas.get(key), "store",
    ).find((c) => (c.u1 - c.u0) * (c.v1 - c.v0) <= room.rect.w * room.rect.h);
    if (candidate) return { house, key, room, candidate };
  }
  throw new Error("no house with spare floor for a store annex — fixture assumption broke");
}

describe("stakeAnnex — AN EMPTY ROOM IS ALREADY A ROOM (phase 4 step 1)", () => {
  it("a FURNISHED house stakes the construction (the control — nothing is spare)", () => {
    const { play, session, director } = harness();
    const { house, key, candidate } = reuseCase(play);
    // Untouched fixture: every room the generator furnished holds furniture,
    // so `spareRoomFor` finds nothing and the designation is a real order.
    expect(director.stakeAnnex(session, house.index, "store", candidate)).toBe(true);
    expect(play.deltas.annexSites()).toHaveLength(1);
    // The want is UNPINNED — it rises with the room the order raises, and the
    // installers find it by kind.
    expect(play.deltas.get(key)?.programs).toEqual([{ ord: 0, room: "store" }]);
  });

  it("a BARE room takes the designation instead — a pinned row, and NO construction", () => {
    const { play, session, toasts, director } = harness();
    const { house, key, room, candidate } = reuseCase(play);
    const planOf = () => houseRoomPlan(play.stage.center, house, play.deltas.get(key));
    // Make that floor genuinely bare (the player emptied it out).
    expect(emptyRoom(play.deltas, key, planOf(), room.id, generatedIn(play, house, room)).ok).toBe(true);
    expect(generatedIn(play, house, planOf().rooms.find((r) => r.id === room.id)!)).toEqual([]);
    expect(director.stakeAnnex(session, house.index, "store", candidate)).toBe(true);
    // NO ground broken — no order of any kind was posted.
    expect(play.deltas.annexSites()).toHaveLength(0);
    expect(play.deltas.orders()).toHaveLength(0);
    // The want is PINNED to that room: a bare room derives "hall", so a
    // kind-match could never find it and the furnish sweeps would starve.
    expect(play.deltas.get(key)?.programs).toEqual([
      { ord: 0, room: "store", roomId: room.id },
    ]);
    expect(toasts.some((t) => t.includes("takes the empty room"))).toBe(true);
  });
});

describe("craftSpotOf — THE SPOT FOLLOWS THE BENCH (phase 4 step 3)", () => {
  it("benchless, the spot is the old fallback — any house can craft, the bench only speeds", () => {
    const { play, session, at, director } = harness();
    const goodDefs = play.stage.goods.map((g) => ({ key: g.good.key, slot: g.good.slot }));
    const house = play.plan.houses.find((h) => {
      const d = play.deltas.get(`h_${h.index}`);
      if (d?.annexes.some((a) => a.cluster === "workshop")) return false;
      return !houseFurniture(play.stage.center, h, goodDefs, "", d).some((p) => p.kind === "workbench");
    });
    expect(house).toBeDefined();
    at.house = house!.index;
    expect(director.orderCraft(session, "furn.chair")).toBe(true);
    expect(play.deltas.craftJobs.get(house!.index)?.spotId).toBe(`furn_${house!.index}_cupboard`);
  });

  it("with a bench standing, the spot is the CONTAINER nearest it, its own room preferred", () => {
    const { play, session, at, director } = harness();
    const house = play.plan.houses[0]!;
    const hi = house.index;
    const key = `h_${hi}`;
    at.house = hi;
    const room = [...houseRoomPlan(play.stage.center, house, play.deltas.get(key)).rooms.slice(1)]
      .sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)[0]!;
    const cx = room.rect.x + room.rect.w / 2;
    const cy = room.rect.y + room.rect.h / 2;
    play.deltas.mutate(key, (d) => {
      d.placed.push(
        { id: `furn_${hi}_p0`, kind: "workbench", x: cx, y: cy, radius: 0.7, facing: 0, openable: false, roomId: room.id },
        { id: `furn_${hi}_p1`, kind: "chest", x: cx + 0.5, y: cy, radius: 0.55, facing: 0, openable: true, roomId: room.id },
      );
    });
    expect(director.orderCraft(session, "furn.chair")).toBe(true);
    // The POSE has always been the bench; before phase 4 the SPOT keyed off
    // the annex list alone, so the inputs hauled to the kitchen cupboard while
    // the crafter stood at the bench, and the two disagreed all job long.
    expect(play.deltas.craftJobs.get(hi)?.spotId).toBe(`furn_${hi}_p1`);
  });
});

describe("orderEmpty / orderDemolish — one row, two commits (phase 4 step 2)", () => {
  it("posts the SAME designation with mode:\"empty\" and HALF the labor", () => {
    const { play, session, director } = harness();
    // A house with a room the kernel would actually take down.
    let found: { house: (typeof play.plan.houses)[number]; key: string; doomed: HouseRoom } | null = null;
    for (const house of play.plan.houses) {
      const key = `h_${house.index}`;
      const plan = houseRoomPlan(play.stage.center, house, play.deltas.get(key));
      const doomed = plan.rooms.find((r) => demolishCheck(play.deltas, key, plan, r.id).ok);
      if (doomed) { found = { house, key, doomed }; break; }
    }
    expect(found).not.toBeNull();
    const { house, key, doomed } = found!;
    const plan = houseRoomPlan(play.stage.center, house, play.deltas.get(key));
    const other = plan.rooms.find((r) => r.id !== doomed.id)!;
    expect(director.orderDemolish(session, house.index, doomed.id)).toBe(true);
    expect(director.orderEmpty(session, house.index, other.id)).toBe(true);
    const rows = play.deltas.demolitionSites();
    expect(rows).toHaveLength(2);
    const down = rows.find((r) => r.roomId === doomed!.id)!;
    const clear = rows.find((r) => r.roomId === other.id)!;
    expect(down.mode).toBeUndefined();
    expect(clear.mode).toBe("empty");
    // Carrying furniture out is HALF the work of pulling a room down.
    expect(clear.buildDays).toBe(Math.max(0.1, down.buildDays / 2));
  });

  it("the LIVING room refuses demolition and accepts emptying (walls are the only rule)", () => {
    const { play, session, toasts, director } = harness();
    const house = play.plan.houses[0]!;
    const key = `h_${house.index}`;
    const living = houseRoomPlan(play.stage.center, house, play.deltas.get(key)).rooms[0]!;
    // HANDLED either way (true) — a refusal is SPOKEN, never silent.
    expect(director.orderDemolish(session, house.index, living.id)).toBe(true);
    expect(play.deltas.demolitionSites()).toHaveLength(0);
    expect(toasts.some((t) => t.includes("can't come down"))).toBe(true);
    expect(director.orderEmpty(session, house.index, living.id)).toBe(true);
    expect(play.deltas.demolitionSites()).toHaveLength(1);
    expect(play.deltas.demolitionSites()[0]!.mode).toBe("empty");
  });
});

describe("orderBreakPiece — the piece comes apart where it stands (phase 4 step 2)", () => {
  it("un-places a PLACED row and re-mints its `furn.<kind>` stack (banked with no world)", () => {
    const { play, session, director } = harness();
    const house = play.plan.houses[0]!;
    const hi = house.index;
    const key = `h_${hi}`;
    const room = houseRoomPlan(play.stage.center, house, play.deltas.get(key)).rooms[0]!;
    play.deltas.mutate(key, (d) => {
      d.placed.push({
        id: `furn_${hi}_p0`, kind: "chair",
        x: room.rect.x + 1, y: room.rect.y + 1,
        radius: 0.22, facing: 0, openable: false, roomId: room.id,
      });
    });
    expect(director.orderBreakPiece(session, key, `furn_${hi}_p0`)).toBe(true);
    expect(play.deltas.get(key)!.placed.map((p) => p.id)).not.toContain(`furn_${hi}_p0`);
    // Headless: the stack banks rather than dropping loose — it NEVER vanishes.
    expect(play.deltas.stock["furn.chair"]).toBe(1);
  });

  it("stows a GENERATED piece — worldgen furniture mints its component lazily", () => {
    // The BEHAVIOUR is unchanged: the piece stops standing, its component lands
    // in the stock, and it never comes back on its own. What changed is HOW
    // (blueprint.ts): breaking MATERIALIZES the house first — the furniture
    // becomes a list and the piece is removed from it — instead of withholding
    // the id from a generator that still runs. The withhold was deleting the
    // BLUEPRINT SLOT along with the furniture, so a piece broken to clear a
    // doorway left no mark saying one belongs there and the room was never
    // re-furnished. A place is not a possession.
    const { play, session, director } = harness();
    const house = play.plan.houses[0]!;
    const hi = house.index;
    const key = `h_${hi}`;
    const goodDefs = play.stage.goods.map((g) => ({ key: g.good.key, slot: g.good.slot }));
    const piece = houseFurniture(play.stage.center, house, goodDefs, "", play.deltas.get(key))
      .find((p) => !p.good && p.kind === "bed")!;
    expect(piece).toBeDefined();
    expect(director.orderBreakPiece(session, key, piece.id)).toBe(true);
    expect(play.deltas.get(key)!.materialized).toBe(true);
    expect(play.deltas.stock["furn.bed"]).toBe(1);
    // It stops standing, and nothing puts it back by itself.
    expect(
      houseFurniture(play.stage.center, house, goodDefs, "", play.deltas.get(key)).map((p) => p.id),
    ).not.toContain(piece.id);
    // Every OTHER piece is still exactly where it was — materializing records
    // the house, it does not rearrange it.
    const after = houseFurniture(play.stage.center, house, goodDefs, "", play.deltas.get(key));
    for (const p of houseFurniture(play.stage.center, house, goodDefs, "", undefined)) {
      if (p.id === piece.id) continue;
      const now = after.find((q) => q.id === p.id);
      expect(now).toBeTruthy();
      expect(Math.hypot(now!.x - p.x, now!.y - p.y)).toBeLessThanOrEqual(0.05);
    }
  });

  it("nothing there to break refuses honestly, and changes nothing", () => {
    const { play, session, toasts, director } = harness();
    expect(director.orderBreakPiece(session, `h_${play.plan.houses[0]!.index}`, "furn_9_nope")).toBe(false);
    expect(toasts.some((t) => t.includes("nothing like that here"))).toBe(true);
  });

  it("DROPS the designation the broken piece stood for — but only when nothing else answers it", () => {
    const { play, session, director } = harness();
    const house = play.plan.houses[0]!;
    const hi = house.index;
    const key = `h_${hi}`;
    const plan = houseRoomPlan(play.stage.center, house, play.deltas.get(key));
    const [a, b] = [plan.rooms[0]!, plan.rooms[1]!];
    const at = (r: typeof a, dx: number) => ({ x: r.rect.x + dx, y: r.rect.y + 0.6 });
    play.deltas.mutate(key, (d) => {
      d.programs = [{ ord: 0, room: "workshop" }];
      d.placed.push(
        { id: `furn_${hi}_p0`, kind: "workbench", ...at(a, 0.9), radius: 0.7, facing: 0, openable: false, roomId: a.id },
        { id: `furn_${hi}_p1`, kind: "workbench", ...at(b, 0.9), radius: 0.7, facing: 0, openable: false, roomId: b.id },
      );
    });
    // A SECOND still-furnished workshop keeps the want standing.
    expect(director.orderBreakPiece(session, key, `furn_${hi}_p0`)).toBe(true);
    expect(play.deltas.get(key)?.programs).toEqual([{ ord: 0, room: "workshop" }]);
    // The last bench goes ⇒ nothing answers the row, so it comes off and the
    // sweeps never re-order the bench forever (the never-self-healing law).
    expect(director.orderBreakPiece(session, key, `furn_${hi}_p1`)).toBe(true);
    expect(play.deltas.get(key)?.programs).toEqual([]);
  });
});
