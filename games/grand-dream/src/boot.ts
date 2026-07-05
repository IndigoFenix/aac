/**
 * Headless World boot for the lab.
 *
 * Mirrors the engine test helper (`popusim/src/__tests__/_helpers.ts`):
 * construct a System, seed its RNG, neutralize the render-yield, build a
 * World and start it. In a real browser `document` exists, so System's
 * detached-DOM construction works — but we still stub the GUI-facing
 * System methods to no-ops so `world.start()` / `world.newDay()` never
 * depend on an attached panel/graph/canvas that this lab doesn't build.
 */

import "@popusim/wireup";
import { System } from "@popusim/controller/System";
import { World } from "@popusim/controller/World";

export interface SitePop {
  pop: number;
  syndrome: { key: string; trait_keys: string[] };
}
export interface LabSite {
  key: string;
  name: string;
  pop: number;
  pops: SitePop[];
}
export interface LabRoute {
  key: string;
  site_a: { key: string } | null;
  site_b: { key: string } | null;
  strength: number;
  migration: number;
}

export interface LabWorld {
  world: World;
  sites(): LabSite[];
  routes(): LabRoute[];
  day(): number;
  totalPop(): number;
  /** Population on a site whose syndrome carries `traitKey`. */
  popOnSiteWithTrait(siteKey: string, traitKey: string): number;
  /** All trait keys declared in the scenario. */
  traitKeys(): string[];
  step(): Promise<void>;
}

const GUI_NOOPS = [
  "setSitesSelector", "setSite", "unsetSite", "setGraphMode",
  "setVisualizerMode", "setVisualizerToggle", "rerenderGraph",
  "updateGUI",
] as const;

export async function bootLab(
  scenario: Record<string, unknown>,
  seed: number,
): Promise<LabWorld> {
  const system = new System(null as never) as unknown as Record<string, unknown> & {
    rand: { seed(n: number): void };
    world: World;
  };
  system.rand.seed(seed);
  // Neutralize the per-population render yield (browser main-thread run).
  (system as Record<string, unknown>).renderIfNeeded = () => undefined;
  // Stub GUI-facing methods so start()/newDay() don't touch panels.
  for (const m of GUI_NOOPS) {
    (system as Record<string, unknown>)[m] = () => undefined;
  }
  // confirmBox is only awaited on the no-sites error path; resolve instantly.
  (system as Record<string, unknown>).confirmBox = () => Promise.resolve(undefined);

  const world = new World(system as never, JSON.parse(JSON.stringify(scenario)));
  system.world = world;
  // world.updateGUI() is called internally; make it a no-op too.
  (world as unknown as Record<string, unknown>).updateGUI = () => undefined;
  await world.start();

  const w = world as unknown as {
    sites: Array<{ key: string; name: string; pop: number; pops: SitePop[] }>;
    routes: Array<{ key: string; site_a: { key: string } | null; site_b: { key: string } | null; strength: number; migration: number }>;
    traits: Array<{ key: string; base_key?: string }>;
    age: number;
    newDay(): Promise<void>;
  };

  return {
    world,
    sites: () => w.sites.map(s => ({ key: s.key, name: s.name, pop: s.pop, pops: s.pops })),
    routes: () => w.routes.map(r => ({
      key: r.key, site_a: r.site_a, site_b: r.site_b,
      strength: r.strength, migration: r.migration,
    })),
    day: () => w.age,
    totalPop: () => w.sites.reduce((sum, s) => sum + s.pops.reduce((a, p) => a + p.pop, 0), 0),
    popOnSiteWithTrait: (siteKey, traitKey) => {
      const site = w.sites.find(s => s.key === siteKey);
      if (!site) return 0;
      let sum = 0;
      for (const p of site.pops) {
        if (p.syndrome.trait_keys.indexOf(traitKey) !== -1) sum += p.pop;
      }
      return sum;
    },
    traitKeys: () => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const t of w.traits) {
        const k = t.base_key ?? t.key;
        if (!seen.has(k)) { seen.add(k); out.push(k); }
      }
      return out;
    },
    step: () => w.newDay(),
  };
}
