// server/services/dual-agent/speech-text.ts
//
// Pure helpers for the cost-saving client-STT path (Phase 1): turning an
// on-device transcript into the turn-completing [HEARD SPEECH] message the
// Observer reacts to. Extracted from AgentCoordinator so the message format and
// confidence mapping are unit-testable. See planning-docs/aac-cost-saving-spec.md §1.

export type ConfidenceLabel = "high" | "medium" | "low" | "unknown";

/** Map a 0..1 STT confidence to a coarse word for the Observer prompt. */
export function confidenceLabel(confidence?: number): ConfidenceLabel {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return "unknown";
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.45) return "medium";
  return "low";
}

/**
 * The suffix that marks a transcript whose WORDS the recogniser wasn't sure of,
 * for the `[<speaker> to <target>]` tag every agent reads. One helper so the
 * Speaker's line (agent-coordinator) and the Board Manager's line
 * (prompts/board-manager renderEventLine) can never drift apart — an agent that
 * saw a different marker than its sibling would act on a different story.
 *
 * Only medium/low are marked. "high" needs no marker, and "unknown" (the model
 * reported no score) must NOT be marked: absence of a score is not evidence of
 * a bad one, and crying wolf on every unscored transcript would train both
 * agents to ignore the marker entirely.
 */
export function clarityTag(asrConfidence?: ConfidenceLabel): string {
  if (asrConfidence === "medium") return " — words uncertain";
  if (asrConfidence === "low") return " — words very uncertain";
  return "";
}

/** Flow-log rendering of a recognizer score — "asr 0.62 (medium)" / "asr n/a".
 *  Keeps the raw number in the log so thresholds can be re-tuned from real
 *  sessions rather than guessed. */
export function describeSttConfidence(confidence?: number): string {
  const label = confidenceLabel(confidence);
  return label === "unknown" ? "asr n/a" : `asr ${confidence!.toFixed(2)} (${label})`;
}

/**
 * Build the turn-completing message fed to the Observer in place of streamed
 * audio. The Observer's job is unchanged — attribute the speaker, judge the
 * target, route via transcript() — but it works from authoritative on-device
 * text rather than re-transcribing audio. Returns null for empty text.
 */
export function buildHeardSpeechTurn(text: string, confidence?: number): string | null {
  const clean = (text || "").trim();
  if (!clean) return null;
  const label = confidenceLabel(confidence);
  // The speech-to-text is a recogniser, not a witness: it always emits SOME
  // word sequence, so weak audio comes back as a fluent, plausible sentence
  // rather than as nothing. The Observer is the layer that catches that — but
  // only if it's told how sure the recogniser actually was, which is why this
  // line must carry the REAL score (see project_stt_fluent_misrecognition).
  const trust = label === "high"
    ? `The recogniser was confident of the words — relay them as heard unless the scene plainly contradicts them.`
    : `The recogniser was ${label === "unknown" ? "unable to score" : `only ${label}-confidence on`} the words. It never returns silence, so weak or distant audio comes back as a confident-looking sentence that was never said. Weigh it against the scene: if it fits nothing happening, drop it rather than passing it on; request_audio to hear the clip when it matters.`;
  return (
    `[HEARD SPEECH] (speech-to-text, confidence: ${label}) "${clean}"\n` +
    `${trust} Attribute the speaker (use [VOICES HEARD] / [PEOPLE PRESENT] and what you can see) and judge who it is addressed to, ` +
    `then route it via transcript() — set its \`confidence\` to how sure YOU are of the WORDS, not of the speaker.`
  );
}
