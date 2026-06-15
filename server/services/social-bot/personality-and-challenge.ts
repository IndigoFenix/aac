/* ============================================================================
   PERSONALITY, DIFFICULTY & ADAPTIVE CHALLENGE
   ----------------------------------------------------------------------------
   Three systems, layered:

     GENOME      6 human-legible traits -> ALL low-level engine params.
                 Randomize the genome (centered, archetype-biased), derive the
                 rest. Random low-level params make malfunctions, not people.

     DIFFICULTY  one scalar = "how much the character meets you halfway."
                 Modulates a coherent cluster of params + a scaffolding level,
                 ON TOP OF personality, without erasing it.

     CHALLENGE   per-USER (not per-character) competency profile built from the
                 turn log; biases the character to manufacture situations that
                 demand the user's weakest skill. SLP-gated, goal-scoped, ZPD-
                 bounded, with a back-off rule. A hypothesis, never a verdict.
   ========================================================================== */

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// 1. THE GENOME  (this is the only thing you randomize)
// ---------------------------------------------------------------------------

export interface PersonalityGenome {
  warmth: number;        // 0 cold .. 1 warm
  expressiveness: number;// 0 reserved/opaque .. 1 expressive/legible
  stability: number;     // 0 volatile .. 1 even
  openness: number;      // 0 guarded/slow .. 1 quick to connect & disclose
  assertiveness: number; // 0 yielding .. 1 holds its ground / pushes back
  patience: number;      // 0 impatient .. 1 forgiving of pauses & repetition
}

/** Every personality-varying value in the whole system, derived from traits. */
export interface EngineParams {
  spring: Record<"valence" | "arousal" | "rapport", { omega: number; zeta: number }>;
  baseline: { valence: number; arousal: number; rapport: number };
  negRapportBias: number;   // how unforgiving (>1 amplifies negative rapport)
  balanceFlipAt: number;    // askShare past which questioning turns negative
  habituationRate: number;  // how fast repeated moves lose value
  sycophancyAt: number;     // agreementTracking past which it tests the user
  discloseTendency: number; // 0..1 readiness to volunteer about itself
  legibility: number;       // 0..1 how clearly mood shows (avatar/tone/TTS range)
}

/** Trait -> low-level params. Each param is a readable blend of traits. */
export function deriveParams(g: PersonalityGenome, difficulty = 0.4): { params: EngineParams; scaffolding: number } {
  // base derivation from personality alone
  const negBias = lerp(2.4, 1.3, g.warmth);                 // warm = forgiving
  const rapportBase = lerp(-0.15, 0.2, g.warmth);
  const valenceBase = lerp(-0.1, 0.25, g.warmth);
  const arousalBase = lerp(-0.25, 0.25, g.expressiveness);
  const zeta = lerp(0.5, 1.0, g.stability);                 // low stability overshoots
  const rapportOmega = lerp(0.45, 0.95, g.openness);        // open = builds fast

  // DIFFICULTY modulation: a coherent cluster, applied on top of personality.
  // Higher difficulty withdraws social slack and legibility; it does NOT flip warmth.
  const d = clamp(difficulty);
  const params: EngineParams = {
    spring: {
      valence: { omega: 2.2, zeta },
      arousal: { omega: 2.6, zeta },
      rapport: { omega: rapportOmega, zeta: lerp(zeta, 0.95, 0.5) },
    },
    baseline: {
      valence: valenceBase,
      arousal: arousalBase,
      rapport: rapportBase - 0.15 * d,                      // harder = colder start
    },
    negRapportBias: negBias + 0.8 * d,                      // harder = mistakes cost more
    balanceFlipAt: lerp(0.85, 0.6, g.assertiveness) - 0.1 * d, // assertive = less tolerant of interview
    habituationRate: lerp(0.15, 0.35, 1 - g.patience) + 0.15 * d, // harder = can't repeat moves
    sycophancyAt: lerp(0.9, 0.62, g.assertiveness),         // assertive = wants to be pushed back on
    discloseTendency: clamp(0.5 * g.openness + 0.5 * g.warmth),
    legibility: clamp(g.expressiveness - 0.45 * d),         // harder = read finer cues
  };

  // scaffolding: at low difficulty the character carries the conversation
  // (more bids, callbacks, repair offered); high difficulty withdraws it.
  const scaffolding = clamp(lerp(0.85, 0.1, d) * lerp(0.7, 1, g.warmth));
  return { params, scaffolding };
}

// ---------------------------------------------------------------------------
// 2. RANDOM GENERATION  (centered sampling + archetype priors)
// ---------------------------------------------------------------------------

/** Approx-normal in [0,1] by averaging uniforms -> most characters near center. */
function centered(mean: number, spread: number): number {
  const n = (Math.random() + Math.random() + Math.random()) / 3; // ~bell, mean .5
  return clamp(mean + (n - 0.5) * 2 * spread);
}

export type Archetype =
  | "random" | "sunny_extrovert" | "anxious_pleaser"
  | "gruff_softie" | "aloof_intellectual" | "even_keel";

// archetype = trait-space mean to sample around (tight spread keeps them recognizable)
const ARCHETYPES: Record<Exclude<Archetype, "random">, PersonalityGenome> = {
  sunny_extrovert:   { warmth: .85, expressiveness: .9, stability: .7, openness: .85, assertiveness: .55, patience: .7 },
  anxious_pleaser:   { warmth: .8,  expressiveness: .55, stability: .25, openness: .4, assertiveness: .2,  patience: .6 },
  gruff_softie:      { warmth: .65, expressiveness: .3, stability: .7, openness: .3,  assertiveness: .8,  patience: .45 },
  aloof_intellectual:{ warmth: .35, expressiveness: .35, stability: .8, openness: .35, assertiveness: .75, patience: .8 },
  even_keel:         { warmth: .6,  expressiveness: .5, stability: .85, openness: .55, assertiveness: .5,  patience: .8 },
};

export function sampleGenome(archetype: Archetype = "random"): PersonalityGenome {
  if (archetype === "random") {
    const r = () => centered(0.5, 0.32);
    return { warmth: r(), expressiveness: r(), stability: r(), openness: r(), assertiveness: r(), patience: r() };
  }
  const m = ARCHETYPES[archetype], s = 0.12; // tight = stays in character
  return {
    warmth: centered(m.warmth, s), expressiveness: centered(m.expressiveness, s),
    stability: centered(m.stability, s), openness: centered(m.openness, s),
    assertiveness: centered(m.assertiveness, s), patience: centered(m.patience, s),
  };
}

/** One-line human-readable summary for the SLP / character card. */
export function describeGenome(g: PersonalityGenome): string {
  const pick = (v: number, lo: string, hi: string) => (v < .4 ? lo : v > .6 ? hi : "");
  return [pick(g.warmth, "reserved", "warm"), pick(g.expressiveness, "understated", "expressive"),
    pick(g.stability, "moody", "steady"), pick(g.assertiveness, "easygoing", "opinionated"),
    pick(g.openness, "private", "open")].filter(Boolean).join(", ") || "balanced";
}

// ---------------------------------------------------------------------------
// 3. LEARNER PROFILE & TARGETED CHALLENGE  (per-user, SLP-gated)
// ---------------------------------------------------------------------------

export type Competency =
  // Core 8 (original):
  | "responsiveness" | "reciprocity" | "attunement" | "repair"
  | "assertiveness" | "complimentCalibration" | "initiation" | "interestEngagement"
  // Batch A — conversation mechanics:
  | "turnTaking" | "topicMaintenance" | "topicShifting" | "greetings" | "leaveTaking"
  // Batch B — social-emotional + register:
  | "perspectiveTaking" | "emotionExpression" | "empathy" | "politeness" | "askingForHelp" | "refusal";

/** The full competency set, in canonical order. Single source for the engine
 *  (emptyProfile), the SLP-config builder (goal/locked scoping), and the
 *  startup-schema enum (targetSkills). Grows in later phases — keep the
 *  `Competency` union + COMPETENCY_LABEL in shared/social-bot/state.ts in
 *  lock-step (Record<Competency,...> there forces a label for each entry). */
export const COMPETENCIES: Competency[] = [
  "responsiveness", "reciprocity", "attunement", "repair",
  "assertiveness", "complimentCalibration", "initiation", "interestEngagement",
  "turnTaking", "topicMaintenance", "topicShifting", "greetings", "leaveTaking",
  "perspectiveTaking", "emotionExpression", "empathy", "politeness", "askingForHelp", "refusal",
];

interface Skill { value: number; samples: number } // value 0..1, EMA

export interface LearnerProfile {
  skills: Record<Competency, Skill>;
  probeHistory: { dim: Competency; success: boolean }[]; // for back-off
}

export interface SlpConfig {
  goalDimensions: Competency[];   // which skills are even in scope for THIS child (IEP/TALA)
  lockedDimensions: Competency[]; // never probe these
  maxChallengeIntensity: number;  // 0..1 ceiling the clinician sets
  challengeRatio: number;         // fraction of turns that probe vs. scaffold (e.g. 0.25)
}

export function emptyProfile(): LearnerProfile {
  const skills = {} as Record<Competency, Skill>;
  COMPETENCIES.forEach((c) => (skills[c] = { value: 0.5, samples: 0 }));
  return { skills, probeHistory: [] };
}

const MIN_SAMPLES = 8; // don't flag a weakness on thin data

/** Slow EMA nudge from the per-turn signals + the director's `notes`.
 *  The batch-A conversation-mechanics fields are CONDITIONALLY sampled — the
 *  director passes `null`/`undefined` on turns where a skill doesn't apply
 *  (e.g. greetings only matter at the start) so the EMA isn't polluted, mirroring
 *  the existing `repaired` / `complimentSpecific` pattern. */
export function updateProfile(p: LearnerProfile, ev: {
  contingency: number; addressedBid: boolean; askShare: number; disclosed: boolean;
  affectTracksCharacter: boolean; repaired: boolean | null; tookOwnStance: boolean;
  sycophantic: boolean; complimentSpecific: number | null; initiatedBid: boolean;
  engagedCharacterInterest: boolean | null;
  // batch A — conversation mechanics
  turnTaking?: boolean;              // always sampled: did they take turns (not interrupt)
  topicMaintained?: number | null;   // sampled after turn 1: 1 - topicShift
  topicShiftedWell?: boolean | null; // sampled only when a real subject change happened
  greeted?: boolean | null;          // sampled only at a greeting moment (early turns)
  leaveTaking?: boolean | null;      // sampled only near a closing moment
  // batch B — social-emotional + register
  consideredPerspective?: boolean;   // always sampled: did they consider the peer's view
  expressedEmotion?: boolean;        // always sampled: did they name their own feeling
  polite?: number | null;            // always sampled: manner (0..1 courtesy/respect)
  showedEmpathy?: boolean | null;    // sampled only at an empathy opportunity
  askedForHelp?: boolean | null;     // sampled only when they seemed stuck
  refusedWell?: boolean | null;      // sampled only when they declined something
}) {
  const bump = (c: Competency, target: number) => {
    const s = p.skills[c];
    s.value = 0.85 * s.value + 0.15 * clamp(target);
    s.samples += 1;
  };
  bump("responsiveness", ev.addressedBid ? ev.contingency : ev.contingency * 0.4);
  bump("reciprocity", ev.askShare > 0.7 ? 0.2 : ev.disclosed ? 0.85 : 0.5);
  bump("attunement", ev.affectTracksCharacter ? 0.8 : 0.3);
  if (ev.repaired !== null) bump("repair", ev.repaired ? 0.9 : 0.2);
  bump("assertiveness", ev.sycophantic ? 0.15 : ev.tookOwnStance ? 0.85 : 0.5);
  if (ev.complimentSpecific !== null) bump("complimentCalibration", ev.complimentSpecific);
  bump("initiation", ev.initiatedBid ? 0.85 : 0.4);
  if (ev.engagedCharacterInterest !== null) bump("interestEngagement", ev.engagedCharacterInterest ? 0.85 : 0.35);
  // batch A
  if (ev.turnTaking !== undefined) bump("turnTaking", ev.turnTaking ? 0.75 : 0.2);
  if (ev.topicMaintained != null) bump("topicMaintenance", ev.topicMaintained);
  if (ev.topicShiftedWell != null) bump("topicShifting", ev.topicShiftedWell ? 0.85 : 0.3);
  if (ev.greeted != null) bump("greetings", ev.greeted ? 0.9 : 0.35);
  if (ev.leaveTaking != null) bump("leaveTaking", ev.leaveTaking ? 0.9 : 0.25);
  // batch B
  if (ev.consideredPerspective !== undefined) bump("perspectiveTaking", ev.consideredPerspective ? 0.85 : 0.4);
  if (ev.expressedEmotion !== undefined) bump("emotionExpression", ev.expressedEmotion ? 0.85 : 0.4);
  if (ev.polite != null) bump("politeness", ev.polite);
  if (ev.showedEmpathy != null) bump("empathy", ev.showedEmpathy ? 0.9 : 0.25);
  if (ev.askedForHelp != null) bump("askingForHelp", ev.askedForHelp ? 0.85 : 0.3);
  if (ev.refusedWell != null) bump("refusal", ev.refusedWell ? 0.85 : 0.3);
}

export type Probe =
  | "go_minimal"          // weak initiation: leave dead air to fill
  | "stop_volunteering"   // weak reciprocity: silence pushes disclosure
  | "shift_mood_silently" // weak attunement: change mood, see if they notice
  | "assert_wrong_view"   // weak assertiveness: provoke, see if they push back
  | "mild_rupture"        // weak repair: take recoverable offense (bounded!)
  | "drop_interest_cue"   // weak interestEngagement: see if they pick it up
  | "hold_floor"          // weak turnTaking: take a longer turn, see if they wait
  | "anchor_topic"        // weak topicMaintenance: stay put, see if they keep it going
  | "invite_topic_change" // weak topicShifting: signal a lull, see if they move us on
  | "wind_down_cue"       // weak leaveTaking: cue an ending, see if they close it out
  | "state_feeling"       // weak perspectiveTaking: voice an inner state, see if they notice
  | "invite_feeling"      // weak emotionExpression: share a feeling, invite a reciprocal
  | "share_minor_trouble" // weak empathy: share a small upset, see if they show care
  | "do_a_favor"          // weak politeness: offer something nice, see if they're courteous
  | "introduce_obstacle"  // weak askingForHelp: be a touch unclear, see if they ask
  | "unreasonable_request"// weak refusal: make a small declinable ask, see how they say no
  | "none";               // scaffold instead

const PROBE_FOR: Partial<Record<Competency, Probe>> = {
  initiation: "go_minimal", reciprocity: "stop_volunteering", attunement: "shift_mood_silently",
  assertiveness: "assert_wrong_view", repair: "mild_rupture", interestEngagement: "drop_interest_cue",
  turnTaking: "hold_floor", topicMaintenance: "anchor_topic", topicShifting: "invite_topic_change",
  leaveTaking: "wind_down_cue",
  perspectiveTaking: "state_feeling", emotionExpression: "invite_feeling", empathy: "share_minor_trouble",
  politeness: "do_a_favor", askingForHelp: "introduce_obstacle", refusal: "unreasonable_request",
  // greetings: detection only — no mid-session probe makes sense.
};

/** Probes that put the student on the spot with emotional friction. They only
 *  land well if the student can recover — so they're softened when the student's
 *  repair/attunement is weak (see shapeIntensity). */
const FRICTION_PROBES = new Set<Probe>([
  "mild_rupture", "assert_wrong_view", "unreasonable_request",
]);

/** Below this, the shaped probe is too faint to be worth the disruption —
 *  scaffold instead. Lets the interaction terms (low language level + low
 *  recovery on a friction probe) decide "don't probe this now". */
const MIN_USEFUL_INTENSITY = 0.08;

/** Language-level → intensity multiplier. A student at single words / short
 *  phrases can't engage a strong provocation, so every probe is gentler the
 *  simpler their language. tier index 1..5; undefined → full strength. */
function languageFactor(tier?: number): number {
  if (tier === undefined) return 1;
  return [0.5, 0.7, 0.85, 1, 1][Math.max(0, Math.min(4, Math.round(tier) - 1))];
}

/** Shape the raw ZPD intensity by the INTERACTION between skills and the
 *  language level — not just the target's own gap. */
function shapeIntensity(
  base: number,
  probe: Probe,
  p: LearnerProfile,
  ceiling: number,
  languageLevelTier?: number,
): number {
  let i = base * languageFactor(languageLevelTier);
  if (FRICTION_PROBES.has(probe)) {
    // Friction needs a recovery buffer. Average repair + attunement readiness;
    // low buffer halves the probe (a student who can't recover shouldn't be
    // ruptured hard). High buffer leaves it at full strength.
    const recovery = (p.skills.repair.value + p.skills.attunement.value) / 2;
    i *= lerp(0.5, 1, clamp(recovery));
  }
  return clamp(i, 0, ceiling);
}

/** Decide whether to challenge this turn, and at what. Honors all SLP gates,
 *  the scaffold:challenge ratio, ZPD bounding, the back-off rule, and the
 *  interaction shaping (adjacent-skill recovery buffer + language level). */
export function selectChallenge(
  p: LearnerProfile,
  slp: SlpConfig,
  turnIndex: number,
  opts: { languageLevelTier?: number } = {},
): { probe: Probe; dim: Competency | null; intensity: number } {

  // scaffold most of the time
  if (Math.random() > slp.challengeRatio) return { probe: "none", dim: null, intensity: 0 };

  // candidate weak dims: in-scope, unlocked, enough data, actually weak
  const candidates = slp.goalDimensions
    .filter((c) => !slp.lockedDimensions.includes(c))
    .filter((c) => p.skills[c].samples >= MIN_SAMPLES)
    .filter((c) => PROBE_FOR[c])
    .sort((a, b) => p.skills[a].value - p.skills[b].value);
  if (!candidates.length) return { probe: "none", dim: null, intensity: 0 };

  const dim = candidates[0];
  const probe = PROBE_FOR[dim]!;

  // BACK-OFF: if recent probes on this dim kept failing, scaffold instead.
  const recent = p.probeHistory.filter((h) => h.dim === dim).slice(-3);
  if (recent.length === 3 && recent.every((h) => !h.success)) return { probe: "none", dim, intensity: 0 };

  // ZPD: challenge just past current competence. Weaker skill => gentler probe,
  // and never exceed the clinician's intensity ceiling.
  const gap = 0.7 - p.skills[dim].value;            // how far below "comfortable"
  const baseIntensity = clamp(lerp(0.2, 0.6, gap), 0, slp.maxChallengeIntensity);

  // INTERACTION SHAPING: soften by the recovery buffer (for friction probes)
  // and the student's language level. If shaping collapses it, scaffold.
  const intensity = shapeIntensity(baseIntensity, probe, p, slp.maxChallengeIntensity, opts.languageLevelTier);
  if (intensity < MIN_USEFUL_INTENSITY) return { probe: "none", dim, intensity: 0 };

  return { probe, dim, intensity };
}

/** Record the outcome so back-off and the profile both learn from it. */
export function recordProbeOutcome(p: LearnerProfile, dim: Competency, success: boolean) {
  p.probeHistory.push({ dim, success });
  if (p.probeHistory.length > 30) p.probeHistory.shift();
}

// ---------------------------------------------------------------------------
// 4. SLP CONFIG BUILDER  (clinician defaults + AI-narrowed targeting)
// ---------------------------------------------------------------------------
//
// Precedence the caller implements: clinician default < AI override < locks.
// This builder takes the already-resolved `targetSkills` (the effective goal
// set) plus the clinician's hard constraints and enforces them:
//   - lockedSkills are ALWAYS removed from goalDimensions (a hard floor the AI
//     cannot override) and recorded as lockedDimensions.
//   - targetSkills scopes which competencies may be probed; empty → all (minus
//     locked).
//   - maxChallengeIntensity is clamped to [0,1]; it caps every probe.

export const DEFAULT_MAX_CHALLENGE_INTENSITY = 0.4;
export const DEFAULT_CHALLENGE_RATIO = 0.25;

export interface SlpConfigOptions {
  /** Effective goal set (AI override or clinician default). Empty → all. */
  targetSkills?: Competency[];
  /** Clinician-only hard floor — never probed, removed from goals. */
  lockedSkills?: Competency[];
  /** Clinician ceiling on probe intensity (0..1). */
  maxChallengeIntensity?: number;
  challengeRatio?: number;
}

export function buildSlpConfig(opts: SlpConfigOptions = {}): SlpConfig {
  const locked = (opts.lockedSkills ?? []).filter((c) => COMPETENCIES.includes(c));
  const lockedSet = new Set(locked);

  const requested = (opts.targetSkills && opts.targetSkills.length ? opts.targetSkills : COMPETENCIES)
    .filter((c) => COMPETENCIES.includes(c) && !lockedSet.has(c));
  // De-dupe while preserving canonical order.
  const scoped = COMPETENCIES.filter((c) => requested.includes(c));
  // If targeting + locks leave nothing, fall back to everything-but-locked so
  // the engine always has a candidate pool (it just scaffolds otherwise).
  const goalDimensions = scoped.length ? scoped : COMPETENCIES.filter((c) => !lockedSet.has(c));

  return {
    goalDimensions,
    lockedDimensions: locked,
    maxChallengeIntensity: clamp(opts.maxChallengeIntensity ?? DEFAULT_MAX_CHALLENGE_INTENSITY, 0, 1),
    challengeRatio: opts.challengeRatio ?? DEFAULT_CHALLENGE_RATIO,
  };
}

/** All competencies in scope, default ceiling — the unconfigured baseline. */
export const DEFAULT_SLP_CONFIG: SlpConfig = buildSlpConfig();