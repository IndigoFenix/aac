# World Content Model

What actually fills the layered world (unified-world-model.md): the concrete
substrate fields, resources, processing chains, buildings, and the conditions
under which cities exist at all. The engines are generic; this doc is the
first opinionated vocabulary for them — chosen so that every piece lands on a
primitive we already have (or names, precisely, the one it needs).

The design target is one worked arc: **terrain shapes fertility and ore into
complementary biomes; wild humans concentrate where the land is good; a dense
band founds a city; lowland farm cities and highland mine cities specialize
and trade; processing chains and buildings turn raw flows into goods.** Every
mechanic below serves that arc.

---

## 1. Substrate fields (the canonical set)

The Substrate is a cell-systems integer grid (idle-safe profile). The
existing examples already prove out three water models; the canonical
worldgen substrate picks **computed rivers** (`intRivers`' `flow` field) —
constant flow, zero per-step cost, re-routes on sculpt — because the layered
world wants "stabilise in motion", not simulated droplets.

| Field | Kind | Source | Dynamics |
|---|---|---|---|
| `height` | int 0..63 | worldgen (noise/sculpt) | static unless sculpted/eroded |
| `solid` | int 0..1 | worldgen | static; blocks flow & fertility |
| `river` | computed | `flow:{potential:height}` | derived; recomputes on sculpt only |
| `fertility` | int 0..15 | **emergent** | converges toward a target set by water × elevation; the master "how good is this land" field |
| `plant` | int 0..7 | emergent | tracks the NEIGHBOURHOOD's fertility (mean, radius 1) — a riparian halo, since fertile tiles are river tiles and render as water; the banks are where the green shows |
| `ore` | int 0..15 | **worldgen, finite** | inert at runtime; only DEPLETES (mining is a Settlement-side withdrawal) |
| `lure` | int 0..15 | emergent | Sugarscape attraction: `max(fertility, ore)` via disjoint-guard towards — each resource holds its own population, like sugar and spice mountains |
| `people` | int 0..31 | emergent | wild humans: logistic growth in place toward `lure`-set capacity — an animal population that grows farm hamlets AND proto-mining camps |

Design rules that make the set coherent:

- **Fertility is the single bridge between geology and life.** Water and
  elevation write fertility; fertility writes plants, people-capacity, and
  (via chartering, §2) farm output. Nothing else reads `river` directly —
  one field to balance, one field to explain.
- **The treeline is the specialization engine.** Fertility's target is 0
  above `TREELINE` (high, cold) and scales with river access below it. Ore
  is placed at worldgen with probability rising above the treeline
  (`ore ∝ max(0, height − TREELINE) × noise`). So ore and fertility
  anti-correlate *by construction*: the map itself proposes farm country and
  mine country, and trade between them is geography, not script.
  - **Provider note (2026-07-06):** height + ore now also have a SIMULATE
    provider — the plate-tectonics stepper (plate-tectonics.md), plugged in
    via `PrepareOpts.height`/`ore`. There the anti-correlation *emerges*
    (orogeny puts ore in mountains, drainage puts fertility in valleys)
    instead of being painted, and the substrate gained a sea line:
    height < 3 is submarine and barren (authored worlds floor land at 3,
    so they are unchanged).
- **Ore is a budget.** No runtime rule may raise it (worldgen writes it
  once); mining draws it down at the day boundary. Exhausted mountains are a
  real long-arc event: `ore_access` falls, the mine city's economy decays or
  re-specializes. This is the substrate's only depletable, which keeps the
  idle-safety story trivial (a monotone-falling bounded field always rests).
- **People are an animal population, nothing more.** A logistic `toward`
  (target = fertility × k) — an existing primitive, provably settling.
  Pre-civilization humanity needs no special system; it is wildlife that
  happens to found cities (§5). One lesson from implementation: naive
  `spread` wandering + logistic death is a perpetual leak→die→regrow
  boundary flux that never rests — migration over the grid needs a *fenced*
  transport (spread-with-block, or a crowding-potential flow), noted as
  future engine work. Growth-in-place already yields the right founding
  dynamics, since density is fertility-shaped either way.

All of this validates under the existing grid rules: fertility→plant and
fertility→people are DAG edges, no 3-loops, every field bounded.

## 2. The charter boundary (Substrate → Settlement)

A settlement is *chartered* against its neighborhood: at founding (and again
whenever the substrate under it changes — sculpting, erosion, depletion), the
city samples radius-R around its tile into static entity scalars:

- `farmland` = Σ fertility in R      (feeds grain production)
- `ore_access` = Σ ore in R          (feeds mining)
- `timberland` = Σ plant in R        (feeds logging, later)
- `water_access` = max river in R    (ports/mills, later)

This is the §4 Substrate→Settlement direction that was "already the plan" —
now with named fields. The reverse write is **depletion**: each day a mining
city subtracts its actual mined amount from the `ore` tiles under it
(largest-first, deterministic), then re-charters `ore_access`. Because
chartering is a pure sample, it costs nothing while the substrate rests —
which is almost always.

## 3. Resources and processing

Starter taxonomy — three raws, three processed, chosen to exercise every
mechanic once:

- **Raw:** `grain` (from farmland), `ore` (from ore_access), `timber` (from
  timberland; later)
- **Processed:** `food` (← grain), `metal` (← ore), `tools` (← metal; the
  two-stage proof)
- **Demand:** every settlement demands `food` ∝ population and `tools` ∝
  population (a consumption good).

**The hazard to respect:** the obvious "tools make mines more productive"
feedback closes a tools→production→ore→metal→tools loop across 4+ attributes
— exactly the 3-loop the validator rejects, and rightly (it is the runaway/
collapse oscillator of every naive econ sim). v1 keeps tools as a consumption
good. If productivity feedback is ever wanted, it must ride the bounded-edge
pattern roads use (grow-with-use + decay, clamped), or live in an idle-unsafe
profile. This is a feature of the framework, not a limitation: the validator
just told us which economies are predictable.

### 3a. Two small engine pieces make chains expressible

Everything else in this section is composition, but two things the cell
algebra genuinely cannot say today:

1. **Flow nets must report what arrived.** `FlowNetSpec` gains
   `satisfied: <scalar>`: each entity's demand actually met, written as a
   derived per-step value (proportional fill — `demand_i × min(1,
   supply/demand)` per component). Without it, a delivered flow evaporates
   into implied consumption and nothing downstream can chain on it.
   (Drift keeps its existing uniform-imbalance semantics; `satisfied` is the
   demand-side view of the same solve.)

2. **A production function needs a min-combiner.** Output is limited by BOTH
   input supply AND installed capacity — `min(input × efficiency, buildings
   × rate)` — and the rule algebra deliberately has no two-scalar
   combinators. Rather than contort rules, the Settlement layer gains one
   sanctioned primitive, `ProcessSpec`:

   ```
   { id, input: <scalar>,          // farmland, or a flow net's satisfied
     output: <scalar>,             // grain_out, metal_out, ...
     efficiency: number,           // output per unit input
     capacityBy?: <scalar>,        // building count (farms, smelters)
     capacityRate?: number }       // output per building
   ```

   `output := min(input × efficiency, capacityBy × capacityRate)`, written
   each step as a **derived value** — a Leontief production function. Like a
   sensor, it has no dynamics of its own (a pure function of bounded
   inputs), so it cannot break termination; its read→write edges join the
   validator's coupling graph like everything else.

### 3b. Chains are DAGs of (process → flow net → process)

```
farmland ─process→ grain_out ─flow net→ satisfied_grain ─process→ food_out ─flow net→ population demand
ore_access ─process→ ore_out ─flow net→ satisfied_ore  ─process→ metal_out ─flow net→ smithies / demand
```

Each stage adds one step of settle-time (a chain of depth d reaches steady
state in ~d days) and the whole pipeline is stationary once inputs are: the
flow nets stop recomputing, the processes write the same values, the world
rests — with ore moving down the mountain and food moving up it forever.
That picture — **two biomes, two cities, two counterflowing caravan lines,
at rest** — is the acceptance test for this whole document.

### 3c. Traits shape demand (added 2026-07-05)

Until this section landed, demand was population-only — a town of 10,000
devout and a town of 10,000 atheists wanted identical goods. The layers
carried people, roads and prevalences across the boundary, but the economy
never asked WHO was buying. Now it does, through two channels:

- **Native (preferred): `Trait.demand`** — a trait declares what its
  carriers want, right beside its transmits:
  `{ key: 'devout', transmit: [...], demand: [{resource: 'incense',
  value: 0.001}] }`. PopuSim aggregates the site's demand vector
  (`World.siteResourceDemand`: Σ rates × carriers, all traits summing
  naturally), and the dual coupling's `demandInputs` writes it into a
  settlement scalar pointed at a flow net's `demand`. Deliberately
  DISTINCT from PopuSim's `consume` impacts: `consume` is the metabolic
  machinery (drains composition-side stockpiles, starvation effects, daily
  churn that would block rest); `demand` is a pure economy signal — our
  goods live in the settlement layer's flow nets.
- **General: `traitInputs` count mode** — the raw carrier count as an
  entity scalar, for custom ProcessSpec chains when a simple rate isn't
  enough (nonlinear appetites, capacity-gated wants).

Effect: what a town wants follows who its people are. As an idea spreads,
the trade map redraws itself — the faith test watches incense caravans
thicken day by day as Farhold converts, and a faithless twin never opens
the market at all. Combined with §5's founding score weights, this closes
the loop the layered model promised: traits → demand → flows → roads →
route strength → where the NEXT idea spreads.

Still open, and worth doing next: the REVERSE channel — scarcity acting on
traits (an unfed demand raising dissent, a metal glut spreading a craft
trait). The sanctioned shape is `satisfied`/need ratios flowing back as
transmit modifiers or ambient sheds at the day boundary; PopuSim's
PlayerAction machinery (external per-site inputs by design) is the likely
carrier.

**Street-level projection (same day, `grand-dream/src/food.ts`):** the
consume behavior also renders at INDIVIDUAL scale as a stateless add-on —
pantry boxes, plaza markets, per-house shopping cycles — all closed-form
functions of `food_need`/`food_got` and the clock (one ration ≡ one
person-day of the trait-declared rate). Nothing feeds back; it's the same
numbers made walkable. See unified-world-model.md step 7's landmark.

### 3d. When goods widen: fan-in and fan-out (analysis 2026-07-08;
### ✅ SHIPPED same day — see civilization-emergence.md step 5b landmark)

The §3 vocabulary exercised LINEAR chains — every `satisfied` fed one
process, every demand scalar had one writer. A real reagent economy
(many materials, shared inputs, higher-level goods) needs two more
primitives, both derived-pure (no loop-dimension cost, same family as
`satisfied`) — now shipped as `SumSpec` and `AllocateSpec`, alongside
`ProcessSpec.inputs` (the multi-reagent Leontief: min across ALL
reagents — the scarcest binds). Evaluation order: processes → sums →
flow nets → allocates. First user: `triBase({goods2})` — planks from
timberland, tools from metal + planks, smiths-first metal allocation,
a plank stockpile part-paying smithies:

- **Fan-in — an additive combinator.** Aggregate demand with several
  sinks (households burn timber AND the shipyard consumes it) needs a
  SUM; today multiple processes writing one output is a "later wins"
  warning. Precedent: drift already accumulates additively.
- **Fan-out — a conserving per-settlement allocator.** Processes are
  pure reads, not draws: two processes reading the same `ore_got`
  double-count the reagent. The allocator splits an input across
  competing consumers by a DETERMINISTIC data rule (fixed priority
  order) — never a heuristic, because the planned-history provider
  (civilization-emergence.md §3d) must reproduce it bit-for-bit.
  Precedent: `allocateDistrictFill` (city-districts.ts), the same shape
  one level down.

Design rules that keep a widened economy solvable at plan time (the
full analysis, including the industry-location contingency and the
piecewise-stationary depletion story, is civilization-emergence.md §3d):

- **Anchor every intermediate**: each process's `capacityBy` building
  caps from a charter field — unanchored industry makes the economic
  endpoint path-dependent.
- **Inelastic demand stays law** at this layer (prices ⇒ general
  equilibrium ⇒ no plan-time solve; city-development.md already
  committed to "emptier boxes, never prices").
- **No labor/productivity feedback** — the §3 hazard, still standing.
- **One commodity vocabulary**, defined here and PROJECTED down to the
  street level (food.ts-style), never grown independently below.

### 3e. Economy as CONTENT (✅ SHIPPED 2026-07-08 — the authoring format;
### see civilization-emergence.md step 6d landmark)

Everything §3–§4 describes is now DATA: an `EconomyDoc`
(`shared/engine/modules/economy` since the 2026-07-08 engine carve —
grand-dream's src/economy.ts is a re-export shim) declares commodities,
buildings and
stockpiles, and `compileEconomy` expands it into the settlement spec
fragments (vars/processes/sums/allocates/flow nets/build rules), the
coupling rows (trait demands + demandInputs), the street `GoodSpec`s
(errand roles and house-box corners assign by REGISTRATION ORDER), and
the presentation registry (footprints, glyphs, titles, info-line
templates, placement bearings, district classes). Developers add goods
and chains by writing documents in this shape — **as actual external
JSON files**: `parseEconomyDoc` (economy-json.ts) is the boot gate
(wrong types name the exact path; unknown fields are REJECTED, so a
typo'd "prodcuers" fails loudly instead of silently defaulting), the
compiler's author-error pass catches semantics (dangling stockpiles /
commodities / producers, shelved-without-sells, and a referential
check — every scalar a process/sum/allocate/flow net names must
resolve, so a typo'd "timberlnd" fails at compile naming the def,
never at runtime as a silent 0), and the idle-safety validator still
gates the compiled spec at world boot. The clothing chain lives in
`src/content/clothing.economy.json` (economy-clothing.ts is only the
loader shim); the LAB takes a "Custom content" file on the emergent
tri scenarios (`TriBaseOpts.extraContent` → dry-run compile → reboot
with the mod live — a broken file reports and changes nothing). The
standard chains (economy-core.ts) stay TS literals by choice: they
carry the named cost constants the calibration notes reference.

**Parameters** (what an author writes):

- **Commodity**: `key`, `scalarMax` (var clamps), `perPersonDaily`
  (household demand — omit for intermediates), `transport` (flow id /
  demand override / stockpile drift / road wear), `needSum` (fan-in
  terms), `allocate` (fan-out shares, PRIORITY ORDER), `street`
  (capDays/shopSec/cartRations, producers, market channel, stock color,
  box label, errand name).
- **Building**: `key`, `countScalar`, `cap` {by, rate} (REQUIRED
  anchor), `processes` (near-raw ProcessSpecs; `capacityRate` sugar ⇒
  capacityBy = own count — the escape hatch for exotic chains, gated by
  the validator like everything else), `vars` (draws + local
  intermediates), `construction` {tier, costs[]}, `sells`/`shelved`,
  `leansToward` (substrate field | null), `mapCap`, `district`,
  `style`/`vignette`/`glyph`/`title`/`info` templates.
- **Stockpile**: `key`, `max`, `construction` flag (the funding stock).

**Compiler laws** (enforced, not authored — each one is a calibration
trap we hit by hand): INDUSTRY AFTER SUBSISTENCE (tier "industry" gates
on every base building at cap — authors declare a tier, the compiler
writes the gates); STAGGERED FUNDING (granary thresholds accumulate over
declared costs within a tier; extra stockpile costs guard at their
amount); ANCHORED CAPACITY (compile error without one — §3d Gap B);
ONE VOCABULARY (a good's street projection exists exactly where the
settlement keeps its ledger — `streetGoodsFor` filters by var presence).
The idle-safety validator remains the certification gate for whatever
the compiler emits.

**Proof**: the equivalence test (economy-equivalence.test.ts) pins the
compiled CORE docs to the frozen hand-calibrated fragments
byte-for-byte, and CLOTHING (economy-clothing.ts — wool grazed on the
pasture charter, cloth woven and sold over the weaver's counter, member
2 running the cloth errands to the linen chest) shipped as pure content
with zero engine/street/renderer edits, calibrating FIRST TRY because
the laws did the calibration structurally.

Remaining hard-coded seams, named: charter attributes (farmland /
ore_access / timberland) are sampled in tri.ts, not declared as
content `resources`; the hall and market are STRUCTURAL town-layer
builtins; cultivated fields anchor to the literal work type "farm".

### 3f. Species as content (✅ SHIPPED 2026-07-08 — see
### civilization-emergence.md step 6e landmark)

"Human" was always just a PopuSim trait — now the trait, its diet, its
Malthusian policy, its civic standing and its founding share all
compile from a `species` section of the content documents, and other
species ride the same seam. Three ROLES, each living at the layer its
nature demands:

- **sapient** — full citizens: a hereditary trait with a demand vector,
  scoped vitals, CIVIC standing (counts toward the population scalar —
  tiers, strength, houses), a share of founding crowds, and the civ
  membership trait at founding. Humans are the implicit primary
  (`HUMAN_SPECIES`, overridable by key).
- **domestic** — owned populations: PopuSim pops with a species trait
  but NEVER civic (a herd is wealth, not a town). They walk in with
  founding crowds (`foundingShare` → startpop weights — INTEGER
  weights; PopInit floors fractions), migrate conservingly with
  colonists like everyone else, and grow logistic under a CAPACITY
  anchor (vitals `capacity`: births × max(0, 1 − pop/(scalar×perUnit))
  — the herd equilibrates at cap × (1 − death/birth)). ANCHOR THE
  SURVIVAL CAP TO SOMETHING FOUNDING-DAY (sheep graze the FARMS,
  perUnit 60) — anchoring it to a late industry building starves the
  founding flock before its pens exist (lab-observed; the sheepfold is
  SHEARING capacity via the graze process, not survival). Headcounts
  land in a settlement scalar (traitInputs count mode) so production
  anchors to REAL animals — wool is shorn from `sheep_count`, not
  conjured from the grass.
- **commensal** — urban wildlife: never a PopuSim identity, just a
  settlement scalar chasing a derived carrying capacity (`toward` a
  `{key}_cap` process off the civic population — converges, 1-var
  loop, idle-safe). Rats scale with the city; the street renders them
  as night scurries; nobody owns them.

**DIFFERENT NEEDS are the point**: every species' vitals name ITS diet
(`{diet}_need`/`{diet}_got`), each policy is trait-scoped through
PopuSim's `applyVitals(site, births, deaths, trait?)`, and species'
`needs` join the demand rows (siteResourceDemand already sums demand
across all traits) — so a fodder famine starves the sheep and only the
sheep while the bread holds (species.test.ts proves exactly this).

**Civic accounting** (the audit that made it safe): the population
scalar carries CIVIC souls only (`coupling.civicTraits`; the write-back
filters via popOnSiteWithTrait), so herds never tier a village, never
add conquest strength, never demand houses. The "Layers agree" check
compares against `dual.civicPop()`. Total-souls conservation is
unchanged — every sheep birth and famine death is in the vital ledger.

**Wild fields (✅ step 6f, same day)**: every sapient species may
declare `wild: { field, habitat, scale }` — `wildSubstrate` grows the
substrate spec one int var + one logistic `toward` rule per species
(the `people` pattern: capacity = habitat × scale), so dwarven crowds
pool on the ORE where human crowds pool on the lure. Foundings scout
EVERY species' field (`findFoundingSites` per field, best score
founds; ties break in species order) and the harvest takes EVERYONE in
the box — `harvestStartpop` founds with the actual demography (a ridge
camp is born dwarf-majority with human prospectors mixed in; herds
ride on top), and `autoFound.cityFactory` receives the mix. Humans
ride the implicit `people`/`lure` field the base substrate carries.

CALIBRATION TENSION, named (found by probe at dwarven scale 3): a
farmland-0 wild metropolis pins its whole road component's food fill
below 1 FOREVER, which kills construction component-wide — the
granary drift is the component surplus mean, and a structural deficit
means no settlement in the component ever banks a build. The colonize
path dodges this by SEQUENCE (valleys build out alone, camps join
funded and small); wild ridge foundings break that sequence when
their crowds outrank the valleys. Dwarves ship at scale 2 (visible,
harvestable, foundable — below the valley founding floor).

**The HARVEST CAP (✅ shipped)** is the first move on that frontier:
`founding.maxHarvest` (FoundingOpts) bounds a founding's take — the
scanner still gates and ranks by full crowd density, but the harvest
gives up at most the cap, apportioned across species LARGEST-REMAINDER
(the mix keeps its proportions; deterministic ties by species order),
and the residue stays WILD in the box — it regrows and can gate a
later founding nearby. The planner mirrors it (`min(density, cap)`),
keeping the §3c agreement exact. The tri worlds cap at 600 grid
persons (15k souls — squarely the village band): single-species boxes
on this substrate top out under it (~470), so every calibrated human
arc is byte-identical, and only the stacked mixed boxes get trimmed —
"found small" now binds the crowd, not just the stock. The cap bounds
the SIZE of a farmless sink, not its existence — import-aware founding
gates or mountain subsistence chains remain the rest of the frontier.

Known limits, named: the planner's float Malthus models the CIVIC
(first) policy only — non-civic species plan through their settlement-
scalar effects, and the planner founds on the primary wild field only;
a planned per-species composition is future §3c work. Worlds with
active vitals still never take the O(1) resting jump; more species
deepen that existing cost class, not a new one.

## 4. Buildings

A building type is an **integer entity var** (`farms`, `mines`, `smelters`,
`smithies`) that does exactly two things:

- **Caps a process** via `capacityBy` (§3a) — buildings ARE capacity.
- **Costs accumulated surplus to build**: a timer rule in the ordinary
  algebra — `when stockpile ≥ COST (and buildings < max), timer T →
  buildings +1, stockpile −COST`. Budget-spend + bounded integer growth:
  idle-safe as-is, no new machinery.

Two facts learned in implementation, now load-bearing:

- **The spend is mandatory, not flavor.** Timers are edge-triggered (a
  timer is a prediction, armed on the guard's rising edge) — a free build
  rule whose guard stays true fires exactly once. Spending the stockpile
  drops the guard below threshold, which is what re-arms the next build.
  Cost IS the repeat mechanism.
- **Derived vars don't count toward loop dimension.** Construction closes
  buildings → output → stockpile → buildings, which touches three names —
  but process outputs (and `satisfied`) are pure functions of state, so the
  validator now counts only STATE attributes in a feedback loop
  (Poincaré–Bendixson bounds state dimensions; combinational relays are
  free). Construction-from-surplus is a sanctioned 2-state loop (it warns,
  like road↔goods). Flow-net `drift` targets integrate, so they remain
  state.

Construction naturally chases demand: surplus accumulates only where
production runs at capacity, which is where the next building pays off.
Maintenance (buildings decay without upkeep) is a later, equally ordinary
rule. "Define objects by what they do": a building is a capacity scalar and
a construction rule — there is no building object.

## 4b. Vital dynamics (births and deaths — added 2026-07-05)

Populations grow and decline through a **direct** model, deliberately
replacing legacy PopuSim's "nonexistent pool + living trait" scheme. That
scheme had one real elegance — birth and death were trait operations, so
every mechanism could target them — but its ghost units contaminated
denominators and the clustering/factoring math had to special-case the
absorbed pool forever (ClusterPartition still carries that rule). The
direct model splits mechanism from policy:

- **Mechanism (PopuSim, `World.applyVitals(site, births, deaths)`)** —
  exact RNG-free counts. Births apportion over the site's populations ∝
  size and land in the **hereditary projection** of the parents' syndrome:
  traits flagged `hereditary: true` (culture, membership, caste) pass to
  the child; acquired states (infected, convinced) do not. A birth cohort
  therefore dilutes any idea that isn't re-transmitted — generational
  decay for free, which is the trait dynamics behaving like ideas instead
  of genes. Deaths remove uniformly by syndrome (the C2b condition), from
  a pre-birth snapshot. Ledger: Σ pops + histfigs = start + births −
  deaths, and the tests hold the identity through every day.
- **Policy (dual layer, `coupling.vitals`)** — Malthus through the
  economy: `fill = foodGot/foodNeed`; births = pop × birthRate × fill;
  deaths = pop × (deathRate + starvation × (1 − fill)); whole people via
  deterministic per-site carries. Because food demand itself comes from a
  hereditary trait's §3c `demand` declaration, the loop closes with no
  extra wiring: population ↑ → food demand ↑ → fill ↓ → births ↓ /
  starvation ↑ → **equilibrium at the carrying capacity the FOOD SUPPLY
  implies** (fill* = (death+starv)/(birth+starv), K = supply/(rate·fill*)).
  Double the harvest and the population follows it up; blight it and the
  town starves — to extinction, at which point it genuinely rests.

Idle-safety note: active vitals are perpetual pending input (the carries
tick daily), so a vital world never takes the O(1) resting jump — only an
emptied or rate-zero world does. Era-folding vitals into the fast-forward
(their dynamics are smooth enough to integrate analytically at the day
scale) is the noted future upgrade.

## 5. City founding

Pre-civilization humans (§1's `people` field) found cities the way the user
framed it: **an animal population that crosses a density threshold.**

- **Condition:** a tile where Σ `people` in radius r ≥ `FOUND_THRESHOLD`,
  at least `MIN_SPACING` from every existing settlement. Scanned at the day
  boundary (or on substrate rest — the field settles, so candidates are
  stable between disturbances). Deterministic: scan in tile order, take
  qualifying tiles greedily respecting spacing.
- **The founding transaction** (one day-boundary structural event, mirroring
  §6's "founding a settlement = entity + Site in the same transaction"):
  1. Harvest the crowd: subtract the neighborhood's `people` into the new
     city's starting population — **conservation now spans layers** (grid
     people + site pops + histfigs = constant).
  2. Create the Settlement entity at that position; edges to the k nearest
     settlements in range.
  3. Create the PopuSim Site with the harvested pop (startpop: a fresh
     `member_of:<tribe>` trait — §7's downscaling arrives free: every new
     city is born a tribe, and absorption/breakaway machinery already
     exists).
  4. Charter it (§2).
- ✅ **Engine gaps CLOSED (gate 5, 2026-07-05):** `addEntity`/`addEdge` in
  cell-systems `entities.ts` (arrays grow, timers keep their index keys,
  derived nets reset for a re-solve) and PopuSim `World.addSite`/`addRoute`
  (mirrors start()'s per-site sequence; histories begin at the founding
  day). `DualWorld.foundSettlement(def)` runs the whole transaction: Site +
  routes, entity + edges (index-aligned), CONSERVING colonists via driven
  migration, immediate write-back so the layers agree from birth. Tested at
  every level (entity check #18, popusim `founding.test.ts`, dual gate-5
  suite: a colony founded mid-run gets fed by the re-solved trade net and
  the grown world rests and jumps again).
- **Sugarscape borrow (same date):** people's carrying capacity follows
  `lure = max(fertility, ore)`, so ore country grows proto-mining camps and
  mine towns can found themselves; `findFoundingSites` gained resource-
  weighted ranking (`score: [{field, weight}]`) — crowds still gate,
  resources rank. That weight vector is the SUPPLY/DEMAND socket: when the
  settlement layer starts publishing scarcity at the day boundary (metal
  dear → ore weight up), founding starts answering the market. Sugarscape's
  *motion* (agents walking gradients) stays out of the idle-safe profile —
  three attempts (spread, and two flowDown variants) all reduce to
  source+transport+sink flux that never rests; concentration-by-capacity
  gives the same landscape without the churn, and punctuated clock-driven
  migration pulses are the foldable path if motion is ever wanted.

The remaining unbuilt piece of §5 is the SUBSTRATE-side harvest (subtract
the grid crowd into the founded site's population — the cross-layer
conservation grid+pops+histfigs = const), which needs the tri-layer harness
of gate 6.

### 1b. Rendering + the original-engine question (added 2026-07-05)

The lab now renders the substrate with the ORIGINAL sandbox's renderer,
ported: the `materialColor` palette (water colored by DEPTH, plants as a
sparse→dense ramp, bare ground sand→damp-brown) under **prominence
shading** — per-tile brightness from how far it stands above the mean of
its surroundings plus a gentle absolute-height tint — which is what makes
terrain read as 3D. Flowing water carries the original's travelling
crest-glints. Fertility was also re-tuned into a TIGHT band (river
accumulation > 15/45, was > 8/40): grass hugs genuine watercourses
instead of carpeting drainages. An engine win came out of the profiling:
grid sensors are now LAZY (computed on first read, memoized per step), so
clock-gated rules stop paying kernel costs on non-boundary steps.

**The behavioral port is unfinished, deliberately.** `oasisSubstrate`
(exported, marked experimental, not wired into the lab) re-derives the
original's hydrology — rain → hidden water table → underground advection
→ springs at the massif foot → rivers → a fertility halo — on integer
primitives, and three calibration gaps surfaced empirically: (1) integer
`flowDown` LEVELS the table like a lake where the original's one-way
fractional advection kept draining it to the foot; (2) whole-unit spring
emission can't imitate a 0.15/step trickle without flooding or drying;
(3) the rain/bleed ratio (0.3 vs 0.005 per step) is regime-critical and
quantizes badly. The recommended path to full fidelity is NOT more
re-derivation: put the ORIGINAL scalar engine (sandbox-game `engine.ts` —
already deterministic, self-scheduling, and settling-by-tolerance) behind
a substrate adapter exposing the CellGrid surface tri worlds read
(fields/step/inject), and let profiles choose engines the way they
already choose scalars vs integers. That's a bounded, separate task.

### 5b. Genesis worlds (the sandbox merge — added 2026-07-05)

The founding loop closed all the way back to the player's hand. A GENESIS
world boots EMPTY — raw terrain, no rivers, no fertility, no people, no
cities (PopuSim now legally starts site-less via `allow_empty`) — and the
whole causal chain runs live: drainage carves rivers → rivers write
fertility → fertility draws wild crowds → every `autoFound.every` days the
densest crowd FOUNDS a city where it stands (harvest → charter → roads to
the nearest neighbor, all through the ordinary transaction). Mountain
foundings (charter more ore than farmland) seed separatism, so even the
breakaway arc emerges rather than being scripted. In the lab, ⛰️ Raise /
⛏️ Dig brushes paint height while the substrate steps at frame rate:
sculpt a sloped valley and the water finds it, the cut greens, crowds
pool, and sooner or later a city rises in the valley you made — verified
by test (a canyon carved through the barren plateau gains rivers and
fertility). Design note that keeps biting: a FLAT excavation is a puddle;
drainage needs a gradient to accumulate along.

## 6. The worked example (acceptance scenario)

One map, ~48×32: a mountain ridge (ore above the treeline) over a river
valley (fertility along the drainage). Wild people pool in the valley; two
founding events fire — `Riverton` (valley: farmland 900, ore 0) and
`Kragholm` (ridge foot: farmland 80, ore 600). Riverton builds farms and
mills; Kragholm builds mines and smelters. Flow nets: grain/food downhill
demand, ore/metal down the mountain. Roads wear in along the pass; the
caravan dashes run both directions; breakaway machinery watches Kragholm's
separatists; the whole thing rests, in motion.

Ship gates:

1. ✅ **Substrate** — `worldgenSubstrate` in cell-systems `examples.ts`
   (fertility/plant/ore/people over the intRivers water model) +
   `worldgen.ts` (`seedOreAboveTreeline`). Grid checks #22–23: settles into
   anti-correlated biomes, catch-up == stepping.
2. ✅ **satisfied + ProcessSpec** — engine + validator (incl. the
   derived-collapse rule, §4); entity checks #16/#18.
3. ✅ **Specialization demo** — the two-biome economy check: chains settle,
   a surplus net fills demand exactly, a shortage net fills proportionally,
   food and metal counterflow on the same edge, construction spends the
   granary, world rests (entity checks #16–17).
4. ✅ **Founding detection** — `worldgen.findFoundingSites` (deterministic,
   spaced, occupancy-aware); grid check #24.
5. ✅ **Founding transaction** — `addEntity`/`addEdge` +
   `World.addSite`/`addRoute` + `DualWorld.foundSettlement` (colony
   founding, conserving, deterministic, re-rests). Plus the Sugarscape
   lure and resource-weighted founding scores (§5).
6. ✅ **The tri-layer acceptance world** — `grand-dream/src/tri.ts`:
   `prepareSubstrate` (author terrain → seed ore → settle → detect) +
   `foundTri` (HARVEST founding: the crowd leaves the grid and becomes the
   city × `peopleScale`; conservation holds at the transaction, then the
   wild people regrow toward lure — wildlife is renewable, later crowds
   found later cities), live chartering, and per-day mining depletion
   (richest tile first; `ore_access` recharters as the mountain shrinks).
   The §6 arc passes end-to-end: asymmetric charters, food/metal
   counterflow over the pass, Malthusian growth on the ledger, Kragholm's
   secession — with a new `creed`-vector absorption transmit so the young
   civ converts its remaining sympathizers and the majority genuinely
   flips — armed borders (border hostility now accrues DAILY on
   different-majority edges, robust to late flips), and a visibly
   shrinking mountain. Bit-deterministic across full reruns. The
   many-settlements stress world runs 14 cities × 100 living days at
   ~1.5 ms/day, deterministic, ledger exact; the no-vitals variant rests
   at scale and O(1)-jumps with goods still flowing. IN THE LAB: the
   "TRI — the layered world" scenario paints the live substrate behind
   the graph (height/greenery/rivers/ore/stone + a warm tint where wild
   people pool), founds Riverton and Kragholm at their real tile
   positions, and runs the full arc with caravans, civ rings, and
   wild/ore readouts in the day line. World definitions live in
   `tri-worlds.ts`, shared by the lab and the vitest suites — what the
   tests prove is what the lab shows.
