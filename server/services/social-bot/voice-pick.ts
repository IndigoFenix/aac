// server/services/social-bot/voice-pick.ts
//
// Gender-matched Gemini voice selection for social-peer characters.
// Shared by the standalone SocialBotRelay and the AAC-integrated
// social-peer Speaker (AgentCoordinator). The exclusion list keeps the
// peer's voice distinct from the AAC AI voice and the student's own
// AAC voice.

import { GEMINI_VOICES } from "../voice/gemini-tts-service";

// Gender-classified groups derived from the Gemini voice descriptions.
// "Zephyr" is neutral — included in both pools so it's always available
// as a fallback.
const MALE_VOICES = ["Puck", "Charon", "Fenrir", "Orus", "Zephyr"];
const FEMALE_VOICES = ["Kore", "Aoede", "Leda", "Zephyr"];

/**
 * Pitch (F0) shift in semitones for a social-peer's TTS so an adult Gemini
 * voice reads as roughly the student's age. Kept MODEST on purpose — pitch
 * alone reads as "same adult, higher", and a large pitch shift sounds
 * chipmunky. The dominant "younger" cue is the formant shift below; pitch only
 * nudges F0 into a child-ish range to complement it.
 *
 * Younger → higher; an adult-aged user gets no shift. Unknown age defaults to a
 * modest child shift since the platform's users are children.
 */
export function peerVoicePitchSemitones(ageYears?: number | null): number {
  if (ageYears == null || !Number.isFinite(ageYears)) return 3;
  if (ageYears <= 6) return 4;
  if (ageYears <= 9) return 4;
  if (ageYears <= 12) return 3;
  if (ageYears <= 15) return 2;
  if (ageYears <= 17) return 1;
  return 0;
}

/**
 * Formant (vocal-tract) shift in semitones — the PRIMARY age cue. A child has a
 * physically shorter vocal tract, so its formants sit higher; shifting the
 * spectral envelope up simulates that without the chipmunk effect of pitch.
 * Deliberately larger than the pitch shift so the formant-to-pitch ratio lands
 * in child/teen territory rather than just "sped-up adult".
 *
 * Younger → larger upward shift; adult → none. Unknown → moderate child shift.
 */
export function peerVoiceFormantSemitones(ageYears?: number | null): number {
  if (ageYears == null || !Number.isFinite(ageYears)) return 5;
  if (ageYears <= 6) return 7;
  if (ageYears <= 9) return 6;
  if (ageYears <= 12) return 5;
  if (ageYears <= 15) return 3;
  if (ageYears <= 17) return 2;
  return 0;
}

/**
 * Grammatical gender of a named Gemini prebuilt voice, for prompts that must
 * gender the AI's own first-person forms (Hebrew, Arabic, …). "Zephyr" sits in
 * both pools as a neutral fallback, but it is the platform's default "woman"
 * AI voice (VOICE_MAP.woman in gemini-tts-service), so it classifies female —
 * hence the female pool is checked first. Unknown names → null.
 */
export function geminiVoiceGender(voiceName?: string | null): "male" | "female" | null {
  if (!voiceName) return null;
  if (FEMALE_VOICES.includes(voiceName)) return "female";
  if (MALE_VOICES.includes(voiceName)) return "male";
  return null;
}

export function pickVoice(
  gender: "male" | "female" | null,
  exclude: ReadonlyArray<string | undefined | null>,
): string {
  const excluded = new Set(exclude.filter((v): v is string => !!v));
  const allIds = GEMINI_VOICES.map((v) => v.id);
  const genderPool = gender === "male" ? MALE_VOICES : gender === "female" ? FEMALE_VOICES : allIds;
  const candidates = genderPool.filter((id) => !excluded.has(id));
  // Fall back, in order: gender pool unfiltered, full pool unfiltered.
  const pool = candidates.length > 0 ? candidates
    : genderPool.length > 0 ? genderPool
    : allIds;
  return pool[Math.floor(Math.random() * pool.length)];
}
