// server/services/dual-agent/observer-interface.ts
//
// Shared interface for the two Observer implementations:
//   - ObserverAgent      (Gemini Live native-audio — continuous, responsive, costly)
//   - HttpObserverAgent  (Gemini HTTP completion — wake-on-event, cheap)
//
// AgentCoordinator holds either through this interface and switches between
// them at runtime (Observer's set_observation_mode tool, or a forced downgrade
// to economy when energy runs low). The interface is the lowest common
// denominator — Live-only knobs (session resumption, raw PCM streaming,
// sendFrameSilent) stay private to ObserverAgent and are no-ops / absent on
// the HTTP path.

import type { ObserverStartConfig } from "./observer-agent";

export interface IObserverAgent {
  readonly isConnected: boolean;

  /** Open the underlying backend (Live session, or bootstrap the HTTP
   *  message history) with the given system prompt + tool config. */
  start(config: ObserverStartConfig): Promise<void>;

  /** Re-open with a fresh prompt + config — Live profile transitions
   *  (awake ↔ resting) reconnect preserving history; the HTTP path just
   *  rebuilds its config and keeps its running history. */
  reconnectWithConfig(config: ObserverStartConfig): Promise<void>;

  close(): void;

  /** A frame the Observer should look at and react to (scene update,
   *  motion/safety escalation, focus frame). `scenePrompt` is the
   *  "react now" instruction that rides with it. */
  sendFrame(jpegBase64: string, scenePrompt?: string): void;

  /** Raw mic audio. Live-only (raw PCM streaming); a no-op on the HTTP
   *  path, where audio always reaches the Observer as transcribed text. */
  sendAudio(audioBase64: string, mimeType?: string): void;

  /** A backlog audio clip the Observer asked to re-hear (request_audio),
   *  delivered as a turn the Observer must react to. */
  sendAudioClipTurn(audioBase64: string, mimeType: string, prompt: string): void;

  /** Downward context the Observer should be aware of but not necessarily
   *  produce a fresh turn for ([SCENE], [OWN_SPEECH], [ENERGY], echoes).
   *  Live: a non-turn context injection. HTTP: buffered into the next turn. */
  sendContextInjection(text: string): void;

  /** A turn-completing message the Observer MUST react to — heard speech
   *  (client STT), startup prompt, etc. Drives a generation. */
  sendUserTurn(text: string): void;

  /** Replay history after a backend (re)build so context survives a
   *  live↔economy switch or a wake. */
  sendConversationHistory(turns: Array<{ role: "user" | "model"; text: string }>): void;

  /** Coordinator-controlled mic mute (echo suppression around Speaker
   *  output). Live-only; a no-op on the HTTP path. Optional so HTTP need
   *  not implement it. */
  setMicMuted?(muted: boolean): void;

  setDebugSessionContext(sessionId: string, debugMode: boolean, agentLabel?: string): void;
}
