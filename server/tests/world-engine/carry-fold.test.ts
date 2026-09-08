// ⚖️ A FOLDED CARRIER'S LOAD FOLDS WITH IT (2026-09-06 carry-integrity round).
//
// THE DEFECT. `removeAvatar` deleted the avatar and left every object with
// `carriedBy === <that id>` pointing at a body that no longer existed — a
// fifth, illegal location: invisible to tidy, to drop, to every collect row,
// frozen where it stood. `simulateObject` holds a carried object one step ahead
// of its carrier, so the moment the streamer re-embodied a household the prop
// SNAPPED onto whichever body took that id. Measured on the frontier arc, both
// dts: four props converging 20–54 m in a single frame — the user's
// *"logs getting teleported"*.
//
// THE RULE, in two arms (main's ruling B):
//   • THE RECORD ARM — the streamer's fold takes the carried prop out of the
//     world WITH the body and keeps it on the body's own record (`mount:
//     "folded"`, `foldedCarryIndex`), so the unfold re-attaches it at the
//     body's NEW position. Exercised by the booted arc below.
//   • THE FLOOR — `removeAvatar` itself RELEASES whatever it is carrying, in
//     place. Every other removal (a despawn, a peer leaving, a demotion with no
//     record for hands) lands here, and it is what makes "never a dangling
//     `carriedBy`" true by construction.
//
// `npm run test:engine -- carry-fold`

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  carryObject,
  createWorldState,
  removeAvatar,
  tickWorld,
  type WorldState,
} from "@shared/world-engine/engine.js";
import type { WorldSpec } from "@shared/world-engine/types.js";
import {
  setFoldedCarry,
  clearFoldedCarry,
  foldedCarryOf,
  recordOf,
  type ContainerRegistry,
} from "@shared/world-engine/kernel/town/containers.js";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";

// ── THE FLOOR: removeAvatar releases, it never orphans ──────────────────────

/** One carryable prop per id — the shape `spawnLooseProp` mints. */
function propSpec(id: string, x: number, y: number) {
  return { id, x, y, shape: "sphere" as const, radius: 0.3, interactions: ["carry"] };
}

function spec(): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "x" },
    manifold: { kind: "flat", width: 60, height: 60 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 5, y: 5, facing: 0 }],
    objects: [propSpec("small:probe", 10, 10), propSpec("small:other", 20, 20)],
    multiplayer: { maxPlayers: 4, authority: "distributed" },
    content: { kind: "sandbox" },
  } as unknown as WorldSpec;
}

/** The smallest world that can hold a body and a thing: one avatar, two props. */
function worldWithCarrier(): { state: WorldState; step: () => void } {
  const state = createWorldState(spec(), "player", 0);
  state.avatars["porter"] = {
    id: "porter", x: 10, y: 10, vx: 0, vy: 0, fx: 1, fy: 0, floor: 0,
  } as never;
  return { state, step: () => tickWorld(state, { aim: null }, 1 / 60) };
}

describe("removeAvatar — nothing is carried by a body that does not exist", () => {
  it("🚨 releases the load IN PLACE: the prop stays, uncarried, where the body stood", () => {
    const { state } = worldWithCarrier();
    expect(carryObject(state, "small:probe", "porter")).toBe(true);
    // The carry solver has put it a step in front of the carrier; that spot is
    // where the fold happens, and where it must stay.
    const at = { x: state.objects["small:probe"]!.x, y: state.objects["small:probe"]!.y };

    removeAvatar(state, "porter");

    const prop = state.objects["small:probe"];
    expect(prop).toBeDefined();
    expect(prop!.carriedBy).toBeNull(); // ← the whole defect: this used to stay "porter"
    expect(prop!.x).toBeCloseTo(at.x, 6);
    expect(prop!.y).toBeCloseTo(at.y, 6);
  });

  it("…so a body that comes back under the SAME id cannot snap it across the map", () => {
    const { state, step } = worldWithCarrier();
    carryObject(state, "small:probe", "porter");
    const at = { x: state.objects["small:probe"]!.x, y: state.objects["small:probe"]!.y };
    removeAvatar(state, "porter");
    // The streamer re-embodies the household 40 m away — the measured shape
    // (two carriers re-spawning on one house anchor, four props converging).
    state.avatars["porter"] = {
      id: "porter", x: 50, y: 50, vx: 0, vy: 0, fx: 1, fy: 0, floor: 0,
    } as never;
    step();
    const prop = state.objects["small:probe"]!;
    expect(Math.hypot(prop.x - at.x, prop.y - at.y)).toBeLessThan(0.001);
  });

  it("touches only THAT body's load — a second carrier keeps its own", () => {
    const { state } = worldWithCarrier();
    state.avatars["other"] = {
      id: "other", x: 20, y: 20, vx: 0, vy: 0, fx: 1, fy: 0, floor: 0,
    } as never;
    carryObject(state, "small:probe", "porter");
    carryObject(state, "small:other", "other");
    removeAvatar(state, "porter");
    expect(state.objects["small:probe"]!.carriedBy).toBeNull();
    expect(state.objects["small:other"]!.carriedBy).toBe("other");
  });

  it("is still a no-op for the local body (an unremovable avatar keeps its hands)", () => {
    const { state } = worldWithCarrier();
    state.avatars["player"] = {
      id: "player", x: 5, y: 5, vx: 0, vy: 0, fx: 1, fy: 0, floor: 0,
    } as never;
    carryObject(state, "small:probe", "player");
    removeAvatar(state, "player");
    expect(state.avatars["player"]).toBeDefined();
    expect(state.objects["small:probe"]!.carriedBy).toBe("player");
  });
});

// ── THE RECORD ARM: the fold moves the row, never the goods ────────────────

describe("setFoldedCarry / clearFoldedCarry — the hands' twin of the worn bag", () => {
  const registry = (): ContainerRegistry => ({
    containerRecords: new Map(),
    wornBagIndex: new Map(),
    foldedCarryIndex: new Map(),
  });

  it("keeps the glyph, the relation, the owner and — the whole point — the STOCK", () => {
    const reg = registry();
    const rec = recordOf(reg, "small:basket");
    rec.mount = "loose";
    rec.glyph = "basket";
    rec.relation = "in";
    rec.owner = "h_8";
    rec.entityId = "ent_1";
    rec.at = 120;
    rec.stock = { block: 8 };

    setFoldedCarry(reg, "small:basket", "resident_8_3");

    expect(rec.mount).toBe("folded");
    expect(rec.holder).toBe("resident_8_3");
    expect(rec.stock).toEqual({ block: 8 }); // eight blocks folded with the body
    expect(rec.glyph).toBe("basket");
    expect(rec.relation).toBe("in");
    expect(rec.owner).toBe("h_8");
    // No world instance while folded — exactly as a worn bag has none.
    expect(rec.entityId).toBeUndefined();
    expect(rec.at).toBeUndefined();
    expect(foldedCarryOf(reg, "resident_8_3")).toEqual({ objId: "small:basket", glyph: "basket" });
  });

  it("round-trips, and is a no-op for a body that folded holding nothing", () => {
    const reg = registry();
    recordOf(reg, "small:basket").glyph = "basket";
    setFoldedCarry(reg, "small:basket", "resident_8_3");
    expect(clearFoldedCarry(reg, "resident_8_3")).toBe("small:basket");
    expect(foldedCarryOf(reg, "resident_8_3")).toBeUndefined();
    expect(reg.containerRecords.get("small:basket")!.holder).toBeUndefined();
    expect(clearFoldedCarry(reg, "resident_9_1")).toBeUndefined();
  });
});

// ── THE ARC: the streamer really folds bodies, and nothing dangles ──────────

const specPath = join(process.cwd(), "scripts", "worlds", "frontier.spec.json");
const doc = JSON.parse(readFileSync(specPath, "utf8"));
/** The transcripts' own dial — a finding here and a finding in the probe are
 *  the same run in two harnesses. */
const SEED = 11;
const DT = 0.5;
/**
 * Long enough to reach the first fold-while-carrying.
 *
 * ⏱️ MEASURED, TWICE. When this pin landed the first carry-fold on this seed was
 * t≈508 s and 600 s carried it. On 2026-09-06 the closer's basket ruling landed
 * — an idle porter now walks its EMPTY basket back to the place it was taken
 * from and sets it down (quest-host `bagHomeAt` / the re-issuable relieve walk)
 * — so bodies stream out holding things LESS OFTEN, which is the point of the
 * ruling and not a defect: over 1 200 s of the same arc the carry-folds went
 * 11 → 6 and the first one moved 507.5 s → **707 s**. 900 s is that plus ~190 s
 * of headroom.
 *
 * ⏱️ MEASURED A THIRD TIME (2026-09-06, carry-residuals round). A haul whose
 * porter cannot reach its basket now asks for ANOTHER basket instead of walking
 * bare (quest-host `avoidBags`), and the arc it is measured on got much shorter
 * for it — materials staged 1 192 s → 635 s, the house finished 1 377 s → 755 s
 * on this very seed. Work that ends sooner means bodies stream out holding
 * things LATER and less often: over 2 000 s, folds 133 / carry-folds **10**, and
 * the first carry-fold moved 707 s → **947.5 s**. 1 200 s is that plus ~250 s of
 * headroom, the same margin the 900 carried.
 *
 * 🚨 THE INVARIANTS DID NOT MOVE — twice now — and are what this file exists
 * for: dangling frames **0** and the worst one-frame prop jump **4.20 m** on
 * every tree measured (round-start, the closer's, and this one, the last over
 * 2 000 s). Only the PREMISE — "the arc really exercises the fold" — has ever
 * needed an arc long enough to still contain one, and no assertion has moved.
 */
const ARC_S = 1200;

describe("frontier arc — a streamed-out carrier never orphans its load", () => {
  let run: TextQuestRun;
  let danglingFrames = 0;
  let folds = 0;
  let foldsCarrying = 0;
  let foldedPeak = 0;
  let worstJump = 0;

  beforeAll(() => {
    run = bootTextQuest({ world: doc, seed: SEED, dt: DT });
    const world = run.host.world!;
    const prev = new Map<string, { x: number; y: number }>();
    let prevAvatars = new Set<string>();
    let carrying = new Set<string>();
    const frames = Math.round(ARC_S / DT);
    for (let f = 0; f < frames; f++) {
      if (f === Math.round(5 / DT)) run.speak("build + house");
      run.stepFrame();

      // ① NOTHING DANGLES, ever. This is the invariant the round exists for.
      for (const o of Object.values(world.state.objects)) {
        if (o.carriedBy && !world.state.avatars[o.carriedBy]) danglingFrames++;
      }
      // ② NOTHING JUMPS. An object absent last frame is a REAPPEARANCE (an
      //    unfolded carry, a doffed bag), not a jump — nothing was on screen to
      //    move — so prune before comparing.
      const present = new Set(Object.keys(world.state.objects));
      for (const id of [...prev.keys()]) if (!present.has(id)) prev.delete(id);
      for (const [id, o] of Object.entries(world.state.objects)) {
        const p = prev.get(id);
        if (p) worstJump = Math.max(worstJump, Math.hypot(o.x - p.x, o.y - p.y));
        prev.set(id, { x: o.x, y: o.y });
      }
      // ③ Did the streamer actually fold anyone? (An arc that folds nobody
      //    proves nothing, so the pin says so out loud.)
      const now = new Set(Object.keys(world.state.avatars));
      for (const id of prevAvatars) {
        if (now.has(id)) continue;
        folds++;
        if (carrying.has(id)) foldsCarrying++;
      }
      prevAvatars = now;
      carrying = new Set(
        Object.values(world.state.objects).filter((o) => o.carriedBy).map((o) => o.carriedBy as string),
      );
      foldedPeak = Math.max(foldedPeak, run.session.foldedCarryIndex.size);
    }
    // ⏱️ 900 s of WALL clock for 1 200 s of SIM. The arc grew with `ARC_S` and
    // measured 433 s here on a machine running three other lanes — comfortably
    // inside this, and uncomfortably close to the 600 s it used to have.
  }, 900_000);

  afterAll(() => run?.dispose());

  it("🚨 no object is EVER carried by an avatar that does not exist", () => {
    expect(danglingFrames).toBe(0);
  });

  it("the arc really exercises the fold — bodies condense, some of them holding things", () => {
    // If either of these is 0 the invariant above is vacuous for this seed, and
    // the pin must be told rather than quietly passing.
    expect(folds).toBeGreaterThan(0);
    expect(foldsCarrying).toBeGreaterThan(0);
    expect(foldedPeak).toBeGreaterThan(0);
  });

  it("no prop moves further in one frame than a body could walk", () => {
    // Measured before the round: 18.9 m at dt 0.5 (and 54 m in the diagnosis's
    // own harness). Measured after: 4.2 m, and that residue is a BODY being
    // re-anchored, not a prop being teleported. 6 m is a ceiling with room for
    // the walk, not a description of the observation.
    expect(worstJump).toBeLessThan(6);
  });
});
