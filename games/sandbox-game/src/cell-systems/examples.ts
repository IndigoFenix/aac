// Cell Systems — example specs.
//
// SAFE_EXAMPLES are the ones surfaced in the editor: each demonstrates one
// idle-safe primitive (timers+budget, energy-descent flow, an allowed 2-var
// cycle, a clock-driven settler). UNSAFE_EXAMPLES are the ones the validator is
// supposed to REJECT — kept here so the engine checks can assert it does.

import type { SystemSpec, WorldSpec } from './spec';

/** Seed → … → Dead, advanced purely by TIMERS that spend a finite energy budget.
 *  The whole lifecycle is ~5 scheduled events regardless of how long the player
 *  is away — the cheapest possible thing to fast-forward. */
export const lifecycle: SystemSpec = {
  id: 'lifecycle',
  name: 'Plant lifecycle',
  description: 'Seed sprouts, grows, fruits and dies on timers, spending stored energy. Reaches rest (Dead).',
  vars: [{ name: 'energy', min: 0, max: 10, initial: 10, budget: true }],
  states: [{ name: 'growth', stages: ['Seed', 'Sprout', 'Growing', 'Mature', 'Fruiting', 'Dead'], initial: 'Seed' }],
  rules: [
    { id: 'germinate', when: { stageIs: { state: 'growth', is: 'Seed' } }, trigger: { timer: 3 },
      effects: [{ setStage: { state: 'growth', to: 'Sprout' } }, { add: { scalar: 'energy', amount: -1 } }] },
    { id: 'grow', when: { stageIs: { state: 'growth', is: 'Sprout' } }, trigger: { timer: 4 },
      effects: [{ setStage: { state: 'growth', to: 'Growing' } }, { add: { scalar: 'energy', amount: -2 } }] },
    { id: 'mature', when: { stageIs: { state: 'growth', is: 'Growing' } }, trigger: { timer: 5 },
      effects: [{ setStage: { state: 'growth', to: 'Mature' } }, { add: { scalar: 'energy', amount: -2 } }] },
    { id: 'fruit', when: { stageIs: { state: 'growth', is: 'Mature' } }, trigger: { timer: 4 },
      effects: [{ setStage: { state: 'growth', to: 'Fruiting' } }, { add: { scalar: 'energy', amount: -3 } }] },
    { id: 'wither', when: { stageIs: { state: 'growth', is: 'Fruiting' } }, trigger: { timer: 6 },
      effects: [{ setStage: { state: 'growth', to: 'Dead' } }] },
  ],
};

/** A → B energy-descent "reaction": the reactant A is the budget and only ever
 *  drains, flowing into product B (total conserved). Settles when A is spent. */
export const reaction: SystemSpec = {
  id: 'reaction',
  name: 'A → B reaction',
  description: 'High-energy reactant A converts to stable product B until A is exhausted (monotone, conserved).',
  vars: [
    { name: 'A', min: 0, max: 10, initial: 10, budget: true },
    { name: 'B', min: 0, max: 10, initial: 0 },
  ],
  rules: [
    { id: 'convert', when: { cmp: '>', left: { scalar: 'A' }, right: { const: 0 } }, trigger: { every: true },
      effects: [
        { change: { scalar: 'A', perStep: -0.1, times: { scalar: 'A' } } },
        { change: { scalar: 'B', perStep: 0.1, times: { scalar: 'A' } } },
      ] },
  ],
};

/** Damped predator–prey: a 2-variable feedback loop. Bounded ⇒ provably non-
 *  chaotic (Poincaré–Bendixson); the damping term spirals it into the fixed
 *  point so it reaches rest while idle. Remove the `-damp·(x-c)` terms and it
 *  rides a neutral cycle forever (also allowed — just never rests). */
const C = 5; // population equilibrium each side oscillates around
export const predatorPrey: SystemSpec = {
  id: 'predator-prey',
  name: 'Predator / prey (damped)',
  description: 'Prey and predator oscillate and spiral into balance. The one sanctioned 2-variable cycle.',
  vars: [
    { name: 'prey', min: 0, max: 10, initial: 7 },
    { name: 'pred', min: 0, max: 10, initial: 5 },
  ],
  rules: [
    { id: 'prey-dyn', trigger: { every: true }, effects: [
      { change: { scalar: 'prey', perStep: -0.12, times: { scalar: 'pred' }, offset: C } }, // -ω(pred-c)
      { change: { scalar: 'prey', perStep: -0.02, times: { scalar: 'prey' }, offset: C } }, // -δ(prey-c) damping
    ] },
    { id: 'pred-dyn', trigger: { every: true }, effects: [
      { change: { scalar: 'pred', perStep: 0.12, times: { scalar: 'prey' }, offset: C } },  // +ω(prey-c)
      { change: { scalar: 'pred', perStep: -0.02, times: { scalar: 'pred' }, offset: C } },  // -δ(pred-c) damping
    ] },
  ],
};

/** A day/night CLOCK driving a settling variable (read-only coupling). The plant
 *  opens by day, closes by night; `openness` relaxes (toward a constant) within
 *  each phase, so it tracks the clock without ever being an oscillator itself.
 *  Fast-forward evaluates the clock by formula and only wakes at dawn/dusk. */
export const dayNight: SystemSpec = {
  id: 'day-night',
  name: 'Day / night flower',
  description: 'A fixed-period clock opens the flower by day and closes it by night. Predictable forever.',
  vars: [{ name: 'openness', min: 0, max: 1, initial: 0 }],
  clocks: [{ name: 'day', period: 120, phase: 0 }],
  rules: [
    { id: 'open', when: { cmp: '<', left: { clock: 'day' }, right: { const: 0.5 } }, trigger: { every: true },
      effects: [{ toward: { scalar: 'openness', target: { const: 1 }, rate: 0.1 } }] },
    { id: 'close', when: { cmp: '>=', left: { clock: 'day' }, right: { const: 0.5 } }, trigger: { every: true },
      effects: [{ toward: { scalar: 'openness', target: { const: 0 }, rate: 0.1 } }] },
  ],
};

export const SAFE_EXAMPLES: SystemSpec[] = [lifecycle, reaction, predatorPrey, dayNight];

// --- Specs the validator must reject ----------------------------------------

/** Three mutually-coupled variables (a → b → c → a): the three-body / food-chain
 *  case. Rejected — 3-D coupling can be chaotic and isn't fast-forwardable. */
export const chaos3: SystemSpec = {
  id: 'chaos3',
  name: '3-variable loop (unsafe)',
  vars: [
    { name: 'a', min: 0, max: 10, initial: 5 },
    { name: 'b', min: 0, max: 10, initial: 5 },
    { name: 'c', min: 0, max: 10, initial: 5 },
  ],
  rules: [
    { id: 'a', trigger: { every: true }, effects: [{ change: { scalar: 'b', perStep: 0.1, times: { scalar: 'a' } } }] },
    { id: 'b', trigger: { every: true }, effects: [{ change: { scalar: 'c', perStep: 0.1, times: { scalar: 'b' } } }] },
    { id: 'c', trigger: { every: true }, effects: [{ change: { scalar: 'a', perStep: 0.1, times: { scalar: 'c' } } }] },
  ],
};

/** An autonomous rule that REGENERATES a budget — breaks the monotone progress
 *  measure, so the cell could change forever. Rejected (rule 2). */
export const budgetRegen: SystemSpec = {
  id: 'budget-regen',
  name: 'Self-refilling budget (unsafe)',
  vars: [{ name: 'energy', min: 0, max: 10, initial: 5, budget: true }],
  rules: [
    { id: 'refill', trigger: { every: true }, effects: [{ add: { scalar: 'energy', amount: 1 } }] },
  ],
};

/** A clock that periodically FORCES a 2-variable oscillator — re-introduces the
 *  third dimension and the chaos. Rejected (rule 5). */
export const forcedOscillator: SystemSpec = {
  id: 'forced-oscillator',
  name: 'Clock-forced oscillator (unsafe)',
  vars: [
    { name: 'prey', min: 0, max: 10, initial: 7 },
    { name: 'pred', min: 0, max: 10, initial: 5 },
  ],
  clocks: [{ name: 'season', period: 200 }],
  rules: [
    { id: 'prey-dyn', trigger: { every: true }, effects: [
      { change: { scalar: 'prey', perStep: -0.12, times: { scalar: 'pred' }, offset: 5 } },
      // season forcing of a loop variable — the illegal coupling:
      { change: { scalar: 'prey', perStep: 0.05, times: { clock: 'season' } } },
    ] },
    { id: 'pred-dyn', trigger: { every: true }, effects: [
      { change: { scalar: 'pred', perStep: 0.12, times: { scalar: 'prey' }, offset: 5 } },
    ] },
  ],
};

export const UNSAFE_EXAMPLES: SystemSpec[] = [chaos3, budgetRegen, forcedOscillator];

// --- Grid examples (Step 2: spread & flow across tiles) ---------------------

/** Pure equalising diffusion: a central blob of "stuff" spreads to a flat field.
 *  Conserved (nothing is created/destroyed) and monotone ⇒ settles. */
export const diffusion: SystemSpec = {
  id: 'diffusion',
  name: 'Diffusion',
  description: 'A blob of material spreads evenly across the grid and stops. Conserved + settles.',
  vars: [{ name: 'stuff', min: 0, max: 100, initial: 0, init: 'centerBlob' }],
  rules: [{ id: 'spread', trigger: { every: true }, effects: [{ spread: { scalar: 'stuff', rate: 0.25 } }] }],
  display: { field: 'stuff', min: 0, max: 60, from: [20, 24, 40], to: [120, 200, 255] },
};

/** Water flowing downhill over a STATIC bowl-shaped landscape, pooling in the
 *  low centre. `height` is never modified, so it's a fixed potential. Conserved. */
export const puddle: SystemSpec = {
  id: 'puddle',
  name: 'Puddle (flow downhill)',
  description: 'Water flows down a fixed bowl landscape and pools in the basin. Conserved + settles.',
  vars: [
    { name: 'height', min: 0, max: 20, initial: 10, init: 'bowl' },
    { name: 'water', min: 0, max: 40, initial: 4, init: 'flat' },
  ],
  rules: [{ id: 'flow', trigger: { every: true }, effects: [{ flowDown: { scalar: 'water', potential: 'height', rate: 0.3 } }] }],
  display: { field: 'water', min: 0, max: 12, from: [40, 50, 35], to: [60, 150, 230] },
};

/** A GLOBAL day/night clock driving every tile's flower open/closed. Shows a
 *  clock waking the whole grid at dawn/dusk while each tile settles between. */
export const dayField: SystemSpec = {
  id: 'day-field',
  name: 'Day / night field',
  description: 'One global clock opens every flower by day and closes it by night. Predictable forever.',
  vars: [{ name: 'openness', min: 0, max: 1, initial: 0, init: 'noise' }],
  clocks: [{ name: 'day', period: 120, phase: 0 }],
  rules: [
    { id: 'open', when: { cmp: '<', left: { clock: 'day' }, right: { const: 0.5 } }, trigger: { every: true },
      effects: [{ toward: { scalar: 'openness', target: { const: 1 }, rate: 0.1 } }] },
    { id: 'close', when: { cmp: '>=', left: { clock: 'day' }, right: { const: 0.5 } }, trigger: { every: true },
      effects: [{ toward: { scalar: 'openness', target: { const: 0 }, rate: 0.1 } }] },
  ],
  display: { field: 'openness', min: 0, max: 1, from: [30, 30, 50], to: [255, 220, 90] },
};

/** A colony that GROWS by spending a finite per-tile `food` budget and SPREADS to
 *  neighbours — transport (population) + a draining budget together. Settles once
 *  the food is used up and the population has diffused. */
export const colony: SystemSpec = {
  id: 'colony',
  name: 'Colony (grow + spread)',
  description: 'Population grows while local food lasts and spreads to neighbours, then settles.',
  vars: [
    { name: 'pop', min: 0, max: 1, initial: 0, init: 'centerBlob' },
    { name: 'food', min: 0, max: 5, initial: 5, budget: true, init: 'flat' },
  ],
  rules: [
    { id: 'grow', when: { cmp: '>', left: { scalar: 'food' }, right: { const: 0 } }, trigger: { every: true },
      effects: [
        { toward: { scalar: 'pop', target: { const: 1 }, rate: 0.05 } },
        { add: { scalar: 'food', amount: -0.05 } },
      ] },
    { id: 'spread', trigger: { every: true }, effects: [{ spread: { scalar: 'pop', rate: 0.12 } }] },
  ],
  display: { field: 'pop', min: 0, max: 1, from: [40, 40, 40], to: [70, 200, 90] },
};

/** Terrain-in-a-spec: a central massif catches "rain" via a PROMINENCE sensor
 *  (height above the local mean), the hidden moisture flows downhill and SURFACES
 *  as a spring where it exceeds the ground (moisture > height·0.9 — note the
 *  scaled ref and the Ref-valued `offset` for a smooth, settling emission), the
 *  spring water flows down to pool, and greenery fills the watered ground. This
 *  is the behaviour the 4-neighbour DSL couldn't express before sensors — and it
 *  still reaches a steady-state rest. (No erosion yet: height is static.) */
export const rainlands: SystemSpec = {
  id: 'rainlands',
  name: 'Rainlands (prominence → springs)',
  description: 'A hill catches rain (prominence sensor); moisture flows down and springs at the foot, greening the slopes.',
  vars: [
    { name: 'height', min: 0, max: 24, initial: 12, init: 'centerBlob' }, // baseline 12, peak 24
    { name: 'moisture', min: 0, max: 20, initial: 0, init: 'flat' },
    { name: 'water', min: 0, max: 40, initial: 0, init: 'flat' },
    { name: 'fertility', min: 0, max: 1, initial: 0, init: 'flat' },
    { name: 'plant', min: 0, max: 1, initial: 0, init: 'flat' },
  ],
  sensors: [{ name: 'prom', of: 'height', op: 'prominence', radius: 6, weight: 'cosine', cap: 6 }],
  rules: [
    // Rain: prominent ground accumulates hidden moisture (∝ capped prominence).
    { id: 'rain', when: { cmp: '>', left: { sensor: 'prom' }, right: { const: 1 } }, trigger: { every: true },
      effects: [{ change: { scalar: 'moisture', perStep: 0.3, times: { sensor: 'prom' } } }] },
    { id: 'moist-decay', trigger: { every: true }, effects: [{ add: { scalar: 'moisture', amount: -0.005 } }] },
    // Hidden water table flows downhill, concentrating at the massif foot.
    { id: 'moist-flow', trigger: { every: true }, effects: [{ flowDown: { scalar: 'moisture', potential: 'height', rate: 0.7 } }] },
    // Spring: a capped trickle where the table breaches the surface (the foot).
    { id: 'spring', when: { cmp: '>', left: { scalar: 'moisture' }, right: { scalar: 'height', scale: 0.9 } }, trigger: { every: true },
      effects: [
        { change: { scalar: 'moisture', perStep: -1, times: { scalar: 'moisture' }, offset: { scalar: 'height', scale: 0.9 }, cap: 0.15 } },
        { change: { scalar: 'water', perStep: 1, times: { scalar: 'moisture' }, offset: { scalar: 'height', scale: 0.9 }, cap: 0.15 } },
      ] },
    // Surface water flows downhill + off the edge (sea), evaporates, and seeps into
    // the ground proportional to depth (the structural anti-flood sink).
    { id: 'water-flow', trigger: { every: true }, effects: [{ flowDown: { scalar: 'water', potential: 'height', rate: 0.2, drainEdge: 0 } }] },
    { id: 'evap', trigger: { every: true }, effects: [{ add: { scalar: 'water', amount: -0.06 } }] },
    { id: 'seep', trigger: { every: true }, effects: [{ change: { scalar: 'water', perStep: -0.08, times: { scalar: 'water' } } }] },
    // Fertility: watered ground greens, the halo spreads a little and decays back.
    { id: 'wet-soil', when: { cmp: '>', left: { scalar: 'water' }, right: { const: 0.05 } }, trigger: { every: true },
      effects: [{ toward: { scalar: 'fertility', target: { const: 1 }, rate: 0.2 } }] },
    { id: 'fert-spread', trigger: { every: true }, effects: [{ spread: { scalar: 'fertility', rate: 0.1 } }] },
    { id: 'fert-decay', trigger: { every: true }, effects: [{ add: { scalar: 'fertility', amount: -0.05 } }] },
    // Plants track fertility (grow into fertile soil, recede when it dries).
    { id: 'plant', trigger: { every: true }, effects: [{ toward: { scalar: 'plant', target: { scalar: 'fertility' }, rate: 0.03 } }] },
  ],
  display: { field: 'water', min: 0, max: 8, from: [70, 90, 60], to: [40, 120, 220] },
};

/** The MAIN-GRID default: the rainlands ecology + a solid `stone` substrate that
 *  blocks flow, player tools (water / raise / dig / stone / seed), and composite
 *  render layers (sand relief → plants → water → stone). This is "the system as it
 *  is now", re-expressed as a spec the player can edit. */
export const terrain: SystemSpec = {
  id: 'terrain',
  name: 'Terrain (default)',
  description: 'The sandbox ecology as a spec: sculpt sand, pour water, drop stone & seeds; springs and oases emerge.',
  vars: [
    // Land baseline 14 (well above sea level 0) with a hill to 28 — so water pools
    // on the land and drains at the map edges, exactly like the original engine.
    { name: 'height', min: 0, max: 28, initial: 14, init: 'centerBlob' },
    { name: 'moisture', min: 0, max: 20, initial: 0, init: 'flat' }, // moistMax (original)
    { name: 'water', min: 0, max: 40, initial: 0, init: 'flat' },
    { name: 'fertility', min: 0, max: 1, initial: 0, init: 'flat' },
    { name: 'plant', min: 0, max: 1, initial: 0, init: 'flat' },
    { name: 'solid', min: 0, max: 1, initial: 0, init: 'flat' },
  ],
  // Constants ported from the original terrain engine (config.ts ECO): promRadius
  // 6, promThreshold 1, promCap 6, moistGain 0.3, moistDecay 0.005, moistDiffuse
  // 0.7, springBreach 0.9, springRate≈0.15, waterFlow 0.2, evap 0.1, edgeDrain 0.
  // Prominence is CAPPED + the boundary is OPEN (drainEdge), so inflow is bounded
  // and has an outlet → it can't flood.
  sensors: [{ name: 'prom', of: 'height', op: 'prominence', radius: 6, weight: 'cosine', cap: 6 }],
  rules: [
    { id: 'rain', when: { cmp: '>', left: { sensor: 'prom' }, right: { const: 1 } }, trigger: { every: true },
      effects: [{ change: { scalar: 'moisture', perStep: 0.3, times: { sensor: 'prom' } } }] },
    { id: 'moist-decay', trigger: { every: true }, effects: [{ add: { scalar: 'moisture', amount: -0.005 } }] },
    { id: 'moist-flow', trigger: { every: true }, effects: [{ flowDown: { scalar: 'moisture', potential: 'height', rate: 0.7, block: 'solid' } }] },
    // Spring = a CAPPED trickle: emit min(0.15, moisture − 0.9·height) per step
    // (perStep 1 makes the factor the raw excess; cap throttles it). Proportional
    // near the breach (settles), capped above (so water inflow can't flood).
    // Spring = a capped trickle min(springRate=0.15, moisture − 0.9·height). The
    // breach 0.9 is the key flood-limiter: it surfaces ONLY where the (downhill-
    // concentrated) water table exceeds the ground — the foot, not the whole map —
    // so the number of spring cells stays small and total inflow stays well under
    // total evaporation + edge drainage. The peak's high breach (0.9·peak) isn't
    // reached (moisture drained off it), so the peak stays dry.
    { id: 'spring', when: { cmp: '>', left: { scalar: 'moisture' }, right: { scalar: 'height', scale: 0.9 } }, trigger: { every: true },
      effects: [
        { change: { scalar: 'moisture', perStep: -1, times: { scalar: 'moisture' }, offset: { scalar: 'height', scale: 0.9 }, cap: 0.15 } },
        { change: { scalar: 'water', perStep: 1, times: { scalar: 'moisture' }, offset: { scalar: 'height', scale: 0.9 }, cap: 0.15 } },
      ] },
    // Water flows downhill, off the map edge (drainEdge: 0 = sea level — the open
    // boundary that stops a closed basin flooding), and evaporates.
    { id: 'water-flow', trigger: { every: true }, effects: [{ flowDown: { scalar: 'water', potential: 'height', rate: 0.2, block: 'solid', drainEdge: 0 } }] },
    // Erosion: flowing water carries sand downstream, incising channels (gentle —
    // a slow background grading). Stone doesn't erode.
    { id: 'erode', trigger: { every: true }, effects: [{ erode: { scalar: 'height', by: 'water', rate: 0.04, minFlow: 0.15, minSlope: 0.12, max: 0.03, block: 'solid' } }] },
    { id: 'evap', trigger: { every: true }, effects: [{ add: { scalar: 'water', amount: -0.06 } }] },
    // Percolation: water also seeps into the ground at a rate PROPORTIONAL to its
    // depth. A constant sink (evaporation) can be out-paced by enough springs and
    // flood a closed basin; a proportional sink CANNOT — the deeper the water the
    // faster it drains, so the total settles at inflow/k for ANY inflow and any
    // geometry (bounded torus included). This is what makes "never floods"
    // STRUCTURAL rather than a tuned balance.
    { id: 'seep', trigger: { every: true }, effects: [{ change: { scalar: 'water', perStep: -0.08, times: { scalar: 'water' } } }] },
    { id: 'wet-soil', when: { all: [{ cmp: '>', left: { scalar: 'water' }, right: { const: 0.05 } }, { cmp: '<', left: { scalar: 'solid' }, right: { const: 0.5 } }] }, trigger: { every: true },
      effects: [{ toward: { scalar: 'fertility', target: { const: 1 }, rate: 0.2 } }] },
    { id: 'fert-spread', trigger: { every: true }, effects: [{ spread: { scalar: 'fertility', rate: 0.1 } }] },
    { id: 'fert-decay', trigger: { every: true }, effects: [{ add: { scalar: 'fertility', amount: -0.05 } }] },
    { id: 'plant', trigger: { every: true }, effects: [{ toward: { scalar: 'plant', target: { scalar: 'fertility' }, rate: 0.03 } }] },
  ],
  // Tool `amount` is per SECOND (the canvas applies amount × dwell-intensity × dt).
  tools: [
    { id: 'water', label: 'Water', symbol: '💧', radius: 1.6, paints: [{ scalar: 'water', amount: 4 }] },
    { id: 'raise', label: 'Raise', symbol: '⛰️', radius: 1.6, paints: [{ scalar: 'height', amount: 4 }] },
    { id: 'dig', label: 'Dig', symbol: '⛏️', radius: 1.6, paints: [{ scalar: 'height', amount: -4 }] },
    { id: 'stone', label: 'Stone', symbol: '🪨', radius: 1.2, paints: [{ scalar: 'solid', amount: 6 }] },
    { id: 'seed', label: 'Seed', symbol: '🌱', radius: 1.0, paints: [{ scalar: 'plant', amount: 3 }] },
  ],
  display: {
    field: 'water',
    layers: [
      { field: 'height', shade: true, min: 0, max: 12, from: [214, 184, 124], to: [150, 120, 80] }, // sand relief
      { field: 'plant', over: 0.05, min: 0, max: 1, from: [120, 176, 74], to: [28, 110, 46] },       // greenery
      { field: 'water', over: 0.05, min: 0, max: 6, from: [99, 178, 220], to: [17, 64, 122] },        // water by depth
      { field: 'solid', over: 0.5, min: 0, max: 1, from: [130, 130, 135], to: [95, 95, 100] },        // stone
    ],
  },
};

// --- Integer-level examples (the idle-safe baseline) ------------------------

/** Integer diffusion: a blob of whole units spreads to a (near-)flat field in
 *  whole-unit steps and stops EXACTLY when no gap ≥ 2 remains — no asymptotic
 *  ε-tail, so it reaches crisp rest fast. Conserved. */
export const intDiffusion: SystemSpec = {
  id: 'int-diffusion',
  name: 'Integer diffusion',
  description: 'Whole-unit diffusion: a blob spreads out and halts exactly (the crisp, idle-safe baseline).',
  vars: [{ name: 'units', min: 0, max: 15, initial: 0, init: 'centerBlob', int: true }],
  rules: [{ id: 'spread', trigger: { every: true }, effects: [{ spread: { scalar: 'units', rate: 1 } }] }],
  display: { field: 'units', min: 0, max: 15, from: [20, 24, 40], to: [120, 200, 255] },
};

/** Integer water flowing down a fixed bowl in whole units — pools in the basin and
 *  stops exactly. Conserved (closed; no edge drain). The bowl is STEEP (max 60):
 *  whole-unit transport only moves where the gradient exceeds the quantization
 *  (gap ≥ 2), so an integer landscape must be tall enough relative to its width —
 *  a gentle bowl would round to ≤1-per-tile and nothing would flow. */
export const intPuddle: SystemSpec = {
  id: 'int-puddle',
  name: 'Integer puddle',
  description: 'Whole-unit water flows down a steep bowl, pools in the basin, and halts exactly.',
  vars: [
    { name: 'height', min: 0, max: 60, initial: 30, init: 'bowl', int: true },
    { name: 'water', min: 0, max: 60, initial: 8, init: 'flat', int: true },
  ],
  rules: [{ id: 'flow', trigger: { every: true }, effects: [{ flowDown: { scalar: 'water', potential: 'height', rate: 1 } }] }],
  display: { field: 'water', min: 0, max: 16, from: [40, 50, 35], to: [60, 150, 230] },
};

/** INTEGER TERRAIN — the idle-safe default. Everything is whole-unit + clock-paced
 *  (the integer+timer baseline), so it stays bounded and catches up by folding its
 *  exact cycle rather than chasing an ε-tail. The bottom of the long-term stack:
 *  HEIGHT (player-sculpted) → WATER (rain on the heights flows downhill into rivers
 *  & lakes, draining at the edges + seeping away so it never floods) → PLANTS
 *  (green spreads where there's water). Stone blocks flow and doesn't erode.
 *
 *  Integer note: whole-unit flow needs gradients ≥ 2, so the terrain is "tall"
 *  (height 0–63) — a steep peak drives crisp rivers; a flat plain just sits. */
export const intTerrain: SystemSpec = {
  id: 'int-terrain',
  name: 'Terrain (integer)',
  description: 'Idle-safe terrain: sculpt tall land, rain runs off the heights into rivers & lakes, greenery follows the water.',
  vars: [
    { name: 'height', min: 0, max: 63, initial: 30, init: 'centerBlob', int: true },
    { name: 'water', min: 0, max: 31, initial: 0, init: 'flat', int: true },
    { name: 'plant', min: 0, max: 7, initial: 0, init: 'flat', int: true },
    { name: 'solid', min: 0, max: 1, initial: 0, init: 'flat', int: true },
  ],
  sensors: [
    { name: 'prom', of: 'height', op: 'prominence', radius: 6, weight: 'cosine', cap: 8 },
    { name: 'nearWater', of: 'water', op: 'max', radius: 1 },
  ],
  clocks: [
    { name: 'rainTick', period: 3 },  // rain pulse cadence
    { name: 'slowTick', period: 24 }, // evaporation / plant cadence
  ],
  rules: [
    // Rain: prominent ground catches a unit of water every rain pulse (orographic).
    { id: 'rain', when: { all: [{ cmp: '==', left: { clock: 'rainTick' }, right: { const: 0 } }, { cmp: '>', left: { sensor: 'prom' }, right: { const: 2 } }] }, trigger: { every: true },
      effects: [{ add: { scalar: 'water', amount: 1 } }] },
    // Water runs downhill (whole units), off the map edge (sea), blocked by stone.
    { id: 'flow', trigger: { every: true }, effects: [{ flowDown: { scalar: 'water', potential: 'height', rate: 1, drainEdge: 0, block: 'solid' } }] },
    // Percolation: deep water seeps away proportional to depth — the structural
    // anti-flood sink that works even on a closed (toroidal) map. (Only bites at
    // depth ≥ ~3, so shallow streams survive while deep pools can't run away.)
    { id: 'seep', trigger: { every: true }, effects: [{ change: { scalar: 'water', perStep: -0.18, times: { scalar: 'water' } } }] },
    // Slow evaporation clears shallow, unfed water.
    { id: 'evap', when: { all: [{ cmp: '==', left: { clock: 'slowTick' }, right: { const: 0 } }, { cmp: '>', left: { scalar: 'water' }, right: { const: 0 } }] }, trigger: { every: true },
      effects: [{ add: { scalar: 'water', amount: -1 } }] },
    // Plants: green grows where there's water nearby (not on stone), recedes when dry.
    { id: 'grow', when: { all: [{ cmp: '==', left: { clock: 'slowTick' }, right: { const: 0 } }, { cmp: '>', left: { sensor: 'nearWater' }, right: { const: 0 } }, { cmp: '<', left: { scalar: 'solid' }, right: { const: 0.5 } }] }, trigger: { every: true },
      effects: [{ add: { scalar: 'plant', amount: 1 } }] },
    { id: 'wither', when: { all: [{ cmp: '==', left: { clock: 'slowTick' }, right: { const: 0 } }, { cmp: '==', left: { sensor: 'nearWater' }, right: { const: 0 } }] }, trigger: { every: true },
      effects: [{ add: { scalar: 'plant', amount: -1 } }] },
  ],
  tools: [
    { id: 'water', label: 'Water', symbol: '💧', radius: 1.6, paints: [{ scalar: 'water', amount: 45 }] },
    { id: 'raise', label: 'Raise', symbol: '⛰️', radius: 1.6, paints: [{ scalar: 'height', amount: 70 }] },
    { id: 'dig', label: 'Dig', symbol: '⛏️', radius: 1.6, paints: [{ scalar: 'height', amount: -70 }] },
    { id: 'stone', label: 'Stone', symbol: '🪨', radius: 1.2, paints: [{ scalar: 'solid', amount: 40 }] },
    { id: 'seed', label: 'Seed', symbol: '🌱', radius: 1.0, paints: [{ scalar: 'plant', amount: 30 }] },
  ],
  display: {
    field: 'water',
    layers: [
      { field: 'height', shade: true, min: 0, max: 63, from: [120, 100, 70], to: [235, 225, 205] }, // earth → snow
      { field: 'plant', over: 0.5, min: 0, max: 7, from: [120, 176, 74], to: [28, 110, 46] },
      { field: 'water', over: 0.5, min: 0, max: 12, from: [99, 178, 220], to: [17, 64, 122] },
      { field: 'solid', over: 0.5, min: 0, max: 1, from: [130, 130, 135], to: [95, 95, 100] },
    ],
  },
};

/** Like `intTerrain`, but rain is produced at a CONSTANT per-cell RATE instead of
 *  synchronised pulses — no rain clock. Each tile accumulates rainfall into a
 *  hidden integer counter at a rate ∝ its prominence, and converts one whole unit
 *  of water each time the counter fills. Smooth and de-synchronised (high ground
 *  rains faster), still all-integer so it stays bounded and foldable. Same look:
 *  rivers off the heights, green base, never floods. */
export const intTerrainSteady: SystemSpec = {
  id: 'int-terrain-steady',
  name: 'Terrain (steady rain)',
  description: 'Integer terrain with continuous-rate rainfall (no rain pulse): prominence drives a steady drip into rivers.',
  vars: [
    { name: 'height', min: 0, max: 63, initial: 30, init: 'centerBlob', int: true },
    { name: 'water', min: 0, max: 31, initial: 0, init: 'flat', int: true },
    { name: 'plant', min: 0, max: 7, initial: 0, init: 'flat', int: true },
    { name: 'solid', min: 0, max: 1, initial: 0, init: 'flat', int: true },
    { name: 'rainAcc', min: 0, max: 40, initial: 0, init: 'flat', int: true }, // hidden rainfall accumulator
  ],
  sensors: [
    { name: 'prom', of: 'height', op: 'prominence', radius: 6, weight: 'cosine', cap: 8 },
    { name: 'nearWater', of: 'water', op: 'max', radius: 1 },
  ],
  clocks: [{ name: 'slowTick', period: 24 }], // evaporation / plant cadence only — no rain tick
  rules: [
    // Constant-rate rainfall: the accumulator fills by `prominence` units/step …
    { id: 'accumulate', when: { cmp: '>', left: { sensor: 'prom' }, right: { const: 1 } }, trigger: { every: true },
      effects: [{ change: { scalar: 'rainAcc', perStep: 1, times: { sensor: 'prom' } } }] },
    // … and converts one unit of water each time it crosses the threshold.
    { id: 'convert', when: { cmp: '>=', left: { scalar: 'rainAcc' }, right: { const: 20 } }, trigger: { every: true },
      effects: [{ add: { scalar: 'water', amount: 1 } }, { add: { scalar: 'rainAcc', amount: -20 } }] },
    { id: 'flow', trigger: { every: true }, effects: [{ flowDown: { scalar: 'water', potential: 'height', rate: 1, drainEdge: 0, block: 'solid' } }] },
    { id: 'seep', trigger: { every: true }, effects: [{ change: { scalar: 'water', perStep: -0.18, times: { scalar: 'water' } } }] },
    { id: 'evap', when: { all: [{ cmp: '==', left: { clock: 'slowTick' }, right: { const: 0 } }, { cmp: '>', left: { scalar: 'water' }, right: { const: 0 } }] }, trigger: { every: true },
      effects: [{ add: { scalar: 'water', amount: -1 } }] },
    { id: 'grow', when: { all: [{ cmp: '==', left: { clock: 'slowTick' }, right: { const: 0 } }, { cmp: '>', left: { sensor: 'nearWater' }, right: { const: 0 } }, { cmp: '<', left: { scalar: 'solid' }, right: { const: 0.5 } }] }, trigger: { every: true },
      effects: [{ add: { scalar: 'plant', amount: 1 } }] },
    { id: 'wither', when: { all: [{ cmp: '==', left: { clock: 'slowTick' }, right: { const: 0 } }, { cmp: '==', left: { sensor: 'nearWater' }, right: { const: 0 } }] }, trigger: { every: true },
      effects: [{ add: { scalar: 'plant', amount: -1 } }] },
  ],
  tools: intTerrain.tools,
  display: intTerrain.display,
};

/** STABLE integer water: no perpetual rain or sink, so it reaches a true static
 *  rest (not a flux that pulses forever). Water is CONSERVED — it just flows down
 *  and levels into the basins, forming flat lakes that stop exactly; greenery
 *  rings them and also stops. Sculpt the land + pour water (the tools) and it
 *  settles into a consistent shape every time. This is the right water model for
 *  the stack (plants/animals need a STABLE wet region, not a flickering river). */
export const intLakes: SystemSpec = {
  id: 'int-lakes',
  name: 'Lakes (stable water)',
  description: 'Conserved water levels into static lakes and fully rests — sculpt basins, pour water, watch it settle.',
  vars: [
    { name: 'height', min: 0, max: 60, initial: 30, init: 'bowl', int: true }, // a basin
    { name: 'water', min: 0, max: 40, initial: 3, init: 'flat', int: true },   // a conserved amount, no source/sink
    { name: 'plant', min: 0, max: 7, initial: 0, init: 'flat', int: true },
    { name: 'solid', min: 0, max: 1, initial: 0, init: 'flat', int: true },
  ],
  sensors: [{ name: 'nearWater', of: 'water', op: 'max', radius: 1 }],
  rules: [
    // Water just levels out (no rain, no drain, no seep) → pools in the basins and
    // stops exactly. Conserved.
    { id: 'flow', trigger: { every: true }, effects: [{ flowDown: { scalar: 'water', potential: 'height', rate: 1, block: 'solid' } }] },
    // Greenery grows beside water up to its cap (then rests), recedes when dry.
    { id: 'grow', when: { all: [{ cmp: '>', left: { sensor: 'nearWater' }, right: { const: 0 } }, { cmp: '<', left: { scalar: 'solid' }, right: { const: 0.5 } }] }, trigger: { every: true },
      effects: [{ add: { scalar: 'plant', amount: 1 } }] },
    { id: 'wither', when: { cmp: '==', left: { sensor: 'nearWater' }, right: { const: 0 } }, trigger: { every: true },
      effects: [{ add: { scalar: 'plant', amount: -1 } }] },
  ],
  tools: intTerrain.tools,
  display: intTerrain.display,
};

/** "Stabilise in motion": rivers as a COMPUTED flow-accumulation field, not
 *  simulated water. Each tile's `river` = its rainfall + everything draining into
 *  it from upslope (steepest descent over `height`). It's a static derived field —
 *  recomputed only when you sculpt — so a river carries a constant flow with ZERO
 *  per-step processing, and the world reaches true rest. Sinks accumulate into
 *  lakes; greenery lines the significant rivers. Sculpt the land and watch the
 *  whole drainage network instantly re-route. */
export const intRivers: SystemSpec = {
  id: 'int-rivers',
  name: 'Rivers (computed flow)',
  description: 'Rivers as a static drainage network (flow accumulation) — constant flow, no water sim, re-routes when you sculpt.',
  vars: [
    // A basin (bowl): drainage CONVERGES inward into rivers that feed a central
    // lake — a smooth cone would just diverge radially (no rivers). Sculpt to make
    // your own valleys/outlets.
    { name: 'height', min: 0, max: 63, initial: 20, init: 'bowl', int: true },
    { name: 'river', min: 0, max: 4000, initial: 0, int: true, flow: { potential: 'height', source: 1, block: 'solid' } },
    { name: 'plant', min: 0, max: 7, initial: 0, init: 'flat', int: true },
    { name: 'solid', min: 0, max: 1, initial: 0, init: 'flat', int: true },
  ],
  rules: [
    // Greenery lines the significant rivers (and lakes), recedes away from them.
    { id: 'grow', when: { all: [{ cmp: '>', left: { scalar: 'river' }, right: { const: 10 } }, { cmp: '<', left: { scalar: 'solid' }, right: { const: 0.5 } }] }, trigger: { every: true },
      effects: [{ add: { scalar: 'plant', amount: 1 } }] },
    { id: 'wither', when: { cmp: '<=', left: { scalar: 'river' }, right: { const: 10 } }, trigger: { every: true },
      effects: [{ add: { scalar: 'plant', amount: -1 } }] },
  ],
  tools: [
    { id: 'raise', label: 'Raise', symbol: '⛰️', radius: 1.6, paints: [{ scalar: 'height', amount: 70 }] },
    { id: 'dig', label: 'Dig', symbol: '⛏️', radius: 1.6, paints: [{ scalar: 'height', amount: -70 }] },
    { id: 'stone', label: 'Stone', symbol: '🪨', radius: 1.2, paints: [{ scalar: 'solid', amount: 40 }] },
    { id: 'seed', label: 'Seed', symbol: '🌱', radius: 1.0, paints: [{ scalar: 'plant', amount: 30 }] },
  ],
  display: {
    field: 'river',
    layers: [
      { field: 'height', shade: true, min: 0, max: 63, from: [120, 100, 70], to: [235, 225, 205] },
      { field: 'plant', over: 0.5, min: 0, max: 7, from: [120, 176, 74], to: [28, 110, 46] },
      { field: 'river', over: 10, min: 10, max: 200, from: [120, 180, 220], to: [17, 64, 122] }, // streams → big rivers
      { field: 'solid', over: 0.5, min: 0, max: 1, from: [130, 130, 135], to: [95, 95, 100] },
    ],
  },
};

export const GRID_EXAMPLES: SystemSpec[] = [intTerrain, intTerrainSteady, intRivers, intLakes, intDiffusion, intPuddle, diffusion, puddle, dayField, colony, rainlands, terrain];

// --- Step 3: entity / relationship worlds -----------------------------------

/** Cities that grow to a carrying capacity, TRADE wealth (conservative diffusion
 *  along edges), and occasionally WAR (a dissipative spend driven by edge
 *  hostility that decays). All legs are bounded or dissipative ⇒ it settles. */
export const civilization: WorldSpec = {
  id: 'civilization',
  name: 'Civilization',
  description: 'Cities grow, trade wealth along routes, and fight when hostile — then settle to peace and plenty.',
  entity: {
    id: 'city',
    vars: [
      { name: 'population', min: 0, max: 100, initial: 20 },
      { name: 'wealth', min: 0, max: 100, initial: 10 },
    ],
    rules: [
      { id: 'grow', trigger: { every: true }, effects: [{ toward: { scalar: 'population', target: { const: 80 }, rate: 0.05 } }] },
      { id: 'produce', trigger: { every: true }, effects: [{ toward: { scalar: 'wealth', target: { const: 50 }, rate: 0.02 } }] },
    ],
  },
  edge: {
    vars: [{ name: 'hostility', min: 0, max: 1, initial: 0 }],
    rules: [{ id: 'cool', trigger: { every: true }, effects: [{ add: { scalar: 'hostility', amount: -0.02 } }] }],
  },
  exchanges: [{ scalar: 'wealth', rate: 0.1 }], // trade equalises wealth along routes (conserved)
  conflicts: [{ id: 'war', by: 'hostility', threshold: 0.5, cost: [{ scalar: 'population', amount: -0.5 }], decay: 0.01 }],
};

/** The sanctioned PAIRWISE cycle: hostility rises with the populations it connects
 *  and drives war that thins them — a {population ↔ hostility} 2-loop. Bounded ⇒
 *  predictable rise/fall; the validator allows it with a warning. */
export const riseAndFall: WorldSpec = {
  id: 'rise-and-fall',
  name: 'Rise and fall (2-loop)',
  entity: {
    id: 'city',
    vars: [{ name: 'population', min: 0, max: 100, initial: 40 }],
    rules: [{ id: 'grow', trigger: { every: true }, effects: [{ toward: { scalar: 'population', target: { const: 80 }, rate: 0.05 } }] }],
  },
  edge: {
    vars: [{ name: 'hostility', min: 0, max: 1, initial: 0 }],
    rules: [{ id: 'ferment', trigger: { every: true }, effects: [
      { change: { scalar: 'hostility', perStep: 0.004, times: { endpoints: 'population', agg: 'mean' } } },
      { add: { scalar: 'hostility', amount: -0.02 } },
    ] }],
  },
  conflicts: [{ id: 'war', by: 'hostility', threshold: 0.4, cost: [{ scalar: 'population', amount: -0.5 }], decay: 0.01 }],
};

/** UNSAFE: war → suffering → grievance → hostility → war couples THREE attributes
 *  (population, grievance, hostility) in one loop — the civilization three-body
 *  case. The validator rejects it. */
export const unstableCiv: WorldSpec = {
  id: 'unstable-civ',
  name: '3-attribute civ loop (unsafe)',
  entity: {
    id: 'city',
    vars: [
      { name: 'population', min: 0, max: 100, initial: 40 },
      { name: 'grievance', min: 0, max: 1, initial: 0 },
    ],
    rules: [
      { id: 'grow', trigger: { every: true }, effects: [{ toward: { scalar: 'population', target: { const: 80 }, rate: 0.05 } }] },
      // suffering: grievance rises as population falls below capacity (reads population)
      { id: 'suffer', trigger: { every: true }, effects: [{ change: { scalar: 'grievance', perStep: -0.01, times: { scalar: 'population' }, offset: 80 } }] },
    ],
  },
  edge: {
    vars: [{ name: 'hostility', min: 0, max: 1, initial: 0 }],
    rules: [{ id: 'ferment', trigger: { every: true }, effects: [
      { change: { scalar: 'hostility', perStep: 0.01, times: { endpoints: 'grievance', agg: 'sum' } } },
      { add: { scalar: 'hostility', amount: -0.02 } },
    ] }],
  },
  conflicts: [{ id: 'war', by: 'hostility', threshold: 0.3, cost: [{ scalar: 'population', amount: -0.5 }], decay: 0.01 }],
};

/** Roads as desire paths: a producer city's goods flow to consumers along trade
 *  routes; the busy routes wear into highways (road grows with flow), idle ones
 *  stay dirt tracks (road floors at its base). Roads also ease trade (exchange
 *  by:road) — a bounded road↔traffic loop. `production` is a static per-city
 *  parameter (set after creation): producers high, consumers 0. */
export const tradeNetwork: WorldSpec = {
  id: 'trade-network',
  name: 'Trade network (roads)',
  description: 'Goods flow from producers to consumers; well-travelled routes grow into roads, unused ones fade.',
  entity: {
    id: 'town',
    vars: [
      { name: 'goods', min: 0, max: 100, initial: 0 },
      { name: 'production', min: 0, max: 100, initial: 0 }, // static parameter (set per-city)
    ],
    rules: [{ id: 'make', trigger: { every: true }, effects: [{ toward: { scalar: 'goods', target: { scalar: 'production' }, rate: 0.1 } }] }],
  },
  edge: {
    vars: [{ name: 'road', min: 0.2, max: 1, initial: 0.2 }], // 0.2 = a dirt track, 1 = a highway
  },
  exchanges: [{ scalar: 'goods', rate: 0.3, by: 'road' }],
  roads: [{ attr: 'road', use: 'goods', rate: 0.05, decay: 0.01 }],
};

/** The map default: cities grow to capacity, produce + trade goods along roads
 *  that form on busy routes, and fight where hostile (which then cools). The one
 *  feedback loop is the bounded road↔goods 2-loop. Drives the World map UI. */
export const worldDefault: WorldSpec = {
  id: 'world',
  name: 'World',
  description: 'Cities grow, trade goods along emergent roads, and war when hostile — then settle.',
  entity: {
    id: 'city',
    vars: [
      { name: 'population', min: 0, max: 100, initial: 20 },
      { name: 'goods', min: 0, max: 100, initial: 0 },
      { name: 'production', min: 0, max: 100, initial: 0 }, // static per-city parameter
    ],
    rules: [
      { id: 'grow', trigger: { every: true }, effects: [{ toward: { scalar: 'population', target: { const: 80 }, rate: 0.04 } }] },
      { id: 'make', trigger: { every: true }, effects: [{ toward: { scalar: 'goods', target: { scalar: 'production' }, rate: 0.1 } }] },
    ],
  },
  edge: {
    vars: [
      { name: 'road', min: 0.2, max: 1, initial: 0.2 },
      { name: 'hostility', min: 0, max: 1, initial: 0 },
    ],
    rules: [{ id: 'cool', trigger: { every: true }, effects: [{ add: { scalar: 'hostility', amount: -0.02 } }] }],
  },
  exchanges: [{ scalar: 'goods', rate: 0.3, by: 'road' }],
  roads: [{ attr: 'road', use: 'goods', rate: 0.05, decay: 0.01 }],
  conflicts: [{ id: 'war', by: 'hostility', threshold: 0.5, cost: [{ scalar: 'population', amount: -0.4 }], decay: 0.01 }],
};

export const WORLD_EXAMPLES: WorldSpec[] = [civilization, riseAndFall, tradeNetwork, worldDefault];
