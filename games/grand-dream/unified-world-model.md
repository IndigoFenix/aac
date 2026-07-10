# Unified Game World Model

How the civilization simulator (civilization.md), the learning-world generator
(brainstorming.md), and our existing engines compose into one world that the
player can zoom through — individual → party → tribe → civilization — without
era breaks.

The core claim: **we do not need a new engine.** We need a layered composition
of four engines we already have, plus a few well-defined extension points. Each
layer owns one scale, each is data-driven ("define by what it does"), and the
layers exchange information only at fixed boundaries so their guarantees
(determinism, idle-safety, closed authoring schemas) survive composition.

**Ultimate goal:** this layered model becomes the *foundation of the world in
`shared/world-engine`*. A world-engine scene is not a standalone level — it is
a projection of grand-dream state (terrain patch from the Substrate, buildings
from Settlement scalars, NPCs sampled from Composition, quests from goal-tree
content over all three). The world the student walks through at avatar scale
and the civilization simulated above it are the same world.

---

## 1. The four layers and who owns what

| Layer | Engine | Owns | Idle-safety |
|---|---|---|---|
| **Substrate** | cell-systems integer grid (`sandbox-game/src/cell-systems/grid.ts`) | Terrain: height, water, rivers, plants, fertility. Topology (square/hex/wrap; sphere later). | Idle-safe, structural |
| **Settlement** | cell-systems EntityWorld (`entities.ts`) | WHERE people are and gross quantities: settlement population counts, goods, roads, hostility/war. | Idle-safe, structural |
| **Composition** | PopuSim (`games/popusim/`) | WHO the people are: what fraction of each settlement carries which traits — culture, ideology, tech, religion, health, civ membership. | Deterministic; cheap per-day; NOT sub-linear (see §5) |
| **Individual** | world-engine (`shared/world-engine/`) + goal-tree (`shared/goal-tree/`) | The player, party members, histfigs, NPCs, dialogue, quests, live 3D play. | Idle-unsafe by nature; live-only |

Naming hazard: "WorldSpec" currently names both the cell-systems civ schema
(`cell-systems/spec.ts`) and the spatial avatar schema (`world-engine/types.ts`).
These are different layers of this model. When we start integrating, rename one
(suggest `CivWorldSpec` for the cell-systems one).

### Why split Settlement from Composition?

Cell-systems Step 3 already simulates cities, trade, war, and roads idle-safely,
and its stated end goal ("one unified integer grid ... cities ... borders that
stabilise") points at the same dream. But its guarantees come from a hard rule:
conservative/dissipative scalars only, no 3+ mutually-coupled variables. That is
the right algebra for *quantities* (people, goods, hostility) and the wrong
algebra for *composition* (a thousand interacting binary traits — precisely the
thing PopuSim's syndrome/vector machinery is optimized for, GPU kernels,
trait-clustering and all).

So: **cell-systems moves scalars between places; PopuSim mutates the trait
makeup within each place.** A settlement's `population` scalar (cell-systems)
and the sum of its PopuSim Populations refer to the same people; §4 defines how
they stay consistent.

This also honors Victoria vs Dwarf Fortress: the Settlement layer is the
Victoria-style production/flow model; the Composition layer plus histfigs (§6)
is the DF-style "pops carry ideas, individuals emerge from pops" model.

---

## 2. Everything is a trait (mod-friendliness)

civilization.md: *define objects by what they do, not what they are.* Both core
engines already speak this idiom natively; the modding surface is scenario
JSON, not code:

- **Technology** = a Trait spread by education/contact Vectors, possibly gated
  by a Resource (literacy, tools). Its *effects* are its Modifiers (×1.3 farm
  production) and Impacts. There is no tech tree object; prerequisite chains
  are just Seek/gating on prior traits.
- **Ideology / religion / culture** = Traits with Transmits (proselytizing),
  ContactModifiers (resistance), and cure-vectors (suppression). Breakaway
  mechanics fall out of this — §7.
- **Government system** = a Trait *bundle* on the ruling structure: its meaning
  is entirely its modifier set (tax efficiency, war exhaustion, idea
  transmissibility). Swapping government = a membership-trait transition.
- **Civilization membership itself** = a Trait (`member_of:X`). PopuSim already
  has the machinery for membership traits that move units between clusters
  (the C2b work). A "civilization" is not an object; it is the set of people
  carrying its membership trait, plus a small ledger (name, color, capital).
- **Settlement behaviors** (growth, trade appetite, road formation) = cell-systems
  rules in the civ spec, validated for idle-safety by `world-validate.ts` —
  a mod that breaks the guarantees is *rejected at load*, not debugged at runtime.
- **Health-related systems** = It's an obvious application, but avoid it for now.
  Focus on ideologies as the prototype for trait spread.

This mirrors seagull-dream's "regimes, not classes" principle: a city is a
settlement whose population crossed a threshold; a civilization is a tribe
whose membership trait spans multiple settlements. Nothing is reclassified;
thresholds just change which UI and which dynamics are active.

---

## 3. Topology: sites are graph nodes, shape is a renderer concern

- PopuSim Sites have **no coordinates and no adjacency** — they are pure
  compartments. Good: they inherit whatever topology we hand them.
- cell-systems already isolates topology in `neighbours()` (square + wrap done;
  hex noted as renderer-work-only; a sphere is a geodesic grid = mostly-hex).
- The **Settlement graph** is the shared skeleton: each settlement is
  simultaneously a cell-systems entity (position on the substrate, edges =
  routes) and a PopuSim Site (trait composition). Flat grid, hex, and sphere
  are substrate choices; the two sim layers only ever see nodes and edges.

### Scalars vs integers (engine-wide principle)

cell-systems supports both scalar and integer-only systems, and the trade is
general: **scalars are more accurate; integers make idle-safety easier**
(crisp rest, no ε-tail). One real integer tail existed and was fixed
2026-07-06: a sub-unit `toward` step rounded away at commit, so decaying int
vars rested ONE SHORT of target — ghost fertility/vegetation that never
cleared off re-routed riverbeds. `intTowardStep` (grid.ts) promotes the
tail step to a whole unit; grid check #25 (dammed river) is the regression. The rule for this model: integer variables are the
*baseline for idle-safe profiles* (§5); scalar variables are freely available
in idle-unsafe worlds where accuracy and depth win. A generated world's
profile decides, not the engine.

## 4. The extension points (the only engine work)

Three real gaps were confirmed by code survey and design review; everything
else is composition.

### 4a. Cross-site transmission in PopuSim ("routes channel")

Today a Shed lives and dies inside one Site — ideas cannot travel. Extension:
a **Route** carries a fraction of a Site's outbound Sheds to neighboring Sites,
weighted by route strength (read from the Settlement layer's road attribute at
the day boundary). Implementation shape: at `Site.updateTransmission`, a
Transmit flagged `ranged` splits its Shed across `[self] + routes` — reusing
the existing PendingTransmission queue on the receiving site, so
order-independence and the snapshot/delta model are untouched.

### 4b. Migration = uniform cross-site unit movement

When the Settlement layer's `exchange` moves population between settlements,
PopuSim must move units between the corresponding Sites. Move them
**proportionally by syndrome** (uniform sampling of the source site). This is
exactly the uniformity condition the C2b clustering work already requires for
membership changes, so the factored evolver stays valid. Non-uniform migration
(only the persecuted leave) is expressible later as a Seek-weighted variant —
at the cost of forcing a cluster merge, which the machinery already handles.

### 4c. Steady-state flow networks (the unperfected idle mechanic)

The missing cell-systems primitive for a *living-feeling* idle economy: a
network of resource **generators and consumers that balance out**, so
resources visibly "move" while the worldstate is static. Today's primitives
settle to rest (transport equalizes, budgets drain) or ride a clock; rivers
solved the special case — `VarSpec.flow` computes flow-accumulation as a
static field, recomputed only when terrain changes, zero per-step cost.

The extension is that idea generalized: solve the settlement graph's
production/consumption/route network for its **steady-state flow field**
(who ships what to whom, at what rate), store it as a read-only derived
field, and recompute only when the network changes (new road, settlement
grown a tier, war severs an edge — all day-boundary events). Between
recomputes the flow is constant: idle-safe by construction, and it is what
makes a settled world look busy — caravans on roads are a *render* of the
flow field, not simulated agents. Imbalances (production ≠ consumption after
solving) become slow stockpile drifts, which are ordinary convergent
variables. This is the Victoria-style economy in idle-safe form.

### The coupling contract (day boundary only)

PopuSim already locks player actions at the top of each day. Generalize that:
**all cross-layer reads happen at the day boundary, one direction per pair:**

- Settlement → Composition: migration flows (§4b), route strengths (§4a),
  war casualties (uniform removal — again the C2b-supported shape).
- Composition → Settlement: aggregate trait fractions enter as *external
  inputs* to entity rules (e.g. rebel fraction scales the production budget
  down, tech fraction raises a cap). External inputs are the sanctioned
  channel in the cell algebra — they may raise budgets because they are
  bounded by the other layer's own conservation.
- Substrate → Settlement: fertility/river sensors (already the plan).

One-day lag in each direction, matching PopuSim's existing lock-in semantics
and cell-systems' event scheduling. No intra-day feedback loops between layers
⇒ the coupling-dimension analysis of each layer remains valid on its own.

---

## 5. Idle-safety: a constraint profile, not a design ceiling

Idle-safety is a **selectable profile that a generated world validates
against, never a limit on what the engine can express.** Idle-unsafe worlds
get full simulation depth — scalar dynamics, dense feedback, per-tick
individual behavior — with no compromises made on their behalf. The engine's
job is to *define the rules*: which primitives, variable kinds, and coupling
shapes an idle-safe world may contain, enforced mechanically at load
(`validate.ts` / `world-validate.ts` / a scenario linter for the Composition
layer), exactly the way cell-systems already rejects a 3-loop. Depth in one
profile and guarantees in the other are separate products of the same engine.

What the idle-safe profile can promise differs per layer:

- **Substrate + Settlement: truly idle-safe.** Structural guarantees, rest-jump
  + period folding, already tested (catch-up == stepping).
- **Composition (PopuSim): deterministic and cheap, but linear in Δt.** The
  factored evolver slashes the per-day constant; it does not change the
  asymptotics. Three-tier answer:
  1. **Short absences** (hours–days of sim time): just step. Per-day cost with
     clustering is small; this is fine.
  2. **Rest detection**: many trait dynamics converge (epidemics burn out,
     ideologies saturate). When every site's composition delta falls below ε
     with no armed events, mark the composition layer AT REST and skip it
     entirely until an external input (settlement flow, event, player) wakes
     it. This mirrors cell-systems' active-set scheduler and will cover most
     long idles in practice.
  3. **Idle-safe mode** (the accuracy sacrifice civilization.md allows):
     freeze composition dynamics entirely while away; only Substrate +
     Settlement advance. On return, composition resumes from where it was.
     The world visibly lived (cities grew, roads wore in, wars cooled) even
     though the ideological weather paused.
- **Individual layer: live-only, by design.** Parties and dialogue only run
  when the player is present. On leave, the party is parked (§6) and the world
  above keeps moving.

A generated world declares which tiers it uses in its profile; the validators
enforce what "idle-safe: yes" is allowed to contain. The steady-state flow
network (§4c) is the key upgrade here — it lets the idle-safe profile *feel*
alive (goods moving, roads busy) without simulating motion.

---

## 6. Scale transitions: aggregation and sampling

The Spore requirement — no era breaks, focus expands and contracts — becomes
two operations between adjacent layers.

### Zoom out (aggregation)

- Party members and notable NPCs become **histfigs**: persistent named
  individuals with a home Site and a role. Histfigs live *outside* PopuSim's
  accounting (they are subtracted from their home Population's count) and —
  unlike Populations — carry **scalar traits, not binaries**. Where a
  Population is 60% devout or 30% literate, a histfig has `devout: 0.74`,
  `literate: 0.2`: scalars **generated from the trait proportions of their
  civilization** (sampled around the local prevalence, with individual
  variance). This is the natural bridge between the layers — aggregation bins
  a scalar back to "carries the trait / doesn't" by threshold or probability,
  and sampling (below) draws scalars from prevalences. It is also
  civilization.md's "individuals may vary from their civilization's norm,"
  stated mechanically.
- The anonymous crowd aggregates: N followers with trait set S become
  `Population(syndrome=S, pop=N)` at the local Site. Founding a settlement =
  creating the entity (Settlement layer) + the Site (Composition layer) in the
  same day-boundary transaction.
- Thresholds are soft (regimes, §2): individual tracking below ~tribe size,
  aggregate above, histfigs tracked at every scale. This is exactly
  civilization.md's "party expands into a tribe ... tribe becomes a
  civilization once individual tracking becomes unfeasible."

### Zoom in (sampling)

- DF-style: individuals at the zoomed-in scale are **drawn from the local
  Site's syndrome distribution**, seeded deterministically — reuse `HashRand`
  keyed by `(worldSeed, siteKey, syndromeKey, index)` so the same villager
  exists every time you visit, without storing anyone. A sampled individual's
  scalar traits are drawn around the Site's trait prevalences (the same
  proportion→scalar bridge histfigs use), so a village that is 80% devout
  produces mostly-but-not-uniformly devout villagers.
- A sampled individual the player interacts with meaningfully gets **pinned**
  (promoted to histfig); everyone else evaporates back into the distribution.
- The zoomed-in scene itself is a world-engine WorldSpec generated from local
  state (terrain patch from the Substrate, buildings from Settlement scalars,
  NPCs sampled as above), with goal-tree content projected into it — the
  brainstorming.md Sandboxes/Challenges model gives the scene its structure,
  and the learning templates give it its curriculum payload.

### Histfig influence (the DF story generator)

A histfig acts on the aggregate world through the **PendingTransmission
pipeline — the exact mechanism PopuSim player actions and events already
use.** A charismatic ruler is a transmitter of her ideology trait, with shed
value scaled by her `charisma` scalar; a great engineer sheds a tech trait;
an assassinated king is an Event.
The player-as-ruler is then literally a PlayerAction set: no new machinery,
and every influence a histfig can have is moddable data.

---

## 7. Breakaway and downscaling (the thing Victoria can't do)

Because a civilization is a membership trait (§2), breakaway needs no special
system:

1. A dissenting ideology trait spreads through some region's Populations
   (ordinary vector transmission, boosted by contact with a neighboring civ's
   routes — DF's "influenced by civilizations they interact with," but driven
   by actual contact flows instead of a table roll).
2. The trait-clustering machinery (C-series) or a correlation Trait detects
   when the dissenting bloc has become a coherent, near-independent factor of
   the population — a statistically real faction, not a scripted one. This is
   a genuinely better breakaway criterion than DF's, answering
   civilization.md's "this mechanism might not be as accurate as it could be."
3. A threshold Event fires: a new membership trait `member_of:Y` cures
   `member_of:X` across the dissenting syndromes; the Settlement layer gets a
   new ledger entry and a hostile edge. Downscaling is the same flow at lower
   population: a breakaway *tribe* is small enough to re-enter individual
   tracking, and the player can be in it — or lead it.

The reverse (absorption, federation) is the same operation with the membership
cures pointed the other way.

---

## 8. Oregon Trail mode: the caravan is a mobile Site

A traveling party above individual scale (wagon train, migration, army on the
march) is modeled as a **Site with local Stockpiles attached to a moving
position on the route graph.** Food, morale, illness (a Trait spreading inside
the caravan!), and members-as-Populations all work unmodified; arrival merges
the caravan Site into the destination (an aggregation transaction, §6).
Travel itself is a Challenge-type area in brainstorming.md's sense — a
constrained A→B path with resource management — and doubles as the transport
mechanic between zoomed-in scenes. Live play is idle-unsafe; an idle variant is
a clock-driven journey with events resolved on return.

---

## 9. Build order

Each step is independently shippable and testable against an engine that
already has a test culture (PopuSim determinism tests, cell-systems
catch-up==stepping checks).

1. ✅ **DONE — Routes channel in PopuSim** (§4a) — smallest engine change,
   biggest unlock: ideology/tech/rebellion spread over a multi-site map. Test:
   two-site scenario, spread arrives with route-proportional delay;
   order-independence suite still green.
   *Landmarks: `popusim/src/game/world/Route.ts`, `popusim/src/__tests__/routes.test.ts`
   (`npm run test:popusim`), browser harness `games/grand-dream` (Routes Lab).*
2. ✅ **DONE — Shared node graph**: run EntityWorld and PopuSim over the same
   node set with the day-boundary contract (§4) — migration and trade→route
   coupling. Test: population conservation across both layers; dual-layer
   determinism.
   *Landmarks: `grand-dream/src/dual.ts` (`bootDual` — the whole §4 contract:
   trait-fraction inputs → settlement step → flows→driven migration → integer
   write-back → roads→route strength → PopuSim day);
   `World.applyExternalMigration` in `popusim/src/controller/World.ts` (exact
   counts, uniform by syndrome, largest-remainder — no RNG);
   `EntityWorld.lastFlow` in `sandbox-game/src/cell-systems/entities.ts`
   (signed per-edge exchange flows); tests
   `grand-dream/src/__tests__/dual.test.ts` (`npm run test:grand-dream`);
   the lab's "DUAL — trade builds roads" scenario shows it live. The
   migration bridge applies the integer rest rule (move only while gap ≥ 2)
   so an equalised graph reaches crisp rest. Note: in a dual world the
   settlement population scalar may change ONLY via exchange — write-back
   erases anything else; births/deaths are a Composition-side channel
   (future step).*
3. ✅ **DONE — Rest detection for composition** (§5 tier 2) — the idle story
   becomes real. Test: converged scenario fast-forwards in O(1), matches
   stepping.
   *Landmarks: `World.isCompositionAtRest()` / `World.skipDays(n)` in
   `popusim/src/controller/World.ts`. A completed day is a proven fixed
   point only when ALL hold: zero expected deltas (Σ|PhaseDelta amounts|,
   instrumented in `applyPhaseDelta`), zero realized pop/stockpile change
   (day-start snapshot diff), cross-site queue identical to yesterday's,
   no shed aimed at anyone it could still change (latent-conversion check
   in `Site.updateContact` — required because the WASM contact path
   pre-rounds sub-unit expectations with DAY-keyed draws, so a
   realized-zero day proves nothing), no fractional rate-migration
   (same day-keyed-rounding reason), all events spent (armed events can
   read `age`/`random`), no RAND-token metrics (daily serial-RNG
   consumers). From such a day skipping is bit-equivalent to stepping —
   including post-wake behavior, since all stochastic draws are keyed by
   (seed, day, …) and skip advances `age`. History rows are not written
   for skipped spans (graphs gap; history-window consumers are excluded
   by the event guard). `world.rest_eps` (default 0 = exact) is the
   sanctioned accuracy dial. Driven migration marks the observation dirty
   (`markCompositionDirty`). Dual layer: `DualWorld.advanceDays(n)` +
   `isResting()` in `grand-dream/src/dual.ts` — steps live until BOTH
   layers rest (settlement: last step changed nothing, no armed timers,
   no clocks), then jumps the remainder O(1). Tests:
   `popusim/src/__tests__/restDetection.test.ts` (7) + dual rest suite in
   `grand-dream/src/__tests__/dual.test.ts`.*
4. ✅ **DONE — Steady-state flow networks** (§4c) — the idle-safe economy:
   solve the settlement network for its static flow field, recompute on
   day-boundary topology changes. Test: solved flow conserves;
   recompute-on-change only; drift stockpiles converge.
   *Landmarks: `FlowNetSpec` in `cell-systems/spec.ts`
   (`{id, source, demand, by?, drift?}` on `WorldSpec.flownets`); solver +
   step integration in `cell-systems/entities.ts` (`solveFlowNet`,
   `EntityWorld.flowNet[id]` = flows/residual/potential/recomputes).
   Electrical-network model: potentials solve the conductance-weighted
   graph Laplacian L·φ = s̃ per connected component (s̃ = supply−demand
   minus component mean), flows f_e = c_e·(φ_a−φ_b) — supply spreads over
   all paths ∝ conductance. Inputs are fingerprinted each step; the solve
   runs ONLY when source/demand/conductance changed. The removed component
   mean is the uniform per-entity `drift` (through the ordinary own-delta
   pipeline: bounded var, linear until clamp ⇒ still settles; balanced
   networks drift nothing and cost nothing). Severed edges (conductance 0)
   partition the economy into local components. `RoadSpec.use` may name a
   flow-net id — caravans wear in roads. Validator checks refs and feeds
   the net's read→drift/road edges into the coupling analysis. Rendering:
   `DualWorld.settlementFlow(edge)` + the lab's marching-dash caravans
   (drawn every frame FROM the field — the resting world visibly moves).
   Tests: entities-checks #10–15 + dual "stabilise in motion" suite.*
5. ✅ **DONE — Membership traits + breakaway events** (§7). Test: seeded
   dissent scenario secedes deterministically; clustering detects the
   faction before the event fires.
   *Landmarks: scenario-level `breakaway` section parsed by
   `popusim/src/controller/World.ts` (`{key, dissent, from, to, threshold,
   coherence}`), evaluated each day after phases. Detection =
   `World.measureFaction(dissent, from)`: bloc size (fraction of
   from-carriers with dissent) + territorial coherence (cross-site
   dissimilarity index ∈ [0,1] — diffuse grumbling ≈ 0 never secedes at
   any size; a regional bloc ≈ 1 does). This is the "correlation" arm of
   §7's detector; the C-series factorization residual can join later as a
   within-site entanglement criterion. The flip =
   `World.applyTraitFlip(where, apply, remove)` riding
   `Population.transferTo` (extracted from applyDeltaShift — the C2b
   same-site membership primitive; wholesale moves are trivially uniform).
   Breakaway conditions read ONLY composition state, so an armed breakaway
   cannot newly fire at a fixed point — no rest guard needed, skips stay
   exact, and a seceded world rests again. Dual:
   `coupling.civs` (ledger = derived from membership counts;
   `DualWorld.civs()/civOf()`), `coupling.breakawayHostility` raises the
   settlement hostility attr on every majority-civ border edge when a
   breakaway fires; the lab rings nodes in civ colors and the flagship
   scenario runs the whole arc (separatism → secession → border war wears
   the road down → cools → caravans return → rest). Tests:
   `popusim/src/__tests__/breakaway.test.ts` (5) + dual step-5 suite.*
6. ✅ **DONE — Histfig layer** (§6): scalar-trait individuals bridged to
   prevalences, pinning, deterministic sampling, influence via
   PendingTransmission.
   *Landmarks: `World.sampleIndividual/pinHistfig/releaseHistfig/
   histfigShed` + `Histfig`/`HistfigSample` in
   `popusim/src/controller/World.ts`. Sampling: syndrome drawn by a
   HashRand-weighted pick over the site's living populations, keyed
   (world seed, siteKey, index) — the same villager (name included, via a
   deterministic syllable generator) exists every visit with ZERO storage;
   the draw shifts only when the composition itself shifts. Scalar bridge:
   per non-combo trait, mix = (u + prevalence)/2; carriers get 0.5+0.5·mix
   (devout villages breed fervent devotees), non-carriers 0.5·mix (pulled
   toward the fence by peer pressure) — so threshold-0.5 binning returns
   an untouched histfig to EXACTLY their origin syndrome. Pinning removes
   one person from the aggregate accounting: the invariant becomes
   Σ pops + histfigs = constant (the lab's conservation check knows).
   Influence rides the PendingTransmission pipeline literally —
   `histfigShed` enqueues on `site.shed_pending_phases[0]` (a raw
   site.shed deposit would be wiped by the day-start history reset),
   optionally scaled by one of the histfig's own scalars. Histfigs are
   rest-compatible: inert while idle, and a shed marks the composition
   dirty. Dual passthroughs: `sampleVillager/pinHistfig/releaseHistfig/
   histfigShed/histfigs/histfigCount`. Not yet built: role-driven
   AUTOMATIC influence (a ruler shedding every day as scenario data) and
   histfig lifecycle (aging/death events) — natural step-7 companions.
   Tests: `popusim/src/__tests__/histfig.test.ts` (5) + dual step-6 suite.*
7. ✅ **DONE (scene + party; goal-tree payload pending) — Zoom-in play**:
   generate a world-engine scene + goal-tree content from local state;
   party aggregation/parking. This is where the model starts serving as
   the world-engine's world foundation.
   *Landmarks: `grand-dream/src/zoom.ts` — `generateScene(tri, siteKey)`
   builds a REAL world-engine WorldSpec from the three layers (Substrate
   patch → manifold/ground-color/cliff walls; Settlement scalars →
   hall/farm/mine/smelter BuildingSpecs ringed round a plaza; Composition
   → `sampleVillager` NPCs, so the same named villagers exist every
   visit), certified through the engine's own `certifyWorldSpec` gate
   before it leaves the module. Deterministic: same world state + seed ⇒
   byte-identical spec. Party (§6 aggregation, minimal arc):
   `recruitVillager` pins an engaged villager (histfig — Σ pops +
   histfigs stays constant, the lab's ledger check watches it),
   `parkParty` on leave (histfigs already live outside the accounting —
   parking just remembers where), returning regenerates the scene with
   members as `approach_nearest` followers, `disbandParty` rebins
   everyone (threshold-0.5 → exact origin syndrome). The lab RUNS the
   scene: click a city (no sculpt tool active) → overlay with
   `runWorldHost` + the stock `createWorld2DView`, single-player,
   pointer-to-walk, proximity-driven recruit/disband buttons; the
   aggregate world keeps ticking behind the overlay. NOT yet: goal-tree
   content projection (the world-engine's ContentSpec still reserves
   `kind:"goal-tree"` — the seam is `ZoomScene.spec` when it lands),
   follower CROWDS (N anonymous followers → Population — deferred to §8
   caravans, it's the same aggregation transaction), and in-scene actions
   that feed back upward (histfigShed exists; the scene UI for it
   doesn't). Tests: `grand-dream/src/__tests__/zoom.test.ts` (3):
   certified deterministic scene, charter-driven biome (Kragholm reads
   as a mining town), recruit→park→return→disband ledger arc.

   **The SEAMLESS WORLD (one scale, no village boundary — reworked same
   day):** the whole substrate is ONE manifold at ONE scale
   (`WORLD_TILE` — every grid tile is a walkable region), and walking
   out of a village simply continues: village content streams in CHUNKS
   around the player and unloads behind them. What keeps a map-sized
   world under the engine's per-spec caps is that the spec carries
   nothing local — `generateWorld` (zoom.ts) emits only the full-map
   manifold + one spawn per city (spawn id = city key → `spawnIndexOf`)
   + party followers; everything else arrives through three seams:
   ① collision — `terrainConstraint(grid)` reads the LIVE grid per step
   (stone/deep water/major rivers block; grade-blocking deferred);
   ② rendering — the lab's `createWorldView` rasterizes the camera's
   window of the substrate each frame (`substrate-render.ts`, shared
   with the map) and draws loaded villages' building footprints +
   door notches (unloaded ones as faint markers); ③ inhabitants — the
   world-engine grew a RUNTIME STREAMING seam, `WorldHost.addNpc` /
   `removeNpc` (world-host.ts; additive, cap-enforced, broadcast like
   spec NPCs), and `createChunkManager` (zoom.ts) reconciles per frame:
   villages load within `CHUNK_LOAD_R`, unload past `CHUNK_UNLOAD_R`
   (hysteresis), villagers spawn nearest-first inside an NPC budget
   that leaves room for the party. `cityContent(tri, key, seed)` is the
   ONE deterministic per-village layout (buildings ring + sampled
   villagers), consumed by both the bounded scene sampler and the chunk
   loader — same village either way. Recruiting swaps the villager body
   for a follower IN PLACE via the streaming seam (no reload — the
   person falls in behind you). Leaving parks the party at the nearest
   settlement. Tests: seamless spec is terrain-free + deterministic;
   live-grid collision; chunk load/unload/hysteresis/budget +
   villager-id round-trip; headless runWorldHost addNpc/removeNpc.
   (The bounded `generateScene` remains as the certified §6 scene
   sampler + future goal-tree projection seat.)

   **Streaming polish + TRAVELER BANDS (same day, from playtest):** three
   fixes and a forward step. ① No visible pop-in: chunk radii moved past
   the camera's half-diagonal (`CHUNK_LOAD_R` 14 tiles / unload 17) so
   villages assemble off-screen; buildings are unbudgeted (only BODIES
   cost), villagers budgeted. ② Stable villagers: the budget REBALANCES
   nearest-village-first on every update (allocation follows the player,
   not load order — approaching a village hands it bodies even with
   others still loaded behind you), and a recruited villager is excluded
   for the session (they left the crowd — no respawn). ③ Villagers stay
   home: the world-engine's `NpcBehaviorSpec` grew `wanderRadius`
   (additive; waypoints tether to the SPAWN point — free-roam default
   unchanged for existing worlds where the manifold IS one place).
   **Traveler bands** (`traveler-bands.ts`): groups on the roads,
   handled as their own MOBILE SITE in miniature — the §8 caravan slot,
   simplified. They derive from the §4c flow field (goods flowing → a
   band each way; a worn quiet road → one band): position is
   `f(route, wall-clock)` — deterministic, storage-free, idle-safe, the
   marching-dash caravans embodied at eye level. Members are §6 samples
   from the ORIGIN site, index-offset above the resident range (a
   traveler is never also a square-stander). Bands render as road-dots
   at ANY distance (no popping — proximity only swaps the dot for
   bodies via `addNpc` + a road errand toward the destination;
   hysteresis + shared NPC budget with villages/party). NOT yet §8:
   no stockpiles, no in-band contagion, no population transfer (real
   migration stays on the day boundary) — a true caravan becomes a
   PopuSim Site attached to this same moving position, with these bands
   as its embodiment layer.

   **REAL-WORLD SCALE (same day, from review):** world units are METERS
   (the engine's avatar is 0.4 m radius walking 5 m/s), a substrate tile
   is a SQUARE KILOMETER (`WORLD_TILE = 1000`), and a site is the size a
   site actually is: `townPlan` (zoom.ts) lays a town out from its live
   scalars — houses = population / `HOUSEHOLD` (5) on closed-form ring
   lots (a 11k-person town ≈ 2,200 houses over ~400 m, sitting inside
   its tile), hall on the plaza, workshops on the outskirt ring, field
   patches beyond. Plans are PREFIX-STABLE: lot k's geometry is seeded
   by lot index alone, so population growth appends houses at the edge
   and never reshuffles the town the player knows. Streaming moved from
   village-granularity to HOUSE-granularity: town DATA loads within
   1.6 km (hysteresis 2 km), but BODIES are per-house — every house has
   a resident (`sampleVillager(site, houseIdx)`: same person at the
   same door every visit, zero storage), and each frame the manager
   picks the K nearest doorsteps within `PEOPLE_R` (240 m), K = the
   live NPC budget: walk down a street and these houses' people are
   out, the last street's went back indoors. Houses render the way the
   bounded scenes did — floor fill inside stroked WALLS with a DOOR gap
   — with LOD (sub-3-px houses become blocks; far zoom shows town
   markers) and a WHEEL-ZOOM camera (70 m street view ↔ 6 km overland),
   because the map is now genuinely enormous relative to a person.
   Engine change: `WORLD_MANIFOLD_MAX` 10 000 → 100 000 (pure schema
   sanity bound — nothing in the engine's math uses it; f64 is
   sub-millimeter at that range), admitting the 48 km acceptance
   landmass in one coordinate space. Traveler bands re-scaled to meters
   (embody at 400 m; sample index base 1 000 000, above any house
   index). The bounded `generateScene` is now explicitly a COMPRESSED
   VIGNETTE at `SCENE_TILE = 8` (real towns can't fit a 16-building
   spec) — still the certified §6 sampler and goal-tree seat. Later
   milestones may compress distances or hand the substrate to a
   planet-scale host (seagull-dream).

   **STRUCTURE STREAMING (same day, from review — "this is an overhead
   view of the SAME engine"):** buildings near the player are REAL
   world-engine structures again — blocking walls and doors that swing
   open — not view-drawn scenery. The engine grew its third streaming
   seam: `setWorldStructures(state, structs)` (engine.ts) +
   `WorldHost.setStructures` — collision, door auto-open, and rendering
   all read `state.spec.structures` LIVE, so the swap is one state
   write; door states persist across swaps for surviving ids (a door
   left open stays open) and reconcile otherwise. The town manager
   lowers every building within `STRUCT_LOAD_R` (100 m, unload 130)
   through the engine's own `buildingStructures` (the same lowering
   `expandWorldBuildings` uses for bounded specs) and re-sends on set
   change only. Beyond the radius, buildings render as roof fills; step
   closer and the walls are the engine's walls (the lab view draws
   structures exactly the way `render2d` does, door-leaf swing
   included). Camera floor dropped to the engine's own street span
   (`SPAN_MIN` 22 m; default 34 ≈ `FOLLOW_VIEW_SPAN`), so the closest
   zoom matches the old bounded scenes. Perf note: `structuresWalkable`
   scans linearly — the 100 m radius keeps it to a few hundred
   structures; a spatial index is the upgrade path if radii grow.

   **Streaming correctness (same day, from playtest):** three rules
   hard-won from visible artifacts. ① Bodies rank and cull by where the
   PERSON is, not where their house is (`update` takes the host's live
   avatar positions), and a body within `PEOPLE_EVICT_MIN` (60 m) of
   the player holds its slot — nobody standing next to you blinks out;
   new arrivals still step out of doors (diegetic), turnover happens
   off to the sides. ② The manager reconciles against HOST TRUTH every
   update: a body the host rejected (addNpc budget race — this was the
   "silent depopulated towns" bug: the ledger said spawned, the host
   said no, and it never retried) is forgotten and re-ranks. ③
   Disbanding keeps people standing: each follower body swaps in place
   for a FREED wanderer tethered where they stand (they rejoin the
   aggregate immediately via releaseHistfig), and once the player walks
   away the freed body is culled and `TownManager.restore` re-admits
   them to the streaming pool — return to their town later and they're
   back at their own door.*

   **Street food economy (2026-07-05, `src/food.ts`):** the first "what
   are all these people DOING" system — an individual-scale ADD-ON to
   PopuSim's abstract consume behavior (trait-declared `demand` →
   `food_need`; flow net → `food_got`; the same fill that gates vitals).
   No second ledger: one RATION ≡ one person-day of whatever the traits
   declared, and everything street-level is a closed-form function of
   (site scalars, house index, wall-clock) — pantry boxes in houses
   (refill to `fill × capacity`, drain linearly), a plaza MARKET in any
   town past `MARKET_MIN_HOUSES` (24 — farm-gate shopping stops scaling),
   per-house shopping cycles (home → source → home; source = nearest of
   market/farm gate, hall fallback for import towns), and market stock
   (the served share of the day's delivery, stocked at dawn, drawn down
   by evening). Inelastic S&D: demand never moves, supply is what
   arrived, so scarcity shows as emptier boxes and MORE FREQUENT trips
   (period ∝ fill), never as prices. Streaming integration: an unspawned
   resident's canonical position IS their cycle position (they rank,
   prefilter by door–source segment distance, and spawn mid-errand with
   the rest of the trip as waypoints + `behavior.home` anchoring their
   wander tether to their own house — a tiny additive engine seam), and
   embodied residents get a real `setNpcErrand` trip once per cycle when
   their box runs dry. Tests: `src/__tests__/food.test.ts` (5).*

   **Town streets + navigation (same day, `src/town-roads.ts`):** the
   fix for NPCs wedging into houses. Towns get an explicit ROAD NETWORK
   derived closed-form from the ring plan — a plaza ring at 22 m, a ring
   road in each 15 m inter-ring gap (at +7.5; lot jitter and house depth
   are bounded so every street center line is provably clear of every
   house corner), and four spokes down the cross-street corridors.
   `roadRoute` plans door-to-door paths that ride rings and spokes
   (cheapest of the four spokes, or a direct same-ring arc); ALL food
   errands use it, so shoppers walk streets, never chords through
   blocks. Houses FACE their nearest road (`doorFor`: cross-street
   flankers front the street, everyone else fronts the ring road on
   their plaza side) and doorsteps are door-edge-aware. The hall and
   market moved INSIDE the plaza ring (their old spots straddled the
   ring-road band and street mouths); ring workshops nudge off the
   spoke axes. Engine fix: wander had NO stuck detection (errands time
   out per waypoint; a wander waypoint inside a building pinned the NPC
   against the wall forever) — the controller now drops a waypoint
   after 3 s without a meter of progress. Resident wander tether cut to
   10 m (their own yard; going further is what errands are for).
   BONUS BUG the route-clearance test caught: `lotAt`'s angular jitter
   was a fixed ±0.025 rad — ±6 m of ARC at ring 14 — so outer-ring
   houses had been physically overlapping all along (a silent stuck
   source); jitter is now ±1 m of arc at any radius. The view draws the
   streets (plaza disc, rings, spokes) under the buildings. Tests:
   `src/__tests__/roads.test.ts` (3: routes never cut through any
   building, doors face roads, stuck-wander repicks).*

   **Body/clock sync (same day, playtest: "stray off-road on the way
   home, walk into house corners, never see the box fill"):** root cause
   was a SPEED MISMATCH — bodies walked at the engine's 5 m/s while the
   food cycle projects 1.6 m/s, so a shopper physically finished the
   trip in a third of the window; the "return leg straying" was actually
   a body already home, WANDERING (blind waypoints into houses through
   auto-opening doors), and the pantry refilled minutes after the body
   arrived. Three engine seams fix it for good: ① `NpcBehaviorSpec.speed`
   (per-NPC steerMaxSpeed override — villagers stroll at `ERRAND_WALK`
   1.6, band travelers at `BAND_SPEED` 3.5, party/player keep 5), so the
   body moves exactly as fast as the schedule clock assumes and the box
   fills as the shopper steps back in their door; ② `NpcErrandPoint.dwell`
   (errand waypoints can hold the NPC standing — the stall point carries
   the SHOP window, so people actually STAND AT the market, and a
   mid-shop spawn dwells out the remainder); ③ `NpcControlCtx.walkable`
   (the host passes the composed locomotion constraint; wander waypoint
   picks REJECT blocked ground, so NPCs stop aiming into buildings at
   all). Errand leg timeouts became distance-aware (4 s + 1 s/m — the
   8 s flat cap would have corner-cut slow walkers).*

   **Neighborhood markets (2026-07-06, `src/districts.ts` — city fractal
   step 1, city-development.md §7):** monocentrism is dead. Markets are
   FOUNDED BY UNSERVED DEMAND: walking the lot sequence in order, each
   household measures its lane distance to the nearest source, too-far
   households accumulate founding mass per quarter, and at threshold the
   pending lot nearest the mass centroid CONVERTS into a market stall
   (same footprint/door — clearance proofs hold; the conversion is
   §5-development on screen). Prefix-stable like `lotAt`. Food binding
   moved from chord-nearest to STREET-nearest (`roadDistance`,
   closed-form — no waypoint materialization, so plans stay ~10 ms at
   10k souls), and each stall stocks its own catchment's share (the
   step-1 district decomposition). Ladder: 1k souls = plaza market only,
   3k = 5 markets, 10k = ~29, linear in population. Tests:
   `src/__tests__/districts.test.ts` (5: founding, prefix stability,
   walk-shortening, townPlan/food integration, growth stability).*

   **Organic streets (2026-07-06 later, `src/streets.ts` — the polar
   template is RETIRED; town-roads.ts deleted):** towns are now grown as
   a STREET TREE from a plaza kernel by a deterministic event stream
   (rounds: every live street extends a jittered step and bends around
   obstacles; branch ports sprout side lanes; dead arms get re-seeded
   arterials at the widest gate gap). Every extension step emits the
   house lots fronting it, so the global slot sequence is CONSTRUCTION
   ORDER — the lot list is the town's development history, prefix
   stability falls out (a bigger town replays the same events further),
   and the layout finally looks like accretion because it is
   (city-development.md §2b made real, one level early). Routing is tree
   routing: (street, arc) positions, parent chains meeting at the plaza
   ring (a closed pseudo-street), O(depth) `roadDistance`, waypoint
   `roadRoute` with the same never-through-a-parlor contract. STREET
   WEAR IS TRAFFIC (§3b of city-development.md): food.ts counts each
   household's trip along its street path (`streetTraffic`) and the view
   draws width/opacity from it — arterials aren't drawn, they BECOME.
   Works cap outer street tips; fields fan past the farm gates; the
   district founding metric moved from polar lane-distance to real
   street distance with mass gathered per arterial ARM. Construction is
   a transient (§5b): TownManager re-derives the plan when population
   moves while loaded, and the world view reveals the diff — new lots
   scaffold in, new lanes pave outward, a lot converting to a stall
   crossfades. Capacity is honest now: a tile-town fills at roughly a
   thousand lots (riverton's site pop overflows it) — the metropolis
   answer is districts-of-districts (city-development.md §8), not a
   denser dartboard. Tests: roads.test.ts (7: determinism + prefix,
   route clearance, traffic concentration, frontage) + districts/food/
   zoom suites updated.*

   **Typed growth bias (same day, follow-up):** towns turn toward what
   feeds them. `townBias` (zoom.ts) reads quantized BEARINGS — toward up
   to two route-connected neighbor cities (the high street IS the
   highway), toward the fertile side, toward the ore side (weighted mean
   direction over the charter box; null when symmetric) — and
   `growStreets` aims its first arterials along them; works pick street
   tips by alignment (farm gates cap lanes toward the fertile tiles, the
   pithead the lanes toward the ore; fields follow the farm gates).
   Bearings are session-memoized so substrate drift (mining depletion)
   can't re-lay a loaded town; a much-later reboot may re-lay it — that
   is development, not noise. This is the SEEDS half of
   city-development.md §7 step 5; the districts themselves (typed seed →
   Voronoi cell → building mix) are the remaining half. Engine unblock
   the same day: `WORLD_MANIFOLD_MAX` 100 km → 40,000 km (planet scale —
   the 144-km tectonic continent tripped seamless-world certification;
   the bound is pure schema sanity, f64 keeps sub-micrometer precision).
   Tests: `src/__tests__/town-bias.test.ts` (4) + a tectonic
   generateWorld regression in tectonics.test.ts.*

   **Districts tier B + the pop-in policy (same day,
   `src/city-districts.ts`):** the step-1 catchments became DISTRICTS
   (houses + street-nearest works + a kind read off the works) and FILL
   NOW VARIES BY DISTRICT: a pure conserving allocator deals the site's
   delivered food by supply order (street distance from the nearest farm
   gate / the hall) — floor share, then nearest-first pour, exact at
   fill 1, Σ need·fill = got always. The poor quarter is a spatial fact:
   leaner pantries, thinner shelves, more frequent trips, all through
   the existing projection (pantry/stock/cycle read district fill).
   Supply hauls wear the streets on top of shopper trips; mid-zoom
   TRAFFIC DOTS sample the field (identity-free, day-curved, culled
   within 80 m of the player); the view tints the miners' quarter slate
   and the farm belt green. POP-IN: bodies enter through buildings —
   home spawns are placed INSIDE the house and the view hides indoor
   villagers (player peeking into the same building still sees them);
   mid-errand spawns within the camera's visible radius (view →
   TownManager, a new `visibleR` param) relocate to their trip's source
   building and walk out. Off-camera behavior unchanged. Tests:
   `src/__tests__/city-districts.test.ts` (4: allocator conservation +
   ordering, apportionment exactness, poor quarter end-to-end, hauls) +
   a pop-in policy test in zoom.test.ts. Open: despawn pop-out, and the
   miners'-quarter building MIX (different lot shapes, not just tint).*

   **Door transits + market stands (same day, playtest polish):** the
   town's only obstacle is its doorways, so bodies cross them with an
   explicit inside→outside (or reverse) waypoint pair (`doorTransit`).
   Residents tether to the HOUSE CENTER at a tiny wander radius — idle
   bodies shuffle indoors under the cull instead of grinding on their
   own wall toward a doorstep-outside tether (the stuck-on-doors bug) —
   and every shopping errand is bracketed by transits (out of home,
   back in). Markets grew STANDS: 2–5 stall tables along the door side,
   each household hashed to one, so shoppers fan out along the tables
   instead of piling at one point; the mid-shop dwell is at their stand.
   Sack piles now scale to the stall's own daily throughput (stock ÷
   dawn delivery) so every shelf visibly drains full→empty across the
   day — the old fixed ÷7.5 scale pinned big stalls at "10 sacks" most
   of the day and read as static (the stock was always a live clock
   function; only its rendering was flat). Tests: door-transit bracket
   assertion + market-stand cycle in food/zoom suites.*

   **Witnessed pantries + street-life ranking (2026-07-07, playtest:
   "people only ever appear in buildings, and boxes fill before the
   shopper is home"):** two fixes to the same illusion. RANKING — the
   engine budget (8 bodies) filled nearest-first, which in a town means
   the nearest houses' residents sitting INVISIBLY indoors while the
   walkers up the street never embody (the "empty roads" report); now
   idle homebodies rank `IDLE_RANK_PENALTY` (200 m) behind street life,
   embody only within `IDLE_EMBODY_R` (110 m), and hold no beside-you
   despawn lock while hidden inside their own house — the player being
   IN the house waives all of it — so the budget buys people the player
   can SEE. WITNESS — the pantry was a pure clock function, so boxes
   refilled the instant the projection said so, slightly before (or
   without) any body; trips now END AT THE CRATE (`pantryBoxAt`, a
   final dwell waypoint after the door transit), main.ts reports the
   engine's last-waypoint `onArrive` to `TownManager.tripArrived`, and
   the view reads `TownManager.pantry` — a stateful overlay on the
   closed form: a walked trip keeps the box empty until the body
   actually reaches it (however late steering and door jams make it),
   and a WATCHED box (inside the camera's visible radius) never refills
   on its own — it waits for a real shopper, or for the player to look
   away; off-screen and first-sight boxes read the closed form as
   before. And the budget itself GREW: the engine's 8-NPC cap exists
   for voiced/broadcast NPCs (each spec NPC is a live social session);
   villager bodies are pure steering controllers, so `runWorldHost`
   gained a per-host `maxNpcs` override (spec-authored casts stay
   schema-capped) and the seamless world runs `STREET_NPCS` (40) —
   busy streets read busy, the on-screen crowd stays in the dozens.
   Tests: a witnessed-pantry suite in food.test.ts (hold +
   commit-on-arrival, watched deferral, first-sight priming) +
   street-life ranking, per-host cap, and reworked pop-in tests in
   zoom.test.ts.*

   **Households (same day, playtest: "5 people per house? then they
   should be IN them"):** HOUSEHOLD=5 sized the town and the pantry but
   each house only ever sampled ONE person. Now member m of house k is
   `sampleVillager(site, k*HOUSEHOLD + m)` (`memberIndex`/`houseIndexOf`
   in zoom.ts) — the addressable-person space finally ≈ the population,
   and the npc-id scheme, recruit/pin ledger, and freed-folk melt-back
   all carry over unchanged since ids were always sample-indexed.
   Member 0's successor-by-exclusion is the household SHOPPER (walks
   the food cycle; recruit the shopper and a sibling takes over next
   cycle); the others are HOMEBODIES at deterministic spots spread
   about the room (`memberSpot`), embodied only near the player and
   ranked behind street life like any idle — step into a home and the
   family is there. Pantry witness state re-keyed per HOUSEHOLD
   (member-0 id, `householdKey`), with the in-flight trip tracked as
   {walking member, cycle} so shopper handover can't strand a box.
   Tests: full-family-at-home assertion in the pop-in test; house
   lookups in food/zoom suites moved to houseIndexOf.*

   **The city frame-rate crawl (same day, playtest: "cities crawl when
   first loaded, sometimes recovers after a while"):** measured on the
   677-house riverton — `townPlan` 0.2–2 s, `createTownFood` 0.1–0.5 s,
   and the GROWTH check replanned the town on ANY `want` change, which
   with the day clock playing is nearly every sim day (population
   drifts a few souls daily). Riverton made it absurd: the town
   OVERFLOWS its footprint (want > built lots), so each ~0.3–1 s replan
   rebuilt a byte-identical town — the crawl "recovering after a bit"
   was the aggregate reaching rest. Three fixes: ① the growth GOVERNOR
   — replan only when it can change the town (a full town skips demand
   above its built lots), only for moves ≥ 2% of built lots, one town
   per update, ≥ 5 s per-town cooldown (`TownPlan.built` records lots
   placed); ② town LOADS stack no more: the nearest missing town loads,
   ONE per update; ③ streaming reconciliation (chunks + bands update)
   throttled to ~8 Hz in main.ts — candidate ranking walks every loaded
   house and cost ~10–40 ms/frame in town; nothing it decides changes
   in 16 ms. Remaining known hitch: the FIRST load of a big town is
   still one synchronous 0.2–2 s plan (street growth is the cost — an
   incremental/async plan builder is the future fix). Tests: governor
   identity assertions (no-change updates and an overflowing town ride
   the same plan object through days of sim) in zoom.test.ts.*

   *2026-07-08 — **The good descriptor (food genericized, first move
   toward multi-commodity streets):** food.ts's closed forms were never
   food-shaped — only its constants were. `createTownGoods(tri, town,
   seed, good)` now parameterizes the whole projection over a `GoodSpec`:
   {key, needScalar/gotScalar, sellers (work types with a counter),
   shelved (kinds with dawn-stocked shelves), producers (where supply
   hauls originate — wired through `deriveDistricts`), perCapitaDaily,
   capDays, shopSec, cartRations}. `FOOD_GOOD` is the founding instance
   and `createTownFood`/`TownFood`/`FoodSource` remain as the food
   wrapper + type aliases, so zoom.ts, main.ts, and every test call site
   are untouched; food's hash draws are byte-stable (the cycle-offset
   key already carried "food"; stand/dawn draws keep their formats —
   correlated across goods, harmless since geometry differs per good).
   The instance exposes `good` and `boxCap` (HOUSEHOLD × capDays ×
   perCapitaDaily) for the multi-good renderer to come. District fill
   allocation needed NO genericizing — it's ratio-based, so per-capita
   scale cancels; only stall stock and haul weights carry units. NOT yet
   commodity-keyed: the TownManager witness overlay (tripWalking/
   committed/lastShown per household) and the shopper assignment
   (member 0) — those grow a good dimension when a second real commodity
   lands (bread: clone the ore→smelt→metal aggregate chain; clothing:
   same shape, member-1 shopper on a weeks-long cycle). Tests: "the good
   descriptor" suite in food.test.ts — a cloth-shaped second instance
   (hall counter, no shelves, 40-day hoard), decorrelated cycle offsets,
   and wrapper ≡ descriptor equivalence.*
8. **Caravan mode** (§8).

Steps 1–5 produce a playable idle civilization sim on their own (the Spore
"civilization stage" with real idea dynamics); 6–8 grow it downward toward the
individual RPG start. Starting at the aggregate end is deliberate: it exercises
both engines' guarantees early, and the individual scale can lean on world-gen
work (goal-tree v2, seagull-dream substrate) that is advancing independently.

---

## 9b. Content model

The concrete vocabulary that fills these layers — substrate fields
(fertility/ore/people over computed rivers), the charter boundary,
resource-processing chains (`ProcessSpec` + flow-net `satisfied`),
buildings, and city-founding conditions — lives in **world-content.md**,
with its own ship gates (1–4 landed 2026-07-05; gate 5 = the founding
transaction is the next engine work).

How a CITY is structured, develops, and loads — districts, emergent
markets, street-level flows that actually move goods, and the fractal
recursion of this whole model inside a settlement — is brainstormed in
**city-development.md** (2026-07-06; supersedes step 7's single-market
polar template as the direction of travel, keeping it as the core-district
layout and the cheat provider).

Where the LANDSCAPE itself comes from — drifting plates, collisional
mountain belts, and ore emplaced by geologic events and exhumed by
erosion — is **plate-tectonics.md** (2026-07-06, SHIPPED: the first real
provider behind timescales.md's Geology→Substrate seam; the lab's
"TRI — tectonic" scenario runs the whole civ arc on a map that happened
rather than being authored).

How SETTLEMENTS THEMSELVES come to exist and grow — the full lifecycle
(villages condensing from the wild `people` field, merging, colonization
toward scarce resources, conquest into multi-city empires) and how deep
civilizational HISTORY can be planned ahead and presented as growth (the
rivers method applied to the settlement graph: keyframed boot-runs à la
tectonics, or a streets.ts-style prefix-stable event stream over the
solved settlement hierarchy) — is brainstormed in
**civilization-emergence.md** (2026-07-07; extends world-content.md §5's
founding transaction; supersedes `autoFound`'s scheduled-scan founding as
the direction of travel).

## 10. Open questions

- **Sphere substrate**: geodesic (hex-ish) grid — engine-ready per the idle
  rules doc, but renderer + gaze→tile mapping is real work. Defer until after
  step 4; nothing above depends on tile shape.
- ✅ **RESOLVED (step 3) — PopuSim rest detection vs stochastic sd**: rest is
  EXACT by default. sd > 0 on a ranged transmit varies the cross-site queue
  day to day, which the queue-fingerprint comparison correctly treats as
  "not a fixed point" — such worlds simply don't rest. Sub-unit *expected*
  drift is caught structurally (latent-conversion check + fractional-
  migration flag), never sampled. The civilization.md accuracy trade is the
  opt-in `world.rest_eps > 0` dial on the delta/state measures; the exact
  default guarantees skip ≡ step bit-for-bit.
- **How much Settlement logic migrates onto the Substrate grid**: the sandbox
  doc's long-term goal folds cities onto tiles. This model is agnostic — the
  Settlement layer is defined by its algebra (conservative exchange,
  dissipative conflict), not by whether it runs on a graph or the lattice.
- ✅ **RESOLVED (step 4) — Flow solver shape** (§4c): proportional relaxation
  won — deterministic Gauss–Seidel on the conductance-weighted graph
  Laplacian (fixed sweep order, fixed tolerance, one pinned node per
  component). This is the electrical-network flow: multi-source/multi-sink
  supply spreads over ALL paths in proportion to conductance, which
  steepest-descent could never do, and it stays fully in-family with the
  cell algebra (a relaxation to fixpoint). Min-cost routing remains a
  possible later refinement if flows should prefer short paths more
  aggressively than conductance alone implies.
- ✅ **RESOLVED (step 5) — Where the ledger lives**: the civ ledger is
  DERIVED, not stored — `DualWorld.civs()` recomputes name/color (from the
  declared `coupling.civs` list) plus pop and capital from live membership-
  trait counts every read, and `World.breakaways_fired` is the event log.
  The only day-boundary WRITE a secession makes is the hostility raise on
  border edges. Diplomatic memory, when it arrives, gets the plain
  day-boundary store this entry originally proposed.
- ✅ **RESOLVED (world-content gate 6) — Full layered-world stress test**:
  the tri-layer harness (`grand-dream/src/tri.ts`) runs a 14-city,
  three-biome, 72×32 world with the full stack (substrate + chartering +
  flow-net economy + trait demand + vitals + mining depletion) at
  ~1.5 ms/day, bit-deterministic across reruns, with the cross-layer
  ledger exact; the quiet variant reaches rest at scale and O(1)-jumps.
  Hundreds-of-nodes scale remains untested but nothing in the per-day
  cost profile (linear in cities × small constants) suggests trouble
  before the PopuSim per-site day cost dominates.
