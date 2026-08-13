// CONSTRUCTION PHASE 5, STEP 3 — THE MASONRY (construction-phase5-plan.md).
//
// Stone has refined into blocks since phase 3, but it did so at a CARPENTER's
// bench, because `refineSpotOf` knew exactly one work type. Step 3 moves the
// routing onto the material: the CATALOGUE says where a raw is worked
// (products.ts `refinesTo.at` — wood at the "workshop", stone at the
// "masonry"), a `masonry` building exists to be that place, and a stonecutter
// standing in a room makes that room one.
//
// The load-bearing law under all of it is stations.ts:422 — `at` NEVER GATES.
// A masonry makes cutting stone FASTER and gives it somewhere to happen; a
// town without one still cuts its stone, exactly where it always did. Every
// routing assertion below is paired with the no-gate assertion, because a
// routing rule that quietly became a requirement is the regression that would
// strand a stone-rich, carpenter-less town with nothing to build from.
//
// No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  buildingKindOf,
  DEFAULT_ROOM_PROGRAMS,
  DEFAULT_STRUCTURE_PROGRAMS,
  roomKindOf,
  roomProgramMet,
  roomProgramOf,
  roomKindDisplayGlyph,
} from "@shared/world-engine/kernel/town/programs.js";
import {
  resolveStructure,
  structureCosts,
  structureDisplayGlyph,
} from "@shared/world-engine/kernel/town/structures.js";
import {
  CLUSTERS,
  FURNITURE_ITEMS,
  nextCraftKind,
  STATION_PROPERTIES,
  workProgram,
  WORK_PROGRAMS,
} from "@shared/world-engine/kernel/town/stations.js";
import { buildTownPlay, TOWN_PLAY_STRUCTURES } from "@shared/world-engine/interaction/town/town-play.js";
import { workDoorstep } from "@shared/world-engine/kernel/town/goods.js";
import { TOWN_YARD_EP } from "@shared/world-engine/kernel/town/construction.js";
import { rawsForRefined, refinedGlyphOf } from "@shared/world-engine/products.js";
import { placeBuilderNouns } from "@shared/world-engine/interaction/intent/builder-surface.js";
import { canResolveGlyph } from "@shared/glyph-compositor.js";
import { getVocabularyItem } from "@shared/glyph-registry.js";
import { resolveEmoji } from "@shared/emoji-registry.js";
import {
  createConstructionDirector,
  STOREHOUSE_RAW_PAR,
  type ConstructionDirectorCtx,
} from "@shared/world-engine/interaction/quest/construction-director.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import type { TownWork } from "@shared/world-engine/kernel/town/plan.js";
import { REAL_SCALE } from "@shared/world-engine/scale.js";

// ─────────────────────────────────────────────────────────────────────────
// THE VOCABULARY — the masonry as a place, in both directions
// ─────────────────────────────────────────────────────────────────────────

describe("the stonecutter makes a masonry (programs, both directions)", () => {
  it("BACKWARD: a standing stonecutter derives a masonry, which derives a masonry building", () => {
    // Nothing declares "this is a masonry". It is one because of what stands
    // in it — the same rule that makes an anvil's room a forge.
    expect(roomKindOf(["stonecutter"])).toBe("masonry");
    expect(buildingKindOf(["masonry"])).toBe("masonry");
  });

  it("BACKWARD: the bench claims its floor even in a FURNISHED work hall", () => {
    // The real case, and the reason the row outranks `living`: WORK_STATIONS
    // already puts a counter (a table), a chair's worth of hall furniture and
    // a barrel in every work building. Filed below `living` the table would
    // claim the room and the building would never derive as itself.
    expect(roomKindOf(["table", "chair", "barrel", "stonecutter"])).toBe("masonry");
    expect(buildingKindOf([roomKindOf(["table", "chair", "barrel", "stonecutter"])])).toBe("masonry");
  });

  it("FORWARD: the masonry program is MET by its own bench and by nothing else", () => {
    expect(roomProgramMet(roomProgramOf("masonry")!, ["stonecutter"])).toBe(true);
    expect(roomProgramMet(roomProgramOf("masonry")!, [])).toBe(false);
    expect(roomProgramMet(roomProgramOf("masonry")!, ["workbench", "anvil"])).toBe(false);
  });

  it("precedence: the carpenter's bench still outranks the mason's", () => {
    // The forge's precedent, applied: a floor holding BOTH is a carpenter's
    // room that happens to keep a slab. This is also the regression guard —
    // adding a kind must never change what existing furniture derives.
    expect(roomKindOf(["workbench", "stonecutter"])).toBe("workshop");
    expect(roomKindOf(["bed"])).toBe("bedroom");
    expect(roomKindOf(["anvil"])).toBe("forge");
    expect(roomKindOf(["table", "chair"])).toBe("living");
    expect(buildingKindOf(["living", "bedroom", "kitchen", "bath"])).toBe("house");
  });

  it("the room row and the structure row agree on their one symbol", () => {
    const room = DEFAULT_ROOM_PROGRAMS.find((d) => d.kind === "masonry")!;
    const building = DEFAULT_STRUCTURE_PROGRAMS.find((d) => d.type === "masonry")!;
    expect(room.symbol).toBe("stonecutter");
    expect(building.symbol).toBe("stonecutter");
    // And both compose to something the AAC compositor can actually draw —
    // the guard that keeps a plate from framing a ❓.
    expect(roomKindDisplayGlyph("masonry")).toBe("room(stonecutter)");
    expect(canResolveGlyph("room(stonecutter)")).toBe(true);
    expect(canResolveGlyph("building(stonecutter)")).toBe(true);
    const item = getVocabularyItem("stonecutter");
    expect(!!item?.imagePath || !!item?.emoji || !!resolveEmoji("stonecutter")).toBe(true);
  });

  it("the builder offers ONE masonry button, and it is the building's", () => {
    // Room kind and building type share the word (the `workshop` precedent),
    // and `placeBuilderNouns` keeps the first entry per word with buildings
    // first — so the single button draws the building framing, which is what
    // a player means by "masonry".
    const nouns = placeBuilderNouns().filter((n) => n.symbol === "masonry");
    expect(nouns).toHaveLength(1);
    expect(nouns[0]!.glyph).toBe("building(stonecutter)");
  });

  it("the bench is an APPLIANCE, and it is NOT an item the economy stocks", () => {
    // `appliance` is what earns it the front-approached reach contract — a
    // slab is worked from the side you stand at. And like the anvil, the loom,
    // the altar and the shelf, it arrives WITH its building (StructureSpec
    // .stations), never through the craft rotation.
    expect(STATION_PROPERTIES.stonecutter).toContain("appliance");
    // The law is NO CRAFT ROW, not "no row at all". A stonecutter is a piece of
    // furniture — it stands in a room, it can be in the way, it can be taken
    // apart and carried — and it needs geometry for all of that; what it must
    // never have is a bench recipe, or the automated crafter turns out stone
    // benches two at a time forever. (Absence from FURNITURE_ITEMS used to
    // stand in for that, and while it did, a deconstructed one rendered as a
    // question mark — see item-prop-spec.test.ts.)
    expect(FURNITURE_ITEMS.find((f) => f.kind === "stonecutter")?.craft).toBeUndefined();
    // The hazard itself, closed: the rotation can never reach it.
    const rotation = new Set<string>();
    for (let day = 0; day < 60; day++) {
      for (const salt of [0, 1, 2, 3, 4]) {
        const pick = nextCraftKind({ day, salt, hasBench: true, stored: () => 0 });
        if (pick) rotation.add(pick.kind);
      }
    }
    expect(rotation.has("stonecutter")).toBe(false);
    for (const appliance of ["anvil", "altar", "loom", "shelf", "oven", "refrigerator"]) {
      expect(rotation.has(appliance)).toBe(false);
    }
  });

  it("the masonry cluster declares a floor a mason can work in", () => {
    const c = CLUSTERS.masonry!;
    expect(c.privacy).toBe(1);
    // Wider than the forge at the same depth — the stock lane (stone waiting,
    // block cut) that a smith at one anvil never needed.
    expect(c.minW!).toBeGreaterThan(CLUSTERS.forge!.minW!);
    expect(c.minD!).toBeGreaterThanOrEqual(CLUSTERS.forge!.minD!);
  });
});

describe("the masonry as a buildable structure", () => {
  const spec = () => TOWN_PLAY_STRUCTURES.find((s) => s.type === "masonry")!;

  it("resolves from BOTH spoken names — the place and the bench", () => {
    // The carpentry's naming, mirrored: `type`/`glyph` is the place, `label`
    // is the bench, and resolveStructure's type → glyph → label ladder makes
    // "build masonry" and "build stonecutter" the same order.
    expect(resolveStructure(TOWN_PLAY_STRUCTURES, "masonry")?.type).toBe("masonry");
    expect(resolveStructure(TOWN_PLAY_STRUCTURES, "stonecutter")?.type).toBe("masonry");
    expect(resolveStructure(TOWN_PLAY_STRUCTURES, "Stonecutter")?.type).toBe("masonry"); // case-blind
    // And it does not steal the carpentry's own names.
    expect(resolveStructure(TOWN_PLAY_STRUCTURES, "carpentry")?.type).toBe("workshop");
  });

  it("raises the bench that defines it, and frames that same bench", () => {
    expect(spec().stations).toContain("stonecutter");
    expect(structureDisplayGlyph(spec())).toBe("building(stonecutter)");
    expect(spec().role).toBe("work");
    expect(spec().default).toBe(true); // the split is useless if nobody can build it
  });

  it("keeps a stock band — rough stone in, cut block out", () => {
    expect(spec().program).toEqual({ store: true });
    expect(WORK_PROGRAMS.masonry).toEqual({ store: true });
    expect(workProgram("masonry")).toEqual({ store: true });
  });

  it("affords its cluster's floor and pays the block bill like every other row", () => {
    expect(spec().footprint.w).toBeGreaterThan(CLUSTERS.masonry!.minW!);
    expect(spec().footprint.d).toBeGreaterThan(CLUSTERS.masonry!.minD!);
    // The bill is DERIVED from the footprint (phase 6) — the row authors no
    // block count, and `structureCosts` is what every affordability path sees.
    expect(Object.keys(structureCosts(spec()))).toEqual(["block"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE ROUTING — refineSpotOf / ensureRefineOrders over a real town
// ─────────────────────────────────────────────────────────────────────────

const CONFIG = { seed: 5, days: 30, questCount: 0, key: "smalltown", startPop: 20 };

const workRow = (type: string, dx: number, dy: number): TownWork =>
  ({ type, dx, dy, w: 10, h: 8, door: "north", color: "#888" });

/**
 * The construction director over a real town-play fixture with a STUB context
 * (town-construction-phase4's harness, plus the two seams the refinement chain
 * reads): `containerAnchor` answers from a map the test writes, so a test can
 * put a crate of stone somewhere reachable and nothing else.
 *
 * `works` REPLACES the generated town's work rows — the routing rule is "which
 * trades stand here", so the fixture states exactly which do.
 */
function harness(works: TownWork[], boxes: Record<string, { at: { x: number; y: number }; stack: Record<string, number> }> = {}) {
  const play = buildTownPlay(CONFIG);
  (play.plan as { works: TownWork[] }).works = works;
  const toasts: string[] = [];
  const anchors = new Map(Object.entries(boxes).map(([id, b]) => [id, b.at]));
  const session = {
    town: play,
    townClock: 0,
    scale: REAL_SCALE,
    containerRecords: new Map(
      Object.entries(boxes).map(([id, b]) => [
        id,
        { mount: "standing" as const, relation: "in" as const, stock: b.stack, owner: null },
      ]),
    ),
    wornBagIndex: new Map<string, string>(),
    marketStore: new Map<string, unknown>(),
    produceBox: new Map<string, unknown>(),
    houseShown: new Set<number>(),
    transfers: play.deltas.transfers,
    reservations: play.deltas.reservations,
    taskClock: 0,
  } as unknown as QuestSession;
  const ctx = {
    presenter: { toast: (m: string) => { toasts.push(m); } },
    familyOf: () => null,
    npcChatBubble: () => {},
    spawnLooseProp: () => null,
    removeLooseProp: () => {},
    postPooledTask: () => {},
    stockEndpointOf: () => null,
    containerAnchor: (_s: unknown, id: string) => anchors.get(id) ?? null,
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
  } as unknown as ConstructionDirectorCtx;
  return { play, session, toasts, director: createConstructionDirector(ctx) };
}

/** What the catalogue says a raw's trade is — the routing's ONE input. */
const atOf = (glyph: string) =>
  rawsForRefined("block").find((p) => p.glyph === glyph)!.refinesTo!.at;

describe("refineSpotOf — the material says where it is worked", () => {
  it("stone goes to the masonry and wood to the carpentry, in the same town", () => {
    // The whole point of the split, in one assertion: two raws, two benches,
    // one town, and the router never confuses them.
    const carpentry = workRow("workshop", -40, -40);
    const masonry = workRow("masonry", 60, 60);
    const { play, session, director } = harness([carpentry, masonry]);
    const c = play.stage.center;
    expect(director.refineSpotOf(session, atOf("stone"))).toEqual(workDoorstep(c, masonry));
    expect(director.refineSpotOf(session, atOf("wood"))).toEqual(workDoorstep(c, carpentry));
    // `atOf` is not a test-local opinion — it IS what products.ts declares.
    expect(atOf("stone")).toBe("masonry");
    expect(atOf("wood")).toBeUndefined(); // unmarked ⇒ the carpentry default
  });

  it("an unmarked raw keeps the carpentry — the pre-split behavior, unchanged", () => {
    const carpentry = workRow("workshop", -40, -40);
    const { play, session, director } = harness([carpentry]);
    // No argument at all is the same answer as the wood catalogue gives.
    expect(director.refineSpotOf(session)).toEqual(workDoorstep(play.stage.center, carpentry));
    expect(director.refineSpotOf(session, undefined)).toEqual(director.refineSpotOf(session));
  });

  it("NO GATE: with no masonry standing, stone still has somewhere to be cut", () => {
    // stations.ts:422's law. The fallback chain is the pre-split one, byte for
    // byte: the yard crate's spot, then the town center.
    const yardAt = { x: 12, y: -7 };
    const withYard = harness([workRow("workshop", -40, -40)], {
      [TOWN_YARD_EP]: { at: yardAt, stack: { stone: 6 } },
    });
    expect(withYard.director.refineSpotOf(withYard.session, "masonry")).toEqual(yardAt);

    const bare = harness([]);
    expect(bare.director.refineSpotOf(bare.session, "masonry")).toEqual(bare.play.stage.center);
    expect(bare.director.refineSpotOf(bare.session, "masonry")).not.toBeNull();
  });

  it("a VACATED masonry is no masonry at all", () => {
    const masonry = { ...workRow("masonry", 60, 60), vacated: true };
    const { play, session, director } = harness([masonry]);
    // Falls all the way through to the center — the row stages nothing.
    expect(director.refineSpotOf(session, "masonry")).toEqual(play.stage.center);
  });
});

describe("ensureRefineOrders — which raw gets cut first", () => {
  /** The one refine order the chain posted, or undefined. */
  const posted = (play: ReturnType<typeof harness>["play"]) => play.deltas.refineOrders()[0];

  it("a town with a masonry and NO carpentry cuts its stone first", () => {
    // The plan's worked example. Catalogue order (wood before stone) would
    // have milled wood at a bench that does not exist; the standing trade wins
    // the tie instead, and the order lands ON the masonry's doorstep.
    const masonry = workRow("masonry", 60, 60);
    const { play, session, director } = harness([masonry], {
      "box:pile": { at: { x: 5, y: 5 }, stack: { wood: 8, stone: 8 } },
    });
    const { milling, rest } = director.ensureRefineOrders(session, { block: 3 });
    expect(rest).toEqual({});
    expect(milling).toBe(3);
    expect(posted(play)!.produces).toBe(refinedGlyphOf("stone"));
    expect(posted(play)!.costs).toEqual({ stone: 6 }); // the 2:1 ratio
    expect(posted(play)!.at).toEqual(workDoorstep(play.stage.center, masonry));
  });

  it("the standing trade breaks a tie even when NEITHER raw is reachable", () => {
    // Free units is the FIRST key, so it only decides when the two differ.
    // With an empty town both are zero and the standing bench decides — the
    // order posts and starves naming stone, which is the honest failure.
    //
    // 🔁 RE-PINNED 2026-08-12 (S&D closing sweep) — the assertion moved, the
    // law did not. The surplus-control patch (absorbed at S0) added one arm to
    // `ensureRefineOrders`: an AUTOMATED bill is capped by the SPARE, and "a
    // spare of zero posts NOTHING and stays quiet" — the shortfall stays
    // counted in `milling`, so the bench still says "milling N" instead of
    // claiming there is nothing to fetch. An empty town has no spare, so the
    // tie-break is no longer OBSERVABLE through a posted row here; it is
    // observable through a SPOKEN bill, which may draw the reserve, and that
    // is what this case now measures. (The catalogue tie-break itself is
    // pinned independently by "with BOTH trades standing" below.)
    const masonry = workRow("masonry", 60, 60);
    const { play, session, director } = harness([masonry]);
    const auto = director.ensureRefineOrders(session, { block: 2 });
    expect(posted(play)).toBeUndefined(); // the quiet arm — nothing to feed it
    expect(auto.milling).toBe(2); // …but the bill IS known
    expect(auto.rest).toEqual({});
    // The SPOKEN twin: the player's own order may reach past the reserve, so
    // the row posts and the standing bench still breaks the tie.
    const spoken = harness([masonry]);
    spoken.director.ensureRefineOrders(spoken.session, { block: 2 }, undefined, undefined, true);
    expect(posted(spoken.play)!.produces).toBe(refinedGlyphOf("stone"));
  });

  it("NO GATE, the other way: reachable stock still outranks a standing bench", () => {
    // A masonry stands but the town has only WOOD. `at` is a place the work
    // goes, never permission — so the chain mills the wood it actually has,
    // at the carpentry-shaped fallback, rather than waiting on stone.
    const masonry = workRow("masonry", 60, 60);
    const { play, session, director } = harness([masonry], {
      "box:pile": { at: { x: 5, y: 5 }, stack: { wood: 8 } },
    });
    director.ensureRefineOrders(session, { block: 2 });
    expect(posted(play)!.produces).toBe(refinedGlyphOf("wood"));
    expect(posted(play)!.at).toEqual(play.stage.center); // no carpentry, no yard
  });

  it("NO GATE: a masonry-less town with stone still cuts it", () => {
    // The plan's own acceptance line. No masonry anywhere; the stone refines
    // at the yard exactly as it did before the split existed.
    //
    // 🔁 RE-MEASURED 2026-08-12 (S&D closing sweep) — the FIXTURE moved, the
    // pin did not. The yard is the COMMONS, and S&D S3 declared the coupling
    // `par ≡ reserve` (`storehouseRawParAt` ≡ `commonsReserveOf`'s floor): the
    // town's first `STOREHOUSE_RAW_PAR` units of a raw are its buffer, and an
    // AUTOMATED bill spends only the SPARE above it. Ten stone is entirely
    // reserve, so the old fixture measured the reserve floor rather than the
    // no-gate law it was written for. Stocked ABOVE the floor, the law reads
    // exactly as before: no masonry, and the stone still cuts, at the yard.
    const yardAt = { x: 12, y: -7 };
    const { play, session, director } = harness([], {
      [TOWN_YARD_EP]: { at: yardAt, stack: { stone: STOREHOUSE_RAW_PAR + 10 } },
    });
    const { rest } = director.ensureRefineOrders(session, { block: 4 });
    expect(rest).toEqual({});
    expect(posted(play)!.produces).toBe(refinedGlyphOf("stone"));
    expect(posted(play)!.at).toEqual(yardAt);
  });

  it("with BOTH trades standing, the catalogue order still decides", () => {
    // The third key, unchanged: two equal candidates fall back to wood before
    // stone, so a fully-built town's behavior is exactly what it always was.
    const carpentry = workRow("workshop", -40, -40);
    const masonry = workRow("masonry", 60, 60);
    const { play, session, director } = harness([carpentry, masonry], {
      "box:pile": { at: { x: 5, y: 5 }, stack: { wood: 8, stone: 8 } },
    });
    director.ensureRefineOrders(session, { block: 2 });
    expect(posted(play)!.produces).toBe(refinedGlyphOf("wood"));
    expect(posted(play)!.at).toEqual(workDoorstep(play.stage.center, carpentry));
  });

  it("the choice is DETERMINISTIC — the same town answers the same way", () => {
    const rows = () => [workRow("masonry", 60, 60), workRow("workshop", -40, -40)];
    const boxes = { "box:pile": { at: { x: 5, y: 5 }, stack: { wood: 8, stone: 8 } } };
    const a = harness(rows(), boxes);
    const b = harness(rows(), boxes);
    a.director.ensureRefineOrders(a.session, { block: 2 });
    b.director.ensureRefineOrders(b.session, { block: 2 });
    expect(posted(a.play)!.produces).toBe(posted(b.play)!.produces);
    expect(posted(a.play)!.at).toEqual(posted(b.play)!.at);
  });

  it("a head no raw refines into is still the honest starved bill", () => {
    const { session, director } = harness([workRow("masonry", 60, 60)]);
    expect(director.ensureRefineOrders(session, { apple: 2 })).toEqual({
      milling: 0,
      rest: { apple: 2 },
    });
  });
});
