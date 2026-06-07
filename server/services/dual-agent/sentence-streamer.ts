// server/services/dual-agent/sentence-streamer.ts
//
// Sentence boundary detector for streamed text. Used by the HTTP Speaker
// path to flush each completed sentence into the streaming TTS pipeline
// as soon as it lands, so first-audio latency stays close to the
// time-to-first-sentence rather than time-to-full-utterance.
//
// Strategy:
//   - Latin terminators (.!?¿¡) flush only when followed by whitespace
//     in the current buffer. This avoids splitting decimals like "3.14"
//     mid-stream. A trailing "Hello world." with no following whitespace
//     waits for more deltas (or a final flush()) rather than firing.
//   - CJK / Arabic terminators (。！？؟) flush eagerly — they are rarely
//     followed by ASCII whitespace and waiting risks holding the whole
//     utterance.
//   - Trailing punctuation immediately after the terminator (closing
//     quote / paren) attaches to the sentence before flushing.
//   - flush() emits anything still buffered as the final fragment.

const LATIN_TERMINATORS = new Set([".", "!", "?", "¿", "¡"]);
const EAGER_TERMINATORS = new Set(["؟", "。", "！", "？"]);

/** Trailing punctuation that should attach to the sentence (closing
 *  quote, paren, bracket). When the terminator is followed by one of
 *  these immediately, include it before the flush. */
const TRAILING = new Set(["\"", "'", "”", "’", ")", "]", "»"]);

export class SentenceStreamer {
  private buffer = "";

  /** Feed a streaming text delta. Returns zero or more complete sentences
   *  that were closed off by this delta. Order is preserved. */
  push(delta: string): string[] {
    if (!delta) return [];
    this.buffer += delta;
    return this.drain();
  }

  /** Stream ended — emit any remaining buffered text as one final
   *  sentence (no terminator required). Returns the leftover, or null
   *  if the buffer is empty / whitespace only. */
  flush(): string | null {
    const remaining = this.buffer.trim();
    this.buffer = "";
    return remaining || null;
  }

  private drain(): string[] {
    const out: string[] = [];
    let cursor = 0;

    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      const isLatin = LATIN_TERMINATORS.has(ch);
      const isEager = EAGER_TERMINATORS.has(ch);
      if (!isLatin && !isEager) continue;

      // Look past any trailing punctuation (close quote / paren).
      let end = i + 1;
      while (end < this.buffer.length && TRAILING.has(this.buffer[end])) end++;

      if (isLatin) {
        // Need whitespace immediately after to confirm this is a
        // sentence boundary rather than a decimal point or initial.
        // If we ran off the buffer, wait for more input.
        const next = this.buffer[end];
        if (next === undefined) break; // wait for more
        if (!/\s/.test(next)) {
          // Not a sentence end (likely a decimal / initial). Skip.
          continue;
        }
      }
      // Eager terminators always flush.

      const sentence = this.buffer.slice(cursor, end).trim();
      if (sentence) out.push(sentence);
      cursor = end;
      i = end - 1;
    }

    if (cursor > 0) this.buffer = this.buffer.slice(cursor);
    return out;
  }
}
