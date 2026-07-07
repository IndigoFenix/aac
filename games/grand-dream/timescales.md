# Deep-Time Architecture: Providers, Provenance, and Granularity

Goal: one world that can, in principle, produce the whole arc — star and
planet formation, geology, evolution, the emergence of sapient species,
civilizations, and the development of society — where the player can zoom
through scales without era breaks, and where **any layer may be either
simulated or cheated** without the layers above it noticing.

The causal spine is physical, not scripted:

> plate tectonics shapes the **landscape**; evolution populates it with
> **life**; civilization concentrates around **landscape + resource
> availability**; society compounds on top of civilization.

This document is the substitutability spec for that spine. It supersedes the
earlier framing of a single global clock whose granularity refines as advances
appear — that idea, corrected and rescoped, survives as the per-layer
granularity dial in §3 and the refine/rest trigger in §6.

Companion docs: unified-world-model.md (the four civ-scale engines and their
day-boundary contract), world-content.md (the concrete substrate fields this
doc treats as the geology→life→civ interface), seagull-dream's universe.md
(the planet-formation provider at the top of the stack).

---

## 1. The core principle: layers depend on outputs, never on process

Each layer consumes only the **output fields** of the layer beneath it, never
that layer's mechanism. The Substrate reads elevation, water, rivers,
fertility, ore — and is blind to whether those numbers came from a tectonic
simulation, a procedural generator, or an authored template. "The civilization
doesn't care how the landscape wound up that way" is therefore an
*architecture*, not a convenience: **provenance-independence at the layer
interface.**

This seam already exists. world-content.md's Substrate is defined by the fields
it exposes, and it designates **fertility as the single bridge between geology
and life**. So "plate tectonics" is not a new layer that must be plumbed into
civilization — it is a *new provider for fields the Substrate already reads*.
Those fields are procedurally generated today (that is the shipped "cheat"); a
real tectonic stepper is an alternative provider of the identical schema, and
nothing above it changes.

General rule for the whole stack:

> **Every layer offers one or more providers behind a fixed field-schema
> interface. A game selects a provider per layer. Providers for the same layer
> must agree at the interface.**

The last clause is testable, and both engines already practice it: a cheat
generator and a real simulator for the same field can be validated against each
other's output distributions — exactly how seagull-dream validates its
formation physics against the real solar system. That agreement is what lets a
provider be swapped without the consumer noticing.

This is the same idiom as seagull-dream's "phase transitions, not classes" and
civilization.md's "define by what it does" — applied to *how a layer's state
was produced* rather than *what a body is*. A landscape is defined by the
fields it exposes, full stop.

---

## 2. Path-dependence decides what a layer can offer

Whether a layer can be cheated, skipped, or watched turns on one property —
whether its process is path-independent.

### Path-independent, smooth processes

Stellar evolution, orbital mechanics, radiogenic cooling, tidal locking: state
is a pure function `f(seed, t)`. This is what seagull-dream's `bodyState(b, t)`
already is — a `Body` stores formation state only, and current state is
re-derived at any queried `t`, O(1).

For these, **skipping and watching are the same operation**: sweep `t` slowly
for an animation, jump `t` to now for an instant skip. Free in both directions,
and already shipped in seagull-dream.

### Path-dependent processes

Plate tectonics, evolution, civilization: the end state depends on the whole
trajectory, not on `(seed, t)`. A mountain range is not a closed-form function
of time the way luminosity is. These get **three providers**:

| Provider | Cost | Watchable? | What it is |
|---|---|---|---|
| **Simulate** | high | yes, in detail | a stepper producing the real trajectory |
| **Coarse-simulate** | medium | yes, roughly | big structural timesteps — a real trajectory, less detail |
| **Generate (cheat)** | instant | **no** | produce a plausible *end-state* directly; it never had a history |

The cheat is not watchable precisely because it never had a trajectory — it
produces a landscape that *looks like* it had tectonics without the continents
ever having moved.

---

## 3. Granularity is a per-layer dial, not a global clock

"Skip ahead at low granularity" is exactly the **coarse-simulate** provider for
a path-dependent layer: real trajectory, large timesteps. This is the correctly
scoped survivor of the original single-clock idea. Granularity is:

- **Per layer.** A game may cheat its geology (no tectonic granularity at all)
  while coarse-simulating its evolution and fine-simulating its civilization.
- **A game profile, not an emergent property of the universe.** Each layer's
  provider and step size are declared up front (§7), the way unified-world-
  model.md's idle-safety is a selectable profile a world validates against.
- **Independent of the interface.** Fine steps and coarse steps write the same
  output fields; only the fidelity of the trajectory differs.

This is why the epoch ladder below is kept only as *documentation of regimes* —
a checklist of what dynamics each epoch actually has — and not as a schedule the
engine follows.

### The epoch ladder (regime reference)

Each rung names the dynamics that become active in that epoch — useful for
deciding what a simulate-provider for that layer must model, and at what step
size a coarse-simulate provider can get away with. It is descriptive, not a
control structure.

- **First stars / structure form** — gas cooling, metal enrichment, galaxy
  assembly. *(seagull-dream: galaxy context — age, metallicity, GHZ.)*
- **Cloud collapse → protostar + disk** — disk accretion, snow line,
  planetesimal growth. *(seagull-dream: `materializeSystem`.)*
- **Crust cools / oceans condense** — plate tectonics (Wilson cycle ~300 Myr),
  climate, prebiotic chemistry. *(✅ BUILT — grand-dream `tectonics.ts`, see
  plate-tectonics.md; climate still open.)*
- **Onset of giant impacts** — stochastic collisions, resonances, magma-ocean
  overturn. *(seagull-dream: formation-time rolls, §5 — not a watchable era.)*
- **Abiogenesis** — biosphere geochemistry. *(seagull-dream: `lifeStage` label,
  a function of habitability + age; no dynamics.)*
- **Great Oxidation Event** — atmospheric redox, glaciation feedbacks.
- **Multicellularity** — ecology (predator-prey ~10²–10³ yr), rapid radiation.
  *(MISSING provider — the evolution spine, §8.)*
- **Cumulative culture / stone tools / sapience** — non-genetic transmission.
- **Agriculture / founding of cities** — institutions, tech accumulation,
  dense-population dynamics. *(grand-dream: Substrate + Settlement.)*
- **Writing** — high-fidelity institutional memory. *(grand-dream: Composition
  trait transmission.)*
- **Industrialization → digital** — compounding economic and information
  cycles. *(grand-dream: Composition + histfigs.)*

---

## 4. The field-schema seams

The spine is a chain of interfaces. Each seam is a field schema that a provider
below writes and a consumer above reads. Naming them makes the substitutability
concrete.

- **Formation → Geology.** Body composition and orbit (seagull-dream's `Body`)
  → a planet's bulk inputs to tectonics: mass, refractory/ice budget, internal
  heat, water inventory.
- **Geology → Substrate.** The landscape fields: `height`, `solid`, `ore`
  (finite budget), and the water/river inputs. This is the seam a tectonic
  provider targets. *Consumer already exists* (world-content.md §1).
- **Substrate → Life.** `fertility` — the single geology→life bridge — plus the
  biome structure fertility and treeline induce.
- **Life → Substrate/Settlement.** Carrying capacity and resource fields
  (`lure`, `people`), which today are emergent logistic fields and which an
  evolution provider would instead set from species/ecology (§8).
- **Substrate → Civilization.** Fertility, ore access, rivers, terrain — the
  founding conditions. *Consumer already exists* (grand-dream Settlement).

A provider is "correct" iff it writes its seam's schema within the distribution
the consumer expects. That is the whole contract.

---

## 5. Watching geology unfold in seagull-dream, using the same system

seagull-dream was not built to watch geology, but the path is clean and does
not fight the existing design:

1. Add a **tectonic provider** whose output is the Geology→Substrate seam (§4).
   Because tectonics is path-dependent, this provider is a *stepper*, not
   another `f(seed, t)`.
2. To keep seagull-dream's lazy-evaluation philosophy, the stepper records
   **keyframes** of the field at sampled times; the renderer lazy-evaluates by
   interpolating between keyframes. This is the path-dependent analogue of
   `bodyState(b, t)`: instead of "recompute state from formation params at t,"
   it is "read the nearest recorded field and interpolate." Same time-toggle
   UX, honest that the history had to actually happen once.
3. The **default provider stays the procedural cheat** (instant, static).
   Watching is the *option* you dial in: swap the provider, pay for the
   trajectory, scrub through it.

Caveat, stated honestly: seagull-dream's current stochastic epochs — giant
impacts, late-veneer water delivery — are formation-time `rng()` rolls with
consequences, not replayable timelines. You can query their *outcome* at any
`t` but you cannot watch the Hadean bombardment unfold, because it was one draw,
not a simulated era. So "watch it unfold" is a per-process capability: smooth
processes are already scrubabble, tectonics becomes scrubabble once it has a
stepping provider, and the impact era stays a generated fact unless it too is
promoted to a stepper. That is probably correct — pay for a trajectory only on
the layers whose unfolding the player wants to see.

## 5b. Interpolated transients: watchability without a stepper (2026-07-06)

§2 says the cheat provider is "not watchable" because a generated end-state
never had a trajectory. That is true of the deep past — but there is a third
option for the PRESENT: **when a resting world changes, both endpoints are
known** (the old rest state on screen, and the new one the engines compute
instantly — a drainage re-route, a re-solved flow net, a re-charter). A
transition between two known states can be *presented* as a fake trajectory:
rivers eroding pre-set paths toward a destination the solver already knows.

The grand-dream lab already lives this pattern without naming it — caravan
dashes are a render of a static flow field, traveler bands are
`f(route, wall-clock)`, street life is a clock projection of static scalars.
The rule generalizes:

> **Authoritative state may jump; what the player sees eases toward it.
> Presentation is a stateless function of (shown state, target, clock) and
> is never read back by the sim.**

Design points, in rough order of importance:

- **Ease-toward, not lerp-from — this is what makes mid-change safe.** The
  substrate may change again while a transient is playing (the stated
  worry). A lerp stores its start state and breaks on retarget; an
  exponential approach (`shown += (target − shown) × k`) has no memory of
  the start, so a new change simply moves the target and the display bends
  from wherever it visibly is. Retargeting is free by construction — the
  same reason the sim's own `toward` fields compose safely.
- **The sim already interpolates its dynamic fields.** Fertility, plants,
  people are convergent `toward` dynamics — sim-level transients with an
  authorable duration (the rate). The fake-transient machinery is only for
  DERIVED fields that jump: `river`, flow nets, charters, tectonic
  keyframes. (Slowing a response = tune the rate; showing a jump as a
  process = presentation ease. Two different dials; don't conflate them.)
- **Structure-aware interpolants read as process, not crossfade.** A
  re-routed river should CARVE: order the new channel's tiles by distance
  along the drainage tree (the flow solve knows it) and advance a front,
  headwaters-to-mouth; lakes fill bottom-up by elevation; vegetation
  already greens outward via the halo's own convergence. Per-tile alpha
  lerp is the fallback, not the goal.
- **Granularity becomes a per-zoom presentation choice** — the original
  wish ("show events at different levels of granularity") without extra
  sim: the map view plays a re-route over seconds; the avatar scale could
  play the same front over game-days with debris and dry-bed detail; a
  fast-forward shows it instantly. Same authoritative event, three
  durations.
- **The honesty seam: consumers that act on the world must read
  authoritative state** (collision, founding, charters, mining — all
  already do). During a transient the display briefly disagrees with the
  truth; at map scale that is invisible, at avatar scale the few
  interaction reads near a changing feature either accept the brief
  mismatch or consult the same presentation field. This is the one place
  the pattern can leak — name it in any implementation.
- **Duration model**: authored per-field time constants ("a re-route
  carves over ~N days"), optionally scaled by the magnitude of the change.
  "We know how it ends and we know when" — the *when* is a design value,
  not a simulation output, which is exactly what makes it cheap.

Consequence for the provider table: the cheat provider becomes watchable
*at its seams* (its changes animate), which removes most of the pressure to
build simulate-providers for spectacle alone. Pay for a real stepper only
when the trajectory itself carries gameplay (flood dynamics, a war front)
or the endpoint is genuinely unknowable without it (tectonics' deep past).
The tectonic keyframe scrubber (plate-tectonics.md §3) is this same
machinery pointed backward: interpolate between recorded keyframes instead
of toward a live target — SHIPPED same day (`geo-scrub.ts` + the lab's
"Geologic history" slider; see the plate-tectonics.md §3 landmark).

✅ **SHIPPED (same day) — first use: the river + vegetation presenter.**
*Landmarks: `createSubstratePresenter` in `grand-dream/src/substrate-render.ts`
(shown river eases toward the live solve; growth is a carve front gated on
the upstream feeder — accumulation strictly increases downstream, so the
drainage tree IS the ordering; decay is a plain dwindle-in-place); plant +
fertility get a plain display ease too (the sim's convergence is gradual in
SIM time, but the lab steps the grid at frame rate — time-lapse cadence
made greening/dieback read as instant). Wired into BOTH lab views via
`Runtime.presenter` in main.ts (one shown state per world; dt derives from
ts so same-frame double-paint is a no-op); `paintSubstrateImage` takes an
`EasedFields` override for the PAINT only.*

*Two front bugs found by playtest, both now regression-tested: (1) the
deadlock trickle must be ABSOLUTE (units/sec) — a floor proportional to the
target let far-downstream tiles (huge accumulation) cross the absolute
paint threshold in under a second, so rivers appeared at the mouth and
visibly "extended uphill"; (2) the feeder gate must demand delivery
proportional to MY size — normalising by min(feeder, me) let a delivered
4-unit side trickle fully open a 192-unit trunk, filling the whole channel
at once. Also: read `grid.fields.river` fresh every frame —
`recomputeFlows` REPLACES the array. Tests
`src/__tests__/transient.test.ts` (3): the front crosses the head before
the mouth in BOTH front progress and paint visibility; vegetation eases
without snapping and lands exactly; a mid-transient re-sculpt retargets
and converges byte-exactly onto the live field.*

✅ **ABSTRACTED (same day) — the generic core + discrete events.**
*Landmarks: `grand-dream/src/transients.ts` — three primitives:
`easeToward` (the universal scalar ease, no memory of the start ⇒ retarget
free), `createEasedValues` (keyed families of eased scalars for CONTINUOUS
quantities that jump: route widths, caravan flow volumes, city radii;
keys prime at first-seen target), and `createRevealTracker` (the DISCRETE
analogue for births/deaths: first-seen wall-clock per key → 0→1 grow-in
phase, fade-out phase for removed keys, keys present on the first frame
primed as already-revealed, a key re-born mid-fade resumes from its
visible phase). The substrate presenter's field ease now rides
`easeToward`; the lab's map rides the tracker — a FOUNDED city grows in
with a fading pulse, its trade route reaches out from the established
network (parametric line reveal toward the younger endpoint; caravans
wait for the road to complete), and route widths / flow volumes / radii
ease instead of stepping at day boundaries. The map drawing itself is
INTERIM (due for a rework) — the trackers are the part that carries over.
Tests: `src/__tests__/transients-core.test.ts` (7: priming, retarget,
exact convergence, key forgetting, fade-out, re-birth resume).*

✅ **APPLIED (same day) — town construction.** *The organic street towns
(`streets.ts` — prefix-stable growth-event stream, see
city-development.md §0/§6b) turn every plan re-derivation into a
transient: TownManager rebuilds a loaded town when its population moves,
and the world view plays the DIFF through the core — new lots scaffold
in (tracker), new lanes pave outward from their junctions (eased length
× reveal phase), lot→stall conversions crossfade (one key fades where
the other grows). Because rebuilds only append, the diff is always
construction — the §5b discipline needed no domain gate here at all.*

---

## 6. Φ_m: the bidirectional refine/rest trigger

The clean master variable is not timescale (which oscillates) but **energy rate
density** — free-energy flux per unit mass, Chaisson's Φ_m — which rises nearly
monotonically across the whole sequence: roughly stars ~1, planets ~10², plants
~10³, animals ~10⁴, brains ~10⁵, human society ~10⁵–10⁶ erg s⁻¹ g⁻¹ (ordering
and rough magnitudes solid; exact Chaisson numbers worth verifying, and in
practice unneeded — see below). Each order-of-magnitude jump coincides with a
regime transition because each transition is a new structure metabolizing free
energy faster.

Its role here is **not** to drive a global timestep. It is the criterion for
*when a layer graduates between provider modes*:

- **Refine (cheat/coarse → simulate):** when the leading edge's Φ_m — or, in
  practice, the measured rate-of-change of the rate-limiting field the engines
  already instrument — crosses a threshold, promote that layer to a finer
  provider, seeded from the closed-form/generated state it had until then.
- **Rest (simulate → coarse/skip):** the mirror image, and it is *already
  built*. grand-dream's rest detection coarsens a stepped layer to O(1) skips
  when every measured delta is provably zero; external inputs, events, or player
  presence wake it. Refinement and rest are two directions of one dial.

Two consequences worth stating:

- **You likely never need literal Chaisson values.** Only the ordering matters,
  and the engines already track realized per-day deltas and energy budgets. Φ_m
  is the *concept*; the instrumented flux is the *implementation*.
- **Trigger on rate-of-change, never on presence.** Several transitions are
  capacity enablers whose fast loop ignites much later — sapience predates
  cultural acceleration (Oldowan/Acheulean toolkits are near-static for ~1 Myr
  each); agriculture's productivity feedback took millennia to bite.
  Presence-detection would refine prematurely and waste resolution on stretches
  where the new loop has not ignited. This is the same lesson grand-dream's rest
  detection learned from the other side: a realized-zero day proves nothing
  (hence its latent-conversion check), so measure the loop's actual activity,
  not the existence of the feature that could drive it.

---

## 7. The game profile: what is simulated vs cheated

A game declares, per layer, a provider and (for simulate providers) a step
size. The consumer contract is identical regardless of the choices.

Illustrative profiles:

| Layer | "Fast civ start" | "Living planet" | "Full deep-time" |
|---|---|---|---|
| Formation | cheat (home template) | closed-form `f(seed,t)` | closed-form |
| Geology | cheat (procedural) | **simulate (watch drift)** | coarse-simulate |
| Evolution | cheat (biome→life table) | cheat | **simulate** |
| Substrate/Settlement | simulate (day step) | simulate | simulate |
| Composition | simulate | rest-jump when idle | simulate |

Every profile produces a playable world; they differ only in which histories
actually happened versus were generated as fact. The default for any layer is
its cheapest correct provider; simulation is opt-in per layer, per game.

---

## 8. What is genuinely missing

Two providers were named MISSING in §3; both are new *content*, not new
engine, and neither blocks the civ layers (which start from generated
substrate today):

- ✅ **BUILT (2026-07-06) — Geology / plate tectonics** — a stepper writing
  the Geology→Substrate seam, with keyframes for §5's scrubbing. Design,
  landmarks, and tuning lessons in **plate-tectonics.md**; the cheat
  remains the alternative provider behind the same `prepareSubstrate`
  sockets, exactly as §1 prescribes. (Lab scrubber UI still open.)
- **Evolution / ecology** — the band between multicellularity and culture, where
  neither engine currently has dynamics (seagull-dream's `lifeStage` is a label
  ladder; grand-dream starts at settlements). The "everything is a trait" idiom
  extends naturally: species/clades as PopuSim syndromes, selection pressures as
  vectors, ecology as cross-site transmission. Its output seam is the
  Life→Substrate fields (carrying capacity, resources) that are emergent
  logistic fields today.

Both slot into the provider framework without disturbing it: each is a new
provider behind an existing seam, and until built, the shipped cheat for that
seam stands in.
