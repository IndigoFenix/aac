// server/services/dual-agent/app-registry.ts
// Static registry of add-on apps available to the AAC system

import type { AACAppDefinition } from "./types";

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
    enabledByDefault: false,
  },
  {
    id: "space_trader",
    name: "Space Trader",
    description: "Opens a space-trading puzzle game designed for eyegaze controls. The student steers a ship to mine asteroids, complete trade chains, and capture the Star across escalating difficulty levels. ALWAYS use open_app to launch this when the user wants to play the space trader game, the space game, or the trader puzzle.",
    icon: "🚀",
    enabledByDefault: false,
  },
  {
    id: "musical_microbes",
    name: "Musical Microbes",
    description: "Opens a calm music-making sandbox where the student places tiny organisms (pulsers, responders, harmonizers, echoers, silencers) that interact to make generative music — a hidden scale keeps it always in tune, so there are no wrong notes. Works with eyegaze, touch, or mouse. ALWAYS use open_app to launch this when the user wants to make music with the microbes, play the musical garden, or asks for the microbes game.",
    icon: "🎶",
    enabledByDefault: false,
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
