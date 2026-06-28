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
    { name: 'height', min: 0, max: 12, initial: 4, init: 'centerBlob' },
    { name: 'moisture', min: 0, max: 40, initial: 0, init: 'flat' },
    { name: 'water', min: 0, max: 40, initial: 0, init: 'flat' },
    { name: 'fertility', min: 0, max: 1, initial: 0, init: 'flat' },
    { name: 'plant', min: 0, max: 1, initial: 0, init: 'flat' },
  ],
  sensors: [{ name: 'prom', of: 'height', op: 'prominence', radius: 4, weight: 'cosine' }],
  rules: [
    // Rain: prominent ground accumulates hidden moisture (∝ prominence).
    { id: 'rain', when: { cmp: '>', left: { sensor: 'prom' }, right: { const: 0.5 } }, trigger: { every: true },
      effects: [{ change: { scalar: 'moisture', perStep: 0.6, times: { sensor: 'prom' } } }] },
    { id: 'moist-decay', trigger: { every: true }, effects: [{ add: { scalar: 'moisture', amount: -0.004 } }] },
    // Hidden water table flows downhill (toward lower ground) — concentrates it
    // at the foot of the massif.
    { id: 'moist-flow', trigger: { every: true }, effects: [{ flowDown: { scalar: 'moisture', potential: 'height', rate: 0.5 } }] },
    // Spring: where the table breaches the surface (moisture > height·0.9), move it
    // smoothly into surface water — continuous (proportional) so it settles.
    { id: 'spring', when: { cmp: '>', left: { scalar: 'moisture' }, right: { scalar: 'height', scale: 0.9 } }, trigger: { every: true },
      effects: [
        { change: { scalar: 'moisture', perStep: -0.2, times: { scalar: 'moisture' }, offset: { scalar: 'height', scale: 0.9 } } },
        { change: { scalar: 'water', perStep: 0.2, times: { scalar: 'moisture' }, offset: { scalar: 'height', scale: 0.9 } } },
      ] },
    // Surface water flows down the landscape and pools; evaporates slowly.
    { id: 'water-flow', trigger: { every: true }, effects: [{ flowDown: { scalar: 'water', potential: 'height', rate: 0.3 } }] },
    { id: 'evap', trigger: { every: true }, effects: [{ add: { scalar: 'water', amount: -0.12 } }] },
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
    { name: 'height', min: 0, max: 16, initial: 4, init: 'centerBlob' },
    { name: 'moisture', min: 0, max: 40, initial: 0, init: 'flat' },
    { name: 'water', min: 0, max: 40, initial: 0, init: 'flat' },
    { name: 'fertility', min: 0, max: 1, initial: 0, init: 'flat' },
    { name: 'plant', min: 0, max: 1, initial: 0, init: 'flat' },
    { name: 'solid', min: 0, max: 1, initial: 0, init: 'flat' },
  ],
  sensors: [{ name: 'prom', of: 'height', op: 'prominence', radius: 4, weight: 'cosine' }],
  rules: [
    { id: 'rain', when: { cmp: '>', left: { sensor: 'prom' }, right: { const: 0.5 } }, trigger: { every: true },
      effects: [{ change: { scalar: 'moisture', perStep: 0.6, times: { sensor: 'prom' } } }] },
    { id: 'moist-decay', trigger: { every: true }, effects: [{ add: { scalar: 'moisture', amount: -0.004 } }] },
    { id: 'moist-flow', trigger: { every: true }, effects: [{ flowDown: { scalar: 'moisture', potential: 'height', rate: 0.5, block: 'solid' } }] },
    { id: 'spring', when: { cmp: '>', left: { scalar: 'moisture' }, right: { scalar: 'height', scale: 0.9 } }, trigger: { every: true },
      effects: [
        { change: { scalar: 'moisture', perStep: -0.2, times: { scalar: 'moisture' }, offset: { scalar: 'height', scale: 0.9 } } },
        { change: { scalar: 'water', perStep: 0.2, times: { scalar: 'moisture' }, offset: { scalar: 'height', scale: 0.9 } } },
      ] },
    { id: 'water-flow', trigger: { every: true }, effects: [{ flowDown: { scalar: 'water', potential: 'height', rate: 0.3, block: 'solid' } }] },
    // Erosion: flowing water carries sand downstream, incising channels (gentle —
    // a slow background grading). Stone doesn't erode.
    { id: 'erode', trigger: { every: true }, effects: [{ erode: { scalar: 'height', by: 'water', rate: 0.04, minFlow: 0.15, minSlope: 0.12, max: 0.03, block: 'solid' } }] },
    { id: 'evap', trigger: { every: true }, effects: [{ add: { scalar: 'water', amount: -0.12 } }] },
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

export const GRID_EXAMPLES: SystemSpec[] = [diffusion, puddle, dayField, colony, rainlands, terrain];

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
