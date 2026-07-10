/**
 * economy.ts — THE CONTENT SEAM (civilization-emergence.md step 6d).
 *
 * Goods, buildings and production chains are DATA, not code: an
 * `EconomyDoc` is a JSON-shaped document a world (eventually an external
 * definition file) supplies, and `compileEconomy` expands it into
 * everything the four layers need —
 *
 *   settlement  → vars, processes, sums, allocates, flow nets, build
 *                 rules (the cell-systems WorldSpec fragments; the
 *                 idle-safety validator remains the certification gate
 *                 for whatever this emits),
 *   coupling    → demandInputs + trait demand rows,
 *   street      → GoodSpec descriptors (food.ts machinery is already
 *                 good-agnostic; errand roles and box corners assign by
 *                 registration order),
 *   presentation→ the WORK REGISTRY (map styles, glyphs, titles, info
 *                 templates, placement bearings, district classes) that
 *                 replaced the hard-coded `Record<union, …>` tables.
 *
 * WHAT THE COMPILER ENFORCES (laws, not parameters — every one of these
 * was a trap we hit while hand-calibrating):
 *   • INDUSTRY AFTER SUBSISTENCE — a tier-"industry" build rule gates on
 *     every base building reaching its cap; authors declare a TIER, the
 *     compiler writes the gates. Hand-written cumulative thresholds
 *     above the base stack are unreachable (the fed-transient law).
 *   • STAGGERED FUNDING — within a tier, granary thresholds accumulate
 *     over the declared costs so one step never overdraws the stock;
 *     extra (non-funding) costs guard at exactly their amount.
 *   • ANCHORED CAPACITY — every building must name a charter/population
 *     anchor (`cap`); unanchored industry is path-dependent and breaks
 *     the planned-history provider (world-content.md §3d Gap B).
 *   • ONE VOCABULARY — the street projects settlement scalars only; a
 *     good's projection exists exactly where the ledger does.
 *
 * Escape hatch: `processes` on a building are near-raw ProcessSpecs (the
 * only sugar is `capacityRate` → capacityBy = the building's own count),
 * so exotic chains stay expressible — the validator gates them anyway.
 */

import type {
  AllocateSpec, Condition, FlowNetSpec, ProcessSpec, RoadSpec, RuleSpec, SumSpec, SystemSpec, VarSpec,
} from "../../cells/spec";

/* --------------------- types the compiler emits into --------------------- */

/**
 * A HOUSEHOLD GOOD, described: everything the street projection needs to
 * render one commodity's flow at individual scale. The math downstream is
 * good-agnostic — sources, street-nearest catchments, shopping cycles,
 * house boxes, stall stock, district fills, traffic — so a new commodity
 * is a new descriptor plus aggregate scalars, not new machinery.
 * (Owned here since the engine carve; the street layer re-exports it.)
 */
export interface GoodSpec {
  /** Commodity key — namespaces the cycle-offset draw so two goods'
   *  shopping routines don't move in lockstep. (Stand and dawn-cart
   *  draws keep their pre-descriptor formats: correlated across goods,
   *  harmless — geometry differs per good — and food stays byte-stable.) */
  key: string;
  /** Site scalars: aggregate demand and what the flow net delivered. */
  needScalar: string;
  gotScalar: string;
  /** Work types that SELL this good over a counter — their doorsteps
   *  become sources. Empty/absent in a town ⇒ the hall hands out the
   *  imports (flow-net towns still eat). */
  sellers: ReadonlyArray<string>;
  /** Source kinds with a stocked SHELF (dawn-stocked, drawn down across
   *  the day). Others sell from the field / hand out at the door. */
  shelved: ReadonlyArray<string>;
  /** Work types the supply hauls set out from (district supply order —
   *  who is "near the producers" for THIS good). */
  producers: ReadonlyArray<string>;
  /** Units one person draws per street day (food: 1 ration). */
  perCapitaDaily: number;
  /** Street days of the good a full house box holds. */
  capDays: number;
  /** Seconds a shopper dwells at the stall. */
  shopSec: number;
  /** Units one supply cart carries (haul-traffic weighting). */
  cartRations: number;
  // --- presentation (optional — compiled economies fill these; the
  // street machinery above never reads them) ---
  /** Unit name for panels ("rations", "tool-days"). */
  unit?: string;
  /** Renderer color of the shelf stock at this good's counters. */
  stockColor?: string;
  /** Panel label of the house box ("Pantry", "Wares chest"). */
  boxLabel?: string;
  /** The errand's name in prose ("wares" → "runs the wares errands"). */
  errandName?: string;
  /** House box corner slot (0 SW, 1 SE, 2 NE, 3 NW) = the household
   *  errand ROLE — both assigned by registration order. */
  slot?: number;
}

/**
 * A Malthusian policy the dual coupling runs (per species, or whole-site
 * when `species` is omitted). Owned here since the engine carve; the
 * dual layer re-exports it.
 */
export interface VitalsSpec {
  /** Trait key scoping this policy to one species' carriers — births,
   *  deaths and starvation all stay inside it. Omit = whole site. */
  species?: string;
  birthRate: number;
  deathRate: number;
  /** Extra death rate at zero diet fill (scaled by 1 − fill). */
  starvation?: number;
  foodNeed?: string;
  foodGot?: string;
  /** Pen/pasture headroom (domestic herds): births scale by
   *  max(0, 1 − pop / (scalar × perUnit)) — a herd grows into its pens
   *  and no further, and with NO pens (cap ≤ 0) births stop entirely,
   *  so an untended founding flock dwindles at its death rate. */
  capacity?: { scalar: string; perUnit: number };
}

/* ------------------------------ the document ------------------------------ */

export interface StockpileDef {
  /** Var name (also what build costs and flow drifts reference). */
  key: string;
  max: number;
  /** Panel label ("Granary"); defaults to the prettified key. */
  name?: string;
  /** The construction system's funding stock — the var (and any drift
   *  into it) exists only when the world runs construction. */
  construction?: boolean;
}

export interface CommodityStreetDef {
  /** Street days a full house box holds (trip cadence). */
  capDays: number;
  /** Seconds a shopper dwells at the counter. */
  shopSec: number;
  /** Units one supply cart carries. */
  cartRations: number;
  /** Unit name for panels ("rations", "tool-days"). */
  unit: string;
  /** Work types this good's supply hauls set out from. */
  producers: string[];
  /** Sold at the plaza market / neighborhood stalls (food's channel). */
  market?: boolean;
  /** Renderer color of the shelf-stock dots at the seller's stands. */
  stockColor: string;
  /** Panel label of the house box ("Pantry", "Wares chest"). */
  boxLabel: string;
  /** The errand's name in prose ("wares" → "runs the wares errands"). */
  errandName: string;
}

export interface CommodityDef {
  key: string;
  /** Clamp for this commodity's convention scalars (`_out/_need/_got`,
   *  the pop-want scalar, allocate shares). */
  scalarMax: number;
  /** Per-person daily demand → a trait demand row + a demandInputs row.
   *  Omit for pure intermediates (ore, planks, wool). */
  perPersonDaily?: number;
  /** Scalar the POPULATION's demand lands in. Default `{key}_need`;
   *  override when industry also draws the commodity and a `needSum`
   *  builds `{key}_need` (the metal lesson — fan-in, never overwrite). */
  popScalar?: string;
  /** Ship it on the road network. Omit for local-only commodities. */
  transport?: {
    /** Flow net id (default the key; ore's is "oreflow" historically). */
    id?: string;
    /** Demand scalar (default `{key}_need`) — planks flow against the
     *  smiths' draw directly, no household `_need` var exists. */
    demand?: string;
    /** Stockpile receiving overproduction drift. */
    drift?: string;
    /** The drift exists only under construction (the granary case —
     *  the funding stock IS the construction system's). */
    driftRequiresConstruction?: boolean;
    /** This trade wears the roads (a RoadSpec entry). */
    wearsRoad?: boolean;
  };
  /** Fan-in: `{key}_need := Σ terms` — declare when several wants
   *  compete (households + industry draws). */
  needSum?: string[];
  /** Fan-out of `{key}_got` in PRIORITY ORDER — first listed, first
   *  fed. Policy is data and it matters (smiths-first vs households-
   *  first decides whether the tool chain lives). */
  allocate?: Array<{ share: string; demand: string }>;
  /** Street projection — household goods only. Presence makes this a
   *  good people shop for (a GoodSpec + an errand role + a house box). */
  street?: CommodityStreetDef;
}

export interface BuildingDef {
  /** The work type string (what TownWork.type carries). */
  key: string;
  /** Count var ("farms"). Monotone int — demolition needs its own shape. */
  countScalar: string;
  /** REQUIRED anchor: cap := by × rate, `by` a charter attr or
   *  "population" (the sanctioned footloose fallback). */
  cap: { by: string; rate: number };
  /** Processes in evaluation order (chains read same-step in array
   *  order). Near-raw ProcessSpecs; `capacityRate` present ⇒ capacityBy
   *  is this building's count var. */
  processes: Array<{
    id: string;
    input?: string;
    inputs?: Array<{ scalar: string; efficiency: number }>;
    output: string;
    efficiency?: number;
    capacityRate?: number;
  }>;
  /** Vars this building introduces beyond count/cap: local
   *  intermediates (grain_out) and reagent draws (smith_metal_draw). */
  vars?: Array<{ name: string; max: number }>;
  construction: {
    /** base = subsistence ladder; industry = gates on base complete. */
    tier: "base" | "industry";
    /** costs[0] is the FUNDING cost (staggers cumulatively within the
     *  tier); the rest guard and spend at exactly their amount. */
    costs: Array<{ stockpile: string; amount: number }>;
  };
  /** Commodity keys sold to households (a street seller). */
  sells?: string[];
  /** Sells over a stocked SHELF (dawn-stocked counter) vs at the gate. */
  shelved?: boolean;
  /** Placement lean: a substrate FIELD name (fertility/ore/plant), or
   *  null — takes an outskirt street tip whichever way it points. */
  leansToward: string | null;
  /** Most footprints the town plan draws (landmarks, not the ledger). */
  mapCap: number;
  district: "farm" | "mining" | "craft" | null;
  style: { color: string; w: number; h: number };
  vignette: { w: number; h: number };
  glyph: string;
  /** Panel title ("🌾 Farmstead"). */
  title: string;
  /** Info-line templates: `{scalar}` → raw value, `{scalar:N}` →
   *  toFixed(N), `{per:out/count}` → the per-building production form. */
  info: string[];
}

/** A species' Malthusian policy (sapient/domestic — PopuSim-backed). */
export interface SpeciesVitalsDef {
  birth: number;
  death: number;
  /** Extra death rate at zero diet fill. */
  starvation?: number;
  /** The species' DIET: a commodity key — its fill reads
   *  `{diet}_need`/`{diet}_got`. Different species starve on different
   *  scarcities; omit for a diet-free population (pens-capped only). */
  diet?: string;
  /** Pen/pasture cap: births stop as carriers approach
   *  scalar × perUnit (no pens ⇒ an untended herd dwindles). */
  capacity?: { scalar: string; perUnit: number };
}

export interface SpeciesDef {
  /** The PopuSim trait key (sapient/domestic) or the settlement var's
   *  identity (commensal). */
  key: string;
  /** sapient = citizens (civic by default, syndromes, politics);
   *  domestic = owned populations (herds — PopuSim pops with a species
   *  trait, never civic); commensal = urban wildlife (a settlement
   *  scalar chasing a derived carrying capacity — no PopuSim identity,
   *  no vitals machinery, just idle-safe dynamics). */
  role: "sapient" | "domestic" | "commensal";
  name: string;
  /** PopuSim trait color "r,g,b,a" (lab trait view). */
  color?: string;
  /** Panel glyph ("🐑", "🐀"). */
  glyph?: string;
  /** Per-head daily demands — each resource must be a declared
   *  commodity; these join demandInputs and ride the trait, so
   *  aggregate demand follows who (and what) actually lives there. */
  needs?: Array<{ resource: string; value: number }>;
  vitals?: SpeciesVitalsDef;
  /** Counts toward the CIVIC population scalar (tiers, strength,
   *  houses). Default: role === "sapient". */
  civic?: boolean;
  /** Share of a founding crowd that is THIS species (startpop weight;
   *  the primary sapient takes the remainder) — herds arrive with
   *  their founders and grow into the pens that get built. */
  foundingShare?: number;
  /** Sapient only: a WILD substrate population of this species — an
   *  animal-model field (logistic growth toward habitat-set capacity,
   *  the `people` pattern) that pools where ITS land is good, gates
   *  foundings, and is HARVESTED into founding crowds. `habitat` names
   *  an existing substrate field (fertility, ore, lure, plant...);
   *  capacity = habitat × scale (default 2). Humans ride the implicit
   *  `people`/`lure` field the base substrate already carries. */
  wild?: { field: string; habitat: string; scale?: number };
  /** Settlement scalar carrying the species headcount (traitInputs
   *  count mode for PopuSim species; the LIVE population var itself
   *  for commensals). Production anchors read it — wool from actual
   *  sheep. */
  countScalar?: string;
  countMax?: number;
  /** Commensal only: carrying capacity = by × rate... */
  capacity?: { by: string; rate: number };
  /** ...which the population chases at this rate per day (a `toward`
   *  effect — converges and stops; 1-var loop, idle-safe). */
  growth?: number;
}

export interface EconomyDoc {
  stockpiles?: StockpileDef[];
  commodities?: CommodityDef[];
  buildings?: BuildingDef[];
  species?: SpeciesDef[];
}

/* ------------------------------ compiled out ------------------------------ */

/** The IMPLICIT primary species: every world has humans unless a
 *  content document overrides the "human" key. Their demand vector
 *  comes from the commodities' `perPersonDaily` rows (the pre-species
 *  form, preserved verbatim); the vitals are the numbers the tri
 *  worlds have always run. */
export const HUMAN_SPECIES: SpeciesDef = {
  key: "human",
  role: "sapient",
  name: "Human",
  color: "150,150,150,1",
  civic: true,
  vitals: { birth: 0.02, death: 0.01, starvation: 0.05, diet: "food" },
  // The base substrate already carries this field (lure = max(fertility,
  // ore) — the Sugarscape landscape); declaring it here just makes the
  // human crowd one species among the wilds.
  wild: { field: "people", habitat: "lure", scale: 2 },
};

export interface CompiledEconomy {
  vars: VarSpec[];
  rules: RuleSpec[];
  processes: ProcessSpec[];
  sums: SumSpec[];
  allocates: AllocateSpec[];
  flownets: FlowNetSpec[];
  roads: RoadSpec[];
  demandInputs: Array<{ resource: string; scalar: string }>;
  traitDemands: Array<{ resource: string; value: number }>;
  /** Street goods in registration order — full GoodSpecs (machinery +
   *  presentation); `slot` = box corner AND household errand role. */
  goods: GoodSpec[];
  /** The work registry, in registration order (town-plan placement
   *  order). Hall and market are STRUCTURAL (every town has a hall; the
   *  market arms by town size) and live in the town layer, not here. */
  works: BuildingDef[];
  /** Stockpile registry (panel rows; the vars are in `vars` already). */
  stockpiles: StockpileDef[];
  /** Per-commodity supply rows (got/need scalar pairs, registration
   *  order) — the city view's Supply bars come from HERE, so a modded
   *  commodity's bar appears the moment its ledger does. */
  fills: Array<{ good: string; got: string; need: string }>;
  /** The species registry — implicit human first, then declared. */
  species: SpeciesDef[];
  /** PopuSim trait defs for the sapient/domestic species (human first,
   *  demand from the commodity rows) — the composition consumes these. */
  speciesTraits: Array<{
    key: string; name: string; color: string; hereditary: true;
    demand: Array<{ resource: string; value: number }>;
  }>;
  /** Per-species Malthusian policies (dual coupling `vitals`), civic
   *  species first — the planner models index 0. */
  vitals: VitalsSpec[];
  /** Species that count toward the population scalar. */
  civicTraits: string[];
  /** Species headcounts → settlement scalars (coupling traitInputs). */
  traitInputs: Array<{ trait: string; scalar: string; mode: "count" }>;
}

export interface CompileOpts {
  /** Emit the funding stock, cap vars/processes and build rules. */
  construction?: boolean;
  /** Scalars the HOST world declares outside the economy (the compiler
   *  checks every reference resolves — a typo'd scalar name fails at
   *  compile with the def's name, not at runtime as a silent 0). */
  structuralScalars?: readonly string[];
}

/** The tri worlds' structural vars — population written by the
 *  coupling, the charter attrs tri.ts samples, the unrest input. */
export const STRUCTURAL_SCALARS: readonly string[] = [
  "population", "farmland", "ore_access", "timberland", "unrest",
];

/** Merge docs by key — a later doc's commodity/building/stockpile with
 *  the same key REPLACES the earlier one IN PLACE (goods2 reshapes metal
 *  without moving its flow-net position). */
function mergeDocs(docs: EconomyDoc[]): Required<EconomyDoc> {
  const byKey = <T extends { key: string }>(lists: Array<T[] | undefined>): T[] => {
    const order: string[] = [];
    const map = new Map<string, T>();
    for (const list of lists) {
      for (const item of list ?? []) {
        if (!map.has(item.key)) order.push(item.key);
        map.set(item.key, item);
      }
    }
    return order.map(k => map.get(k)!);
  };
  return {
    stockpiles: byKey(docs.map(d => d.stockpiles)),
    commodities: byKey(docs.map(d => d.commodities)),
    buildings: byKey(docs.map(d => d.buildings)),
    // The implicit human leads; a document may override the "human" key.
    species: byKey([[HUMAN_SPECIES], ...docs.map(d => d.species)]),
  };
}

/** AUTHOR-ERROR checks over one document (duplicates hide overrides)
 *  and the merged whole (dangling references) — content breaks at
 *  compile with the def's name, never at runtime as a silent 0. */
function validateDocs(docs: EconomyDoc[], doc: Required<EconomyDoc>): void {
  const fail = (msg: string): never => { throw new Error(`economy: ${msg}`); };

  // Duplicate keys WITHIN one document are author error (cross-document
  // repeats are the sanctioned override mechanism — goods2's metal).
  for (const d of docs) {
    for (const [section, list] of [
      ["stockpile", d.stockpiles], ["commodity", d.commodities],
      ["building", d.buildings], ["species", d.species],
    ] as const) {
      const seen = new Set<string>();
      for (const item of list ?? []) {
        if (seen.has(item.key)) fail(`duplicate ${section} "${item.key}" within one document`);
        seen.add(item.key);
      }
    }
  }

  const stockpiles = new Set(doc.stockpiles.map(s => s.key));
  const commodities = new Set(doc.commodities.map(c => c.key));
  const buildings = new Set(doc.buildings.map(b => b.key));

  for (const b of doc.buildings) {
    if (!b.cap || !(b.cap.rate > 0)) {
      fail(`building "${b.key}" has no capacity anchor — unanchored industry is path-dependent (§3d Gap B)`);
    }
    if (!b.construction?.costs?.length) {
      fail(`building "${b.key}" declares no construction costs — it could never be built`);
    }
    for (const cost of b.construction.costs) {
      if (!stockpiles.has(cost.stockpile)) {
        fail(`building "${b.key}" costs unknown stockpile "${cost.stockpile}"`);
      }
    }
    for (const sold of b.sells ?? []) {
      if (!commodities.has(sold)) fail(`building "${b.key}" sells unknown commodity "${sold}"`);
    }
    if (b.shelved && !(b.sells ?? []).length) {
      fail(`building "${b.key}" is shelved but sells nothing`);
    }
  }
  for (const c of doc.commodities) {
    if (c.transport?.drift && !stockpiles.has(c.transport.drift)) {
      fail(`commodity "${c.key}" drifts into unknown stockpile "${c.transport.drift}"`);
    }
    for (const p of c.street?.producers ?? []) {
      if (!buildings.has(p) && p !== "hall" && p !== "market") {
        fail(`commodity "${c.key}" names unknown producer "${p}"`);
      }
    }
  }
  for (const s of doc.species) {
    for (const n of s.needs ?? []) {
      if (!commodities.has(n.resource)) {
        fail(`species "${s.key}" needs unknown commodity "${n.resource}"`);
      }
    }
    if (s.vitals?.diet && !commodities.has(s.vitals.diet)) {
      fail(`species "${s.key}" eats unknown commodity "${s.vitals.diet}"`);
    }
    if (s.role === "commensal") {
      if (!s.countScalar || !s.capacity || !(s.growth && s.growth > 0)) {
        fail(`commensal species "${s.key}" needs countScalar, capacity and growth`);
      }
      if (s.vitals || s.needs?.length || s.foundingShare) {
        fail(`commensal species "${s.key}" is settlement-scalar wildlife — no vitals, needs or founding share`);
      }
    } else if (!s.vitals) {
      fail(`species "${s.key}" has no vitals — an immortal population never rests honestly`);
    }
    if (s.foundingShare !== undefined && !(s.foundingShare > 0 && s.foundingShare < 1)) {
      fail(`species "${s.key}" foundingShare must be in (0, 1)`);
    }
  }
}

/** Every scalar the compiled fragments reference must be DECLARED — an
 *  economy var, a stockpile, or one of the host's structural scalars. */
function validateReferences(eco: CompiledEconomy, structural: readonly string[]): void {
  const declared = new Set([...eco.vars.map(x => x.name), ...structural]);
  const check = (name: string | undefined, where: string): void => {
    if (name !== undefined && !declared.has(name)) {
      throw new Error(`economy: ${where} references undeclared scalar "${name}"`);
    }
  };
  for (const p of eco.processes) {
    const where = `process "${p.id ?? p.output}"`;
    check(p.input, where);
    for (const i of p.inputs ?? []) check(i.scalar, where);
    check(p.output, where);
    check(p.capacityBy, where);
  }
  for (const s of eco.sums) {
    check(s.output, `sum "${s.id ?? s.output}"`);
    for (const t of s.terms) check(t.scalar, `sum "${s.id ?? s.output}"`);
  }
  for (const a of eco.allocates) {
    const where = `allocate "${a.id ?? a.source}"`;
    check(a.source, where);
    for (const sh of a.shares) {
      check(sh.output, where);
      check(sh.demand, where);
    }
  }
  for (const f of eco.flownets) {
    const where = `flow net "${f.id}"`;
    check(f.source, where);
    check(f.demand, where);
    check(f.satisfied, where);
    check(f.drift, where);
  }
  for (const d of eco.demandInputs) check(d.scalar, `demand input "${d.resource}"`);
  for (const vt of eco.vitals) {
    const where = `vitals "${vt.species ?? "site"}"`;
    check(vt.foodNeed, where);
    check(vt.foodGot, where);
    check(vt.capacity?.scalar, where);
  }
  for (const ti of eco.traitInputs) check(ti.scalar, `trait input "${ti.trait}"`);
}

export function compileEconomy(docs: EconomyDoc[], opts: CompileOpts = {}): CompiledEconomy {
  const construction = opts.construction ?? false;
  const doc = mergeDocs(docs);
  const v = (name: string, max: number, int = false): VarSpec =>
    ({ name, min: 0, max, initial: 0, ...(int ? { int: true } : {}) });

  validateDocs(docs, doc);

  // ---- vars ----
  const vars: VarSpec[] = [];
  for (const b of doc.buildings) vars.push(v(b.countScalar, 40, true));
  for (const c of doc.commodities) {
    if (c.transport) {
      vars.push(v(`${c.key}_out`, c.scalarMax));
      const demand = c.transport.demand ?? `${c.key}_need`;
      if (demand === `${c.key}_need`) vars.push(v(`${c.key}_need`, c.scalarMax));
      vars.push(v(`${c.key}_got`, c.scalarMax));
    }
    if (c.popScalar && c.popScalar !== `${c.key}_need`) vars.push(v(c.popScalar, c.scalarMax));
    for (const a of c.allocate ?? []) vars.push(v(a.share, c.scalarMax));
  }
  for (const b of doc.buildings) for (const x of b.vars ?? []) vars.push(v(x.name, x.max));
  for (const s of doc.stockpiles) {
    if (s.construction && !construction) continue;
    vars.push(v(s.key, s.max));
  }
  if (construction) for (const b of doc.buildings) vars.push(v(`${b.key}_cap`, 40));

  // ---- build rules (the tier/stagger laws) ----
  const rules: RuleSpec[] = [];
  if (construction) {
    const base = doc.buildings.filter(b => b.construction.tier === "base");
    const industry = doc.buildings.filter(b => b.construction.tier === "industry");
    // INDUSTRY AFTER SUBSISTENCE — the compiler writes the gates.
    const baseDone: Condition[] = base.map(b => ({
      cmp: ">=" as const, left: { scalar: b.countScalar }, right: { scalar: `${b.key}_cap` },
    }));
    const emit = (tier: BuildingDef[], gates: Condition[]): void => {
      let cum = 0;
      for (const b of tier) {
        const [funding, ...extra] = b.construction.costs;
        cum += funding.amount;
        rules.push({
          id: `build-${b.key}`,
          when: {
            all: [
              ...gates,
              { cmp: ">=" as const, left: { scalar: funding.stockpile }, right: { const: cum } },
              ...extra.map(x => ({ cmp: ">=" as const, left: { scalar: x.stockpile }, right: { const: x.amount } })),
              { cmp: "<" as const, left: { scalar: b.countScalar }, right: { scalar: `${b.key}_cap` } },
            ],
          },
          // {every}, never a timer — edge-triggered timers stall when the
          // stock overshoots twice the cost (the step-1 lesson).
          trigger: { every: true as const },
          effects: [
            { add: { scalar: b.countScalar, amount: 1 } },
            ...b.construction.costs.map(x => ({ add: { scalar: x.stockpile, amount: -x.amount } })),
          ],
        });
      }
    };
    emit(base, []);
    emit(industry, baseDone);
  }

  // ---- processes: per tier, production first then anchors ----
  const processes: ProcessSpec[] = [];
  const emitProcesses = (tier: "base" | "industry"): void => {
    const group = doc.buildings.filter(b => b.construction.tier === tier);
    for (const b of group) {
      for (const p of b.processes) {
        const { capacityRate, ...rest } = p;
        processes.push({
          ...rest,
          ...(capacityRate !== undefined ? { capacityBy: b.countScalar, capacityRate } : {}),
        });
      }
    }
    if (construction) {
      for (const b of group) {
        processes.push({ id: `${b.key}-cap`, input: b.cap.by, output: `${b.key}_cap`, efficiency: b.cap.rate });
      }
    }
  };
  emitProcesses("base");
  emitProcesses("industry");

  // ---- fan-in / fan-out ----
  const sums: SumSpec[] = doc.commodities
    .filter(c => c.needSum)
    .map(c => ({ id: `${c.key}-want`, output: `${c.key}_need`, terms: c.needSum!.map(scalar => ({ scalar })) }));
  const allocates: AllocateSpec[] = doc.commodities
    .filter(c => c.allocate)
    .map(c => ({ id: `${c.key}-split`, source: `${c.key}_got`, shares: c.allocate!.map(a => ({ output: a.share, demand: a.demand })) }));

  // ---- flow nets + road wear ----
  const flownets: FlowNetSpec[] = [];
  const roads: RoadSpec[] = [];
  for (const c of doc.commodities) {
    const t = c.transport;
    if (!t) continue;
    const id = t.id ?? c.key;
    const drift = t.drift && (!t.driftRequiresConstruction || construction) ? { drift: t.drift } : {};
    flownets.push({
      id, source: `${c.key}_out`, demand: t.demand ?? `${c.key}_need`,
      by: "road", satisfied: `${c.key}_got`, ...drift,
    });
    if (t.wearsRoad) roads.push({ attr: "road", use: id, rate: 0.002, decay: 0.001 });
  }

  // ---- coupling rows ----
  const demandInputs: Array<{ resource: string; scalar: string }> = [];
  const traitDemands: Array<{ resource: string; value: number }> = [];
  for (const c of doc.commodities) {
    if (c.perPersonDaily === undefined) continue;
    demandInputs.push({ resource: c.key, scalar: c.popScalar ?? `${c.key}_need` });
    traitDemands.push({ resource: c.key, value: c.perPersonDaily });
  }

  // ---- species: traits, policies, headcounts, wildlife ----
  const speciesTraits: CompiledEconomy["speciesTraits"] = [];
  const vitalsOut: VitalsSpec[] = [];
  const civicTraits: string[] = [];
  const traitInputs: CompiledEconomy["traitInputs"] = [];
  for (const s of doc.species) {
    if (s.role !== "commensal") {
      speciesTraits.push({
        key: s.key, name: s.name, color: s.color ?? "150,150,150,1", hereditary: true,
        demand: [
          // The commodity `perPersonDaily` rows ride the PRIMARY species
          // (the pre-species form, preserved verbatim).
          ...(s.key === "human" ? traitDemands : []),
          ...(s.needs ?? []),
        ],
      });
      if (s.vitals) {
        vitalsOut.push({
          species: s.key,
          birthRate: s.vitals.birth,
          deathRate: s.vitals.death,
          ...(s.vitals.starvation !== undefined ? { starvation: s.vitals.starvation } : {}),
          ...(s.vitals.diet ? { foodNeed: `${s.vitals.diet}_need`, foodGot: `${s.vitals.diet}_got` } : {}),
          ...(s.vitals.capacity ? { capacity: s.vitals.capacity } : {}),
        });
      }
      if (s.civic ?? s.role === "sapient") civicTraits.push(s.key);
      if (s.countScalar) {
        traitInputs.push({ trait: s.key, scalar: s.countScalar, mode: "count" });
        vars.push(v(s.countScalar, s.countMax ?? 100_000));
      }
      // A species' needs join the demand rows (dedup by resource — the
      // scalar carries the SUM across every trait wanting it, which is
      // exactly what siteResourceDemand computes).
      for (const n of s.needs ?? []) {
        if (!demandInputs.some(d => d.resource === n.resource)) {
          const c = doc.commodities.find(x => x.key === n.resource);
          demandInputs.push({ resource: n.resource, scalar: c?.popScalar ?? `${n.resource}_need` });
        }
      }
    } else {
      // Commensal wildlife: a settlement scalar chasing a DERIVED
      // carrying capacity (a `toward` — converges and stops; the only
      // dynamic var is its own, so idle-safety is untouched).
      vars.push(v(s.countScalar!, s.countMax ?? 100_000));
      vars.push(v(`${s.key}_cap`, s.countMax ?? 100_000));
      processes.push({
        id: `${s.key}-cap`, input: s.capacity!.by, output: `${s.key}_cap`, efficiency: s.capacity!.rate,
      });
      rules.push({
        id: `${s.key}-grow`,
        trigger: { every: true },
        effects: [{ toward: { scalar: s.countScalar!, target: { scalar: `${s.key}_cap` }, rate: s.growth! } }],
      });
    }
  }

  // ---- street goods (roles/box slots by registration order) ----
  const goods: GoodSpec[] = [];
  for (const c of doc.commodities) {
    if (!c.street) continue;
    const st = c.street;
    const gateSellers = doc.buildings.filter(b => (b.sells ?? []).includes(c.key));
    const sellers = [
      ...(st.market ? ["market"] : []),
      ...gateSellers.map(b => b.key),
    ];
    const shelved = [
      ...(st.market ? ["market"] : []),
      ...gateSellers.filter(b => b.shelved).map(b => b.key),
    ];
    goods.push({
      key: c.key,
      needScalar: `${c.key}_need`,
      gotScalar: `${c.key}_got`,
      sellers: sellers as GoodSpec["sellers"],
      shelved,
      producers: st.producers as GoodSpec["producers"],
      perCapitaDaily: 1,
      capDays: st.capDays,
      shopSec: st.shopSec,
      cartRations: st.cartRations,
      unit: st.unit,
      stockColor: st.stockColor,
      boxLabel: st.boxLabel,
      errandName: st.errandName,
      slot: goods.length,
    });
  }

  const eco: CompiledEconomy = {
    vars, rules, processes, sums, allocates, flownets, roads,
    demandInputs, traitDemands, goods, works: doc.buildings,
    stockpiles: doc.stockpiles.filter(s => !s.construction || construction),
    fills: doc.commodities
      .filter(c => c.transport)
      .map(c => ({ good: c.key, got: `${c.key}_got`, need: c.transport!.demand ?? `${c.key}_need` })),
    species: doc.species, speciesTraits, vitals: vitalsOut, civicTraits, traitInputs,
  };
  validateReferences(eco, opts.structuralScalars ?? STRUCTURAL_SCALARS);
  return eco;
}

/** Extend a substrate SystemSpec with the WILD FIELDS of the sapient
 *  species that declare one — each an int var plus one logistic
 *  `toward` rule (the `people` pattern: capacity = habitat × scale,
 *  rate 0.25 — the minimum that doesn't stall on int rounding). Fields
 *  the base spec already carries (people) are skipped; an unknown
 *  habitat fails at build, not as a silent dead field. */
export function wildSubstrate(base: SystemSpec, species: SpeciesDef[]): SystemSpec {
  const have = new Set((base.vars ?? []).map(v => v.name));
  const extra = species.filter(s => s.role === "sapient" && s.wild && !have.has(s.wild.field));
  if (!extra.length) return base;
  for (const s of extra) {
    if (!have.has(s.wild!.habitat)) {
      throw new Error(`economy: species "${s.key}" wild habitat "${s.wild!.habitat}" is not a substrate field`);
    }
  }
  return {
    ...base,
    vars: [
      ...(base.vars ?? []),
      ...extra.map(s => ({ name: s.wild!.field, min: 0, max: 31, initial: 0, init: "flat" as const, int: true })),
    ],
    rules: [
      ...base.rules,
      ...extra.map(s => ({
        id: `multiply-${s.wild!.field}`,
        trigger: { every: true as const },
        effects: [{
          toward: { scalar: s.wild!.field, target: { scalar: s.wild!.habitat, scale: s.wild!.scale ?? 2 }, rate: 0.25 },
        }],
      })),
    ],
  };
}

/** The founding crowd's startpop: the primary sapient takes the
 *  remainder after every declared founding share (herds walk in with
 *  their founders — a village founds with its flocks, which then grow
 *  into whatever pens get built). Sapient founders carry `civicApply`
 *  (typically the civ membership trait); animals only their species.
 *  Sizes are RELATIVE INTEGER WEIGHTS (PopuSim's PopInit parses `size`
 *  through intVal — a fractional weight floors to 0 and 0/0 poisons
 *  the whole site with NaN), so shares scale to parts-per-10000. */
export function citizenStartpop(
  eco: CompiledEconomy,
  civicApply: string[] = [],
): Array<{ size: number; apply: string[] }> {
  const SCALE = 10_000;
  const primary = eco.species.find(s => s.role === "sapient")!;
  const shares = eco.species.filter(s =>
    s.key !== primary.key && s.role !== "commensal" && (s.foundingShare ?? 0) > 0);
  const rest = shares.reduce((a, s) => a + Math.round(s.foundingShare! * SCALE), 0);
  return [
    { size: Math.max(1, SCALE - rest), apply: [primary.key, ...civicApply] },
    ...shares.map(s => ({
      size: Math.round(s.foundingShare! * SCALE),
      apply: s.role === "sapient" ? [s.key, ...civicApply] : [s.key],
    })),
  ];
}

/** The startpop of a HARVESTED crowd: sapient weights are the actual
 *  per-species grid persons the founding took (a mixed border camp is
 *  born mixed — who lived there decides who founds), and each domestic
 *  founding share adds on top, proportional to the sapient total. An
 *  empty mix falls back to the declared shares (citizenStartpop). */
export function harvestStartpop(
  eco: CompiledEconomy,
  civicApply: string[],
  mix: Record<string, number>,
): Array<{ size: number; apply: string[] }> {
  const out: Array<{ size: number; apply: string[] }> = [];
  let sapientTotal = 0;
  for (const s of eco.species) {
    if (s.role !== "sapient") continue;
    const n = Math.round(mix[s.key] ?? 0);
    if (n > 0) {
      out.push({ size: n, apply: [s.key, ...civicApply] });
      sapientTotal += n;
    }
  }
  if (sapientTotal <= 0) return citizenStartpop(eco, civicApply);
  for (const s of eco.species) {
    if (s.role !== "domestic" || !(s.foundingShare && s.foundingShare > 0)) continue;
    out.push({ size: Math.max(1, Math.round(s.foundingShare * sapientTotal)), apply: [s.key] });
  }
  return out;
}
