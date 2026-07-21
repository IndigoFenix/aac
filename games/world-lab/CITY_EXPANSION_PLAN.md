# City Expansion — Phase ① Design (build-order directives + StructureSpec catalog)

Status: DESIGN. Approved phasing: ① build orders + structure specs → ② scope-agnostic trade →
③ zoning charters → ④ per-district cohort LOD + city HUD → ⑤ intercity barter caravans.
Economy stance: communal (roster/haul/needs) allocator stays; logistics kept economy-agnostic;
valuation (currency/prices) deferred — intercity barter ratios (⑤) are the on-ramp.
Prerequisite: Step 0 founding flow (spirit↔avatar possession, "build" founds empty site,
wilderness gathering stocks it, empty abandoned sites cleared).

## What exists today (recon summary, verified 2026-07-16)

- **Directive pipeline**: `parse-intent.ts` LEXICON already registers `build` (V("build", true), L216).
  `intent-compile.ts` compiles it to `{kind:"build", structure, cap}` (L254-258). **Dead end**:
  `goal-selection.ts` returns `null` for `build` (L392) and quest-host has no executor. Phase ①
  = wiring this dead end to construction.
- **Two half-catalogs already describe buildings** and must be LINKED, not triplicated:
  - `economy.ts BuildingDef` — economic half: produces/consumes, `cap:{by:<charter-attr>,rate}`,
    `construction.costs`, `district` (closed union `"farm"|"mining"|"craft"|null`).
  - `stations.ts BuildingProgram` / `WORK_PROGRAMS` (L404) — interior half: wants
    (sleepCells/wet/kitchen/store) consumed by `rooms.ts buildingRoomPlan()` (L847).
  - Plus `FurnitureItemDef.craft {at, consumes}` as the produces/consumes precedent, and
    `StationDef`/`ClusterDef` as the declarative-row pattern to follow.
- **Construction unit today = room (annex) + furniture piece** on an EXISTING building
  (`construction.ts BuildingDelta`). There is no new-whole-building placement primitive;
  new buildings only appear at founding (`seedFoundingWorkshops`). Prosperity auto-expansion
  (`constructionStep`, hard-coded want ladder `nextAnnexWant` sleep→kitchen→store→workshop)
  adds annexes only.
- **Refusal precedent**: `placement-will.ts willingnessToPlace()` → `place|cannot|wont`
  (cannot = infeasible, wont = taste beyond compliance floor).
- **Jobs**: `roster.ts assignTownJobs()` hires flat `STAFF_PER_WORK = 2` per work building.
- **Board seam**: quest-host pushes `QuestBoardView.options` via `QuestPresenter.board()`;
  world-lab `board-island.tsx` renders them and returns sentences through `onSpeak` → LEXICON
  parse. No new channel needed.
- **Stocks**: `EconomyDoc.stockpiles` (granary) + `BuildingDef.construction.costs` = the
  town-scale spend model; household/shop containers in `goods.ts`; intercity `trade.ts`
  TradeRoute exists as phase ② / ⑤ generalization target.

## Phase ①a — communication & tasking layer (user additions, 2026-07-16)

Prerequisite substrate for build orders; ships before the StructureSpec work (①b).

1. **Response semantics**: "Okay" is RESERVED for confirming an accepted order — no longer the
   generic reply. Asking a creature about its state returns emotional state when no problems
   exist (thin layer over needs/mood; more robust later). Utterances no valid responder
   catches fall to "I don't understand".
2. **Untargeted orders → task pool**: an order with no target creature creates a TASK
   (compiled goal + issuer + focus area). Any appropriate creature (willingness/capability
   machinery decides "appropriate") inside the focus area may pick it up; a task is FILLED on
   claim so two creatures never chase the same order. Claims must be deterministic
   (seed+clock+mutations law — tasks and claims are mutations).
3. **Intent announcements**: a communication path letting a creature state what it is about
   to do before doing it (e.g. on claiming a task). Whether a given act announces is a
   criteria hook — default conservative (announce on task claim), criteria TBD later; the
   PATH is what ships now. World lang layer for strings, not client i18n.
4. **Creature-issued orders** (keep-in-mind seam, not required now): the task pool and the
   directive pipeline must not assume the player is the only issuer — creature-originated
   orders (targeted or pooled) should be routable through the same intent path later.

## Phase ①b data model: `StructureSpec`

One registry row per buildable structure, UNIFYING the two half-catalogs (each spec holds or
references its BuildingDef economic half and BuildingProgram interior half):

```
StructureSpec {
  type: string                      // registry key; free string, no closed union
  glyph / label                     // board + TTS surface (shared game lang layer, NOT client i18n)
  footprint: { w, d }               // lot size request
  program: BuildingProgram          // interior wants → buildingRoomPlan()
  stations?: StationKind[]          // beyond what the program implies
  jobs: number                      // replaces flat STAFF_PER_WORK for this building
  economy?: BuildingDef ref         // produces/consumes, cap:{by,rate}, district
  costs: Record<glyph, number>      // build materials drawn from town/site stock
  default: boolean                  // in the default catalog vs unlocked by world doc
}
```

Lives as world content beside `TOWN_PLAY_ECONOMY` (an `EconomyDoc` peer in `town-play.ts` /
its own module under `kernel/town/`), overridable per world doc in `worlds.ts` — same
"swap the doc, nothing else" modding loop.

## Phase ① wiring

1. **Resolve**: intent-compile `build` case looks up `frame.object.symbol` against the
   StructureSpec registry (binder seam, like `isFurniture`); unknown structure → conversational
   "can't" reply, never a silent generic fallback (don't repeat the `workProgram()` swallow).
2. **New-building placement primitive = the annex pattern one level up.** `construction.ts`
   declares itself scope-agnostic by design ("the same machinery grows a cottage bedroom, a
   shop's stock room, and (later) a city block" — header L11-14). Founding a building is an
   "annex" of the STREET/BLOCK frame: a `FoundedBuilding` delta (type, lot rect flush to a
   street frontage, door onto the street ≙ `doorInto`), candidates enumerated best-first with
   feasibility INSIDE the enumeration (`annexOptions` law: a candidate that reaches the caller
   is buildable), serialized in `TownDeltas`, consumed as pure-generator input. Likewise
   `placement.ts`'s three layers (feasible-with-reason / naturalness / best-first search) map
   to town scale as: zones = lots/blocks, corridors = streets (must stay walkable, like door
   swings), pieces = existing buildings, service flood = street connectivity. What IS
   house-bound and needs a town-scale twin or a generalized core: `Zone.room: HouseRoom`,
   `HOUSE_STATIONS` as the aesthetic registry, `zoneForCell` resolution. Prefer generalizing
   the geometric core over a minimal frame interface; mirror only where types resist.
3. **Execute**: quest-host `goal.kind === "build"` branch (sibling of `handlePlaceOrder`):
   check costs against stock → willingness (`cannot`: no lot / missing materials, with the
   missing glyphs named; `wont`: taste/compliance, placement-will pattern) → commit founded
   delta → roster `assignTownJobs` picks up the new work building using `spec.jobs`.
4. **Build takes time**: founded building starts as a frame/site the way prosperity annexes do;
   builders' duty rows (`DutyActivity {kind:"job"}`) make construction visible on the ground —
   board words MUST visibly change the world.
5. **Board surface**: quest-host pushes contextual civic options (buildable specs whose costs
   are met, at town scope) as `QuestBoardView.options`; sentence builder path works already
   since `build` is in LEXICON — add structure nouns to the noun surface.
6. **Auto-expansion hook**: `nextAnnexWant`'s hard ladder stays for houses in ①, but
   `constructionStep` gains the ability to spend prosperity on FOUNDING specs marked
   auto-eligible — this is the seam phase ③ zoning charters steer.

## Known choke points to edit (closed unions, by design)

- `rules.ts GoalSpec` — `build` arm already exists; may need a richer payload (spec type + site).
- `goal-selection.ts` L392 — route `build` to quest-host handling (like `place`).
- `roster.ts STAFF_PER_WORK` → per-spec `jobs`.
- `economy.ts BuildingDef.district` closed union → free string (needed by ③).
- `rooms.ts buildWorkPlan()` hard branches — acceptable for ① (programs are still the
  interface); full data-driven room emission only if a spec needs rooms programs can't express.

## Phase ② — SHIPPED (2026-07-16): the transfer primitive

ONE scope-agnostic transfer/trade shape: `kernel/town/transfer.ts`.

- **StockEndpoint** = a VIEW over a live stack map (id, kind, walk-to anchor,
  optional capacity, owner scope, `stack`). The stack ALIASES the real holder —
  containerStock entries (which already alias the site crate), `deltas.stock`,
  `site.stock`, pockets (`pocket:<cid>` = the player's pocket / a resident's
  carried stack). Derived stores (market shelves `store:*`, produce piles
  `produce:*`, `trade:*` crates) are time-pure projections and are NOT
  endpoints. `takeStock`/`putStock`/`transferStock` are head-aware (wood.wet
  pays toward wood, the spendCosts convention) and CONSERVING (capacity
  refusals return to the source; overflow at unload spills as loose piles).
- **TransferAgreement** = {from, to, goods, issuer, executor, mode
  haul|scheduled, recurrence `every`} in a serializable LEDGER
  (`createTransferLedger`, TownDeltas pattern: toJSON round-trip, no RNG,
  `carried` survives a reload). `QuestSession.transfers` holds it.
- **Execution**: one-shot orders are CREATURE HAULS (`issueTransferHaul`:
  load at the source → visible carried prop → unload at the destination),
  targeted (willingness gate = the build-order gate, "ok" reserved for the
  accepted order) or UNTARGETED → the ①a task pool as a `transfer` GoalSpec
  arm (capability = endpoints resolve + source holds stock + canGrasp;
  claim announces via intent-lines "put + wood + in + yard"; the pooled task
  completes off the LEDGER status, like build off construction state).
  Standing agreements run as scheduled abstract legs (`runDueTransfers`,
  swept with the task pool at the task clock).
- **The builder's yard made real** (the ①b gap): town sessions stand a
  `town:yard` crate beside the hall whose container stack IS `deltas.stock`
  (the FoundedSite-crate pattern) — container puts/takes and transfer hauls
  fund/drain build orders directly. "yard" is a speakable place noun
  (resolver alias → town crate / site crate).
- **Player surface**: `bring` joined the LEXICON (give's frame); give/bring
  with a PLACE destination compiles to putIn; quest-host intercepts
  endpoint-shaped give/putIn orders (`orderTransfer`) — "bring wood to
  house/house.red/yard/person", quantities via the spoken quantity word
  (`orderQuantity`; "all" = everything available). Houses bind as endpoints
  ("house.red" = the directions colour word; bare "house" = nearest OTHER
  house) landing in the good's chest, else the cupboard. Sources are
  ownership-gated for the ISSUER (mayUse chain): refusals are honest and
  named — "we don't have 3 wood — only 1", "it's not ours", private boxes
  refused with the owner named, "won't" for a non-compliant hauler. A
  single unit handed to a creature stays the shipped give path.
- **Bridged, NOT migrated**: goods.ts dawn carts and trade.ts caravans stay
  time-pure closed forms (their clocks are their scheduled executors —
  stability of the shipped economy over purity). `dawnCartAgreementInput` /
  `tradeRouteAgreementInputs` express those legs in the agreement
  vocabulary; re-derive after `bindPartner()` and the partner endpoint
  follows — the ⑤ caravan on-ramp.
- Tests: `server/tests/town-transfer.test.ts` (endpoint aliasing per holder
  kind, ledger lifecycle/serialization/determinism, house↔house end-to-end,
  yard-deposit→build-spend, refusal matrix, standing legs, trade bridge,
  spoken-surface compiles).

## Phase ③ — SHIPPED (2026-07-16): zoning charters

A zone = a SPATIAL CHARTER steering the EXISTING growth machinery (never a
new construction path): `kernel/town/zoning.ts`.

- **ZoneCharter** = {ord (stable forever — the ④ district seed), town-local
  DISC x/y/r, category (free string: a StructureSpec.type OR an economy
  `BuildingDef.district` class), issuer}. Stored IN TownDeltas
  (`zones()`/`addZone`, serialized in `SerializedTownDeltas.zones` — rides
  siteTownConfig and every replay). OVERLAP RULE: the LATEST charter over a
  point wins (`zoneAt`); "unzone" = a CLEARING charter (category null) —
  nothing is ever deleted, so replay holds and ords stay stable.
- **Founding filter**: `foundingOptions` gained an optional `zoning`
  classifier (`slotZoningFn`): blocked lots (zoned for another category)
  never enumerate (annexOptions law), zone-MATCHED lots outrank open
  ground, unzoned ground stays fully permissive (no charters ⇒
  byte-identical behavior). Manual `orderBuild` refusals are NAMED: an
  empty zone-aware enumeration re-probes raw — ground that exists but is
  chartered refuses as a WONT with the category ("that's farmland",
  `zoneRefusalLine`); truly-out ground keeps the honest cannot.
- **Auto-expansion founding** (the ①b deferred piece): `foundingGrowthStep`
  (a pure sibling of `constructionStep`, run on the same town-day tick —
  the annex ladder `nextAnnexWant` untouched) banks TOWN prosperity
  (`deltas.civic.prosperity`, mean household gain, daily-capped) and a
  crossed threshold founds the most-NEEDED admitted structure inside a
  zone with ground for it: need = crowding for houses, the worst `sells`
  commodity shortage for producers (data-driven off eco.fills), flat
  default otherwise; gated by the `cap:{by,rate}` charter precedent (read
  discretely: the next whole building must fit) and REAL YARD STOCK
  (auto-growth spends `deltas.stock` — a town out of wood stops growing).
  Commit = the player-order path (FoundedBuilding delta → plan row →
  scaffold → completion sweep → roster staffing). Unzoned towns never
  auto-found — exactly the pre-③ behavior.
- **Player surface**: `zone` joined the LEXICON (V, directive) → GoalSpec
  `{kind:"zone", category}` (host-routed like build; the AREA is the
  player's focus circle at order time — the task-pool brush). "zone farm
  here" charters, "zone none" clears, unknown words refuse NAMED,
  accepted orders confirm through the reserved "ok". Civic board carries
  `zone:<type>` + `zone:none` options beside the build options. VISIBLE
  ground: `quest/zone-overlay-3d.ts` (SceneOverlay beside the goal-tree
  layer) tints chartered discs category-colored on a canvas-textured
  plane, painted in ord order so later-wins and clearing are visibly true.
- Tests: `server/tests/town-zoning.test.ts` (lifecycle/serialization/
  overlap, founding filter + named refusal, growth determinism/caps/
  stock), `server/tests/symbol-game-zone-directive.test.ts` (parse/
  compile/refusal lines).

## Phase ④ — SHIPPED (2026-07-16): move-in + per-district cohorts + city HUD

Kernel: `kernel/town/population.ts` (pure); HUD data: `interaction/quest/city-hud.ts`
(family-hud's sibling); host wiring in quest-host's "POPULATION TIERS" block.

- **MOVE-IN (the ①b `role:"house"` half)**: once per credited town day,
  `moveInStep` admits ONE household into the OLDEST completed, still-empty
  house-role founding when food is not scarce
  (`shortage("food") <= MOVE_IN_FOOD_SHORTAGE_MAX` — surplus attracts,
  famine turns newcomers away). Admission is a SERIALIZED FACT
  (`FoundedBuilding.household`, the `completed` pattern, written by
  `TownDeltas.admitHousehold`). Materialization is ONE shape
  (`foundedHouseRow`) on both paths: rebuilds divert the founding to a real
  `plan.houses` row in `applyFoundedBuildings` (index = max+1 — stall-gap
  safe; an EMPTY founded house stays the ①b work row); the LIVE conversion
  VACATES the work row in place (`TownWork.vacated` — works indices are
  load-bearing: jobs, attendance, the stage's registration maps) and
  appends the house row. The stage reconciles on the version bump
  (vacated works clear walls/furniture; appended houses register walls +
  furniture live) and the resident model streams the household in — the
  loop closes: build houses → people move in → more souls → more growth.
- **COHORTS**: past the tracked cap (`TownPlayConfig.trackedResidents`,
  default `TRACKED_RESIDENTS_DEFAULT = 30` = six full households — the
  historical 6-house village floor, so small towns are ALWAYS fully
  tracked), whole HOUSEHOLDS pool into per-district `CohortRow`s
  serialized in `SerializedTownDeltas.cohorts`: {pop, member-weighted
  wellbeing, per-good needs satisfaction, an inventory STACK, ratesDay}.
  A DISTRICT = the governing zone charter's ord (`districtOfPoint` over
  ③'s `zoneAt`); unzoned ground is ONE default district (-1).
  CONSERVATION: demotion folds the members + their CARRIED stacks into
  the pool (house pantries stay with the standing BUILDING — its walls,
  furniture and closed forms are untouched); promotion returns exactly
  the pooled members (the stack stays district property, reachable via ②)
  — nothing minted or lost across any cycle. In-flight state never folds:
  houses with party/possessed/live-need/queued-command/hauling members
  are PINNED (with the family, the dollhouse, watched interiors, quest-
  cast homes). Transitions: `planCohortTransition`, AT MOST ONE per 2 s
  sweep, keep-score = −distance to the player's focus, hysteretic
  (`COHORT_SWAP_MARGIN` band — a swap can never flap back). RATES
  integrate once per town day (`cohortRatesStep`, idle-safe closed form —
  N slept days catch up in one call) off the SAME street books individuals
  project: production = district producers' `cartRations` × the pool's
  share of district souls; consumption = street `perCapitaDaily`; a
  pop-scaled stack cap sheds surplus. A FEW sampled walkers per pooled
  district keep streets alive (`cohortWalkerSpots` — hashed off
  (seed, day, district), spawned outside camera reach, cosmetic-only).
- **CITY HUD**: `cityHudView` (pure) assembles per-district chips —
  category glyph (town glyph 🏘️ for the default district), population
  (tracked + pooled), a wellbeing FACE, key stocks worst-city-shortage-
  first — plus a city-total row folding the yard. UNLOCK: pooled souls
  exist or street population > cap; locked = null (the village never sees
  chips). Pushed diff-gated through the new optional
  `QuestPresenter.city` channel; world-lab renders `CityStrip` in
  board-island (the FamilyStrip pattern, `.lab-city` styles).
- **Seams honored**: a pool IS a ② `StockEndpoint`
  (`cohort:<district>` ids resolve in `stockEndpointOf`; scheduled legs
  via `runDueTransfers` reach it); ③'s crowding numerator now reads
  street souls too — tracked households × HOUSEHOLD + cohort population,
  floored by the aggregate scalar (vacated rows excluded from every
  count); zone ords stay the district ids; cohort rows ride
  `SerializedTownDeltas` (toJSON round-trip, no RNG anywhere — walkers
  hash). BELOW THE CAP EVERYTHING IS DORMANT: no rows, no transitions,
  no chips, resident streaming byte-identical (pinned by test).
- **NOT DONE / open**: the resident MODEL's `jobsByHouse` stays fixed per
  session (a moved-in household's members shop but don't commute until
  the next rebuild — the host-side `townJobsMemo` DOES re-deal for
  attendance/HUD; converging the two is the live-re-deal seam, left
  because the model's roster cache is creation-bound). Flight-view proxy
  lots don't yet know a vacated work converted (edge: the low-res
  instance may linger until rebuild). Cohort pools don't feed the market
  shelf closed forms (catchments are creation-bound; pools carry their
  own stock instead).
- Tests: `server/tests/town-move-in.test.ts` (rule gates, oldest-first,
  serialized fact, both materialization paths, zero-pop rebuild),
  `server/tests/town-cohorts.test.ts` (district mapping, conservation,
  hysteresis no-flap, idle-safe rates, endpoint/scheduled transfers,
  serialization, stage-seam streaming exclusion + dormancy
  byte-identity), `server/tests/town-city-hud.test.ts` (unlock, chip
  content, stock ordering).

## Phase ⑤ — SHIPPED (2026-07-17): intercity barter caravans

The economy stance EXECUTED at the boundary: communal inside (unchanged),
priced at the edges as scarcity-driven BARTER RATIOS. No currency, no money
glyphs, no prices anywhere — goods for goods. Kernel: `kernel/town/barter.ts`
(pure); the agreement flavor lives on the ② ledger (`transfer.ts
BarterTerms`); host wiring in quest-host's "INTERCITY BARTER" block.

- **THE RATIO MODEL** (`barterRatio`): each good carries a pair-worth
  `1 + W·(our shortage + theirs)` (③/④'s `townShortage` signal on our side);
  ratio = worth(give)/worth(take), clamped to [1/3, 3]. Test-pinned:
  perspective consistency (A's view of the A↔B deal = B's inverse — worth is
  pair-symmetric, the clamp bounds reciprocal), monotone in scarcity (the
  scarcer their need for what we give, the better our ratio), bounded,
  deterministic. BOTH sides' desperation counts — a starving town gets worse
  terms for the food it buys (bargaining position is part of the lesson).
  `barterQuote` renders the ratio as a small integer pair inside the
  speakable quantity words ("3 wood for 2 food", 1..3 a side) and shipments
  move in WHOLE quote batches — spoken terms ARE executed terms, the
  remainder honestly stays home.
- **PARTNER SIGNALS, both shapes**: a REAL-SIM partner (cluster neighbor —
  `TownStage.cluster.partners()`, new ⑤ seam in town-cluster.ts) prices off
  its LIVE books (fills/scalars — the townShortage math aimed at its
  economy) and its `town:<key>` endpoint ALIASES its actual yard
  (deltas.stock), so shipments conserve across both economies; an ABSTRACT
  partner (the `away:<seed>` line, a flight `city:<cell>`, a boot-supplied
  key) reads `stubPartnerSignals` — a hash-seeded base per (partner, good)
  plus a slow triangular season over the town day (pure f(key, good, day),
  no RNG) — so terms shift over time against a stub too; its synthetic shelf
  (`session.partnerStock`) is topped up deterministically before each sweep
  (the stub's one mint, at the boundary).
- **WILLINGNESS** (`barterWillingness`, judged by THEIR books alone): the
  partner accepts only when it wants what we give MORE than what it gives up
  (`shortage(give) ≥ 0.15` and `> shortage(take)`), and never during its own
  famine on the take-good (`≥ 0.7` → "wont-part"). Refusals speak the honest
  vocabulary (`dialogue/barter-lines.ts`): "they have many wood" /
  "they give.not food"; OUR side refuses counted ("we don't have 6 wood —
  only 2", the noStock flow).
- **AGREEMENTS on the ② ledger**: a barter deal = ONE TransferAgreement
  (from our yard/site crate, to `town:<partnerKey>` — the ② bridge's id
  convention made LIVE in `stockEndpointOf`) carrying `barter: BarterTerms`
  {take, giveGood, takeGood, quote, partnerKey, suspended} — ratios attach
  to the agreement row, serialize round-trip, and `runDueTransfers` SKIPS
  barter rows by contract. One-shots and STANDING routes (`every` = a street
  day); both take TRAVEL TIME (`dueAt` = now + 0.35 day, the new optional
  PostTransferInput field).
- **EXECUTION** (`runDueBarters`, swept with the task pool): per shipment it
  RE-DERIVES the quote off the current signals (rewritten onto the row — the
  terms the player hears shift as scarcities shift), re-checks willingness
  (a famine SUSPENDS the route — edge-flagged toast, `barter.suspended`
  visible on the row; recovery reports "resumed"), and moves stock BOTH WAYS
  between the live endpoints in whole batches, clamped by our yard, the
  ordered amount AND the partner's real shelf — conservation pinned. Stalled
  one-shots re-arm a day out (they WAIT, visibly, never rot). Every landing
  renders: the honest toast ("caravan from hamlet-1: 2 wood → 1 food") plus
  a mounted carrier (🐴) walking the trade-road polyline in to OUR depot,
  dwelling, and leaving (deterministic serial ids; cosmetic where it must
  be — an abstract partner still lands a visible cart at our gate).
- **PLAYER SURFACE**: `trade` was already a LEXICON verb — it now compiles:
  `{kind:"trade", give, take, partner}` (GoalSpec arm, host-routed like
  zone). "trade wood with hamlet-1"; "trade wood FOR food with hamlet-1"
  rides the new additive `IntentFrame.bound` slot (EVERY relation-marked
  noun kept — the two-argument frame loses nothing); no take-good spoken →
  defaults to OUR worst shortage and the clerk SAYS IT BACK; "trade all
  wood …" = a STANDING daily route. The confirmation SPEAKS THE TERMS: the
  reserved-ok flow states the ratio (`barterTermsLine` — a:"ok",
  b:"three + wood + for + two + food"). Unknown partner refuses NAMED with
  who we DO trade with. Board: at town scope with a partner, `trade:<good>`
  options join the civic board (affordable AND partner-willing goods only,
  ≤3 — the board is engine chrome, not a market screen).
- **PARTNER BINDING**: multi-partner falls out of the `town:<key>` keying
  for free — `tradePartnersOf` unions cluster neighbors (real sims), the
  bound caravan line's key (`bindPartner` untouched; its partner appears as
  real when a cluster member carries the key, stub otherwise), and
  boot-supplied `deps.tradePartners()`. A FOUNDED SITE with none of those
  still gets ONE abstract partner (`away:<siteKey>`) — found → grow → trade
  works from day one; its scarcity signal is its own crate (empty shelf =
  everything scarce, the honest frontier bargaining position), its give
  endpoint the site stockpile. The visible caravan LINE (trade.ts geometry)
  stays the one bound route; barter with other partners ships abstractly +
  renders at the depot.
- **Untouched by design**: trade.ts closed forms (daily caravan, import
  crates, export pile), dawn carts, and every ②-④ flow — barter is a
  PARALLEL flow on the ② ledger.
- Tests: `server/tests/town-barter.test.ts` (ratio properties, quotes,
  willingness matrix, stub proxy, ledger round-trip + runDueTransfers skip,
  executor: both-ways conservation, re-derived terms, suspend/resume edges,
  one-shot wait, short/partner-dry clamps, no-endpoint, replay determinism),
  `server/tests/symbol-game-trade-directive.test.ts` (lexicon, two-argument
  parse via `bound`, compile matrix, spoken terms + refusal lines).
- **NOT DONE / open**: no city-HUD route-status chip (optional, skipped);
  the world-lab boots don't yet pass `deps.tradePartners` (flight cities
  reach barter through the bound line's stub only); a real BODY caravan
  walking the full intercity leg between two simulated towns (travel-drag/
  mounts substrate) — the rendered depot arrival stands in at town scale.

## Phases ②–⑤ pointers

- ② Transfer primitive: generalize `goods.ts haul()` + `trade.ts TradeRoute` into one
  transfer-agreement between any two stock endpoints (household box / shelf / stockpile).
  — SHIPPED, see above.
- ③ Zoning: spatial charter rows following `cap:{by,rate}` precedent; steer `constructionStep`
  founding within zone rects. — SHIPPED, see above.
- ④ Cohorts: per-district; tracked-resident cap ~20–40; promotion/demotion conserves totals;
  city HUD (stocks, population, avg wellbeing per district). — SHIPPED, see above.
- ⑤ Caravans: `trade.ts bindPartner()` seam + travel-drag/mounts; barter ratios from relative
  scarcity, no currency. — SHIPPED, see above.
