# PopuSim — System Outline

**Source of truth:** `legacy/script.js` (~13,720 lines).
**Modern port:** `src/` (TypeScript).
**Audience:** Developer working on the modern port, who needs to understand exactly what the simulation is supposed to do, what objects exist, what runs each day, what math is applied, and where the modern port has drifted from the legacy.

This document is descriptive of the legacy behavior. Where the modern port diverges, it is called out inline with **DIVERGENCE** flags and consolidated in the final section.

---

## 1. The big picture

PopuSim is a deterministic, group-based epidemiological simulator. It does **not** track individuals. Instead, every "person" is implicit inside a **Population** — a bag of identical people identified by their **Syndrome** (which traits they have). A **Site** holds many Populations whose sizes always sum to the site's total population.

Vectors are also grouped: a **Shed** is a swarm of identical change-affecting entities sitting inside a Site, waiting to make contact with units on a particular phase. These are are not tracked individually either.

The simulation steps in **days**. Each day is divided into ordered **phases**. Every event in the system — transmissions, progressions, infections, resource production, resource consumption, scripted events, player actions — is bound to a phase. Within a phase, all bound work is treated as occurring "simultaneously" (the legacy is loose about this — see §11 on order-dependence).

The high-level objects:

```
System ────────► World ────────► Site ────────► Population ──┬─► SubPop ─► SubSyndrome
   │               │               │                         │
   │               │               ├─► Shed                  └─► (every Population maps to exactly one Syndrome)
   │               │               ├─► Stockpile (local)
   │               │               ├─► PendingTransmission
   │               │               └─► PlayerAction (local)
   │               │
   │               ├─► Trait ─► Transmit, Progress, Modifier(s), Impact(Produce|Consume)
   │               ├─► Vector ─► Seek, VectorMod
   │               ├─► Syndrome ─► SynTransmit, SynProgress, SynImpact
   │               ├─► SubSyndrome
   │               ├─► Resource ─► Stockpile (global)
   │               ├─► PlayerAction (global) ─► ActionCost
   │               ├─► Event ─► EventCondition, EventResult, EventValue
   │               ├─► Phase ─► IndexedPhase
   │               └─► Tracker ─► History
   │
   └─► UI / WorldBuilder (not described here — see class_analysis.md)
```

---

## 2. Static (scenario) objects

These are defined once in a scenario and (with rare exceptions like `Event.count`) do not change at runtime.

### 2.1 Trait
A binary characteristic a Population can have. Every Population is defined by exactly which traits it has.

A Trait is *the* place where epidemic behavior is declared. It owns:
- **`transmit`** (list of `Transmit`): "if a unit has me, it sheds these viruses each day."
- **`progress`** (list of `Progress`): "if a unit has me, these things happen *to it* each day."
- **`impact`** (list of `Impact` — produce/consume): "if a unit has me, it produces/consumes resources each day."
- **`modifiers`** (`TransmitModifier`, `ProgressModifier`, `ContactModifier`, `ImpactModifier`, `ProduceModifier`, `ConsumeModifier`): "having me changes the rate of *other* traits' actions."
- **`bloc`** (boolean): if true, the trait's modifiers are baked into the Syndrome's effective rates statically. If false, they would be applied per-site at runtime via stockpile-aware multipliers (see Syndrome §2.6).

### 2.2 Vector
A type of virus: e.g. "airborne flu". A Transmit or Progress declares which Vectors it releases. Vectors carry `Seek` constraints (which traits they prefer to land on) and `VectorMod` records.

### 2.3 Transmit / Progress (subclasses of the same idea)
Both are "produce viruses" rules. They differ only in destination:
- **Transmit**: viruses are released into the Site, picking a target Population at random (weighted by Seek). Spreads between people.
- **Progress**: viruses are applied internally to the same Population that produced them. Always `precise=1` (`Progress.js:9556`), which means deterministic application — see §6.

Both declare:
- `vectors`/`vector_keys`: which Vectors are produced
- `traits`/`trait_keys`: traits to *add* to anyone infected
- `cures`/`cure_keys`: traits to *remove* from anyone infected
- `seek`: targeting preferences (Transmit only is meaningful)
- `value`: base rate (viruses produced per unit per day)
- `sd`: standard deviation of that rate
- `phase`: which phase this fires in
- `popmult`: if set, multiply final shed count by site population (used by some player actions)
- `precise`: if 1, infection is deterministic; if 0, infection uses the binomial-mean approximation

### 2.4 Modifier
Six subclasses, all multiplicative (legacy `script.js:10419, 10458, 10632`). A Modifier sits on a Trait and says "if my host trait is present in the population, multiply this rate by `mult` (a number) or by the value of `mult` (a resource name)."

- **TransmitModifier** — modifies a Transmit's value/sd
- **ProgressModifier** — modifies a Progress's value/sd
- **ContactModifier** — modifies the *probability of being infected* by an incoming Shed
- **ProduceModifier**, **ConsumeModifier** — modify resource production/consumption rates
- **ImpactModifier** — generic impact rate modifier

If `mult` is a number → applied at Syndrome construction (static). If `mult` is a resource → applied at per-Site runtime via `SiteTransmit.recalculateValues()` (each day, dependent on current stockpile).

### 2.5 Resource / Stockpile / Impact
- **Resource**: a named numeric variable. May be `global` (one Stockpile in World) or per-site (one Stockpile per Site).
- **Stockpile**: the actual store of a Resource. Tracks a numeric value plus a history.
- **Impact** (subclassed `ImpactProduce`, `ImpactConsume`): a rule on a Trait saying "this Trait produces/consumes this Resource at this rate per unit per day."

### 2.6 Syndrome / SubSyndrome
A **Syndrome** is a *combination of traits*. Every Population has exactly one Syndrome. Syndromes are interned: ask the World for the Syndrome corresponding to a sorted set of trait keys, you get a singleton.

The Syndrome is the runtime cache of "what does it mean to have all these traits at once?":
- `transmit_phases[p]`, `progress_phases[p]`, `produce_phases[p]`, `consume_phases[p]`, `impacts_phases[p]` — arrays of `SynTransmit`/`SynImpact` indexed by phase
- For each `SynTransmit`/`SynImpact`, the Syndrome's constructor walks every Trait the Syndrome contains, finds matching modifiers (by vector match), and bakes their multipliers into `value` and `sd` (legacy `script.js:10250-10698`).
- For *resource-based* (non-numeric) modifiers, the Syndrome stores a list of stockpile references in `value_resource_mult` / `sd_resource_mult`. These are evaluated per-Site each tick by `SiteTransmit.recalculateValues()` (legacy 10226).

A **SubSyndrome** is a finer-grained variant used during infection bookkeeping. A SubSyndrome's `trait_states` is a `Record<traitKey, 0|1>` — `1` means the trait is present, `0` means *explicitly absent* (was cured). Crucially, `0` is not the same as "missing" — once a trait is set to `0`, it cannot be re-added (see §6 on cure-as-immunity behavior). Each Population maintains a list of SubPops keyed by SubSyndrome so that infection can mutate the trait set incrementally without immediately reshuffling site populations.

### 2.7 Seek / Imply
- **Seek**: vector targeting preference. A Seek says "if the target population has *any* trait in `trait_has_keys`, OR is missing *any* trait in `trait_not_keys`, multiply the targeting weight by `mult`." Multiple Seeks compose multiplicatively (`Syndrome.getSeekMod`, legacy 10566). The default weight is 1; lower weights de-prefer; higher weights up-weight.
- **Imply**: declares "if a unit has these traits, it implicitly also has these other traits." In legacy this is parsed and stored on Vectors and Modifiers but the application path is thin — **DIVERGENCE/AMBIGUITY**: it's not clear that Imply does anything beyond a parse-time mark. The `value`/`sd` fields suggest a probabilistic intent that was never wired up.

### 2.8 Phase / IndexedPhase
- **Phase**: a named ordering bucket: a string key plus an index assigned in declaration order.
- **IndexedPhase**: the runtime collection. Each World has an array `all_phases: IndexedPhase[]`, each holding the `transmit`, `progress`, `events`, `impacts`, `syndromes` registered into that phase. World iterates `all_phases` in array order (legacy 4062: `for (var p=0; p<this.all_phases.length; p++)`).

### 2.9 PlayerAction / ActionCost
Player-controlled toggle/slider/number. Has:
- `desired_value` (what the player has set in the UI) and `current_value` (the locked-in value used during the current day).
- `transmit_list`: Transmits the action triggers. The action acts as if it were a Trait that fires its Transmits each day, but only when the player turns it on.
- `costs`: list of `ActionCost` declaring resources gained/spent per unit of action value.

### 2.10 Event
A scripted conditional with `count` (number of times it can still fire — `-1` for unlimited), `conditions` (`EventCondition`s with AND/OR logic via `.or` flag, legacy 7560-7569), and `results` (`EventResult`s — push news, modify resources, enable/disable actions, win/lose, fire transmissions).

### 2.11 PopInit
Scenario-time spec for "populate Site S with N units having traits X, Y, Z." Resolved during `World.start` to create initial Populations.

### 2.12 Site
A geographic location. Owns:
- `pops: Population[]` and `pops_kv: Record<syndromeKey, Population>` — every population on this site
- `shed: Shed[]` — sheds currently waiting to infect
- `shed_pending_phases[p]: PendingTransmission[]` — sheds queued by player actions/events that haven't been turned into Sheds yet
- `local_stockpiles: Stockpile[]` — per-site resources
- `pop_phases[p]: Population[]` — populations registered to do work on phase p

### 2.13 Tracker / History
A Tracker links a "thing whose value can change over time" (a Population, a Stockpile, a custom expression) to a History, which records one number per day for graphing.

### 2.14 CustomMetric / Correlation (player-side artifacts)

Both are **player-created at runtime** via popup UIs in the gameplay GUI; neither lives in the scenario JSON. They survive a `/reset` of the same scenario by way of the `custom_metrics_prev` / `custom_traits_prev` rebind path in `World.start` (matching legacy 3208-3242). The harness (`WorkerSim`) keeps the snapshot across `boot()` calls and only drops it when the scenario key changes.

- **CustomMetric** (`game/tracking/CustomMetric.ts`) — owns an `Expression` that is evaluated every day for the world plus per-site, with results piped into a `History` exactly like a resource or trait. Supports moving-average and since-start windows via `TrackerCalc.{neg_offset, calc}` (legacy parity). The serialized expression (`expression_data: SerializedExprValue[]`) is the source of truth across reset; `World.rebuildExpressionFromSerialized` rebinds tracker references to the freshly-built world.
- **Correlation** — a real `Trait` with `is_correlation = true`. Created by `World.addCorrelationTrait`, which adds it via `addAsCombo`, re-evaluates every existing `Syndrome` to see which now include it, mutates the matching syndromes in-place, and **retroactively** rebuilds the new trait's history by summing per-day population values across sites (legacy 3702-3811). Beyond legacy's `def_and` / `def_not` / `def_or` it also exposes `require` / `forbid`.

**Visibility / dependency:** every `CustomMetric` and correlation `Trait` carries `dep_tracker_keys` (`${kind}:${key}` strings). The reverse-index `referenced_by_metrics` / `referenced_by_correlations` lives on the underlying `Trait` / `Resource`. `World.recomputeMetricGrayout` (called once per `newDay`) sets `grayed_out` on the metric/correlation when any dependency is hidden; the worker reports those IDs in `Snapshot.grayedOutTrackerIds` so the UI can dim the row.

**Wire flow:** main → worker via `addCustomMetric` / `addCorrelation` / `removeCustomMetric` / `removeCustomTrait` ClientMsg variants. Worker emits `Snapshot.trackerPatch = { added, removedIds }` so the client patches its `bootstrap.trackers` registry without a full bootstrap re-emit.

---

## 3. Runtime objects (created/destroyed during play)

These are the things that come and go during a tick:

| Object | Created | Destroyed | Purpose |
|---|---|---|---|
| **Population** | At `World.start` (from `PopInit`) and at runtime when a SubPop transitions to a new Syndrome that has no existing Population (`Site.addPop`, legacy 7270) | Never destroyed; populations of size 0 are kept in `pops_kv` so they can be revived | The atomic unit of "people who all behave identically" |
| **SubPop** | During `Population.updateTransmission` (`createPrimarySubpop`) at the start of each phase, and by `Population.updateContact` when infection would move some of its members into a different SubSyndrome | Consumed by `Population.updatePopulations` at the end of each phase, which moves their members into the appropriate Syndrome-level Populations | Bookkeeping for "how does this Population's trait composition shift inside a single phase" |
| **Shed** | (a) By `Population.updateTransmission` from each Transmit; (b) By `Site.updateTransmission` from any pending `PendingTransmission`s (set up by player actions/events on the previous day's lock-in or by event triggers); (c) By `Stockpile.doConsumption` to model the side-effects of consuming a resource | At the end of `Site.updateContact` for that phase: `this.shed = []` (legacy 7380). Sheds **never persist across days** unless their *creation* phase is later than their *infect* phase, in which case they sit in `shed` until the next day's earlier infect phase | A bag of identical viruses inside a Site. The Shed knows how many viruses, what traits they add/remove, what Vectors, and the Seek preferences |
| **PendingTransmission** | By player actions during `World.performPlayerActions` and by `EventResult.trigger` for transmission-flavored event results | Consumed (drained to `Shed`) by the next `Site.updateTransmission` for the matching phase | Lets non-Population sources (player actions, events) feed into the same shed-pipeline that Populations use |
| **SubSyndrome** | Lazily, by `World.getSubSyndrome` during `SubSyndrome.getContactResult` whenever an infection produces a never-before-seen trait combination | Never destroyed (interned for the rest of the run, cached in `world.subsyndromes_kv`) | Avoids re-walking the trait-state hashmap for every infection of every Shed against every Population |
| **NewsItem** | By events with news results (`EventResult`) | Drops off the bottom of the news feed UI | UI feedback only — does not affect simulation |
| **CustomMetric** | By the player via the calculator popup (`addCustomMetric` ClientMsg → `WorkerSim.addCustomMetricFromSpec` → `World.addMetric`). Replayed on `World.start` from `custom_metrics_prev` after a scenario reset | By `removeCustomMetric` ClientMsg | Player-defined daily-evaluated expression; appears as a trackable row alongside traits and resources |
| **Correlation Trait** | By the player via the correlation popup (`addCorrelation` ClientMsg → `WorkerSim.addCorrelationFromSpec` → `World.addCorrelationTrait`). Replayed on `World.start` from `custom_traits_prev` after a scenario reset | By `removeCustomTrait` ClientMsg | A real `Trait` flagged `is_correlation: true` with retroactively-rebuilt history; behaves like any other combo trait once added |

Note: **viruses are not tracked individually**. A Shed is the only "virus object" that exists, and it represents a count, not a list.

---

## 4. The flow of one day

**Entry point:** `World.newDay` (legacy 3984; modern `controller/World.ts:546`).

The day is divided into two macro-stages: **lock-in / record** (once, before phases run) and **per-phase processing** (looped per phase in `all_phases`).

### 4.1 Lock-in / record (runs once at the top of the day)

1. **`updateDisplayedHistoryValues`** — clamp negative stockpiles to 0 if their resource is unsigned, so the displayed history matches the simulation's view of stockpile floors.
2. **`performPlayerActions`** — for each `PlayerAction`, push a `PendingTransmission` for each of its Transmits into `site.shed_pending_phases[transmit.phase_index]` based on `current_value` (already locked in from the previous day). This is "the player's actions for *today* take effect now."
3. **`setAllActionsToValueClosestToDesired`** — copy `desired_value → current_value` for every action. *This* is the lock-in: it freezes the player's UI choices for the day to come. (Note: legacy logs every change here, so the lock-in is observable.)
4. **`addCurrentValuesToHistory`** — every Tracker writes today's value into its History so the graph has a sample for "day N before any simulation."
5. **`age++`** — advance the day counter.

After this point no further player input matters until tomorrow.

### 4.2 Per-phase loop (legacy `updateAllPhases`, 4061)

For each phase `p` in declaration order:

1. **Events**: `for event of phase.events: event.update()`.
   For each Event, if `global` it evaluates once, otherwise once per Site. Conditions are evaluated (mixed AND with optional OR, see §2.10), and on success each `EventResult` triggers (resource changes, news, action enable/disable, victory/defeat, fire transmission). `event.count` decrements (unless `-1`).

2. **Transmission generation** — `for site of sites: site.updateTransmission(p)`:
   - **Phase setup**: every Population calls `createPrimarySubpop()` so it has a fresh SubPop tree to mutate during this phase.
   - **Drain pending transmissions**: any `PendingTransmission` queued for this phase by player actions/events is converted into a `Shed` on the Site via `Site.addShed`.
   - `shed_pending_phases[p].length = 0`.
   - **Population transmissions**: for every Population registered in `site.pop_phases[p]`, run `Population.updateTransmission(p)`. This walks the Population's `transmit_phases[p]` (Transmit-derived `SynTransmit` records) and creates a Shed per Transmit (see §5.1 for the math), and also walks `progress_phases[p]` and pushes a Shed onto the Population's *own* `progress` list (NOT the site's `shed` list — Progress sheds stay local).

3. **Resource accounting** — both `global_stockpiles` and `local_stockpiles` per site:
   - `setImpactValue()` rolls the production from this phase into the stockpile's "incoming" total.
   - `doConsumption()` distributes the stockpile's value across the consumption requests (see §7).
   - When consumption fires, the Stockpile may itself create new Sheds and immediately call `Population.updateContact` to deliver them (legacy 9004-9061). This is the way "consuming this resource gives you a side-effect dose" works.

4. **Contact** — `for site of sites: site.updateContact()`:
   - First, every Population runs `updateProgression()`, which iterates its private `progress` list and calls `updateContact(shed.amount, shed)` on itself for each one (i.e., Progress is "the virus you released to yourself just hit you").
   - Then for every Shed in `site.shed`:
     - If the Shed has Seek constraints, walk every Population, compute `seek_mod = syndrome.getSeekMod(shed)` (multiplicative composition of Seek rules, legacy 10566), and build a weighted list `wa = pop * seek_mod` (skipping pops with `seek_mod === 0`).
     - Otherwise, weight each Population by raw `pop / total_pop`.
     - For each weighted Population: `amount = shed.amount * (weighted_amounts[i] / weighted_total)`. Call `Population.updateContact(amount, shed)`.
   - `site.shed = []`.

5. **Population reconciliation** — `for site of sites: site.updatePopulations()`:
   - Each Population walks its SubPops. For each SubPop whose SubSyndrome resolves to a different Syndrome than the parent Population's, the SubPop's units are moved into the corresponding Population (creating one via `addPop` if it doesn't exist). The original Population's `pop` shrinks; the destination's grows.

### 4.3 After all phases

- **`updatePopulationsHistory`** per site — record today's population values into per-Population history.
- **`addNewsItems`** — flush queued news to the UI.
- `age` is now committed; tomorrow can start.

---

## 5. The math (and why)

### 5.1 Shed amount (Transmit, Progress, Produce — all the same formula)

Legacy `script.js:8476, 8519, 8559`:

```
amount_shed = generateRandom(rate.value * pop, rate.sd * sqrt(pop))
```

where `generateRandom(mean, sd)` is a Box-Muller normal sampler (legacy 851) seeded by the World's `Random` (Park-Miller LCG, legacy 459). If `sd === 0`, returns the mean exactly.

**Why mean = `value * pop`**: rate is per-unit-per-day. For a population of `pop` units each shedding `value` viruses, the expected total shed is `value * pop`.

**Why sd ∝ `sqrt(pop)`**: if each unit's shedding is an independent Bernoulli/Poisson with per-unit variance `value`, the population-level variance is `value * pop`, so the population-level standard deviation scales as `sqrt(pop)`. Multiplying a per-unit `sd` by `sqrt(pop)` is the cheap normal-approximation way to get aggregate variance correct without sampling per unit. This is the simulator's central scaling trick — it's how the system stays accurate at arbitrary population sizes without tracking individuals.

The result is then optionally multiplied by `site.pop` if `popmult` is set (used by some player actions to make their effect proportional to site size).

### 5.2 Shed-to-population allocation (within a Site)

Legacy `script.js:7350-7378`. Two regimes:

- **No Seek constraints** → split by raw population fraction. Population *i* receives `shed.amount * (pop_i / total_pop)`.
- **With Seek constraints** → compute `wa_i = pop_i * seek_mod_i`, drop pops with `seek_mod_i === 0`, and split `shed.amount * (wa_i / sum(wa))`.

`seek_mod_i` is the multiplicative composition of all Seek rules on the Shed, evaluated against Population *i*'s Syndrome (`Syndrome.getSeekMod`, legacy 10566). Each Seek rule contributes a factor of `seek.mult` if its trait condition matches — by default 1 (no effect), <1 to deprefer, >1 to prefer.

**Why proportional**: within a single Shed, vectors choose targets uniformly at random over weighted population units. Expectation of "fraction landing on pop i" is `wa_i / sum(wa)`.

### 5.3 Number of units hit inside a Population

Legacy `Population.getNumberHit` (8586) and modern `Population.ts:342`:

```
p   = (1 / pop) * hitChance        // per-vector probability of hitting any given unit
prob = 1 - (1 - p)^vectorCount      // probability a given unit is hit by ≥1 of the incoming vectors
hit  = pop * prob                   // expected number of units hit
```

`hitChance = modified_shed.multiplier`, the product of all matching `ContactModifier`s on the population's Syndrome (legacy 10615-10648). For `precise` sheds (Progress always, plus opt-in Transmits), this whole branch is skipped: `hit = vectorCount * hitChance`.

**Why this formula**: each of the `vectorCount` viruses picks a target uniformly at random over `pop` units (probability `1/pop` per unit per vector), modulated by the susceptibility multiplier. Per-unit "infected by at least one" is geometric: `1 - (1-p)^vectorCount`. Expected hits is just `pop * prob`. This is the mean of a binomial(`pop`, `prob`).

**Note on stochasticity**: this returns the *mean*, not a binomial sample. The randomness in the simulation comes from the upstream `generateRandom` on the shed amount — once that draws an amount, the downstream infection is fully deterministic except for the fractional-rounding tiebreak (`amount_moved_exact - amount_moved` compared against `rand.get()`, legacy 8619). This is intentional: at large populations the binomial collapses to its mean and the `sqrt(pop)` shed-amount sd captures the variance that matters.

### 5.4 Hit distribution across SubPops within a Population

**Snapshot/delta model (current).** Within a phase, every Population starts with a single primary SubPop containing all of its units (created by `createPrimarySubpop` at the top of every phase). When a Shed hits a Population, `Population.applyShedToDelta` writes a single entry to the phase's `PhaseDelta`:

```
delta.popShifts[popKey][primary_subsyndrome.key][target_subsyndrome.key] += hitCount
```

No SubPop or population state is mutated during the kernel. At end of phase, `World.applyPhaseDelta` materializes any newly-required SubSyndromes and calls each Population's `applyDeltaToSubpops`, which:

1. Iterates `delta.popShifts[popKey]`.
2. For each `(source, target, amount)` entry: `moved = floor(amount); moved += rngDraw(...) < (amount - moved) ? 1 : 0`. Cap at `sourceSub.pop`.
3. `sourceSub.pop -= moved; targetSub.pop += moved` (creating `targetSub` if needed).

The fractional-rounding RNG draw is a counter-based hash of `(seed, day, phase, popKey, "source->target")`, so two clients with the same seed see identical draws regardless of iteration order.

**Why this layer**: order-independence. Snapshot semantics decouple the result from the order in which sheds, populations, and consumption requests are processed within a phase. (Across phases, ordering remains meaningful — see §10.) The legacy "split SubPops in place per shed" approach worked but produced different results under reordering; this model produces the same result regardless of the order in which the kernels write to the delta.

### 5.5 Trait state transitions — the "removal wins" rule

Legacy `SubSyndrome.getContactResult` (8184-8233) and modern `SubSyndrome.ts:54-116`:

```js
// Step 1 — apply additions (modern; legacy used `!== 0`, see note)
for k in trait_keys:
    if new_trait_states[k] !== 1:   // missing/cured → set to 1
        new_trait_states[k] = 1

// Step 2 — apply removals (cures)
for k in cure_keys:
    if new_trait_states[k] !== 0:
        new_trait_states[k] = 0
```

Removal happens *after* addition with no gating, so if the same trait `k` is in *both* the Shed's `trait_keys` and `cure_keys`, the trait ends at `0`. **Removal wins.** ✓ (matches the design rule in CLAUDE.md).

**Intentional divergence from legacy.** Legacy used `!== 0` in the addition loop (`script.js:8198`), which silently turned cures into *permanent immunity to re-infection*: a trait set to `0` could never become `1` again, even by a fresh exposure. Modern uses `!== 1`, which preserves the "removal wins" tie-break and the `1 → 1` no-op while restoring `0 → 1` re-infection. The legacy semantic is treated as a long-standing bug.

### 5.6 Modifier composition

All modifiers are multiplicative. A Syndrome's effective rate for a given Transmit is:

```
eff.value = transmit.value * Π(numeric_mods.mult) * Π(stockpile_links.value)
eff.sd    = transmit.sd    * Π(numeric_mods.mult) * Π(stockpile_links.value)
```

Legacy applies the static (numeric) part once at Syndrome construction (10412-10477) and the resource-dependent part each tick at SiteTransmit (10226). ContactModifiers compose into a single `multiplier` evaluated against each Shed via `Syndrome.getContactMod` (10615).

**Why multiplicative**: rate factors compose by multiplication if each represents a fractional change ("vaccination cuts transmission to 30%" → ×0.3). Additive composition would not be order-independent in a simple way and would not commute with the resource-dependent factors.

### 5.7 Resource production / consumption

- **Production**: same shed formula `generateRandom(value * pop, sd * sqrt(pop))`, but the result is added to the stockpile via `addImpactValue` instead of becoming a Shed (legacy 8540-8569).
- **Consumption**: each consuming Population posts a *request* to the Stockpile (`makeConsumptionRequest`) with a weighted amount. After all populations have requested, the Stockpile's `doConsumption` either:
  - fulfills all requests at face value (if the stockpile holds enough) and subtracts the total, or
  - distributes proportionally by request weight (if it doesn't).
  Each request, on fulfillment, may construct a Shed and immediately call `Population.updateContact` — this is how "consuming this resource has a viral side-effect" is modeled (e.g. taking medicine that gives partial immunity).

The two-pass request-then-fulfill design is what makes consumption order-independent across populations within a site: every population's request is logged before any is honored.

### 5.8 RNG

One seeded Park-Miller LCG (`Random`, legacy 459) covers everything stochastic. `Math.random()` is used exactly once: as the seed if no seed was supplied. Given the same seed and the same scenario, the simulation is fully reproducible.

---

## 6. Object lifecycles per day, in one place

For a Site with `S` shed-creating Populations across `P` phases, on a given day:

- **Created**:
  - 1 SubPop per Population at the start of each phase (`createPrimarySubpop`).
  - 1 Shed per Transmit-instance per Population per phase (only if `amount_shed > 0`).
  - 1 Shed per Progress-instance per Population per phase (likewise).
  - Up to 1 PendingTransmission per PlayerAction × Transmit (drained inside `updateTransmission`).
  - 0 or more transient Sheds per Stockpile.doConsumption call.
  - 0 or more new SubPops during `Population.updateContact` whenever a Shed transitions some members into a not-yet-seen SubSyndrome.
  - 0 or more new SubSyndromes (interned globally — created once per novel trait-state combo *ever*, then reused).
  - 0 or more new Populations during `updatePopulations` if a SubSyndrome resolves to a Syndrome with no existing Population at the Site.
  - 1 history sample per Tracker.

- **Destroyed (or reset)**:
  - All Sheds at end of `Site.updateContact` for the phase.
  - All PendingTransmissions for the phase (drained).
  - All SubPops are folded back into Populations at end of phase via `updatePopulations`.

Populations and SubSyndromes themselves are never garbage-collected; they're interned for the lifetime of the run.

---

## 7. Stockpile flow (close-up, because it's subtle)

For each phase `p`:

1. (During `Population.updateTransmission`) Each Trait's `Impact(Produce)` adds `generateRandom(value*pop, sd*sqrt(pop))` to the stockpile's `pending_impact_value`.
2. (Same loop) Each Trait's `Impact(Consume)` calls `stockpile.makeConsumptionRequest(this, transmit)`, which records `{population, siteTransmit, weighted_amount, amount_requested}` in the stockpile.
3. After all populations have processed transmission for this phase, `World.updateAllPhases` calls `stockpile.setImpactValue()` (commits production into the stockpile's value) and then `stockpile.doConsumption()`:
   - If `total_requested ≤ current_value`: pay every request in full, subtract total, optionally turn each request into a Shed delivered immediately to the requesting population.
   - Else: distribute proportionally by `weighted_amount / weighted_total`, stockpile drops to 0.
4. `resetConsumptionRequests` clears the request list for the next phase.

This design is what makes resources fair: nobody gets paid first, everybody's allocation depends on the full request set.

---

## 8. Player actions, in detail

The player-facing UI binds to `desired_value`. The simulation only ever reads `current_value`. The `desired_value → current_value` copy happens **once per day, at the very top of `newDay`** (legacy 3996, before any phases run).

This is how the design rule "actions are locked in at the beginning of a day" is enforced: a slider tweak at any time during the day goes only into `desired_value` and is invisible to the simulation until the next morning. Lock-in is also where ActionCost gets paid (`PlayerAction.change`, legacy 6952-6993, which validates resource availability and may reduce the effective `current_value` to a `cost_capped_value` if the player can't afford the full request).

Then, also during lock-in, `performPlayerActions` walks every action and pushes a `PendingTransmission` for each Transmit into the matching phase's queue. The PendingTransmissions are drained the first time `Site.updateTransmission` runs for that phase.

---

## 9. Events

Events fire once per day per Site (or once globally). Per legacy 4064-4065, events run *before* transmission generation in a phase. Their results can:
- Modify resources directly.
- Push news items.
- Enable/disable PlayerActions.
- Trigger transmissions (via `EventResult.trigger` posting `PendingTransmission`s — this is the only other source of pendings besides player actions).
- Win/lose the scenario (sets `world.scenario_complete`).

Conditions: `condition.isTrue(site)`, with AND-by-default and OR for entries with `or === true`. Counted via `event.count` decrementing (or `-1` for unlimited).

---

## 10. Phase ordering and "addToPhase"

Every Trait's Transmit/Progress/Impact, every Event, and every Syndrome that ever does work registers itself with `World.addToPhase(obj, phaseKey)`. This:
- Looks up the existing IndexedPhase by key (or creates one and appends to `all_phases`, assigning the next index).
- Appends `obj` to the appropriate typed list inside the IndexedPhase (`transmit`, `progress`, `events`, etc.).

The `index` returned is what gets stored on the object (e.g. `transmit.phase_index`) and indexes per-population per-phase arrays like `pop.transmit_phases[index]`. So phase ordering is established purely by **declaration order in the scenario** — the phase that appears first in the scenario runs first each day.

---

## 11. Order independence

CLAUDE.md states:
> The sequence in which traits and vectors are listed should be arbitrary, so we need to make sure that the order in which processes happen does not change the outcome.

**The modern port now satisfies this rule within a phase.** The simulation has been restructured into a *snapshot-read / delta-write / batch-apply* loop per phase:

1. **Snapshot read.** At the start of every phase, `Site.updateTransmission` calls `Population.createPrimarySubpop` for every Population, producing a single primary SubPop per Population. During the phase, kernels read population state via `this.pop` and `this.primary_subsyndrome`, both of which are frozen (no kernel mutates them).

2. **Delta write.** Every kernel that previously mutated state — `Population.applyShedToDelta` (was `updateContact`), `Population.applyProgressionToDelta` (was `updateProgression`), `Stockpile.doConsumption` — now writes its results into a per-phase `PhaseDelta` instead. Writes are commutative: the order in which kernels run cannot change the delta's final state.

3. **Batch apply.** At end of phase, `World.applyPhaseDelta` materializes any new SubSyndromes referenced by `delta.popShifts`, then calls each Site's `applyPhaseDelta`, which routes shifts into subpops with a single rounding step per `(source → target)` pair.

**RNG decoupling.** Phase A introduces `HashRand` (`src/core/HashRand.ts`), a counter-based PRNG keyed by a tuple `(seed, day, phase, popKey, "source->target")`. Rounding draws use this directly. The order in which draws are issued cannot change their values, because each draw is a pure function of its key tuple. (The legacy `Random` LCG remains in use for non-simulation code paths and is itself unchanged.)

**Multiplayer determinism.** Two clients running the same scenario with the same seed will now produce identical state regardless of iteration order. Before Phase A, this was not guaranteed: the LCG advanced state in the order draws happened, so any reordering of populations or sheds gave a different result.

**Cross-phase ordering is preserved by design.** Phase order is meaningful: an earlier phase's effects (popShifts applied, stockpile values updated) are visible to later phases of the same day. CLAUDE.md treats the *sequence of agent processing* as arbitrary; the *sequence of phases* is part of scenario semantics.

**Pre-existing gap, unrelated to Phase A:** `Site.initPopulation` is declared in the interface but not yet implemented on `Site` in the modern port (legacy `script.js:7131-7252`). When that method is ported, it should be aware that the new world-level `applyPhaseDelta` is the canonical apply step; one-shot initial-contact logic can either inline the snapshot+delta flow or call into a small helper that exposes it.

---

## 12. Modern port: divergences from legacy

This section tracks every place the modern TypeScript port differs from the legacy `script.js`, separated by intent. **Fixed** items are completed work. **Intentional divergences** are knowingly different from legacy (usually because legacy itself was buggy or incomplete). **Open** items are still work to do.

### 12.1 Fixed — `Site.updateContact`/`updatePopulations`/`updatePopulationsHistory`

Legacy `script.js:7338-7396`. Previously missing on `Site`; `World.updateAllPhases` called them and would have thrown at runtime. Now implemented in `game/world/Site.ts`, mirroring legacy:

- `updateContact` — runs each population's `updateProgression`, then for each shed computes seek-weighted distribution across populations (or pop/total_pop weighting if no seek) and dispatches to `Population.updateContact`. Resets `shed` and `shed_keys` at end.
- `updateProgression`, `updatePopulations`, `updatePopulationsHistory` — thin wrappers that loop populations.

### 12.2 Fixed — all six modifier types are now wired in Syndrome

Legacy `script.js:10405-10551`. Previously only `progress_mod` was applied; `transmit_mod`, `produce_mod`, `consume_mod` had a "// Similar..." placeholder. Now `applyModifiers` in `game/simulation/Syndrome.ts` runs the same per-trait/per-mod loop for all four target types via a shared helper. `contact_mod` is applied at runtime in `getContactMod` (was already correct). `impact_mod` is not a separate class in either codebase — `Impact` (produce/consume) is modified by the produce/consume mod paths.

### 12.3 Intentional divergence — non-blocking modifier multipliers are now applied

Legacy populates `value_multipliers` (per-trait Map) for `bloc=false` traits but **never reads it anywhere** — the data is dropped. This means non-blocking modifiers had zero effect even in the source of truth. Modern now folds the Map's values into the target's `value` after the per-trait loop (`Syndrome.ts:foldMultipliers`). For numeric multipliers this makes `bloc=false` functionally equivalent to `bloc=true`; the per-trait Map is preserved as an accumulator for future GPU/parallel work or selective disable logic. SD is left alone, mirroring legacy's bloc/non-bloc asymmetry.

### 12.4 Intentional divergence — cure no longer grants permanent immunity

`SubSyndrome.getContactResult` previously matched legacy's `!== 0` check, which prevented `0 → 1` transitions and effectively gave cured units permanent immunity to that trait. Modern uses `!== 1` (treat-as-no-op-when-already-present), which preserves "removal wins" while allowing the unit to be affected again. See §5.5.

### 12.5 Fixed — global EventResult transmissions fan out to all sites

Legacy `script.js:7991-7993`: a global event with `type: "transmit"` pushes its PendingTransmission into every site's `shed_pending_phases`. Modern previously had `&& site` and silently dropped global events' transmissions. Now `EventResult.ts` fans out to `_resultWorld.sites` when `site` is null, with per-site `popmult` (legacy used the null `site.pop`, which would have been NaN — modern is strictly more correct here).

### 12.6 RNG note (not a divergence)

Both legacy `getNumberHit` (8591) and modern `Population.ts:342` return `targetCount * prob` — the **mean** of the binomial, not a sample. This is correct given that upstream shed amounts are already drawn from a normal with `sd = sd * sqrt(pop)`. No action needed; flagged here so future readers don't "fix" it.

### 12.7 Open — Imply

`game/transmission/Imply.ts` exists, parses fields, and is referenced by Trait/Vector setup. No runtime path consumes it in either legacy or modern. Treat as latent partial implementation. Per design intent (per the project owner), this is to be revisited later once its purpose is recovered.

### 12.8 Superseded — PopBranch/PopCluster hierarchy → trait clustering

Legacy has `PopBranch`/`PopCluster` for hierarchical population organization (a *tree* of clusters-within-clusters). Modern flattens to `subpops: SubPop[]`; the legacy tree is the **wrong shape** and stays retired (`src/game/simulation/Cluster.ts` is dead stub code — do not resurrect).

The optimization concept it was reaching for is being rebuilt as **trait clustering**: a *flat partition* of traits into independent factors (a factored joint distribution), splitting/merging dynamically. Design, criterion, reachability terminal-exit detector, split gates, and adversarial validation: `planning-docs/clustering-design.md`. **Phases C0–C1 landed** (`src/sim/clustering/`, all behind the `WorkerSim.clustering` toggle, default off; `setClustering` ClientMsg / `clusterReport` WorkerMsg):
- **C0** `ClusterDetector.ts` — static cluster detection (coupling graph + reachability terminal-exit detector).
- **C1** `ClusterPartition.ts` (projects syndromes onto clusters, over BASE traits only; living-vs-absorbed split via membership trait) + `ClusterVerifier.ts` (`verifyFactorization` — shadow-projects the live joint onto the partition and measures factorization residual + storage saving). Verification rides the `clusterReport` (`verification` field). Demonstrated 2× state reduction (16→8) at residual 6e-5 on a synthetic 3-cluster scenario; COVID factors validly with a modest ~15% saving.
- **C1.x** factorization monitor (`WorkerSim.afterDay`) — re-verifies after every simulated day while clustering is active; on a rising-edge residual breach (default >0.05) it alarms and re-emits the report. The standing runtime edge-case net: catches couplings the static detector misses, including **initial-state correlation seeded by a scenario** (the detector reasons from rules, not state). Partition is built once at boot and not rebuilt mid-scenario.

The `WorkerSim.clustering` toggle is a **boot/test affordance, not a mid-scenario switch** — clustering is intended to be always-on in shipping; the flag exists so tests can run with it off. - **C2a** factored evolver (`scenarioProjection.ts` + `FactoredEvolver.ts`) — evolves each cluster's marginal in its own small sub-World running the real engine (no math re-implemented). Proven to reproduce the joint engine's marginals to 0.0029% of N (sd=0, independent partition) — the correctness gate for replacing joint tracking. `WorkerSim.buildClusterEvolver()` builds it on demand; falls back (returns null) when the partition has exit/death coupling. Joint engine still authoritative (evolver is the verified substitute-in-waiting; no per-day overhead yet).

- **C2b** cross-cluster full-strip removal glue (death/emigration) in `FactoredEvolver` — modeled generally as a *region transition* (unit changes membership across clusters at once). Because such removal is uniform (non-uniform forces a merge), follower clusters' distributions stay correct and only the scalar living total needs reconciling: `trueLivingN()` + read-time marginal scaling, no sub-World mutation. Dual-track vs joint with 100k deaths: 0.0053% divergence. Detector tests confirm `hospitalized` (data-retaining) is never treated as a removal — it merges if it spans, stays within-cluster otherwise.

- **C2b-rest** generalized living-total reconciliation: `trueLivingN = B + Σ_owner(rawMass − B)` where B is the replicated baseline and owners are clusters with a non-membership trait that changes membership. Handles recurring immigration (growth, +12.7% at 6e-4% divergence) and multi-source death (two independent sources, 0.03% divergence) in addition to single death.

- **C2c** shared stockpiles (the aggregate-coupling channel): projection keeps resources in every sub-World; the evolver reconciles each shared stockpile via delta-sum (true value = baseline + Σ per-sub-World net production/consumption), giving cross-cluster readers a one-day lag (consistent with daily lock-in). Validated dual-track: a resource produced by disease and read by politics keeps the clusters separate and matches the joint at 0.047% of N.

- **C2-final** authoritative flip: `FactoredEvolver` gains an output API (`traitLivingCount` / `syndromeCount` — reconstructs cross-cluster combos from marginals without materializing the joint / `resourceValues`). `WorkerSim` runs a promotion gate — first `clusterWarmupDays` run both engines; promote to evolver-only iff max(evolver-vs-joint marginal residual, joint factorization residual) stays under threshold (the factorization check is what catches seeded correlation that marginal-match misses). On promotion the joint freezes and `advanceDay` runs sub-Worlds alone (the cost saving); `syncJointFromEvolver` reconstructs living pops + resources each day so the snapshot path is unchanged. Failure → drop evolver, stay on joint (safe fallback). Validated: factorable scenario promotes (residual 1.5e-4, reconstructed totals match joint-only <1%); seeded-correlated refuses (residual 0.24).

- **C3** dynamic split/merge on resource-gated edges: `detectClusters`/`buildPartition` compute the ACTIVE partition for current resource values (a resource-gated modifier is inert at value≈1); `FactoredEvolver.repartition(targetGroups, eps)` reconciles sub-Worlds to it — MERGE rebuilds from the outer product (always safe), SPLIT factors a joint into marginals gated by `factorResidual<eps` (refuses while still correlated). `combinedCount` reads cross-cluster counts correctly in both merged and split regimes. Validated (`dynamicRepartition.test.ts`): a gated coupling driven 1→2→1 splits-while-off, merges-on-activation, splits-back-after-decorrelation, never merges the uncoupled cluster, tracks the joint within 0.9% of N. Two subtle fixes: drop `site.transmit` on rebuild (else initial injection double-fires) and dedupe membership in rebuilt startpops (the `is_alive` seek pulls `alive` into the disease cluster).

Re-partition is **wired into the `WorkerSim` day loop**: `advanceDay` calls `repartitionEvolver()` before each evolver step (warmup and post-promotion), rebuilding the active partition from current resource values and merging/splitting to match; skipped when the scenario has no resource-gated edges. The evolver is built from the active partition at boot, and the promotion gate uses a partition-independent `reconstructionResidual` (does `syndromeCount` reproduce the joint's living pops?). Validated end-to-end through the real `step` loop (gate driven 1→2→1: promotes, merges-on-activation, splits-back, tracks joint-only within 0.9% of N).

The `WorkerSim.clustering` toggle is a **boot/test affordance, not a mid-scenario switch** — clustering is intended to be always-on in shipping; the flag exists so tests can run with it off. **The full C-series (C0–C3) is complete and loop-integrated**: trait clustering is detected, validated, run on the cheaper factored representation (with safe joint fallback), and dynamically re-partitions in the day loop as resource-gated couplings toggle mid-run. Deferred edges (none blocking the core): hysteresis to damp split/merge thrash near the band; caching the per-day active-partition detect; absorbed/dead per-syndrome breakdown post-promotion; player-action + history/tracker snapshot parity (UI integration); consumption rationing under scarcity; trait-rate birth follower injection; fear-style aggregate sheds. See `planning-docs/clustering-design.md`.

### 12.9 Resolved — previously-suspicious items

- **Phase-coupled Production** — fine. `Population.updateTransmission` calls `updateProduction` and `makeRequestsForConsumption` (line 294-295), matching legacy 8535-8536. World then calls `setImpactValue`/`doConsumption` on stockpiles. Order matches.
- **`units[0]` loop in `Population.updatePopulations`** — not a bug. `Unit.changePop` removes the unit from `this.pop.units`, so `units[0]` advances naturally per iteration. Legacy 8677 has a commented-out `Math.floor(rand.get() * units.length)` variant confirming the deterministic FIFO is intentional.

---

## 13. Status and what's next

**Closed:** cure-immunity bug; missing Site methods (`updateContact`, `updatePopulations`, `updatePopulationsHistory`, `updateDisplay`, `updateLocalHistory`, and `initPopulation`); modifier completeness; non-blocking multipliers; global EventResult fan-out; previously-suspicious items; Phase A order-independence; Phase B1 TypedArray PhaseDelta + integer IDs; Phase B0 headless runtime; browser runtime baseline (vite + index.html + main.ts); Phase B2 Web Worker offload (SimClient + WorkerSim + protocol); COVID-19 stress scenario; Phase B3 foundation (GpuContext + GpuKernel + shed-amount WebGPU kernel + CPU fallback + Bench button); Phase B3.1 (seek-weight kernel + 64-bit trait bitmask infrastructure); Phase B3.2 (SubSyndrome consolidation + applyShed kernel — three GPU kernels now cover the day loop's hot per-pair math); **`getAttrs` / `AttrDef` removal** — the legacy stringly-typed `BWObj` loader has been deleted. Sim classes now parse their own JSON in their constructors via the helpers in `src/core/parse.ts` (`strVal`, `intVal`, `numVal`, `boolVal`, `arrayVal`, `numOrSelectorVal`, `parseColor`, `parseChildren`, etc.). `BWObj` retains only runtime lifecycle (parent/child links, sounds, `update*`, `destroy`); `save` / `getData` / `copy` / `attrChanged` / `edit` are gone. `AttrDef`, the `TYPES`/`AttrType` constants, the `WorldBuilderLike` shim in `types/interfaces.ts`, and the BColor self-registration cycle have all been removed.

**Deferred:** Imply (recover original intent later); legacy UI port (`Screen`/`Graph`/`Visualizer`/`PanelsGUI`/`WorldBuilder` and the canvas rendering stack — its own future project); replace the `documentShim` worker tactic with a proper headless System path.

**Phase B3.x (next):** more kernels. The foundation (GpuContext / GpuKernel / collect-dispatch-apply pattern) is in place; adding kernels is mostly WGSL + a few JS lines per kernel. Candidates in rough cost-benefit order: seek-weight × population allocation (high benefit, moderate complexity), per-shed reduction by target subsyndrome (requires reduction primitive), `Population.applyShedToDelta` math (parallel over (shed × population × subpop) tuples, also requires reduction). B1c (per-Population pop counts in flat TypedArrays at World level) becomes relevant when these later kernels need GPU-resident state. SharedArrayBuffer + CORP/COOP headers become relevant when we want to skip the round-trip readback between kernels.

See `C:\Users\Daniel\.claude\plans\fancy-crafting-scott.md` for the latest plan.

---

*Document grounded in legacy `script.js` line numbers and modern `src/` file:line citations. Treat any line-number drift gracefully.*
