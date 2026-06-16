// shared/social-bot/state.ts
//
// Wire-level types that cross the SocialBot WS. Server uses these in the
// outbound payloads; client uses them to type the inbound messages.
//
// The old discrete state engine (PAD struct, Counters, Phase, etc.) has
// been retired — affect and rapport now live inside the server's
// DirectedSession and only the *projected* tuple (face target + mode)
// crosses the wire. Scoring derives from LearnerProfile.skills instead
// of the old per-dimension counters.

import type { FaceTarget, FaceAppearance } from "./ProceduralFace";

// ── Per-session, sent once with `initialized` ──────────────────────────

export interface InitializedPayload {
  sessionId: string;
  /** Persona name shown in tooltips ("Mira"). */
  characterName: string;
  /** TTS voice the server will use. */
  voiceName: string | null;
  language: string;
  /** Procedurally-generated head/skin/etc. params for the face renderer. */
  appearance: FaceAppearance;
  /** Expressiveness trait (0..1) — drives face amplitude. */
  expressiveness: number;
  /** Legibility (0..1) — drops with difficulty. */
  legibility: number;
}

// ── Per-turn, sent on every state mutation ─────────────────────────────

export interface BotStatePayload {
  /** Where the face should be heading — client lerps from current. */
  target: FaceTarget;
  /** Coarse classifier of inner state, for debug/SLP traces. */
  mode: "WITHDRAWN" | "GUARDED" | "PLAYFUL" | "OPEN" | "NEUTRAL";
  /** Bot's current rapport with the user (-1..1). Same as target.r; mirrored for debug. */
  rapport: number;
  /** The peer's spoken line this turn — surfaced in the header caption.
   *  Omitted at session start (before any turn). */
  text?: string;
}

// ── Session report (end of session) ────────────────────────────────────

// Keep in lock-step with the `Competency` union + COMPETENCIES array in
// server/services/social-bot/personality-and-challenge.ts.
export type Competency =
  | "responsiveness"
  | "reciprocity"
  | "attunement"
  | "repair"
  | "assertiveness"
  | "complimentCalibration"
  | "initiation"
  | "interestEngagement"
  // Batch A — conversation mechanics:
  | "turnTaking"
  | "topicMaintenance"
  | "topicShifting"
  | "greetings"
  | "leaveTaking"
  // Batch B — social-emotional + register:
  | "perspectiveTaking"
  | "emotionExpression"
  | "empathy"
  | "politeness"
  | "askingForHelp"
  | "refusal";

export interface CompetencySnapshot {
  competency: Competency;
  /** 0..1 — current EMA. */
  value: number;
  samples: number;
}

export interface SharedMomentSummary {
  kind: "joke" | "disclosure" | "resolved_disagreement" | "shared_interest" | "attuned_moment";
  summary: string;
  weight: number;
}

export interface SessionReport {
  characterName: string;
  durationMs: number;
  turnIndex: number;
  finalMode: BotStatePayload["mode"];
  finalRapport: number;
  competencies: CompetencySnapshot[];
  moments: SharedMomentSummary[];
  /** Bot's in-character closing line, if any. */
  feedbackSummary: string;
}

// ── Dimension labels (for the AAC debrief renderer) ────────────────────

export const COMPETENCY_LABEL: Record<Competency, string> = {
  responsiveness: "responding to what they said",
  reciprocity: "asking about them",
  attunement: "reading their mood",
  repair: "recovering from missteps",
  assertiveness: "speaking your mind",
  complimentCalibration: "giving compliments well",
  initiation: "starting conversations",
  interestEngagement: "engaging with their interests",
  turnTaking: "taking turns",
  topicMaintenance: "staying on topic",
  topicShifting: "changing topics smoothly",
  greetings: "saying hello",
  leaveTaking: "saying goodbye",
  perspectiveTaking: "thinking about how others feel",
  emotionExpression: "naming their own feelings",
  empathy: "showing they care",
  politeness: "being polite",
  askingForHelp: "asking for help",
  refusal: "saying no kindly",
};
