// server/services/dual-agent/split-observer-agent.ts
//
// Vision-split Observer: the Live (native-audio) Observer keeps everything it
// is good at — hearing, continuity, responsiveness — while every camera frame
// is handed to a stateless HTTP "vision pass" instead of entering the Live
// context.
//
// Why: Gemini Live re-bills its ENTIRE context on every turn, and image/audio
// input costs 6x text ($3.00 vs $0.50 per 1M). A 258-token frame that enters
// the Live context is paid for again on every subsequent turn of the session.
// Measured on real sessions (2026-08-27): ~20 frames sent over a 50-minute
// session cost $2.26 — ~$0.11 per frame, 45% of that session's spend. The
// HTTP Observer sends a frame in the turn it arrives and never again
// (history keeps a text placeholder), so the same frame costs ~$0.004 there.
//
// The vision pass runs the SAME Observer prompt and tools (minus the backend
// switch), so its findings arrive through the same typed events — a
// `context_update` from the vision pass is indistinguishable downstream from
// one the Live Observer would have raised, and the Coordinator already
// echoes every context update back into the Observer as a [CONTEXT] line, so
// the Live half learns what its eyes saw without a second summary channel.
//
// Routing (the whole design, in one table):
//   sendFrame            → vision only        (never sendFrameWithPrompt into Live)
//   sendUserTurn         → Live as a turn; vision as CONTEXT (aware, no generation)
//   sendContextInjection → both
//   sendAudio / clip /
//   setMicMuted          → Live only          (audio stays where the ears are)
//   history / config /
//   close                → both
//
// Built by AgentCoordinator.createObserverAgent when the Observer is on the
// Live backend AND the session may economize (full-attention OFF). The
// economy (HTTP) backend needs no split — it already handles frames
// statelessly. Kill switch: AAC_OBSERVER_VISION_SPLIT=false.

import type { IObserverAgent } from "./observer-interface";
import type { ObserverStartConfig } from "./observer-agent";

/** Prepended to the FIRST frame the vision pass sees after each start, so the
 *  role is stated inside the turn that needs it (a buffered context line could
 *  be evicted by the pending-context cap before the first frame arrives). */
export const VISION_PASS_ROLE_NOTE =
  `[VISION PASS] You are the Observer's eyes. You receive every camera frame; a sibling Observer handles hearing and gets your findings as [CONTEXT] lines. Examine each frame and record what matters via update_context / set_person_as_user / report_gesture / emergency_alarm exactly as the Observer would. Heard speech reaches you only as context — never transcribe it.`;

/** Told to the Live Observer once its session is up, so it neither waits for
 *  images that will never come nor loops on request_focus. */
export const PRIMARY_EYES_DELEGATED_NOTE =
  `[VISION] To save energy, camera images are not delivered to you directly. A vision pass examines every frame — scene updates, escalations, and your request_focus pulls — and reports what it sees as [CONTEXT] lines. Treat those lines as your own look: request_focus still works and answers the same way. Speech, [SCENE] lines, [PEOPLE PRESENT] and energy reach you unchanged.`;

export class SplitObserverAgent implements IObserverAgent {
  /** True once the Live half has been told its eyes are delegated (per start). */
  private primaryNoteSent = false;
  /** True once the vision pass has had its role stated (per start). */
  private visionRoleSent = false;

  /**
   * @param primary the Live Observer — hearing, continuity, responsiveness.
   * @param vision  the stateless HTTP Observer that receives every frame.
   * @param visionModel catalog id the vision pass runs on (the coordinator's
   *   HTTP Observer model); the start config carries the LIVE model.
   */
  constructor(
    private readonly primary: IObserverAgent,
    private readonly vision: IObserverAgent,
    private readonly visionModel: string,
  ) {}

  /** Both halves must be up: a frame analyzed while the Live half is still
   *  connecting would have its [CONTEXT] echo dropped on the floor. */
  get isConnected(): boolean {
    return this.primary.isConnected && this.vision.isConnected;
  }

  /** The vision pass shares the Observer prompt (same Gemini cache prefix)
   *  and tools, but never `set_observation_mode`: switching the Observer's
   *  backend is a judgment about the LIVE half's own cost, and a per-frame
   *  pass has no standing to make it. */
  private visionConfig(config: ObserverStartConfig): ObserverStartConfig {
    return {
      ...config,
      model: this.visionModel,
      toolConfig: { ...config.toolConfig, economyModeEnabled: false },
    };
  }

  async start(config: ObserverStartConfig): Promise<void> {
    this.primaryNoteSent = false;
    this.visionRoleSent = false;
    await Promise.all([
      this.primary.start(config),
      this.vision.start(this.visionConfig(config)),
    ]);
  }

  /** Profile transitions (awake ↔ resting) — both halves keep their history,
   *  so the role notes are NOT re-sent. */
  async reconnectWithConfig(config: ObserverStartConfig): Promise<void> {
    await Promise.all([
      this.primary.reconnectWithConfig(config),
      this.vision.reconnectWithConfig(this.visionConfig(config)),
    ]);
  }

  close(): void {
    try { this.vision.close(); } catch { /* ignore */ }
    this.primary.close();
  }

  /** The point of the class: frames go to the vision pass and nowhere else. */
  sendFrame(jpegBase64: string, scenePrompt?: string): void {
    this.tellPrimaryEyesDelegated();
    const prompt = this.visionRoleSent || !scenePrompt
      ? scenePrompt
      : `${VISION_PASS_ROLE_NOTE}\n${scenePrompt}`;
    this.visionRoleSent = true;
    this.vision.sendFrame(jpegBase64, prompt);
  }

  /** Deliver the delegation note once the Live session can actually receive
   *  it — a Live context injection before setupComplete is silently dropped,
   *  so this retries on every frame until the primary reports connected. */
  private tellPrimaryEyesDelegated(): void {
    if (this.primaryNoteSent || !this.primary.isConnected) return;
    this.primaryNoteSent = true;
    this.primary.sendContextInjection(PRIMARY_EYES_DELEGATED_NOTE);
  }

  sendAudio(audioBase64: string, mimeType?: string): void {
    this.primary.sendAudio(audioBase64, mimeType);
  }

  sendAudioClipTurn(audioBase64: string, mimeType: string, prompt: string): void {
    this.primary.sendAudioClipTurn(audioBase64, mimeType, prompt);
  }

  sendContextInjection(text: string): void {
    this.primary.sendContextInjection(text);
    this.vision.sendContextInjection(text);
  }

  /** Heard speech is the Live half's turn to react to. The vision pass only
   *  needs to KNOW it was said (so a later frame can be read in light of it),
   *  which the HTTP backend buffers for free until its next frame turn. */
  sendUserTurn(text: string): void {
    this.primary.sendUserTurn(text);
    this.vision.sendContextInjection(text);
  }

  sendConversationHistory(turns: Array<{ role: "user" | "model"; text: string }>): void {
    this.primary.sendConversationHistory(turns);
    this.vision.sendConversationHistory(turns);
  }

  setMicMuted(muted: boolean): void {
    this.primary.setMicMuted?.(muted);
  }

  setDebugSessionContext(sessionId: string, debugMode: boolean, agentLabel?: string): void {
    this.primary.setDebugSessionContext(sessionId, debugMode, agentLabel);
    // Its own flow-log label so a frame turn reads as VISION, not OBSERVER.
    this.vision.setDebugSessionContext(sessionId, debugMode, "VISION");
  }
}
