/**
 * Board CONTENT PAYLOAD signal.
 *
 * A board stalls the conversation when its buttons are speech ACTS with no
 * subject: "I want to talk about something else", "I want to ask a question",
 * "I want to tell you something". Pressing one cannot advance anything —
 * it carries no referent, so the only possible reply is "about what?", which
 * regenerates the same board one rung down. Observed verbatim in
 * `server/agent-flow-debug.log` (2026-08-19) after a [MORE] press.
 *
 * This module answers ONE question about a board: do its buttons NAME
 * anything? It is EVIDENCE, never a gate — a contentless board still ships.
 * The Coordinator feeds the score to `./conversation-stall`, which decides
 * when the next rebuild should carry conversation seeds.
 *
 * Why not part-of-speech alone: the registry types `something` and `apple`
 * both as `noun`. Separating them needs the explicit placeholder set below.
 */

// Explicit ".js": `shared/glyph-compositor.tsx` (the React component) sits
// beside `.ts` (the server-safe parser), and esbuild resolves an
// extensionless specifier to .tsx first — which imports parseGlyph but does
// not re-export it, so the dev bundle failed to build while tsc stayed
// green. Every other server importer of this module is already explicit.
import { parseGlyph } from "@shared/glyph-compositor.js";
import { getVocabularyItem, getVocabularyItemByEmoji } from "@shared/glyph-registry";
import type { GlyphPos } from "@shared/glyph-registry";

/**
 * Registry keys that fill a slot without naming anything — pro-forms,
 * placeholder nouns and interrogatives. A glyph made only of these is the
 * shape this module exists to catch.
 */
export const PLACEHOLDER_HEADS: ReadonlySet<string> = new Set([
  // placeholder nouns
  "something", "thing", "anything", "nothing", "stuff",
  // interrogatives / pro-forms
  "what", "who", "where", "when", "why", "which", "how",
  // board chrome that leaks into speech ("something else", "more options")
  "other", "else", "more", "again",
  // the act itself, when the AI spells it out as a noun
  "question", "answer", "topic", "word",
]);

/**
 * Conversation participants. Present in every exchange, so naming one does
 * not make a button topical — "how are you?" is as open as "I want to talk".
 * A THIRD party (mom, teacher, a classmate) is a real referent and is NOT
 * listed here.
 */
export const PARTICIPANT_HEADS: ReadonlySet<string> = new Set([
  "i_me", "you", "we", "us", "me", "my", "your",
]);

/**
 * Verbs that describe the act of communicating rather than a topic. "I want
 * to PLAY" names an activity; "I want to TALK" names only the wish to talk.
 * Kept deliberately short — every other verb counts as content.
 */
export const META_VERBS: ReadonlySet<string> = new Set([
  "talk", "say", "tell", "ask", "answer", "want", "do", "choose", "pick",
]);

/** Parts of speech that can carry a referent at all. */
const CONTENT_POS: ReadonlySet<GlyphPos> = new Set<GlyphPos>([
  "noun", "person", "animal", "place", "time", "feeling", "verb",
]);

/** A board at or below this payload ratio reads as contentless. */
export const CONTENTLESS_RATIO = 0.34;

/** One button's verdict, kept for logging — a flow note that names the
 *  offending labels is what makes this diagnosable in a live session. */
export interface ButtonContentVerdict {
  label: string;
  /** The button names at least one referent. */
  hasPayload: boolean;
  /** Content heads found on it (registry keys), for the stall accumulator. */
  heads: string[];
}

export interface BoardContentSignal {
  /** Buttons scored (chrome like `more` / `wordfinder` is excluded). */
  total: number;
  withPayload: number;
  /** withPayload / total; 1 when there was nothing to score. */
  ratio: number;
  /** True when the board is mostly speech acts with no subject. */
  contentless: boolean;
  /** Distinct content heads across the whole board. */
  heads: string[];
  buttons: ButtonContentVerdict[];
}

/** Buttons that are navigation chrome, not utterances — never scored. */
const CHROME_TYPES: ReadonlySet<string> = new Set([
  "more", "wordfinder", "category", "suggestion", "narrow",
]);

/** The button fields this module reads. Structurally satisfied by
 *  `MergeButton` (board-merge.ts) and by raw BoardManager output. */
export interface ScorableButton {
  label?: string;
  glyph?: string;
  glyphFallback?: string;
  buttonType?: string;
}

/**
 * Does one glyph slot key name something?
 *
 * Resolution order matters: a raw emoji (`😀`) is not a registry KEY but
 * usually maps to one by emoji, and an unresolvable emoji still depicts a
 * concrete thing. An unknown BARE key is the opposite case — in practice it
 * is the AI spelling out a meta word it had no symbol for (`else`,
 * `question`, `about`, all three seen in the logged board), so it counts as
 * no payload. An unknown BRACKETED key (`[volcano]`) is a deliberate
 * on-demand image for a real word and does count.
 *
 * The bracket tell costs us novel content words the AI forgot to bracket.
 * That is the right way to be wrong here: this signal only nudges the next
 * rebuild toward richer topics, so a false "contentless" is cheap and a
 * false "has payload" hides the very thing we are looking for.
 */
function slotNamesSomething(key: string, unknown: boolean, rawGlyph: string): boolean {
  if (PLACEHOLDER_HEADS.has(key) || PARTICIPANT_HEADS.has(key) || META_VERBS.has(key)) {
    return false;
  }
  const item = getVocabularyItem(key) ?? getVocabularyItemByEmoji(key);
  if (item) {
    // A resolved item may still be a placeholder under its canonical key
    // (an emoji alias), so re-test the key we actually landed on.
    if (PLACEHOLDER_HEADS.has(item.key) || PARTICIPANT_HEADS.has(item.key)
        || META_VERBS.has(item.key)) {
      return false;
    }
    return CONTENT_POS.has(item.pos);
  }
  if (!unknown) return false;
  // Unresolved: bracketed keys and non-ASCII symbols (emoji the registry
  // doesn't carry) name things; bare ASCII words are meta filler.
  if (rawGlyph.includes(`[${key}]`)) return true;
  return !/^[\w-]+$/.test(key);
}

/** Content heads on one glyph string. */
function headsOf(glyph: string): string[] {
  const parsed = parseGlyph(glyph);
  const heads: string[] = [];
  for (const slot of parsed.slots) {
    if (slot.join) continue; // connectors bind, they don't name
    if (slotNamesSomething(slot.key, slot.unknown, glyph)) heads.push(slot.key);
    // A payload rides INSIDE a composable host (`house(apple)`) and is as
    // real a referent as a top-level slot.
    if (slot.payload
        && slotNamesSomething(slot.payload, !!slot.payloadUnknown, glyph)) {
      heads.push(slot.payload);
    }
  }
  return heads;
}

/** Score one button. Exported for the unit tests and for per-button logging. */
export function scoreButtonContent(button: ScorableButton): ButtonContentVerdict {
  const label = button.label ?? "";
  let heads = headsOf(button.glyph ?? "");
  // An all-imageKey glyph carries its readable form in the fallback; score
  // that rather than call the button empty.
  if (heads.length === 0 && button.glyphFallback) {
    heads = headsOf(button.glyphFallback);
  }
  return { label, hasPayload: heads.length > 0, heads };
}

/**
 * Score a whole board. Chrome buttons are excluded from the ratio — a
 * "More" button is not the AI failing to name a topic.
 */
export function scoreBoardContent(buttons: readonly ScorableButton[]): BoardContentSignal {
  const scorable = buttons.filter(
    (b) => !(b.buttonType && CHROME_TYPES.has(b.buttonType)),
  );
  const verdicts = scorable.map(scoreButtonContent);
  const withPayload = verdicts.filter((v) => v.hasPayload).length;
  const total = verdicts.length;
  const ratio = total === 0 ? 1 : withPayload / total;
  const heads = [...new Set(verdicts.flatMap((v) => v.heads))];
  return {
    total,
    withPayload,
    ratio,
    // An empty board is not evidence of anything.
    contentless: total > 0 && ratio <= CONTENTLESS_RATIO,
    heads,
    buttons: verdicts,
  };
}
