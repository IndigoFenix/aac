// shared/aac/speech-act.ts
//
// SPEECH ACT — what a board button's utterance DOES, as opposed to what it
// means. Pure and server-safe (no React, no DOM), so the server can stamp a
// button's act before shipping it and every renderer can agree on the result.
//
// ─────────────────────────────────────────────────────────────────────────────
// SCOPE — THIS DRIVES A MARK, NOT A COLOUR. (Narrowed 2026-08-24.)
// ─────────────────────────────────────────────────────────────────────────────
//
// The act's ONLY job is the prosody mark on the glyph: `request` gets the arc,
// `ask` gets the `?`. Nothing here paints a button. Board colour is decided in
// `shared/button-color.ts` from the yes/no SYMBOL and from `role` — see the
// note there.
//
// It used to paint (social -> pink, repair -> violet, and a widening of
// green/red past a literal yes/no symbol). That was WRONG and was pulled after
// one live session. The reason is worth keeping, because the data is still
// sitting here looking convenient:
//
//   ⚠️ `ToneFamily` CLASSIFIES WORDS. A SPEECH ACT CLASSIFIES UTTERANCES.
//
// `tone: "social"` is a vocabulary flavour, not a pragmatic function — its 41
// members include twelve PEOPLE NOUNS (mom, dad, teacher, doctor…), function
// words (with, for, together) and directives (look, my_turn). Deriving "this
// utterance is a greeting" from it painted "I want to talk to mom" pink, and
// the colour read as random on a real board. `tone: "request"` leaks the same
// way, more mildly — it holds plain action verbs (eat, drink, go, come, carry)
// alongside the true requests (want, need, give, help), so the arc is right
// most of the time rather than always. That is tolerable for a MARK sitting in
// a corner; it was not tolerable for the button's whole background.
//
// The rule that survives: a lexical tag may HINT at an act, never assert one,
// and the weaker the evidence the quieter the channel it may drive.
//
// Related axis, deliberately separate: `BoardButton.role` ("reply" | "bid") is
// TURN-TAKING FORCE — does this hand the turn over? It comes from the model
// reading the CONVERSATION rather than from any word-level tag, which is why it
// cannot suffer the failure above, and it is what the board now colours.

import { parseGlyph, dominantToneFamily } from "../glyph-compositor.js";

/**
 * The nine pragmatic functions a board utterance can perform.
 *
 * Only `request` and `ask` are DRAWN (see `speechActToneTag`). The rest are
 * carried because the act is stamped on the button and the Monitor, the session
 * summary and the press handlers all benefit from knowing what kind of thing
 * the student just said — but nothing paints from them. `direct` and `repair`
 * are currently unreachable: they had no registry tone and were only ever
 * assertable through the removed `speech_act` tool field. They stay in the type
 * so the taxonomy reads whole and a future derivation has somewhere to land.
 */
export type SpeechAct =
  /** Accepts or agrees: yes, okay, sure, me too, I like it. */
  | "affirm"
  /** Refuses or protests: no, stop, don't, I don't want that, go away. */
  | "reject"
  /** Wants an object or an action: I want water, help me, can I have that. */
  | "request"
  /** Wants information back: why? what about you? who is that? */
  | "ask"
  /** Reports an internal state: I'm tired, I hurt, I'm scared, I'm happy. */
  | "express"
  /** Phatic / etiquette: hi, bye, thank you, please, sorry. */
  | "social"
  /** Regulates the partner: look at this, come here, your turn, wait. */
  | "direct"
  /** Repairs the channel: that's not what I meant, say it again, wrong. */
  | "repair"
  /** Asserts about the world — the unmarked default. */
  | "comment";

export const SPEECH_ACTS: readonly SpeechAct[] = [
  "affirm", "reject", "request", "ask", "express", "social", "direct", "repair", "comment",
] as const;

const SPEECH_ACT_SET: ReadonlySet<string> = new Set<string>(SPEECH_ACTS);

/** Narrow an untrusted string (model output, stored board JSON) to a SpeechAct. */
export function asSpeechAct(v: unknown): SpeechAct | undefined {
  return typeof v === "string" && SPEECH_ACT_SET.has(v) ? (v as SpeechAct) : undefined;
}

/**
 * Scan a glyph encoding for the canonical bare `yes` / `no` SYMBOLs.
 *
 * Tokenizes on the syntactic separators (`+` between GLYPHs, `.` between
 * HEAD/MODIFIER SYMBOLs, `#` for OPERATORs, and the composable-host `(payload)`
 * parens) so it can never match inside an emoji or an arbitrary key. Both
 * present is ambiguous and yields undefined.
 *
 * Shares its rule with `detectYesNoDefaultColor` in `shared/button-color.ts`,
 * which is what actually paints green/red. Pinned against each other in
 * `server/tests/speech-act.test.ts` so the mark and the colour cannot disagree
 * about what counts as a yes.
 */
export function detectYesNoAct(glyph?: string): "affirm" | "reject" | undefined {
  if (!glyph) return undefined;
  const tokens = glyph.split(/[+.#()]/).map((t) => t.trim()).filter(Boolean);
  let hasYes = false;
  let hasNo = false;
  for (const t of tokens) {
    if (t === "yes") hasYes = true;
    else if (t === "no") hasNo = true;
  }
  if (hasYes && hasNo) return undefined; // ambiguous
  if (hasYes) return "affirm";
  if (hasNo) return "reject";
  return undefined;
}

/**
 * Resolve a button's speech act from its GLYPH.
 *
 * Glyph-only by design: the Board Manager used to be able to assert an act via
 * a `speech_act` tool field, and that field was removed (it drove colour, and
 * colour moved to `role`). Keeping one deterministic source means the mark on a
 * button is reproducible from the button alone.
 *
 * Returns undefined when the glyph says nothing — callers treat that as
 * `comment` (the unmarked default) rather than as an error.
 */
export function deriveSpeechAct(input: { glyph?: string }): SpeechAct | undefined {
  const { glyph } = input;

  // A yes/no symbol is absolute — and is also what `button-color` keys its
  // green/red off, so the two agree by construction.
  const yesNo = detectYesNoAct(glyph);
  if (yesNo) return yesNo;

  if (!glyph) return undefined;

  // The registry's opinion. `dominantToneFamily` prefers a `#question`
  // OPERATOR over the slots, then a verb's tone, then a feeling's — so
  // `i_me+want+water` resolves through `want` (tone: "request"), not `water`.
  switch (dominantToneFamily(parseGlyph(glyph))) {
    case "question": return "ask";
    case "request":  return "request";
    case "social":   return "social";
    case "feeling":  return "express";
    case "comment":  return undefined;
  }
  return undefined;
}

/**
 * The prosody OPERATOR tag a speech act implies, for the acts whose symbol
 * needs a mark rather than a fill.
 *
 * `ask` maps to the `#question` tag that already exists and already renders a
 * `?`. `request` and `direct` share the new `#request` mark — both are
 * DIRECTIVES in the speech-act sense ("come here" and "I want water" both ask
 * the partner to do something), and the student learning one mark for both is
 * a feature rather than a compromise.
 *
 * Returned as a tag name so the caller can append it to the glyph string; the
 * compositor draws it.
 */
export function speechActToneTag(act?: SpeechAct): "question" | "request" | undefined {
  switch (act) {
    case "ask":     return "question";
    case "request":
    case "direct":  return "request";
    default:        return undefined;
  }
}

/**
 * Stamp the act's prosody mark onto a glyph string, returning it unchanged when
 * there is nothing to add.
 *
 * APPENDS the tag as text rather than parse→serialize round-tripping, so an
 * exotic or AI-authored glyph cannot be quietly rewritten on its way through.
 * `parseGlyph` collects tags off any token and accepts both `#a#b` and `#a.b`,
 * so a glyph that already carries `#past` becomes `#past#request` and parses
 * correctly — tense and prosody live on opposite corners.
 *
 * A glyph that ALREADY carries a prosody tag is left alone: an author who wrote
 * `#question` outranks a derived `request`, matching how the badge renderer
 * resolves the same collision.
 */
export function applySpeechActMark(glyph: string | undefined, act: SpeechAct | undefined): string | undefined {
  const tag = speechActToneTag(act);
  if (!glyph || !tag) return glyph;
  const existing = parseGlyph(glyph).toneTags;
  if (existing.some((t) => t === "question" || t === "exclamation" || t === "request")) return glyph;
  return `${glyph}#${tag}`;
}
