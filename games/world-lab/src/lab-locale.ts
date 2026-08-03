// games/world-lab/src/lab-locale.ts
//
// The lab's LANGUAGE picker (the 🌍 bar's "Language" select).
//
// A world's locale drives every player-facing string the engine produces: the
// glyph→speech translation, what NPCs say, the board's own chrome, and whether
// symbols lay out right-to-left. In the real AAC it arrives on the embed's
// `init` message and is the STUDENT's language (client-aac GameEmbed → the
// dollhouse's loadSpec). The lab has no parent to ask, so this picker stands in
// for it — the one place a dev can see a Hebrew town without editing JSON.
//
// It is a BUILD-time choice: the locale is stamped onto the game's meta as the
// town is generated (town-play → town-quests → `meta.locale`) and the quest
// host reads it from there, so a switch means a rebuild, never a retranslation
// of a world already standing.

export interface LabLocale {
  code: string;
  label: string;
}

/**
 * Only the SHIPPED glyph rulesets are offered. Every other app locale (fr, de,
 * ru, ko, zh, yue, ar) falls back to English inside the engine
 * (interaction/lang/index.ts), so listing them here would promise a translation
 * the lab can't show. Hebrew is the one that also exercises RTL.
 */
export const LAB_LOCALES: ReadonlyArray<LabLocale> = [
  { code: "en", label: "English" },
  { code: "he", label: "עברית · Hebrew (RTL)" },
  { code: "es", label: "Español · Spanish" },
  { code: "pt", label: "Português · Portuguese" },
];

export const LOCALE_STORAGE_KEY = "world-lab-locale";

/** A stored / user-supplied code narrowed to one the lab actually offers. */
export function normalizeLabLocale(code: string | null | undefined): string {
  return LAB_LOCALES.find((l) => l.code === code)?.code ?? "en";
}

/**
 * Stamp the chosen locale onto a lowered `aivota-world` document, in place,
 * just before it is validated — the picker OVERRIDES whatever the World form's
 * own Locale field holds, so the bar is the single language switch.
 *
 * Only the TOWN scope declares a `locale` world field (town-play-game.ts), so
 * any other scope is left untouched rather than being failed by an unknown key
 * — unless its document already carries one, which means its scope took it.
 */
export function applyLabLocale(doc: unknown, locale: string): void {
  const game = (doc as { game?: { scope?: unknown; world?: unknown } } | null | undefined)?.game;
  if (!game || typeof game !== "object") return;
  const world = game.world;
  if (!world || typeof world !== "object") return;
  if (game.scope !== "town" && !("locale" in world)) return;
  (world as Record<string, unknown>).locale = locale;
}
