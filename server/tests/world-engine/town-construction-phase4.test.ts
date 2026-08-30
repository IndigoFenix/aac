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
  foundedBuildingDone,
  removeProgram,
  requestAnnex,
  type PendingDemolition,
  pileEntries,
  type QueuedCraft,
  type SerializedTownDeltas,
} from "@shared/world-engine/kernel/town/construction.js";
import { houseRoomPlan, type HouseRoom } from "@shared/world-engine/kernel/town/rooms.js";
import { BLOCK_GLYPH } from "@shared/world-engine/products.js";
import { buildTownPlay, TOWN_PLAY_STRUCTURES } from "@shared/world-engine/interaction/town/town-play.js";
import { houseFurniture } from "@shared/world-engine/kernel/town/furniture.js";
import { ROOM_GLYPH } from "@shared/world-engine/interaction/town/structure-board.js";
import { DEFAULT_ROOM_PROGRAMS } from "@shared/world-engine/kernel/town/programs.js";
import { resolveStructure, structureCosts } from "@shared/world-engine/kernel/town/structures.js";
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
import type { ContainerRecord } from "@shared/world-engine/kernel/town/containers.js";
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

  it("a COMMISSION rides the row (CraftJob.for) — the maker remembers who asked", () => {
    // 🚨 GL fix round F2. A shell designates a craft at a neighbouring household
    // and used to forget it had asked: the piece landed in that household's
    // cupboard (unwatched) or on its floor (watched), and NEITHER is reachable
    // by the shell's haul — `siteMaterialSources` sees container stacks only and
    // `mayUse` refuses another household's boxes outright. The shell's re-ask
    // then answered `"held"` (`buildingUnits(…,"anywhere")` sees the piece
    // perfectly well) and waited for a delivery nobody had scheduled, forever.
    const d = createTownDeltas();
    d.craftJobs.set(4, {
      produces: "furn.door", consumes: { block: 1 }, at: "workbench",
      label: "door", spotId: "furn_4_cupboard", agreements: [], laborS: 0,
      for: "bfurn:w_7",
    });
    const back = createTownDeltas(d.toJSON());
    expect(back.craftJobs.get(4)?.for).toBe("bfurn:w_7");
    // Absent stays absent — every pre-commission save, and every piece a house
    // makes for itself, is nobody's delivery.
    d.craftJobs.set(5, {
      produces: "furn.bed", consumes: {}, label: "bed",
      spotId: "furn_5_cupboard", agreements: [], laborS: 0,
    });
    expect(createTownDeltas(d.toJSON()).craftJobs.get(5)).not.toHaveProperty("for");
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

function harness(over: Partial<ConstructionDirectorCtx> = {}) {
  const play = established();
  const toasts: string[] = [];
  /** Which house a spoken order lands on (the host's `familyOf` answer). */
  const at = { house: null as number | null };
  const session = {
    town: play,
    townClock: 0,
    scale: REAL_SCALE, // the session default (quest-host 2185)
    containerRecords: new Map<string, ContainerRecord>(),
    wornBagIndex: new Map<string, string>(),
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
    // ⚖️ batch 2 L3/L4 — the host's two hand readings, reduced to what this
    // harness models: no jobs, no live needs and no pooled claims, so FREE is
    // exactly the shipped "no queued errand", and the pool is one hand per
    // household (the fixture's own workforce, far above any site's cap — so
    // the shared-pool split allocates every site its full crew, as before).
    handIsFree: (s: QuestSession, id: string) => !s.npcTasks?.get(id)?.length,
    townHandPool: () => ({ total: play.plan.houses.length, free: play.plan.houses.length }),
    // The seams a test needs to be REAL for its own question (the commission
    // delivery below wants an endpoint and an anchor) come in through here —
    // the stubs above stay the default so every existing case is untouched.
    ...over,
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

// ─────────────────────────────────────────────────────────────────────────
// 🚨 GL FIX ROUND (2026-08-11) — THE TWO WAYS A FINISHED PIECE GOT STRANDED
//
// Both are the same shape: something MADE the piece and nothing MOVED it.
//   F2  a piece made ON COMMISSION for a work shell stayed in the maker's
//       kitchen, invisible to the shell's haul and visible to its "have we got
//       one" test — so the shell waited on a delivery nobody had scheduled.
//   F4  a piece a house made FOR ITSELF landed on its own floor, where the
//       work list calls it a `move` — and the install sweep only ever acted on
//       `install`, leaving the 12 s hand-gated re-flow as its one route.
// ─────────────────────────────────────────────────────────────────────────

/** A headless world with ONE body loaded — enough for the craft sweeps, which
 *  gate on "is the crafter/placer there" and nothing else. */
function worldWith(bodies: Record<string, { x: number; y: number }>, objects: Record<string, unknown> = {}) {
  return {
    state: { avatars: { ...bodies }, objects: { ...objects }, spec: { objects: [] } },
    npcRadiusOf: () => 0.3,
    npcErrandActive: () => false,
    removeObject: () => {},
    setDragZones: () => {},
  } as never;
}

describe("a COMMISSIONED craft DELIVERS — it never becomes the maker's floor clutter (F2)", () => {
  it("posts the haul to the commissioner instead of dropping the piece where it was made", () => {
    const posted: Array<{ goods: unknown }> = [];
    const anchor = { x: 5, y: 5 };
    let harnessSession: QuestSession;
    const { play, session, director } = harness({
      avatarIdOf: (cid: string) => cid,
      buildingUnits: () => 0,
      containerAnchor: () => anchor,
      // The commissioner's delivery pile resolves; the maker's own spot does
      // too (the haul needs both ends to exist).
      stockEndpointOf: (_s: QuestSession, id: string) =>
        ({ id, kind: "site", at: anchor, stack: {}, owner: null }) as never,
      itemLocOf: () => (loc: { kind: string; id?: string }) =>
        loc.kind === "container" && loc.id
          ? { id: loc.id, kind: "container", at: anchor, stack: harnessSession.containerRecords.get(loc.id)?.stock ?? {}, owner: null }
          : null,
      postPooledTask: (_s: QuestSession, goal: { goods?: unknown }) => { posted.push({ goods: goal.goods }); },
      dropFromStack: () => { throw new Error("a commissioned piece must NOT be dropped on the maker's floor"); },
    });
    harnessSession = session;
    Object.assign(session as object, {
      npcTasks: new Map<string, unknown[]>(),
      needPoseShow: new Map<string, unknown>(),
      townParks: new Map<string, unknown>(),
    });
    const hi = play.plan.houses[0]!.index;
    director.setWorld(worldWith({ [`resident_${hi}_0`]: { x: 5, y: 5 } }));

    const spotId = `furn_${hi}_cupboard`;
    session.containerRecords.set(spotId, { mount: "standing", stock: { block: 2 } });
    play.deltas.craftJobs.set(hi, {
      produces: "furn.door", consumes: { block: 2 }, at: "workbench", label: "door",
      spotId, agreements: [], laborS: 1, laborStart: 0, for: "bfurn:w_3",
    });
    session.townClock = 10; // the labour clock has run out

    director.stepConstructionHousekeeping(session, () => false);

    // THE PIECE WAS MADE…
    expect(play.deltas.craftJobs.get(hi)).toBeUndefined();
    // …AND SENT. One haul, spot → the commissioner's pile, with a pooled task
    // so ANY neighbour may carry it (the shell's own `inbound` test then reads
    // this agreement and never designates a second).
    const out = session.transfers.active().filter((a) => a.to === "bfurn:w_3");
    expect(out).toHaveLength(1);
    expect(out[0]!.from).toBe(spotId);
    expect(out[0]!.goods).toEqual({ "furn.door": 1 });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.goods).toEqual({ "furn.door": 1 });
  });

  it("an UNCOMMISSIONED craft is untouched — it arrives as a thing where it was made", () => {
    // The item law (2026-07-28) is not weakened by the delivery leg: a house
    // that made something for itself still gets a prop on its floor.
    const drops: string[] = [];
    const anchor = { x: 5, y: 5 };
    let harnessSession: QuestSession;
    const { play, session, director } = harness({
      avatarIdOf: (cid: string) => cid,
      buildingUnits: () => 0,
      containerAnchor: () => anchor,
      stockEndpointOf: (_s: QuestSession, id: string) =>
        ({ id, kind: "container", at: anchor, stack: {}, owner: null }) as never,
      itemLocOf: () => (loc: { kind: string; id?: string }) =>
        loc.kind === "container" && loc.id
          ? { id: loc.id, kind: "container", at: anchor, stack: harnessSession.containerRecords.get(loc.id)?.stock ?? {}, owner: null }
          : null,
      dropFromStack: (_s: QuestSession, _stack: Record<string, number>, glyph: string) => {
        drops.push(glyph);
        return "small:x";
      },
    });
    harnessSession = session;
    Object.assign(session as object, {
      npcTasks: new Map<string, unknown[]>(),
      needPoseShow: new Map<string, unknown>(),
      townParks: new Map<string, unknown>(),
    });
    const hi = play.plan.houses[0]!.index;
    director.setWorld(worldWith({ [`resident_${hi}_0`]: { x: 5, y: 5 } }));
    const spotId = `furn_${hi}_cupboard`;
    session.containerRecords.set(spotId, { mount: "standing", stock: { block: 2 } });
    play.deltas.craftJobs.set(hi, {
      produces: "furn.door", consumes: { block: 2 }, at: "workbench", label: "door",
      spotId, agreements: [], laborS: 1, laborStart: 0,
    });
    session.townClock = 10;
    session.houseShown.add(hi);

    director.stepConstructionHousekeeping(session, (h) => h === hi);

    expect(drops).toEqual(["furn.door"]);
    expect(session.transfers.active().filter((a) => a.to.startsWith("bfurn:"))).toHaveLength(0);
  });
});

describe("a PLAYER-ORDERED build carries the RESOLVER's bill (F1)", () => {
  it("executeBuildOrder founds with structureCosts(spec), and the plot WAITS on it", () => {
    // 🚨 The seam the pure staging suite could not reach: `executeBuildOrder`
    // handed `foundBuilding` the row's EXTRAS map, which is `{}` for every
    // catalog structure since the phase-6 split. `stagingMissing` then answered
    // {} on the very next line, the plot staged the same tick, no haul was ever
    // posted and the walls rose out of nothing — the frontier farm finished
    // with the yard's 14 wood and 6 stone untouched (dx-frontier-farm).
    const { play, session, director } = harness({ buildingUnits: () => 0 });
    const spec = resolveStructure(TOWN_PLAY_STRUCTURES, "house")!;
    expect(spec.costs[BLOCK_GLYPH]).toBeUndefined(); // the trap is real
    const ctx = director.buildContext(session)!;
    const candidate = director.buildCandidates(ctx, spec)[0]!;
    const b = director.executeBuildOrder(session, spec, candidate, null)!;
    expect(b).not.toBeNull();
    expect(b.costs).toEqual(structureCosts(spec));
    expect(b.costs![BLOCK_GLYPH]).toBeGreaterThan(0);
    expect(b.costs).not.toEqual(spec.costs);
    // …and the designation is honest: nothing staged, nothing paid, no walls.
    expect(b.laborStartDay).toBeUndefined();
    expect(foundedBuildingDone(b, 1_000_000)).toBe(false);
  });
});

describe("the craft gather obeys the OBSERVATION LAW (F3)", () => {
  /** A house with a craft job mid-GATHER and one reachable stack of blocks —
   *  the only knob is whether the house is on screen. */
  function gathering(shown: boolean) {
    const moved: string[] = [];
    const anchor = { x: 0, y: 0 };
    const { play, session, director } = harness({
      avatarIdOf: (cid: string) => cid,
      buildingUnits: () => 0,
      containerAnchor: () => anchor,
      stockEndpointOf: (_s: QuestSession, id: string) =>
        ({ id, kind: "container", at: anchor, stack: {}, owner: null }) as never,
      bumpStockEpoch: () => { moved.push("epoch"); },
      fellIfConsumed: () => {},
      parkTown: () => {},
      townParked: () => false,
    });
    Object.assign(session as object, {
      npcTasks: new Map<string, unknown[]>(),
      needPoseShow: new Map<string, unknown>(),
      townParks: new Map<string, unknown>(),
    });
    const hi = play.plan.houses[0]!.index;
    // THE FAMILY ARE OUT — nobody is loaded to carry anything. Shown or not,
    // the bill is identical; only the arm differs.
    director.setWorld(worldWith({}));
    session.containerRecords.set("town:yard", { mount: "standing", stock: { block: 9 }, owner: null });
    const spotId = `furn_${hi}_cupboard`;
    session.containerRecords.set(spotId, { mount: "standing", stock: {} });
    play.deltas.craftJobs.set(hi, {
      produces: "furn.door", consumes: { block: 2 }, at: "workbench", label: "door",
      spotId, agreements: [], laborS: 0,
    });
    if (shown) session.houseShown.add(hi);
    director.stepConstructionHousekeeping(session, () => shown);
    return { yard: session.containerRecords.get("town:yard")!.stock!, spot: session.containerRecords.get(spotId)!.stock! };
  }

  it("a WATCHED house never teleports its materials into the cupboard", () => {
    // 🚨 The gather posted ONE visible haul and ran the INSTANT TWIN for every
    // other draw — `spot[g] += c` straight into the cupboard — whether or not
    // the house was on screen. The site piles have said `obs ? postSiteHauls :
    // twinStagePile` since phase 2; the bench never got the same law, so the
    // player watched wood appear inside a cupboard nobody had walked to.
    const { yard, spot } = gathering(true);
    expect(yard).toEqual({ block: 9 }); // untouched
    expect(spot).toEqual({}); // nothing landed
  });

  it("an UNWATCHED house still draws instantly — the abstract twin is unchanged", () => {
    const { yard, spot } = gathering(false);
    expect(yard.block).toBe(7);
    expect(spot).toEqual({ block: 2 });
  });
});

describe("a piece LYING ON THE FLOOR of its own house is installable (F4)", () => {
  it("the furnish sweep stands it on its blueprint slot — it does not wait for the re-flow", () => {
    // 🚨 The work list calls a loose prop inside the building a `move`
    // (`reconcileFurnishing` cannot tell a prop from a standing chest), and the
    // install sweep only ever picked `install` — which needs a unit STORED, and
    // the arrival of a watched craft is a prop BY DEFINITION. So the only route
    // left was `stepBlueprintReflow`: one carry per building per 12 s, gated on
    // a free pair of hands, competing with every other re-flow in the house.
    // A workbench a family had just made lay on its own kitchen floor for the
    // whole run, the house stayed benchless, and the bootstrap made another
    // (dx-doll-bench, 2026-08-11). `handlePlaceOrder` has taken a loose prop as
    // its source since the watched-craft fix; only this filter kept it out.
    const placed: Array<{ kind: unknown; spot: unknown }> = [];
    const PROP = "small:bench_1";
    const { play, session, director } = harness({
      avatarIdOf: (cid: string) => cid,
      buildingUnits: () => 0,
      containerAnchor: () => ({ x: 0, y: 0 }),
      handlePlaceOrder: (
        _s: QuestSession,
        _cid: string,
        goal: { item: { match: { kind: string } } },
        opts: { spot?: unknown },
      ) => {
        placed.push({ kind: goal.item.match.kind, spot: opts?.spot });
        return "placed";
      },
    });
    // A BARE ROOM ORDERED TO BE A WORKSHOP — the drawing then has a place for a
    // bench, and a floor with room to stand one on (an untouched living room is
    // full, and a want with nowhere legal to go is `blocked`, not a `move`).
    const { house, key, room } = reuseCase(play);
    const hi = house.index;
    expect(
      emptyRoom(
        play.deltas, key,
        houseRoomPlan(play.stage.center, house, play.deltas.get(key)),
        room.id, generatedIn(play, house, room),
      ).ok,
    ).toBe(true);
    play.deltas.mutate(key, (d) => { d.programs = [{ ord: 0, room: "workshop", roomId: room.id }]; });
    // …and the bench the household made is LYING ON THAT FLOOR.
    const propAt = { x: room.rect.x + room.rect.w / 2, y: room.rect.y + room.rect.h / 2 };
    Object.assign(session as object, {
      npcTasks: new Map<string, unknown[]>(),
      needPoseShow: new Map<string, unknown>(),
      townParks: new Map<string, unknown>(),
    });
    session.containerRecords.set(PROP, { mount: "loose", entityId: "e_bench", glyph: "furn.workbench" });
    director.setWorld(
      worldWith({ [`resident_${hi}_0`]: { ...propAt } }, { [PROP]: { ...propAt } }),
    );

    director.stepConstructionHousekeeping(session, () => false);

    // THE BENCH IS STOOD UP — by a resident's own errand, onto the mark the
    // drawing has been holding for it. (Before the fix the work list said
    // `move`, the sweep asked only for `install`, and nothing happened.)
    expect(placed).toHaveLength(1);
    expect(placed[0]!.kind).toBe("workbench");
    expect(placed[0]!.spot).toBeTruthy(); // the blueprint's slot, not a fresh search
  });
});

describe("the re-flow's pace is a HAND COUNT, not a clock (scope-unification ⑥)", () => {
  /**
   * `REFLOW_GAP_S = 12` is gone. What paced the furniture-carry sweep was a
   * per-building timer — one carry per twelve seconds, whoever was free and
   * however many of them; the chapter's first draft called it "a timer
   * standing in for a hand count". The sweep now asks the SAME census the
   * build sites read (`townHandPool` → `allocateHands`), so these three are
   * the whole of the new law:
   *
   *   · the town's free pool is the gate (no hands ⇒ no carry, ever),
   *   · a piece already being carried is CLAIMED (a second free hand is never
   *     sent after the same chest — the timer's other job, done honestly),
   *   · and nothing waits on a clock: the moment the carrier stops walking,
   *     the next sweep may send the next one.
   */
  const PROP = "small:bench_1";

  /** A house with a bare workshop-programmed room and a bench lying on its
   *  floor — the F4 fixture, with the install sweep REFUSING so the carry is
   *  the re-flow's to make. `members` bodies stand in the room; the first
   *  `free` of them have empty errand queues, the rest are already busy. */
  function adriftBench(opts: { free: number; members: number; pool?: number }) {
    const errands: Array<{ npcId: string; points: Array<{ x: number; y: number }> }> = [];
    const { play, session, director } = harness({
      avatarIdOf: (cid: string) => cid,
      buildingUnits: () => 0,
      containerAnchor: () => ({ x: 0, y: 0 }),
      // The install sweep declines, so the piece stays adrift and the re-flow
      // owns it. (Its own claim is pinned by the F4 case above.)
      handlePlaceOrder: () => "no",
      townParked: () => false,
      parkTown: () => {},
      ...(opts.pool === undefined
        ? {}
        : { townHandPool: () => ({ total: opts.pool, free: opts.pool }) }),
      enqueueNpcErrand: (
        s: QuestSession,
        npcId: string,
        errand: { points: Array<{ x: number; y: number }> },
      ) => {
        errands.push({ npcId, points: errand.points });
        // The host's own two lines — the queue is what `handIsFree` reads.
        const q = s.npcTasks.get(npcId) ?? [];
        q.push(errand as never);
        s.npcTasks.set(npcId, q);
      },
    });
    const { house, key, room } = reuseCase(play);
    const hi = house.index;
    expect(
      emptyRoom(
        play.deltas, key,
        houseRoomPlan(play.stage.center, house, play.deltas.get(key)),
        room.id, generatedIn(play, house, room),
      ).ok,
    ).toBe(true);
    play.deltas.mutate(key, (d) => { d.programs = [{ ord: 0, room: "workshop", roomId: room.id }]; });
    const propAt = { x: room.rect.x + room.rect.w / 2, y: room.rect.y + room.rect.h / 2 };
    const npcTasks = new Map<string, unknown[]>();
    const bodies: Record<string, { x: number; y: number }> = {};
    for (let m = 0; m < opts.members; m++) {
      const id = `resident_${hi}_${m}`;
      bodies[id] = { ...propAt };
      if (m >= opts.free) npcTasks.set(id, [{}]); // already holding an errand
    }
    Object.assign(session as object, {
      npcTasks,
      needStep: new Map<string, unknown>(),
      lastDrive: new Map<string, unknown>(),
      needPoseShow: new Map<string, unknown>(),
      townParks: new Map<string, unknown>(),
    });
    session.containerRecords.set(PROP, { mount: "loose", entityId: "e_bench", glyph: "furn.workbench" });
    director.setWorld(worldWith(bodies, { [PROP]: { ...propAt } }));
    /** One sweep, one tick of the town clock (the ask list closes per tick). */
    const sweep = (n = 1) => {
      for (let i = 0; i < n; i++) {
        (session as unknown as { townClock: number }).townClock += 0.05;
        director.stepConstructionHousekeeping(session, () => false);
      }
    };
    return { play, session, hi, errands, npcTasks, sweep };
  }

  it("ONE piece, TWO free hands, many sweeps — exactly ONE carry (no stampede)", () => {
    const { errands, sweep } = adriftBench({ free: 2, members: 2 });
    sweep(40); // two seconds of ticks — the old gate's whole window and more
    // The second free member is NEVER sent after the bench the first one is
    // already walking to: the CLAIM is per piece, so the only bound the timer
    // was really providing survives it.
    expect(errands).toHaveLength(1);
    // …and the OTHER member was never sent anywhere.
    expect(errands.map((e) => e.npcId)).toEqual([errands[0]!.npcId]);
  });

  it("NO free hands ⇒ NO carry, however long the sweep runs", () => {
    const { errands, sweep } = adriftBench({ free: 0, members: 2 });
    sweep(40);
    expect(errands).toHaveLength(0);
  });

  it("the TOWN's pool is the gate — a free body in the house carries nothing when the town has no hand to spare", () => {
    // The census, not the household: `allocateHands([cap], 0)` is [0]. This is
    // the line the timer could never draw — a 12 s metronome sent a carry out
    // whether or not the town had anyone to spare.
    const { errands, sweep } = adriftBench({ free: 2, members: 2, pool: 0 });
    sweep(40);
    expect(errands).toHaveLength(0);
  });

  it("nothing waits on a clock — the carrier stops walking and the next sweep sends the next carry", () => {
    const { errands, npcTasks, sweep, hi, session } = adriftBench({ free: 1, members: 1 });
    sweep(4);
    expect(errands).toHaveLength(1);
    const firstAt = (session as unknown as { townClock: number }).townClock;
    // The errand died (re-tasked, evicted — `recoverDroppedCarries`'s case) and
    // the bench is adrift again. Under the timer this house could not have
    // tried again for twelve seconds.
    npcTasks.set(`resident_${hi}_0`, []);
    sweep(2);
    expect(errands).toHaveLength(2);
    expect((session as unknown as { townClock: number }).townClock - firstAt).toBeLessThan(12);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// #43 HOMESTEAD TREADMILL (homestead-defect-round.md ② + ④) — the scarcity
// laws that stop porters circling the yard crate: ONE open refine row per
// (head, scope) with a batch-capped bill, the release arm's receive-hold and
// co-located-ledger rules, and the third refusal state (dead < IMPOSSIBLE <
// slow) for a spoken structure the whole reachable world cannot supply.
// ─────────────────────────────────────────────────────────────────────────

import {
  REFINE_BATCH_UNITS,
} from "@shared/world-engine/interaction/quest/construction-director.js";

/** A harness whose session can actually SUPPLY materials: one unowned box
 *  of raw stock, anchored at the origin, visible to `siteMaterialSources`
 *  (the stubs' nulls otherwise hide every stack). */
function suppliedHarness(stock: Record<string, number>) {
  const box: ContainerRecord = { stock } as unknown as ContainerRecord;
  const h = harness({
    containerAnchor: (_s: QuestSession, id: string) =>
      id === "box_test" ? { x: 0, y: 0 } : null,
  });
  (h.session as unknown as { containerRecords: Map<string, ContainerRecord> })
    .containerRecords.set("box_test", box);
  (h.session as unknown as { meta: { syntax: string } }).meta = { syntax: "b" };
  return { ...h, box };
}

describe("#43 ②c/④ — ensureRefineOrders: one open row, batch-capped", () => {
  it("caps a fresh 120-block bill at REFINE_BATCH_UNITS and never fragments while a row is open", () => {
    const { play, session, director } = suppliedHarness({ wood: 500 });
    const r1 = director.ensureRefineOrders(session, { block: 120 });
    expect(r1.rest).toEqual({});
    expect(r1.milling).toBe(120);
    const rows = play.deltas.refineOrders();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(REFINE_BATCH_UNITS);
    // The measured disease: a second sweep used to post the REMAINDER as a
    // fresh supply-sized row (four concurrent rows splitting one bill, their
    // piles all on the yard spot). While a row is open, nothing more posts.
    const r2 = director.ensureRefineOrders(session, { block: 120 });
    expect(r2.milling).toBe(120);
    expect(play.deltas.refineOrders()).toHaveLength(1);
  });

  it("the remainder re-triggers AFTER the open row commits — sequential batches, never siblings", () => {
    const { play, session, director } = suppliedHarness({ wood: 500 });
    director.ensureRefineOrders(session, { block: 120 });
    const first = play.deltas.refineOrders()[0]!;
    play.deltas.removeOrder(first.ord); // the commit's own retirement
    director.ensureRefineOrders(session, { block: 120 - REFINE_BATCH_UNITS });
    const rows = play.deltas.refineOrders();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(REFINE_BATCH_UNITS);
    expect(rows[0]!.ord).not.toBe(first.ord); // ordinals never reused
  });
});

describe("#43 ②a — infeasibleBillHeads: the state between dead and slow", () => {
  it("names need and have when the whole chain cannot reach the bill", () => {
    const { session, director } = suppliedHarness({ wood: 100 });
    const sources = director.siteMaterialSources(session, { x: 0, y: 0 });
    const short = director.infeasibleBillHeads(session, { block: 120 }, sources);
    // 100 wood at the shipped 2:1 mills 50 blocks — impossible, and SAID so
    // with both numbers (the refusal's actionability law).
    expect(short).toEqual({ block: { need: 120, have: 50 } });
  });

  it("stays quiet when supply covers the bill (the control)", () => {
    const { session, director } = suppliedHarness({ wood: 300 });
    const sources = director.siteMaterialSources(session, { x: 0, y: 0 });
    expect(director.infeasibleBillHeads(session, { block: 120 }, sources)).toEqual({});
  });
});

describe("#43 ②b — releaseStarvedPile: co-located ledger moves + the receive-hold", () => {
  /** Two unstaged refine rows on one harness: the donor holding a heap, the
   *  recipient a gap the heap covers WHOLE — the release's precondition. The
   *  endpoint map is mutable so the ctx override can be threaded BEFORE the
   *  ords exist. */
  function releasePair(donorAt: { x: number; y: number }, rcptAt: { x: number; y: number }) {
    const endpoints = new Map<string, { at: { x: number; y: number }; stack: Record<string, number> }>();
    const h = harness({
      stockEndpointOf: (_s: QuestSession, id: string) => endpoints.get(id) ?? null,
      // The ledger arm's wake — a host service the default stubs don't carry.
      bumpStockEpoch: () => {},
    });
    expect(h.play.deltas.refineOrders()).toHaveLength(0); // clean slate, or the pins lie
    const donor = h.play.deltas.postRefineOrder({
      produces: "block.material_wood", count: 30, costs: { wood: 60 },
      pile: { wood: 20 }, at: donorAt, startedDay: 0, buildDays: 1,
    });
    const rcpt = h.play.deltas.postRefineOrder({
      produces: "block.material_wood", count: 10, costs: { wood: 20 },
      pile: {}, at: rcptAt, startedDay: 0, buildDays: 1,
    });
    // A third mouth the RECIPIENT could feed after receiving (its 20-wood
    // gap = exactly the heap) — what makes the receive-hold pin a pin on the
    // HOLD and not on feasibility. Posted last, so the tie-break (progress,
    // then ord ascending) always picks `rcpt` for the first release.
    const third = h.play.deltas.postRefineOrder({
      produces: "block.material_wood", count: 10, costs: { wood: 20 },
      pile: {}, at: rcptAt, startedDay: 0, buildDays: 1,
    });
    endpoints.set(`orderpile:${donor.ord}`, { at: donorAt, stack: donor.pile! });
    endpoints.set(`orderpile:${rcpt.ord}`, {
      at: rcptAt,
      stack: (rcpt as { pile?: Record<string, number> }).pile ?? {},
    });
    endpoints.set(`orderpile:${third.ord}`, {
      at: rcptAt,
      stack: (third as { pile?: Record<string, number> }).pile ?? {},
    });
    return { ...h, donor, rcpt, third, endpoints };
  }

  it("piles on the same spot move as ARITHMETIC — heap lands, no agreement, no toast", () => {
    const at = { x: 5, y: 5 };
    const { session, play, toasts, director, donor, rcpt } = releasePair(at, {
      x: at.x + 1,
      y: at.y + 1,
    });
    const before = play.deltas.transfers.all().length;
    expect(
      director.releaseStarvedPile(session, `orderpile:${donor.ord}`, "issuer", "haul"),
    ).toBe(true);
    // The heap changed COLUMN, not place: recipient's pile holds it, the
    // donor's is empty, and nothing was posted or announced.
    expect((rcpt as { pile?: Record<string, number> }).pile).toEqual({ wood: 20 });
    expect(Object.values(donor.pile ?? {}).reduce((s, n) => s + n, 0)).toBe(0);
    expect(play.deltas.transfers.all().length).toBe(before);
    expect(toasts.some((t) => t.includes("🔁"))).toBe(false);
  });

  it("a pile that just RECEIVED may not donate until the hold lapses", () => {
    const at = { x: 5, y: 5 };
    const pair = releasePair(at, { x: at.x + 1, y: at.y + 1 });
    const { session, director, donor, rcpt } = pair;
    director.releaseStarvedPile(session, `orderpile:${donor.ord}`, "issuer", "haul");
    // `third`'s gap is exactly the heap the recipient now holds — without
    // the hold this donate would fire at once, and the old code shuttled
    // heaps exactly this way every 20 s gate.
    expect(
      director.releaseStarvedPile(session, `orderpile:${rcpt.ord}`, "issuer", "haul"),
    ).toBe(false);
    // Past the hold the same call releases — the refusal above was the hold,
    // not some other precondition.
    (session as unknown as { taskClock: number }).taskClock +=
      0.5 * REAL_SCALE.dayLengthS + 1;
    expect(
      director.releaseStarvedPile(session, `orderpile:${rcpt.ord}`, "issuer", "haul"),
    ).toBe(true);
  });

  it("far-apart piles still WALK the release — an agreement posts and the 🔁 line speaks", () => {
    const { session, play, toasts, director, donor } = releasePair(
      { x: 0, y: 0 },
      { x: 60, y: 0 },
    );
    expect(
      director.releaseStarvedPile(session, `orderpile:${donor.ord}`, "issuer", "haul"),
    ).toBe(true);
    expect(
      play.deltas.transfers.all().some((a) => a.from === `orderpile:${donor.ord}`),
    ).toBe(true);
    expect(toasts.some((t) => t.includes("🔁"))).toBe(true);
  });
});

// ═══ #44 — RENDERED PILES: the one emitter shape ═══
// Every site/lot pile row list comes off `pileEntries`, so the drawn goods
// can never disagree with the ledger that is their whole truth.
describe("#44 pileEntries (rendered piles)", () => {
  it("is glyph-sorted, zero-dropped, and deterministic", () => {
    expect(pileEntries({ wood: 3, "block.material_wood": 2, stone: 0 })).toEqual([
      { glyph: "block.material_wood", n: 2 },
      { glyph: "wood", n: 3 },
    ]);
    expect(pileEntries({})).toEqual([]);
    expect(pileEntries(undefined)).toEqual([]);
  });
});

// ═══ #44 C — FOLDED REGION RECORDS JOIN THE SUPPLY ═══
// The ① ruling's law revision at the decision layer: a folded stand counts
// toward every starved path's arithmetic (siteMaterialSources → the
// infeasibility refusal), with the boundary shelf + standing stock as the
// COUNTING stack. Movement stays endpoint-shaped — pinned live in the
// probe arcs (22 walked hauls off wild:area:grove, record 459→363).
describe("#44 region records in siteMaterialSources", () => {
  async function groveRecord(woodTarget: number) {
    const { condenseWildArea, wildAreaStock } = await import(
      "@shared/world-engine/interaction/quest/wild-area.js"
    );
    const { makeFeature } = await import(
      "@shared/world-engine/interaction/quest/wilderness.js"
    );
    let s = 7;
    const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    const features = [];
    let wood = 0;
    for (let i = 0; wood < woodTarget && i < 200; i++) {
      const f = makeFeature(`wild:oak_g.${i}`, "oak", { x: 150 + rand() * 20, y: 60 + rand() * 20 }, rand);
      wood += f.stock.wood ?? 0;
      features.push(f);
    }
    const rec = condenseWildArea({
      features, now: 0, area: { x: 150, y: 60, w: 30, h: 30 }, seed: 7, key: "grove",
    });
    return { rec, wood: wildAreaStock(rec).wood ?? 0 };
  }

  it("a folded grove joins the source walk and WIDENS the #43 refusal", async () => {
    const { session, director } = suppliedHarness({ wood: 100 });
    const { rec, wood } = await groveRecord(200);
    (session as unknown as { areaRecords: Map<string, unknown> }).areaRecords =
      new Map([["grove", rec]]);
    (session as unknown as { partnerStock: Record<string, Record<string, number>> }).partnerStock = {};
    const sources = director.siteMaterialSources(session, { x: 0, y: 0 });
    const grove = sources.find((src: { id: string }) => src.id === "wild:area:grove");
    expect(grove).toBeDefined();
    expect(grove!.stack.wood).toBe(wood); // standing stock IS the counting stack
    // 100 local wood alone mills 50 — the pinned IMPOSSIBLE refusal above.
    // With the grove the chain covers 120 whole blocks: the refusal widens
    // AUTOMATICALLY, because sources are a parameter.
    expect(
      director.infeasibleBillHeads(session, { block: 120 }, sources),
    ).toEqual({});
  });

  it("the shelf's cut goods count WITH the standing stock (one source, both halves)", async () => {
    const { session, director } = suppliedHarness({ wood: 100 });
    const { rec, wood } = await groveRecord(60);
    (session as unknown as { areaRecords: Map<string, unknown> }).areaRecords =
      new Map([["grove", rec]]);
    (session as unknown as { partnerStock: Record<string, Record<string, number>> }).partnerStock = {
      "wild:area:grove": { wood: 9 },
    };
    const sources = director.siteMaterialSources(session, { x: 0, y: 0 });
    const grove = sources.find((src: { id: string }) => src.id === "wild:area:grove");
    expect(grove!.stack.wood).toBe(wood + 9);
  });

  it("a session with no record map simply has no regions (harness truth)", () => {
    const { session, director } = suppliedHarness({ wood: 100 });
    const sources = director.siteMaterialSources(session, { x: 0, y: 0 });
    expect(sources.every((src: { id: string }) => !src.id.startsWith("wild:area:"))).toBe(true);
  });
});
