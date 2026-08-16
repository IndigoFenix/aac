/**
 * DualWorld — grand-dream step 2: the SHARED NODE GRAPH.
 *
 * Runs the Settlement layer (cell-systems EntityWorld) and the Composition
 * layer (a demographic backend behind the CompositionWorld seam — PopuSim
 * in grand-dream, injected via CompositionBoot) over the SAME set of nodes
 * and edges, coupled only at the day boundary (unified-world-model.md §4),
 * one direction per pair:
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

import type { CompositionBoot, CompositionWorld, Histfig, HistfigSample } from "./composition";
import type { WorldSpec } from "../cells/spec";
import { validateWorldSpec } from "../cells/world-validate";
import { createWorld, stepWorld, worldFastForward, injectEdge, injectEntity, addEntity, setEntityDisabled, type EntityWorld } from "../cells/entities";

export type { Histfig, HistfigSample } from "./composition";

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

/** One Malthusian policy: a species' (via its trait) or the whole
 *  site's. `foodNeed`/`foodGot` are THE SPEC'S DIET scalars. The type
 *  lives with the compiler that emits it (the economy module); the
 *  coupling here is its executor, so it re-exports it. */
import type { VitalsSpec } from "../modules/economy/economy";
export type { VitalsSpec };

export interface DualCoupling {
  /** Settlement entity scalar that mirrors PopuSim site population. Its
   *  exchange flow drives migration; its value is written back from the
   *  Composition layer's integer totals each day. With `civicTraits`
   *  set, the write-back counts ONLY civic carriers — see below. */
  populationScalar: string;
  /** Traits whose carriers COUNT as the settlement's civic population
   *  (what populationScalar carries — and with it tiers, conquest
   *  strength, capacity anchors, houses). Species worlds set this to
   *  the sapient species so a herd of sheep never tiers a village into
   *  a town. Absent = every soul counts (the pre-species behavior).
   *  NOTE: migration still moves ALL pops uniformly by syndrome (the
   *  conserving contract) — the civic flow drives it, and the herds
   *  travel with their people. */
  civicTraits?: string[];
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
   *  mechanism. Each day, per site AND PER SPEC:
   *    pop     = the spec's SPECIES carriers (or the whole site)
   *    fill    = foodNeed > 0 ? min(1, foodGot / foodNeed) : 1
   *    births  = pop × birthRate × fill
   *    deaths  = pop × (deathRate + starvation × (1 − fill))
   *  applied as whole people via deterministic per-(spec, site) carries.
   *  The ECONOMY sets the carrying capacity: a population grows until
   *  ITS DIET's fill drops to the break-even point — which is the point
   *  of the array form: species with different needs starve on
   *  different scarcities (the sheep on fodder while the bread holds),
   *  each scoped to its own trait via applyVitals' trait parameter. A
   *  bare object is the one-species legacy form (whole-site scope),
   *  bit-identical to before the array existed. A world with active
   *  vitals never takes the O(1) resting jump (carries are pending
   *  input; era-folding is future work). */
  vitals?: VitalsSpec | VitalsSpec[];
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
  /** CONQUEST (civilization-emergence.md §2d) — fusion, the mirror of
   *  breakaway's fission. Strength is CIV-level: Σ over each civ's
   *  majority sites of the weighted `strengthScalars` (v1 as decided:
   *  population + ore presence). Each day, every BORDER edge (different
   *  majority civs) with `hostilityAttr` ≥ `hostilityAt` where one civ is
   *  ≥ `ratio`× the other arms a SIEGE — the armed prediction, watchable;
   *  after `siegeDays` consecutive armed days in the same direction the
   *  defender's site FALLS: `casualties` on both endpoint sites (uniform
   *  removal via applyVitals — they join the vital ledger), then the
   *  political flip (the site's membership rewrites to the winner,
   *  scoped applyTraitFlip) — or, if the survivors number under
   *  `villagePop`, the PHYSICAL mode instead: the site is emptied into
   *  the attacker and tombstoned (§2b's decided mode split; a conquered
   *  hamlet is emptied, not annexed). Hostility on the resolved edge
   *  resets; the empire's NEW borders arm by themselves the next day —
   *  expansion breeds the next war. A siege that breaks (ratio lost,
   *  direction flipped) cools its edge by `failedSiegeCooling`, so
   *  borders between unmatched civs don't grind forever. STALEMATE
   *  (§2d's third outcome, as decided): while a border is hot, both
   *  endpoints bleed `skirmish` × hostility deaths daily — matched civs
   *  consume people as fast as they are produced, borders frozen until
   *  something shifts the ratio. A world with conquest configured and a
   *  live border never claims rest. */
  conquest?: {
    strengthScalars: Array<{ scalar: string; weight: number }>;
    hostilityAttr: string;
    /** Hostility level that arms a siege (default 1 — the clamp). */
    hostilityAt?: number;
    /** Attacker civ strength ≥ ratio × defender civ strength. */
    ratio: number;
    /** Consecutive armed days (same direction) before the site falls. */
    siegeDays: number;
    /** Fraction of EACH endpoint site's population lost at resolution
     *  (default 0.05). */
    casualties?: number;
    /** Post-casualty population below which the loser is EMPTIED into
     *  the attacker (physical absorb) instead of flipped (default 0 —
     *  always political). */
    villagePop?: number;
    /** Hostility drop when a running siege breaks (default 0). */
    failedSiegeCooling?: number;
    /** Daily death rate × hostility on hot borders, both sides
     *  (default 0 — no attrition). */
    skirmish?: number;
  };
  /** THE DISPUTE MACHINE (nations-and-empires.md §5, P4) — the conquest
   *  block generalized: a dispute is a border under pressure (the
   *  hostility attr); a CHANNEL is a way that pressure drains; the
   *  outcomes are shared (political flip, physical absorb, split, frozen
   *  stalemate). War is channel #1, configured with the exact legacy
   *  conquest shape; `coupling.conquest` remains as war-only sugar
   *  (byte-identical — configure one or the other, never both). Taboos
   *  gate channels per §6: a culture that cannot "fight" never arms the
   *  war channel — hostility still accrues and drains through the rest. */
  dispute?: DisputeCoupling;
}

export type DisputeChannelId = "war" | "blockade" | "prestige" | "union" | "arbitration";

/** Weighted entity-scalar aggregate over a civ's majority sites — the
 *  strength shape (population + ore presence), reused by prestige and
 *  arbitral authority. */
export type CivScalarWeights = Array<{ scalar: string; weight: number }>;

export interface DisputeCoupling {
  /** The pressure attr — every channel reads the same hostility. */
  hostilityAttr: string;
  /** Pressure that arms the hot channels (default 1 — the clamp). */
  hostilityAt?: number;
  /** Channels that are never armed on this world (culture §6 — the
   *  absolute ring projected to the civ tier; see `channelTaboos`).
   *  Tabooed channels may stay configured: the taboo is the gate. */
  taboos?: DisputeChannelId[];
  /** Channel 1 — WAR: the legacy conquest machine, verbatim. Drains
   *  POPULATION (skirmish, siege casualties); outcomes political flip or
   *  physical absorb. Household twin: a fight. */
  war?: {
    strengthScalars: CivScalarWeights;
    /** Attacker civ strength ≥ ratio × defender civ strength. */
    ratio: number;
    /** Consecutive armed days (same direction) before the site falls. */
    siegeDays: number;
    /** Fraction of EACH endpoint site's population lost at resolution
     *  (default 0.05). */
    casualties?: number;
    /** Post-casualty population below which the loser is EMPTIED into
     *  the attacker (physical absorb) instead of flipped (default 0). */
    villagePop?: number;
    /** Hostility drop when a running siege breaks (default 0). */
    failedSiegeCooling?: number;
    /** Daily death rate × hostility on hot borders, both sides
     *  (default 0 — no attrition). */
    skirmish?: number;
  };
  /** Channel 2 — BLOCKADE/EMBARGO: the siege timer aimed at fills. While
   *  a border is hot BOTH endpoints bleed the stock scalar (the blockader
   *  loses trade income too — a real cost, so embargoes end); when exactly
   *  one side sits in shortage for `capitulationDays` straight it
   *  capitulates — terms = the political flip, no casualties. Both sides
   *  shorted = mutual ruin, nobody capitulates (the counter resets).
   *  Household twin: refusing to share. */
  blockade?: {
    /** Entity scalar both endpoints drain while the border is hot. */
    stockScalar: string;
    /** Stock lost per hot day × hostility, BOTH sides. */
    drain: number;
    /** Stock level at or below which a side counts as shorted. */
    shortageAt: number;
    /** Consecutive one-sided shortage days before capitulation. */
    capitulationDays: number;
  };
  /** Channel 3 — PRESTIGE CONTEST: civ prestige = the weighted aggregate
   *  over majority sites (wonders, festivals, wellbeing surplus — content
   *  points the scalars). While a border is hot and one civ sustains
   *  ≥ ratio × the other's prestige for `defectDays`, the lower border
   *  site DEFECTS — the political flip without the siege, no casualties.
   *  Household twin: reputation/warmth. */
  prestige?: {
    scalars: CivScalarWeights;
    ratio: number;
    defectDays: number;
  };
  /** Channel 4 — UNION: both heads consent — a COLD border (pressure
   *  under the arm threshold) whose affinity attr holds ≥ `affinityAt`
   *  for `days` straight merges the crowns: the smaller civ's members
   *  flip to the larger EVERYWHERE (absorb in political mode, whole
   *  holding). Household twin: marriage/move-in. */
  union?: {
    /** Edge attr carrying the standing relation (grown by content —
     *  trade, festivals; the machinery only reads it). */
    affinityAttr: string;
    affinityAt: number;
    days: number;
  };
  /** Channel 5 — ARBITRATION: a third civ with authority over both
   *  disputants (strength ≥ authorityRatio × the stronger one) awards a
   *  split after `afterDays` hot days: pressure drains (`cooling`,
   *  default a full reset), claims stand, nobody flips. Refusal is not
   *  modeled yet — acceptance rides authority (v1 compliance proxy).
   *  Household twin: a parent settling a sibling dispute. */
  arbitration?: {
    strengthScalars: CivScalarWeights;
    authorityRatio: number;
    afterDays: number;
    cooling?: number;
  };
}

/** Culture → channel gating (§6): map a world's absolute-taboo VERBS to
 *  the dispute channels they disarm. An absolute taboo on "fight" means
 *  the war channel is never armed — hostility still accrues but drains
 *  through channels 2–6. */
export function channelTaboos(absoluteVerbs: ReadonlySet<string> | readonly string[]): DisputeChannelId[] {
  const set = Array.isArray(absoluteVerbs) ? new Set(absoluteVerbs) : absoluteVerbs as ReadonlySet<string>;
  return set.has("fight") ? ["war"] : [];
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

export interface DualWorld extends CompositionWorld {
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
   *  Composition site's CIVIC total (all souls when no civicTraits)
   *  after every step. */
  settlementPop(nodeKey: string): number;
  /** The Composition side of that contract: the site's civic carrier
   *  count (all souls when no civicTraits) — what the write-back
   *  writes; the "Layers agree" check compares against this. */
  civicPop(nodeKey: string): number;
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
  /** The ABSORB transaction, physical mode (civilization-emergence.md
   *  §2b) — the founding transaction's mirror: the loser's WHOLE
   *  population moves to the winner (driven migration — exact, uniform by
   *  syndrome, conserving), every loser scalar drops to its var minimum
   *  (the ruin reads as abandoned), and the entity is TOMBSTONED — absent
   *  from all dynamics, incident edges inert, index preserved. One
   *  day-boundary structural event; layers agree immediately. Returns
   *  false when either key is unknown, the keys match, or either side is
   *  already a tombstone. */
  absorbSettlement(loserKey: string, winnerKey: string): boolean;
  /** The ABANDON transaction (settlement-emergence.md Gate D) — the
   *  absorb's no-winner twin: the population EMIGRATES off the
   *  composition (walkers, ledgered separately from deaths — the layer
   *  above turns them into a wild band), and the site ruins exactly as
   *  absorption ruins it. Returns the souls that walked; 0 = refused
   *  (unknown/dead site, or a backend without the emigration channel). */
  abandonSettlement(key: string): number;
  /** Absorbed settlements, oldest first ({ key, day, pop at absorption }). */
  tombstones(): Array<{ key: string; day: number; pop: number }>;
  /** Resolved conquests, oldest first. `mode` is §2b's split: "political"
   *  = the site changed flags; "physical" = a village was emptied into
   *  the attacker (it also appears in tombstones()). */
  conquests(): Array<{
    day: number; edge: number; loser: string; winner: string;
    civ: string; mode: "political" | "physical"; casualties: number;
  }>;
  /** Resolved disputes across ALL channels, oldest first (war rows also
   *  appear in conquests()). `mode`: "political" = a flag changed,
   *  "physical" = a village was emptied (war only), "award" = an arbitral
   *  split — pressure drained, claims stand (loser/winner = the two
   *  disputant endpoints in edge order, civ = the arbiter). */
  resolutions(): Array<{
    day: number; edge: number; channel: DisputeChannelId;
    loser: string; winner: string; civ: string;
    mode: "political" | "physical" | "award"; casualties: number;
  }>;
  /** Lifetime births/deaths — the accounting identity for vital worlds:
   *  totalPop + histfigCount = start + births − deaths. */
  vitalLedger(): { births: number; deaths: number };
  /** Σ of the settlement population scalar — equals PopuSim totalPop()
   *  after every step, by construction. */
  settlementTotalPop(): number;
}

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

export async function bootDual(spec: DualSpec, seed: number, boot: CompositionBoot): Promise<DualWorld> {
  const { nodes, edges, coupling } = spec;

  const valid = validateWorldSpec(spec.settlement);
  if (!valid.ok) {
    throw new Error(`dual: settlement spec rejected: ${valid.errors.join("; ")}`);
  }
  const popVar = (spec.settlement.entity.vars ?? []).find(v => v.name === coupling.populationScalar);
  if (!popVar) {
    throw new Error(`dual: settlement spec lacks the population scalar '${coupling.populationScalar}'`);
  }

  if (coupling.conquest && coupling.dispute) {
    throw new Error("dual: configure coupling.conquest (war-only sugar) OR coupling.dispute, not both");
  }
  // The dispute machine's normalized config: legacy `conquest` is war-only
  // sugar — the war channel IS the old code path, op for op.
  const disp: DisputeCoupling | undefined = coupling.dispute ?? (coupling.conquest ? {
    hostilityAttr: coupling.conquest.hostilityAttr,
    hostilityAt: coupling.conquest.hostilityAt,
    war: {
      strengthScalars: coupling.conquest.strengthScalars,
      ratio: coupling.conquest.ratio,
      siegeDays: coupling.conquest.siegeDays,
      casualties: coupling.conquest.casualties,
      villagePop: coupling.conquest.villagePop,
      failedSiegeCooling: coupling.conquest.failedSiegeCooling,
      skirmish: coupling.conquest.skirmish,
    },
  } : undefined);
  // Taboo gating (§6): a taboo'd channel stays configured but never arms.
  const taboo = new Set<DisputeChannelId>(disp?.taboos ?? []);
  const warCh = taboo.has("war") ? undefined : disp?.war;
  const blockadeCh = taboo.has("blockade") ? undefined : disp?.blockade;
  const prestigeCh = taboo.has("prestige") ? undefined : disp?.prestige;
  const unionCh = taboo.has("union") ? undefined : disp?.union;
  const arbCh = taboo.has("arbitration") ? undefined : disp?.arbitration;
  if (disp?.blockade && !(spec.settlement.entity.vars ?? []).some(v => v.name === disp.blockade!.stockScalar)) {
    throw new Error(`dual: blockade channel names unknown entity var '${disp.blockade.stockScalar}'`);
  }
  if (disp?.union && !(spec.settlement.edge?.vars ?? []).some(v => v.name === disp.union!.affinityAttr)) {
    throw new Error(`dual: union channel names unknown edge var '${disp.union.affinityAttr}'`);
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
  const lab = await boot(scenario, seed);
  const routeObjs = lab.ops.routes;

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
  // Vital carries: fractional births/deaths accumulate per (SPEC, site)
  // until a whole person arrives/leaves — each species' policy keeps
  // its own remainder. Grown on founding.
  const vitalsList: VitalsSpec[] = coupling.vitals
    ? (Array.isArray(coupling.vitals) ? coupling.vitals : [coupling.vitals])
    : [];
  let birthCarry = vitalsList.map(() => new Float64Array(nodes.length));
  let deathCarry = vitalsList.map(() => new Float64Array(nodes.length));
  // Dispute state: per-edge SIGNED day counters (+n = pressure running
  // against `b` for n days, −n = against `a`; direction change resets) —
  // one per channel — and per-site fractional skirmish-death carries.
  // Union/arbitration counters are unsigned (symmetric). Grown on founding.
  let siegeCount = new Int32Array(edges.length);
  let blockadeCount = new Int32Array(edges.length);
  let prestigeCount = new Int32Array(edges.length);
  let unionCount = new Int32Array(edges.length);
  let arbCount = new Int32Array(edges.length);
  let skirmishCarry = new Float64Array(nodes.length);

  // Whether the last settlement step changed anything (rest tracking).
  let settlementChanged = true;

  const restWorld = lab.ops;

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
   *  gains hostility (clamped), whether the civs met by breakaway or
   *  were distinct from boot (conquest worlds start multi-civ), and
   *  however long after an event the majority actually flipped
   *  (day-boundary write — §10's discipline). */
  const armBorders = (): void => {
    if (!coupling.breakawayHostility) return;
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

  /** What the population scalar CARRIES: civic carriers only when the
   *  coupling scopes it, else everyone (legacy). */
  const civicPops = (): number[] => {
    const civ = coupling.civicTraits;
    if (!civ?.length) return sitePops();
    return lab.sites().map(s => civ.reduce((a, t) => a + lab.popOnSiteWithTrait(s.key, t), 0));
  };

  /** The integer write-back (§4 contract): composition truth → the
   *  population scalar, civic-scoped. One shape for the day boundary,
   *  founding and absorption. */
  const writeBackPops = (): void => {
    const after = civicPops();
    const popArr = ew.scalars[coupling.populationScalar];
    for (let k = 0; k < nodes.length; k++) popArr[k] = after[k];
  };

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
      restWorld.applyExternalMigration(moves);
    }

    // 3½. Vital dynamics (day boundary): the Malthusian policies — each
    //     spec's DIET fill gates its births and drives its starvation,
    //     scoped to its species' carriers; PopuSim applies the exact
    //     counts (hereditary-projected births, uniform deaths WITHIN the
    //     scope — one species' famine never bleeds into another's).
    if (vitalsList.length) {
      const popsNow = sitePops();
      for (let si = 0; si < vitalsList.length; si++) {
        const vt = vitalsList[si];
        const needArr = vt.foodNeed ? ew.scalars[vt.foodNeed] : null;
        const gotArr = vt.foodGot ? ew.scalars[vt.foodGot] : null;
        const capArr = vt.capacity ? ew.scalars[vt.capacity.scalar] : null;
        const bc = birthCarry[si];
        const dc = deathCarry[si];
        for (let i = 0; i < nodes.length; i++) {
          const pop = vt.species
            ? lab.popOnSiteWithTrait(nodes[i].key, vt.species)
            : popsNow[i];
          if (pop <= 0) continue;
          const need = needArr ? needArr[i] : 0;
          const fill = need > 0 ? Math.min(1, (gotArr ? gotArr[i] : 0) / need) : 1;
          let headroom = 1;
          if (vt.capacity) {
            const cap = (capArr ? capArr[i] : 0) * vt.capacity.perUnit;
            headroom = cap > 0 ? Math.max(0, 1 - pop / cap) : 0;
          }
          const b = pop * vt.birthRate * fill * headroom + bc[i];
          const d = pop * (vt.deathRate + (vt.starvation ?? 0) * (1 - fill)) + dc[i];
          const births = Math.floor(b);
          const deaths = Math.floor(d);
          bc[i] = b - births;
          dc[i] = d - deaths;
          if (births > 0 || deaths > 0) restWorld.applyVitals(nodes[i].key, births, deaths, vt.species);
        }
      }
    }

    // 3¾. Disputes (§2d generalized, nations §5): skirmish attrition,
    //     channel clocks, resolutions — the day's war dead land in the
    //     same write-back as its vitals.
    processDisputes();

    // 4. Integer write-back: Composition totals are the truth; both layers
    //    now agree exactly (this also absorbs any clamped move).
    writeBackPops();

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
    const live = vitalsList.some(vt =>
      vt.birthRate > 0 || vt.deathRate > 0 || (vt.starvation !== undefined && vt.starvation > 0));
    if (!live) return false;
    return sitePops().some(p => p > 0);
  };

  const isResting = (): boolean =>
    restWorld.isCompositionAtRest() && settlementInert() && !vitalsActive() && !disputePending();

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
    birthCarry = birthCarry.map(old => {
      const grown = new Float64Array(nodes.length);
      grown.set(old);
      return grown;
    });
    deathCarry = deathCarry.map(old => {
      const grown = new Float64Array(nodes.length);
      grown.set(old);
      return grown;
    });
    const growCounter = (old: Int32Array): Int32Array => {
      const grown = new Int32Array(edges.length);
      grown.set(old);
      return grown;
    };
    siegeCount = growCounter(siegeCount);
    blockadeCount = growCounter(blockadeCount);
    prestigeCount = growCounter(prestigeCount);
    unionCount = growCounter(unionCount);
    arbCount = growCounter(arbCount);
    const grownSkirmish = new Float64Array(nodes.length);
    grownSkirmish.set(skirmishCarry);
    skirmishCarry = grownSkirmish;

    if (def.colonists?.length) {
      restWorld.applyExternalMigration(
        def.colonists.map(c => ({ from: c.from, to: def.key, count: c.count })),
      );
    }

    // Immediate write-back: both layers agree from the moment of founding.
    writeBackPops();
    settlementChanged = true; // a founding day is never a resting day
    return i;
  }

  // Absorbed settlements, oldest first — the ruin ledger.
  const tombstoneLog: Array<{ key: string; day: number; pop: number }> = [];

  /** The RUIN half shared by absorb and abandon: every entity scalar to
   *  its floor (fields untended, buildings emptied — the frozen display
   *  state IS the ruin), then structural death — absent from every
   *  dynamic, edges inert, index preserved. */
  function ruinSettlement(li: number, key: string, pop: number): void {
    for (const v of spec.settlement.entity.vars ?? []) {
      ew.scalars[v.name][li] = v.min;
    }
    setEntityDisabled(ew, li);
    for (const e of ew.adj[li]) {
      carry[e] = 0;
      siegeCount[e] = 0; blockadeCount[e] = 0; prestigeCount[e] = 0;
      unionCount[e] = 0; arbCount[e] = 0;
    }
    for (const bc of birthCarry) bc[li] = 0;
    for (const dc of deathCarry) dc[li] = 0;
    skirmishCarry[li] = 0;
    tombstoneLog.push({ key, day: lab.day(), pop });
    // Immediate write-back: layers agree at the moment of ruin.
    writeBackPops();
    settlementChanged = true; // a ruin day is never a resting day
  }

  /** The absorb transaction (physical mode) — see the interface doc. */
  function absorbSettlement(loserKey: string, winnerKey: string): boolean {
    const li = nodeIdx.get(loserKey);
    const wi = nodeIdx.get(winnerKey);
    if (li === undefined || wi === undefined || li === wi) return false;
    if (ew.disabled[li] || ew.disabled[wi]) return false;

    // The whole crowd walks: driven migration, exact and uniform by
    // syndrome (moving everyone is trivially uniform — the same
    // argument applyTraitFlip rides).
    const pop = sitePops()[li];
    if (pop > 0) {
      restWorld.applyExternalMigration([{ from: loserKey, to: winnerKey, count: pop }]);
    }
    ruinSettlement(li, loserKey, pop);
    return true;
  }

  /** ABANDONMENT (settlement-emergence.md Gate D): the settlement fails
   *  and its people leave the settled world entirely — emigrants, never
   *  deaths (the layer above turns them back into a wild BAND; that is
   *  what keeps foragers permanent rather than transitional). Same ruin
   *  as absorption, but the crowd has no winner to walk to. Returns the
   *  souls that walked; 0 = refused (unknown/dead site, or a composition
   *  backend without the emigration channel). */
  function abandonSettlement(key: string): number {
    const li = nodeIdx.get(key);
    if (li === undefined || ew.disabled[li]) return 0;
    if (!restWorld.applyEmigration) return 0;

    // 0 always means NOTHING HAPPENED: an empty settlement has nobody to
    // walk (emptying ghost towns is absorption's business).
    const pop = sitePops()[li];
    if (pop <= 0) return 0;
    const walked = restWorld.applyEmigration(key, pop);
    if (walked <= 0) return 0;
    ruinSettlement(li, key, walked);
    return walked;
  }

  // Resolved conquests, oldest first — the war ledger (war rows only,
  // the legacy API); resolutionLog carries every channel's outcomes.
  const conquestLog: Array<{
    day: number; edge: number; loser: string; winner: string;
    civ: string; mode: "political" | "physical"; casualties: number;
  }> = [];
  const resolutionLog: Array<{
    day: number; edge: number; channel: DisputeChannelId;
    loser: string; winner: string; civ: string;
    mode: "political" | "physical" | "award"; casualties: number;
  }> = [];

  /** Reset every channel counter on an edge (endpoint disabled, not a
   *  border, or the dispute just resolved). */
  const resetDispute = (e: number): void => {
    siegeCount[e] = 0; blockadeCount[e] = 0; prestigeCount[e] = 0;
    unionCount[e] = 0; arbCount[e] = 0;
  };

  /** Weighted entity-scalar aggregate per civ over its majority sites —
   *  war strength, prestige, and arbitral authority all ride this shape. */
  const civAggregate = (weights: CivScalarWeights, majority: Array<string | null>): Map<string, number> => {
    const agg = new Map<string, number>();
    for (let i = 0; i < nodes.length; i++) {
      const m = majority[i];
      if (!m || ew.disabled[i]) continue;
      let s = 0;
      for (const w of weights) s += w.weight * (ew.scalars[w.scalar]?.[i] ?? 0);
      agg.set(m, (agg.get(m) ?? 0) + s);
    }
    return agg;
  };

  /** DISPUTE processing (§5), one pass per day between vitals and the
   *  write-back: every border edge is a dispute over the land under it;
   *  each configured, un-taboo'd channel drains the shared pressure its
   *  own way, and the first channel to hit its threshold resolves the
   *  edge (further channels wait for tomorrow's new border). The war
   *  branch replicates the legacy conquest ops exactly — the
   *  byte-identical gate of P4. */
  const processDisputes = (): void => {
    if (!disp) return;
    const host = ew.edgeAttr[disp.hostilityAttr];
    if (!host) throw new Error(`dual: settlement spec has no edge var '${disp.hostilityAttr}'`);
    const hostAt = disp.hostilityAt ?? 1;
    const majority = nodes.map(n => civOf(n.key)?.trait ?? null);

    const strength = warCh ? civAggregate(warCh.strengthScalars, majority) : null;
    const prestige = prestigeCh ? civAggregate(prestigeCh.scalars, majority) : null;
    const authority = arbCh ? civAggregate(arbCh.strengthScalars, majority) : null;
    const stock = blockadeCh ? ew.scalars[blockadeCh.stockScalar] : null;
    const affinity = unionCh ? ew.edgeAttr[unionCh.affinityAttr] : null;

    for (let e = 0; e < edges.length; e++) {
      const ia = nodeIdx.get(edges[e].a)!;
      const ib = nodeIdx.get(edges[e].b)!;
      if (ew.disabled[ia] || ew.disabled[ib]) { resetDispute(e); continue; }
      const ca = majority[ia];
      const cb = majority[ib];
      if (!ca || !cb || ca === cb) { resetDispute(e); continue; }

      // ---- Channel 1: WAR — drains population. (Legacy ops, verbatim.)
      if (warCh && strength) {
        // Stalemate attrition: a hot border bleeds both endpoints daily —
        // through the vitals mechanism, so the ledger stays exact.
        if (warCh.skirmish && host[e] > 0) {
          const popsNow = sitePops();
          for (const [i, key] of [[ia, edges[e].a], [ib, edges[e].b]] as Array<[number, string]>) {
            const d = popsNow[i] * warCh.skirmish * host[e] + skirmishCarry[i];
            const deaths = Math.floor(d);
            skirmishCarry[i] = d - deaths;
            if (deaths > 0) restWorld.applyVitals(key, 0, deaths);
          }
        }

        // Siege: armed while the border is at heat AND one civ overmatches
        // the other. Signed counter — a direction change restarts the clock.
        const sa = strength.get(ca) ?? 0;
        const sb = strength.get(cb) ?? 0;
        const dir = sa > 0 && sa >= sb * warCh.ratio ? 1 : sb > 0 && sb >= sa * warCh.ratio ? -1 : 0;
        if (host[e] >= hostAt && dir !== 0) {
          siegeCount[e] = Math.sign(siegeCount[e]) === dir ? siegeCount[e] + dir : dir;
          if (Math.abs(siegeCount[e]) >= warCh.siegeDays) {
            resolveWar(e, dir > 0 ? ia : ib, dir > 0 ? ib : ia);
            resetDispute(e);
            continue;
          }
        } else {
          // A broken siege cools the border faster than baseline decay —
          // unmatched neighbors don't grind forever.
          if (siegeCount[e] !== 0 && warCh.failedSiegeCooling) {
            injectEdge(ew, e, disp.hostilityAttr, -warCh.failedSiegeCooling);
          }
          siegeCount[e] = 0;
        }
      }

      // ---- Channel 2: BLOCKADE — the siege timer aimed at fills. Both
      // sides pay (the blockader loses the trade too); one side alone in
      // sustained shortage capitulates — terms, not casualties.
      if (blockadeCh && stock) {
        if (host[e] >= hostAt) {
          const amt = blockadeCh.drain * host[e];
          injectEntity(ew, ia, blockadeCh.stockScalar, -amt);
          injectEntity(ew, ib, blockadeCh.stockScalar, -amt);
          const aShort = stock[ia] <= blockadeCh.shortageAt;
          const bShort = stock[ib] <= blockadeCh.shortageAt;
          if (aShort !== bShort) {
            const dir = aShort ? -1 : 1; // sign points at the LOSING side's b/a
            blockadeCount[e] = Math.sign(blockadeCount[e]) === dir ? blockadeCount[e] + dir : dir;
            if (Math.abs(blockadeCount[e]) >= blockadeCh.capitulationDays) {
              resolvePolitical(e, aShort ? ib : ia, aShort ? ia : ib, "blockade");
              resetDispute(e);
              continue;
            }
          } else {
            blockadeCount[e] = 0; // both fat or both ruined — no terms
          }
        } else {
          blockadeCount[e] = 0;
        }
      }

      // ---- Channel 3: PRESTIGE — the political flip without the siege:
      // a border settlement defects toward sustained prestige overmatch.
      if (prestigeCh && prestige) {
        const pa = prestige.get(ca) ?? 0;
        const pb = prestige.get(cb) ?? 0;
        const dir = pa > 0 && pa >= pb * prestigeCh.ratio ? 1 : pb > 0 && pb >= pa * prestigeCh.ratio ? -1 : 0;
        if (host[e] >= hostAt && dir !== 0) {
          prestigeCount[e] = Math.sign(prestigeCount[e]) === dir ? prestigeCount[e] + dir : dir;
          if (Math.abs(prestigeCount[e]) >= prestigeCh.defectDays) {
            resolvePolitical(e, dir > 0 ? ia : ib, dir > 0 ? ib : ia, "prestige");
            resetDispute(e);
            continue;
          }
        } else {
          prestigeCount[e] = 0;
        }
      }

      // ---- Channel 4: UNION — a COLD border with standing affinity
      // merges the crowns (both heads consent; the moveInStep one tier up).
      if (unionCh && affinity) {
        if (host[e] < hostAt && affinity[e] >= unionCh.affinityAt) {
          unionCount[e]++;
          if (unionCount[e] >= unionCh.days) {
            resolveUnion(e, ia, ib);
            resetDispute(e);
            continue;
          }
        } else {
          unionCount[e] = 0;
        }
      }

      // ---- Channel 5: ARBITRATION — a third civ with authority over
      // both drains what nobody wins: the award resets the pressure,
      // claims stand (a parent settling a sibling dispute).
      if (arbCh && authority) {
        let arbiter: string | null = null;
        if (host[e] >= hostAt) {
          const sa = authority.get(ca) ?? 0;
          const sb = authority.get(cb) ?? 0;
          const need = arbCh.authorityRatio * Math.max(sa, sb);
          for (const civ of coupling.civs ?? []) {
            if (civ.trait === ca || civ.trait === cb) continue;
            const s = authority.get(civ.trait) ?? 0;
            if (s > 0 && s >= need) { arbiter = civ.trait; break; }
          }
        }
        if (arbiter) {
          arbCount[e]++;
          if (arbCount[e] >= arbCh.afterDays) {
            injectEdge(ew, e, disp.hostilityAttr, -(arbCh.cooling ?? host[e]));
            resolutionLog.push({
              day: lab.day(), edge: e, channel: "arbitration",
              loser: edges[e].a, winner: edges[e].b, civ: arbiter,
              mode: "award", casualties: 0,
            });
            arbCount[e] = 0;
            settlementChanged = true; // an award day is never a resting day
          }
        } else {
          arbCount[e] = 0;
        }
      }
    }
  };

  /** One site falls to WAR: casualties both sides, then the §2b mode
   *  split — political flip for a town, physical absorption for a
   *  village. */
  const resolveWar = (e: number, wi: number, li: number): void => {
    const cq = warCh!;
    const winnerKey = nodes[wi].key;
    const loserKey = nodes[li].key;
    const winnerCiv = civOf(winnerKey)?.trait;
    const loserCiv = civOf(loserKey)?.trait;
    if (!winnerCiv || !loserCiv || winnerCiv === loserCiv) return;

    // Casualties on both sides — uniform removal, on the vital ledger.
    const cas = cq.casualties ?? 0.05;
    const popsNow = sitePops();
    const dw = Math.floor(popsNow[wi] * cas);
    const dl = Math.floor(popsNow[li] * cas);
    if (dw > 0) restWorld.applyVitals(winnerKey, 0, dw);
    if (dl > 0) restWorld.applyVitals(loserKey, 0, dl);

    const remaining = sitePops()[li];
    let mode: "political" | "physical";
    if (remaining < (cq.villagePop ?? 0)) {
      // A conquered VILLAGE is emptied into the attacker (§2b physical).
      mode = "physical";
      absorbSettlement(loserKey, winnerKey);
    } else {
      // A conquered TOWN changes flags: the site's membership rewrites
      // to the winner — the empire exists the moment the flip lands.
      mode = "political";
      restWorld.applyTraitFlip([loserCiv], [winnerCiv], [loserCiv], loserKey);
    }

    // The war is over on this road; the empire's new borders will arm
    // themselves tomorrow.
    const host = ew.edgeAttr[disp!.hostilityAttr];
    injectEdge(ew, e, disp!.hostilityAttr, -host[e]);
    conquestLog.push({ day: lab.day(), edge: e, loser: loserKey, winner: winnerKey, civ: winnerCiv, mode, casualties: dw + dl });
    resolutionLog.push({ day: lab.day(), edge: e, channel: "war", loser: loserKey, winner: winnerKey, civ: winnerCiv, mode, casualties: dw + dl });
    settlementChanged = true; // a conquest day is never a resting day
  };

  /** A NONVIOLENT flip — blockade terms, prestige defection: the loser
   *  endpoint changes flags through the same sanctioned op as war's
   *  political mode, with no casualties. */
  const resolvePolitical = (e: number, wi: number, li: number, channel: DisputeChannelId): void => {
    const winnerKey = nodes[wi].key;
    const loserKey = nodes[li].key;
    const winnerCiv = civOf(winnerKey)?.trait;
    const loserCiv = civOf(loserKey)?.trait;
    if (!winnerCiv || !loserCiv || winnerCiv === loserCiv) return;
    restWorld.applyTraitFlip([loserCiv], [winnerCiv], [loserCiv], loserKey);
    const host = ew.edgeAttr[disp!.hostilityAttr];
    injectEdge(ew, e, disp!.hostilityAttr, -host[e]);
    resolutionLog.push({ day: lab.day(), edge: e, channel, loser: loserKey, winner: winnerKey, civ: winnerCiv, mode: "political", casualties: 0 });
    settlementChanged = true; // a capitulation day is never a resting day
  };

  /** UNION: the smaller civ joins the larger EVERYWHERE — political
   *  absorb of the whole holding (planet/polities `merge` is this
   *  relabel's territorial write, P5). Ties go to edge-`a`'s crown —
   *  deterministic. */
  const resolveUnion = (e: number, ia: number, ib: number): void => {
    const ca = civOf(nodes[ia].key)?.trait;
    const cb = civOf(nodes[ib].key)?.trait;
    if (!ca || !cb || ca === cb) return;
    const popA = civCounts(ca).reduce((a, c) => a + c, 0);
    const popB = civCounts(cb).reduce((a, c) => a + c, 0);
    const aWins = popA >= popB;
    const winnerCiv = aWins ? ca : cb;
    const loserCiv = aWins ? cb : ca;
    restWorld.applyTraitFlip([loserCiv], [winnerCiv], [loserCiv]);
    const host = ew.edgeAttr[disp!.hostilityAttr];
    injectEdge(ew, e, disp!.hostilityAttr, -host[e]);
    resolutionLog.push({
      day: lab.day(), edge: e, channel: "union",
      loser: aWins ? nodes[ib].key : nodes[ia].key,
      winner: aWins ? nodes[ia].key : nodes[ib].key,
      civ: winnerCiv, mode: "political", casualties: 0,
    });
    settlementChanged = true; // a union day is never a resting day
  };

  /** Dispute worlds with a LIVE border (different majority civs on any
   *  active edge) and at least one ARMED-ABLE channel never claim rest:
   *  counters tick, drains bleed, hostility arms daily. Conservative —
   *  a bordered stalemate world steps forever, by design ("visibly
   *  bleeding", §2d). A world whose every channel is taboo'd CAN rest:
   *  the border freezes — the cold-war regime. */
  const disputePending = (): boolean => {
    if (!disp) return false;
    if (!warCh && !blockadeCh && !prestigeCh && !unionCh && !arbCh) return false;
    const majority = nodes.map(n => civOf(n.key)?.trait ?? null);
    for (let e = 0; e < edges.length; e++) {
      const ia = nodeIdx.get(edges[e].a)!;
      const ib = nodeIdx.get(edges[e].b)!;
      if (ew.disabled[ia] || ew.disabled[ib]) continue;
      const ca = majority[ia];
      const cb = majority[ib];
      if (ca && cb && ca !== cb) return true;
    }
    return false;
  };

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
    civicPop: (nodeKey) => {
      const i = nodeIdx.get(nodeKey);
      return i === undefined ? 0 : civicPops()[i];
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
    absorbSettlement,
    abandonSettlement,
    tombstones: () => tombstoneLog.slice(),
    conquests: () => conquestLog.slice(),
    resolutions: () => resolutionLog.slice(),
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
