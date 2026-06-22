// server/services/dual-agent/speech-text.ts
//
// Pure helpers for the cost-saving client-STT path (Phase 1): turning an
// on-device transcript into the turn-completing [HEARD SPEECH] message the
// Observer reacts to. Extracted from AgentCoordinator so the message format and
// confidence mapping are unit-testable. See planning-docs/aac-cost-saving-spec.md §1.

export type ConfidenceLabel = "high" | "medium" | "low" | "unknown";

/** Map a 0..1 STT confidence to a coarse word for the Observer prompt. */
export function confidenceLabel(confidence?: number): ConfidenceLabel {
  if (typeof confidence !== "number") return "unknown";
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.45) return "medium";
  return "low";
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
  return (
    `[HEARD SPEECH] (on-device transcript, confidence: ${confidenceLabel(confidence)}) "${clean}"\n` +
    `This was transcribed on the device — the words above are authoritative; do NOT re-transcribe. ` +
    `Attribute the speaker (use [VOICES HEARD] / [PEOPLE PRESENT] and what you can see) and judge who it is addressed to, ` +
    `then route it via transcript(). If the confidence is low or the words don't fit the scene, treat it as uncertain.`
  );
}
