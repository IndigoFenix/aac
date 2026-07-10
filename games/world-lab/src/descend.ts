/**
 * The DESCEND seam — the scope ladder's zoom-in, composed at the lab's
 * root (composition-root work per scope, the engine README's law): a
 * planet or region game whose document ALSO ships economy packs can
 * descend into its focused founding site, founding the town that would
 * live there:
 *
 *   the site's radius-3 charter box → the town's charter,
 *   the site's crowd → the founding population,
 *   the site's cell → the street-plan seed (per-site, deterministic),
 *   the document's economy packs → what the town produces and eats.
 *
 * THREE-free on purpose: the grand-dream suite imports this to pin that
 * descending is deterministic and honest to the substrate.
 */
import { docsFor, type GameSettings, type LoadedWorld } from "@shared/engine/manifest";
import type { StarRecord } from "@shared/space/galaxy";
import { generateSystem, type SystemPlanet } from "@shared/space/solar";
import { ECONOMY_MODULE } from "@shared/engine/modules/economy/index";
import { compileEconomy, type CompiledEconomy, type EconomyDoc } from "@shared/engine/modules/economy/economy";
import { createTownWorld, type TownWorld } from "@shared/engine/town/town-world";
import { townPlan, type TownPlan } from "@shared/engine/town/plan";
import type { CellGrid, FoundingSite } from "@shared/engine/cells/index";

export interface DescendedTown {
  key: string;
  charter: { farmland: number; ore_access: number; timberland: number };
  startPop: number;
  eco: CompiledEconomy;
  town: TownWorld;
  plan: TownPlan;
}

/** A document can found towns iff it ships economy content for that level. */
export function canDescend(loaded: LoadedWorld): boolean {
  return docsFor<EconomyDoc>(loaded, ECONOMY_MODULE).length > 0;
}

/** Galaxy → system: the focused star IS the system (its systemSeed and
 *  stellar identity ride down; nothing is re-rolled). The descended view
 *  arrives focused on the first LANDABLE planet — rocky preferred, ice
 *  next — so the ladder keeps a next rung when one exists (generation is
 *  deterministic, so peeking at the system here re-rolls nothing). */
export function solarGameFromStar(star: StarRecord, avatar: boolean): GameSettings {
  const preview = generateSystem(star.systemSeed, {
    star: { massInit: star.massInit, age: star.age, feh: star.feh },
  });
  const landable =
    preview.planets.find(p => p.kind === "rocky") ??
    preview.planets.find(p => p.kind === "ice") ??
    null;
  return {
    scope: "solar_system",
    world: {
      seed: star.systemSeed,
      star: { massInit: star.massInit, age: star.age, feh: star.feh },
    },
    initialFocus: landable ? `planet:${landable.index}` : null,
    avatar,
    avatarSpecies: "human",
    creativeMode: false,
  };
}

/** System → planet: the focused planet's seed IS the geology seed. Rocky
 *  worlds settle (rivers, life, founding sites); ice worlds bake barren. */
export function planetGameFromPlanet(planet: SystemPlanet, avatar: boolean): GameSettings {
  if (planet.kind === "gas") {
    throw new Error(`descend: planet ${planet.index} is a gas giant — there is no surface to approach`);
  }
  return {
    scope: "planet",
    world: {
      topology: { kind: "cube-sphere", faceN: 24 },
      geology: { seed: planet.seed, epochs: 350 },
      settle: planet.kind === "rocky",
      radius: 2000,
    },
    initialFocus: null,
    avatar,
    avatarSpecies: "human",
    creativeMode: false,
  };
}

export function descendToSite(
  loaded: LoadedWorld,
  grid: CellGrid,
  site: FoundingSite,
  opts: { days?: number } = {},
): DescendedTown {
  const docs = docsFor<EconomyDoc>(loaded, ECONOMY_MODULE);
  if (!docs.length) {
    throw new Error("descend: the document ships no economy packs — nothing to found a town with");
  }
  const eco = compileEconomy(docs, { construction: true });

  const box = (field: string): number => {
    const arr = grid.fields[field];
    if (!arr) return 0;
    let sum = 0;
    grid.topo.disk(site.cell, 3, c => { sum += arr[c]; });
    return sum;
  };
  const charter = {
    farmland: box("fertility"),
    ore_access: box("ore"),
    timberland: box("plant"),
  };
  // The site's crowd founds the town (a few souls per grid person —
  // clamped so a thin camp still functions and a metropolis stays sane).
  const startPop = Math.max(40, Math.min(2000, Math.round(site.density * 5)));
  const key = `site${site.cell}`;

  const town = createTownWorld({
    economy: eco,
    charter,
    startPop,
    seedScalars: { farms: 1 },
    key,
  });
  town.step(Math.max(1, Math.min(5000, Math.floor(opts.days ?? 220))));
  const plan = townPlan(town, eco, key, site.cell, 0);

  return { key, charter, startPop, eco, town, plan };
}
