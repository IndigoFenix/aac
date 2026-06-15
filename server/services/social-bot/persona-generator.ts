// server/services/social-bot/persona-generator.ts
//
// Procedural per-session persona.
//
// What's procedural:
//   - Genome (6 personality traits) via sampleGenome() — archetype-biased
//     centered sampling so most characters land near the archetype center.
//   - Identity (interests + stances) via random selection from the pools
//     below. 2–3 loves, 1–2 cold-ons, 1–2 stances with conviction.
//   - Name from a mixed-origin pool.
//   - Appearance via randomAppearance() — hue + head proportions.
//   - HumorStyle derived from genome traits.
//
// What stays authored:
//   - Pool contents (here). Light, conversational, non-political — these
//     are kids practicing chitchat with a peer, not debate club.

import type {
  Archetype,
  PersonalityGenome,
} from "./personality-and-challenge";
import { deriveParams, sampleGenome } from "./personality-and-challenge";
import type { CharacterIdentity } from "./identity-layer";
import type { FaceAppearance } from "@shared/social-bot/ProceduralFace";
import { randomAppearance } from "@shared/social-bot/ProceduralFace";
import { humorStyle, type HumorStyle } from "./humor-and-history";

export type Gender = "male" | "female";

export interface GeneratedPersona {
  name: string;
  /** Drives the gendered name pool, gender-matched voice selection, and
   *  a "young man/woman" hint in the prompt so the LLM can conjugate
   *  correctly in gendered languages (Spanish, Hebrew, Arabic, etc.). */
  gender: Gender;
  archetype: Archetype;
  genome: PersonalityGenome;
  identity: CharacterIdentity;
  appearance: FaceAppearance;
  humorStyle: HumorStyle;
}

// ── Pools ──────────────────────────────────────────────────────────────

const MALE_NAMES: string[] = [
  "Theo", "Felix", "Leo", "Eli", "Owen", "Diego", "Ravi", "Liam",
  "Kai", "Sam", "Alex", "Noah", "Mateo", "Hiro", "Omar", "Arjun",
];

const FEMALE_NAMES: string[] = [
  "Mira", "Luna", "Iris", "Maya", "Zara", "Noor", "Mei", "Nadia",
  "Yuki", "Anika", "Aisha", "Stella", "Priya", "Lila", "Sofia", "Amara",
];

const LOVE_INTERESTS: string[] = [
  // Things a peer character might light up about. Kid-friendly.
  "astronomy", "ocean creatures", "trains", "video games", "cooking",
  "drawing", "music", "old movies", "cats", "dogs", "horses",
  "skateboarding", "soccer", "basketball", "swimming", "running",
  "robots", "dinosaurs", "outer space", "mythology", "history",
  "magic tricks", "comic books", "stand-up comedy", "classical music",
  "puzzles", "board games", "gardening", "birdwatching", "rainstorms",
  "snow", "the beach", "deserts", "the night sky", "weird facts",
  "trivia", "anime", "card games", "knitting", "lego",
];

const COLD_INTERESTS: string[] = [
  // Things a peer might be neutral-to-cold on. Used for the dislikes line.
  "small talk", "loud places", "crowds", "scary movies", "broccoli",
  "thunderstorms", "early mornings", "long car rides", "math homework",
  "doing dishes", "raisins", "polka music",
];

// Stances are LIGHT conversational opinions, never political/sensitive.
// Each stance: short proposition phrasing, plus a "wrong-side" example
// (string) used by the prompt to render "you push back on the idea that …".
interface StanceTemplate { prop: string; }

const STANCE_POOL: StanceTemplate[] = [
  { prop: "cats are better than dogs" },
  { prop: "pineapple belongs on pizza" },
  { prop: "winter is better than summer" },
  { prop: "books are better than movies" },
  { prop: "morning people have it easier" },
  { prop: "tea is better than coffee" },
  { prop: "ice cream is best in cold weather" },
  { prop: "board games are better than video games" },
  { prop: "comedies are better than action movies" },
  { prop: "the best snacks are salty, not sweet" },
  { prop: "the window seat is the best seat" },
  { prop: "owls are cooler than eagles" },
  { prop: "stickers make everything better" },
  { prop: "weekends should be three days long" },
];

// ── Sampling helpers ──────────────────────────────────────────────────

function pickN<T>(arr: ReadonlyArray<T>, n: number, rng: () => number): T[] {
  const pool = arr.slice();
  const out: T[] = [];
  const take = Math.min(n, pool.length);
  for (let i = 0; i < take; i++) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

function range(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

// ── Identity composition ──────────────────────────────────────────────

/** What the persona's accessory (if any) translates to as a conversation
 *  topic. Used to seed an interest the bot will naturally bring up when
 *  the director picks `volunteer_interest`. */
const ACCESSORY_INTEREST: Record<NonNullable<FaceAppearance["accessory"]>["kind"], string> = {
  hat: "my hat",
  glasses: "my glasses",
  bowtie: "dressing up",
  flower: "the flower in my hair",
};

function generateIdentity(
  rng: () => number,
  accessory: FaceAppearance["accessory"] | undefined,
  interestHints?: string[],
): CharacterIdentity {
  const loveCount = 2 + Math.floor(rng() * 2); // 2 or 3
  const coldCount = 1 + Math.floor(rng() * 2); // 1 or 2

  // Seeded interests (e.g. topics the student loves, so the peer shares common
  // ground) take priority and fill the remaining love slots from the pool.
  const seeded = (interestHints ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 3);
  const fillCount = Math.max(0, loveCount - seeded.length);
  const loves = [
    ...seeded,
    ...pickN(LOVE_INTERESTS.filter((l) => !seeded.includes(l)), fillCount, rng),
  ];
  const colds = pickN(COLD_INTERESTS, coldCount, rng);

  const interests: Record<string, number> = {};
  for (const k of loves) interests[k] = range(rng, 0.7, 0.95);
  for (const k of colds) interests[k] = range(rng, -0.65, -0.35);

  // Accessory becomes an interest with strong affinity so the bot will
  // bring it up when the director picks volunteer_interest. Higher
  // affinity than the regular pool so it edges to the top of the list.
  if (accessory) {
    const topic = ACCESSORY_INTEREST[accessory.kind];
    interests[topic] = 0.85;
  }

  const stanceCount = 1 + Math.floor(rng() * 2); // 1 or 2
  const stancePicks = pickN(STANCE_POOL, stanceCount, rng);
  const stances: CharacterIdentity["stances"] = {};
  for (const s of stancePicks) {
    // position is which side the character takes; +1 = agree with the
    // proposition as worded, -1 = push back on it. Half the time we
    // pick the "opposite" side so the rendered identity isn't always
    // bland affirmation.
    const position = rng() < 0.5 ? 1 : -1;
    const conviction = range(rng, 0.6, 0.9);
    stances[s.prop] = { position, conviction };
  }

  return { interests, stances };
}

// ── Genome → derived humor playfulness ────────────────────────────────

/** A 7th "trait" used only for humor-style selection.
 *  Higher when the bot is warm, expressive, and not too rigid. */
function playfulnessOf(g: PersonalityGenome): number {
  return Math.max(0, Math.min(1, 0.5 * g.expressiveness + 0.3 * g.warmth + 0.2 * (1 - g.stability)));
}

// ── Public API ────────────────────────────────────────────────────────

export interface GeneratePersonaOptions {
  archetype?: Archetype;
  /** Force a specific gender. Omit to roll 50/50. */
  gender?: Gender;
  /** Topics the peer should love (e.g. the student's interests, so they share
   *  common ground). Up to 3 are seeded as strong affinities. */
  interestHints?: string[];
  /** Inject a deterministic RNG for tests. Defaults to Math.random. */
  rng?: () => number;
}

export function generatePersona(opts: GeneratePersonaOptions = {}): GeneratedPersona {
  const rng = opts.rng ?? Math.random;
  const archetype = opts.archetype ?? "random";
  const genome = sampleGenome(archetype);
  // Appearance first so the accessory (if any) can seed an interest.
  const appearance = randomAppearance(rng);
  const identity = generateIdentity(rng, appearance.accessory, opts.interestHints);
  const gender: Gender = opts.gender ?? (rng() < 0.5 ? "male" : "female");
  const namePool = gender === "male" ? MALE_NAMES : FEMALE_NAMES;
  const name = namePool[Math.floor(rng() * namePool.length)];
  const playfulness = playfulnessOf(genome);
  return {
    name,
    gender,
    archetype,
    genome,
    identity,
    appearance,
    humorStyle: humorStyle(playfulness, genome.warmth, genome.assertiveness),
  };
}

// ── SLP config ────────────────────────────────────────────────────────
// The builder + default live in personality-and-challenge.ts (pure, no
// face/appearance imports, so they're unit-testable in isolation). Re-exported
// here for the existing call sites that import them from persona-generator.
export {
  buildSlpConfig,
  DEFAULT_SLP_CONFIG,
  DEFAULT_MAX_CHALLENGE_INTENSITY,
  DEFAULT_CHALLENGE_RATIO,
  type SlpConfigOptions,
} from "./personality-and-challenge";

export const DEFAULT_DIFFICULTY = 0.4;

export function buildDefaultEngineParams(difficulty: number = DEFAULT_DIFFICULTY) {
  // Convenience for callers that want params for the "average" persona —
  // mostly the test path. Production code derives params from the
  // generated genome inside DirectedSession.
  return deriveParams(sampleGenome("even_keel"), difficulty);
}

// ── Human-readable summary for the log ────────────────────────────────

export function describePersona(p: GeneratedPersona): string {
  const loves = Object.entries(p.identity.interests).filter(([, v]) => v > 0.5).map(([k]) => k);
  const colds = Object.entries(p.identity.interests).filter(([, v]) => v < -0.3).map(([k]) => k);
  const stances = Object.entries(p.identity.stances).map(([k, v]) => {
    const side = v.position > 0 ? "agrees" : "pushes back";
    return `${k} (${side}, conviction ${v.conviction.toFixed(2)})`;
  });
  return [
    `name=${p.name}`,
    `gender=${p.gender}`,
    `archetype=${p.archetype}`,
    `genome={w:${p.genome.warmth.toFixed(2)} e:${p.genome.expressiveness.toFixed(2)} s:${p.genome.stability.toFixed(2)} o:${p.genome.openness.toFixed(2)} a:${p.genome.assertiveness.toFixed(2)} p:${p.genome.patience.toFixed(2)}}`,
    `humor=${p.humorStyle}`,
    `loves=[${loves.join(", ")}]`,
    `colds=[${colds.join(", ")}]`,
    `stances=[${stances.join(" | ")}]`,
  ].join(" ");
}
