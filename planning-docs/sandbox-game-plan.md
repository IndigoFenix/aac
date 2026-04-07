# Sandbox Game Plan

This is a grid-based sandbox game that can be played entirely by pressing large buttons and grid sections.
It is designed to run as an app in the AAC.

## Time-based system

It is a time-based, idle game that can "catch up" when reloaded as if it was never turned off.
At any given moment, there must be a finite and reasonably small number of future steps before it reaches equilibrium and stops changing. This ensures that no matter how long it was turned off, the game can always catch up to the current time.

The skip-ahead algorithm works as follows:

Process all pending events up to "now"
Each event may trigger fast cascading consequences — resolve those immediately (they're energy-bounded, so they halt quickly)
Each cascade resolution may schedule new slow events
When the cascade halts, jump to the next pending event
Repeat until the event queue is either empty or all remaining events are in the future

For testing purposes, there should be an option to skip ahead a certain amount of time

The smallest unit of time should be 1/4 of a second, for one tick of water flow.
Some timescales can be hours or up to a day.

## Interface

The game should be designed to handle a board of arbitrary size. Default: 16 by 16.
The main screen should be square regardless of the dimensions of the screen. All grid spaces should be square. There should be menu buttons on the side which allows the player to select different tools, used to interact with the main screen by clicking tiles.

## Mechanics

Each grid cell has the following values:

Type — what it is. Stone, Soil, Water, Seed, Bloom, etc.
Energy — its remaining capacity to cause changes. When this hits zero, the element is inert (still visually alive via the rendering layer, but computationally frozen).
State thresholds — discrete levels rather than continuous values. For populations: None / Sparse / Average / Dense. For growth: Dormant / Sprouting / Growing / Mature / Fruiting. For resources: Empty / Low / Medium / Full. These are the only values the simulation tracks.
Timers — scheduled future events. "This Soil tile will transition from Sprouting to Growing in 4 hours." Each timer is just a timestamp and a target state. No per-tick computation — just a comparison against the clock when the player logs in.
Neighbor sensitivity — a list of conditions on adjacent tiles that can trigger state changes. "If this Soil is Dormant and an adjacent tile is Water, start a Sprouting timer." This is the interaction system.

It must be possible to store cell data in a space-efficient format. This will be saved to the local device.

### The Interaction Model
Every element type has a rule table. Rules take the form:
"When I am [my state], and my neighbor is [their type in their state], then [effect], costing [energy]."
Effects are: 
- change my state, 
- change my neighbor's state, 
- start a timer on myself, 
- start a timer on my neighbor.

This is deliberately less expressive than a cellular automaton. A cell can't count how many neighbors of a given type it has — it responds to the presence of at least one neighbor matching a condition. This prevents the combinatorial explosion that makes Conway's Life unpredictable. The interaction is more like chemistry than computation: elements react with adjacent elements, consuming energy and producing new states.

### Farming Vocabulary
Here's a concrete set of elements for the farming theme, starting small:
#### Terrain elements (persistent, placed by player or generated):

- Stone — inert, blocks water flow, can be broken down into Soil (slow timer, or player action)
- Soil — the fundamental growing medium. Has a fertility state: Barren / Poor / Fair / Rich
- Water — flows into adjacent empty or Soil tiles, makes Soil fertile. Has a level: Dry / Damp / Wet / Flooded

#### Plant elements (placed as seeds, grow over time):

- Seed — placed by the player on Soil. If conditions are met (Soil is at least Poor, adjacent Water is at least Damp), starts a growth timer. Growth stages: Seed → Sprout → Growing → Mature → Fruiting → Withered
- Bloom — a wildflower variant. Self-seeds to adjacent Fair+ Soil when Mature (costs energy, limited spread radius because each generation has less energy). Attracts pollinators.
- Weed — appears spontaneously on neglected Soil (slow timer). Competes with crops by draining Soil fertility. Spreads more aggressively than crops but produces nothing useful.

#### Resource elements (produced by interactions):

- Fruit — produced when a plant reaches Fruiting stage. Sits on the tile. Can be harvested by player or by automation. Decays over time (timer) into Compost if not harvested.
- Compost — increases adjacent Soil fertility by one step (Poor → Fair, Fair → Rich). Consumed in the process.

#### Insect populations (threshold-based, on tiles):

- Pollinators (bees/butterflies) — attracted to Bloom tiles. Presence threshold increases based on number of adjacent Bloom tiles in Mature+ state. None / Sparse / Average / Dense. Sparse+ pollinators on an adjacent tile accelerate Seed → Sprout transition. Dense pollinators enable Bloom self-seeding at greater range.
- Pests (aphids/caterpillars) — attracted to crop tiles in Growing+ state. Appear on a slow timer if no deterrent is present. Drain plant energy, potentially reverting Mature → Growing or killing the plant. Spread to adjacent crop tiles.
- Predators (ladybugs/mantises) — attracted by Dense pest populations. Appear on a slow timer after pests reach Average+. Reduce pest threshold over time. Natural pest control.

#### Infrastructure elements (player-placed, enable automation):

- Irrigation channel — a placed element that distributes Water state to adjacent Soil tiles. Doesn't create water — must be adjacent to a Water source. Converts the player's manual "place water everywhere" into a persistent structure.
- Scarecrow/Trap — reduces pest arrival rate on adjacent tiles (extends the timer before pests appear). Passive, no energy cost, but occupies a tile.
- Harvester — the first automation element. When adjacent to a Fruiting plant, automatically collects the Fruit and deposits it in an adjacent Storage tile. Runs on energy — needs to be "wound up" or "fueled" by the player.
- Storage — holds collected resources. Has a capacity threshold: Empty / Partial / Full. When Full, adjacent Harvesters stop.

## How a Session Plays Out (example)

The player opens the game after being away overnight.
Step 1: Resolve pending events. The game checks the event queue. Maybe six things fired while they were gone:

Three Seed tiles completed their Sprout → Growing timer (4 hours each, planted yesterday)
One Bloom reached Mature and self-seeded to an adjacent tile (8 hour timer)
Pest population on one tile ticked up from None to Sparse (12 hour timer, no scarecrow nearby)
Two Fruit tiles decayed into Compost (not harvested within 16 hours)

Each of these is a single state change. Some trigger fast cascades: the Compost appearing might immediately bump adjacent Soil from Poor to Fair (energy cost, happens instantly in cascade). The pest appearing might start draining energy from the adjacent crop. But each cascade is small and resolves in a handful of steps.
Step 2: Show the result. The player sees their farm. The crops they planted have grown. A new wildflower appeared. Some fruit rotted but enriched the soil. A pest showed up on one crop. All of this is communicated visually — the grown crops are taller, the compost is visible, the pest tile has tiny aphid sprites.
Step 3: Player acts. They deal with the pest (place a trap, or introduce predator insects). They harvest mature crops. They plant new seeds. They extend their irrigation. Each action costs them energy (the game's session-limiting resource), and each action potentially starts new timers and triggers fast cascades.
Step 4: Watch cascades. After placing a Water source, they watch it flow through their irrigation channels to dry Soil tiles (fast cascade, takes a few seconds of real-time, each step costs energy from the Water element). The Soil tiles change from Dry to Damp. Seeds on those tiles that were waiting for water start their growth timers.
Step 5: Leave. They've used most of their energy for the session. The world is visually alive — crops sway, water sparkles, bees orbit the flowers — but computationally frozen except for the slow timers they've set in motion. They'll check back in a few hours when the next crop stage completes.

## The Energy Accounting
There are really two kinds of energy working here:
Solar energy (solution 1) — infinite, free, constant. Powers all visual animation and sustains the "alive" look. Also powers the slow biological timers: seeds germinate, plants grow, insects arrive. These happen automatically without player input. Solar energy represents the passage of time — things grow because time passes, not because the player spent resources.
Player energy (the session limiter) — finite, regenerating. Powers all player-initiated changes: placing elements, breaking stone, harvesting, building infrastructure. Also powers all fast cascades: when the player places water and it flows outward, each step of the flow costs energy from the water element (which the player injected). This is what ensures cascades halt.
The subtle distinction: solar timers create anticipation (come back tomorrow to see your crops), while player energy creates agency (you decide what to change right now). The game is interesting because the player shapes the world during their active time, then the world slowly evolves along the tracks they've laid.
