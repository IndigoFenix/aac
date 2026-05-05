// Sandbox Game — Element definitions and rule tables

import type { ElementDef, CellType } from './types';

// Time constants (in ms)
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// State indices for readability
// Soil fertility
const BARREN = 0, POOR = 1, FAIR = 2, RICH = 3;
// Water level
const _DRY = 0, DAMP = 1, WET = 2, FLOODED = 3;
// Growth stages
const S_SEED = 0, S_SPROUT = 1, S_GROWING = 2, S_MATURE = 3, S_FRUITING = 4, S_WITHERED = 5;

const ELEMENTS: Record<CellType, ElementDef> = {
  empty: {
    type: 'empty',
    label: 'Empty',
    states: ['empty'],
    defaultEnergy: 0,
    colors: ['#d4d4d4'],
    icons: [''],
    rules: [],
    placeable: false,
    placeCost: 0,
  },

  stone: {
    type: 'stone',
    label: 'Stone',
    states: ['solid'],
    defaultEnergy: 1,
    colors: ['#78716c'],
    icons: ['🪨'],
    rules: [
      // Stone adjacent to water slowly erodes into soil (24h)
      {
        myState: null, neighborType: 'water', neighborState: null, neighborStateMin: DAMP,
        effect: { type: 'startMyTimer', targetState: 0, targetType: 'soil', targetEnergy: 5, duration: 24 * HOUR },
        energyCost: 1, once: true,
      },
    ],
    placeable: true,
    placeCost: 1,
  },

  soil: {
    type: 'soil',
    label: 'Soil',
    states: ['Barren', 'Poor', 'Fair', 'Rich'],
    defaultEnergy: 10,
    colors: ['#92400e', '#a16207', '#854d0e', '#65a30d'],
    icons: ['🟫', '🟫', '🟤', '🟢'],
    rules: [
      // Soil adjacent to water: slowly increase fertility (2h per step)
      { myState: BARREN, neighborType: 'water', neighborState: null, neighborStateMin: DAMP,
        effect: { type: 'startMyTimer', targetState: POOR, duration: 2 * HOUR }, energyCost: 1, once: true },
      { myState: POOR, neighborType: 'water', neighborState: null, neighborStateMin: DAMP,
        effect: { type: 'startMyTimer', targetState: FAIR, duration: 2 * HOUR }, energyCost: 1, once: true },
      { myState: FAIR, neighborType: 'water', neighborState: null, neighborStateMin: DAMP,
        effect: { type: 'startMyTimer', targetState: RICH, duration: 2 * HOUR }, energyCost: 1, once: true },
      // Soil adjacent to compost: immediate fertility boost, consume compost
      { myState: BARREN, neighborType: 'compost', neighborState: null,
        effect: { type: 'changeMyState', newState: POOR }, energyCost: 0 },
      { myState: POOR, neighborType: 'compost', neighborState: null,
        effect: { type: 'changeMyState', newState: FAIR }, energyCost: 0 },
      { myState: FAIR, neighborType: 'compost', neighborState: null,
        effect: { type: 'changeMyState', newState: RICH }, energyCost: 0 },
    ],
    placeable: true,
    placeCost: 2,
  },

  water: {
    type: 'water',
    label: 'Water',
    states: ['Dry', 'Damp', 'Wet', 'Flooded'],
    defaultEnergy: 8,
    defaultState: FLOODED, // placed as flooded
    colors: ['#bfdbfe', '#60a5fa', '#2563eb', '#1e3a8a'],
    icons: ['💧', '💧', '🌊', '🌊'],
    rules: [
      // Water flow is handled by the flow tick system, not rules.
      // Evaporation — unconditional, solar-powered
      { myState: FLOODED, neighborType: null, neighborState: null,
        effect: { type: 'startMyTimer', targetState: WET, duration: 4 * HOUR }, energyCost: 0, once: true },
      { myState: WET, neighborType: null, neighborState: null,
        effect: { type: 'startMyTimer', targetState: DAMP, duration: 4 * HOUR }, energyCost: 0, once: true },
      { myState: DAMP, neighborType: null, neighborState: null,
        effect: { type: 'startMyTimer', targetState: 0, targetType: 'empty', targetEnergy: 0, duration: 4 * HOUR }, energyCost: 0, once: true },
    ],
    placeable: true,
    placeCost: 3,
  },

  seed: {
    type: 'seed',
    label: 'Seed',
    states: ['Seed', 'Sprout', 'Growing', 'Mature', 'Fruiting', 'Withered'],
    defaultEnergy: 12,
    colors: ['#a16207', '#84cc16', '#22c55e', '#15803d', '#ea580c', '#78716c'],
    icons: ['🌱', '🌿', '🌾', '🌳', '🍎', '🥀'],
    rules: [
      // Seed → Sprout: requires adjacent water
      { myState: S_SEED, neighborType: 'water', neighborState: null, neighborStateMin: DAMP,
        effect: { type: 'startMyTimer', targetState: S_SPROUT, duration: 4 * HOUR }, energyCost: 1, once: true },
      // Subsequent growth is unconditional (solar-powered)
      { myState: S_SPROUT, neighborType: null, neighborState: null,
        effect: { type: 'startMyTimer', targetState: S_GROWING, duration: 4 * HOUR }, energyCost: 1, once: true },
      { myState: S_GROWING, neighborType: null, neighborState: null,
        effect: { type: 'startMyTimer', targetState: S_MATURE, duration: 8 * HOUR }, energyCost: 1, once: true },
      { myState: S_MATURE, neighborType: null, neighborState: null,
        effect: { type: 'startMyTimer', targetState: S_FRUITING, duration: 12 * HOUR }, energyCost: 1, once: true },
      // Fruiting → Withered (decay, unconditional)
      { myState: S_FRUITING, neighborType: null, neighborState: null,
        effect: { type: 'startMyTimer', targetState: S_WITHERED, duration: 24 * HOUR }, energyCost: 0, once: true },
    ],
    placeable: true,
    placeCost: 2,
    placeOn: ['soil'],
  },

  bloom: {
    type: 'bloom',
    label: 'Bloom',
    states: ['Seed', 'Sprout', 'Growing', 'Mature', 'Fruiting', 'Withered'],
    defaultEnergy: 10,
    colors: ['#a16207', '#84cc16', '#22c55e', '#ec4899', '#f472b6', '#78716c'],
    icons: ['🌱', '🌿', '🌾', '🌸', '🌺', '🥀'],
    rules: [
      // Seed → Sprout: requires adjacent water
      { myState: S_SEED, neighborType: 'water', neighborState: null, neighborStateMin: DAMP,
        effect: { type: 'startMyTimer', targetState: S_SPROUT, duration: 4 * HOUR }, energyCost: 1, once: true },
      // Subsequent growth is unconditional (solar-powered)
      { myState: S_SPROUT, neighborType: null, neighborState: null,
        effect: { type: 'startMyTimer', targetState: S_GROWING, duration: 4 * HOUR }, energyCost: 1, once: true },
      { myState: S_GROWING, neighborType: null, neighborState: null,
        effect: { type: 'startMyTimer', targetState: S_MATURE, duration: 8 * HOUR }, energyCost: 1, once: true },
      // Mature bloom self-seeds to adjacent fair+ soil
      { myState: S_MATURE, neighborType: 'soil', neighborState: null, neighborStateMin: FAIR,
        effect: { type: 'spawnOnEmpty', spawnType: 'bloom', spawnState: S_SEED, spawnEnergy: 6, duration: 8 * HOUR },
        energyCost: 3, once: true },
      // Mature → Fruiting (unconditional)
      { myState: S_MATURE, neighborType: null, neighborState: null,
        effect: { type: 'startMyTimer', targetState: S_FRUITING, duration: 12 * HOUR }, energyCost: 1, once: true },
      // Fruiting → Withered (unconditional)
      { myState: S_FRUITING, neighborType: null, neighborState: null,
        effect: { type: 'startMyTimer', targetState: S_WITHERED, duration: 24 * HOUR }, energyCost: 0, once: true },
    ],
    placeable: true,
    placeCost: 2,
    placeOn: ['soil'],
  },

  weed: {
    type: 'weed',
    label: 'Weed',
    states: ['Sprout', 'Growing', 'Mature', 'Spreading'],
    defaultEnergy: 8,
    colors: ['#4d7c0f', '#365314', '#1a2e05', '#1a2e05'],
    icons: ['🌿', '🌵', '🌵', '🌵'],
    rules: [
      // Weed grows unconditionally
      { myState: 0, neighborType: null, neighborState: null,
        effect: { type: 'startMyTimer', targetState: 1, duration: 6 * HOUR }, energyCost: 1, once: true },
      { myState: 1, neighborType: null, neighborState: null,
        effect: { type: 'startMyTimer', targetState: 2, duration: 6 * HOUR }, energyCost: 1, once: true },
      // Mature weed drains adjacent soil fertility
      { myState: 2, neighborType: 'soil', neighborState: null, neighborStateMin: POOR,
        effect: { type: 'changeNeighborState', newState: BARREN }, energyCost: 2 },
      // Mature weed spreads to adjacent soil
      { myState: 2, neighborType: 'soil', neighborState: null, neighborStateMin: BARREN,
        effect: { type: 'spawnOnEmpty', spawnType: 'weed', spawnState: 0, spawnEnergy: 5, duration: 12 * HOUR },
        energyCost: 3, once: true },
    ],
    placeable: false,
    placeCost: 0,
  },

  fruit: {
    type: 'fruit',
    label: 'Fruit',
    states: ['Fresh', 'Ripe', 'Decaying'],
    defaultEnergy: 3,
    colors: ['#f97316', '#ea580c', '#92400e'],
    icons: ['🍊', '🍎', '🍂'],
    rules: [
      // Fruit decays unconditionally over time → compost
      { myState: 0, neighborType: null, neighborState: null,
        effect: { type: 'startMyTimer', targetState: 1, duration: 8 * HOUR }, energyCost: 0, once: true },
      { myState: 1, neighborType: null, neighborState: null,
        effect: { type: 'startMyTimer', targetState: 0, targetType: 'compost', targetEnergy: 3, duration: 8 * HOUR }, energyCost: 0, once: true },
    ],
    placeable: false,
    placeCost: 0,
  },

  compost: {
    type: 'compost',
    label: 'Compost',
    states: ['fresh'],
    defaultEnergy: 3,
    colors: ['#78350f'],
    icons: ['🧱'],
    rules: [
      // Compost adjacent to soil: boost fertility and consume self
      { myState: null, neighborType: 'soil', neighborState: BARREN,
        effect: { type: 'consumeSelf', replacementType: 'empty', replacementState: 0, replacementEnergy: 0 }, energyCost: 1 },
      { myState: null, neighborType: 'soil', neighborState: POOR,
        effect: { type: 'consumeSelf', replacementType: 'empty', replacementState: 0, replacementEnergy: 0 }, energyCost: 1 },
      { myState: null, neighborType: 'soil', neighborState: FAIR,
        effect: { type: 'consumeSelf', replacementType: 'empty', replacementState: 0, replacementEnergy: 0 }, energyCost: 1 },
    ],
    placeable: false,
    placeCost: 0,
  },

  irrigation: {
    type: 'irrigation',
    label: 'Irrigation',
    states: ['dry', 'active'],
    defaultEnergy: 20,
    colors: ['#94a3b8', '#38bdf8'],
    icons: ['🚿', '🚿'],
    rules: [
      // Irrigation adjacent to water (damp+): become active
      { myState: 0, neighborType: 'water', neighborState: null, neighborStateMin: DAMP,
        effect: { type: 'changeMyState', newState: 1 }, energyCost: 0 },
    ],
    placeable: true,
    placeCost: 5,
  },

  scarecrow: {
    type: 'scarecrow',
    label: 'Scarecrow',
    states: ['standing'],
    defaultEnergy: 50,
    colors: ['#fbbf24'],
    icons: ['🎃'],
    rules: [],
    placeable: true,
    placeCost: 4,
  },

  harvester: {
    type: 'harvester',
    label: 'Harvester',
    states: ['Empty', 'Low', 'Medium', 'Full'],
    defaultEnergy: 10,
    colors: ['#6b7280', '#ef4444', '#f97316', '#22c55e'],
    icons: ['⚙️', '⚙️', '⚙️', '⚙️'],
    rules: [
      // Harvester with energy adjacent to fruiting seed/bloom: harvest it
      { myState: null, neighborType: 'seed', neighborState: S_FRUITING,
        effect: { type: 'changeNeighborState', newState: S_WITHERED }, energyCost: 2 },
      { myState: null, neighborType: 'bloom', neighborState: S_FRUITING,
        effect: { type: 'changeNeighborState', newState: S_WITHERED }, energyCost: 2 },
    ],
    placeable: true,
    placeCost: 6,
  },

  storage: {
    type: 'storage',
    label: 'Storage',
    states: ['Empty', 'Partial', 'Full'],
    defaultEnergy: 50,
    colors: ['#d4a574', '#b8860b', '#8b6914'],
    icons: ['📦', '📦', '📦'],
    rules: [],
    placeable: true,
    placeCost: 5,
  },
};

export default ELEMENTS;

/** Get the element definition for a cell type */
export function getElement(type: CellType): ElementDef {
  return ELEMENTS[type];
}

/** All placeable tools (element types the player can use) */
export const PLACEABLE_TOOLS = Object.values(ELEMENTS).filter(e => e.placeable);

/** Special tools that aren't element placements */
export const SPECIAL_TOOLS = [
  { id: 'harvest' as const, label: 'Harvest', icon: '🧺', cost: 1 },
  { id: 'remove' as const, label: 'Remove', icon: '❌', cost: 1 },
];
