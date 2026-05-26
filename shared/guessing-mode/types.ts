// shared/guessing-mode/types.ts
//
// Core types for AAC Guessing Mode — the fuzzy feature-vector narrowing
// assistant that guides (does not override) the live AI as it plays a
// gentle game of "20 questions" to figure out what the student wants to say.
//
// See planning-docs/aac-guessing-mode/aac-guessing-mode-plan.md → "Reconciled
// design (v2)" for the authoritative design. In short:
//   - Each press applies a SOFT multiplicative update to a dimension's value
//     weights; "unknown" never decays, so a later conflicting press relaxes an
//     earlier belief instead of fighting it to elimination (mistake tolerant).
//   - Top-level categories (things/actions/people/places/feelings/time) are a
//     MODE SWITCH, not a dimension.
//   - Dimensions come from REUSABLE CLUSTERS (place, body_part, feeling,
//     action…) instantiated under a namespace, so "where is it found?" powers
//     top-level places AND "where does this animal live?".
//   - Dimensions have a ROLE: "steering" dims cleave the space and drive the
//     next question; "descriptive" dims (color, size, texture, real_or_imagined)
//     record a fact that sharpens the AI's final guess but are rarely suggested.

export type DimensionType = "categorical" | "binary" | "ternary";

export type DimensionRole = "steering" | "descriptive";

export type GuessingCategory =
  | "things"
  | "actions"
  | "people"
  | "places"
  | "feelings"
  | "time";

export const GUESSING_CATEGORIES: readonly GuessingCategory[] = [
  "things",
  "actions",
  "people",
  "places",
  "feelings",
  "time",
] as const;

/**
 * A single dimension instance in the live registry. `id` is namespaced and
 * globally unique (e.g. "things.kind", "animal.where_found"); `cluster` is the
 * suggestion-registry namespace its VALUES resolve under (a shared cluster name
 * like "place"/"body_part", or — for one-off dimensions — its own local id).
 * Two reuses of the same cluster therefore share one set of registry entries.
 */
export interface DimensionDef {
  id: string;
  cluster: string;
  type: DimensionType;
  role: DimensionRole;
  /** Value tokens (unique within `cluster`). "unknown" is implicit, never listed. */
  values: string[];
  /** Higher = asked sooner. Descriptive dims are damped further at scoring time. */
  priority: number;
  /** When present, the dimension is only eligible while this returns true. */
  applicableWhen?: (s: GuessingModeState) => boolean;
  /** Human label for the injection's "Now figuring out: …" line (English source). */
  subquestionLabel?: string;
}

/** Mutable per-dimension belief state. */
export interface DimensionState {
  /** value → weight. Always seeded with every value at 1.0 plus "unknown": 1.0. */
  weights: Record<string, number>;
  /** User pressed "No" while this dimension was being asked — drop it this session. */
  dismissed?: boolean;
  lastPressedTurn?: number;
}

export interface GuessingModeState {
  category: GuessingCategory | null;
  /** Keyed by DimensionDef.id. Created lazily on first press. */
  dimensions: Record<string, DimensionState>;
  history: Array<{ turn: number; key: string }>;
  /** Student's known special interests, from monitor memory (snake_case-ish). */
  specialInterests: string[];
  turnCount: number;
  /** Namespace currently being drilled, for the injection's focus label. */
  focus?: string;
  /** Set by a "More" press — next injection should expand the same dimension. */
  expandSameDimension?: boolean;
  /** Set by a "none of these" press — next injection tells the AI the user rejected the last options. */
  justRejected?: boolean;
}

/** One suggestion-registry entry. `icon` is an emoji OR a snake_case imageKey. */
export interface SuggestionEntry {
  /** i18n key for the client label, e.g. "guessing.kind.animal". */
  labelKey: string;
  /** Canonical English label (server button text + i18n source of truth). */
  labelEn: string;
  /**
   * Emoji (used directly) or a snake_case imageKey. The existing board pipeline
   * runs `resolveEmoji` on this: an emoji stays, a snake_case key with a known
   * emoji is swapped in, otherwise the icon generator is queued.
   */
  icon: string;
}

/**
 * What the client computes and ships to the server each turn. The server turns
 * `text` into the `[GUESSING STATE]` injection and keeps `suggestionKeys` to
 * validate/expand the suggestion buttons the AI emits in response.
 */
export interface GuessingInjectionWire {
  text: string;
  /** Fully-formed `suggestion:<dim>:<value>` keys the AI is invited to offer. */
  suggestionKeys: string[];
}
