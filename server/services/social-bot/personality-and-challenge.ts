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
  | "responsiveness" | "reciprocity" | "attunement" | "repair"
  | "assertiveness" | "complimentCalibration" | "initiation" | "interestEngagement";

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
  (["responsiveness","reciprocity","attunement","repair","assertiveness",
    "complimentCalibration","initiation","interestEngagement"] as Competency[])
    .forEach((c) => (skills[c] = { value: 0.5, samples: 0 }));
  return { skills, probeHistory: [] };
}

const MIN_SAMPLES = 8; // don't flag a weakness on thin data

/** Slow EMA nudge from the per-turn signals + the director's `notes`. */
export function updateProfile(p: LearnerProfile, ev: {
  contingency: number; addressedBid: boolean; askShare: number; disclosed: boolean;
  affectTracksCharacter: boolean; repaired: boolean | null; tookOwnStance: boolean;
  sycophantic: boolean; complimentSpecific: number | null; initiatedBid: boolean;
  engagedCharacterInterest: boolean | null;
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
}

export type Probe =
  | "go_minimal"          // weak initiation: leave dead air to fill
  | "stop_volunteering"   // weak reciprocity: silence pushes disclosure
  | "shift_mood_silently" // weak attunement: change mood, see if they notice
  | "assert_wrong_view"   // weak assertiveness: provoke, see if they push back
  | "mild_rupture"        // weak repair: take recoverable offense (bounded!)
  | "drop_interest_cue"   // weak interestEngagement: see if they pick it up
  | "none";               // scaffold instead

const PROBE_FOR: Partial<Record<Competency, Probe>> = {
  initiation: "go_minimal", reciprocity: "stop_volunteering", attunement: "shift_mood_silently",
  assertiveness: "assert_wrong_view", repair: "mild_rupture", interestEngagement: "drop_interest_cue",
};

/** Decide whether to challenge this turn, and at what. Honors all SLP gates,
 *  the scaffold:challenge ratio, ZPD bounding, and the back-off rule. */
export function selectChallenge(p: LearnerProfile, slp: SlpConfig, turnIndex: number):
  { probe: Probe; dim: Competency | null; intensity: number } {

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

  // BACK-OFF: if recent probes on this dim kept failing, scaffold instead.
  const recent = p.probeHistory.filter((h) => h.dim === dim).slice(-3);
  if (recent.length === 3 && recent.every((h) => !h.success)) return { probe: "none", dim, intensity: 0 };

  // ZPD: challenge just past current competence. Weaker skill => gentler probe,
  // and never exceed the clinician's intensity ceiling.
  const gap = 0.7 - p.skills[dim].value;            // how far below "comfortable"
  const intensity = clamp(lerp(0.2, 0.6, gap), 0, slp.maxChallengeIntensity);
  return { probe: PROBE_FOR[dim]!, dim, intensity };
}

/** Record the outcome so back-off and the profile both learn from it. */
export function recordProbeOutcome(p: LearnerProfile, dim: Competency, success: boolean) {
  p.probeHistory.push({ dim, success });
  if (p.probeHistory.length > 30) p.probeHistory.shift();
}