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
    description: "Watch child-safe YouTube videos. Suggest this if the user wants to watch a video.",
    icon: "▶️",
    enabledByDefault: false,
  },
  {
    id: "spotify",
    name: "Spotify",
    description: "Listen to music on Spotify. Suggest this if the user wants to listen to a song or music.",
    icon: "🎧",
    enabledByDefault: false,
  },
  {
    id: "drawing",
    name: "Drawing",
    description: "Draw on a canvas with colors. Suggest this if the user mentions drawing or pictures.",
    icon: "🎨",
    enabledByDefault: true,
    supportsDetectionCapture: true,
  },
  {
    id: "music",
    name: "Music Maker",
    description: "Play musical notes on a piano. Suggest this if the user mentions music or wants to make music.",
    icon: "🎵",
    enabledByDefault: true,
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
