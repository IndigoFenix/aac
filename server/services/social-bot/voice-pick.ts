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
