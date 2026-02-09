// server/services/dual-agent/app-registry.ts
// Static registry of add-on apps available to the AAC system

import type { AACAppDefinition } from "./types";

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
