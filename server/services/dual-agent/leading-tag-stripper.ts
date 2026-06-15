// server/services/dual-agent/leading-tag-stripper.ts
//
// Strips leaked leading meta-tags ("[USER to YOU]", "[MODE companion]",
// "[CONTEXT ...]", "[YOU to USER]") that the Speaker model occasionally
// echoes from its input at the very START of an utterance. These tags are
// an internal wire format the Speaker SEES (the Coordinator tags every
// incoming statement and context injection with them) — it must never
// REPRODUCE them. Two harms:
//   1. Voicing/subtitling "[USER to YOU]" is noise the child sees/hears.
//   2. Feeding the tag back into the transcript (Observer echo, conversation
//      log, session summary) teaches the model that tagging its own speech
//      is expected — so the behavior compounds over a session until it
//      reliably prefixes every reply.
//
// We remove any run of bracket groups that LEAD an utterance — never
// brackets that appear mid-sentence. Natural speech essentially never
// begins with a "[...]" group, so this is false-positive-safe.

/** One or more leading "[...]" groups (each confined to a single line and
 *  length-capped as a runaway guard) plus surrounding whitespace. */
const LEADING_TAG_RE = /^(?:\s*\[[^\]\n]{1,200}\])+\s*/;
/** A leading "[" that has NOT closed yet — a streaming transcript may still
 *  be mid-tag, so we withhold output until the "]" lands (or the stream
 *  ends). */
const OPEN_LEADING_BRACKET_RE = /^\s*\[[^\]\n]*$/;
/** Probe for a single complete leading tag. */
const HAS_LEADING_TAG_RE = /^\s*\[[^\]\n]{1,200}\]/;

/** True when `text` begins with a complete bracketed meta-tag. */
export function hasLeadingTag(text: string): boolean {
  return HAS_LEADING_TAG_RE.test(text);
}

/** Remove any run of leading bracketed tags (and surrounding whitespace). */
export function stripLeadingTags(text: string): string {
  return text.replace(LEADING_TAG_RE, "");
}

/** The leading tag run that `stripLeadingTags` would remove (trimmed), or
 *  "" when there is none. Used for logging which tag leaked. */
export function extractLeadingTags(text: string): string {
  const m = text.match(LEADING_TAG_RE);
  return m ? m[0].trim() : "";
}

/**
 * Incremental stripper for a streaming transcript. Feed deltas in order via
 * push(); it withholds output while a leading "[" is still open, strips the
 * closed leading tag run exactly once, and thereafter passes text through
 * unchanged. `strippedTag` records what was removed (drives the corrective).
 */
export class LeadingTagStripper {
  private raw = "";
  /** Chars of the cleaned stream already returned to the caller. */
  private emittedLen = 0;
  /** Leading region decided (tag stripped or confirmed absent). */
  private resolved = false;
  /** The leading tag run that was removed (empty when none). */
  strippedTag = "";

  /** Whether a leading tag was removed from this stream. */
  get stripped(): boolean {
    return this.strippedTag.length > 0;
  }

  /** Full cleaned transcript accumulated so far. */
  get cleaned(): string {
    return stripLeadingTags(this.raw);
  }

  /** Push the next raw delta; returns the cleaned text to forward now (may
   *  be "" while a leading bracket is still open). */
  push(delta: string): string {
    this.raw += delta;
    if (!this.resolved) {
      // Still possibly mid-tag — hold until the bracket closes.
      if (OPEN_LEADING_BRACKET_RE.test(this.raw)) return "";
      this.resolved = true;
      this.strippedTag = extractLeadingTags(this.raw);
    }
    return this.takeTail();
  }

  /** Force resolution at end-of-stream (handles a never-closed "[" by
   *  treating it as ordinary text) and return any withheld tail. */
  flush(): string {
    if (!this.resolved) {
      this.resolved = true;
      this.strippedTag = extractLeadingTags(this.raw);
    }
    return this.takeTail();
  }

  private takeTail(): string {
    const cleaned = stripLeadingTags(this.raw);
    const tail = cleaned.slice(this.emittedLen);
    this.emittedLen = cleaned.length;
    return tail;
  }
}
