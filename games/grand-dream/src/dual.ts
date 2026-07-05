/**
 * DualWorld — grand-dream step 2: the SHARED NODE GRAPH.
 *
 * Runs the Settlement layer (cell-systems EntityWorld) and the Composition
 * layer (PopuSim World) over the SAME set of nodes and edges, coupled only
 * at the day boundary (unified-world-model.md §4), one direction per pair:
 *
 *   Settlement → Composition
 *     • population exchange flows become DRIVEN migration
 *       (World.applyExternalMigration — exact counts, uniform by syndrome)
 *     • the road edge attribute becomes Route.strength (ranged-shed share)
 *   Composition → Settlement
 *     • trait prevalences per site are written into entity scalars as
 *       external inputs (bounded [0,1] — the sanctioned channel)
 *
 * One EntityWorld step = one PopuSim day. After migration the Composition
 * layer's integer site totals are written back into the Settlement
 * population scalar, so the two layers agree EXACTLY every day (the float
 * exchange only proposes flows; a per-edge fractional carry preserves
 * slow flows across days). Consequence for authors: in a dual world the
 * settlement population scalar may change ONLY via exchange — autonomous
 * growth would be erased by the write-back. Births/deaths belong to the
 * Composition layer (a later step).
 */

import { bootLab, type LabWorld } from "./boot";
import type { Histfig, HistfigSample } from "@popusim/controller/World";
import type { WorldSpec } from "@cells/spec";
import { validateWorldSpec } from "@cells/world-validate";
import { createWorld, stepWorld, worldFastForward, injectEdge, addEntity, type EntityWorld } from "@cells/entities";

export interface DualNode {
  key: string;
  name: string;
  pop: number;
  /** Initial values for settlement entity scalars (population is set from `pop`). */
  scalars?: Record<string, number>;
  /** PopuSim site JSON passthrough (startpop, transmit, ...). */
  site?: Record<string, unknown>;
}

export interface DualEdge {
  a: string;
  b: string;
  key?: string;
  /** Initial values for settlement edge attributes (road, hostility, ...). */
  attrs?: Record<string, number>;
}

export interface DualCoupling {
  /** Settlement entity scalar that mirrors PopuSim site population. Its
   *  exchange flow drives migration; its value is written back from the
   *  Composition layer's integer totals each day. */
  populationScalar: string;
  /** Settlement edge attribute that drives Route.strength each day. */
  roadAttr?: string;
  /** Route.strength = roadAttr × strengthScale (default 1). */
  strengthScale?: number;
  /** Composition→Settlement inputs, written each day:
   *    'fraction' (default) — entity scalar := trait prevalence [0..1]
   *                           (dimensionless dials: unrest, cohesion).
   *    'count'              — entity scalar := carrier COUNT (people).
   *  Count mode is how TRAITS SHAPE DEMAND (world-content §3c): feed the
   *  carrier count into a ProcessSpec (devout_pop → incense_need) and a
   *  flow net's demand — what a town wants follows who its people are,
   *  and a spreading idea redraws the trade map. */
  traitInputs?: Array<{ trait: string; scalar: string; mode?: "fraction" | "count" }>;
  /** Composition→Settlement demand vector (world-content §3c): each day,
   *  entity scalar := the site's aggregated trait-declared demand for a
   *  resource (Σ trait.demand rates × carriers, via
   *  World.siteResourceDemand). The PREFERRED way traits shape the
   *  economy: a trait declares what its carriers want, next to its
   *  transmits, and every trait carrying that resource sums naturally.
   *  Point the scalar at a flow net's `demand`. */
  demandInputs?: Array<{ resource: string; scalar: string }>;
  /** Vital dynamics — the Malthusian policy over PopuSim's applyVitals
   *  mechanism. Each day, per site:
   *    fill    = foodNeed > 0 ? min(1, foodGot / foodNeed) : 1
   *    births  = pop × birthRate × fill
   *    deaths  = pop × (deathRate + starvation × (1 − fill))
   *  applied as whole people via deterministic per-site carries. The
   *  ECONOMY sets the carrying capacity: population grows until food fill
   *  drops to the break-even point. foodNeed/foodGot name settlement
   *  scalars (typically a flow net's demand + satisfied). A world with
   *  active vitals never takes the O(1) resting jump (carries are pending
   *  input; era-folding is future work). */
  vitals?: {
    birthRate: number;
    deathRate: number;
    /** Extra death rate at zero food (scaled by 1 − fill). */
    starvation?: number;
    foodNeed?: string;
    foodGot?: string;
  };
  /** Civilizations = membership traits (§2/§7). The LEDGER (name, color,
   *  capital) is tiny derived state outside both sims (§10) — a civ is
   *  simply everyone carrying its trait. Declare every civ that can exist,
   *  including breakaway targets that start empty. */
  civs?: Array<{ trait: string; name: string; color: string }>;
  /** Civ borders are tense while they exist: every day, each edge whose
   *  endpoints belong to DIFFERENT majority civs gains `amount` on this
   *  settlement edge attribute (clamped by the var's bounds; a settlement
   *  edge rule can cool it). Robust to majorities flipping days after a
   *  breakaway fires (absorption converts the stragglers over time). */
  breakawayHostility?: { attr: string; amount: number };
}

export interface DualSpec {
  nodes: DualNode[];
  edges: DualEdge[];
  /** Settlement layer (cell-systems). Rejected at load if it fails the
   *  idle-safety validator — mods break at boot, not at runtime. */
  settlement: WorldSpec;
  /** PopuSim scenario JSON WITHOUT site/route — those are generated from
   *  nodes/edges so the two layers cannot disagree about the graph. */
  composition: Record<string, unknown>;
  coupling: DualCoupling;
}

export interface DualWorld extends LabWorld {
  entityWorld: EntityWorld;
  /** True when BOTH layers sit on a proven fixed point: the composition
   *  world is at rest (PopuSim step-3 detection) and the settlement world
   *  is inert (last step changed nothing, no armed timers, no clocks). */
  isResting(): boolean;
  /** Advance `n` days, jumping the whole remainder in O(1) once both
   *  layers rest — bit-equivalent to stepping (minus history rows).
   *  Returns how many days were stepped live vs jumped. */
  advanceDays(n: number): Promise<{ stepped: number; skipped: number }>;
  /** The settlement layer's population value at a node — must equal the
   *  Composition site total after every step. */
  settlementPop(nodeKey: string): number;
  /** A settlement entity scalar at a node (e.g. goods, production). */
  settlementScalar(nodeKey: string, scalar: string): number;
  /** A settlement edge attribute by edge index (order = spec.edges). */
  settlementEdgeAttr(edgeIndex: number, attr: string): number;
  /** Signed steady-state flow (positive = edge's a→b) on an edge, from the
   *  named flow net — or summed across all nets when omitted. This is the
   *  §4c render field: caravans are drawn from it, not simulated. */
  settlementFlow(edgeIndex: number, netId?: string): number;
  /** The civ ledger, derived fresh from membership-trait counts: carriers,
   *  and the capital (the site holding the most members; ties break on
   *  node order). Civs with no carriers are dormant. */
  civs(): Array<{ trait: string; name: string; color: string; pop: number; capital: string | null }>;
  /** Majority civ at a site (most carriers, > 0), or null. */
  civOf(siteKey: string): { trait: string; name: string; color: string } | null;
  /** Fired breakaways, oldest first ({ key, day, moved }). */
  breakaways(): Array<{ key: string; day: number; moved: number }>;
  /** Preview villager `index` of a site — deterministic, storage-free (§6). */
  sampleVillager(siteKey: string, index: number): HistfigSample | null;
  /** Promote a villager to a persistent histfig (leaves the aggregate
   *  accounting: totalPop drops by 1, histfigCount rises by 1). */
  pinHistfig(siteKey: string, index: number, role?: string): Histfig | null;
  /** Return a histfig to the crowd (scalars re-bin to a syndrome). */
  releaseHistfig(id: number): boolean;
  /** Histfig influence: shed `amount` (× their `scaleBy` scalar) of a trait
   *  onto their home site via the pending-transmission pipeline. */
  histfigShed(id: number, traitKey: string, amount: number, scaleBy?: string): number;
  histfigs(): Histfig[];
  histfigCount(): number;
  /** The founding transaction (world-content §5, gate 5): create the Site
   *  and the Settlement entity in one day-boundary event, wire routes on
   *  both layers, and populate CONSERVINGLY via driven colonist migration.
   *  Returns the new node index, or -1. */
  foundSettlement(def: FoundSettlementDef): Promise<number>;
  /** Lifetime births/deaths — the accounting identity for vital worlds:
   *  totalPop + histfigCount = start + births − deaths. */
  vitalLedger(): { births: number; deaths: number };
  /** Σ of the settlement population scalar — equals PopuSim totalPop()
   *  after every step, by construction. */
  settlementTotalPop(): number;
}

interface RouteObj { strength: number; }

export interface FoundSettlementDef {
  key: string;
  name: string;
  /** Birth population injected from OUTSIDE the composition layer — the
   *  substrate-harvest path (tri worlds: the founding crowd leaves the
   *  grid; the tri ledger owns that conservation). Composition-internal
   *  foundings should leave this 0 and use `colonists`. */
  pop?: number;
  /** Initial settlement scalars (population mirrors the composition). */
  scalars?: Record<string, number>;
  /** PopuSim site JSON passthrough (startpop shapes a harvested pop). */
  site?: Record<string, unknown>;
  /** Roads to existing settlements. */
  edges: Array<{ to: string; key?: string; attrs?: Record<string, number> }>;
  /** Conserving population source: driven migration from existing sites. */
  colonists?: Array<{ from: string; count: number }>;
}

/** Set an entity scalar to an absolute value (inject the delta, clamped by
 *  the var's declared bounds — the sanctioned external-input channel). */
function setScalar(ew: EntityWorld, i: number, name: string, value: number): void {
  const arr = ew.scalars[name];
  if (!arr) throw new Error(`dual: settlement spec has no entity var '${name}'`);
  arr[i] = value; // bounds are the author's contract; initial placement is exact
}

export async function bootDual(spec: DualSpec, seed: number): Promise<DualWorld> {
  const { nodes, edges, coupling } = spec;

  const valid = validateWorldSpec(spec.settlement);
  if (!valid.ok) {
    throw new Error(`dual: settlement spec rejected: ${valid.errors.join("; ")}`);
  }
  const popVar = (spec.settlement.entity.vars ?? []).find(v => v.name === coupling.populationScalar);
  if (!popVar) {
    throw new Error(`dual: settlement spec lacks the population scalar '${coupling.populationScalar}'`);
  }

  // --- Composition side: sites + routes generated from the shared graph.
  // `allow_empty`: a genesis world may boot city-less and found everything
  // dynamically (world-content §5).
  const scenario: Record<string, unknown> = {
    ...JSON.parse(JSON.stringify(spec.composition)) as Record<string, unknown>,
    allow_empty: true,
    site: nodes.map(n => ({ key: n.key, name: n.name, pop: n.pop, ...(n.site ?? {}) })),
    // strength starts at 0 and is driven from the road attribute each day;
    // migration stays 0 — movement is DRIVEN, never a PopuSim-side rate.
    route: edges.map((e, i) => ({ key: e.key ?? `e${i}`, sites: [e.a, e.b], strength: 0, migration: 0 })),
  };
  const lab = await bootLab(scenario, seed);
  const routeObjs = (lab.world as unknown as { routes: RouteObj[] }).routes;

  // --- Settlement side: same nodes, same edges.
  const nodeIdx = new Map(nodes.map((n, i) => [n.key, i] as const));
  for (const e of edges) {
    if (!nodeIdx.has(e.a) || !nodeIdx.has(e.b)) {
      throw new Error(`dual: edge ${e.a}–${e.b} references an unknown node`);
    }
  }
  const ew = createWorld(
    spec.settlement,
    nodes.length,
    edges.map(e => [nodeIdx.get(e.a)!, nodeIdx.get(e.b)!] as [number, number]),
  );
  nodes.forEach((n, i) => {
    setScalar(ew, i, coupling.populationScalar, n.pop);
    for (const [k, v] of Object.entries(n.scalars ?? {})) setScalar(ew, i, k, v);
  });
  edges.forEach((e, i) => {
    for (const [k, v] of Object.entries(e.attrs ?? {})) {
      const arr = ew.edgeAttr[k];
      if (!arr) throw new Error(`dual: settlement spec has no edge var '${k}'`);
      arr[i] = v;
    }
  });

  // Fractional carry per edge so sub-1-person daily flows still migrate
  // whole people over time (deterministic — no RNG draw). `let`: founding
  // grows it.
  let carry = new Float64Array(edges.length);
  // Vital carries: fractional births/deaths accumulate per site until a
  // whole person arrives/leaves. Grown on founding.
  let birthCarry = new Float64Array(nodes.length);
  let deathCarry = new Float64Array(nodes.length);

  // Whether the last settlement step changed anything (rest tracking).
  let settlementChanged = true;

  const restWorld = lab.world as unknown as {
    isCompositionAtRest(): boolean;
    skipDays(n: number): number;
    breakaways_fired: Array<{ key: string; day: number; moved: number }>;
    histfigs: Histfig[];
    sampleIndividual(siteKey: string, index: number): HistfigSample | null;
    pinHistfig(siteKey: string, index: number, role?: string): Histfig | null;
    releaseHistfig(id: number): boolean;
    histfigShed(id: number, traitKey: string, amount: number, scaleBy?: string): number;
    siteResourceDemand(siteKey: string): Record<string, number>;
    applyVitals(siteKey: string, births: number, deaths: number): { born: number; died: number };
    births_total: number;
    deaths_total: number;
    addSite(json: Record<string, unknown>): Promise<unknown>;
    addRoute(json: Record<string, unknown>): unknown;
    applyExternalMigration(moves: Array<{ from: string; to: string; count: number }>): number;
  };

  /** Carriers of a membership trait per node index. */
  const civCounts = (trait: string): number[] =>
    nodes.map(n => lab.popOnSiteWithTrait(n.key, trait));

  const civOf = (siteKey: string): { trait: string; name: string; color: string } | null => {
    const i = nodeIdx.get(siteKey);
    if (i === undefined) return null;
    let best: { trait: string; name: string; color: string } | null = null;
    let bestCount = 0;
    for (const civ of coupling.civs ?? []) {
      const count = lab.popOnSiteWithTrait(siteKey, civ.trait);
      if (count > bestCount) { bestCount = count; best = { trait: civ.trait, name: civ.name, color: civ.color }; }
    }
    return best;
  };

  /** Civ borders arm daily: any edge joining different majority civs
   *  gains hostility (clamped), however long after the breakaway the
   *  majority actually flipped (day-boundary write — §10's discipline). */
  const armBorders = (): void => {
    if (!coupling.breakawayHostility || restWorld.breakaways_fired.length === 0) return;
    const attr = ew.edgeAttr[coupling.breakawayHostility.attr];
    if (!attr) throw new Error(`dual: settlement spec has no edge var '${coupling.breakawayHostility.attr}'`);
    const majority = nodes.map(n => civOf(n.key)?.trait ?? null);
    for (let e = 0; e < edges.length; e++) {
      const ca = majority[nodeIdx.get(edges[e].a)!];
      const cb = majority[nodeIdx.get(edges[e].b)!];
      if (ca !== null && cb !== null && ca !== cb) {
        injectEdge(ew, e, coupling.breakawayHostility.attr, coupling.breakawayHostility.amount);
      }
    }
  };

  /** Settlement fixed point: last step changed nothing, and nothing can
   *  re-activate on its own (no armed timers, no clocks). Static guards
   *  can't produce a rising edge, so no timer will arm either. */
  const settlementInert = (): boolean =>
    !settlementChanged &&
    (spec.settlement.clocks ?? []).length === 0 &&
    ew.armedEntity.every(m => m.size === 0) &&
    ew.armedEdge.every(m => m.size === 0);

  const sitePops = (): number[] => lab.sites().map(s => s.pops.reduce((a, p) => a + p.pop, 0));

  async function advanceDay(): Promise<void> {
    // 1. Composition → Settlement: yesterday's trait carriers become
    //    entity-scalar inputs (one-day lag is the contract) — as a
    //    prevalence fraction, or as a raw count for demand chains.
    const pops = sitePops();
    for (const ti of coupling.traitInputs ?? []) {
      nodes.forEach((n, i) => {
        const withTrait = lab.popOnSiteWithTrait(n.key, ti.trait);
        const value = ti.mode === "count"
          ? withTrait
          : (pops[i] > 0 ? withTrait / pops[i] : 0);
        setScalar(ew, i, ti.scalar, value);
      });
    }
    if (coupling.demandInputs?.length) {
      nodes.forEach((n, i) => {
        const wants = restWorld.siteResourceDemand(n.key);
        for (const di of coupling.demandInputs!) {
          setScalar(ew, i, di.scalar, wants[di.resource] ?? 0);
        }
      });
    }

    // 2. Settlement day: rules, trade, roads, conflict, population
    //    exchange — publishes signed per-edge flows on ew.lastFlow.
    settlementChanged = stepWorld(ew);

    // 3. Settlement → Composition: population flows become driven
    //    migration, rounded to whole people with a per-edge carry. The
    //    integer rest rule from the cell-systems transports applies: a
    //    whole person only moves while the day-start gap is ≥ 2 (a
    //    blocked edge also drops its carry), so an equalised graph
    //    reaches CRISP rest instead of trading ±1 forever. Safe because
    //    the population exchange is pure diffusion — its flow always
    //    points down the gradient this guard checks.
    const flows = ew.lastFlow[coupling.populationScalar];
    const moves: Array<{ from: string; to: string; count: number }> = [];
    if (flows) {
      for (let e = 0; e < edges.length; e++) {
        const ia = nodeIdx.get(edges[e].a)!;
        const ib = nodeIdx.get(edges[e].b)!;
        const gap = pops[ia] - pops[ib];
        const f = flows[e] + carry[e];
        const whole = Math.trunc(f);
        if (whole > 0 && gap >= 2) {
          carry[e] = f - whole;
          moves.push({ from: edges[e].a, to: edges[e].b, count: whole });
        } else if (whole < 0 && gap <= -2) {
          carry[e] = f - whole;
          moves.push({ from: edges[e].b, to: edges[e].a, count: -whole });
        } else {
          carry[e] = whole === 0 ? f : 0;
        }
      }
    }
    if (moves.length > 0) {
      (lab.world as unknown as {
        applyExternalMigration(m: Array<{ from: string; to: string; count: number }>): number;
      }).applyExternalMigration(moves);
    }

    // 3½. Vital dynamics (day boundary): the Malthusian policy — food fill
    //     gates births and drives starvation; PopuSim applies the exact
    //     counts (hereditary-projected births, uniform deaths).
    if (coupling.vitals) {
      const vt = coupling.vitals;
      const needArr = vt.foodNeed ? ew.scalars[vt.foodNeed] : null;
      const gotArr = vt.foodGot ? ew.scalars[vt.foodGot] : null;
      const vitalsWorld = restWorld as unknown as {
        applyVitals(siteKey: string, births: number, deaths: number): { born: number; died: number };
      };
      const popsNow = sitePops();
      for (let i = 0; i < nodes.length; i++) {
        const pop = popsNow[i];
        if (pop <= 0) continue;
        const need = needArr ? needArr[i] : 0;
        const fill = need > 0 ? Math.min(1, (gotArr ? gotArr[i] : 0) / need) : 1;
        const b = pop * vt.birthRate * fill + birthCarry[i];
        const d = pop * (vt.deathRate + (vt.starvation ?? 0) * (1 - fill)) + deathCarry[i];
        const births = Math.floor(b);
        const deaths = Math.floor(d);
        birthCarry[i] = b - births;
        deathCarry[i] = d - deaths;
        if (births > 0 || deaths > 0) vitalsWorld.applyVitals(nodes[i].key, births, deaths);
      }
    }

    // 4. Integer write-back: Composition totals are the truth; both layers
    //    now agree exactly (this also absorbs any clamped move).
    const after = sitePops();
    const popArr = ew.scalars[coupling.populationScalar];
    for (let i = 0; i < nodes.length; i++) popArr[i] = after[i];

    // 5. Roads → route strength, in time for today's ranged sheds.
    if (coupling.roadAttr) {
      const road = ew.edgeAttr[coupling.roadAttr];
      if (!road) throw new Error(`dual: settlement spec has no edge var '${coupling.roadAttr}'`);
      const scale = coupling.strengthScale ?? 1;
      for (let e = 0; e < routeObjs.length; e++) routeObjs[e].strength = road[e] * scale;
    }

    // 6. Composition day: phases, ranged sheds along routes, events, and
    //    breakaway checks.
    await lab.step();

    // 7. Civ borders (if any secession ever happened) stay armed.
    armBorders();
  }

  /** Active vitals are perpetual pending input (carries tick every day):
   *  such a world must not take the O(1) jump. Era-folding vitals into the
   *  fast-forward is future work. */
  const vitalsActive = (): boolean => {
    const vt = coupling.vitals;
    if (!vt) return false;
    if (vt.birthRate <= 0 && vt.deathRate <= 0 && !(vt.starvation && vt.starvation > 0)) return false;
    return sitePops().some(p => p > 0);
  };

  const isResting = (): boolean =>
    restWorld.isCompositionAtRest() && settlementInert() && !vitalsActive();

  /** The founding transaction — one day-boundary structural event across
   *  both layers (world-content §5). PopuSim Site + routes first, then the
   *  settlement entity + edges (same relative order, so route index e and
   *  settlement edge e stay aligned), then conserving colonist migration,
   *  then an immediate write-back so "Layers agree" holds from birth. */
  async function foundSettlement(def: FoundSettlementDef): Promise<number> {
    if (nodeIdx.has(def.key)) return -1;
    const site = await restWorld.addSite({ key: def.key, name: def.name, pop: def.pop ?? 0, ...(def.site ?? {}) });
    if (!site) return -1;

    const i = nodes.length;
    nodes.push({ key: def.key, name: def.name, pop: 0, scalars: def.scalars });
    nodeIdx.set(def.key, i);

    const entEdges: Array<{ to: number; attrs?: Record<string, number> }> = [];
    for (const e of def.edges) {
      const j = nodeIdx.get(e.to);
      if (j === undefined || j === i) continue;
      const key = e.key ?? `e${edges.length}`;
      const route = restWorld.addRoute({ key, sites: [def.key, e.to], strength: 0, migration: 0 });
      if (!route) continue;
      edges.push({ a: def.key, b: e.to, key, attrs: e.attrs });
      entEdges.push({ to: j, attrs: e.attrs });
    }
    addEntity(ew, {
      scalars: { ...(def.scalars ?? {}), [coupling.populationScalar]: 0 },
      edges: entEdges,
    });
    const grownCarry = new Float64Array(edges.length);
    grownCarry.set(carry);
    carry = grownCarry;
    const grownBirths = new Float64Array(nodes.length);
    grownBirths.set(birthCarry);
    birthCarry = grownBirths;
    const grownDeaths = new Float64Array(nodes.length);
    grownDeaths.set(deathCarry);
    deathCarry = grownDeaths;

    if (def.colonists?.length) {
      restWorld.applyExternalMigration(
        def.colonists.map(c => ({ from: c.from, to: def.key, count: c.count })),
      );
    }

    // Immediate write-back: both layers agree from the moment of founding.
    const after = sitePops();
    const popArr = ew.scalars[coupling.populationScalar];
    for (let k = 0; k < nodes.length; k++) popArr[k] = after[k];
    settlementChanged = true; // a founding day is never a resting day
    return i;
  }

  /** Advance n days; once both layers rest, jump the remainder in O(1).
   *  Valid because a resting dual day is a pure no-op: trait inputs
   *  rewrite the same values, the settlement step changes nothing (so no
   *  flows, no moves, static roads → static route strengths), and the
   *  composition day is a proven fixed point. */
  async function advanceDays(n: number): Promise<{ stepped: number; skipped: number }> {
    let stepped = 0;
    let remaining = Math.floor(n);
    while (remaining > 0) {
      if (isResting()) {
        worldFastForward(ew, remaining); // exact — rest-jumps internally
        restWorld.skipDays(remaining);
        return { stepped, skipped: remaining };
      }
      await advanceDay();
      stepped++;
      remaining--;
    }
    return { stepped, skipped: 0 };
  }

  return {
    ...lab,
    step: advanceDay,
    entityWorld: ew,
    isResting,
    advanceDays,
    settlementPop: (nodeKey) => {
      const i = nodeIdx.get(nodeKey);
      return i === undefined ? 0 : ew.scalars[coupling.populationScalar][i];
    },
    settlementScalar: (nodeKey, scalar) => {
      const i = nodeIdx.get(nodeKey);
      const arr = ew.scalars[scalar];
      return i === undefined || !arr ? 0 : arr[i];
    },
    settlementEdgeAttr: (edgeIndex, attr) => ew.edgeAttr[attr]?.[edgeIndex] ?? 0,
    settlementFlow: (edgeIndex, netId) => {
      if (netId) return ew.flowNet[netId]?.flows[edgeIndex] ?? 0;
      let f = 0;
      for (const id in ew.flowNet) f += ew.flowNet[id].flows[edgeIndex];
      return f;
    },
    sampleVillager: (siteKey, index) => restWorld.sampleIndividual(siteKey, index),
    pinHistfig: (siteKey, index, role) => restWorld.pinHistfig(siteKey, index, role),
    releaseHistfig: (id) => restWorld.releaseHistfig(id),
    histfigShed: (id, traitKey, amount, scaleBy) => restWorld.histfigShed(id, traitKey, amount, scaleBy),
    histfigs: () => restWorld.histfigs.slice(),
    histfigCount: () => restWorld.histfigs.length,
    foundSettlement,
    vitalLedger: () => ({ births: restWorld.births_total, deaths: restWorld.deaths_total }),
    civs: () => (coupling.civs ?? []).map(civ => {
      const counts = civCounts(civ.trait);
      let pop = 0, bestIdx = -1, bestCount = 0;
      counts.forEach((c, i) => { pop += c; if (c > bestCount) { bestCount = c; bestIdx = i; } });
      return { ...civ, pop, capital: bestIdx >= 0 ? nodes[bestIdx].key : null };
    }),
    civOf,
    breakaways: () => restWorld.breakaways_fired.slice(),
    settlementTotalPop: () => {
      const arr = ew.scalars[coupling.populationScalar];
      let s = 0;
      for (let i = 0; i < arr.length; i++) s += arr[i];
      return s;
    },
  };
}
