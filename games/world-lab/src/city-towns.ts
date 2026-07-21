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
import { grownDays, grownBuildUp } from "@shared/world-engine/planet/growth";
import { provideTownRoadBearings } from "@shared/world-engine/kernel/town/host";
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
}

/** The settlement key a city's town builds under (street-plan identity). */
export function cityTownKey(fc: FlightCity): string {
  return fc.city.name.toLowerCase().replace(/\s+/g, "-");
}

export function cityTownConfig(fc: FlightCity, nowMs = Date.now(), questCount = 0): TownPlayConfig {
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
      const config = foundedCfg.get(fc.city.cell) ?? cityTownConfig(fc, Date.now(), opts.questCount ?? 0);
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
        // The roads' true approach bearings register under the town's key
        // BEFORE the build starts — createTownWorld snapshots them at
        // chartering and townBias aims the arterials along them.
        provideTownRoadBearings(cityTownKey(fc), opts.roadBearings?.(fc) ?? null);
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
