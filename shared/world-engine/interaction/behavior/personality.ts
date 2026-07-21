// shared/world-engine/interaction/behavior/personality.ts
//
// A creature's INTRINSIC personality — who it IS, independent of any particular
// partner. Deliberately mirrors the social-trainer bot's PersonalityGenome
// (server/services/social-bot/personality-and-challenge.ts) trait-for-trait, so
// the two systems can converge on ONE personality substrate: the same genome that
// drives an LLM-voiced social peer can drive a canned-dialogue game creature. The
// LLM is a renderer, never the decider (social-bot's stated design) — so a creature
// and a social peer differ only in their PERCEPTION front-end and their TEXT
// surface, not in their personality or decision math. See
// planning-docs/games/creature-personality.md for the unification plan; the intent
// is to lift this genome + the affect engine into a truly shared module and delete
// this mirror.
//
// Two layers, kept distinct (as the social-bot keeps them):
//   • PERSONALITY (this file) — intrinsic, per-creature. "Bear is stubborn and warm."
//   • RELATION (relations.ts) — directed, per-pair. "Bear trusts the player."
// Personality SEEDS relation baselines (a warm creature starts strangers higher)
// and MODULATES compliance (an assertive creature yields less to any command).
//
// ONE DIAL BOARD, NO CHARACTER TYPES (2026-07-10). Every character — a person, a
// drone that obeys anyone, a ruler, an oddball, an alien, a bare gameplay unit — is
// a POINT in this continuous dial space, never a subtype with its own code. There is
// no `if (isDrone)` anywhere; a drone is `{ obedience: 1 }`. Named archetypes
// (PERSONALITY_PRESETS) are DATA — points you can start from and nudge. Behavior is a
// pure function of the dials, so non-standard characters cost zero new branches.
//
// The board has two groups:
//   • SOCIAL-AFFECT GENOME — the 6 traits verbatim from the social-bot genome
//     (shared substrate; the bot uses these, and it never obeys commands).
//   • GAME-NATURE dials — behavior the social-bot has no concept of, chiefly
//     command-following. Each DEFAULTS to the human/social-bot value, so a plain
//     "person" leaves them alone and behaves exactly as before.

export interface Personality {
  // ── Social-affect genome (shared with the social-bot; 0..1) ──────────────
  /** 0 cold … 1 warm — seeds how high relations start + baseline agreeableness. */
  warmth: number;
  /** 0 reserved/opaque … 1 expressive/legible — how readable its mood is. */
  expressiveness: number;
  /** 0 volatile … 1 even — how fast relations swing (spring damping, later). */
  stability: number;
  /** 0 guarded/slow … 1 quick to connect & disclose — relation-building speed. */
  openness: number;
  /** 0 yielding … 1 holds its ground / pushes back — a compliance damper. */
  assertiveness: number;
  /** 0 impatient … 1 forgiving of pauses & repetition — nudges compliance up. */
  patience: number;

  // ── Game-nature dials (no social-bot equivalent; default = human) ─────────
  /**
   * Innate deference to ANY commander, independent of relationship (0..1). This is
   * the FLOOR under compliance: at 0 the creature obeys only those it has come to
   * respect (the human default — you don't take orders from strangers); at 1 it
   * follows instructions by default from anyone (a drone / a bare gameplay unit);
   * 0.7 is a soldier who mostly complies without a personal bond. The relationship
   * still adds ON TOP of the floor. Default 0 preserves the pre-dial behavior.
   */
  obedience: number;
}

/** A featureless average creature — affect axes at the midpoint, obedience 0 (needs
 *  a relationship). Compliance-neutral: passing it changes nothing vs. omitting
 *  personality entirely. The social-bot's default "person" point. */
export const NEUTRAL_PERSONALITY: Personality = {
  warmth: 0.5,
  expressiveness: 0.5,
  stability: 0.5,
  openness: 0.5,
  assertiveness: 0.5,
  patience: 0.5,
  obedience: 0,
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Clamp a partial dial-set into a full Personality (missing affect axes → 0.5,
 *  missing obedience → 0). This is how PRESETS work: a preset is just a partial. */
export function makePersonality(partial: Partial<Personality> = {}): Personality {
  return {
    warmth: clamp01(partial.warmth ?? 0.5),
    expressiveness: clamp01(partial.expressiveness ?? 0.5),
    stability: clamp01(partial.stability ?? 0.5),
    openness: clamp01(partial.openness ?? 0.5),
    assertiveness: clamp01(partial.assertiveness ?? 0.5),
    patience: clamp01(partial.patience ?? 0.5),
    obedience: clamp01(partial.obedience ?? 0),
  };
}

/**
 * Named archetypes as DATA — points in the dial space, not types. Start from one and
 * override any dial. The whole point of the design: a "drone" and an "alien" are
 * reachable purely by turning these same dials, with no behavior code to add.
 *   • person       — the neutral social-bot point (needs a relationship to obey).
 *   • companion    — warm, patient, cooperative pet; obeys a bonded owner readily.
 *   • soldier      — high obedience floor + holds its ground; complies without a bond.
 *   • drone        — obeys anyone by default; flat affect, unshakeable.
 *   • unit         — a bare gameplay piece: full obedience, no emotional surface.
 *   • ruler        — never takes orders (obedience 0, max assertiveness); OTHERS defer
 *                    to it via high relation.authority the world seeds (relations.ts),
 *                    which is where "assumes compliance" actually lives.
 *   • wildcreature — defiant + guarded; obeys only earned respect, and grudgingly.
 *   • oddball      — an unusual-but-valid corner (very expressive, volatile, open).
 */
export const PERSONALITY_PRESETS = {
  person: {},
  companion: { warmth: 0.85, patience: 0.9, openness: 0.7, assertiveness: 0.2, obedience: 0.35 },
  soldier: { obedience: 0.75, assertiveness: 0.6, stability: 0.85, expressiveness: 0.3 },
  drone: { obedience: 1, assertiveness: 0, expressiveness: 0.1, stability: 1, warmth: 0.5 },
  unit: { obedience: 1, expressiveness: 0, stability: 1, warmth: 0.5 },
  ruler: { obedience: 0, assertiveness: 1, warmth: 0.3, patience: 0.3, stability: 0.7 },
  wildcreature: { obedience: 0, openness: 0.15, patience: 0.3, assertiveness: 0.7, warmth: 0.35 },
  oddball: { expressiveness: 0.95, stability: 0.2, openness: 0.9, assertiveness: 0.5 },
} as const satisfies Record<string, Partial<Personality>>;

/** Build a full Personality from a named preset, with optional per-dial overrides. */
export function personalityFromPreset(
  name: keyof typeof PERSONALITY_PRESETS,
  overrides: Partial<Personality> = {},
): Personality {
  return makePersonality({ ...PERSONALITY_PRESETS[name], ...overrides });
}

// Compliance modulation. On TOP of the directed relation (relations.ts owns
// affinity/trust/authority), a creature's own temperament shifts how much it obeys
// ANY commander: an assertive creature holds its ground (yields less), a patient/
// warm one goes along more easily. Kept a BOUNDED multiplier (≈0.45..1.15) so
// personality tilts obedience without overriding the relationship — the relation is
// still the primary signal.
const K_ASSERT = 0.45; // assertiveness is the dominant damper
const K_PATIENCE = 0.2;
const K_WARMTH = 0.1;
const FACTOR_LO = 0.45;
const FACTOR_HI = 1.15;

/**
 * The personality multiplier on compliance, ≈0.45..1.15. Exactly 1 at
 * NEUTRAL_PERSONALITY. Assertiveness pulls it down (a stubborn creature resists
 * commands); patience and warmth nudge it up (an easygoing creature goes along).
 */
export function personalityComplianceFactor(p: Personality): number {
  const f =
    1 -
    K_ASSERT * (p.assertiveness - 0.5) +
    K_PATIENCE * (p.patience - 0.5) +
    K_WARMTH * (p.warmth - 0.5);
  return Math.min(FACTOR_HI, Math.max(FACTOR_LO, f));
}
