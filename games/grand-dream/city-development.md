# City Development: the Settlement as a Fractal

Brainstorming doc for how cities are STRUCTURED, how they DEVELOP, and how
they LOAD. Companion to unified-world-model.md (the four engines and the
day-boundary contract), world-content.md (substrate fields, processes, flow
nets), and timescales.md (providers behind field-schema seams — this doc is
that idea applied one level down).

Status: brainstorm. Sections 1–4 are converging; 5–8 are genuinely open.

---

## 0. Where this comes from (honest state of the shipped thing)

What ships today (step 7 + food economy + town streets):

- ~~One polar template per town: plaza, concentric house rings, four
  spokes~~ **REPLACED (2026-07-06, `streets.ts`)**: towns grow as an
  ORGANIC STREET TREE from the plaza — a deterministic growth-event
  stream whose emitted frontage slots ARE the prefix-stable lot
  sequence, so the layout is literally its own development history (§2b
  below, landed one level early). Works cap the outer street tips;
  street width follows shopping traffic (§3b, real); markets are founded
  by unserved demand (§2c/step 1). The plaza keeps hall + central market.
- Street life is a **clock projection**: every house has a deterministic
  shopping cycle, a closed-form function of (site scalars, house index,
  wall-clock). Pantries, market stock, and walkers are all *derived*; no
  item ever moves. Bodies embody the projection near the player and are
  kept in step with it (same walking speed, dwell at the stall).

The projection is the right **cheat provider** (timescales.md §2): instant,
stateless, streams at any city size, identical on every visit. Its honest
limits, which motivated this doc:

- **Nothing is caused.** A market's stock is a formula, not the sum of
  deliveries that arrived. Rob the granary and nothing downstream changes.
- **Monocentric.** One plaza, one market — a 10k-soul city should have
  neighborhood markets, and WHERE they sit should follow from supply and
  demand, not from the template.
- **Person-first bookkeeping.** Per-house schedules are elegant at 600
  houses but upside-down at scale: the city-level truth (how much grain
  moves down which street) is *derived from* thousands of individual
  schedules, when causally it's the other way round.

The correction is not "simulate every person." It is to make the city the
same shape as the world it lives in.

---

## 1. The fractal claim

The world model is already one pattern applied at one scale:

> **aggregate scalars** (site population, food_out, food_need)
> → **graph of parts + steady-state flows** (sites, routes, flow nets,
>   roads worn by use)
> → **embodied instances sampled from the flows** (traveler bands,
>   caravans-as-render-field, villagers near the player).

The claim: a city is the same pattern, one level down. And a district is
the same pattern one level below that. Fractal, concretely:

| level | aggregate | graph of parts | flows on the graph | embodied |
|---|---|---|---|---|
| world | site scalars | sites + routes | food/ore/metal nets, roads | caravans, traveler bands |
| **city** | district scalars | **districts + streets** | intra-city goods nets, street wear | carters, shoppers, porters |
| district | building scalars | buildings + lanes | household draws, workshop inputs | residents at their doors |
| building? | room scalars | rooms + doorways | meals, tools, sleep | one family's evening |

Each level's **truth is the level above it**. Each level solves a
steady-state flow on its own small graph. Embodiment *samples* flows near
the player. Interference by the player writes back **as a day-boundary
delta to the level above** — the exact discipline the dual world already
uses between Settlement and Composition.

In timescales.md language: each row is a **seam** (a field schema: traffic
per street, stock per market, occupancy per building), and each seam can be
served by a cheat provider (today's clock projection) or a simulate
provider (flows actually moving quanta). Consumers above must not be able
to tell. The player's presence is the **refine trigger** (§6 there):
distant cities run the cheat; the city you stand in runs the finest
provider you can afford, seeded from the cheat's state.

---

## 2. Districts: the city's large-scale map comes first

Generation order inverts today's: instead of houses-then-works-on-a-ring,
generate the **district map** first, then streets, then buildings inside
districts, then people. Producers, residential areas, and the marketplaces
where they trade are the city's coarse anatomy.

### 2a. What a district is

A node with a **type mix** and a **resource balance** — deliberately the
same shape as a settlement entity, so the machinery recurses:

- `kind` weights: residential / farm belt / mining / crafts / market /
  civic (a district is a MIX, not an enum — a market square has homes
  above the stalls).
- scalars: population share, production vector (grain out, ore out...),
  consumption vector (food need ∝ its residents), storage (granary,
  pantries in aggregate).
- The district vector sum across the city MUST equal the site's scalars —
  apportionment, not new state. The site remains the only persistent
  truth; districts are a **derived decomposition** (re-derived on load,
  like town plans today). A city with no player in it has no districts in
  memory at all.

### 2b. Where districts come from (development story, not layout template)

Seeded growth that mimics how cities actually accrete, so the map READS as
development history:

1. **Founding kernel**: the charter picks the seed — river-crossing plaza
   for a farm town, pithead for a mining town. First district = mixed
   core (the current polar template is exactly this one-district city —
   the degenerate case, which is why the shipped geometry survives as the
   core district's local layout).
2. **Accretion**: as population grows, new district seeds attach where
   their inputs are — farm belts toward fertile tiles, mining quarters
   toward ore, residential infill between work and food, crafts along the
   busiest street (flow-following, see §3). Each seed appends to a stable
   ordered list keyed by the pop threshold that spawned it →
   **prefix-stable** exactly like house lots: growth adds districts,
   never reshuffles the ones the player knows.
3. **Partition**: district areas = weighted Voronoi cells around seeds
   (weight = district size). Open question (§8): keeping cell boundaries
   stable as seeds append — candidate rule: a new seed may only claim
   territory from the OUTER free ring plus a bounded bite of its parent,
   never redraw distant cells.

### 2c. Markets form dynamically (the user's core point)

No market-by-threshold. A market is a **facility that flows create**:

- Every residential district has demand mass; every market/farm-gate has
  a service area (walk radius on the street graph).
- **A new market seeds where unserved demand mass exceeds a founding
  threshold** — demand-weighted distance to the nearest existing source,
  the same founding-score idiom `findFoundingSites` uses on the substrate.
- Market SIZE (stall count, stock capacity) = the flow actually routed
  through it by the solve in §3. A market that loses its hinterland to a
  newer, closer one visibly shrinks (stalls board up) — decline for free.
- Consequence: polycentric cities emerge — a granary market by the river
  gate, a produce square in the farm belt, a company store at the pithead
  — placed by resource availability, not by template.

---

## 3. Streets and traffic: flows first, geometry second

### 3a. The district graph is a small EntityWorld

Districts = entities, streets = edges. This is deliberately the SAME spec
shape as the settlement layer (world-content.md §3): processes per district
(farm belt: farmland → grain; mill; kitchen demand ∝ residents), flow nets
per commodity over street conductance, `satisfied` writing each district's
fill. Reuse, not rebuild — triBase() in miniature, instantiated per loaded
city, derived from site scalars, thrown away on unload. Idle-safe by
construction because it is *stateless between visits*.

### 3b. Traffic is the flow field made visible

- Per-street **expected traffic** = Σ over commodities of |flow| ÷ load
  per trip, plus commuters (residents working in another district), plus
  shoppers (household draws on their market). This is "probable traffic
  at any given moment" — a RATE PER STREET, modulated by a time-of-day
  curve (dawn deliveries, midday shopping, evening lull) on the street
  clock (`FOOD_DAY_SEC`).
- **Street prominence follows traffic** (the road-wear rule recursed):
  arterials are not drawn as arterials, they *become* arterials because
  district-pair flows concentrate on them. Render width/wear from the
  same field. A new market re-routes flows → the street to it widens over
  game-days. **SHIPPED (2026-07-06) at the household level**:
  `food.streetTraffic()` counts every household's trip along its street
  path and the world view draws width/opacity from it (the trunk streets
  visibly widen; a founded stall's catchment re-routes and the wear
  follows). The full commodity-flow version arrives with tier B.
- Mid-zoom rendering samples the traffic field directly (dots per street
  ∝ rate) — the traveler-band pattern generalized: no identity, no
  schedule, just the field. Cheap at any city size.

### 3c. Embodiment near the player: flow-first, person-second

Within PEOPLE_R, walkers are **samples of street traffic**, not owners of
house schedules: seeded (street segment, time bucket, slot) → deterministic
"who is on this street now" with zero per-person state. Identity attaches
lazily ONLY on engagement: the player talks to a walker → resolve them to a
household in the origin district (deterministic sample, like
`sampleVillager`) → from that moment they are person-first (recruitable,
pinnable — the existing histfig path). The current per-house cycle survives
INSIDE the core district at close range — your own street stays fully
person-first (stable neighbors at stable doors); the fractal takes over
beyond it. This is the same person/flow boundary the world already has
between residents and traveler bands, moved inside the city.

### 3d. Items actually move (the causality upgrade)

The decisive break from the clock projection:

- Commodity flows are **quantized into hauls**: a cart = N units of grain,
  a porter = a basket. The day's flow on a street = a schedule of haul
  departures (deterministic within the day, Poisson-shaped by the curve).
- **Conservation at the district-day level**: market stock = yesterday's
  stock + hauls in − draws out. The stock formula is REPLACED by a ledger
  whose entries are the very hauls the player can watch arrive. (Fill
  still anchors it: what the flow net delivers city-wide is still
  `food_got` — districts share it out.)
- **Interference writes back**: inside the loaded bubble the hauls are
  real engine objects (carry-able, blockable, robbable). A stolen cart is
  a delta on the district ledger at the next day boundary → that
  district's fill dips → its residents' pantries and trips respond next
  day. Outside the bubble, the cheat provider keeps generating the same
  seam (stock curves, traffic rates) — provenance-independence means
  nobody above can tell.
- Player-scale economy falls out: BUY at a stall = a draw with payment; a
  hungry party actually competes for scarce stock in a starving town.

---

## 4. How it loads (the tier ladder, revised)

| tier | radius | what materializes | cost model |
|---|---|---|---|
| A | always | site scalars (exists) | O(sites), the only persistent state |
| B | TOWN_LOAD_R | district decomposition + street graph + flow solve → traffic rates, market set/sizes, per-district building counts | O(districts+streets), once per load + on day boundary |
| C | camera | building footprints inside VISIBLE districts (prefix-stable lots in district-local frames) | O(visible buildings) |
| D | PEOPLE_R / STRUCT_R | walls+doors, embodied walkers sampled from traffic, hauls as real objects, person-first core street | bounded by NPC cap |

Notes:

- Tier B is the new layer. Everything in it is a pure function of (site
  scalars, seed) *plus the sparse delta ledger* (below) — so a city still
  costs nothing while nobody is there.
- **Sparse delta ledger** (the one concession to persistence): player
  interference and rare events (a burned district, a robbed granary)
  append (district, field, delta, day) rows kept per site — tiny, replayed
  onto the derived decomposition at load. Re-derivation stays the rule;
  history is the exception, stored as diffs. Expiry: deltas decay/absorb
  into site scalars at day boundaries (a stolen cart is site-level truth
  after one day: `food_got` was lower; the DISTRICT attribution can fade).
- Determinism contract per tier: same scalars + same seed + same ledger ⇒
  byte-identical district map, streets, market set, traffic rates. Tests
  mirror the existing town-plan/prefix-stability suites one level up.

---

## 5. Development over time (cities that visibly grow)

Because districts key on population thresholds and flows, development is
watchable at the map scale without any new machinery:

- pop ↑ → next district seed fires → construction fringe at the edge of
  its cell (render: scaffold-colored lots before houses).
- new trade route at the world level → gate district on that side thickens;
  the street from gate to core widens (flow → wear).
- ore depletes (already simulated) → pithead district's production vector
  fades → its market starves → stalls board up → residential absorbs or
  empties. Decline is the same rules run backward.
- war/hostility (settlement edge attr) → gate districts grow walls?
  (open: fortification as a district response to the hostility field.)

The refine/rest dial (timescales.md §6) applies within the city too: a
district with zero delta days is "at rest" — its tier-B recompute is a
cache hit; a city fully at rest skips tier B entirely on reload.

---

## 6. What survives from the shipped code

- ~~**Polar template** → the core district's internal layout~~ GONE
  (2026-07-06): the organic street tree (`streets.ts`) replaced it
  wholesale — villages and cities alike grow from the plaza kernel.
- ~~**town-roads.ts**~~ → **streets.ts**: the street tree IS the
  intra-city graph and the router (tree routing via the plaza-ring hub).
  When districts arrive, arterial-between-district edges are the tree's
  gen-0/1 trunks — already distinguished, already traffic-weighted.
- **food.ts** → the cheat provider, verbatim: distant/unloaded cities keep
  the clock projection; its fill/pantry/trip math becomes per-district
  (fill varies BY district once flows route unevenly — a poor quarter).
- **TownManager streaming discipline** → unchanged (host truth, body
  ranking, evict lock, budget sharing).
- **Traveler bands** → the template for flow-sampled walkers (§3c) — same
  id-space discipline, same embody/dot hysteresis.
- **Engine seams** (addNpc/removeNpc, setStructures, wanderRadius+home,
  speed, errand dwell, walkable) → all load-bearing as-is. Hauls need one
  more: carry-able objects streamed like structures (objects are capped
  at 32 in the spec — a runtime add/remove object seam, mirroring addNpc).

## 6b. Presentation seam: the transient core (pointer, 2026-07-06)

`grand-dream/src/transients.ts` shipped as the generic timescales.md §5b
presentation foundation, and this doc's lifecycle events are exactly its
material — noted so the district work can ride it instead of reinventing:

- `createRevealTracker` — births/deaths with first-frame priming and
  fade-out: market stalls boarding up (§2c decline), a new district's
  construction fringe (§5), buildings materializing at tier C/D. A key
  re-born mid-fade resumes from its visible phase (a market that recovers
  its hinterland un-boards smoothly).
- `createEasedValues` — keyed continuous quantities that jump at day
  boundaries: per-street traffic rates (§3b), market stock/size, district
  fill. The lab's route widths/flows already ride this.
- The one-way contract holds here too: ledgers and hauls stay
  authoritative; only the paint eases.

**SHIPPED (2026-07-06) for town construction:** TownManager re-derives a
loaded town's plan when its population moves; the world view reconciles
every loaded plan against a reveal tracker (houses/works keys) + eased
street lengths — new lots scaffold in translucent with a scaffold edge,
new lanes pave outward from their junction, extensions ease, and a lot
converting into a market stall crossfades (the house ghost fades where
the stall grows). Prefix stability is what makes this safe: a rebuild
only APPENDS, so the diff is always construction, never reshuffle.

## 7. Migration path (each step playable)

1. **Districts + multi-markets on the current template**: keep polar
   geometry; partition rings into wedge districts; markets by unserved-
   demand founding rule instead of the single-plaza threshold. Food cycles
   point at *their district's* market. (Kills monocentrism first.)
   **DONE** (`districts.ts`): households too far from any source (lane
   meters — polar taxicab, because the strict 4-spoke road metric makes
   fringe service areas thin slivers and founds a shop per block)
   accumulate founding mass per quarter; at threshold the pending lot
   nearest the mass centroid CONVERTS into a market stall (same footprint
   and door, so all road-clearance proofs hold, and the conversion IS the
   visible development). Prefix-stable in lot order. Food binds each house
   to its street-nearest source (`roadDistance`, closed-form) — those
   catchments are the step-1 districts — and each stall's shelf stocks its
   own catchment's share. Ladder: 1k souls = plaza only, 2k = +2 stalls,
   3k = 5 markets, 10k = ~29, linear in population, ~10 ms to plan.
2. **District flow graph (tier B)**: mini EntityWorld per loaded city;
   per-district fill; traffic rates per street; mid-zoom traffic dots.
   **DONE for the food commodity (2026-07-06, `city-districts.ts`)**:
   the step-1 catchments are promoted to DISTRICTS (source + houses +
   street-nearest works + kind read off the works — the miners' quarter
   is derived, and the view tints it), and FILL VARIES BY DISTRICT: a
   pure conserving allocator (`allocateDistrictFill`) deals the site's
   delivered food by supply order (street distance from the nearest
   producer — farm gate or the hall), floor share + nearest-first pour,
   exact at fill 1. The POOR QUARTER emerges spatially: leaner pantry
   ceilings, thinner stall shelves, more frequent trips — all riding the
   existing projection (pantry/stock/cycle read district fill now).
   Supply hauls (producer→market cart routes) wear the streets on top of
   shopper trips, and mid-zoom TRAFFIC DOTS sample the field (identity-
   free ambient walkers, culled near the player where real bodies live).
   Not yet a mini EntityWorld — one hand-rolled conserving allocator for
   ONE commodity; grow it into the entity-spec shape when more
   commodities (ore, timber) flow at street level.
3. **Hauls**: carters walking producer→market on the road net, stock as
   ledger; the object-streaming seam; robbery = delta ledger row.
4. **Flow-sampled pedestrians** beyond the core street (replace nothing —
   ambient walkers additional to person-first residents). **STARTED**:
   the tier-B traffic dots are the identity-free rung (position sampled
   from (street, hash, clock), day-curved, never within 80 m of the
   player). The next rung is engagement: a dot the player approaches
   resolves to a household (§3c's lazy identity).

   **Pop-in policy (2026-07-06, with the dots):** bodies never
   materialize on open ground. Home-phase residents spawn INSIDE their
   house and the view hides indoor villagers (the closed-door
   abstraction, visually — bodies still exist for the engine; dropping
   them entirely is a future memory save). Mid-errand residents whose
   projected position is inside the camera's visible radius spawn at
   their trip's SOURCE building and walk out of it (a bounded clock
   slip instead of a body from thin air); off-camera they still spawn
   mid-route, so the plaza has people before you arrive. OPEN: despawn
   pop-OUT (eviction beyond the lock radius is visible when zoomed
   out — candidate rule: evictees walk to the nearest building first),
   and camera-aware zoom means a sudden zoom-out can still catch a
   spawn mid-frame.

   **Door transits + market stands (2026-07-06 later, playtest: "people
   get stuck on doors; the market crowds in a corner"):** the only
   obstacle a town actually has is its own doorways, so bodies now cross
   them with an explicit two-waypoint sandwich (`doorTransit` in
   food.ts): space-just-inside → space-just-outside (or the reverse).
   Residents tether to their HOUSE CENTER with a tiny wander radius —
   idle bodies shuffle indoors (and fall under the cull) instead of
   grinding on their own wall trying to reach a doorstep-outside tether,
   which was the bug — and every shopping errand is bracketed by door
   transits (out of home at the start, back in at the end), so the wall
   is crossed AT the door at both ends. Markets grew STANDS: 2–5 stall
   tables spread along the building's door side, each household hashed to
   one, so shoppers dwell fanned out along the tables instead of piling
   at a single point. The sack piles now scale to the stall's own daily
   throughput (stock ÷ dawn delivery), so every shelf visibly drains
   from full to nearly empty across the day (the old fixed ÷7.5 scale
   pinned big stalls at "10 sacks" most of the day, reading as static);
   stock was always a live function of the clock — only its rendering
   was flat.
5. **District-first geometry**: new cities generate accretively (§2b).
   **MOSTLY DONE (2026-07-06)**: geometry IS accretive — the street tree
   grows from the kernel in construction order (`streets.ts`), the polar
   template is gone, and existing saves regenerated (nothing persists
   but site scalars — the whole point). The SEEDS are typed too
   (`townBias` in zoom.ts): arterials aim along trade routes and toward
   the fertile/ore sides, farm gates cap the fertile-side tips and the
   pithead the ore-side tips, fields follow the farm gates —
   session-memoized quantized bearings, so drift can't re-lay a loaded
   town. What remains: the district layer PROPER — typed seed → Voronoi
   cell → per-district building mix (miners' quarter by the pithead),
   which arrives with the tier-B district graph (step 2).
6. **Write-back + player economy**: buying/stealing hits ledgers; fill
   dips propagate through vitals (a city you starve SHRINKS — the §4b
   Malthus loop, now reachable from street level).

## 8. Open questions

- **Stable partitions under growth**: exact rule for appending Voronoi
  seeds without redrawing old cells (candidate in §2b; needs a
  prefix-stability proof like lotAt's).
- **Street geometry between districts**: Delaunay edges of seeds, snapped
  to what? Terrain (river crossings, contour-following) matters at km
  scale. Probably: arterial = shortest terrain-weighted path between
  seeds, cached; local nets stay per-district templates by type. [Yes]
- **How deep does the fractal go?** Building-level (rooms/meals) is
  plausible with the same pattern but likely wasted below PEOPLE_R —
  decide by playtest, not architecture. [Start with simple houses, we'll do family dynamics later]
- **Metropolis recursion**: is a 100k city districts-of-districts (the
  pattern applied twice), or one bigger graph? Leaning: recurse — cell
  budgets stay bounded at every level, and it's the same code. [Recusive]
- **Identity continuity across the flow/person boundary**: engaging the
  same sampled walker twice should resolve to the same household —
  seeding must survive traffic-rate changes (slot → household hash must
  key on stable ids, not rate-dependent indices). [Yes]
- **Time-of-day vs the sim day**: street clock (240 s) vs settlement day
  (one step) — hauls conserve per SIM day, but the street clock may show
  several dawn-delivery cycles per sim day. Probably fine (the street
  clock is presentation), but the ledger must be written against sim
  days only. [Related to time granularity - for now ledger supply and demand should be based on sim day. Histfigs may elevate to individual tracking.]
- **Where does PopuSim recurse?** Districts could carry trait prevalences
  (a devout quarter, a separatist dockside) by apportioning site
  composition — powerful for §7's civ arcs (WHERE in the city the idea
  lives), cost unclear. Defer until districts exist. [Yes, this will come later, but leave it open for different predefined types. Also the same functionality can apply to resources other than food, with different details.]
