// shared/app-defaults.ts
//
// Default enablement for every built-in AAC add-on app, keyed by app id.
//
// SINGLE SOURCE OF TRUTH, and it lives in shared/ for one reason: the value has
// two consumers on opposite sides of the wire and they MUST agree.
//
//   server  — APP_REGISTRY.enabledByDefault (services/dual-agent/app-registry.ts),
//             which getEnabledAppsFromConfig() uses to decide what the student
//             can actually launch.
//   client  — the AAC Settings toggles (client/src/features/AACSettingsPanel.tsx),
//             whose fallback is what the CLINICIAN sees when a student has no
//             explicit appConfig entry.
//
// 🚨 They were hardcoded separately and drifted. `sandbox_game`, `bubbles_game`
// and `musical_microbes` were `enabledByDefault: true` on the server while the
// panel drew their switches with `?? false`. Every new student therefore got
// three game tiles on their board that their AAC Settings page reported as OFF
// — so nobody could tell "never configured" from "deliberately disabled", and
// the tiles could not be explained, only turned on and off again. Found
// 2026-09-08 when a new student opened Musical Microbes in the browser.
//
// A default only reaches the student through `appConfig[id].enabled === undefined`;
// an explicit choice always wins in both directions, in both consumers.

/**
 * `true` = on for any student with no explicit `appConfig[id].enabled`.
 *
 * The reasoning for each choice stays next to its APP_REGISTRY entry, where the
 * app's description and policy live. Only the value is centralised here.
 */
export const APP_ENABLED_BY_DEFAULT = {
  phone_call: false,
  youtube: false,
  spotify: false,
  photos: false,
  picture_search: false,
  restaurant: false,
  drawing: true,
  music: true,
  bubbles_game: true,
  musical_microbes: true,
  space_trader: false,
  sandbox_game: true,
  social_trainer: true,
  social_world: false,
  symbol_learning: false,
  dollhouse: true,
  "nature-hike": false,
} as const;

/** Ids of the built-in apps, i.e. everything except clinician-authored custom apps. */
export type BuiltInAppId = keyof typeof APP_ENABLED_BY_DEFAULT;

/**
 * Default enablement for an app id. Unknown ids (custom apps, or a registry
 * entry added without a default) are OFF — a student should never inherit an
 * app nobody decided to give them.
 */
export function appEnabledByDefault(id: string): boolean {
  return APP_ENABLED_BY_DEFAULT[id as BuiltInAppId] ?? false;
}
