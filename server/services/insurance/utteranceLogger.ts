import { db } from "../../db";
import { aacUtteranceEvents, type AacUtteranceSource } from "@shared/schema";

/**
 * Append-only utterance log for the Insurance Bridge module. Computes
 * word_count + unique_word_count at insert time so MLU/NDW aggregation queries
 * stay simple. Fire-and-forget — errors go to stderr, never thrown.
 *
 * `text` is the spoken/synthesized content the student communicated, after
 * any board-button-to-sentence interpretation. Empty/whitespace-only inputs
 * are dropped silently.
 */
export function recordUtterance(params: {
  studentId: string;
  chatSessionId: string | null;
  text: string;
  source: AacUtteranceSource;
}): void {
  const trimmed = params.text.trim();
  if (!trimmed) return;

  const words = trimmed
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => /[a-zà-ÿא-תء-ي一-鿿]/i.test(w));
  if (words.length === 0) return;

  const uniqueCount = new Set(words).size;

  db.insert(aacUtteranceEvents)
    .values({
      studentId: params.studentId,
      chatSessionId: params.chatSessionId,
      text: trimmed,
      wordCount: words.length,
      uniqueWordCount: uniqueCount,
      source: params.source,
    })
    .execute()
    .catch((err) => {
      console.error("[UtteranceLogger] Failed to record utterance:", err);
    });
}
