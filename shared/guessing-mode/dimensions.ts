// shared/guessing-mode/dimensions.ts
//
// The live dimension registry: top-level categories composed from the shared
// clusters plus category-specific dimensions. This is the scaffolding the
// frontend assistant walks; it is deliberately SHALLOW — once a branch is
// narrowed the AI fills in the actual `[GUESS]` buttons from its own knowledge.

import type { DimensionDef, GuessingCategory, GuessingModeState } from "./types.js";
import { isDominant } from "./state.js";
import {
  instantiate,
  PLACE_CLUSTER,
  BODY_PART_CLUSTER,
  FEELING_CLUSTER,
  ACTION_CLUSTER,
  THEME_CLUSTER,
} from "./clusters.js";

/** Top-level category buttons live under the synthetic "category" dimension. */
export const CATEGORY_DIM_ID = "category";
export const CATEGORY_VALUES: GuessingCategory[] = [
  "things",
  "actions",
  "people",
  "places",
  "feelings",
  "time",
];

/** Gate helper: applies only while `things.kind` is dominantly `value`. */
const kindIs = (value: string) => (s: GuessingModeState) =>
  isDominant(s, "things.kind", value);

// ─── things ────────────────────────────────────────────────────────────────
const THINGS: DimensionDef[] = [
  {
    id: "things.kind",
    cluster: "kind",
    type: "categorical",
    role: "steering",
    priority: 10,
    // Child-everyday kinds first (page 1); broader/older-user kinds in the long
    // tail (page 2+), revealed via "More".
    values: [
      "animal", "food", "toy", "clothes", "tool", "vehicle",
      "screen", "nature_thing", "drink", "furniture", "device", "instrument",
    ],
    subquestionLabel: "what kind of thing",
  },
  // Universal "where is it found?" — reused place cluster.
  ...instantiate(PLACE_CLUSTER, "things", { focusLabel: "where you find it" }),
  // Universal "is it related to one of these?" — reused theme cluster.
  ...instantiate(THEME_CLUSTER, "things", { focusLabel: "is it related to one of these" }),
  // Descriptive facts — low priority, rarely suggested, but sharpen the guess.
  {
    id: "things.size",
    cluster: "size",
    type: "ternary",
    role: "descriptive",
    priority: 4,
    values: ["tiny", "medium", "big"],
  },
  {
    id: "things.color",
    cluster: "color",
    type: "categorical",
    role: "descriptive",
    priority: 2,
    values: ["red", "orange_c", "yellow", "green", "blue", "purple", "pink", "brown", "black", "white"],
  },
  {
    id: "things.real_or_imagined",
    cluster: "real_or_imagined",
    type: "binary",
    role: "descriptive",
    priority: 3,
    values: ["real_thing", "from_a_show"],
  },
  {
    id: "things.where_known",
    cluster: "where_known",
    type: "categorical",
    role: "descriptive",
    priority: 2,
    values: ["real_life", "on_screen_known", "in_a_book"],
  },

  // ── kind=animal ──
  ...instantiate(PLACE_CLUSTER, "animal", {
    baseApplicable: kindIs("animal"),
    focusLabel: "where this animal lives",
  }),
  {
    id: "animal.covering",
    cluster: "animal_covering",
    type: "categorical",
    role: "steering",
    priority: 6,
    values: ["furry", "feathers", "scales", "shell", "skin"],
    applicableWhen: kindIs("animal"),
    subquestionLabel: "what the animal feels like",
  },
  {
    id: "animal.diet",
    cluster: "animal_diet",
    type: "categorical",
    role: "steering",
    priority: 5,
    values: ["eats_meat", "eats_plants", "eats_fish", "eats_bugs", "eats_many"],
    applicableWhen: kindIs("animal"),
    subquestionLabel: "what the animal eats",
  },

  // ── kind=food ──
  {
    id: "food.taste",
    cluster: "taste",
    type: "categorical",
    role: "steering",
    priority: 6,
    values: ["sweet", "salty", "sour", "plain"],
    applicableWhen: kindIs("food"),
    subquestionLabel: "how it tastes",
  },
  {
    id: "food.temp",
    cluster: "temperature",
    type: "ternary",
    role: "descriptive",
    priority: 3,
    values: ["hot", "warm", "cold"],
    applicableWhen: kindIs("food"),
  },
  {
    id: "food.texture",
    cluster: "food_texture",
    type: "categorical",
    role: "steering",
    priority: 5,
    values: ["crunchy", "soft_food", "liquid_food"],
    applicableWhen: kindIs("food"),
    subquestionLabel: "what it feels like to eat",
  },
  {
    id: "food.when",
    cluster: "food_when",
    type: "categorical",
    role: "steering",
    priority: 6,
    values: ["breakfast", "lunch", "dinner", "snack", "treat"],
    applicableWhen: kindIs("food"),
    subquestionLabel: "when you eat it",
  },

  // ── kind=clothes ──
  ...instantiate(BODY_PART_CLUSTER, "clothes", {
    baseApplicable: kindIs("clothes"),
    focusLabel: "where it is worn",
  }),
  {
    id: "clothes.when",
    cluster: "clothes_when",
    type: "categorical",
    role: "steering",
    priority: 5,
    values: ["everyday", "fancy", "weather_clothes"],
    applicableWhen: kindIs("clothes"),
    subquestionLabel: "when you wear it",
  },

  // ── kind=toy ──
  {
    id: "toy.form",
    cluster: "toy_form",
    type: "categorical",
    role: "steering",
    priority: 7,
    values: ["physical_toy", "video_game", "app", "show_toy"],
    applicableWhen: kindIs("toy"),
    subquestionLabel: "what kind of toy",
  },
  {
    id: "toy.play",
    cluster: "play_style",
    type: "binary",
    role: "steering",
    priority: 5,
    values: ["play_alone", "play_together"],
    applicableWhen: kindIs("toy"),
    subquestionLabel: "how you play with it",
  },

  // ── kind=tool ──
  {
    id: "tool.purpose",
    cluster: "tool_purpose",
    type: "categorical",
    role: "steering",
    priority: 7,
    values: ["draw_write", "eat_tool", "clean_tool", "fix_tool", "move_tool"],
    applicableWhen: kindIs("tool"),
    subquestionLabel: "what it is for",
  },

  // ── kind=vehicle ──
  {
    id: "vehicle.domain",
    cluster: "vehicle_domain",
    type: "categorical",
    role: "steering",
    priority: 7,
    values: ["land", "water", "air", "space"],
    applicableWhen: kindIs("vehicle"),
    subquestionLabel: "where it travels",
  },

  // ── kind=screen ──
  {
    id: "screen.medium",
    cluster: "screen_medium",
    type: "categorical",
    role: "steering",
    priority: 7,
    values: ["show", "movie", "video_game", "app", "youtube"],
    applicableWhen: kindIs("screen"),
    subquestionLabel: "what you watch it on",
  },
  {
    id: "screen.subject",
    cluster: "screen_subject",
    type: "categorical",
    role: "steering",
    priority: 6,
    values: ["character", "place_in_it", "thing_in_it"],
    applicableWhen: kindIs("screen"),
    subquestionLabel: "what part of it",
  },

  // ── kind=nature_thing ──
  {
    id: "nature.kind",
    cluster: "nature_kind",
    type: "categorical",
    role: "steering",
    priority: 7,
    values: ["plant", "weather", "water_body", "sky_thing", "ground_thing"],
    applicableWhen: kindIs("nature_thing"),
    subquestionLabel: "what kind of nature thing",
  },
];

// ─── actions ─────────────────────────────────────────────────────────────
const ACTIONS: DimensionDef[] = [
  ...instantiate(ACTION_CLUSTER, "actions", { focusLabel: "what kind of action" }),
  // "is it related to one of these?" — reused theme cluster (e.g. a sport, a
  // music activity, a game). Same registry entries as things.theme.
  ...instantiate(THEME_CLUSTER, "actions", { focusLabel: "is it related to one of these" }),
];

// ─── people ──────────────────────────────────────────────────────────────
const PEOPLE: DimensionDef[] = [
  {
    id: "people.relationship",
    cluster: "relationship",
    type: "categorical",
    role: "steering",
    priority: 9,
    // Everyday relationships first; adult-life relationships in the long tail.
    values: ["family", "friend", "helper", "new_person", "coworker", "partner", "neighbor", "professional"],
    subquestionLabel: "who they are to you",
  },
  {
    id: "people.presence",
    cluster: "presence",
    type: "binary",
    role: "steering",
    priority: 7,
    values: ["here_now", "not_here"],
    subquestionLabel: "here or not here",
  },
];

// ─── places ──────────────────────────────────────────────────────────────
const PLACES: DimensionDef[] = [
  ...instantiate(PLACE_CLUSTER, "places", { focusLabel: "which place" }),
  {
    id: "places.activity",
    cluster: "activity",
    type: "categorical",
    role: "steering",
    priority: 6,
    values: ["eat_there", "play_there", "learn_there", "rest_there", "shop_there", "get_help", "work_there", "exercise_there"],
    subquestionLabel: "what you do there",
  },
];

// ─── feelings ──────────────────────────────────────────────────────────────
const FEELINGS: DimensionDef[] = [
  ...instantiate(FEELING_CLUSTER, "feelings", { focusLabel: "which feeling" }),
];

// ─── time ────────────────────────────────────────────────────────────────
// Flat — no fuzzy narrowing. Presented once; a press is effectively the answer.
const TIME: DimensionDef[] = [
  {
    id: "time.when",
    cluster: "time",
    type: "categorical",
    role: "steering",
    priority: 8,
    values: ["now", "earlier_today", "yesterday", "long_ago", "soon", "later", "bedtime", "mealtime", "school_time"],
    subquestionLabel: "when",
  },
];

export const DIMENSIONS_BY_CATEGORY: Record<GuessingCategory, DimensionDef[]> = {
  things: THINGS,
  actions: ACTIONS,
  people: PEOPLE,
  places: PLACES,
  feelings: FEELINGS,
  time: TIME,
};

export const ALL_DIMENSIONS: DimensionDef[] = [
  ...THINGS,
  ...ACTIONS,
  ...PEOPLE,
  ...PLACES,
  ...FEELINGS,
  ...TIME,
];

/** Flat id → DimensionDef lookup (every namespaced id is globally unique). */
export const DIMENSION_BY_ID: Record<string, DimensionDef> = (() => {
  const out: Record<string, DimensionDef> = {};
  for (const d of ALL_DIMENSIONS) {
    if (out[d.id]) {
      throw new Error(`Duplicate guessing dimension id: ${d.id}`);
    }
    out[d.id] = d;
  }
  return out;
})();
