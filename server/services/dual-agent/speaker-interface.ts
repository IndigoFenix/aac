// server/services/dual-agent/speaker-interface.ts
//
// Shared interface for the two Speaker implementations:
//   - SpeakerAgent      (Gemini Live, AUDIO or TEXT modality)
//   - HttpSpeakerAgent  (Gemini HTTP completion, streaming TTS)
//
// AgentCoordinator holds either through this interface and chooses which
// to instantiate based on AAC_SPEAKER_MODE. The interface is the lowest
// common denominator — Live-only knobs (e.g. session resumption, mic
// muting) stay private to SpeakerAgent.

import type { SpeakerStartConfig } from "./speaker-agent";

export interface ISpeakerAgent {
  readonly isConnected: boolean;

  /** Open the underlying provider (Live session or just bootstrap the
   *  HTTP message buffer) with the given system prompt + tool config. */
  start(config: SpeakerStartConfig): Promise<void>;

  /** Re-bootstrap with a fresh prompt + config — used by profile
   *  transitions (awake ↔ resting in the Live path; recreate buffer in
   *  the HTTP path). */
  reconnectWithConfig(config: SpeakerStartConfig): Promise<void>;

  close(): void;

  /** A user-role turn that should provoke a reply (button press,
   *  transcribed speech addressed to the AI, composed sentence). */
  sendUserTurn(text: string): void;

  /** Abandon the turn currently being generated, if any, WITHOUT starting a
   *  replacement. Used by the barge-in press option: the student pressed a
   *  different button over the AI's answer, so the answer is dead — the HTTP
   *  path aborts its in-flight completion so no further sentences reach TTS.
   *  Optional: the Live path has no cancel of its own (its generation is cut
   *  when the next user turn lands, and its audio is already dropped by the
   *  Coordinator), so it implements this as a no-op. */
  cancelTurn?(reason: string): void;

  /** Downward context the model should remember but NOT respond to
   *  directly (mode changes, mute toggles, observer hints, [BUILDER STATE]).
   *  In the HTTP path this buffers without firing a completion. */
  sendContextInjection(text: string): void;

  /** Replay history after reconnection / wake. Live agent passes this
   *  to the provider's session-resumption replay; HTTP agent seeds its
   *  message buffer. */
  sendConversationHistory(turns: Array<{ role: "user" | "model"; text: string }>): void;

  setDebugSessionContext(sessionId: string, debugMode: boolean, agentLabel?: string): void;
}
