/**
 * ai-caption.ts — WHAT THE AI ACTUALLY SAID, out of a stream of `text` chunks.
 *
 * The live model's speech arrives as streamed output-transcription chunks, and
 * a few things leak into that stream that the student must never be shown. Each
 * guard here exists because something got through:
 *
 *   ① `<ctrl##>` SCAFFOLD. On the native-audio model, Google's internal recovery
 *      scaffolding leaks into the transcription ahead of a control token ("If
 *      you were silent, say something.<ctrl95>"). The AUDIO is correct; only the
 *      transcript carries it. Everything up to and including the last token is
 *      scaffold — and so is whatever was accumulated before it, which is why
 *      this RESTARTS the caption rather than trimming it.
 *   ② TAG ARTIFACTS. `<end_of_turn>`, `<unk>` and friends, stripped outright.
 *   ③ PRIVATE-NOTE PREFIXES. The model's own reasoning ("[private note] …"),
 *      which it should have kept to itself. A turn that OPENS with one is
 *      dropped whole — mid-caption it is left alone, so legitimate speech
 *      containing a bracket is never truncated.
 *
 * Pure, so the rule is testable and so the AAC client and the simulated-child
 * harness cannot disagree about what a child heard.
 *
 * ⚠️ The AAC client (`useLiveSession`'s `case "text"`) still carries its own
 * inline copy of this logic — this module was extracted FROM it for the harness.
 * Pointing the client at this module is a small follow-up and the reason to do
 * it is drift: two copies of "what the student is allowed to see" is exactly the
 * shape of bug this codebase keeps finding.
 */

export type CaptionChunk =
  /** Contributes nothing: empty, all-artifact, or a dropped private-note turn. */
  | { kind: "ignore"; reason: "empty" | "artifact-only" | "private-note" }
  /** Scaffold detected: throw away what was accumulated and start from `text`. */
  | { kind: "restart"; text: string; tokens: string[] }
  /** Ordinary speech to append. */
  | { kind: "append"; text: string };

const CTRL = /<ctrl\d+>/g;
const ANY_TAG = /<[^<>]+>/g;
const PRIVATE_NOTE = /^\s*\[(private\s*note|note|thinking|internal|reasoning|self[\s-]*note)\b/i;

/**
 * Decide what one streamed chunk contributes, given what is accumulated so far.
 * `accumulated` matters: the private-note guard only applies at the START of a
 * caption, so a bracketed aside mid-sentence cannot truncate real speech.
 */
export function applyAiTextChunk(accumulated: string, chunk: string): CaptionChunk {
  if (!chunk || !chunk.trim()) return { kind: "ignore", reason: "empty" };

  let text = chunk;
  let restarted = false;
  let tokens: string[] = [];

  const ctrlMatches = [...text.matchAll(CTRL)];
  if (ctrlMatches.length > 0) {
    const last = ctrlMatches[ctrlMatches.length - 1];
    tokens = ctrlMatches.map((m) => m[0]);
    text = text.slice((last.index ?? 0) + last[0].length);
    restarted = true;
    if (!text.trim()) return { kind: "restart", text: "", tokens };
  }

  const cleaned = text.replace(ANY_TAG, "");
  if (!cleaned.trim()) {
    return restarted
      ? { kind: "restart", text: "", tokens }
      : { kind: "ignore", reason: "artifact-only" };
  }

  // Only at the start of a fresh caption — see ③.
  const startsFresh = restarted || !accumulated;
  if (startsFresh && PRIVATE_NOTE.test(cleaned)) {
    return { kind: "ignore", reason: "private-note" };
  }

  return restarted ? { kind: "restart", text: cleaned, tokens } : { kind: "append", text: cleaned };
}

/** Fold a whole stream of chunks into the caption a student would have read. */
export function captionFromChunks(chunks: readonly string[]): string {
  let out = "";
  for (const c of chunks) {
    const r = applyAiTextChunk(out, c);
    if (r.kind === "append") out += r.text;
    else if (r.kind === "restart") out = r.text;
  }
  return out;
}
