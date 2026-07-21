/**
 * The Composition seam — the structural surface the civ layer's dual
 * coupling drives on its composition backend (the TownHost pattern, one
 * layer up). PopuSim satisfies it with no adapter beyond one cast at the
 * game's boot (grand-dream's boot.ts); the member names deliberately
 * mirror PopuSim's own (`breakaways_fired`, `births_total`, the LIVE
 * `routes` array) so that cast is the whole binding. WHICH backend a
 * world runs is the game's concern: `bootDual`/`foundTri` take the boot
 * as an explicit parameter, exactly as the town layer takes its compiled
 * economy (the content/machinery split, shared/engine/README.md).
 */

/** One aggregate population bin on a site. */
export interface CompositionSitePop {
  pop: number;
  syndrome: { key: string; trait_keys: string[] };
}

export interface CompositionSite {
  key: string;
  name: string;
  pop: number;
  pops: CompositionSitePop[];
}

export interface CompositionRouteInfo {
  key: string;
  site_a: { key: string } | null;
  site_b: { key: string } | null;
  strength: number;
  migration: number;
}

/** Preview of one deterministic, storage-free villager (§6). */
export interface HistfigSample {
  siteKey: string;
  index: number;
  /** Deterministic syllable name — flavor, stable per (site, index). */
  name: string;
  /** The binary syndrome this person was drawn from. */
  syndromeKey: string;
  traitKeys: string[];
  /** Scalar in [0,1) per non-combo trait. Carriers ≥ 0.5, non-carriers
   *  < 0.5 (so an untouched release re-bins to the origin syndrome). */
  scalars: Record<string, number>;
}

/** A pinned individual — persistent, outside the aggregate accounting. */
export interface Histfig extends HistfigSample {
  id: number;
  role: string;
}

/**
 * The raw day-boundary ops the dual coupling drives — the sanctioned
 * write channels (driven migration, vitals, trait flips, structural
 * founding) and the rest/history reads. PopuSim's World satisfies this
 * structurally.
 */
export interface CompositionOps {
  /** The LIVE route objects, index-aligned with the dual world's edges
   *  (grown in step by addRoute); writing `strength` is how the road
   *  attribute drives the ranged-shed share each day. */
  routes: Array<{ strength: number }>;
  /** Fixed-point detection (step-3 rest) — gates the O(1) jump. */
  isCompositionAtRest(): boolean;
  /** Jump n resting days in O(1) (history rows elided). */
  skipDays(n: number): number;
  /** Fired breakaways, oldest first. */
  breakaways_fired: Array<{ key: string; day: number; moved: number }>;
  /** Pinned individuals, live array. */
  histfigs: Histfig[];
  sampleIndividual(siteKey: string, index: number): HistfigSample | null;
  pinHistfig(siteKey: string, index: number, role?: string): Histfig | null;
  releaseHistfig(id: number): boolean;
  histfigShed(id: number, traitKey: string, amount: number, scaleBy?: string): number;
  /** Σ trait-declared demand × carriers per resource (world-content §3c). */
  siteResourceDemand(siteKey: string): Record<string, number>;
  /** Exact whole-people births/deaths, optionally scoped to a trait's
   *  carriers (hereditary-projected births, uniform deaths in scope). */
  applyVitals(siteKey: string, births: number, deaths: number, trait?: string): { born: number; died: number };
  /** Lifetime vital ledger. */
  births_total: number;
  deaths_total: number;
  /** Structural founding, composition side (null/undefined on refusal). */
  addSite(json: Record<string, unknown>): Promise<unknown>;
  addRoute(json: Record<string, unknown>): unknown;
  /** DRIVEN migration — exact counts, uniform by syndrome (conserving). */
  applyExternalMigration(moves: Array<{ from: string; to: string; count: number }>): number;
  /** Political conquest: rewrite a site's membership traits in place. */
  applyTraitFlip(where: string[], apply: string[], remove: string[], siteKey?: string): number;
}

/** A booted composition world: aggregate reads + one day step + the ops. */
export interface CompositionWorld {
  sites(): CompositionSite[];
  routes(): CompositionRouteInfo[];
  day(): number;
  totalPop(): number;
  /** Population on a site whose syndrome carries `traitKey`. */
  popOnSiteWithTrait(siteKey: string, traitKey: string): number;
  /** All trait keys declared in the scenario. */
  traitKeys(): string[];
  /** One composition day: phases, ranged sheds along routes, events. */
  step(): Promise<void>;
  /** The raw backend surface the dual coupling drives. */
  ops: CompositionOps;
}

/** Boot a composition backend over a generated scenario. The scenario's
 *  `site`/`route` arrays are authored by the dual layer from the shared
 *  node graph, so the two layers cannot disagree about the graph. */
export type CompositionBoot = (
  scenario: Record<string, unknown>,
  seed: number,
) => Promise<CompositionWorld>;
