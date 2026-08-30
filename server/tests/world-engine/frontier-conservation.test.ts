// 🚨 THE FRONTIER CONSERVATION DIAGNOSIS — now a REGRESSION SUITE, all green.
//
// Born as a DIAGNOSIS artefact (planning-docs/games/world-engine/
// frontier-conservation-diagnosis.md): every conservation defect below was
// first pinned as a `test.failing` that passed BECAUSE the defect was present,
// then flipped to a plain `it` in the round that fixed it. ② landed
// 2026-08-14 (the twin's shadow store), the deadlock/spoken-cap round
// 2026-08-15, and the MOUNT-STATE CONTRACT round (①/③a/③b/④ below) 2026-08-23:
// every mount an item can take — hands, worn, stowed whole, mirror shell,
// order pile with or without a town — now lands in a representation exactly
// one reader reads.
//
// THE REPORT: "Frontier Homestead: creatures loop saying 'I will carry the wood
// to the block', circling the central box carrying logs." Driving text mode
// (`transcripts/bug-carry-loop-wide.txt`, `bug-carry-loop-exhaust.txt`) showed
// `sessionStockAudit` drifting across a block haul arc that mints nothing:
// block 240→238→239→245, basket 12→13→14→15, wood/stone dead constant.
//
// THREE SEPARATE DEFECTS, bisected here one op at a time:
//
//   ① THE POCKET CENSUS BLIND SPOT — ✅ FIXED 2026-08-23.  scope.ts
//      `auditScopeTree` reads
//      `looseIn(n.id)` only for nodes that came out of `input.ids()`.
//      quest-host `scopeTreeOf().ids()` lists `pocket:<cid>` ONLY for a body
//      that wears a bag or carries a REGISTERED CONTAINER (the
//      `isContainerId(session, objId)` gate) — while the census one screen up
//      buckets ANY carried prop under `pocket:<cid>` (`parentOfObject`, via
//      `o.carriedBy`). So a body carrying a BARE loose prop — precisely what
//      `giveUnitsToBody`'s no-bag arm mints for a porter with no basket — has
//      no node in the tree, and its unit is invisible for the whole walk. It
//      reappears on unload. That is the mid-flight dip, and its mirror (a bag
//      that is WORN is not in `looseEntries` at all, so it is worth 0 until
//      somebody doffs it and it becomes +1) is the "satchel: 1 from nowhere"
//      in the exhaust dump.
//
//   ② THE TWIN'S SHADOW STORE — ✅ FIXED 2026-08-14.  construction-director
//      `twinResolveHauls` debited the carrier for real and credited
//      `session.containerRecords.get(a.to).stock` under a PILE id, then
//      `setContainerStock(session, a.to, dstStock)`. But `stockEndpointOf`'s
//      `orderPile` branch returns the ORDER ROW's `pile` and never falls
//      through to the container fallback, so that store was read back by
//      NOTHING: not the audit, not `pileShortfall`, not any resolver. The
//      goods were destroyed and the site re-ordered them forever. The twin
//      now credits the destination through `stockEndpointOf` for the three
//      pile spellings (`isOrderPileId`), so the delivery lands in the map
//      every reader reads. Its pins are PLAIN tests: the reader half in the
//      booted describe, the writer half (the director driving a loaded
//      unobserved haul home) in the harness describe at the bottom.
//
//   ③ A BASKET PER HAUL TRIP — ✅ FIXED 2026-08-23 (localized: worn bags and
//      whole-object stows had no countable home; the pool of existing bags
//      surfaced as they changed mount). The arc test at the bottom stays as
//      the standing net.
//
// DB-free by construction: `bootTextQuest` is the same headless boot
// `headless-quest-boot.test.ts` uses, over the smallest shipped world document
// (`scripts/worlds/frontier.spec.json`, the very world the bug was reported
// against). Run it with:  npm run test:engine -- frontier

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import { itemObjectSpec } from "@shared/world-engine/interaction/content/item-prop.js";
import { carryObject, placeInContainer } from "@shared/world-engine/engine.js";
import { setLooseProp, setContainerStock } from "@shared/world-engine/kernel/town/containers.js";
import {
  BFURN_EP,
  createConstructionDirector,
  type ConstructionDirectorCtx,
} from "@shared/world-engine/interaction/quest/construction-director.js";
import { createTaskPool } from "@shared/world-engine/interaction/behavior/task-pool.js";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import {
  markDoorless,
  stagingMissing,
  TOWN_YARD_EP,
  workDeltaKey,
  type FoundedBuilding,
  type FoundingCandidate,
} from "@shared/world-engine/kernel/town/construction.js";
import { furnitureGlyph } from "@shared/world-engine/kernel/town/stations.js";
import { BLOCK_GLYPH } from "@shared/world-engine/products.js";
import { REAL_SCALE } from "@shared/world-engine/scale.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import type { ContainerRecord } from "@shared/world-engine/kernel/town/containers.js";
import type { StockEndpoint } from "@shared/world-engine/kernel/town/transfer.js";
import type { FoundedSite } from "@shared/world-engine/interaction/town/founding.js";

const specPath = join(process.cwd(), "scripts", "worlds", "frontier.spec.json");
const doc = JSON.parse(readFileSync(specPath, "utf8"));

// The transcripts' own dial (`--seed 11 --dt 0.5`), so a finding here and a
// finding there are the same run in two harnesses.
const SEED = 11;
const DT = 0.5;

/** `stockAudit` prunes non-positive rows (scope.ts `addStack` positiveOnly), so
 *  an absent glyph reads as 0 rather than a missing key. */
const units = (run: TextQuestRun, glyph: string): number => run.host.stockAudit()[glyph] ?? 0;

describe("frontier — item conservation across a construction haul arc", () => {
  let run: TextQuestRun;
  /** A real resident body to put things into the hands of. */
  let bodyId: string;
  let at: { x: number; y: number };

  // ONE boot for the whole file: it is the expensive part (~11 s), every test
  // below measures its OWN delta, and sharing keeps the arc test downstream of
  // the ops that precede it exactly as a live session would be.
  beforeAll(() => {
    run = bootTextQuest({ world: doc, seed: SEED, dt: DT });
    run.advance(20); // let the streamer stand the residents up
    const id = Object.keys(run.state.avatars).find((k) => k.startsWith("resident_"));
    if (!id) throw new Error("no resident body was streamed in — fixture broken, not a finding");
    bodyId = id;
    const b = run.state.avatars[bodyId]!;
    at = { x: b.x, y: b.y };
  }, 600_000);

  afterAll(() => run?.dispose());

  // ── ① THE POCKET CENSUS BLIND SPOT ────────────────────────────────────────
  //
  // Two probe props, minted exactly the way `spawnLooseProp` mints one (world
  // object + `setLooseProp` row). They differ in ONE respect, which is the
  // whole bisect: the basket is a REGISTERED CONTAINER (`relation` set) and the
  // block is not.

  const BARE = "probe:bare-block";
  const BAG = "probe:loose-basket";

  it("PRECONDITION — both probe props are visible to the audit while they lie on the floor", () => {
    const block0 = units(run, "block");
    const basket0 = units(run, "basket");

    run.host.world!.addObject(itemObjectSpec("block", BARE, at));
    setLooseProp(run.session, BARE, { entityId: "probe_bare", glyph: "block", at: run.session.townClock });

    run.host.world!.addObject(itemObjectSpec("basket", BAG, at));
    setLooseProp(run.session, BAG, { entityId: "probe_bag", glyph: "basket", at: run.session.townClock });
    // What `spawnLooseProp` does for a container glyph: a basket on the floor is
    // a place things can go, so it registers as one.
    run.session.containerRecords.get(BAG)!.relation = "in";

    // A loose prop IS one unit of its own glyph (item-prop.ts's law). If this
    // fails the props landed on unscoped ground and the tests below prove
    // nothing — that is a broken fixture, not a finding.
    expect(units(run, "block")).toBe(block0 + 1);
    expect(units(run, "basket")).toBe(basket0 + 1);
  }, 600_000);

  it("① FIXED — a BARE prop taken into the hands does not leave the audit", () => {
    const before = units(run, "block");
    // Nothing has left the session: the same object, one metre higher.
    expect(carryObject(run.state, BARE, bodyId)).toBe(true);
    // The census always bucketed a carried prop under `pocket:<cid>`; the
    // defect was `ids()` gating that NODE on `isContainerId`, so a body
    // holding a bare block had a bucket nobody ever asked for — every bagless
    // porter's load was invisible for the whole walk (`giveUnitsToBody`'s
    // no-bag arm mints exactly this shape). `ids()` now lists a pocket for a
    // body holding ANYTHING.
    expect(units(run, "block")).toBe(before);
  }, 600_000);

  it("…and the same op on a REGISTERED CONTAINER still conserves (the old differential)", () => {
    const before = units(run, "basket");
    expect(carryObject(run.state, BAG, bodyId)).toBe(true);
    // Pre-fix this was the DIFFERENTIAL that isolated ① to one boolean
    // (`relation !== undefined`, the literal body of `isContainerId`). Both
    // arms conserve now; this half stays as the container-side control.
    expect(units(run, "basket")).toBe(before);
  }, 600_000);

  // ── ③ THE OTHER TWO MOUNTS THE AUDIT COULDN'T SEE ─────────────────────────
  //
  // ① was the HELD case. The census keys every prop off `parentOfObject`, and
  // two of the three mounts a container can take used to leave it with no
  // countable home at all. That is what the transcripts' "basket 11→16,
  // satchel 0→2, then flat" really was: not a per-trip mint but a bounded pool
  // of already-existing bags becoming VISIBLE as they changed mount. Sampling
  // during the climb read as "+1 per haul trip".

  it("③a FIXED — a WORN container is a thing the session owns", () => {
    // The player boots wearing a satchel (`donWornBag`).
    const wornSatchels = [...run.session.containerRecords.values()].filter(
      (r) => r.mount === "worn" && r.glyph === "satchel",
    ).length;
    expect(wornSatchels).toBeGreaterThan(0); // measured: 1 at boot
    // `mount:"worn"` leaves `looseEntries`, so the old census never reached
    // the bag: worth 0 while worn, then "+1 minted from nowhere" on doff —
    // the transcripts' "satchel: 1". The census now reads the wear register
    // directly: one unit of the bag's own glyph under `pocket:<wearer>` (its
    // CONTENTS were always safe — the bag's own row is an endpoint).
    expect(units(run, "satchel")).toBeGreaterThanOrEqual(wornSatchels);
  }, 600_000);

  it("③b FIXED — a container put INSIDE a box as a whole object does not evaporate", () => {
    const body = run.state.avatars[bodyId]!;
    const pid = "probe:stow-basket";
    run.host.world!.addObject(itemObjectSpec("basket", pid, { x: body.x, y: body.y }));
    setLooseProp(run.session, pid, { entityId: "probe_stow", glyph: "basket", at: run.session.townClock });
    run.session.containerRecords.get(pid)!.relation = "in";

    const onFloor = units(run, "basket");
    // The WHOLE-OBJECT arm: a container that may not dissolve stays a real
    // thing inside the box, and nothing credits the box's stack for it.
    expect(placeInContainer(run.state, pid, "town:yard", "in")).toBe(true);

    // The old census skipped EVERY `containedIn` prop ("in a box: counted as
    // that box's stack") — true for a banked MIRROR shell, false for this
    // whole object, which was therefore counted by nobody (measured 12 → 11)
    // and minted again on the way back out. The census now distinguishes the
    // two by the record's `mirror` flag: a shell's unit is the box's stack
    // row; a whole thing counts as itself, under the box.
    expect(units(run, "basket")).toBe(onFloor);
  }, 600_000);

  // ── ② THE TWIN'S SHADOW STORE — ✅ FIXED 2026-08-14 ────────────────────────
  //
  // `twinResolveHauls` now resolves its destination the way every READER does:
  // a pile id (`isOrderPileId` — the three spellings `pileEndpointOf` answers
  // for) is credited through `stockEndpointOf`, i.e. straight into the ORDER
  // ROW's own live `pile`, and no `setContainerStock` is called for it.
  //
  // The test here is the READER half of that law — WHICH account a pile id
  // names, and why the container record was the wrong one. The WRITER half —
  // the director actually walking a loaded unobserved haul home — is the
  // harness describe at the bottom of this file, and that is the one that goes
  // RED if the shadow store ever comes back.

  /** THE ORDER BOOK, whichever one this world has: `stockEndpointOf` reads
   *  `session.town?.deltas ?? session.foundedSite?.deltas`, so the pin must
   *  too. (The original ② pins asked `session.town` alone, got `undefined` and
   *  threw on their FIRST expect — which a `test.failing` counts as a pass.
   *  They were green for the wrong reason, and neither ever reached the
   *  assertion it was named for.) */
  const orderBook = () => run.session.town?.deltas ?? run.session.foundedSite?.deltas;

  it("② — a pile id names the ORDER ROW's own map; a container record under it is a SHADOW", () => {
    // STAKE a costed lot straight onto the live book — exactly what founding
    // does (`deltas.foundBuilding`, construction-director.ts:4454). Speaking it
    // needs a surveyed spot and a builder to walk out; the pile's ACCOUNT is
    // the same row either way, and the account is what ② is about. Removed at
    // the end, so the arc below inherits the session it would have anyway.
    const book = orderBook();
    if (!book) throw new Error("this world booted with no order book — fixture broken, not a finding");
    const lot: FoundingCandidate = { type: "house", slot: 41, dx: 40, dy: -30, w: 9, h: 8, door: "south" };
    const row: FoundedBuilding = book.foundBuilding(lot, 0, 4, { block: 6 });
    const pileId = `orderpile:${row.ord}`;

    try {
      // THE ALIAS LAW: `StockEndpoint.stack` IS the live map, not a copy — the
      // node hands back `row.pile` itself (quest-host `pileEndpointOf`, which
      // materializes it for a found row on the way past).
      const node = run.host.scopeTree().find((n) => n.id === pileId);
      if (!node) {
        throw new Error(`the audit tree does not list ${pileId} — ids() must enumerate the SAME book stockEndpointOf resolves (④)`);
      }
      expect(node.endpoint?.stack).toBe(row.pile);

      // …so a credit written through that door — the door the twin now uses —
      // is a thing the session owns.
      const before = units(run, "block");
      row.pile!["block"] = (row.pile!["block"] ?? 0) + 5;
      expect(units(run, "block")).toBe(before + 5);
      row.pile!["block"] = row.pile!["block"]! - 5;
      expect(units(run, "block")).toBe(before);

      // AND THE OTHER DOOR IS A WALL. The credit `twinResolveHauls` used to
      // make (construction-director.ts :3664 / :3672 / :3683 as it stood),
      // verbatim: `stockEndpointOf`'s `orderPile` branch returns
      // pileEndpointOf(...) → `row.pile` and RETURNS, so the container
      // fallback is unreachable for any id that parses as a pile. This store
      // is read by NOTHING — not the audit, not `pileShortfall`, not
      // `stagingMissing`. Goods credited here were debited off a real carrier
      // and destroyed, and the site re-ordered them forever. That is why the
      // fix moved the WRITE, and did not teach the reader a second account.
      const dstStock = run.session.containerRecords.get(pileId)?.stock ?? {};
      dstStock["block"] = (dstStock["block"] ?? 0) + 5;
      setContainerStock(run.session, pileId, dstStock);
      expect(units(run, "block")).toBe(before);
      expect(run.host.scopeTree().find((n) => n.id === pileId)!.endpoint!.stack).not.toBe(dstStock);
    } finally {
      run.session.containerRecords.delete(pileId);
      book.removeOrder(row.ord);
    }
  }, 600_000);

  // ── ④ THE TOWN-LESS SESSION'S PILES ───────────────────────────────────────

  it("④ FIXED — a HOMESTEAD's piles are in the tree: ids() lists from the book the resolver answers", () => {
    // `stockEndpointOf` resolves `orderpile:` for `town ?? foundedSite`, but
    // `ids()` used to enumerate them only INSIDE `if (session.town)` — so a
    // founded-site (homestead) session resolved its pile endpoints perfectly
    // well while the audit never asked for one, and every unit staged into a
    // homestead pile read as LOST. Same one-boolean shape as ①: enumeration
    // and resolver disagreeing about the key space.
    const t = run.session.town;
    const book = orderBook();
    if (!book) throw new Error("this world booted with no order book — fixture broken, not a finding");
    const lot: FoundingCandidate = { type: "house", slot: 43, dx: -40, dy: 30, w: 9, h: 8, door: "south" };
    const row: FoundedBuilding = book.foundBuilding(lot, 0, 4, { block: 6 });
    const pileId = `orderpile:${row.ord}`;
    const savedSite = run.session.foundedSite;
    try {
      // THE HOMESTEAD SHAPE, exactly: no town, the same order book riding the
      // founded site (founding.ts serializes it just so).
      run.session.town = null;
      run.session.foundedSite = {
        key: "probe-homestead",
        seed: 0,
        at: { x: 0, y: 0 },
        foundedDay: 0,
        stock: {},
        deltas: book,
        buildings: 0,
        residents: [],
      } satisfies FoundedSite;
      const node = run.host.scopeTree().find((n) => n.id === pileId);
      if (!node) {
        throw new Error(`the audit tree does not list ${pileId} for a founded-site session — defect ④ is back`);
      }
      // The alias law, same as ②: the endpoint IS the row's live map…
      expect(node.endpoint?.stack).toBe(row.pile);
      // …and a credit staged into the homestead's pile is a thing the session
      // owns — the exact units that used to read as LOST.
      const before = units(run, "block");
      row.pile!["block"] = (row.pile!["block"] ?? 0) + 5;
      expect(units(run, "block")).toBe(before + 5);
      row.pile!["block"] = row.pile!["block"]! - 5;
      expect(units(run, "block")).toBe(before);
    } finally {
      run.session.town = t;
      run.session.foundedSite = savedSite;
      book.removeOrder(row.ord);
    }
  }, 600_000);

  // ── W1 THE GARMENT'S HOME (⑩ audit, wear round rung 1) ───────────────────

  it("W1 FIXED — a WORN GARMENT is a thing the session owns (the fifth item location)", () => {
    // `session.worn` was outside every audited location (item-move.ts's closed
    // union AND the scope tree): a shirt was worth 0 while worn, and the equip
    // path's doffed `.dirty` unit read as minted from nowhere. The census now
    // banks one unit of the worn glyph under `pocket:<wearer>` and `ids()`
    // lists a dressed body's node — the ③a shape, for garments.
    //
    // The boot dresses its streamed residents (seedWorn), so the register is
    // live in this very fixture…
    expect(run.session.worn.size).toBeGreaterThan(0);
    const [realCid, realW] = [...run.session.worn.entries()][0]!;
    expect(units(run, realW.glyph)).toBeGreaterThanOrEqual(1);
    void realCid;
    // …and a probe row moves the audit by exactly one, on and off.
    const PROBE_GLYPH = "shirt.color_red";
    const before = units(run, PROBE_GLYPH);
    run.session.worn.set("probe_wearer", { glyph: PROBE_GLYPH, n: 0 });
    try {
      expect(units(run, PROBE_GLYPH)).toBe(before + 1);
    } finally {
      run.session.worn.delete("probe_wearer");
    }
    expect(units(run, PROBE_GLYPH)).toBe(before);
  }, 600_000);

  // ── #25 THE DELIVERY-LEG MINT (facet mismatch) ────────────────────────────

  it("#25 FIXED — a FACTED source conserves through a REAL haul arc (the delivery-leg mint)", () => {
    // The 08-15 arc's signature: `commitRefineOrder` credits the CONCRETE
    // variant (`block.material_wood`), the bill says "block", and the load leg
    // measured availability HEAD-matched (`stackUnits`) but debited with the
    // exact-key `stackTake` — a silent no-op against a facted row. The body
    // was credited, the source never drained, and the next sweep ordered the
    // same load again: "bring 12 block — delivered" ×30 for one 12-block mill,
    // census 127 of 29 milled. This drives the REAL machinery: a costed lot on
    // the live book, the director's own haul sweep, a real porter walking a
    // real agreement through the fixed load leg.
    const book = orderBook();
    if (!book) throw new Error("no order book — fixture broken, not a finding");
    const yard = run.session.containerRecords.get(TOWN_YARD_EP);
    if (!yard?.stock) throw new Error("no yard stock — fixture broken, not a finding");

    // Repaint the supply as the mill's own product: ONLY facted blocks on the
    // shelf, so every draw the bill provokes must cross the head/facet seam.
    const plainBlocks = yard.stock["block"] ?? 0;
    delete yard.stock["block"];
    yard.stock["block.material_wood"] = (yard.stock["block.material_wood"] ?? 0) + 8;

    // Every block in the session, whatever its facet — heads and variants are
    // one good to the conservation question.
    const totalBlocks = () =>
      Object.entries(run.host.stockAudit())
        .filter(([g]) => g === "block" || g.startsWith("block."))
        .reduce((s, [, n]) => s + n, 0);

    // Staked near the town center so the session's own player position keeps
    // the site OBSERVED (< 120 m) — the twin already draws via `takeStock`;
    // the leg under test is the real porter's.
    const lot: FoundingCandidate = { type: "house", slot: 45, dx: 12, dy: 14, w: 9, h: 8, door: "south" };
    const row: FoundedBuilding = book.foundBuilding(lot, 0, 4, { block: 6 });
    const before = totalBlocks();
    const yardBefore = yard.stock["block.material_wood"] ?? 0;

    try {
      // Let the sweep post the haul and a resident walk it. Bail as soon as a
      // delivery lands; the cap keeps a broken run from hanging the suite.
      row.pile ??= {};
      for (let i = 0; i < 12 && !Object.keys(row.pile).length; i++) run.advanceS(20);

      // A delivery HAPPENED (the arc is live, not vacuously green)…
      const delivered = Object.entries(row.pile).reduce((s, [, n]) => s + n, 0);
      expect(delivered).toBeGreaterThan(0);
      // …the pile holds the CONCRETE variant the shelf actually held — the
      // twin's own bookkeeping, now from the observed leg too…
      expect(row.pile["block.material_wood"] ?? 0).toBeGreaterThan(0);
      // …the source actually DRAINED (the mint's defining symptom was a shelf
      // that never went down)…
      expect(yard.stock["block.material_wood"] ?? 0).toBeLessThan(yardBefore);
      // …and NOT ONE unit was minted or destroyed across the whole arc: shelf
      // + pile + every body mid-carry sum to exactly what we started with
      // (countable mid-flight because the mount-state round landed first).
      expect(totalBlocks()).toBe(before);
    } finally {
      // Put the fixture back: the staked order dies and the plain supply
      // returns for the tests downstream.
      book.removeOrder(row.ord);
      yard.stock["block"] = (yard.stock["block"] ?? 0) + plainBlocks;
    }
  }, 600_000);

  // ── THE STANDING NET ──────────────────────────────────────────────────────

  it("baskets are CONSTANT once the pool has finished becoming visible", () => {
    // Frontier has no weaver, no basket recipe and no basket import, so over
    // any arc at all this is a constant. It holds HERE (measured: flat over
    // 400 sim-s at this point in the boot) — which is the positive half of the
    // ③ finding: the transcripts' climb 11→14→16 PLATEAUS at 16 and stays
    // there for another 2 000 sim-s, so nothing is minting per trip. Kept as a
    // live net: if a real producer ever appears in this path, it lands here.
    const before = units(run, "basket");
    run.advanceS(120);
    expect(units(run, "basket")).toBe(before);
  }, 600_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// ② THE WRITER HALF — THE TWIN, DRIVEN
//
// The booted arc above proves WHICH account a pile id names. This proves the
// unobserved twin credits THAT one. The director is real
// (`stepFoundedConstruction` over real TownDeltas and a real transfer ledger);
// the host services are stubbed the way `haul-claim-staleness.test.ts` stubs
// them, and the `stockEndpointOf` stub is quest-host's own pile dispatch in
// miniature (`pileOrderRow`/`pileEndpointOf`, quest-host.ts:26048-26090 —
// every pile spelling resolves to the ORDER ROW's live `pile`, never to a
// container record).
//
// PRE-FIX THIS DESCRIBE IS RED: the load left the porter's hands and landed in
// `containerRecords["orderpile:0"].stock`, an account nothing reads — so the
// row's pile stayed empty, `stagingMissing` never shrank, and the site
// re-ordered the same wood forever (the reported carry loop).
describe("② the unobserved twin credits the map every reader reads", () => {
  const CONFIG = { seed: 5, days: 30, questCount: 0, key: "smalltown", startPop: 20 };
  const PORTER = "porter_1";
  const YARD_AT = { x: 0, y: 0 };
  const SITE_AT = { x: 30, y: 0 };
  /** One costed lot. `foundBuilding` gives it `pile: {}` because costs are passed. */
  const LOT: FoundingCandidate = {
    type: "house",
    slot: 3,
    dx: 10,
    dy: -20,
    w: 9,
    h: 8,
    door: "south",
  };

  function harness(carried: string = BLOCK_GLYPH, clerk?: string) {
    const play = buildTownPlay(CONFIG);
    const toasts: string[] = [];
    /** ⚖️ THE OTHER REFUSAL CHANNEL — what the addressed clerk actually says.
     *  A banner alone is a `saySystem`, which the vocal-refusal law forbids. */
    const bubbles: Array<{ cid: string; line: string }> = [];
    /** The porter's hands: ONE thing — the no-bag arm's single-unit trip. */
    let inHand: { objId: string; glyph: string } | null = { objId: "obj:carried", glyph: carried };
    /** A yard with NO blocks in it, so the twin's OWN draw (`twinStagePile`,
     *  which runs in the same sweep) can find nothing: every unit the row's
     *  pile gains came off the carrier and from nowhere else. */
    const containerRecords = new Map<string, ContainerRecord>([
      [TOWN_YARD_EP, { stock: {} } as ContainerRecord],
    ]);
    const session = {
      town: play,
      townClock: 0,
      taskClock: 0,
      scale: REAL_SCALE,
      containerRecords,
      wornBagIndex: new Map<string, string>(),
      marketStore: new Map<string, unknown>(),
      produceBox: new Map<string, unknown>(),
      houseShown: new Set<number>(),
      transfers: play.deltas.transfers,
      reservations: play.deltas.reservations,
      taskPool: createTaskPool(),
      buildTaskOrds: new Map<string, number>(),
      // A queued step, so the sweep's re-aim leaves the walking porter alone
      // (haul-claim-staleness's own shape) and the row reaches the twin as a
      // live, loaded trip.
      npcTasks: new Map<string, unknown[]>([[PORTER, [{}]]]),
      needPoseShow: new Map<string, unknown>(),
      party: new Set<string>(),
      escorting: new Set<string>(),
      // A clerk is only wired for the refusal pin: the vocal half of a refusal
      // needs SOMEBODY addressed to say it (`session.addressedFamily ??
      // gazeCreature ?? convoNodeId`), and `npcChatBubble` is gated on the
      // creature being a real node.
      creatures: clerk ? { nodeByCreature: new Map([[clerk, {}]]) } : null,
      addressedFamily: clerk ?? null,
    } as unknown as QuestSession;
    const ctx = {
      presenter: {
        toast: (m: string) => {
          toasts.push(m);
        },
      },
      familyOf: () => null,
      avatarIdOf: (cid: string) => cid,
      buildingUnits: () => 0,
      npcChatBubble: (_s: QuestSession, cid: string, line: string) => {
        bubbles.push({ cid, line });
      },
      gazeCreature: () => null,
      spawnLooseProp: () => null,
      removeLooseProp: () => {},
      postPooledTask: () => {},
      containerAnchor: (_s: QuestSession, id: string) => (id === TOWN_YARD_EP ? YARD_AT : null),
      houseContainerKeys: () => [],
      // ⇐ NOBODY IS WATCHING (no player position, no spirit): `observedRect` is
      // false for every rect, which is what routes the sweep down the twin arm.
      playerWorldPos: () => null,
      playerFocusArea: () => null,
      townShortage: () => 0,
      invalidateTownJobs: () => {},
      questViewOf: () => null,
      spiritFocusOf: () => null,
      convoNodeId: () => null,
      issueTransferHaul: () => {},
      handIsFree: () => true,
      townHandPool: () => ({ total: 1, free: 1 }),
      bumpStockEpoch: () => {},
      bodyCarryOf: (_s: QuestSession, cid: string) =>
        cid === PORTER ? { inHand, worn: null } : { inHand: null, worn: null },
      takeUnitsFromBody: (_s: QuestSession, cid: string, glyph: string, n: number) => {
        if (n <= 0 || cid !== PORTER || inHand?.glyph !== glyph) return 0;
        inHand = null; // the hands hold ONE whole object, consumed on the way in
        return 1;
      },
      stockEndpointOf: (_s: QuestSession, id: string): StockEndpoint | null => {
        // The reader, faithfully: `orderpile:`/`sitepile:` name the found row's
        // OWN live map (materialized on the way past, as `pileEndpointOf` does);
        // anything else is a container record. The fixture stakes exactly one
        // row family, so the found arm is the only one modelled here.
        if (id.startsWith("orderpile:") || id.startsWith("sitepile:")) {
          const ord = Number(id.slice(id.indexOf(":") + 1));
          const row = play.deltas.orders().find((o) => o.ord === ord);
          if (!row) return null;
          // A REFINE row answers for its own mill spot (`pileEndpointOf`'s
          // refine arm, quest-host.ts:26326-26328) — the release path asks the
          // recipient pile where it is before it posts anything to it.
          if (row.kind === "refine") {
            return { id, kind: "site", at: row.at, stack: row.pile, owner: null };
          }
          if (row.kind !== "found") return null;
          row.pile ??= {};
          return { id, kind: "site", at: SITE_AT, stack: row.pile, owner: null };
        }
        // …and `bfurn:` names the SHELL's furniture pile on TownDeltas,
        // materialized on touch — quest-host's `buildingFurnPile` branch
        // (:26157-26174) verbatim, including its "no pending building ⇒ no
        // endpoint" null (here: a `w_<i>` naming no plan row at all).
        if (id.startsWith("bfurn:")) {
          const key = id.slice("bfurn:".length);
          const wi = Number(/^w_(\d+)$/.exec(key)?.[1] ?? -1);
          if (!play.plan.works[wi]) return null;
          const piles = play.deltas.shellFurnPiles;
          let stack = piles.get(key);
          if (!stack) {
            stack = {};
            piles.set(key, stack);
          }
          return { id, kind: "site", at: SITE_AT, stack, owner: null };
        }
        const stock = containerRecords.get(id)?.stock;
        return stock ? { id, kind: "yard", at: YARD_AT, stack: stock, owner: null } : null;
      },
    } as unknown as ConstructionDirectorCtx;
    const director = createConstructionDirector(ctx);
    // The porter has a REAL body on its trip — a `moving` row whose avatar is
    // gone is failed "no-executor" by the sweep long before the twin sees it
    // (construction-director.ts:5697-5702). It is not, however, WATCHED: there
    // is no player position at all, so the twin's "this one is really walking,
    // leave it alone" guard (which needs a watcher to measure against) never
    // fires and the trip finishes unobserved.
    director.setWorld({
      state: { avatars: { [PORTER]: { x: 5, y: 5 } }, objects: {}, spec: { objects: [] } },
      npcRadiusOf: () => 0.3,
      npcErrandActive: () => true,
      removeObject: () => {},
      setDragZones: () => {},
    } as never);
    return { play, session, director, toasts, bubbles, containerRecords, held: () => inHand };
  }

  /** ONE LOADED TRIP: the porter has claimed the row and the goods are on its
   *  body — the only shape the twin delivers (an unloaded one fails named). */
  function loadedHaul(h: ReturnType<typeof harness>, to: string, glyph: string = BLOCK_GLYPH) {
    const a = h.session.transfers.post({
      from: TOWN_YARD_EP,
      to,
      goods: { [glyph]: 1 },
      issuer: "player",
      mode: "haul",
      now: h.session.taskClock,
      sourceGlyph: `bring 1 ${glyph}`,
    });
    expect(h.session.transfers.begin(a.id, PORTER)).toBe(true);
    h.session.transfers.load(a.id, { [glyph]: 1 });
    return a;
  }

  /** A COSTED site nobody is watching, and one loaded haul walking to it. */
  function stakedSite(h: ReturnType<typeof harness>, idOf: (ord: number) => string) {
    const b = h.play.deltas.foundBuilding(LOT, 0, 50, { [BLOCK_GLYPH]: 6 });
    return { b, a: loadedHaul(h, idOf(b.ord)) };
  }

  /** One sweep of the founded-construction step (its own 1 s cadence). */
  function sweep(h: ReturnType<typeof harness>) {
    h.session.taskClock += 1;
    h.director.stepFoundedConstruction(h.session, 1);
  }

  it("lands the load in the ORDER ROW's own pile — the map every reader reads", () => {
    const h = harness();
    const { b, a } = stakedSite(h, (ord) => `orderpile:${ord}`);
    expect(stagingMissing(b)).toEqual({ [BLOCK_GLYPH]: 6 });

    sweep(h);

    // The delivery is in the ROW's map, so the bill it feeds actually shrinks —
    // which is the whole point: `stagingMissing` is what re-posts the haul.
    expect(b.pile).toEqual({ [BLOCK_GLYPH]: 1 });
    expect(stagingMissing(b)).toEqual({ [BLOCK_GLYPH]: 5 });
    expect(h.session.transfers.get(a.id)!.status).toBe("done");
    // CONSERVATION: off the body exactly once, into the pile exactly once.
    expect(h.held()).toBeNull();
  });

  it("writes NO second account: there is no container record under the pile id", () => {
    const h = harness();
    const { b } = stakedSite(h, (ord) => `orderpile:${ord}`);
    sweep(h);
    // `setContainerStock` would have MINTED this record. Its absence is the
    // shadow store's absence.
    expect(h.containerRecords.get(`orderpile:${b.ord}`)).toBeUndefined();
  });

  it("…and the LEGACY `sitepile:` spelling lands in that same map", () => {
    // A pre-phase-2 agreement still in flight targets the old id; the sweep
    // passes it as `legacyPileId`, and it must resolve to the same live pile.
    const h = harness();
    const { b, a } = stakedSite(h, (ord) => `sitepile:${ord}`);
    sweep(h);
    expect(b.pile).toEqual({ [BLOCK_GLYPH]: 1 });
    expect(h.containerRecords.get(`sitepile:${b.ord}`)).toBeUndefined();
    expect(h.session.transfers.get(a.id)!.status).toBe("done");
    expect(h.held()).toBeNull();
  });

  // ── ② ADDENDUM: THE SHELL'S FURNITURE PILE (`bfurn:`) ──────────────────────
  //
  // The SAME defect, one pipeline over: `stepShellPrograms` resolves an
  // unobserved building's inbound furniture haul through the same twin
  // (construction-director.ts:4759) and then reads the delivery back off
  // `shellFurnPilesOf(session)` — a TownDeltas map — one line later. A
  // container-record credit was invisible to that read, to the placement sweep
  // and to the audit alike, so an unobserved furniture delivery was destroyed
  // and the shell re-ordered the piece forever.

  it("a SHELL furniture pile is the same law: the load lands on TownDeltas, not in a record", () => {
    const DOOR = furnitureGlyph("door");
    const h = harness(DOOR);
    const key = workDeltaKey(h.play.plan.works[0]!, 0);

    // OPEN THE SHELL SWEEP'S GATE the cheapest honest way: a doorway with no
    // leaf in it is a want (`wantsDoor`). The key names no REAL doorway, which
    // is deliberate — the placement sweep then finds nowhere to hang the
    // delivered leaf and leaves it in the pile ("dropping it would destroy a
    // real unit", construction-director.ts:4955-4988), so there is still
    // something to assert on at the end of the sweep.
    markDoorless(h.play.deltas, key, ["probe:no-such-doorway"]);
    const a = loadedHaul(h, `${BFURN_EP}${key}`, DOOR);

    sweep(h);

    expect(h.play.deltas.shellFurnPiles.get(key)).toEqual({ [DOOR]: 1 });
    expect(h.containerRecords.get(`${BFURN_EP}${key}`)).toBeUndefined();
    expect(h.session.transfers.get(a.id)!.status).toBe("done");
    expect(h.held()).toBeNull();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ① THE HOLD-AND-WAIT DEADLOCK, AND ITS RELEASE PATH
  //
  // The recurrence check (diagnosis §RECURRENCE CHECK (d)) drove the world-lab
  // `frontier-homestead` preset — `days: 0`, `stock: { wood: 14, stone: 6 }`,
  // i.e. ZERO pre-stocked blocks — and `say build house` spawned TWO refine
  // rows whose raw bills came to ≈237 wood in a world containing 144. Measured
  // over 1 237 sim-s: `orderpile:1` wood 4 → 48 → 114, `orderpile:2` wood
  // 6 → 27, `town:yard` 13 → 0, the 8 wild oaks 124 → 3, session wood 144 at
  // both ends. Nothing was destroyed. Nothing could ever move again either:
  // every landed unit is reserved the instant it lands, `commitRefineOrder`
  // returns early while `stagingMissing` is non-empty, and no timeout,
  // preemption or yield existed anywhere. Site: `0% worked`, forever.
  //
  // The rows below are that measured pair, to the unit.

  /** THE MEASURED FRONTIER STANDOFF, to the unit (`/orders` at t≈420 s of
   *  `transcripts/fix-deadlock-frontier.txt`): one big mill sitting on 114 of
   *  a 132-wood bill IN A WORLD WHOSE REMAINING WOOD CAN NEVER REACH 132, and
   *  two small mills starved beside it at 6/34 and 0/50. Nothing in the world
   *  to fetch. The big row is the hoard; the two small ones are what its wood
   *  could actually finish. */
  function starvedTrio(h: ReturnType<typeof harness>) {
    const post = (count: number, wood: number, have: number, days: number) =>
      h.play.deltas.postRefineOrder({
        produces: "block.material_wood",
        count,
        costs: { wood },
        pile: have > 0 ? { wood: have } : {},
        at: { x: 92.8, y: 96.2 },
        startedDay: 0,
        buildDays: days,
      });
    const big = post(66, 132, 114, 0.82);
    const mid = post(17, 34, 6, 0.21);
    const small = post(25, 50, 0, 0.31);
    return { big, mid, small };
  }

  /** Sweeps far enough apart that the per-pile 20 s haul gate reopens. */
  function sweepPast(h: ReturnType<typeof harness>, times: number) {
    for (let i = 0; i < times; i++) {
      h.session.taskClock += 25;
      h.director.stepFoundedConstruction(h.session, 25);
    }
  }

  it("① a starved pile YIELDS to the sibling it can FINISH — nearest-done first — and that sibling STAGES", () => {
    const h = harness();
    const { big, mid, small } = starvedTrio(h);
    expect(stagingMissing(big)).toEqual({ wood: 18 });
    expect(stagingMissing(mid)).toEqual({ wood: 28 });
    expect(stagingMissing(small)).toEqual({ wood: 50 });
    const total = () =>
      (big.pile["wood"] ?? 0) + (mid.pile["wood"] ?? 0) + (small.pile["wood"] ?? 0);
    expect(total()).toBe(120);

    sweepPast(h, 1);

    // PREEMPT-TO-FEASIBILITY. `big` cannot fetch its last 18 and never will —
    // so the 114 it is sitting on goes to the sibling it can actually finish.
    // BOTH small rows are feasible out of 114; the recipient is the one
    // NEAREST DONE (6/34 beats 0/50), which is the deterministic pick.
    expect(mid.pile).toEqual({ wood: 34 });
    expect(big.pile).toEqual({ wood: 86 });
    expect(small.pile).toEqual({});
    expect(stagingMissing(mid)).toEqual({});
    // ⚖️ #43 ②b: these three piles stand on ONE spot, so the release is a
    // LEDGER move — silent by law (a porter walking wood from the yard to
    // the yard was the measured "circling the crate" disease). The far-apart
    // release still walks and still speaks: pinned in
    // town-construction-phase4.test.ts (#43 ②b).
    expect(h.toasts.some((t) => t.startsWith("🔁"))).toBe(false);
    // 🚨 CONSERVATION: a release MOVES units, it never mints or burns one.
    expect(total()).toBe(120);

    // …and the point of the whole exercise: a mill can now RUN. Pre-fix this
    // line is unreachable — the site sat at 0 % for the entire 1 237 s run
    // with every raw in the world locked inside piles that could not move.
    sweepPast(h, 1);
    expect(mid.laborStartDay).not.toBeUndefined();
    expect(h.toasts.some((t) => t.includes("materials in — milling 17 block"))).toBe(true);
  });

  it("① the release TERMINATES: each recipient stages out of the pool, and the donor stops", () => {
    const h = harness();
    const { big, mid, small } = starvedTrio(h);
    sweepPast(h, 6);
    // Second window: `small` is now the only unfed sibling, and 86 covers its
    // 50. Third: nobody is left that 36 can finish, so the donor HOLDS — the
    // release path is not a treadmill, it stops when it can do no more good.
    expect(small.pile).toEqual({ wood: 50 });
    expect(big.pile).toEqual({ wood: 36 });
    // ⚖️ #43 ②b: both releases are co-located ledger moves now — silent, so
    // the cascade leaves NO 🔁 lines (was 2). The movement assertions above
    // are the pin's real content; the voice belongs to far-apart releases.
    expect(h.toasts.filter((t) => t.startsWith("🔁")).length).toBe(0);
    // 🚨 ONE-WAY DOOR: a staged recipient leaves the arbitration pool, so
    // nothing it received can ever be released back out of it.
    expect(mid.laborStartDay).not.toBeUndefined();
    expect(small.laborStartDay).not.toBeUndefined();
    expect((big.pile["wood"] ?? 0) + 34 + 50).toBe(120);
  });

  it("① NO PING-PONG: two starved siblings with no feasible recipient hold STEADY", () => {
    const h = harness();
    // Neither can finish the other: 40 held vs 70 wanted, 30 held vs 60 wanted.
    const a = h.play.deltas.postRefineOrder({
      produces: "block.material_wood", count: 90, costs: { wood: 100 }, pile: { wood: 40 },
      at: { x: 10, y: 10 }, startedDay: 0, buildDays: 3,
    });
    const b = h.play.deltas.postRefineOrder({
      produces: "block.material_wood", count: 90, costs: { wood: 100 }, pile: { wood: 30 },
      at: { x: 10, y: 10 }, startedDay: 0, buildDays: 3,
    });
    expect(h.play.deltas.orders().length).toBe(2);

    sweepPast(h, 5);

    // FEASIBILITY-ONLY is the whole anti-oscillation argument: a release that
    // would merely move a shortage is not made at all, so there is nothing to
    // oscillate. Holding is CORRECT here — when the trees grow back, "none to
    // fetch" clears and ordinary filling resumes.
    expect(a.pile).toEqual({ wood: 40 });
    expect(b.pile).toEqual({ wood: 30 });
    expect(h.toasts.some((t) => t.startsWith("🔁"))).toBe(false);
    // …and the honest starved line is still spoken, once per retry window.
    expect(h.toasts.some((t) => t.includes("and there is none to fetch"))).toBe(true);
  });

  it("① CANCELLING a site releases its hoard — the pile banks back to the yard", () => {
    const h = harness();
    const b = h.play.deltas.foundBuilding(LOT, 0, 50, { [BLOCK_GLYPH]: 6 });
    b.pile = { [BLOCK_GLYPH]: 4 };
    const banked0 = h.play.deltas.stock[BLOCK_GLYPH] ?? 0;

    expect(h.director.cancelWork(h.session, `site_wf_${b.ord}`)).toBe(true);

    // Conservation on the OTHER release path (the one that already worked, and
    // must keep working): a changed mind never costs the town its materials.
    expect(h.play.deltas.stock[BLOCK_GLYPH] ?? 0).toBe(banked0 + 4);
    expect(h.play.deltas.orders().some((o) => o.ord === b.ord)).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ② A SPOKEN BILL IS SIZED TO SUPPLY, AND A ZERO CLAMP REFUSES ALOUD

  it("② a spoken mill with NO free raw is refused VOCALLY, not silently posted", () => {
    const CLERK = "resident_clerk";
    const h = harness(BLOCK_GLYPH, CLERK);
    // A spoken site wanting blocks, in a world with an empty yard and no wood
    // anywhere: the chain has nothing to chain to.
    const b = h.play.deltas.foundBuilding(LOT, 0, 50, { [BLOCK_GLYPH]: 6 });
    b.spoken = true;

    sweepPast(h, 1);

    // NO ROW WAS POSTED — the old `if (!spoken)` skipped the cap outright, so
    // this posted a full-size mill against a shelf that cannot feed one unit
    // of it (and two books doing that is the 237-wood deadlock above).
    expect(h.play.deltas.orders().filter((o) => o.kind === "refine").length).toBe(0);
    // BOTH CHANNELS. The banner is unconditional…
    expect(
      h.toasts.some((t) => /can't mill the block — there is no (wood|stone) to cut/.test(t)),
    ).toBe(true);
    // …and the addressed clerk says no out loud. A banner on its own is a
    // `saySystem`, which the vocal-refusal law does not accept.
    expect(h.bubbles).toContainEqual({ cid: CLERK, line: "no" });
  });

  it("② a PARTIAL clamp still posts — a feedable bill is never refused", () => {
    const h = harness();
    // 20 free wood on the shelf: not the whole appetite, but enough to mill
    // something. ⑥ stands — an order that CAN be fed is posted and waits.
    h.containerRecords.get(TOWN_YARD_EP)!.stock!["wood"] = 20;
    const b = h.play.deltas.foundBuilding(LOT, 0, 50, { [BLOCK_GLYPH]: 400 });
    b.spoken = true;

    sweepPast(h, 1);

    const mills = h.play.deltas.orders().filter((o) => o.kind === "refine");
    expect(mills.length).toBe(1);
    // Clamped to what the shelf can actually feed, and strictly under the
    // 400 asked for — the appetite is not the supply.
    expect(mills[0]!.count).toBeGreaterThan(0);
    expect(mills[0]!.count).toBeLessThan(400);
    expect(h.toasts.some((t) => /can't mill the block/.test(t))).toBe(false);
  });
});
