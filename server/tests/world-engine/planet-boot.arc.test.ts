/**
 * 🌍 TEXT MODE BOOTS THE PLANET THE BROWSER BAKES — the planet arm of
 * `bootTextQuest`, end to end (planning-docs/games/world-engine/
 * planet-boot-round.md, S2).
 *
 * ⚖️ THE USER'S LAW (2026-09-10, verbatim): *"Why can't text mode boot a planet
 * world with cities streamed as partners? Text mode isn't supposed to be
 * different from visual mode except for the visual rendering."*
 *
 * 🚨 WHAT THIS REPLACED. `bootTextQuest` refused every scope but `town`, so the
 * frontier planet reached headless mode as a HAND-TYPED TOWN wearing
 * `terrain: "planet"`, and the cell under it was four constants in the harness
 * (`PLANET_CELL_*`: rain 1.0, 12 °C, `eco.tree` 0.35 ⇒ 15.05 oak/ha, a
 * bush·apple·carrot·hazel larder). The world the browser actually bakes has
 * none of that: the founding cell is 12755, a TROPICAL highland forest at
 * 28.4 °C with `eco.tree` 0.24 ⇒ 10.32 oak/ha whose only cultivar is the
 * banana, standing 280 km from its nearest neighbour. Every headless
 * measurement of "the frontier planet" — the whole PART 4 §6 forage forecast
 * included — was taken in a world that does not exist.
 *
 * WHAT THIS FILE PINS:
 *   ① THE SUBSTRATE IS THE BROWSER'S. The parity checksum, the body, the
 *      geology seed, the civ layer's own counts, and the cell the premise
 *      founds on.
 *   ② THE CELL IS MEASURED, NOT CHOSEN — charter, climate, biome, ecology.
 *   ③ CITIES ARE STREAMED AS PARTNERS, which is the user's sentence: the boot
 *      hands the host real settlements and the session BINDS one, priced at the
 *      great-circle chord because a founded site is never a route endpoint.
 *   ④ THE COUNTRYSIDE IS THE CELL'S. `wildMixForBiome` on the measured cell —
 *      oak, banana, rock, and nothing the sample used to invent.
 *   ⑤ ONE CLIMATE, BOTH SEATS — the live farm's (`session.climate`) is the
 *      books' (`TownPlayConfig.climate`), or the visible farm and the abstract
 *      farm size the same ground differently.
 *   ⑥ DETERMINISM — two boots of one document build the identical world.
 *   ⑦ 📜 THE TWO PRODUCERS AGREE. The DECLARED cell document
 *      (`frontier-cell.spec.json`, generated from this very planet) lays the
 *      SAME countryside as the measured planet does. That is what makes the
 *      cheap path honest.
 *
 * 💰 COST: a headless planet boot IS the bake (24–29 s) plus ~2 s of civ.
 * `buildPlanetScope` memoises the substrate per process and per (seed, faceN,
 * compression, scale), so this file's boots share ONE bake inside a jest
 * worker. Everything else here is a read.
 *
 * DB-free / GL-free — `npm run test:engine:arcs -- planet-boot`.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import type { PlanetScope } from "@shared/world-engine/interaction/town/planet-scope.js";

/** THE PLANET HALF of `run.planet`, narrowed. Since S3b the field is
 *  `PlanetScope | RegionScope | null` — one host seat, two substrates — and the
 *  fields this file pins (`checksum`, `body`, `geologySeed`) are the ones only
 *  a baked PLANET can answer. `built` is the discriminator (a region carries
 *  `region`), and the throw is the fixture guard: a run that came back on the
 *  region arm is not the world these assertions are about. */
function planetRecord(run: TextQuestRun): PlanetScope {
  const rec = run.planet;
  if (!rec || !("built" in rec)) {
    throw new Error("planet-boot: the run did not come back on the PLANET arm — fixture broken, not a finding");
  }
  return rec;
}

const WORLDS = join(process.cwd(), "scripts", "worlds");
const readDoc = (name: string): unknown => JSON.parse(readFileSync(join(WORLDS, name), "utf8"));

/** THE DOCUMENT'S OWN SEED. `opts.seed` moves the NPC rng and nothing else —
 *  the world is the document's — so this run says so by passing the same one. */
const SEED = 1337;
const DT = 0.5;

/** Species → count over a session's laid countryside. */
const scatterOf = (run: TextQuestRun): Array<[string, number]> => {
  const sp = new Map<string, number>();
  for (const f of run.session.wilderness?.features ?? []) sp.set(f.species, (sp.get(f.species) ?? 0) + 1);
  return [...sp].sort();
};

/** THE WORLD AS ONE STRING — the shape `headless-determinism.arc.test.ts`
 *  compares (cast, feet, clock, conversation counters), full precision, no
 *  rounding: a digest that rounded would be a tolerance in disguise. */
function digest(run: TextQuestRun): string {
  const ids = Object.keys(run.state.avatars).sort();
  const bodies = ids.map((id) => {
    const a = run.state.avatars[id]!;
    return `  ${id} ${String(a.x)} ${String(a.y)} f${String(a.floor)}`;
  });
  const convos = run.host.conversationAudit().map((c) => `  ${JSON.stringify(c)}`).sort();
  return [`clock=${String(run.session.townClock)}`, `n=${ids.length}`, ...bodies, `convos=${convos.length}`, ...convos].join("\n");
}

describe("🌍 the planet arm — one engine definition, booted headless", () => {
  let run: TextQuestRun;
  let cellRun: TextQuestRun;

  beforeAll(() => {
    run = bootTextQuest({ world: readDoc("frontier-planet.spec.json"), seed: SEED, dt: DT });
    // TEN SIM-SECONDS. The stage's trade line is re-derived by the host's own
    // sweep, so a read at frame 0 catches the pre-sweep abstract row; by t = 1
    // it is the real city (measured on the ten-day arc: bound from bucket −1).
    run.advance(20);
    cellRun = bootTextQuest({ world: readDoc("frontier-cell.spec.json"), seed: SEED, dt: DT });
    cellRun.advance(20);
  }, 900_000);

  afterAll(() => {
    run?.dispose();
    cellRun?.dispose();
  });

  it("① the substrate is the one the browser bakes — checksum, body, civ layer", () => {
    const p = planetRecord(run);
    // THE PARITY PIN: FNV-1a over the substrate's own fields. Two producers
    // that agree on this agree about the planet.
    expect(p.checksum).toBe("ece0d9ba");
    // The home world is SOL's Earth analogue — `pickHomePlanet`'s rule (the
    // most habitable body with a real surface) without building a mesh.
    expect(p.body.id).toBe("Ap2");
    expect(p.geologySeed).toBe(2232455333);
    // …and the civ layer derived off it, all three called BARE, exactly as
    // space-fly / trade-roads / refine call them.
    expect(p.cities.length).toBe(1757);
    expect(p.pairs.length).toBe(2708);
    expect(p.routes.length).toBe(2708);
    // THE FOUNDING CELL. Forest-first among the dry sites — the homestead
    // stands where the timber is.
    expect(p.cell).toBe(12755);
    expect(p.site.key).toBe("frontier");
    expect(p.site.seed).toBe(SEED);
    // The founders carry what the spec says and nothing else (`premise_stock`
    // straight onto the site ledger — baskets included).
    expect(p.site.stock).toEqual({ wood: 14, stone: 6, basket: 2 });
  });

  it("② the cell is MEASURED — charter, climate, biome, ecology", () => {
    const env = planetRecord(run).env;
    // 🚨 THE CHARTER IS NOT `siteTownConfig`'s DEFAULT. A founded config with
    // no substrate under it charters 60/0 out of thin air; this one is
    // `charterBoxAt` over the site's real reach.
    expect(env.charter).toEqual({ farmland: 516, ore_access: 0, timberland: 302 });
    // A TROPICAL HIGHLAND FOREST — not the temperate wood the harness used to
    // assert (rain 1.0, 12 °C, fertility 8, ore 2).
    expect(env.climate.rain).toBeCloseTo(1.0753, 4);
    expect(env.climate.tempC).toBeCloseTo(28.4125, 4);
    expect(env.climate.elevation).toBe(7);
    expect(env.climate.fertility).toBe(12);
    expect(env.climate.ore).toBe(0);
    expect(env.biome).toBe(1); // DEFAULT_BIOSPHERE order: forest
    expect(env.eco.tree).toBeCloseTo(0.24, 6); // was the typed 0.35
    // ⛰️ NO GROUND HEADLESS, and it says so rather than inventing relief no
    // frame would render. The seat is live for the browser producer (S3).
    expect(env.ground).toBeUndefined();
  });

  it("③ 🏙️ CITIES ARE STREAMED AS PARTNERS — the user's own sentence", () => {
    const rows = planetRecord(run).env.partners;
    // `nearbyCityPartners` streams the nearest three.
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.key.startsWith("city:")).toBe(true);
    // NEAREST FIRST, and the nearest is Tarastead — 280.7 km out. At faceN 48
    // on a real-radius Earth a chart cell is 208.9 km and the founding scan
    // floors spacing at one cell, so this IS what "the next town over" means
    // on this world; the abstract `away:` partner's 3 000 m was a fiction.
    expect(rows[0]!.key).toBe("city:12804");
    expect(rows[0]!.distanceM).toBeCloseTo(280723.98, 1);
    expect(rows[1]!.distanceM).toBeGreaterThan(rows[0]!.distanceM);
    expect(rows[2]!.distanceM).toBeGreaterThan(rows[1]!.distanceM);
    // 🚨 PRICED AT THE CHORD, NOT A ROAD, and that is a fact about the premise
    // rather than about the road net: a founded site's registered cell is
    // SYNTHETIC and never a route endpoint, so `cityIncidentRoutes` finds it
    // nothing even though its lattice cell carries a junction's interstates.
    // (The browser splits the same way — the road arm is live only for CITY
    // towns, which pass their own `FlightCity`.)
    for (const r of rows) expect(r.distanceM).toBeGreaterThan(200_000);
    // …and what the distant ground SAYS IT CAN SELL rides along.
    expect(rows[0]!.geo).toEqual({ node: "junction", farmland: 516, ore: 0 });

    // AND THE SESSION BINDS ONE. Read off the stage's own trade view — never
    // instrumented, never a new export.
    const tr = run.session.town!.stage.trade;
    expect(tr).not.toBeNull();
    expect(tr!.route.partnerKey).toBe("city:12804");
    expect(tr!.route.distanceM).toBeCloseTo(280723.98, 1);
    // BOUND: a real settlement standing somewhere, not the abstract stub.
    expect(tr!.route.partnerAt).toBeDefined();
  });

  it("④ the countryside is the CELL's — oak, banana, carrot, rock", () => {
    // `wildMixForBiome(biome, seed, climate, eco)` on the measured cell: the
    // browser's exact call. The 28.4 °C cell admits ONE cultivar and it is the
    // banana; the bush/hazel/apple larder the sample asserted has no
    // hot-climate member and does not stand here.
    //
    // 🥕 THE CARROT JOINS (the resource-packing round), and it always could:
    // its niche is the widest in the catalogue and it admits this cell. What
    // kept it out was the ROUNDING — `forageBase 10 × rarity 0.1 ×
    // suitability` rounds below 0.5, so the line was deleted before the pass
    // that counts plants ever saw it. On the packed arm membership is `fit >
    // 0` and the pass decides how many (6.04 patches a hectare here).
    const mix = planetRecord(run).wildMix;
    expect(new Set(mix.map((m) => m.species)))
      .toEqual(new Set(["oak", "banana_plant", "carrot_plant", "rock"]));
    // PER-HECTARE, which is the ONE predicate that makes the near-stand disc
    // bind and the neighbouring tiles mint (`mix.some(e => e.perHa !== undefined)`).
    for (const m of mix) expect(m.perHa).toBeGreaterThan(0);
    expect(mix.find((m) => m.species === "oak")!.perHa).toBeCloseTo(10.32, 6);
    // …and the session really did mint the ring off it.
    expect([...run.session.areaRecords.keys()].some((k) => k.startsWith("tile"))).toBe(true);
  });

  it("⑤ ONE climate sample reaches BOTH seats", () => {
    // The live farm's seat (`host.start({climate})` → `session.climate`) and
    // the books' seat (`TownPlayConfig.climate`) must be the same expression,
    // or the visible farm and the abstract farm size the same ground
    // differently. This is the assertion that says they are.
    expect(run.session.climate).toEqual(planetRecord(run).env.climate);
    expect(planetRecord(run).townConfig.climate).toEqual(planetRecord(run).env.climate);
  });

  it("⑥ two boots of the document build the IDENTICAL world", () => {
    const second = bootTextQuest({ world: readDoc("frontier-planet.spec.json"), seed: SEED, dt: DT });
    try {
      second.advance(20);
      // The digest must be measuring a POPULATED world — a bodiless result
      // would pass the comparison while proving nothing.
      expect(Object.keys(second.state.avatars).length).toBeGreaterThan(1);
      expect(digest(second)).toBe(digest(run));
      // …and the record itself, which is the substrate saying it was baked the
      // same way twice.
      expect(planetRecord(second).checksum).toBe(planetRecord(run).checksum);
      expect(planetRecord(second).cell).toBe(planetRecord(run).cell);
      expect(planetRecord(second).env).toEqual(planetRecord(run).env);
    } finally {
      second.dispose();
    }
  }, 900_000);

  it("⑦ 📜 the DECLARED cell lays the SAME countryside as the measured planet", () => {
    // The whole point of the cheap path: `frontier-cell.spec.json` is
    // GENERATED from this very planet, so a suite that boots it is standing on
    // cell 12755 and not on a convenient fiction. The two towns are NOT the
    // same object (a declared camp is day 0 from a document; the planet arm's
    // is `siteTownConfig`'s day-one site) — what must agree is the GROUND.
    expect(cellRun.planet).toBeNull(); // no bake on this arm, by construction
    expect(scatterOf(cellRun)).toEqual(scatterOf(run));
    expect(cellRun.session.climate).toEqual(planetRecord(run).env.climate);
    const tr = cellRun.session.town!.stage.trade;
    expect(tr!.route.partnerKey).toBe(run.session.town!.stage.trade!.route.partnerKey);
    expect(tr!.route.distanceM).toBeCloseTo(280723.98, 1);
  });
});
