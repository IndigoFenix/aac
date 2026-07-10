# Civilization Emergence: the Settlement Lifecycle and Planned History

Brainstorming doc for how cities COME TO EXIST and how civilizations GROW —
villages condensing out of the wild population, merging into farming cities,
extending into the mountains, and conquering one another into multi-city
empires — without a founding script. Companion to unified-world-model.md
(the four engines and the day-boundary contract), world-content.md (§5's
founding transaction, which this doc extends into a full lifecycle),
city-development.md (the same growth story one level down), and
timescales.md (providers, transients, and the refine/rest dial — the
machinery this doc leans on hardest).

Status: brainstorm. §2 (lifecycle events) is converging — it names concrete
transactions on shipped primitives. §3–4 (planned history) is the genuinely
new idea. §7's open questions were answered 2026-07-07 and the decisions
are folded into the body (the answers stand inline there, ✅-marked).

The originating observation: the original design for emergent cities
predates the "plan ahead of time, then fake procedural growth" method that
rivers now use (timescales.md §5b + the streets.ts construction-order
pattern). That method may make emergent-looking civilization affordable
where it wasn't before.

---

## 0. Where this comes from (honest state of the shipped thing)

More of the vision already exists than the word "scripted" suggests:

- **Wild humans as an animal population: SHIPPED.** The `people` substrate
  field grows logistically toward `lure = max(fertility, ore)`
  (world-content.md §1); ore country grows proto-mining camps as well as
  farm hamlets (the Sugarscape borrow, §5 there).
- **Density-threshold founding: SHIPPED.** `findFoundingSites` scans the
  grid deterministically (threshold, radius, spacing, occupancy-aware,
  resource-weighted ranking); `DualWorld.foundSettlement` runs the
  conserving transaction (harvest the crowd → entity + Site + routes +
  charter, layers agreeing from birth). GENESIS and TECTONIC worlds boot
  city-less and found every city this way; only the §6 acceptance world
  places cities by hand, deliberately (it is the regression fixture).

What is still script-shaped, and what this doc is for:

- **`autoFound` is a scheduler, not a dynamic.** "Every N days, the densest
  crowd founds a complete city, up to maxCities, named from a table." The
  trigger is a clock; the cap is authored; a founding instantly produces a
  full city with charter-sized buildings. There are no villages.
- **Settlements are immortal.** `addEntity` exists; no removal, no merge.
  A settlement founded is a settlement forever.
- **All foundings come from wild crowds.** Cities never found daughters —
  no colonization, so "the farm cities extend into the mountains" cannot
  happen; only mountain crowds can put a camp there.
- **Fission without fusion.** Breakaway (membership-trait secession,
  `measureFaction` + `applyTraitFlip`) is shipped and tested; conquest is
  not. Hostility is an edge attribute that wears roads down. There is no
  strength, no war resolution, no empire formation.

So the missing thing is not "emergence" in general — it is the **settlement
lifecycle**: birth at the right size, growth through tiers, merging,
colonizing, conquering, dying. §2 designs those events. §3 then asks how a
whole history of them can be produced cheaply.

---

## 1. The target arc, restated

> Wild humans cluster where the land is good. Dense clusters condense into
> VILLAGES. Villages in one another's orbit MERGE into farming cities.
> Cities whose demand outruns their charter COLONIZE — farm country
> extends camps into the mountains for ore. Cities project strength;
> hostile neighbors with a strength gap get CONQUERED, and the winner's
> membership trait spans settlements: an EMPIRE. Empires fray by the
> breakaway machinery that already exists.

Every noun in that paragraph should be a threshold or an event over shipped
state, not a class ("regimes, not classes" — unified-world-model.md §2). A
village is a settlement below a population threshold. An empire is a
membership trait that spans settlements — which is already the shipped
definition of a civilization. The arc is a sequence of day-boundary
structural events, and day-boundary structural events are exactly what the
founding transaction proved the engines can do.

---

## 2. The settlement lifecycle (sim-side prerequisites)

These four events must exist in the dual world REGARDLESS of how history is
generated (§3): both providers must write the same seam, and the seam is
"the set of structural events a settlement graph can undergo."

### 2a. Tiers are thresholds

`village` / `town` / `city` are render-and-dynamics regimes over the
`population` scalar, nothing more (a city is a settlement whose population
crossed a threshold — §2 of the world model, verbatim). Two real changes:

- **Found small.** `autoFound`'s instant full city becomes: harvest founds
  a VILLAGE (population = the harvested crowd, buildings = a hall and
  little else); the charter-sized building stock is *grown into* through
  the ordinary construction rules, not granted. The building-construction
  timers already chase surplus; founding just stops pre-paying them.
- **Tier gates dynamics.** Colonization (§2c) and conquest (§2d) arm only
  above tier thresholds — villages don't found colonies or wage wars. This
  is data, not code: thresholds in the world spec.

### 2b. Merge (absorption of a settlement by a stronger neighbor)

The user-visible event "villages merge into larger farming cities" is,
mechanically, **absorption**: the smaller settlement's people move to the
larger one and the smaller one ceases. Decided (§7): merge and conquest
are ONE `absorb(loser, winner, mode)` transaction with two triggers and
two modes — PHYSICAL (population moves, loser tombstoned — this section)
and POLITICAL (membership flips, settlement persists — §2d). The economic
trigger below takes the physical mode; the military trigger takes the
political mode for towns and above, the physical mode for villages (a
conquered hamlet is emptied, not annexed). As a day-boundary transaction:

1. **Condition** (evaluated like breakaway conditions, at day end): two
   route-connected settlements within `MERGE_RANGE`, same civ, no
   hostility, population ratio past `MERGE_RATIO`, and the smaller one's
   growth stalled (fill ≤ 1 — it merges because it cannot feed itself into
   a town; a thriving village stays independent). Deterministic scan order.
2. **Population**: driven migration of the WHOLE population loser→winner —
   `applyExternalMigration` already moves exact counts uniformly by
   syndrome, and moving everyone is trivially uniform (the same argument
   `applyTraitFlip` uses). Conservation ledger unchanged.
3. **Structure**: the loser is TOMBSTONED, not deleted. cell-systems arrays
   are index-keyed (timers keep index keys — `addEntity` was designed
   around that), so removal-by-splice is a landmine. A tombstone is: pop 0,
   all processes idle (they already are, inputs zero), every incident edge
   conductance → 0 (flow nets re-solve around it; severed edges already
   partition economies), Site emptied. A `tombstone` flag excludes it from
   founding-spacing scans and from the civ ledger.
4. **Remains**: the tombstone renders as a RUIN — abandoned street tree at
   its last population (the plan is a pure function of scalars, so "the
   plan at its peak population, weathered" is free content). Decided (§7):
   a wild crowd or a colony CAN re-found on a ruin — the ruined street
   tree becomes the new plan's prefix (prefix-stability makes inheritance
   free: the new town replays the old events first, then grows past
   them), but the charter is sampled FRESH (the land under it may have
   changed since the ruin died).

The winner's charter does not change (it didn't move); what it gains is
population, which the Malthus loop converts into demand, construction, and
growth — absorption feeds the winner through channels that all exist.

### 2c. Colonization (cities found daughters where their scarcity points)

world-content.md §5 already names the socket: `findFoundingSites`' score
weights are "the SUPPLY/DEMAND socket — when the settlement layer starts
publishing scarcity (metal dear → ore weight up), founding starts answering
the market." Colonization is that socket plus a spend:

1. **Condition**: a settlement above the colony tier with sustained unmet
   demand (`satisfied`/need ratio below threshold for a resource, over a
   trailing window) and accumulated surplus ≥ `COLONY_COST`, and a
   qualifying site (scored BY the scarce resource) within `COLONY_RANGE`.
2. **The spend is mandatory** — the same edge-triggered-timer lesson
   buildings taught (world-content.md §4): paying the surplus is what
   re-arms the next colony. Cost IS the repeat mechanism.
3. **Transaction**: `foundSettlement` with colonists drawn from the parent
   (driven migration, conserving — the dual gate-5 suite already tests a
   colony founded mid-run), a route to the parent, the parent's membership
   trait in the startpop (a colony is born INSIDE the civ — contrast
   founding-from-the-wild, which births a new tribe). Charter at the site.
4. **Effect**: "farm cities extend into the mountains" is now literal — a
   lowland city starved for metal founds a pithead camp above the
   treeline, the ore flows down the new route, and the counterflow
   acceptance picture assembles itself one colony at a time.

Wild-crowd founding and colonization coexist: the wild field keeps
condensing new INDEPENDENT villages at the frontier (it regrows — wildlife
is renewable), while civs push PLANNED tendrils toward resources. Two
founding channels, one transaction. Decided (§7): the wild field is a
TRANSITIONAL resource, not a renewable one to protect — no harvest floor,
no reserve. Once civilization has claimed all available land, wild
humanity effectively disappears: every fertile tile sits inside some
settlement's charter, crowds are harvested as fast as they pool, and the
frontier is over. The endgame map has no warm tint — which is itself the
signal that expansion must now come from §2b/§2d, not from founding.

### 2d. Conquest (fusion — the missing half of breakaway)

Breakaway is a membership flip driven by a detected faction. Conquest is a
membership flip driven by a strength gap across a hostile border. The §7
note ("absorption is the same operation with the membership cures pointed
the other way") becomes:

- **Strength is a derived var** — a pure function via an ordinary
  ProcessSpec. Decided (§7): v1 drives it from POPULATION and ORE
  PRESENCE (`strength = population × f(ore_access)` — the charter scalar,
  simpler and steadier than metal flows); fortifications (a building var)
  and tech growth (composition trait fractions through `traitInputs`) are
  the later channels, both already sanctioned. Derived ⇒ zero
  loop-dimension cost (the validator counts only state attributes in
  feedback loops); the war loop below stays legal.
- **Condition**: a border edge (different majority civs — the daily
  hostility accrual already identifies these) with hostility at clamp AND
  strength ratio ≥ `CONQUEST_RATIO`, sustained for `SIEGE_DAYS` (a timer —
  the siege is the armed prediction, and it is watchable). Rest-compatible
  by the breakaway argument: every input is bounded and monotone-at-rest
  (hostility clamps, strengths settle with the economy), so a conquest
  that would fire, fires before the world rests; none can newly fire AT a
  fixed point.
- **Transaction**: the shared `absorb` transaction in POLITICAL mode
  (§2b): casualties on both sides (uniform removal — the C2b shape
  `applyVitals` deaths already use), then `applyTraitFlip` on the loser
  site: `member_of:winner` applies, `member_of:loser` removes. (Against a
  VILLAGE, physical mode instead — the hamlet is emptied into the winner
  and tombstoned.) Hostility on the edge resets (the war is over);
  hostility on the NEW borders starts accruing (the empire has new
  neighbors — expansion breeds the next war). The civ ledger is derived
  from membership counts, so the empire exists the moment the flip lands,
  no new bookkeeping.
- **The third outcome: STALEMATE (decided, §7).** Matched strengths at
  clamped hostility don't cool and don't conquer — they settle into
  CONTINUOUS BORDER SKIRMISHES: a daily attrition drain on both border
  settlements (casualties ∝ edge hostility, through the ordinary vitals
  channel) that consumes people and metal as fast as they are produced.
  This is a designed equilibrium, not a failure mode — the military
  sibling of the flow nets' "stabilise in motion": the border FREEZES,
  visibly bleeding, until an outside disruption shifts the strength ratio
  (an ally's conquest, ore depletion, a plague) or a tech/values trait
  breaks through. Values traits are the intended dial (the
  government-bundle idiom, world model §2): a warlike trait raises
  hostility accrual, a pacifist one raises its decay — whether a border
  grinds or cools follows from who lives there. A failed siege (ratio
  drops before the timer fires) cools hostility faster than baseline
  decay, so borders between UNMATCHED civs don't grind forever.
- **What an empire then IS**: exactly what a civilization already is — a
  membership trait spanning settlements, with the capital, color, and
  population derived. Post-conquest integration is composition dynamics
  that already exist: the winner's creed-vector absorption transmit
  converts sympathizers; unconverted majorities are tomorrow's
  `measureFaction` blocs — conquest SEEDS breakaway, and the imperial
  cycle (expand → overextend → fray) emerges from two events pointed in
  opposite directions.

Deliberately NOT in v1: armies as objects, marches, occupation levels,
diplomacy memory. A war is a timer on an edge plus one flip. Everything
else is presentation (§4) until gameplay demands otherwise.

---

## 3. History providers: where "plan ahead, fake the growth" comes in

With §2 built, the live sim can grow empires from bare terrain — but a
player who starts at the PRESENT of an old world, or fast-forwards deep
spans, needs centuries of settlement history. Civilization is
path-dependent, so timescales.md §2 gives it three providers. Both of the
affordable ones exist in shipped form elsewhere; this section maps them.

### 3a. Coarse-simulate: the tectonics pattern (build this first)

Run the REAL dual world forward at boot and record keyframes —
`runTectonics(… keyframeEvery: 25)` + `geo-scrub.ts` is this exact shape,
shipped, for geology. The aggregate civ sim costs ~1.5 ms/day at 14 cities
(the gate-6 stress figure), so a 10,000-day history is seconds of boot
compute, bit-deterministic, and honestly a trajectory: the scrubber
becomes a CIVILIZATION history slider (borders creeping, cities appearing
and dying) next to the geologic one.

Costs to respect: vitals worlds never rest (the carries tick daily), so
the run is linear in span — fine for centuries × dozens of sites,
uncomfortable at planet scale × millennia. And keyframes of a settlement
graph are cheap (scalars per site per frame), unlike grid keyframes.

### 3b. Generate (cheat): the streets.ts move, one level up

The deep observation behind the rivers method, stated once:

> streets.ts made the town plan a deterministic growth-EVENT STREAM whose
> emitted order IS the development history — prefix-stable, re-derived
> from scalars, "a bigger town replays the same events further." The
> substrate presenter made a jump watchable by ordering its reveal along
> a structure the solver already knows (the drainage tree IS the carve
> order). Planned history for civilization is the same two ideas with
> the settlement graph as the structure.

The endpoint is (mostly) solvable without stepping history:

- **Where settlements end up**: `findFoundingSites` over the RESTED
  substrate — deterministic, spaced, resource-ranked. Already the case.
- **How big each ends up**: the Malthus equilibrium is closed-form from
  the charter (world-content.md §4b: fill* = (death+starv)/(birth+starv),
  K = supply/(rate·fill*)) — mature population from farmland/ore, no
  stepping.
- **Who feeds whom**: the flow-net solve over the mature graph gives the
  trade tree — which villages' food flows to which town, which pithead's
  ore to which valley. This is the **settlement hierarchy tree**, and it
  is the drainage tree's exact analogue (central-place structure falling
  out of a solver we already run).

Then EMIT history as an ordered event stream over §2's vocabulary:

- **Ordering = leaves → trunk**, the way the carve front runs headwaters →
  mouth: hamlets condense first (in wild-crowd density order), merges fire
  up the hierarchy tree (a village merges into the town its food already
  flows to), colonies extend when the trunk's mature demand implies them,
  conquests fire last, along the strength differentials of the mature
  economy.
- **The clock is a development threshold, not a date**: key each event to
  CUMULATIVE BIRTHS (decided, §7 — strictly monotone even through
  regional collapse, where live population would rewind), the way street
  lots key to town population. Prefix stability falls out — an older
  world replays the same stream further, and watching history is
  replaying the stream, which never reshuffles what the player has seen.
- **Re-plan on substrate change** — sculpting re-routes rivers; it also
  re-plans the unplayed future. Same discipline as `townBias`:
  session-memoize what the player has witnessed (history already shown
  never re-lays); only the future re-plans.

The correspondence, explicitly:

| rivers | civilization |
|---|---|
| drainage tree (from the flow solve) | settlement hierarchy tree (from the flow-net solve) |
| carve front, headwaters → mouth | growth events, hamlets → capitals |
| accumulation strictly increases downstream | population/flow strictly increases up the hierarchy |
| re-route on sculpt, ease retargets | re-plan on change, memoized past |
| `intRivers` flow field: zero per-step cost | event stream: zero per-step cost, replayed on demand |

**The honest weak point: conquest.** Economic endpoints are attractors —
closed forms are credible. Political endpoints are contingent (who wins a
war depends on the order wars happen). Options, in preferred order: (1)
mix providers — closed-form the economic history, coarse-simulate only
the political layer over it (cheap: politics is per-border-edge, not
per-tile); (2) accept the plan's determinism as canon (the sim is
deterministic too; a plan derived from mature strength is a plausible
draw, just not THE trajectory); (3) don't plan conquest at all — boot the
planned economic world and let §2d fight the wars live from there. A game
profile picks (timescales.md §7).

### 3c. The agreement contract (what makes the cheat legal)

timescales.md §1: providers for the same layer must agree at the
interface. Here that is TESTABLE because the plan is built from the sim's
own attractors — the same `findFoundingSites`, the same flow solver, the
same Malthus algebra, invoked at plan time instead of step time. The
acceptance test: generate a planned history; separately run the live sim
from bare substrate; assert the settlement rosters, tier ladders, and civ
partitions land within tolerance. Divergence localizes to whichever §2
event's condition the closed form mis-approximates — which is exactly the
list of things to fix.

### 3d. The economic endpoint when goods widen (2026-07-08)

Today's economy is two shallow chains (grain→food, ore→metal) whose
stages never compete for an input. The planned history must survive a
REAL goods economy — many materials, traded as reagents into higher
goods — and the town-level goods work (city-development.md) will push in
that direction. The analysis, so the planner is built against the right
contract:

**What survives, and why: closed COMPUTATION, not closed formula.** The
§3b design rules — Leontief processes (`min(input × eff, capacity)`),
DAG chains, inelastic demand, every raw anchored to a static charter
field — are exactly the conditions under which the mature economy of a
fixed settlement network is a deterministic fixpoint of a monotone map.
The sim reaches it in ~chain-depth days; the planner reaches the same
point by running the same relaxation instantly at plan time. Deep chains
cost the planner iterations, never tractability. Malthus K stops being a
one-liner (food's chain must be evaluated at the mature building stock)
but stays derivable feed-forward from the charters. This is the §3c
contract restated: the plan is the sim's own solver, invoked early.

**Gap A — the algebra supports paths, not real DAGs (engine work, needed
before any planner).** Every `satisfied` currently feeds exactly one
process and every demand scalar has one writer; chains are linear. Two
things break when goods become shared reagents:

- *Fan-out double-counting*: processes are pure reads — they don't
  consume inputs. Two processes at one settlement reading the same
  `ore_got` (weapons AND tools) would each transform the full amount.
- *Fan-in overwrite*: aggregate demand with several sinks (households
  burn timber; the shipyard consumes it) needs a SUM, and multiple
  processes writing one output is a validator warning ("later wins").

Both fixes are small, derived-pure (no loop-dimension cost), and have
shipped precedents: an ADDITIVE COMBINATOR (fan-in — drift already
accumulates additively) and a CONSERVING PER-SETTLEMENT ALLOCATOR
(fan-out — `allocateDistrictFill` in city-districts.ts is this exact
shape one level down). Non-negotiable: the allocation rule is part of
the provider seam — boring data (a fixed priority order), reproduced
bit-for-bit by the planner, never a heuristic.

**Gap B — unanchored industry location (the real threat to the
planner).** With two goods, geography decides everything and the
endpoint is unique. A smithy has no substrate anchor: smelt at the mine
or at the consumer? Today the funding channel can't even ask — granary
drift is the COMPONENT MEAN, uniform across the trade component, so
construction is symmetric by construction (evenly smeared industry,
never clusters). Localize the funding or gating (build rules reading
LOCAL input availability) and you get specialization — but then which
town gets the first smithy is PATH-DEPENDENT: industry location joins
conquest as a contingent outcome, and the endpoint is one of several
equilibria that the trajectory picks. Mitigations, in preference order
(the conquest precedent, §3b):

1. **Anchor everything in v1**: every process's `capacityBy` building
   caps from a charter field (smelters ← ore_access, sawmills ←
   timberland; genuinely footloose goods anchor to population or the
   hall). Endpoint unique; planner stays closed.
2. **Deterministic tie-breaks shared by sim and planner** — founding-
   order scans, the discipline merge/colonize already use. The plan
   matches the sim by construction, not by luck.
3. **Coarse-simulate industry placement** like politics — cheap,
   per-settlement not per-tile.

**Depletables make the history piecewise-stationary — and that is a
gift.** Ore is a budget (more raws add stone; timber tracks the living
plant field and renews). Depletion rates are deterministic, so
exhaustion dates are COMPUTABLE: the planned history becomes a sequence
of structural events and depletion epochs, each followed by an instant
re-solve. Mining booms, busts, and re-specialization arcs fall out of
the planner instead of fighting it.

**The town level costs the planner nothing.** The truth stays at the
settlement scalars; street-level goods remain a projection
(city-development.md's cheat-provider discipline). Better: because town
plans are prefix-stable pure functions of scalars, a planned economic
history yields WALKABLE PAST TOWNS for free — scrub to day N, hand the
planned scalars to `townPlan`, and the town of that era assembles. The
one requirement: the commodity vocabulary is defined ONCE, at the
settlement layer, and projected down — not grown independently in
food.ts's idiom.

**Doctrine guards (write them down before they're violated):**

- **Inelastic demand stays law at the aggregate layer.** Prices or
  substitution turn the monotone fixpoint into general equilibrium and
  kill plan-time solving — and city-development.md already committed to
  "scarcity shows as emptier boxes, never as prices".
- **No labor, no productivity feedback.** Population→capacity coupling
  is the tools→production→ore→tools loop family the validator rejects,
  and rightly. Population gates the economy through demand only.

---

## 4. Presentation (already mostly built)

The transient layer needs almost nothing new — §2's events are precisely
the "discrete births/deaths + continuous quantities that jump" the
machinery was abstracted for (transients.ts):

- Founding: `createRevealTracker` already grows cities in with a pulse and
  reveals routes parametrically (caravans wait for the road).
- Merge: the loser's fade-out phase IS the abandonment; the ruin persists
  as the faded key's final state. The winner's growth is the ordinary
  eased radius plus, zoomed in, the street-tree construction diff that
  town rebuilds already play (scaffolds, paving).
- Colonization: a route reveal parent→site, then a founding pulse — a
  visible tendril, which is the arc's signature image.
- Conquest: the siege timer is the watchable part (a slow hostile-border
  effect while it arms); the flip eases ring colors through
  `createEasedValues`; new borders start glowing. At avatar scale, later:
  the same event over game-days (timescales.md §5b granularity-per-zoom).
- History scrubbing (§3a): the geo-scrub pattern verbatim — shown
  settlement scalars ease toward the interpolated keyframe.

Deterministic naming replaces the name tables: the histfig syllable
generator already exists; seed by (worldSeed, siteKey).

---

## 5. The player seam (name it, per §5b's own rule)

Rivers get away with planned growth because nothing READS the fake
trajectory — consumers read authoritative state. Civilization history has
one consumer that can interrupt it: the player.

- **Zoom-in mid-history** = the refine trigger (timescales.md §6): hand
  the keyframe/planned state at time t to the live sim as its initial
  state and step from there. Provider agreement (§3c) is what makes the
  handoff seamless.
- **Interference invalidates the future**: a robbed granary, a led
  breakaway, a sculpted valley — re-plan (or re-simulate) forward from
  the interference. The retarget-free easing absorbs the visual jump; the
  memoized past guarantees nothing already witnessed rewrites.
- **The scrubber is read-only** toward the past (recorded keyframes are
  facts), interactive only at the head. If scrubbing BACK and playing
  forward differently is ever wanted, that is save-branching, out of
  scope here.

---

## 6. Migration path (each step playable)

1. ✅ **DONE (2026-07-07) — Found small + tiers** (§2a): villages,
   construction-driven growth into towns. Smallest change, immediately
   visible in GENESIS.
   *Landmarks: `triBase({construction: true})` in
   `grand-dream/src/tri-worlds.ts` — a `granary` fed by the food net's
   `drift`, charter-derived cap vars via derived processes (`farm_cap` =
   farmland/60 etc., the same sizing `buildings()` grants outright), and
   staggered build rules; `villageSeed` (subsistence farms ∝ the
   harvested crowd) replaces the charter-sized grant in the GENESIS and
   TECTONIC factories; `FoundTriOpts.tiers` + `TriWorld.tierOf` (tri.ts)
   with the `TIERS` ladder as world data (village / 20k town / 40k city,
   sized to measured founding crowds of ~10–19k souls); the lab labels
   nodes `name · tier`. Construction is OPT-IN — the acceptance/stress
   fixtures keep their pre-granted stock, both because they are
   regression pins and because a granary crawling to its clamp would
   stall the no-vitals rest test. Four lessons, all load-bearing:
   ① build rules are `{every}`, not timers — timers are strictly
   edge-triggered, and a granary that overshoots twice the cost never
   re-arms the guard (the spend must drop it below threshold), so a rich
   town builds once and stalls; ② the MALTHUS TRAP: a fat crowd founding
   on one farm starves to the single-farm carrying capacity with the
   granary pinned at 0 — subsistence seeding must scale to the crowd
   (the scalars factory now receives the founding population); ③ the
   CALIBRATION LAW: at Malthus equilibrium fill* < 1 ⇒ drift ≤ 0, so
   surplus exists only in the fed transient after each build re-opens
   headroom — a build cost must fit inside that transient's integral
   (cost 60 built ONE farm in 200 days; cost 20 ladders to the charter
   cap ahead of the population); ④ two VALIDATOR refinements
   (`world-validate.ts`): flow-net `by` edges to drift/satisfied exist
   only when the conductance var can sever (min ≤ 0) — per-component
   mean/fill genuinely don't read conductance values — and MONOTONE
   COUNTERS (vars written only by fixed-sign adds; buildings) don't
   count toward loop state dimension, the scalar mirror of forward-only
   stages; without both, three build rules sharing one granary over
   road-conducted nets read as a fictitious 4-state SCC. Caveat noted
   for later: demolition/decline rules make counters bi-directional and
   re-fuse the loop — decline needs its own shape. Tests: the step-1
   suite in `grand-dream/src/__tests__/tri.test.ts` (villages found at
   subsistence, grow to the charter cap, tier consistency + a real
   promotion) and entities-checks #20–21 (severability, monotone
   counters, demolition re-fusion).*
2. ✅ **DONE (2026-07-08) — Tombstone + merge** (§2b): the first
   settlement death; ruins render. Tests: conservation across the merge,
   flow nets re-solve around the tombstone, world re-rests,
   founding-spacing ignores ruins.
   *Landmarks: ENGINE — `setEntityDisabled` + `EntityWorld.disabled`
   (cell-systems entities.ts): the tombstone primitive, mirror of
   `addEntity` — a disabled entity is ABSENT from every dynamic (rules,
   timers dropped, exchanges, conflicts, processes, flow-net components:
   incident edges sever, no drift share, no satisfied) while its index
   survives (splice is a landmine — timers and the layers above key by
   index); mask serialized, grown by addEntity, in the flow-net
   fingerprint. Contract: the engine guarantees absence from DYNAMICS;
   the CALLER zeroes the scalars, because processes skip a ruin and a
   derived output left standing would freeze at its last value. Roads to
   a ruin decay to their floor on their own (the roads mechanism, not an
   edge rule) — ruins re-rest. DUAL — `DualWorld.absorbSettlement(loser,
   winner)` + `tombstones()` (dual.ts): whole-population driven migration
   (`applyExternalMigration` — exact, uniform by syndrome, conserving),
   every loser scalar to its var floor, tombstone, migration carries
   zeroed, immediate write-back — layers agree at the moment of
   absorption, and the civ ledger drops the ruin for free (membership
   counts are derived). TRI — `FoundTriOpts.merge` (tri.ts): the economic
   trigger — every N days, founding-order scan for a STALLED loser
   (food fill < stallFill; at Malthus equilibrium fill* < stallFill, so
   every mature settlement eventually qualifies — §2b's "a thriving
   village stays independent" is the growth phase) with a route-connected,
   same-civ, cold-border neighbor within range at ≥ ratio× its size;
   largest such neighbor wins; ONE merge per scan day (deaths read as
   events). Ruins: excluded from founding spacing and road wiring (a
   later crowd may rise beside a fallen one), from mining, and from
   merging; `tierOf` returns "ruin"; the lab draws a faded dashed ring
   with a greyed italic label. GENESIS/TECTONIC run `MERGE` (tri-worlds:
   ratio 3, range 10 — sized so similar-age siblings coexist). Tests:
   entities-checks #22 (severed economy, re-rest, save/load,
   catch-up==stepping), the dual absorption suite (conservation, layer
   agreement, refusal cases, re-rest + O(1) jump after a death,
   determinism), and the tri merge suite (two river towns with ceilings
   ~1.19 apart: both stall, the better-landed one absorbs — people walk,
   a ruin remains, the lifetime ledger holds, byte-deterministic).
   Deferred within §2b: zoom-level ruin rendering (the weathered street
   tree at last population — needs a peak-pop plan input at the town
   layer) and ruin re-founding inheritance (§7's decision stands; wire it
   when a founding actually lands on a ruin tile).*
3. ✅ **DONE (2026-07-08) — Colonization** (§2c): scarcity-scored,
   surplus-spending daughters. Test: the acceptance picture (farm valley
   + mine ridge) assembles from ONE seeded valley village with no
   mountain crowd needed.
   *Landmarks: `FoundTriOpts.colonize` (tri.ts) — every N days, the
   first parent in founding order that is (a) at/above `minTier` (the
   §2a tier gate doing its job: villages don't found colonies), (b)
   SCARCE for a listed resource for `window` consecutive scans
   (per-(resource, city) counters — "sustained unmet demand"), and (c)
   funded (`costScalar` ≥ cost) founds a colony at the best unoccupied
   site RANKED BY THE SCARCE FIELD (`findFoundingSites` with threshold 0
   — crowds gate wild founding, resources alone rank colonies) within
   `range`, post-checked to actually hold `minField` of it (density can
   outrank an empty box). The transaction is `foundSettlement` with
   pop 0 + colonists-only driven migration: conserving, no harvest
   (wildlife stays wild), and — because uniform-by-syndrome migration
   carries the membership trait — the colony is BORN INSIDE the parent's
   civ with no startpop needed, exactly as §2c decided. The cost spend
   re-arms the next expedition and resets the scarcity window; one
   colony per scan day; `maxColonies` caps, and `autoFound.maxCities`
   now counts WILD foundings only. Colonies carry `colonyOf` on the tri
   city list (harvested 0). Profile: `COLONIZE` (tri-worlds.ts — town
   tier, metal fill < 0.5 for 3 scans, cost 300 granary, 2k colonists,
   ore-scored within 30 tiles), wired into GENESIS + TECTONIC. The
   load-bearing tuning discovery: **half the cost arrives as the camp's
   starting granary (`COLONY_STORES`)** — colonies found when the parent
   already sits at its Malthus plateau, where drift ≤ 0 (the step-1
   calibration law), so a camp waiting on the component's surplus mean
   would never bank its first mine; carried stores let it build mine +
   smelter off its own wagons, then live on imports and ore. Ship-gate
   test (tri.test.ts step-3 suite): ONE seeded valley village grows to a
   town, stays metal-starved, sends an expedition to the ridge — camp
   sited on ore not farmland, same civ, nothing minted (the ledger
   identity holds), mines + smelters rise, metal flows home while food
   flows out on the same road (the §6 counterflow), the mountain
   depletes, byte-deterministic across reruns.*
4. ✅ **DONE (2026-07-08) — Strength + conquest** (§2d): the imperial
   cycle. Test: a deterministic two-civ world where the stronger
   conquers, absorption converts, and a seeded dissent later fissures
   the empire — fusion and fission in one arc, resting between wars.
   *Landmarks: `coupling.conquest` (dual.ts) — the fusion mirror of
   breakaway, processed each day between vitals and the write-back so
   war dead land in the same sync. STRENGTH is CIV-level: Σ over each
   civ's majority sites of weighted `strengthScalars` (v1 as decided:
   population + ore_access — a linear combination, because ProcessSpec
   is a min-combiner and can't express a product; the weights are data).
   SIEGE: a border edge (different majority civs) at `hostilityAt` where
   one civ ≥ `ratio`× the other arms a SIGNED per-edge day counter
   (direction change restarts the clock); at `siegeDays` the defender's
   site falls — `casualties` on BOTH endpoint sites (uniform removal via
   applyVitals, so the vital ledger stays exact: totalPop = start +
   births − deaths through every war), then §2b's mode split: POLITICAL
   for a town (`applyTraitFlip` grew an optional `siteKey` scope in
   popusim — a fallen city changes flags, its civ elsewhere does not) or
   PHYSICAL below `villagePop` (emptied into the attacker via
   absorbSettlement — the walkers KEEP their flags, a minority inside
   the empire, which is why an emptied hamlet can't secede). Hostility
   on the resolved edge resets; new borders arm themselves the next day
   (`armBorders` generalized: borders are tense whenever DIFFERENT
   majorities exist, not only after a breakaway — conquest worlds start
   multi-civ; pre-breakaway single-civ worlds behave identically).
   STALEMATE (§2d third outcome as decided): `skirmish` × hostility
   deaths bleed both endpoints of every hot border daily through the
   vitals mechanism — matched civs consume people as fast as produced;
   a broken siege cools its edge by `failedSiegeCooling` so unmatched
   borders don't grind. REST: `conquestPending` (any live border ⇒ the
   world never claims rest — conservative and honest: a bordered
   stalemate steps forever, "visibly bleeding", by design); once one civ
   spans everything the world proves its fixed point and O(1)-jumps —
   resting between wars, literally. `conquests()` is the war ledger
   ({day, edge, loser, winner, civ, mode, casualties}). TRI:
   `triBase({conquest: true})` (population weight 1 + ore_access weight
   50, ratio 2, siege 10 days, casualties 3%, villagePop 5k, skirmish
   0.001) wired into GENESIS + TECTONIC — a mountain secession now gets
   besieged back by an empire twice its strength; OPT-IN because the
   acceptance fixture asserts a PERSISTING secession. Tests (dual.test
   step-4 suite): the full arc — Aurelia besieges the fort (fusion), the
   fort's seeded pride — inert while Borvian, coherent once flipped
   INSIDE the empire — secedes it back out (fission), reconquest, then
   rest with skipped > 0; the physical-mode hamlet arc (one war,
   tombstone, loyal-minority Borvians, rest); byte-determinism. Not in
   v1, per §2d: armies as objects, marches, occupation, diplomacy
   memory — a war is a timer on an edge plus one flip.*
5. ✅ **DONE (2026-07-08) — Keyframed history + scrubber** (§3a):
   boot-run + geo-scrub twin.
   *Landmarks: `FoundTriOpts.history` (tri.ts) — every N days (after the
   day's structural events, plus a day-0 baseline) the tri world records
   a `CivFrame`: per-city population, majority civ, dead flag, plus edge
   count and the named road/hostility attrs. Pure read, tiny frames
   (scalars per site — nothing like grid keyframes), and PREFIX-STABLE
   BY CONSTRUCTION: the city and edge rosters only append, so a frame's
   array length IS its roster size — founding, death, and border history
   are all legible from the frame sequence alone. `TriWorld.history()`
   returns the frames plus read-time roster snapshots;
   `historyFrames()` is the cheap UI count. `HISTORY` profile
   (tri-worlds, every 5 days) wired into ACCEPTANCE + GENESIS + TECTONIC
   (recording changes nothing, so even the pinned fixture can afford
   it). PRESENTER — `civ-scrub.ts`, geo-scrub's twin: `civTargetAt`
   (pure, tested) lerps continuous quantities (pop, road wear, border
   heat) between straddling keyframes and snaps discrete facts (roster
   membership, majority civ, dead) to the NEARER frame — the same
   "ownership is discrete" rule geo-scrub uses for plates;
   `createCivScrubber` eases the shown values toward the target
   (retarget-free, primes at the head). LAB — a "Civilization history"
   slider beside the geologic one (appears once ≥ 2 frames exist,
   scrubber built lazily on first input and rebuilt when frames accrue):
   at pos < 1 the map replays the recorded past — rings swelling and
   changing flags, ruins appearing, roads thickening, borders glowing
   red — over the PRESENT substrate (the civ layer is what's keyframed;
   terrain drift is slow enough to stand behind it — the honest §5b
   caveat, named), and the live graph resumes at pos 1. Read-only toward
   the past, per §5. Tests: civ-scrub.test.ts (keyframe-exact positions,
   lerp vs nearer-frame discrete, mid-history founding presence, eased
   view converging exactly and retargeting free) + the tri.test.ts
   recording suite (cadence, prefix-stable rosters, head frame ==
   live world, byte-identical frames across reruns). NOT yet: recording
   substrate keyframes alongside (scrubbed terrain past), event flashes
   (conquests/foundings as scrub-time pulses), and persisting history
   into saves — natural follow-ups when the scrubber earns gameplay.*
5b. ✅ **DONE (2026-07-08) — Goods v2** (§3d — prerequisite for a planner
   that survives a real economy): the fan-in/fan-out primitives, four
   goods with a genuine two-stage cross-settlement chain, every
   intermediate anchored, multi-stockpile construction costs. (The §3c
   per-commodity agreement test lands with the step-6 planner itself.)
   *Landmarks: ENGINE (cell-systems spec.ts / entities.ts /
   world-validate.ts) — three derived-pure relays, zero loop-dimension
   cost: `ProcessSpec.inputs` (multi-reagent Leontief — min across ALL
   inputs; the scarcest binds; exactly one of input/inputs, validated),
   `SumSpec` (fan-in: output = Σ scale×term, the additive combinator
   demand aggregation needed — multi-writer outputs were "later wins"),
   and `AllocateSpec` (fan-out: a delivered quantity divides across
   consumers IN ARRAY ORDER, conserving — Σ shares ≤ source; priority is
   boring data the planner reproduces bit-for-bit; later shares depend
   on all earlier demands in the coupling graph). Evaluation order:
   processes → sums → flow nets → allocates, so a sum of this step's
   draws is this step's net demand and consumers see their allocated
   share NEXT step — one settle-step per chain stage, as ever. TRI —
   `triBase({goods2: true})`: planks milled from the timberland charter
   (`sawmills`), tools = metal + planks (multi-reagent; `smithies`
   anchor to POPULATION, the §3d footloose fallback), metal_need =
   households + smithies (fan-in), delivery split SMITHS-FIRST
   (fan-out), plank surplus banking in `plank_store` — the second
   stockpile that part-pays smithies (multi-stockpile cost). Wired into
   GENESIS + TECTONIC. Three lessons, all §3d laws confirmed live: ①
   INDUSTRY AFTER SUBSISTENCE — cumulative funding thresholds above the
   base stack (115+) are unreachable because base builds drain the
   granary through the whole fed window; the goods2 builds instead GATE
   on the base stock being complete, which also makes them mutually
   exclusive with the base rules so their stagger only spans each other;
   ② SEQUENCE IS THE MECHANISM — founding a barren camp simultaneously
   with its feeder starves the component from day 0 (no fed transient
   exists at all; population just declines to the seed-farm equilibrium
   with the granary pinned) — the reagent economy must GROW along the
   step-3 arc: village → build-out → colony; ③ ALLOCATION PRIORITY IS A
   REAL POLICY LEVER — households-first starves the tool chain the
   moment metalware demand outgrows supply (metal_for_smiths pinned 0,
   tools never made); smiths-first feeds industry and households buy
   what's left. Tests: entities-checks #23 (fan-in sum, priority-exact
   fan-out under plenty and scarcity, conservation, scarcest-reagent
   binding, re-rest, catch-up == stepping, validator teeth) + the
   tri.test.ts step-5b suite (one village grows sawmills → banks planks
   → builds smithies → colonizes the ridge → metal comes home → tools
   ship back over the pass; every relay contract asserted live;
   byte-deterministic).*
6. ✅ **DONE (2026-07-08) — Planned event stream** (§3b): the economic
   history behind the same seam; the §3c agreement test decides how much
   politics the closed form may claim. Political layer per profile.
   *Landmarks: `planHistory(prep, opts)` in `grand-dream/src/plan.ts` —
   the v1 planner is THE CHEAPEST PROVIDER THAT REUSES THE SOLVERS
   VERBATIM: the real settlement EntityWorld runs every planned day
   (processes, flow nets, sums, allocators, construction rules, road
   wear — the §3d fixpoint is the sim's own), population follows the
   Malthus POLICY in closed float form (same rates the dual coupling
   applies through integer carries; the fill attractor keeps the
   trajectories glued), and the structural event gates — founding,
   colonize, merge — mirror tri.ts clause for clause on the same scan
   cadences, taking THE SAME factory/profile objects (shared gates kill
   drift). The Composition layer is never invited — that was the whole
   per-day cost — and with it politics: no breakaway, no conquest, civ
   column constant (§3b option 3: boot the planned economic world and
   let §2d fight the wars live). The planner NEVER MUTATES the caller's
   grid (mining depletes a private ore copy; charters read the shared
   rested fields), so plan and live sim can run over the same substrate
   — which is exactly what the agreement test does. OUTPUT IS THE STEP-5
   SEAM: a `CivHistory` plus a `PlanEvent` stream carrying the §7
   development clock (cumulative births, monotone through collapse) —
   the civ scrubber replays a planned past exactly like a remembered
   one. A load-bearing geometry fact makes wild foundings PLAN-EXACT:
   founding boxes are spacing-disjoint (minSpacing 6 > 2×radius+1), so
   standing crowds equal `FoundingSite.density` and harvests never
   perturb later candidates — the planner needs no people-field
   stepping at all. THE AGREEMENT TEST (plan.test.ts, the §3c gate):
   plan and live sim over identical rested substrates — roster
   identical (keys, positions, founding ORDER, harvest counts EXACT),
   wild foundings frame-exact, colonies same parents/sites within ±4
   frames, buildings within 1, populations within 10%, per-commodity
   fills within 0.15, births ledger within 10%, planned frames hold the
   step-5 invariants and scrub via `civTargetAt`, byte-deterministic.
   The probed 300-day plan: 3 towns (days 5/10/15) + 3 ore colonies
   from 3 different parents (days 65–75), towns maturing ~31–34k.
   Upgrade path, noted not needed: O(events) instead of O(days) —
   analytic Malthus integration between scan days with the settlement
   world stepped once per epoch (a planned day is already microseconds).
   NOT planned, by profile: politics (live-only), and the §5 refine
   handoff (boot a live world FROM a planned frame) — the natural next
   piece when deep-history worlds ship.*
6b. ✅ **DONE (2026-07-08) — City view mode** (the first INSPECTION
   surface — a settlement examined as a map plus its books, one level
   between the world map and the walkable zoom; built ahead of step 7 by
   choice).
   *Landmarks: `grand-dream/src/city-view.ts` — a read-only projection
   in the §5b discipline (everything READS; nothing feeds back). DATA
   LAYER (headless-tested): `cityOverview` (population, tier, civ, ruin
   status, colony parentage/children, harvest, charter, building counts,
   stockpiles, per-commodity fills — each row appears only if the world
   declares its vars, so base and goods2 worlds both render honestly);
   `cityChronicle` (the city's OWN COLUMN of the step-5 CivHistory —
   population series plus every structural event naming it: founding,
   colonies sent, conquests suffered/won, abandonment);
   `hitTestBuilding` (town-local meters → work/house/field, works first,
   with a 2 m padded second pass — at full-town zoom a house is 4 px and
   near-misses should land); `buildingInfo` (a work reports its
   production from the live scalars — farms/grain, mines/ore,
   smelters/metal, a market its shelf stock, dawn stocking, catchment
   and district fill, the hall its stockpiles; a house reports its
   district, pantry level from the goods clock, shopping source, and
   its HOUSEHOLD — the same deterministic residents the walkable world
   spawns, shopper marked). PAINTERS: `paintCityMap` (ground, fields,
   plaza + the organic street tree with §3b traffic wear, houses tinted
   by district kind, typed works with glyphs, selection highlight;
   returns the transform for click mapping) and `paintSparkline` (the
   chronicle's population curve with event ticks). LAB (main.ts):
   clicking a city now opens the CITY VIEW overlay — map beside a
   scrolling panel (overview / charter / buildings / stockpiles / supply
   bars / chronicle / building) with live repaint timers; "🚶 Walk here"
   drops into the step-7 seamless world at the same city (ruins can't
   be walked); the view closes on scenario change. VERIFIED IN A REAL
   BROWSER (playwright drive of the acceptance world): the overlay
   opens on click, the map draws the street tree with works and fields,
   the panel fills, and clicking the town hall highlights it and
   reports its data. Tests: city-view.test.ts (overview mirrors live
   scalars and invents nothing, chronicle == the history column,
   hit-testing exact + padded, deterministic households, work
   production lines). Known gap, named: the town-plan vocabulary lags
   goods2 — sawmills and smithies COUNT in the resources panel but have
   no map footprint yet (a zoom.ts `townPlan` follow-up).*
6c. ✅ **DONE (2026-07-08) — Street goods & the new works** (closes 6b's
   named gap and widens the INDIVIDUAL layer to a second need).
   *Landmarks: (a) NEW WORK TYPES — `TownWork` grew `"sawmill"` and
   `"smithy"`; `townBias` reads a third bearing off the `plant` field
   (`timber`, NOT added to the arterial bearings — that would re-lay
   every existing street tree; only work placement uses it); typed tip
   placement now carries `toward` per work type (sawmills lean at the
   trees, the forge takes an outskirt tip whichever way — fire risk
   lives at the town's edge). The vignette (`cityContent`), district
   classifier (new `craft` DistrictKind + tint in both painters), city
   view (🪚/🔨 glyphs, production info from `planks_out`/`tools_out`/
   the smith draws) and the walkable renderer all learned the types.
   (b) SECOND NEED — tools, projected by the SAME GoodSpec machinery
   food rides (food.ts was genericized for exactly this): `TOOLS_GOOD`
   (need `tools_need` / got `tools_got` — humans have demanded tools at
   the aggregate since step 5b; sellers/shelved/producers = smithy;
   capDays 9 ⇒ the wares trip comes a third as often as food) and
   `createTownWares` which returns NULL where the settlement keeps no
   tools ledger — the street never invents one. `LoadedTown` carries
   `wares` beside `food`; houses get a WARES CHEST (`waresBoxAt`, the
   pantry crate's opposite corner, steel-grey); smithies render counter
   stands exactly as markets render stalls; street WEAR and ambient
   walkers sum every good's trips. (c) ERRAND ROLES — household member
   1 (successor-by-exclusion, same rule as the shopper) walks the wares
   run on its own clock, so a two-need household is two different
   people out on different errands; `TownManager`'s witnessed-box
   machinery generalized from food-keyed to (household, good)-keyed
   (`boxLevel`, `tripWalking`/`committed`/`lastShown` on box keys,
   `tripArrived` resolves WHICH box the arrival fills), with `pantry()`
   byte-compatible and `wares()` beside it. (d) THE VARIANT SEAM —
   `buildingInfo` shows a deterministic per-household "table favorite"
   (display-only): the hook where real food variants would attach; the
   ledger knows one FOOD until the aggregate splits it. Tests:
   wares.test.ts (placement + timber lean, projection existence gated
   on the ledger, smithy counter + hall-imports fallback, slow cadence,
   opposite-corner boxes, city-view lines, and the member-1 runner
   spawning mid-errand with the trip ending at the chest while the
   pantry reads its own clock). Browser-smoked: city view + seamless
   world, no page exceptions.*

   **The recipe for FURTHER needs** (what 6c proves out): a new need =
   (1) an AGGREGATE chain — trait demand on humans, a `demandInputs`
   scalar, production processes + a flow net, a building var grown by
   construction rules (this is a step-5b-shaped calibration: INDUSTRY
   AFTER SUBSISTENCE gates, costs inside the fed-transient integral);
   (2) a WORK TYPE for the seller (one `TownWork` entry + styles/glyphs
   + a placement bearing); (3) a `GoodSpec` descriptor + a guarded
   factory like `createTownWares`; (4) nothing else — errand roles,
   boxes, stands, districts, traffic and witness rules come free from
   the good-agnostic machinery. CLOTHING is the worked example waiting
   on (1): a fiber source (flax on farmland / wool on highland) → weaver
   work type → `cloth_need`/`cloth_got`, then ~30 lines of street code.
   PREFERRED FOODS are variants WITHIN a good: either display flavor
   (shipped — the variant seam) or real variants, which are just more
   goods (fish and grain as separate flow nets) under doctrine §3d: ONE
   commodity vocabulary at the settlement layer, projected down.
6d. ✅ **DONE (2026-07-08) — Economy as CONTENT + clothing** (the
   direction set explicitly: complex multi-item systems must be
   definable in the external world-definition document — developers add
   goods, buildings and chains as data).
   *Landmarks: `economy.ts` — `EconomyDoc` (commodities / buildings /
   stockpiles; full parameter inventory in world-content.md §3e) +
   `compileEconomy` emitting all four layers' pieces: settlement spec
   fragments, coupling rows, street GoodSpecs (errand roles + house-box
   corners by REGISTRATION ORDER — `goodBoxAt` slots SW/SE/NE/NW), and
   the presentation registry that REPLACED the hard-coded
   `Record<union,…>` tables (TownWork.type is an open string now;
   styles/glyphs/titles/info-templates/placement-bearings/district-
   classes all come from `BuildingDef`; hall + market stay structural
   builtins). COMPILER LAWS, each a hand-calibration trap converted to
   structure: tier gates generated from "tier: industry" (INDUSTRY
   AFTER SUBSISTENCE), cumulative funding stagger, mandatory capacity
   anchors (compile error), one-vocabulary street filtering
   (`streetGoodsFor`). `economy-core.ts` = the standard chains AS
   content (CORE_BASE + CORE_GOODS2, costs moved here, tri-worlds
   re-exports); `triBase` now COMPILES its economy (structural parts
   only remain); `TriWorld.economy` carries the compiled registry to
   the street (DEFAULT_ECONOMY fallback for older fixtures/stubs).
   THE EQUIVALENCE GATE (economy-equivalence.test.ts): compiled CORE ==
   a FROZEN copy of the pre-rewire hand-written fragments, byte-for-
   byte (vars as name-keyed maps; processes/rules/nets exact order —
   process order is SEMANTIC, same-step chaining) — deliberately not
   compared against live triBase, which would be a tautology after the
   rewire. CLOTHING (economy-clothing.ts): wool grazed on the pasture
   charter (sheepfolds, the planks flow pattern — net demand IS the
   weaver draw), cloth woven (weavers anchor to population), sold over
   a shelved counter, household member 2 running cloth errands to the
   linen chest (slot 2, NE corner) — ZERO engine/street/renderer
   edits, wired into genesis + tectonic, and it calibrated FIRST TRY
   (stagger landed at 75/100 automatically). Tests: clothing.test.ts
   (compiled shape, the aggregate growth probe, the street pickup) —
   129/129. Remaining seams named in world-content §3e: charter attrs
   still sampled in tri.ts (not content `resources`), hall/market
   structural, fields anchor to the literal "farm".*
   **JSON milestone (same day)** — content now loads from ACTUAL
   EXTERNAL FILES: `parseEconomyDoc` (economy-json.ts) shape-checks
   unknown JSON with path-exact errors and rejects unknown fields
   (typos fail loudly); compileEconomy gained the author-error pass
   (duplicate keys within a doc, unknown stockpiles/commodities/
   producers, shelved-without-sells, and a REFERENTIAL SCALAR CHECK —
   every process/sum/allocate/flownet reference must resolve to an
   economy var or a structural scalar, so a typo'd "timberlnd" fails
   at compile naming the def, not at runtime as a silent 0). The
   clothing chain moved to `src/content/clothing.economy.json` with
   economy-clothing.ts as the loader shim — byte-identical behavior.
   `TriBaseOpts.extraContent` is the mod seam; genesis/tectonic accept
   extra docs and the LAB grew a "Custom content" file input (parse →
   dry-run compile against the full stack → reboot with the mod; a bad
   file reports its error and changes nothing). Browser-verified
   end-to-end: an ale+brewery mod file dropped onto the live genesis
   world loaded as the FOURTH street good (slot 3, the last box
   corner; stagger extended to 130 automatically), and a broken file
   reported `process "distill" references undeclared scalar
   "grain_owt"` — no exceptions, nothing applied. Tests:
   economy-json.test.ts (both gates + the ale compile) — 134/134.*
6e. ✅ **DONE (2026-07-08) — Species as content** (sapient, domestic and
   commensal populations defined in the generator documents; full
   design in world-content.md §3f).
   *Landmarks: PopuSim `applyVitals` gained an optional TRAIT SCOPE
   (the applyTraitFlip-siteKey precedent) — snapshot, apportionment and
   clamps see one species' carriers; hereditary species traits keep
   births inside the scope. `coupling.vitals` became `VitalsSpec |
   VitalsSpec[]` (per-spec diet scalars + per-(spec, site) carries +
   pen-cap headroom on births); bare-object legacy form bit-identical.
   CIVIC ACCOUNTING: `coupling.civicTraits` scopes the population
   write-back (and with it tiers, strength, capacity anchors, houses)
   to sapient carriers; `dual.civicPop()` is the checks' new contract;
   migration still moves ALL pops uniformly (herds travel with their
   people — colonist flocks for free). COMPILER: `SpeciesDef`
   {role, needs, vitals(diet/capacity), civic, foundingShare,
   countScalar, capacity/growth} → trait defs (human implicit,
   demand = the commodity rows), vitals array (human first — the
   planner models index 0), civicTraits, traitInputs count scalars,
   commensal var+cap-process+`toward` rule; `citizenStartpop` emits
   INTEGER startpop weights (PopInit parses size via intVal — a
   fractional weight floors to 0 and 0/0 NaN-poisons the whole site;
   found by probe). CONTENT: sheep joined clothing.economy.json
   (fodder diet — farms OVERRIDDEN cross-doc to cut hay, the goods2
   metal mechanism; wool now shorn from `sheep_count`, graze anchored
   to the fold; herd logistic under perUnit-100 pens, equilibrium
   cap × (1 − d/b) — birth 0.06 lifts the plateau to ⅔); rats shipped
   in content/wildlife.economy.json (cap 2% of civic pop, growth
   0.05/day) with night-scurry ambient rendering (inverse day curve)
   and a fauna line in the city-view overview. Genesis/tectonic found
   with the species mix and run wildlife. Probe lesson: the founding
   flock STARVED before pens existed until farms cut hay from day 0 —
   sequence is the mechanism, again. Tests: species.test.ts — compiled
   shapes, author-error gates, integer startpops, and the load-bearing
   DIFFERENT-NEEDS proof (fodder famine kills the sheep and only the
   sheep while civic humans grow; total-souls ledger exact throughout).
   141/141 + 127/127 popusim.*
6f. ✅ **DONE (2026-07-08) — Wild fields: every people pools on its own
   land** (the seam 6e named; full design in world-content.md §3f).
   *Landmarks: `SpeciesDef.wild {field, habitat, scale}` +
   `wildSubstrate` (economy.ts — grows the substrate SystemSpec one int
   var + one logistic `toward` per species, the `people` pattern;
   unknown habitats fail at build); tri.ts harvests EVERY wild field in
   the founding box (`harvest` → {total, mix}) and scouts candidates
   per species field (best score founds, ties by species order);
   `autoFound.cityFactory` gained the harvested `mix`, and
   `harvestStartpop` founds with the actual demography — sapient
   weights are the grid persons taken, herds ride proportionally on
   top, empty mixes fall back to declared shares. `gridPeople()` sums
   all wild fields. DWARVES shipped as content
   (content/dwarves.economy.json): sapient, civic, DIFFERENT needs
   (2× human metal demand), `dwarf_count` scalar, wild field pooling
   on the ore (scale 2) — amber-gold tint beside the humans'
   warm-orange in the substrate render. Genesis/tectonic run them.
   PROBE LESSONS: at scale 3 dwarven ridge crowds outranked the
   valleys and founded farmland-0 metropolises (23k souls) whose
   structural food deficit pinned the whole component's fill below 1 —
   which STARVED CONSTRUCTION component-wide (granary drift is the
   component surplus mean; the fed transient never returns once a
   permanent sink joins). The first-founded camp (no road partner)
   starved to a pop-0 ghost. SEQUENCE IS THE MECHANISM, again — the
   colonize path works because camps join built-out valleys small and
   funded. Dwarves ship at scale 2 (below the valley founding floor);
   the named next frontier: founding-size caps (found-small applied to
   the harvest), import-aware founding gates, or mountain subsistence.
   Also: tri.test's step-1 arc now tracks the first FARMLAND-majority
   city (a first-founded ridge camp may honestly die), and a fat mixed
   harvest may found straight into the "town" tier — small is about
   the STOCK, not the crowd. Tests: species.test.ts wild suite
   (substrate growth, harvest-mix startpops, the mixed ridge founding
   with valley bread over the road, civic + conservation). 144/144.*
   **Harvest cap (same day)** — found-small applied to the CROWD:
   `founding.maxHarvest` (FoundingOpts; FOUNDING carries 600 grid
   persons = 15k souls, the village band). The scanner still gates and
   ranks by full density; the harvest takes at most the cap,
   apportioned largest-remainder across species (proportions kept,
   ties by species order), residue left WILD to regrow and gate later
   foundings. Planner mirrors `min(density, cap)` — §3c agreement
   exact. Single-species boxes top out ~470 < 600, so every calibrated
   arc is byte-identical; only stacked mixed boxes trim. tri.test's
   village-tier assertion RESTORED (a fat mixed harvest founds a
   village again). The cap bounds a farmless sink's SIZE, not its
   existence — import-aware gates / mountain subsistence still open.
   **Clothing made REAL (same day — lab-observed fixes)**: the user
   watched genesis and saw sheep vanish, no fodder anywhere, and two
   house crates that never fill. Root causes: (1) flock survival was
   PEN-capped and pens arrive at industry tier day 40+ if ever — the
   founding flocks died first almost everywhere. Sheep capacity
   re-anchored to FARMS (perUnit 60 — village flocks graze the
   farmland from day 0; sheepfolds are SHEARING capacity, which they
   already were via the graze process). Probe: every genesis city now
   holds its flock at the logistic plateau (7 farms × 60 × ⅔ = 280,
   exactly), fodder fill 1.00, CLOTH FILL 1.00 in every city. (2) the
   city view's Supply/Stockpiles/Buildings rows were HARD-CODED lists
   (food/metal/planks/tools) — fodder, wool, cloth and any modded
   commodity were invisible. Now registry-driven off the compiled
   economy (`CompiledEconomy.fills` from commodity transports,
   `.stockpiles` with panel names, buildings from works' countScalars)
   — a mod's supply bar appears the moment its ledger does; the ore
   bar joined honestly. Also OBSERVED, working as designed: tools fill
   DECAYS over centuries (0.68→0.12 by day 400) — mining depletion
   emptying the mountains is the long-arc event; and rats are pure
   decoration (a commensal stockpile-drain is a future content knob).
   **THE ENGINE CARVE (2026-07-08) — grand-dream becomes a composition
   root**: the platform direction is ONE ENGINE, ONE JSON, ALL GAMES
   (the AAC dialogue system eventually navigating full living worlds).
   First two moves shipped: (a) cell-systems moved wholesale from
   games/sandbox-game into `shared/engine/cells` (zero-dep, all aliases
   repointed, sandbox checks + this suite green); (b) the economy
   compiler + its JSON boot gate moved to `shared/engine/modules/economy`
   as the FIRST capability module (`ECONOMY_MODULE`), with grand-dream's
   `src/economy.ts`/`economy-json.ts` left as re-export shims so content
   packs and internal imports stay put. GoodSpec/VitalsSpec moved WITH
   the compiler (food.ts/dual.ts re-export them). The kernel is
   `shared/engine/manifest.ts`: a world document declares `uses`
   (capability keys — refused with the registered list if this build
   lacks one) and ordered `packs` whose sections route to their owning
   module's parse (path-exact errors; unknown sections rejected, never
   skipped). Pack order is composition order (cross-pack key override).
   The lab's content input now accepts BOTH a bare EconomyDoc and an
   `aivota-world` manifest (`isWorldManifest` envelope sniff).
   engine-manifest.test.ts proves the manifest path compiles to EXACTLY
   the hand-composed economy. Next carves (shared/engine/README.md):
   town module (popusim-free zoom/food town core), then demography
   (headless popusim slice) ONLY when a game needs it.

   **THE TOWN CARVE (same day)**: the street-scale town layer moved to
   `shared/engine/town/` — streets.ts verbatim (dependency-free),
   districts/city-districts, food.ts→goods.ts, and zoom.ts's town-plan
   half→plan.ts, all over the structural `TownHost` seam (host.ts:
   cities/charterOf/grid?/dual.settlementScalar — TriWorld satisfies it
   with NO adapter) plus an EXPLICIT compiled-economy parameter (which
   registry is the game's concern — grand-dream's zoom/food keep the
   pre-carve signatures as wrappers resolving `tri.economy ??
   DEFAULT_ECONOMY`, and keep the content: FOOD_GOOD/TOOLS_GOOD,
   defaultWorkClass, villageSeed). What stays in zoom.ts on purpose:
   vignettes, TownManager, embodied villagers, parties — everything
   reading NAMED residents (histfigs) is demography-module territory.
   Towns are byte-identical across the carve (all 154 pre-carve tests
   pin it). AND the payoff: `town-world.ts` — a STANDALONE living town
   (one settlement's books over a compiled economy, NO popusim): the
   composition layer's writes minimally replaced at day start (demand =
   primary species' per-head rows × population into the coupling's
   demand scalars, popScalar fan-in included; population = one
   Malthusian policy from eco.vitals[0], scarcity self-limits), the
   same idle-safety validator gating the spec, rest-jump via
   worldFastForward once books and population still. town-world.test.ts
   (159 total now): grows 60→600+ and builds to charter caps off the
   granary drift; an unseeded town starves honestly; a 5000-day absence
   is one leap; deterministic; townPlan + streetGoods project the full
   street town (food AND tools errands) with zero popusim imports. This
   is the world the symbol-learning game hosts.

   **THE GEOLOGY + CIV CARVE (2026-07-09)**: two more layers moved.
   (a) `tectonics.ts` → `shared/engine/geology/tectonics.ts` verbatim
   (it was import-free; the `bakeAuthors` → `prepareSubstrate` seam is
   the whole contract), shim left behind. (b) The civilization spine —
   `tri.ts`, `dual.ts`, `plan.ts` → `shared/engine/civ/` over a NEW
   structural seam, `civ/composition.ts`: `CompositionWorld` (aggregate
   reads + one day step) + `CompositionOps` (the raw day-boundary write
   channels — driven migration, vitals, trait flips, addSite/addRoute,
   the LIVE routes array — member names deliberately mirroring
   PopuSim's, so PopuSim satisfies it with ONE cast). WHICH backend a
   world runs is the game's concern (the town carve's law, one layer
   up): shared `bootDual`/`foundTri` take a `CompositionBoot` as an
   explicit parameter; grand-dream's `dual.ts`/`tri.ts` shims bind
   `bootLab` and keep the pre-carve signatures, `boot.ts` stays
   game-side as the whole PopuSim binding (`LabWorld extends
   CompositionWorld`). The planner moved whole (it never touched the
   composition layer). Content stays put: tri-worlds.ts, scenarios,
   economy packs, civ-scrub/geo-scrub presenters. All 159 tests
   byte-identical across the carve. The demography module (README
   roadmap) is now PURELY a popusim extraction question — the civ
   machinery no longer knows popusim exists.

7. **Avatar-scale war/colony presentation** — only when zoom-in gameplay
   wants it.

Steps 1–4 make the live sim honest to the arc; 5–6 make deep history
affordable. They are independently shippable in that order, and 1–4 are
prerequisites for both providers (§2 preamble).

---

## 7. Open questions (all answered 2026-07-07; decisions folded into the body)

- ✅ **RESOLVED — Tombstone reclamation**: YES. A wild crowd or a colony
  can re-found on a ruin, inheriting its street tree as the new plan's
  prefix; the charter is re-sampled fresh (the land may have changed).
  Folded into §2b.
- ✅ **RESOLVED — Merge vs conquest overlap**: YES — one `absorb(loser,
  winner, mode)` transaction, two triggers (economic stall / military
  victory), two modes (physical / political; conquest of a village takes
  the physical mode). Folded into §2b + §2d.
- ✅ **RESOLVED — Strength ingredients**: v1 drives strength from ORE
  PRESENCE and POPULATION (`ore_access` charter scalar — steadier than
  metal flows); fortifications and tech growth are the intended later
  channels. Folded into §2d.
- ✅ **RESOLVED — War exhaustion / peace**: hostility generally declines
  (and a failed siege cools it faster), BUT matched civs may stabilize
  into a designed STALEMATE regime — continuous border skirmishes
  draining populations and resources as fast as they are produced,
  borders frozen until outside disruption or a tech breakthrough shifts
  the ratio. Tied to civilization VALUES traits (warlike raises
  hostility accrual, pacifist raises decay). Folded into §2d as the
  third war outcome.
- ✅ **RESOLVED — Event-stream clock**: CUMULATIVE BIRTHS (strictly
  monotone through collapse; live population rewinds). Folded into §3b.
- ✅ **RESOLVED — How much politics the closed form can claim**: decide
  empirically — build §3c's agreement test and measure; no architectural
  commitment.
- ✅ **RESOLVED — Population floor for the wild field**: NO floor, no
  reserve. The wild population is transitional by design and effectively
  disappears once civilization has claimed all available land; the empty
  frontier is the signal that growth must continue through merge,
  colonization, and conquest. Folded into §2c.
