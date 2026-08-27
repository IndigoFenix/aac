// shared/guessing-mode/clusters.ts
//
// Reusable dimension CLUSTERS and the `instantiate()` helper that stamps a
// cluster out under a namespace. This is what lets the same narrowing question
// power multiple contexts: the `place` cluster is instantiated as top-level
// "places", as "animal.<…>" ("where does this animal live?"), etc.
//
// A cluster template lists LOCAL dimension specs. Intra-cluster gating is
// declared with `appliesWhenLocal` (referencing a sibling LOCAL id);
// instantiate() rewrites those to predicates against the namespaced id and
// AND-s in any `baseApplicable` predicate the caller passes (used for
// cross-cluster gating, e.g. "only while things.kind is dominantly 'animal'").

import type {
  DimensionDef,
  DimensionType,
  DimensionRole,
  GuessingModeState,
} from "./types.js";
import { isDominant } from "./state.js";

export interface ClusterDimSpec {
  /** Local id, unique within the template (e.g. "where_found", "home_room"). */
  local: string;
  /**
   * Suggestion-registry namespace for this dim's values. Usually the template
   * name, but a template may pull in values that live under a different shared
   * cluster (e.g. the `place` template's "home_room" dim resolves under the
   * "home_room" registry namespace).
   */
  cluster: string;
  type: DimensionType;
  role: DimensionRole;
  values: string[];
  priority: number;
  /** Intra-cluster gate: applies only when sibling `dim` holds one of `valueIn`. */
  appliesWhenLocal?: { dim: string; valueIn: string[] };
  subquestionLabel?: string;
}

export interface ClusterTemplate {
  name: string;
  dims: ClusterDimSpec[];
}

export interface InstantiateOptions {
  /**
   * Cross-cluster gate AND-ed into every dimension (e.g. parent value
   * dominant). Receives the dim's LOCAL id, so an instance can stand down
   * per-dimension rather than wholesale — needed when suppressing a redundant
   * instance must not also hide a dim the user already answered.
   */
  baseApplicable?: (s: GuessingModeState, local: string) => boolean;
  /** Added to every dimension's priority (lets a context raise/lower a cluster). */
  priorityBoost?: number;
  /**
   * DEFAULT subquestion label for dims in this instance that declare none of
   * their own. It is NOT a blanket override: a cluster's dims ask genuinely
   * different questions ("who does it" vs "where it happens"), and flattening
   * them all to one instance-wide label is what shipped the actions bug —
   * every narrowing turn announced itself as "what kind of action", so Speaker
   * re-asked the same vague question and BoardManager stopped recognising the
   * offered keys as fitting it. To override ONE dim's question for this
   * instance, use `labelOverrides`.
   */
  focusLabel?: string;
  /**
   * Per-dimension label overrides for this instance, keyed by LOCAL id. Use
   * when a context genuinely renames one question — the `place` cluster's
   * entry question becomes "where this animal lives" under `animal` — while
   * the cluster's other dims keep asking their own ("which room").
   */
  labelOverrides?: Record<string, string>;
}

const nsId = (ns: string, local: string) => `${ns}.${local}`;

/** Stamp a cluster template out under namespace `ns`. */
export function instantiate(
  tpl: ClusterTemplate,
  ns: string,
  opts: InstantiateOptions = {},
): DimensionDef[] {
  const { baseApplicable, priorityBoost = 0, focusLabel, labelOverrides } = opts;

  return tpl.dims.map((spec): DimensionDef => {
    const id = nsId(ns, spec.local);

    // Build the applicability predicate by composing the intra-cluster gate
    // (rewritten to the namespaced sibling id) with any caller base gate.
    let applicableWhen: ((s: GuessingModeState) => boolean) | undefined;
    const localGate = spec.appliesWhenLocal;
    if (localGate || baseApplicable) {
      const siblingId = localGate ? nsId(ns, localGate.dim) : undefined;
      applicableWhen = (s: GuessingModeState): boolean => {
        if (baseApplicable && !baseApplicable(s, spec.local)) return false;
        if (localGate && siblingId) {
          return localGate.valueIn.some((v) => isDominant(s, siblingId!, v));
        }
        return true;
      };
    }

    return {
      id,
      cluster: spec.cluster,
      type: spec.type,
      role: spec.role,
      values: spec.values,
      priority: spec.priority + priorityBoost,
      applicableWhen,
      // Precedence: an explicit per-dim override for THIS instance, then the
      // dim's own question, then the instance-wide default. The dim's own
      // question must outrank `focusLabel` — it is the one that actually
      // describes the buttons being offered.
      subquestionLabel: labelOverrides?.[spec.local] ?? spec.subquestionLabel ?? focusLabel,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Shared cluster templates
// ─────────────────────────────────────────────────────────────────────────

/**
 * `place` — "where is it found?" Includes the nested home/school/nature
 * breakdowns as gated dims so the whole place-narrowing tree comes in one
 * instantiation. Reused for top-level Places and for "where does X live?".
 */
export const PLACE_CLUSTER: ClusterTemplate = {
  name: "place",
  dims: [
    {
      local: "where_found",
      cluster: "place",
      type: "categorical",
      role: "steering",
      priority: 8,
      values: ["at_home", "at_school", "in_the_city", "in_nature", "far_away"],
      subquestionLabel: "where it is",
    },
    {
      local: "home_room",
      cluster: "home_room",
      type: "categorical",
      role: "steering",
      priority: 7,
      values: ["kitchen", "bedroom", "bathroom", "living_room", "closet"],
      appliesWhenLocal: { dim: "where_found", valueIn: ["at_home"] },
      subquestionLabel: "which room",
    },
    {
      local: "school_area",
      cluster: "school_area",
      type: "categorical",
      role: "steering",
      priority: 7,
      values: ["classroom", "playground", "lunchroom"],
      appliesWhenLocal: { dim: "where_found", valueIn: ["at_school"] },
      subquestionLabel: "where at school",
    },
    {
      local: "natural_kind",
      cluster: "natural_places",
      type: "categorical",
      role: "steering",
      priority: 7,
      values: ["water", "sky", "grass", "forest", "mountains", "desert", "snow", "underground"],
      appliesWhenLocal: { dim: "where_found", valueIn: ["in_nature"] },
      subquestionLabel: "which kind of nature place",
    },
  ],
};

/** `body_part` — reused for "where does it hurt?" and "where is it worn?". */
export const BODY_PART_CLUSTER: ClusterTemplate = {
  name: "body_part",
  dims: [
    {
      local: "part",
      cluster: "body_part",
      type: "categorical",
      role: "steering",
      priority: 7,
      values: ["head", "chest_heart", "belly", "arm", "leg", "eye", "nose", "mouth", "ear"],
      subquestionLabel: "which body part",
    },
  ],
};

/**
 * `feeling` — top-level Feelings, and reusable for "how does it feel about it?".
 * `hurt` opens the body_part + pain_scale follow-ups.
 */
export const FEELING_CLUSTER: ClusterTemplate = {
  name: "feeling",
  dims: [
    {
      local: "valence",
      cluster: "valence",
      type: "ternary",
      role: "steering",
      priority: 9,
      values: ["good", "bad", "mixed"],
      subquestionLabel: "good or bad feeling",
    },
    {
      local: "named",
      cluster: "named_feeling",
      type: "categorical",
      role: "steering",
      priority: 8,
      // Common feelings first (page 1); rarer / older-user feelings in the long
      // tail, revealed via "More". `hurt` opens the body_part + pain follow-ups.
      values: [
        "happy", "sad", "angry", "afraid", "hurt", "excited",
        "calm", "tired", "anxious", "frustrated", "bored", "proud",
        "lonely", "embarrassed",
      ],
      subquestionLabel: "which feeling",
    },
    {
      local: "where_hurts",
      cluster: "body_part",
      type: "categorical",
      role: "steering",
      priority: 7,
      values: ["head", "chest_heart", "belly", "arm", "leg", "eye", "nose", "mouth", "ear"],
      appliesWhenLocal: { dim: "named", valueIn: ["hurt"] },
      subquestionLabel: "where it hurts",
    },
    {
      local: "pain_scale",
      cluster: "pain_scale",
      type: "ternary",
      role: "steering",
      priority: 6,
      values: ["a_little", "medium", "a_lot"],
      appliesWhenLocal: { dim: "named", valueIn: ["hurt"] },
      subquestionLabel: "how much it hurts",
    },
    {
      local: "intensity",
      cluster: "intensity",
      type: "binary",
      role: "descriptive",
      priority: 3,
      values: ["strong", "small"],
      subquestionLabel: "how strong the feeling is",
    },
  ],
};

/**
 * `theme` — "is it related to one of these?" A cross-cutting ASSOCIATION facet
 * (topics + activities), NOT a top-level category. Reused under things and
 * actions so the same question powers "what topic is this thing about?" and
 * "what topic is this activity about?". Deliberately long (18 values) so the
 * long tail surfaces via "More" — this is the main home for special-interest
 * narrowing and broad adult topics. Common topics first (page 1).
 */
export const THEME_CLUSTER: ClusterTemplate = {
  name: "theme",
  dims: [
    {
      local: "theme",
      cluster: "theme",
      type: "categorical",
      role: "steering",
      priority: 6,
      values: [
        "sports", "music", "shows_movies", "games", "animals", "food_cooking",
        "vehicles", "outside_nature", "art", "school_learning", "science", "space",
        "history", "computers", "building_making", "books_reading", "weather", "holidays",
      ],
      subquestionLabel: "is it related to one of these",
    },
  ],
};

/** `action` — top-level Actions, and reusable for "what does this thing do?". */
export const ACTION_CLUSTER: ClusterTemplate = {
  name: "action",
  dims: [
    {
      local: "pace",
      cluster: "pace",
      type: "binary",
      role: "steering",
      priority: 7,
      values: ["fast", "slow"],
      subquestionLabel: "fast or slow",
    },
    {
      local: "who",
      cluster: "who",
      type: "categorical",
      role: "steering",
      priority: 7,
      values: ["alone", "with_others", "together"],
      subquestionLabel: "who does it",
    },
    {
      local: "where",
      cluster: "action_where",
      type: "categorical",
      role: "steering",
      priority: 6,
      values: ["inside", "outside", "on_screen"],
      subquestionLabel: "where it happens",
    },
    {
      local: "uses_tool",
      cluster: "uses_tool",
      type: "binary",
      role: "steering",
      priority: 5,
      values: ["yes_tool", "no_tool"],
      subquestionLabel: "uses something or not",
    },
    {
      local: "purpose",
      cluster: "purpose",
      type: "binary",
      role: "descriptive",
      priority: 3,
      values: ["fun", "work"],
      subquestionLabel: "for fun or a job to do",
    },
  ],
};
