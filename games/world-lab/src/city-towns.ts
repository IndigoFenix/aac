/**
 * CITY-TOWN LOADER — the approach-load rung of the city abstraction ladder,
 * mirroring how planets lazy-load (halo → pixel gate → geology bake):
 *
 *   founded   — name/charter/crowd + a beacon (planet/cities.ts). No sim.
 *   books     — a settlement's economy fast-forwards its whole history in
 *               one leap (createTownWorld.step — grand-dream's cheap layer).
 *   shape     — streets/lots/residents/stage, the expensive part, staged
 *               ACROSS FRAMES while the ship flies in (buildTownPlayStaged).
 *   entered   — the quest host mounts the fully-warmed session.
 *
 * One loader per flight; one cache entry per city cell — a city is an
 * address, so a revisit remounts the same warmed town instantly. Only the
 * town being approached ever builds; nothing simulates in the background.
 */
import {
  buildTownPlayStaged, type TownPlay, type TownPlayConfig,
} from "@shared/world-engine/interaction/town/town-play";
import {
  certifyCreatureQuestWorld, type CreatureCertification,
} from "@shared/world-engine/interaction/quest/creature-quests";
import { expand, isFoldRefusal, type FoldRecord } from "@shared/world-engine/kernel/town/fold";
import type { TownRecord, TownFoldCtx } from "@shared/world-engine/kernel/town/barter";
import { scopeIdOf } from "@shared/world-engine/kernel/town/scope";
import { kindsOf } from "@shared/world-engine/kernel/town/goods-kinds";
import { grownDays, grownBuildUp } from "@shared/world-engine/planet/growth";
import {
  provideTownRoadBearings, provideTownRoadSeeds,
} from "@shared/world-engine/kernel/town/host";
import type { GrowSeed } from "@shared/world-engine/kernel/town/streets";
import type { WorldScale } from "@shared/world-engine/scale";
import type { FlightCity } from "./space-fly";

/** Founding population cap for a VISIT: Malthus regrows the town to its
 *  charter capacity during the fast-forward anyway, so the visited town is
 *  still the city's town — it just doesn't lay a metropolis of lots in one
 *  synchronous stage (townPlan is the budget; see the timing probe). */
const VISIT_START_POP = 200;

export interface CityTownEntry {
  state: "founding" | "ready" | "error";
  /** Live progress note ("day 160", "laying streets") for the status bar. */
  note: string;
  play?: TownPlay;
  error?: string;
}

export interface CityTownLoader {
  /** Kick (idempotent) + read a city's founding. Call every frame while the
   *  ship is inside the city's approach envelope. */
  approach(fc: FlightCity): CityTownEntry;
  /** Peek without kicking a build. */
  entry(cell: number): CityTownEntry | null;
  /** FOUNDED SITES (nations P0, planet-scale founding): override the config
   *  this cell's town builds from — a player-founded site rebuilds from
   *  `siteTownConfig` (its serialized deltas: founded buildings, yard stock,
   *  standing trade routes) instead of the procedural `cityTownConfig`.
   *  Re-registering REPLACES the override and drops any built entry, so the
   *  next approach founds from the freshest snapshot (the wilderness chunk
   *  refreshes it as it unmounts). */
  registerFounded(cell: number, config: TownPlayConfig): void;
  /** Drop a founded override + its entry (the site was abandoned). */
  dropFounded(cell: number): void;
}

export interface CityTownLoaderOpts {
  /** Off-thread quest certification (geo-bake's worker). Absent (tests,
   *  headless hosts) the loader certifies synchronously — same verdict. */
  certify?: (game: unknown) => Promise<CreatureCertification>;
  /** Quest-giving residents per founded town — the GAME SPEC's questCount
   *  (game.world.questCount). Default 0: no quests unless the spec asks. */
  questCount?: number;
  /** TRUE approach bearings of the city's incident roads (town-local
   *  radians, kernel/town/approach.ts) — registered under the town's key
   *  before founding, so townBias grows the arterials where the ribbons
   *  really come in. MUST be deterministic in (planet, city): the street
   *  tree is prefix-stable per (seed, key, bearings). null = unknown
   *  (townBias falls back); [] = a verified roadless town. */
  roadBearings?: (fc: FlightCity) => readonly number[] | null;
  /** THE SEAM (growth phase B §2.1) — the city's incident roads themselves,
   *  as town-local growth seeds (kernel/town/approach.ts `townRoadSeeds`).
   *  A bearing says only "a road leaves that way"; a seed carries the road,
   *  so the town's BASELINE can be the through road instead of a guess aimed
   *  along it. Same determinism contract as `roadBearings` — a function of
   *  (planet, city) alone. Registered before founding, preferred over the
   *  bearings when it comes back non-empty; `[]` (the overlap rule left every
   *  incident route unclipped, so there is no port-to-port span) falls back
   *  to the bearings exactly as before the seam existed. */
  roadSeeds?: (fc: FlightCity) => readonly GrowSeed[] | null;
  /** THE DOCUMENT'S DECLARED SCALE (`game.scale`, resolved) — read per
   *  founding, because the document can be reloaded under a live loader.
   *  Rides into `TownPlayConfig.scale` so `plan.ts` lays the town out to the
   *  SAME `townExtentM` the roads were ported at and the seam splices at.
   *  Absent / undefined = realism. */
  scale?: () => WorldScale | undefined;
  /** ⚖️ B-③'s EXPAND DOOR (band-settlement-round.md S3): this city's
   *  CONDENSED TOWN RECORD, when one exists — a settlement that folded with
   *  goods on its shelf (a settled band's banked store). Consumed through
   *  the fold dispatch's `expand` at materialization, so the goods land in
   *  the built town conserving; the record's stack is DRAINED in place (the
   *  host owns the transition — wild's own convention), which is what makes
   *  a cache-drop rebuild safe against double-minting. Same determinism
   *  contract as `roadBearings`/`roadSeeds`: a function of the city, not of
   *  time. Absent / null = no record, the shipped path byte-identical. */
  record?: (fc: FlightCity) => TownRecord | null;
}

/**
 * ⚖️ CONSUME A CONDENSED TOWN RECORD INTO A BUILD CONFIG — the loader's
 * half of `expand` (the placer). Two laws meet here:
 *
 * · THE LANE PICK (town-play.ts's own trap, honored not fought):
 *   `config.stock` is IGNORED whenever `config.deltas` is present, so the
 *   goods fold into `deltas.stock` when an override is in play and into
 *   `config.stock` otherwise — never both.
 * · THE GOOD→GLYPH SPLIT (F-③ — the integral/derivative lives at the
 *   fold): a record's stack speaks the trade rung's GOOD keys ("food");
 *   the built town's yard speaks item glyphs. A category good deals its
 *   WHOLE units across its kinds by largest remainder (gather's own
 *   apportionment); a concrete glyph lands directly. Fractional crumbs
 *   STAY ON THE RECORD — nothing evaporates, and nothing invents a
 *   fractional prop.
 */
export function consumeTownRecord(rec: TownRecord, config: TownPlayConfig): boolean {
  const envelope: FoldRecord<TownRecord> = {
    kind: "town",
    id: scopeIdOf({ kind: "town", key: rec.key }),
    at: 0,
    payload: rec,
    commitments: [],
  };
  const ctx: TownFoldCtx = {
    now: 0,
    place: (_key, stack) => {
      const target = config.deltas
        ? (config.deltas.stock ??= {})
        : (config.stock ??= {});
      for (const [good, units] of Object.entries(stack)) {
        const whole = Math.floor(units);
        if (whole <= 0) continue;
        const kinds = kindsOf(good);
        if (!kinds.length) {
          target[good] = (target[good] ?? 0) + whole;
        } else {
          // Largest remainder over equal shares — deterministic (kinds
          // order breaks ties), Σ exact.
          const base = Math.floor(whole / kinds.length);
          let left = whole - base * kinds.length;
          kinds.forEach(g => {
            const share = base + (left > 0 ? 1 : 0);
            if (left > 0) left--;
            if (share > 0) target[g] = (target[g] ?? 0) + share;
          });
        }
        const rest = units - whole;
        if (rest > 1e-9) stack[good] = rest;
        else delete stack[good];
      }
    },
  };
  return !isFoldRefusal(expand(envelope, ctx));
}

/** The settlement key a city's town builds under (street-plan identity). */
export function cityTownKey(fc: FlightCity): string {
  return fc.city.name.toLowerCase().replace(/\s+/g, "-");
}

export function cityTownConfig(
  fc: FlightCity, nowMs = Date.now(), questCount = 0, scale?: WorldScale,
): TownPlayConfig {
  // The visit cap flattens founding size, so AGE carries the difference the
  // crowd would have: a thin camp is a young hamlet, a dense site has grown
  // for two extra seasons. (Malthus makes fast-forward days ≈ town size.)
  // On top of that base, THE WORLD CLOCK: the settling era ages every town
  // identically on every client (planet/growth.ts) — revisit next month and
  // the town has genuinely grown; once its spread saturates, it RISES.
  const crowd01 = Math.min(1, fc.city.density / 400);
  return {
    seed: fc.city.cell,
    key: cityTownKey(fc),
    charter: fc.city.charter,
    startPop: Math.min(fc.city.startPop, VISIT_START_POP),
    days: grownDays(100 + Math.round(120 * crowd01), nowMs),
    buildUp: grownBuildUp(fc.city.density, nowMs),
    questCount,
    // THE TOWN GROWS TO THE EXTENT THE ROADS WERE CLIPPED AT. `plan.ts`
    // derives its own `townExtentM(scale)`, so a config that carried no
    // scale grew a REAL-scale 450 m town inside a compressed world whose
    // routes ported at 195 m — the buildings then stood outside their own
    // port and the interstates crossed them. Absent = realism, which is
    // exactly what an undeclared world means everywhere else.
    ...(scale ? { scale } : {}),
    // …AND TO THE BODY ITS TIER DECLARES (food-scale-round ⑩): a village row
    // (`planet/refine.ts`/`border.ts` stamp `PlanetCity.tier`) builds the
    // 120 m village its lanes ported at, not a 450 m market town. Absent =
    // "town", byte-identical — tier-0 capitals deliberately carry none.
    ...(fc.city.tier ? { tier: fc.city.tier } : {}),
  };
}

export function createCityTownLoader(opts: CityTownLoaderOpts = {}): CityTownLoader {
  const cache = new Map<number, CityTownEntry>();
  // BUDGETED breathing: the founding generator yields FINELY now (day
  // slices, house batches, furniture batches — buildTownPlaySteps), so we
  // only hand the browser a frame when we actually consumed one; tiny
  // stages run on without paying a timer, and no stage ever spans frames.
  let lastBreath = performance.now();
  const breathe = async (): Promise<void> => {
    if (performance.now() - lastBreath < 6) return;
    await new Promise(r => setTimeout(r, 16));
    lastBreath = performance.now();
  };

  // Founded-site config overrides (nations P0) — cell → the site's own
  // serialized config (deltas ride inside; registerFounded replaces).
  const foundedCfg = new Map<number, TownPlayConfig>();

  async function found(fc: FlightCity, entry: CityTownEntry): Promise<void> {
    try {
      const config = foundedCfg.get(fc.city.cell)
        ?? cityTownConfig(fc, Date.now(), opts.questCount ?? 0, opts.scale?.());
      // ⚖️ B-③ — THE LAZY MATERIALIZATION IS EXPAND: a city with a condensed
      // record delivers its shelf into the town it becomes, conserving.
      const rec = opts.record?.(fc) ?? null;
      if (rec && Object.values(rec.stack).some(n => n > 0)) {
        consumeTownRecord(rec, config);
      }
      const play = await buildTownPlayStaged(config, async note => {
        entry.note = note;
        await breathe();
      });
      entry.note = "certifying";
      // Prove the resident quests are winnable BEFORE the player lands —
      // a refusal surfaces as an error beacon note, not a black screen.
      // With a worker on hand the proof runs off-thread (pure JSON in/out);
      // without one it runs here, the loader's one remaining lump.
      const cert = opts.certify
        ? await opts.certify(play.bundle.game)
        : certifyCreatureQuestWorld(play.bundle.game);
      if (!cert.ok) {
        throw new Error(`town failed ${cert.stage} certification: ${cert.errors.join("; ")}`);
      }
      entry.play = play;
      entry.state = "ready";
      entry.note = "ready";
    } catch (e) {
      entry.state = "error";
      entry.error = (e as Error).message;
      entry.note = "refused";
    }
  }

  return {
    approach(fc) {
      let e = cache.get(fc.city.cell);
      if (!e) {
        // The roads register under the town's key BEFORE the build starts —
        // createTownWorld snapshots them at chartering. SEEDS are the roads
        // themselves (the baseline grows AS the through road); the bearings
        // stay registered beside them as the fallback for a city whose
        // routes the overlap rule left unclipped.
        const key = cityTownKey(fc);
        provideTownRoadBearings(key, opts.roadBearings?.(fc) ?? null);
        provideTownRoadSeeds(key, opts.roadSeeds?.(fc) ?? null);
        e = { state: "founding", note: "chartering" };
        cache.set(fc.city.cell, e);
        void found(fc, e);
      }
      return e;
    },
    entry: cell => cache.get(cell) ?? null,
    registerFounded(cell, config) {
      foundedCfg.set(cell, config);
      cache.delete(cell); // rebuild from the fresh snapshot on next approach
    },
    dropFounded(cell) {
      foundedCfg.delete(cell);
      cache.delete(cell);
    },
  };
}
