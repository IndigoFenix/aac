/**
 * Step 7 — zoom-in play (§6 sampling), seamless edition: one world at one
 * scale. The bounded scene sampler stays certified + deterministic; the
 * seamless world spec is terrain-free (terrain streams through the
 * constraint + view seams); villages stream as chunks with an NPC budget
 * through the engine's runtime addNpc/removeNpc seam; recruited villagers
 * pin into the party without breaking the population ledger.
 */

import { describe, expect, it } from "vitest";
import { runWorldHost } from "@shared/world-engine/world-host";
import { buildAcceptanceTri } from "../tri-worlds";
import { createTravelerBands } from "../traveler-bands";
import { ERRAND_WALK } from "../food";
import {
  HOUSEHOLD, PEOPLE_R, TOWN_LOAD_R, TOWN_UNLOAD_R, WORLD_TILE,
  createParty, createTownManager, disbandParty, generateScene, generateWorld,
  nearestCity, parkParty, recruitVillager, terrainConstraint, townPlan,
  villagerOf, worldPos,
} from "../zoom";

describe("zoom-in scenes (§6 sampling)", () => {
  it("generates a certified, deterministic scene from local state", async () => {
    const a = await buildAcceptanceTri(42);
    await a.tri.advanceDays(10);

    const scene = generateScene(a.tri, "riverton", { seed: 7 });

    // Certified by the world-engine's own gate (generateScene throws on
    // failure — reaching here IS the certification assert).
    expect(scene.spec.engine).toBe("world");
    expect(scene.spec.spawns.length).toBeGreaterThan(0);

    // Settlement scalars project into buildings: the hall always, farms
    // for a farm town (riverton charters real farmland).
    const ids = (scene.spec.buildings ?? []).map(b => b.id);
    expect(ids).toContain("hall_0");
    expect(ids).toContain("farm_0");
    expect(scene.biome).toBe("farmland");

    // Composition projects into villagers with STABLE identity: the same
    // people, names included, on every visit.
    expect(scene.villagers.length).toBeGreaterThanOrEqual(2);
    for (const [i, v] of scene.villagers.entries()) {
      const again = a.tri.dual.sampleVillager("riverton", v.index);
      expect(again?.name).toBe(v.name);
      expect(scene.spec.npcs?.[i]?.name).toBe(v.name);
    }

    // Same world state + same seed ⇒ byte-identical scene.
    const twin = generateScene(a.tri, "riverton", { seed: 7 });
    expect(JSON.stringify(twin.spec)).toBe(JSON.stringify(scene.spec));
  });

  it("biome follows the charter: the mountain town reads as a mining scene", async () => {
    const a = await buildAcceptanceTri(42);
    const valley = generateScene(a.tri, "riverton", { seed: 7 });
    const mountain = generateScene(a.tri, "kragholm", { seed: 7 });

    expect(mountain.biome).toBe("mining");
    expect((mountain.spec.buildings ?? []).map(b => b.id)).toContain("mine_0");
    expect(mountain.spec.terrain.groundColor).not.toBe(valley.spec.terrain.groundColor);
  });

  it("party: recruit, park, return, disband — ledger stays balanced", async () => {
    const a = await buildAcceptanceTri(42);
    const d = a.tri.dual;
    const balance = (): number => d.totalPop() + d.histfigCount();
    const before = balance();

    // Recruit two villagers the player "engaged" in the world.
    const party = createParty();
    const first = recruitVillager(a.tri, party, "riverton", 0);
    const second = recruitVillager(a.tri, party, "riverton", 1);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(d.histfigCount()).toBe(2);
    expect(balance()).toBe(before); // pinning moves people, never makes them

    // Leaving parks the party; the world above keeps moving.
    parkParty(party, "riverton");
    expect(party.parkedAt).toBe("riverton");
    await a.tri.advanceDays(5);
    expect(balance()).toBeGreaterThan(0);

    // Returning: the regenerated scene contains the party as followers.
    const back = generateScene(a.tri, "riverton", { seed: 7, party: party.members });
    const partyNpcs = (back.spec.npcs ?? []).filter(n => n.id.startsWith("party_"));
    expect(partyNpcs.length).toBe(2);
    expect(partyNpcs.every(n => n.behavior?.movement === "approach_nearest")).toBe(true);
    expect(partyNpcs.map(n => n.name)).toEqual(party.members.map(m => m.name));

    // Disband: everyone rebins into the distribution, ledger intact.
    const preDisband = balance();
    expect(disbandParty(a.tri, party)).toBe(2);
    expect(d.histfigCount()).toBe(0);
    expect(balance()).toBe(preDisband);
    expect(party.parkedAt).toBeNull();
  });
});

describe("the seamless world (one scale, no village boundary)", () => {
  it("spans the whole substrate, carries NO terrain, and is deterministic", async () => {
    const a = await buildAcceptanceTri(42);
    const w = generateWorld(a.tri, { seed: 7, atCity: "riverton" });

    // Manifold = the whole grid at the ONE world scale.
    expect(w.spec.manifold.width).toBe(a.tri.grid.cols * WORLD_TILE);
    expect(w.spec.manifold.height).toBe(a.tri.grid.rows * WORLD_TILE);

    // One spawn per city, id = city key, at the city's tile-center.
    expect(w.spec.spawns.map(s => s.id)).toEqual(a.tri.cities.map(c => c.key));
    for (const c of a.tri.cities) {
      const s = w.spec.spawns[w.spawnIndexOf.get(c.key)!];
      expect(s).toEqual({ id: c.key, ...worldPos(c.x, c.y) });
    }

    // The spec holds NO terrain and NO village content — all of that
    // streams through the constraint/view/addNpc seams at runtime, so
    // the spec stays tiny regardless of map size or city count.
    expect(w.spec.structures ?? []).toHaveLength(0);
    expect(w.spec.buildings ?? []).toHaveLength(0);
    expect(w.spec.npcs ?? []).toHaveLength(0);

    const twin = generateWorld(a.tri, { seed: 7, atCity: "riverton" });
    expect(JSON.stringify(twin.spec)).toBe(JSON.stringify(w.spec));
  });

  it("terrain collision reads the live grid: cities walkable, major rivers block", async () => {
    const a = await buildAcceptanceTri(42);
    const { grid } = a.tri;
    const con = terrainConstraint(grid);
    const R = 0.4; // engine avatar radius

    for (const c of a.tri.cities) {
      expect(con.walkable(worldPos(c.x, c.y), R)).toBe(true);
    }

    let riverTile = -1;
    for (let i = 0; i < grid.cols * grid.rows; i++) {
      if (grid.fields.river[i] > 45) { riverTile = i; break; }
    }
    expect(riverTile).toBeGreaterThanOrEqual(0);
    const rp = worldPos(riverTile % grid.cols, Math.floor(riverTile / grid.cols));
    expect(con.walkable(rp, R)).toBe(false);
    expect(con.walkable({ x: -1, y: 5 }, R)).toBe(false);

    const rc = a.tri.cities.find(c => c.key === "riverton")!;
    const near = nearestCity(a.tri, worldPos(rc.x, rc.y))!;
    expect(near.key).toBe("riverton");
    expect(near.distance).toBeLessThan(0.01);
  });

  it("towns are real-scale: houses match population and plans are prefix-stable", async () => {
    const a = await buildAcceptanceTri(42);
    const plan = townPlan(a.tri, "riverton", 7);
    const pop = a.tri.dual.settlementScalar("riverton", "population");

    // A town that holds thousands of people HAS the houses for them
    // (street corridors eat a few lots — the loss stays small).
    const lots = Math.max(6, Math.round(pop / HOUSEHOLD));
    expect(pop).toBeGreaterThan(1000);
    expect(plan.houses.length).toBeGreaterThan(lots * 0.7);
    expect(plan.houses.length).toBeLessThanOrEqual(lots);
    // ...at real footprint: hundreds of meters across, inside its km tile.
    expect(plan.radius).toBeGreaterThan(100);
    expect(plan.radius).toBeLessThan(WORLD_TILE / 2);
    expect(plan.works.some(w => w.type === "hall")).toBe(true);

    // Deterministic, and PREFIX-STABLE across population change: after
    // days of growth/decline, the houses both plans share sit on
    // byte-identical lots (growth appends at the edge — the town the
    // player knows never reshuffles).
    const twin = townPlan(a.tri, "riverton", 7);
    expect(JSON.stringify(twin)).toBe(JSON.stringify(plan));
    await a.tri.advanceDays(30);
    const later = townPlan(a.tri, "riverton", 7);
    expect(later.houses.length).not.toBe(plan.houses.length); // vitals moved it
    const byIndex = new Map(later.houses.map(h => [h.index, h]));
    for (const h of plan.houses.slice(0, Math.min(plan.houses.length, later.houses.length) - 1)) {
      const l = byIndex.get(h.index);
      if (!l) continue; // tail difference only
      expect([l.dx, l.dy, l.w, l.h, l.door]).toEqual([h.dx, h.dy, h.w, h.h, h.door]);
    }
  });

  it("residents stream house-by-house: nearest K within the live budget", async () => {
    const a = await buildAcceptanceTri(42);
    const rc = a.tri.cities.find(c => c.key === "riverton")!;
    const home = worldPos(rc.x, rc.y);
    let budget = 6;
    const mgr = createTownManager(a.tri, 7, () => budget);

    // Radii: town data loads with hysteresis; people embody well past
    // the street-level camera reach.
    expect(TOWN_UNLOAD_R).toBeGreaterThan(TOWN_LOAD_R);
    expect(PEOPLE_R).toBeGreaterThan(120);

    // Standing on the plaza: the town loads, the K nearest residents
    // step out — tethered to home, identities from the sampler.
    const first = mgr.update(home);
    expect(mgr.loaded().map(t => t.key)).toContain("riverton");
    expect(first.spawn).toHaveLength(6);
    expect(mgr.active()).toBe(6);
    expect(first.spawn.every(s => (s.npc.behavior?.wanderRadius ?? 0) > 0)).toBe(true);
    // Every body is anchored to its own house, wherever it spawned, and
    // strolls at the food-cycle pace (body and projection stay in step).
    expect(first.spawn.every(s => s.npc.behavior?.home !== undefined)).toBe(true);
    expect(first.spawn.every(s => s.npc.behavior?.speed === ERRAND_WALK)).toBe(true);
    for (const { npc: n } of first.spawn) {
      const who = villagerOf(n.id)!;
      expect(who.siteKey).toBe("riverton");
      expect(a.tri.dual.sampleVillager(who.siteKey, who.index)?.name).toBe(n.name);
    }
    // Deterministic: a twin manager picks the same people at the same doors.
    const twin = createTownManager(a.tri, 7, () => 6).update(home);
    expect(JSON.stringify(twin.spawn)).toBe(JSON.stringify(first.spawn));

    // Walk down the street: the cast follows the player — some of the
    // previous houses' residents go back in, nearer doors open.
    const walked = mgr.update({ x: home.x + 150, y: home.y });
    expect(walked.despawn.length).toBeGreaterThan(0);
    expect(walked.spawn.length).toBe(walked.despawn.length); // budget refilled
    expect(mgr.active()).toBe(6);

    // The budget is live (the party grew): surplus residents despawn.
    budget = 2;
    const squeezed = mgr.update({ x: home.x + 150, y: home.y });
    expect(squeezed.spawn).toHaveLength(0);
    expect(mgr.active()).toBe(2);

    // A recruited resident left the crowd: excluded for the session.
    budget = 6;
    const refill = mgr.update({ x: home.x + 150, y: home.y });
    const recruitedId = refill.spawn[0]?.npc.id ?? "";
    expect(recruitedId).toBeTruthy();
    mgr.release(recruitedId);
    const after = mgr.update({ x: home.x + 150, y: home.y });
    expect(after.spawn.map(s => s.npc.id)).not.toContain(recruitedId);
    expect(mgr.active()).toBe(6); // someone else stepped out instead

    // Leaving town far behind unloads its data.
    mgr.update({ x: home.x + TOWN_UNLOAD_R + 200, y: home.y });
    expect(mgr.loaded().map(t => t.key)).not.toContain("riverton");
  });

  it("no blink-outs: bodies rank where they ARE, hold their slot beside the player, and host truth heals ghosts", async () => {
    const { PEOPLE_EVICT_MIN } = await import("../zoom");
    const a = await buildAcceptanceTri(42);
    const rc = a.tri.cities.find(c => c.key === "riverton")!;
    const home = worldPos(rc.x, rc.y);
    const mgr = createTownManager(a.tri, 7, () => 3);

    const first = mgr.update(home);
    expect(first.spawn).toHaveLength(3);
    const liveAt = (pts: Array<[string, { x: number; y: number }]>): Map<string, { x: number; y: number }> => new Map(pts);
    const spawnedLive: Array<[string, { x: number; y: number }]> =
      first.spawn.map(({ npc: n }) => [n.id, { x: n.x, y: n.y }]);

    // Stroll 25 m: nearer doorsteps now outrank the spawned three, but
    // everyone's BODY is still beside the player (< PEOPLE_EVICT_MIN) —
    // nobody blinks out, nobody new shoves in. The cast is stable.
    const stroll = mgr.update({ x: home.x + 25, y: home.y }, liveAt(spawnedLive));
    expect(stroll.despawn).toHaveLength(0);
    expect(stroll.spawn).toHaveLength(0);

    // A wanderer's DESPAWN follows their body too: one body drifts far
    // (past the people radius) while their house stays close — THEY are
    // culled; the two beside the player stay.
    const [farId, ...nearRest] = first.spawn.map(s => s.npc.id);
    const drifted = mgr.update(home, liveAt([
      [farId, { x: home.x + PEOPLE_R + 40, y: home.y }],
      ...spawnedLive.filter(([id]) => id !== farId),
    ]));
    expect(drifted.despawn).toContain(farId);
    expect(nearRest.every(id => !drifted.despawn.includes(id))).toBe(true);
    expect(PEOPLE_EVICT_MIN).toBeLessThan(PEOPLE_R);

    // HOST TRUTH heals ledger drift (the silent-town bug): a body the
    // host never actually held (rejected addNpc) is forgotten and
    // respawns instead of haunting the ledger forever.
    const fresh = createTownManager(a.tri, 7, () => 3);
    const f1 = fresh.update(home);
    const ghost = f1.spawn[0].npc.id;
    const f2 = fresh.update(home, liveAt(
      f1.spawn.slice(1).map(({ npc: n }) => [n.id, { x: n.x, y: n.y }]),
    ));
    expect(f2.spawn.map(s => s.npc.id)).toContain(ghost);
    expect(fresh.active()).toBe(3);

    // release → restore round trip (the recruit/disband path). Release
    // is silent (the caller already removed the body); the person stops
    // streaming and someone else takes the slot — until restored.
    fresh.release(ghost);
    const gone = fresh.update(home, liveAt(
      f1.spawn.slice(1).map(({ npc: n }) => [n.id, { x: n.x, y: n.y }]),
    ));
    expect(gone.spawn.map(s => s.npc.id)).not.toContain(ghost);
    expect(gone.spawn.length).toBeGreaterThan(0); // a replacement stepped out
    fresh.restore(ghost);
    const back = fresh.update(home, liveAt([]));
    expect(back.spawn.map(s => s.npc.id)).toContain(ghost);
  });

  it("nearby buildings become REAL engine structures: blocking walls + swinging doors", async () => {
    const { structuresWalkable, createWorldState, setWorldStructures } = await import("@shared/world-engine/engine");
    const a = await buildAcceptanceTri(42);
    const rc = a.tri.cities.find(c => c.key === "riverton")!;
    const home = worldPos(rc.x, rc.y);
    const mgr = createTownManager(a.tri, 7, () => 4);

    // On the plaza: the surrounding houses stream in as walls AND doors.
    const first = mgr.update(home);
    expect(first.structures).toBeDefined();
    expect(first.structures!.length).toBeGreaterThan(20);
    expect(first.structures!.some(s => s.kind === "wall")).toBe(true);
    expect(first.structures!.some(s => s.kind === "door")).toBe(true);

    // Unchanged position ⇒ no re-send; moving a street over ⇒ a new set.
    expect(mgr.update(home).structures).toBeUndefined();
    const moved = mgr.update({ x: home.x + 220, y: home.y });
    expect(moved.structures).toBeDefined();

    // Fed to the engine, a streamed wall BLOCKS and door state is live —
    // the same machinery the bounded scenes used, streamed.
    const w = generateWorld(a.tri, { seed: 7, atCity: "riverton" });
    const state = createWorldState(w.spec, "player", w.spawnIndexOf.get("riverton") ?? 0);
    setWorldStructures(state, first.structures!);
    const wall = first.structures!.find(s => s.kind === "wall")!;
    const mid = { x: (wall.a.x + wall.b.x) / 2, y: (wall.a.y + wall.b.y) / 2 };
    expect(structuresWalkable(state, mid, 0.4, 0)).toBe(false);
    const door = first.structures!.find(s => s.kind === "door")!;
    expect(state.doors[door.id]).toBeDefined();

    // Door state SURVIVES a re-stream (a door left open stays open)...
    state.doors[door.id].open = 0.8;
    setWorldStructures(state, first.structures!);
    expect(state.doors[door.id].open).toBe(0.8);
    // ...and clears with an empty stream (walked far away).
    setWorldStructures(state, []);
    expect(Object.keys(state.doors)).toHaveLength(0);
    expect(structuresWalkable(state, mid, 0.4, 0)).toBe(true);
  });

  it("wander is tethered: a wanderRadius NPC never aims outside its home disc", async () => {
    const { createNpcController } = await import("@shared/world-engine/npc-controller");
    const ctrl = createNpcController({
      id: "v", x: 100, y: 100,
      behavior: { movement: "wander", conversationRadius: 5, wanderRadius: 12 },
    });
    // Deterministic rng; the self stays at home so every returned aim is
    // a fresh waypoint pick (worst case for the tether).
    let s = 42;
    const rng = (): number => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    let now = 0;
    for (let i = 0; i < 200; i++) {
      now += 5; // past any pause
      const aim = ctrl.computeAim({
        self: { id: "v", x: 100, y: 100, fx: 1, fy: 0, vx: 0, vy: 0, floor: 0 },
        humans: [],
        now,
        width: 800,
        height: 600,
        rng,
      });
      if (aim) {
        expect(Math.hypot(aim.x - 100, aim.y - 100)).toBeLessThanOrEqual(12 + 1e-9);
      }
    }
  });

  it("traveler bands walk the roads as mobile mini-sites and embody near the player", async () => {
    const a = await buildAcceptanceTri(42);
    await a.tri.advanceDays(10); // let goods flow on the riverton–kragholm road
    const bands = createTravelerBands(a.tri, 7, () => 8);

    // The flow field breeds traffic; positions are deterministic and MOVE.
    const t0 = bands.bands(100);
    expect(t0.length).toBeGreaterThan(0);
    const twin = createTravelerBands(a.tri, 7, () => 8).bands(100);
    expect(JSON.stringify(twin.map(s => [s.band.id, s.x, s.y]))).toBe(
      JSON.stringify(t0.map(s => [s.band.id, s.x, s.y])),
    );
    const later = bands.bands(110);
    expect(Math.hypot(later[0].x - t0[0].x, later[0].y - t0[0].y)).toBeGreaterThan(1);

    // Members are sampled from the ORIGIN site, offset above the resident
    // index range — a traveler is never also a square-stander.
    for (const s of t0) {
      expect(s.band.members.length).toBeGreaterThanOrEqual(2);
      for (const m of s.band.members) {
        expect(m.siteKey).toBe(s.band.from);
        expect(m.index).toBeGreaterThanOrEqual(1_000_000);
      }
    }

    // Standing on a band: it embodies (bodies + a road errand target),
    // and the snapshot flips to embodied so the view drops its dot.
    // (Other bands in range may embody too — assert on THIS band's.)
    const target = t0[0].band;
    const here = { x: t0[0].x, y: t0[0].y };
    const up = bands.update(here, 100);
    expect(up.spawn.every(t => t.npc.id.startsWith("traveler_"))).toBe(true);
    const mine = up.spawn.filter(t => t.npc.id.startsWith(`traveler_${target.id}_`));
    expect(mine.length).toBe(target.members.length);
    const dest = worldPos(
      a.tri.cities.find(c => c.key === target.to)!.x,
      a.tri.cities.find(c => c.key === target.to)!.y,
    );
    expect(mine[0].walkTo).toEqual(dest);
    expect(bands.active()).toBe(up.spawn.length);
    expect(bands.bands(100).find(s => s.band.id === target.id)?.embodied).toBe(true);

    // Walking far away releases the bodies; the band keeps moving as a dot.
    const away = bands.update({ x: here.x + 20 * WORLD_TILE, y: here.y + 20 * WORLD_TILE }, 130);
    expect(away.despawn.sort()).toEqual(up.spawn.map(t => t.npc.id).sort());
    expect(bands.active()).toBe(0);
  });

  it("the engine streams NPCs at runtime: addNpc spawns, removeNpc despawns", async () => {
    const a = await buildAcceptanceTri(42);
    const w = generateWorld(a.tri, { seed: 7, atCity: "riverton" });

    // Headless host: fake view, manual clock — the engine needs no DOM.
    const frames: Array<(nowMs: number) => void> = [];
    let clock = 0;
    const host = runWorldHost({
      view: {
        screenToWorld: () => null,
        render: () => { /* headless */ },
        resize: () => { /* headless */ },
        dispose: () => { /* headless */ },
      },
      spec: w.spec,
      localId: "player",
      spawnIndex: w.spawnIndexOf.get("riverton") ?? 0,
      hostNpcs: true,
      npcRng: () => 0.5,
      scheduleFrame: cb => {
        frames.push(cb);
        return () => { /* cancelled */ };
      },
      now: () => clock,
    });
    host.start();
    const step = (): void => {
      clock += 16;
      frames.shift()?.(clock);
    };

    const me = host.state.avatars["player"];
    const ok = host.addNpc({
      id: "villager_riverton_0",
      x: me.x + 2,
      y: me.y,
      name: "Testa",
      behavior: { movement: "stationary", conversationRadius: 5 },
    });
    expect(ok).toBe(true);
    expect(host.state.avatars["villager_riverton_0"]).toBeDefined();
    expect(host.addNpc({ id: "villager_riverton_0", x: 0, y: 0 })).toBe(false); // dup

    // The streamed NPC participates in proximity like a spec NPC would.
    step();
    step();

    expect(host.removeNpc("villager_riverton_0")).toBe(true);
    expect(host.state.avatars["villager_riverton_0"]).toBeUndefined();
    expect(host.removeNpc("villager_riverton_0")).toBe(false);
    host.stop();
  });
});
