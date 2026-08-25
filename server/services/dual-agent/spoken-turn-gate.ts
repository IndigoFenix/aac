// server/services/dual-agent/spoken-turn-gate.ts
//
// THE gate for "what the Speaker is allowed to have said".
//
// Every Speaker turn — native-audio outputTranscription, HTTP text deltas,
// and the fallback speak() tool — passes through here exactly once, and the
// result is what reaches ALL FIVE downstream consumers:
//
//   1. the client caption (streaming deltas + the final transcript)
//   2. server TTS / the native audio stream
//   3. the Board Manager rebuild trigger
//   4. the Observer echo + the conversation log
//   5. the Speaker's OWN context ("[YOU to USER] … (you just said this)")
//
// Why this file exists
// --------------------
// The Speaker SEES its input in a bracketed wire format — "[USER to YOU] …",
// "[MODE companion]", "[CONTEXT] other: …", "[GAME] …" — and it sometimes
// reproduces that machinery in its output. Until now the only guards were
// two POSITIONAL prefix tests: `isLeakedThought()` (matches "private_thought"
// at the front) and `stripLeadingTags()` (matches a bracket run at index 0).
//
// On 2026-08-24 a turn came out as:
//
//   (The user has closed the game.)[CONTEXT] other: סיום פעילות …[CONTEXT]
//   other: Daniel …[CONTEXT] close_app: The app closed. (Cave Gem Quest)סיימת לשחק?
//
// It began with a PAREN, not a bracket, so the leading-tag regex failed at
// character 0, marked the leading region resolved, and let all three
// `[CONTEXT]` groups through. The model spoke the whole thing aloud, the
// child saw it captioned, the Board Manager rebuilt from it, and it was
// echoed back into the model's own context as something it had said — the
// same self-reinforcing loop the thought-leak guard was built to break.
//
// The policy therefore lives here, once, as a shape rule rather than a list
// of known markers:
//
//   * A bracket group is machine wire format ANYWHERE in an utterance.
//     Spoken words never contain "[…]". Removed on sight, at any position.
//   * A LEADING paren group is a stage direction ("(The user has closed the
//     game.)", "(sighs)"). Spoken replies do not open with a parenthetical.
//     Removed. Mid-sentence parens are left alone.
//
// and the SEVERITY rule decides what happens next:
//
//   * clean  — nothing removed. Speak it.
//   * mild   — exactly ONE leading group, and it is a stage direction or a
//              pure addressing tag ("[USER to YOU]", "[MODE …]"). Strip it,
//              speak the rest, nudge the model once. This is the behavior
//              the leading-tag guard already had; it is preserved so a
//              single stray prefix doesn't cost the child a whole reply.
//   * severe — anything else: two or more groups, a group carrying injected
//              CONTENT ("[CONTEXT] …", "[GAME] …", "[SCENE] …"), or a group
//              found mid-utterance. The turn is not a reply, it is the model
//              reciting its input. Suppressed exactly like a thought leak —
//              audio killed mid-stream, nothing echoed back, nothing
//              rebuilt, and a corrective injected.
//
// Adding a new kind of context injection is silent by default: it can only
// reach the child by being SPOKEN, never by falling through this gate.

/** One bracket group, confined to a single line and length-capped as a
 *  runaway guard (an unclosed "[" must not eat the whole utterance). */
const BRACKET_GROUP = String.raw`\[[^\]\n]{1,200}\]`;
/** One paren group, same guards. */
const PAREN_GROUP = String.raw`\([^)\n]{1,200}\)`;

/** A bracket-or-paren group at the very front, with its whitespace. */
const LEADING_GROUP_RE = new RegExp(`^\\s*(?:${BRACKET_GROUP}|${PAREN_GROUP})\\s*`);
/** Bracket groups remaining anywhere after the leading run is consumed. */
const INNER_BRACKET_RE = new RegExp(`\\s*${BRACKET_GROUP}\\s*`, "g");
/** An unclosed "[" or "(" at the tail — a streaming transcript may still be
 *  mid-group, so the gate withholds output until it closes. */
const OPEN_TAIL_RE = /[[(][^\])\n]*$/;

/**
 * Tags that only say WHO is talking to whom. If the model echoes one of
 * these alone at the front, the reply behind it is still a real reply.
 * Everything else in brackets carries injected CONTENT — perception notes,
 * game events, tool results — and an utterance containing it is the model
 * reading its input aloud, not talking to the child.
 */
const ADDRESSING_TAG_RE = /^\[\s*(?:USER to\b|YOU to\b|AI to\b|MODE\b)/i;

export type SpokenTurnVerdict = "clean" | "mild" | "severe";

export interface SpokenTurnResult {
  /** The only text that may be spoken, captioned, echoed or rebuilt from. */
  speech: string;
  /** The same text with edge whitespace left intact — the streaming gate
   *  emits from this so a word-boundary space rides with the delta that
   *  produced it instead of being deferred to the next one. */
  speechStream: string;
  /** Everything removed, joined — for the flow log and the corrective. */
  leaked: string;
  verdict: SpokenTurnVerdict;
}

/** True when the group is a stage direction or a pure addressing tag —
 *  the two shapes a single leading leak may take without voiding the turn. */
function isBenignGroup(group: string): boolean {
  return group.startsWith("(") || ADDRESSING_TAG_RE.test(group);
}

/**
 * The whole policy, as a pure function. Everything about what the Speaker is
 * allowed to have said is decided here and nowhere else.
 */
export function sanitizeSpokenTurn(raw: string): SpokenTurnResult {
  const removed: string[] = [];

  // 1. The leading run: bracket tags and stage directions, in any order.
  let rest = raw;
  for (;;) {
    const m = rest.match(LEADING_GROUP_RE);
    if (!m) break;
    removed.push(m[0].trim());
    rest = rest.slice(m[0].length);
  }
  const leadingCount = removed.length;

  // 2. Bracket groups anywhere in what's left. This is the case the
  //    leading-only guard could never see.
  rest = rest.replace(INNER_BRACKET_RE, (m) => {
    removed.push(m.trim());
    return " ";
  });

  const speechStream = rest.replace(/[ \t]{2,}/g, " ");
  const speech = speechStream.trim();

  let verdict: SpokenTurnVerdict;
  if (removed.length === 0) {
    verdict = "clean";
  } else if (removed.length === 1 && leadingCount === 1 && isBenignGroup(removed[0])) {
    verdict = "mild";
  } else {
    verdict = "severe";
  }

  return { speech, speechStream, leaked: removed.join(" "), verdict };
}

/**
 * Incremental gate for a streaming turn. Feed deltas in order via push();
 * it withholds text while a group is still open, strips what the policy
 * removes, and flips `severe` the moment the turn is disqualified — so the
 * caller can kill the audio mid-stream rather than after the child hears it.
 */
export class SpokenTurnGate {
  private raw = "";
  /** Chars of the cleaned stream already returned to the caller. */
  private emittedLen = 0;
  private severeLeak = false;

  /** True once this turn is disqualified. Terminal — never clears. */
  get severe(): boolean {
    return this.severeLeak;
  }

  /** Everything fed in so far, untouched (for the supervisor record). */
  get rawTurn(): string {
    return this.raw;
  }

  /** The policy's verdict on the turn as it stands. */
  result(): SpokenTurnResult {
    return sanitizeSpokenTurn(this.raw);
  }

  /** Push the next raw delta; returns the text safe to forward NOW (may be
   *  "" while a group is still open, or forever once `severe` is set). */
  push(delta: string): string {
    this.raw += delta;
    if (this.severeLeak) return "";
    const r = sanitizeSpokenTurn(this.raw);
    if (r.verdict === "severe") {
      this.severeLeak = true;
      return "";
    }
    // Still possibly mid-group — hold until it closes.
    if (OPEN_TAIL_RE.test(this.raw)) return "";
    return this.takeTail(r.speechStream);
  }

  /** Force resolution at end-of-stream (a never-closed "[" is treated as
   *  ordinary text) and return any withheld tail. */
  flush(): string {
    if (this.severeLeak) return "";
    const r = sanitizeSpokenTurn(this.raw);
    if (r.verdict === "severe") {
      this.severeLeak = true;
      return "";
    }
    return this.takeTail(r.speechStream);
  }

  private takeTail(speech: string): string {
    const tail = speech.slice(this.emittedLen);
    this.emittedLen = speech.length;
    return tail;
  }
}
