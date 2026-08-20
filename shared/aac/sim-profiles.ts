/**
 * sim-profiles.ts — WHO THE SIMULATED CHILD IS (harness design ⑤).
 *
 * A profile decides three things AT ONCE, and keeping them in one object is
 * what stops the harness testing a child the settings do not describe:
 *
 *   1. PERCEPTION — what the projection is allowed to show them.
 *   2. INPUT — how their presses go wrong (a mis-select, a repeat).
 *   3. SETTINGS — the `aac_settings` row the sim student is seeded with.
 *
 * If (3) drifts from (1), a run measures nothing: a board built for a fluent
 * reader, read by a child who cannot read, scored against neither.
 *
 * WHY THE INPUT DIALS EARN THEIR KEEP. `misselectRate` under eyegaze is the only
 * way anything here can measure `restSpace` or button sizing at all — run one
 * scenario at `restSpace: "none"` and again at `"large"` and compare dead-end
 * presses. `receptiveLevel` is the only way to test whether `languageLevel` does
 * its job: set the setting to 4 and comprehension to `short_phrases`, and the
 * child should visibly fail to follow. If they don't, either the setting or the
 * harness is lying.
 */

import { mulberry32 } from "../prng.js";
import type { RestSpace } from "../button-shape.js";
import { languageLevelToInt, type LanguageLevel } from "../aac-language-level.js";
import type { VerbalAbility } from "./verbal-ability.js";

/**
 * How much of a button this child can take in. Consumed by the projection —
 * defined HERE so a profile and the projection cannot disagree about it.
 */
export interface PerceptionProfile {
  /**
   * none        — labels suppressed entirely; the picture is all there is.
   * logographic — labels shown only for words already met this run.
   * emerging    — labels shown, but words longer than `longWordChars` redacted.
   * fluent      — labels verbatim.
   */
  reading: "none" | "logographic" | "emerging" | "fluent";
  /** Is button colour something they navigate by? */
  colourSalience?: boolean;
  /** `emerging` only: the length a word stops being readable at. */
  longWordChars?: number;
}

/** The subset of `aac_settings` a profile pins. Everything else stays default. */
export interface SimAacSettings {
  /** 1..5, from shared/aac-language-level. What the AI's sentences are LIKE. */
  languageLevel: number;
  /** 1..5, icon-to-text ratio. */
  iconTextRatio: number;
  restSpace: RestSpace;
  selectionMethod: "whole_button" | "selection_area";
  eyegazeEnabled: boolean;
  eyegazeTimeout: number;
  singleGlyphButtons: boolean;
  dynamicBoardsEnabled: boolean;
  autoAudioScan: boolean;
}

export interface ChildProfile {
  id: string;
  /** One line, for the report header. */
  description: string;
  perception: PerceptionProfile;
  // ── input ───────────────────────────────────────────────────────────────
  access: "touch" | "eyegaze" | "switch";
  /** Probability a press lands on a NEIGHBOURING cell instead. */
  misselectRate: number;
  /** Probability a press repeats the previous one. */
  perseveration: number;
  /** Past this, the child gives up waiting and presses again. */
  latencyToleranceMs: number;
  // ── language / cognition ────────────────────────────────────────────────
  verbalAbility: VerbalAbility;
  /** What they UNDERSTAND. Not the same as the `languageLevel` setting, which
   *  is what the AI is told to produce — comparing the two is the test. */
  receptiveLevel: LanguageLevel;
  ageYears: number;
  interests: string[];
  aacSettings: SimAacSettings;
}

/** Settings a profile does not care about; per-profile fields override. */
const BASE_SETTINGS: SimAacSettings = {
  languageLevel: languageLevelToInt("full_sentences"),
  iconTextRatio: 3,
  restSpace: "none",
  selectionMethod: "whole_button",
  eyegazeEnabled: false,
  eyegazeTimeout: 2000,
  singleGlyphButtons: false,
  dynamicBoardsEnabled: false,
  autoAudioScan: false,
};

/** Eyegaze implies the accessibility settings that go with it. Stated once so a
 *  new eyegaze profile cannot forget half of them. */
const EYEGAZE_SETTINGS: Partial<SimAacSettings> = {
  eyegazeEnabled: true,
  restSpace: "large",
  selectionMethod: "selection_area",
};

function settings(over: Partial<SimAacSettings> = {}): SimAacSettings {
  return { ...BASE_SETTINGS, ...over };
}

/**
 * The seed set. Deliberately small and deliberately DIFFERENT from one another
 * — six profiles that stress six different things beat twenty that stress one.
 */
export const SIM_PROFILES: readonly ChildProfile[] = [
  {
    id: "prereader-eyegaze",
    description: "Pre-reading, non-speaking, drives the board with her eyes.",
    perception: { reading: "none", colourSalience: true },
    access: "eyegaze",
    misselectRate: 0.15,
    perseveration: 0.05,
    latencyToleranceMs: 4000,
    verbalAbility: "none",
    receptiveLevel: "simple_sentences",
    ageYears: 7,
    interests: ["dogs", "swimming", "her sister"],
    // The reference Rett-profile student: symbol legibility, rest space and
    // dwell traps all fall out of this one.
    aacSettings: settings({ ...EYEGAZE_SETTINGS, languageLevel: languageLevelToInt("simple_sentences"), iconTextRatio: 1 }),
  },
  {
    id: "emerging-touch",
    description: "Reads short words, says single words, touches the screen.",
    perception: { reading: "emerging", longWordChars: 6, colourSalience: true },
    access: "touch",
    misselectRate: 0.03,
    perseveration: 0.02,
    latencyToleranceMs: 6000,
    verbalAbility: "single_words",
    receptiveLevel: "short_phrases",
    ageYears: 9,
    interests: ["trains", "dinosaurs"],
    // Label length and icon/text ratio are what this one is for.
    aacSettings: settings({ languageLevel: languageLevelToInt("short_phrases"), iconTextRatio: 4 }),
  },
  {
    id: "fluent-reader",
    description: "Reads and speaks fluently; uses AAC for speed and clarity.",
    perception: { reading: "fluent", colourSalience: true },
    access: "touch",
    misselectRate: 0.01,
    perseveration: 0,
    latencyToleranceMs: 8000,
    verbalAbility: "fluent",
    receptiveLevel: "complex",
    ageYears: 13,
    interests: ["football", "space", "arguing"],
    // Vocabulary reach and builder efficiency — the ceiling case.
    aacSettings: settings({ languageLevel: languageLevelToInt("complex"), iconTextRatio: 5, dynamicBoardsEnabled: true }),
  },
  {
    id: "low-receptive",
    description: "Understands short phrases only, though the board looks capable.",
    perception: { reading: "emerging", longWordChars: 5 },
    access: "eyegaze",
    misselectRate: 0.1,
    perseveration: 0.05,
    latencyToleranceMs: 5000,
    verbalAbility: "none",
    receptiveLevel: "short_phrases",
    ageYears: 10,
    interests: ["music", "the cat"],
    // THE MISMATCH IS THE POINT: the setting says full sentences, the child
    // understands short phrases. If the run reads clean, something is lying.
    aacSettings: settings({ ...EYEGAZE_SETTINGS, languageLevel: languageLevelToInt("full_sentences") }),
  },
  {
    id: "perseverating",
    description: "Vocalises, uses a switch, and tends to press the same thing again.",
    perception: { reading: "none" },
    access: "switch",
    misselectRate: 0.02,
    perseveration: 0.3,
    latencyToleranceMs: 3000,
    verbalAbility: "vocalizations",
    receptiveLevel: "single_words",
    ageYears: 6,
    interests: ["bubbles", "spinning things"],
    // Exercises the press-repeat guard and press pacing.
    aacSettings: settings({ languageLevel: languageLevelToInt("single_words"), iconTextRatio: 1, singleGlyphButtons: true }),
  },
  {
    id: "dense-board-gaze",
    description: "Recognises familiar words by sight; loses buttons on a crowded board.",
    perception: { reading: "logographic", colourSalience: true },
    access: "eyegaze",
    misselectRate: 0.2,
    perseveration: 0.05,
    latencyToleranceMs: 4000,
    verbalAbility: "none",
    receptiveLevel: "simple_sentences",
    ageYears: 11,
    interests: ["horses", "baking"],
    // The highest mis-select rate, so board density and corner buttons show up.
    // languageLevel is pinned to match `receptiveLevel` deliberately: inheriting
    // the base default would make this a SECOND comprehension-mismatch case and
    // blur what `low-receptive` is for.
    aacSettings: settings({
      ...EYEGAZE_SETTINGS,
      languageLevel: languageLevelToInt("simple_sentences"),
      autoAudioScan: true,
      iconTextRatio: 2,
    }),
  },
];

export function profileById(id: string): ChildProfile | null {
  return SIM_PROFILES.find((p) => p.id === id) ?? null;
}

// ── the input-noise model ──────────────────────────────────────────────────

/**
 * Where a press ACTUALLY lands.
 *
 * A mis-select goes to a grid NEIGHBOUR — up, down, left or right — because
 * that is how a gaze or a tremor fails. A random cell anywhere on the board
 * would be a different (and much rarer) failure, and modelling it would make
 * dead-end presses look like noise instead of like a layout problem.
 *
 * Seeded, so a scenario replays. `intended` and the result are FLAT indices
 * into the grid in reading order.
 */
export function landedCell(
  intended: number,
  grid: { rows: number; cols: number },
  profile: ChildProfile,
  rand: () => number,
): number {
  const total = grid.rows * grid.cols;
  if (total <= 1 || intended < 0 || intended >= total) return intended;
  if (rand() >= profile.misselectRate) return intended;

  const row = Math.floor(intended / grid.cols);
  const col = intended % grid.cols;
  const options: number[] = [];
  if (row > 0) options.push(intended - grid.cols);
  if (row < grid.rows - 1) options.push(intended + grid.cols);
  if (col > 0) options.push(intended - 1);
  if (col < grid.cols - 1) options.push(intended + 1);
  if (options.length === 0) return intended;
  return options[Math.floor(rand() * options.length) % options.length];
}

/** Whether this press is a perseverative repeat of the last one. */
export function repeatsLastPress(profile: ChildProfile, rand: () => number): boolean {
  return profile.perseveration > 0 && rand() < profile.perseveration;
}

/** A deterministic stream for one (profile, scenario, run) triple. */
export function simRandom(seed: number): () => number {
  return mulberry32(seed);
}
