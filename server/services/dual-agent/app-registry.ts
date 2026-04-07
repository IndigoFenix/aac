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
    description: "Opens an interactive YouTube video player on the user's screen. Use open_app to launch it when the user wants to watch a video. Pass a search query in the data parameter.",
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
    description: "Opens an interactive drawing canvas on the user's screen where they can draw with colors. ALWAYS use open_app to launch this when the user mentions drawing, coloring, or pictures — do NOT just create board buttons about drawing.",
    icon: "🎨",
    enabledByDefault: true,
    supportsDetectionCapture: true,
  },
  {
    id: "music",
    name: "Music Maker",
    description: "Opens an interactive piano on the user's screen where they can play musical notes. ALWAYS use open_app to launch this when the user wants to make music or play piano — do NOT just create board buttons about music.",
    icon: "🎵",
    enabledByDefault: true,
  },
  {
    id: "sandbox_game",
    name: "Sandbox Farm",
    description: "Opens an idle farming sandbox game on the user's screen. The user places soil, water, seeds, and flowers on a grid and watches them grow over time. ALWAYS use open_app to launch this when the user wants to play the farm game, garden game, or sandbox game — do NOT just create board buttons about it.",
    icon: "🌱",
    enabledByDefault: false,
  },
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
