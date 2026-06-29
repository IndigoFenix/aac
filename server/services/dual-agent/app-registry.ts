// server/services/dual-agent/app-registry.ts
// Static registry of add-on apps available to the AAC system

import type { AACAppDefinition } from "./types";
import { COMPETENCIES } from "../social-bot/personality-and-challenge";
import { COMPETENCY_LABEL } from "@shared/social-bot/state";

/**
 * Per-app configuration stored in aacSettings.appConfig JSON.
 * Each key is an app ID, value is app-specific settings.
 */
export interface AppConfig {
  [appId: string]: {
    enabled?: boolean;
    [key: string]: any;
  } | undefined;
}

/**
 * Static registry of all add-on apps.
 * Each app can be enabled/disabled per session.
 */
export const APP_REGISTRY: AACAppDefinition[] = [
  {
    id: "youtube",
    name: "YouTube",
    description: "Opens an interactive YouTube video player on the user's screen. When permitted channels are configured (the channel list appears in the system prompt with their recent video titles), prefer calling open_app(youtube) WITHOUT `data` — this opens a channel browser where the student picks a video themselves. Only pass a `data` string when the student's request clearly matches one of the actual video titles shown; the search uses title matching, so a generic topic like 'animals' will miss and fall back to the browser anyway. When NO permitted channels are configured (unrestricted search via API key), always pass a descriptive query in `data`.",
    icon: "▶️",
    enabledByDefault: false,
  },
  {
    id: "phone_call",
    name: "Phone Call",
    description: "Opens a list of the student's callable contacts so they can place a live video call to someone who is online. Use open_app(phone_call) when the student wants to call a person but you are not sure who, or wants to browse who is available. To call a specific known person directly, prefer the call_person tool instead.",
    icon: "☎️",
    enabledByDefault: true,
  },
  {
    id: "spotify",
    name: "Spotify",
    description: "Opens an interactive Spotify music player on the user's screen. Use open_app to launch it when the user wants to listen to music. Pass a search query in the data parameter (e.g. 'happy kids songs').",
    icon: "🎧",
    enabledByDefault: false,
  },
  {
    id: "drawing",
    name: "Drawing",
    description: "Opens an interactive drawing canvas on the user's screen where they can draw with colors. ALWAYS use open_app to launch this when the user mentions drawing, coloring, or pictures. As the user draws, add context buttons related to what they seem to be drawing.",
    icon: "🎨",
    enabledByDefault: true,
    supportsDetectionCapture: true,
  },
  {
    id: "music",
    name: "Music Maker",
    description: "Opens an interactive piano on the user's screen where they can play musical notes. ALWAYS use open_app to launch this when the user wants to make music or play piano.",
    icon: "🎵",
    enabledByDefault: true,
  },
  {
    id: "sandbox_game",
    name: "Sandbox Farm",
    description: "Opens an idle farming sandbox game on the user's screen. The user places soil, water, seeds, and flowers on a grid and watches them grow over time. ALWAYS use open_app to launch this when the user wants to play the farm game, garden game, or sandbox game.",
    icon: "🌱",
    enabledByDefault: false,
  },
  {
    id: "bubbles_game",
    name: "Bubbles",
    description: "Opens a bubble-popping reflex game designed to train hand-eye coordination. Bubbles float around and the student pops them by tapping. Difficulty adjusts automatically. ALWAYS use open_app to launch this when the user wants to play the bubbles game, pop bubbles, or practice coordination.",
    icon: "🫧",
    enabledByDefault: false,
  },
  {
    id: "social_trainer",
    name: "Social Trainer",
    description: "Opens a social training session with a procedurally-generated peer character the user practices conversation with. The peer has its own face and voice and reacts to how the user treats it. While the session is running, you (the AAC AI) are placed in silent/utterance-button mode — the user communicates with the peer by pressing your buttons, and the peer's text replaces yours in the header. Use open_app(\"social_trainer\") when the user wants to practice talking to people, work on social skills, or asks for the social game. When the session ends you will be notified with a debrief — discuss it warmly with the user.",
    icon: "🧑‍🤝‍🧑",
    // Enabled by default — surfaced as the "Practice friend" button on the AAC
    // home board (not the Apps page). Its enable toggle lives in the AAC
    // Settings social-trainer section.
    enabledByDefault: true,
    // NOTE: social_trainer is NOT client-rendered — its peer lives server-side
    // (startSocialPeerSession). These params are resolved there, NOT via the
    // client request_app_open round-trip, so its snapshot needsStartupResolution
    // flag stays false (see sendAppsSnapshot).
    startup: {
      appId: "social_trainer",
      guidance:
        "The Social Trainer pairs the student with a procedurally-generated peer to practice conversation. " +
        "Tune the peer to THIS student and the current moment: pick `genderHint`; optionally an `archetypeHint` " +
        "for the peer's personality; up to three `interestHints` — ideally topics the student loves, so the peer " +
        "shares common ground; a `difficulty`; and a `scenario` framing the kind of interaction to practice. " +
        "Bias gentle: prefer easier difficulty and a warmer, friendlier archetype unless the conversation clearly " +
        "shows the student is ready for more challenge.\n\n" +
        "Optionally set `targetSkills` to FOCUS this session on one or two social skills (the peer will steer " +
        "situations that exercise them). Only set it when the conversation points at a clear, specific goal " +
        "(e.g. the student keeps cutting people off → turn-taking); otherwise leave it empty and the clinician's " +
        "configured goals — or all skills — apply. You may narrow the focus, but a skill the clinician has locked " +
        "off-limits is enforced server-side regardless of what you choose. The skills are: " +
        COMPETENCIES.map((c) => `${c} (${COMPETENCY_LABEL[c]})`).join("; ") + ".",
      paramsSchema: {
        type: "object",
        properties: {
          genderHint: { type: "string", enum: ["male", "female", "any"], description: "Peer's gender." },
          archetypeHint: {
            type: "string",
            enum: ["sunny_extrovert", "anxious_pleaser", "gruff_softie", "aloof_intellectual", "even_keel", "any"],
            description: "Peer personality archetype, or 'any' to randomize.",
          },
          interestHints: {
            type: "array",
            items: { type: "string" },
            description: "Up to 3 topics the peer should love — ideally the student's own interests.",
          },
          difficulty: {
            type: "string",
            enum: ["gentle", "medium", "challenging"],
            description: "How demanding the peer is. Default gentle.",
          },
          scenario: {
            type: "string",
            enum: ["greeting", "making_friends", "sharing_interests", "handling_disagreement", "joining_a_group"],
            description: "The social situation to practice.",
          },
          targetSkills: {
            type: "array",
            items: { type: "string", enum: [...COMPETENCIES] },
            description: "Optional: 1-2 social skills to FOCUS this session on (see guidance). Omit to use the clinician's configured goals, or all skills.",
          },
        },
        required: ["genderHint", "difficulty", "scenario"],
      },
      defaults: { genderHint: "any", archetypeHint: "any", interestHints: [], difficulty: "gentle", scenario: "greeting", targetSkills: [] },
    },
  },
  {
    id: "space_trader",
    name: "Space Trader",
    description: "Opens a space-trading puzzle game designed for eyegaze controls. The student steers a ship to mine asteroids, complete trade chains, and capture the Star across escalating difficulty levels. ALWAYS use open_app to launch this when the user wants to play the space trader game, the space game, or the trader puzzle.",
    icon: "🚀",
    enabledByDefault: false,
    startup: {
      appId: "space_trader",
      guidance:
        "Space Trader is an eyegaze steering puzzle: the student flies a ship to mine asteroids and complete trade " +
        "chains across escalating levels. Choose `startLevel` (0–6): 0 for a first-timer or anyone who needs an easy " +
        "win; pick a higher level ONLY if the conversation shows the student has played before, asked for a harder " +
        "challenge, or is clearly capable. When unsure, choose 0.",
      paramsSchema: {
        type: "object",
        properties: {
          startLevel: {
            type: "integer",
            minimum: 0,
            maximum: 6,
            description: "Starting difficulty level, 0 (easiest) to 6.",
          },
        },
        required: ["startLevel"],
      },
      defaults: { startLevel: 0 },
    },
  },
  {
    id: "musical_microbes",
    name: "Musical Microbes",
    description: "Opens a calm music-making sandbox where the student places tiny organisms (pulsers, responders, harmonizers, echoers, silencers) that interact to make generative music — a hidden scale keeps it always in tune, so there are no wrong notes. Works with eyegaze, touch, or mouse. ALWAYS use open_app to launch this when the user wants to make music with the microbes, play the musical garden, or asks for the microbes game.",
    icon: "🎶",
    enabledByDefault: false,
  },
  {
    id: "social_world",
    name: "Play with friends",
    description: "Opens a shared multiplayer 'social world' where the student meets up with their contacts as avatars on a simple field and plays with physics toys (e.g. kicking a ball around). It runs inside a live video chat: opening it starts a chat with a friend and turns it into the game, or — if the student is already in a chat — attaches the game to that call so everyone in it can play. Use open_app(social_world) when the student wants to play WITH other people, meet friends, or hang out together — distinct from the single-player games and from a plain 1:1 video call (phone_call).",
    icon: "🎮",
    // A communication/social feature like phone_call (which is also default-on
    // with no toggle): it must be openable so the student can START a game and
    // invite friends (the game is a property of the chat, not a pre-existing
    // room they wait to be invited into).
    enabledByDefault: true,
  },
  {
    id: "symbol_learning",
    name: "Learn Symbols",
    description: "Opens a 3D learning game that teaches AAC symbols by DEMONSTRATING what they mean — abstract concepts (big/small, and more to come) are shown happening in the world, then the student connects the symbol to what they saw and practices in the sentence builder. ALWAYS use open_app(\"symbol_learning\") when the student wants to learn symbols/words, practice the sentence builder, or asks for the learning game. Built for eyegaze; warmly narrate and celebrate as they watch and answer.",
    icon: "🔤",
    // On by default for every student — it's the platform's core learning tool,
    // not an opt-in extra. Clinicians can disable it per-student via appConfig.
    enabledByDefault: true,
  },
  // Note: the "browser" app is not listed here. It's launched via the dedicated
  // open_website tool (gated by aacSettings.permittedWebsites), not via open_app.
];

/**
 * Get an app definition by ID
 */
export function getAppDefinition(id: string): AACAppDefinition | undefined {
  return APP_REGISTRY.find(app => app.id === id);
}

/**
 * Get the default set of enabled app IDs based on enabledByDefault flags
 */
export function getDefaultEnabledApps(): string[] {
  return APP_REGISTRY.filter(app => app.enabledByDefault).map(app => app.id);
}

/**
 * Compute enabled app IDs by merging registry defaults with per-student appConfig.
 * - Apps with enabledByDefault=true are enabled unless explicitly disabled in appConfig.
 * - Apps with enabledByDefault=false are enabled only if explicitly enabled in appConfig.
 */
export function getEnabledAppsFromConfig(appConfig: AppConfig | null | undefined): string[] {
  return APP_REGISTRY
    .filter(app => {
      const cfg = appConfig?.[app.id];
      if (cfg?.enabled !== undefined) return cfg.enabled;
      return app.enabledByDefault;
    })
    .map(app => app.id);
}
