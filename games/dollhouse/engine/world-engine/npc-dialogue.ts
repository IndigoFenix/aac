// shared/world-engine/npc-dialogue.ts
//
// Canned, LANGUAGE-KEYED dialogue for in-game characters (NPCs) — the "what to
// say" half of NPC speech, kept pure/headless so it's unit-testable. The "say it
// out loud" half is npc-voice.ts (browser speechSynthesis). A game pairs them:
// resolveLine() → showWorldBubble() (the bubble) + NpcVoice.speak() (the audio).
//
// Lines are grouped by INTENT (a situation: greet / celebrate / encourage / …)
// and each line carries text per BCP-47 base language, so the same character can
// speak the student's language with no server round-trip.

/** One canned line in multiple languages. `text` keyed by language ("en", "he",
 *  "es"…). `glyph` is an optional composed AAC glyph string for a symbol bubble. */
export interface DialogueLine {
  text: Record<string, string>;
  glyph?: string;
}

/** A character's canned lines, grouped by intent/situation. */
export type NpcDialogue = Record<string, DialogueLine[]>;

/**
 * Resolve a line's text for `lang`, falling back: exact tag → base language →
 * the line's first available language. Null if the line has no text at all.
 */
export function lineText(line: DialogueLine, lang: string): string | null {
  const base = lang.split("-")[0].toLowerCase();
  if (line.text[lang]) return line.text[lang];
  if (line.text[base]) return line.text[base];
  const first = Object.keys(line.text)[0];
  return first ? line.text[first] : null;
}

/** Pick one line for an intent (uniformly at random; pass a seeded rng for
 *  determinism). Null if the intent has no lines. */
export function pickLine(
  dialogue: NpcDialogue,
  intent: string,
  rng: () => number = Math.random,
): DialogueLine | null {
  const lines = dialogue[intent];
  if (!lines || lines.length === 0) return null;
  const i = Math.min(lines.length - 1, Math.max(0, Math.floor(rng() * lines.length)));
  return lines[i];
}

/** pickLine + lineText: a ready-to-show line for an intent in a language, or null
 *  if the intent is unknown / empty / has no text for any language. */
export function resolveLine(
  dialogue: NpcDialogue,
  intent: string,
  lang: string,
  rng: () => number = Math.random,
): { text: string; glyph?: string } | null {
  const line = pickLine(dialogue, intent, rng);
  if (!line) return null;
  const text = lineText(line, lang);
  return text ? { text, glyph: line.glyph } : null;
}

/**
 * A small sample companion dialogue (en/es/he) — used by the symbol-learning
 * game's companion and as a test fixture. Games ship their own sets; this is a
 * reasonable default for a warm, encouraging helper.
 */
export const SAMPLE_NPC_DIALOGUE: NpcDialogue = {
  greet: [
    { text: { en: "Hi! Let's play.", es: "¡Hola! Vamos a jugar.", he: "היי! בוא נשחק." } },
  ],
  celebrate: [
    { text: { en: "You did it!", es: "¡Lo lograste!", he: "הצלחת!" } },
    { text: { en: "Great job!", es: "¡Buen trabajo!", he: "כל הכבוד!" } },
  ],
  encourage: [
    { text: { en: "Almost — try again!", es: "Casi — ¡inténtalo otra vez!", he: "כמעט — נסה שוב!" } },
  ],
};
