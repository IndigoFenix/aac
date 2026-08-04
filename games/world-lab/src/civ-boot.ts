/**
 * civ-boot — world-lab's Composition backend binding (nations P0).
 *
 * The shared civ tier (`kernel/civ/dual.ts` / `tri.ts`) takes its
 * demography backend as an explicit `CompositionBoot` parameter — the
 * content/machinery split. This module is world-lab's binding: PopuSim's
 * engine source behind the seam, headless. It is the successor of
 * grand-dream's `boot.ts` (grand-dream is retiring; when it goes, this is
 * the binding that remains until the PopuSim core itself moves into
 * shared — port-then-delete, planning-docs/games/world-engine/nations-and-empires.md
 * §11.5).
 *
 * Headless everywhere: the document shim is imported FIRST (top-level
 * side effect, self-guarding — a real browser's `document` wins), so the
 * same module boots in the browser lab, a worker, and node tests.
 */

import "@popusim/sim/documentShim";
import "@popusim/wireup";
import { System } from "@popusim/controller/System";
import { World } from "@popusim/controller/World";
import type {
  CompositionOps, CompositionSite, CompositionSitePop, CompositionRouteInfo, CompositionWorld,
} from "@shared/world-engine/kernel/civ/composition";

/** World-lab's CompositionWorld: PopuSim behind the shared civ seam,
 *  plus the raw World handle for lab-only probes. */
export interface CivWorld extends CompositionWorld {
  world: World;
}

const GUI_NOOPS = [
  "setSitesSelector", "setSite", "unsetSite", "setGraphMode",
  "setVisualizerMode", "setVisualizerToggle", "rerenderGraph",
  "updateGUI",
] as const;

/** The lab's `CompositionBoot`: construct a System, seed its RNG,
 *  neutralize the render yield + GUI-facing methods, build a World over
 *  the scenario the dual layer authored, and start it. */
export async function bootCiv(
  scenario: Record<string, unknown>,
  seed: number,
): Promise<CivWorld> {
  const system = new System(null as never) as unknown as Record<string, unknown> & {
    rand: { seed(n: number): void };
    world: World;
  };
  system.rand.seed(seed);
  // Neutralize the per-population render yield (main-thread run).
  (system as Record<string, unknown>).renderIfNeeded = () => undefined;
  for (const m of GUI_NOOPS) {
    (system as Record<string, unknown>)[m] = () => undefined;
  }
  // confirmBox is only awaited on the no-sites error path; resolve instantly.
  (system as Record<string, unknown>).confirmBox = () => Promise.resolve(undefined);

  const world = new World(system as never, JSON.parse(JSON.stringify(scenario)));
  system.world = world;
  (world as unknown as Record<string, unknown>).updateGUI = () => undefined;
  await world.start();

  const w = world as unknown as {
    sites: Array<{ key: string; name: string; pop: number; pops: CompositionSitePop[] }>;
    routes: Array<{
      key: string; site_a: { key: string } | null; site_b: { key: string } | null;
      strength: number; migration: number;
    }>;
    traits: Array<{ key: string; base_key?: string }>;
    age: number;
    newDay(): Promise<void>;
  };

  return {
    world,
    // The whole PopuSim binding: World satisfies the shared civ layer's
    // raw-ops seam structurally (the seam mirrors its member names).
    ops: world as unknown as CompositionOps,
    sites: (): CompositionSite[] =>
      w.sites.map(s => ({ key: s.key, name: s.name, pop: s.pop, pops: s.pops })),
    routes: (): CompositionRouteInfo[] =>
      w.routes.map(r => ({
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
