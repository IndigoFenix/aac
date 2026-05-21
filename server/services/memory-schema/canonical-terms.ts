// server/services/memory-schema/canonical-terms.ts
//
// Single source of truth for the AAC system's canonical terminology. The
// prompt, tool descriptions, conversation injections, and example blocks
// all interpolate from `T` rather than embedding raw literals. To rename
// a term — or A/B test a different label — change exactly one line here.
//
// SCOPE
//   This module owns the LABELS the model sees. It does NOT own:
//   - Wire-protocol message types (lowercase `button_press`, `glyph_press`,
//     `construction_state`) — those are client↔server protocol, separate
//     concern.
//   - Code identifiers (`rebuildBoardIntendedSpeech`, `lastTurnHadButtonPress`,
//     etc.) — those track internal state and don't need to track label
//     changes for the model.
//
// ADDING A NEW TERM
//   1. Add the entry to `T` below with a short JSDoc explaining what surface
//      it refers to (UI, linguistic primitive, or model-facing tag/param).
//   2. Reference it via `${T.x}` from the prompt builder, tool descriptions,
//      and example translations. Do not duplicate the literal anywhere.
//
// RENAMING A TERM
//   1. Update the value here. Run a quick `grep` for the old literal to
//      catch any straggling raw mentions outside this module.
//   2. The model picks up the new label on the next session re-init.

export const T = {
  // ── Surfaces (UI affordances the model + student interact with) ─────────
  /** The board of buttons the student picks from to respond. Built/replaced
   *  by `rebuild_board`. Renamed to emphasize it's the STUDENT'S responses
   *  to the AI (not the AI's own statements). */
  board: "USER RESPONSE BOARD",
  /** One button on the board. The student taps it; its `speech` is voiced
   *  by the device TTS. */
  button: "SENTENCE BUTTON",
  /** The composition surface the student opens to build a SENTENCE one
   *  SYMBOL at a time. */
  builder: "SENTENCE BUILDER",

  // ── Linguistic primitives ───────────────────────────────────────────────
  /** One word. Emoji, canonical registry key, custom symbol, or `generate:`. */
  symbol: "SYMBOL",
  /** One phrase: HEAD SYMBOL + zero or more MODIFIER SYMBOLs joined by `.`. */
  glyph: "GLYPH",
  /** Up to three GLYPHs joined by `+`, with sentence-level OPERATORs via `#`. */
  sentence: "SENTENCE",
  /** Sentence-level tag appended via `#` (`#past`, `#future`, `#question`). */
  operator: "OPERATOR",
  /** The first SYMBOL of a GLYPH — its semantic anchor. */
  headSymbol: "HEAD SYMBOL",
  /** A SYMBOL attached to a HEAD SYMBOL via `.` — adjective, adverb, or
   *  preposition that sharpens the head's meaning. */
  modifierSymbol: "MODIFIER SYMBOL",
  /** One SYMBOL the AI offers in the SENTENCE BUILDER's AI strip. */
  suggestion: "SUGGESTION",

  // ── Model-facing tag literals ───────────────────────────────────────────
  /** Turn marker injected when the student taps a SENTENCE BUTTON. */
  tagPress: "[BUTTON PRESS]",
  /** Turn marker injected when the student plays a composed SENTENCE
   *  from the SENTENCE BUILDER. */
  tagComposed: "[SENTENCE COMPOSED]",
  /** Context-injection marker carrying the in-progress builder state. */
  tagBuilderState: "[SENTENCE BUILDER STATE]",

  // ── Tool-parameter names (model-visible JSON keys) ──────────────────────
  /** `rebuild_board.own_speech` — the AI's own spoken statement for this
   *  turn. Renamed from `response` to disambiguate from "USER RESPONSE
   *  BOARD" — the board is the STUDENT'S responses; this param is the
   *  AI's own speech, two different speakers. */
  paramOwnSpeech: "own_speech",
  /** `rebuild_board.user_response_buttons` — the list of SENTENCE BUTTONs
   *  the student can choose from. Renamed from `buttons` so the model
   *  can't conflate "buttons I want to show" with "questions I want to
   *  ask" — these are the USER'S response options, not the AI's. */
  paramUserResponseButtons: "user_response_buttons",
} as const;

/** Type of every value in T — useful for callers that need a value type. */
export type CanonicalTerm = typeof T[keyof typeof T];
