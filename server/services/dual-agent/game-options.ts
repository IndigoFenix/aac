// ---------------------------------------------------------------------------
// Per-student "game options" for embedded world-engine games (e.g. the
// Dollhouse) + the game_press orchestration.
//
// Stored inside `aacSettings.appConfig.gameOptions` — nesting under appConfig
// deliberately avoids a DB migration and the AAC_SETTINGS_FIELDS whitelist
// (appConfig is already whitelisted; precedent: appConfig.social_trainer).
// The key "gameOptions" is not an app id, so getEnabledAppsFromConfig never
// sees it as an app entry.
//
// Two independent gates read this one source:
//  - `useAi` — how much the live AI participates while a world-engine game
//    runs. "on" = game context always reaches the Observer; "energy" = only
//    while the session's single cost signal (budget binding %) is NOT in the
//    low band (the coordinator's existing lowBandActive() predicate — no new
//    threshold system); "off" = game-sourced context never reaches the agents.
//  - `studentVoice` — whether game presses are voiced with the student's
//    cloned/server TTS voice (true) or left to cheap local speech on the
//    client (false).
//
// The game_press flow itself lives here as a pure orchestrator with injected
// dependencies (same pattern as ProcessingIndicators) so it is testable
// without the AgentCoordinator's heavy import graph. The coordinator wires
// the deps to its real pieces — see AgentCoordinator.handleGamePress.
// ---------------------------------------------------------------------------

export type GameUseAi = "on" | "energy" | "off";

export interface GameOptions {
  useAi: GameUseAi;
  studentVoice: boolean;
}

export const GAME_OPTIONS_DEFAULTS: GameOptions = Object.freeze({
  useAi: "energy",
  studentVoice: true,
});

/**
 * Resolve the per-student game options from the joined student.aacSettings
 * shape (aac_settings is a SEPARATE table joined onto the student row — read
 * this from the session's cached student, never a raw students query).
 * Unknown / missing values fall back to the defaults.
 */
export function resolveGameOptions(aacSettings: unknown): GameOptions {
  const raw = (aacSettings as { appConfig?: { gameOptions?: Partial<GameOptions> } } | null | undefined)
    ?.appConfig?.gameOptions ?? {};
  const useAi: GameUseAi =
    raw.useAi === "on" || raw.useAi === "off" || raw.useAi === "energy"
      ? raw.useAi
      : GAME_OPTIONS_DEFAULTS.useAi;
  return {
    useAi,
    studentVoice: raw.studentVoice !== false, // default true
  };
}

/** True when game-sourced PASSIVE context may reach the agents right now.
 *  "energy" defers to the coordinator's existing low-band predicate
 *  (lowBandActive — budget binding % in the "low" band). */
export function gameAiAllowed(options: GameOptions, lowBandActive: boolean): boolean {
  if (options.useAi === "off") return false;
  if (options.useAi === "energy") return !lowBandActive;
  return true;
}

/** Classify a client context_injection as game-sourced. The AAC client's
 *  GameEmbed forwards embedded-game `ai_observation` / `ai_request` bridge
 *  messages with these exact prefixes. */
export type GameContextKind = "observation" | "request";

export function classifyGameContext(text: string): GameContextKind | null {
  if (text.startsWith("[GAME OBSERVATION]")) return "observation";
  if (text.startsWith("[GAME REQUEST]")) return "request";
  return null;
}

/** Whether a game-sourced context injection should be forwarded to the
 *  Observer. Passive observations obey the full useAi gate; a [GAME REQUEST]
 *  is an ACTIVE ask from the game, so it is dropped only when "off". */
export function shouldForwardGameContext(
  kind: GameContextKind,
  options: GameOptions,
  lowBandActive: boolean,
): boolean {
  if (kind === "request") return options.useAi !== "off";
  return gameAiAllowed(options, lowBandActive);
}

// ---------------------------------------------------------------------------
// game_press orchestration
// ---------------------------------------------------------------------------

/** Client → server WS payload for a press on an ENGINE-generated game board.
 *  A game press is a REAL student utterance — it must be voiced in the
 *  student's own voice, logged, and published to the group-chat room — but it
 *  must NOT wake any agent into a model turn (the game itself executes the
 *  sentence; gameplay conserves cost). */
export interface GamePressMessage {
  type: "game_press";
  /** The spoken sentence (already localized by the engine/client). */
  text: string;
  /** The composed glyph string, informational (flow-log visibility). */
  glyph?: string;
  /** Whether the client wants server student-voice TTS. The client already
   *  consulted the studentVoice setting; when absent we fall back to the
   *  resolved setting server-side. */
  voice?: boolean;
}

export interface GamePressDeps {
  options: GameOptions;
  /** The coordinator's existing low-band predicate (budget binding % "low"). */
  lowBandActive: () => boolean;
  /** Send the {type:"utterance"} UI message (conversation header/captions). */
  sendUtterance: (text: string) => void;
  /** The SAME student-TTS chokepoint handleButtonPress uses. NOTE: it already
   *  publishes the utterance to the conversation room internally, so the
   *  orchestrator must not also call publishToRoom on the voiced path. */
  streamStudentTts: (text: string) => Promise<void>;
  /** Room publish alone — used on the NON-voiced path (client-local speech),
   *  where the TTS chokepoint (and its internal publish) is skipped. */
  publishToRoom: (text: string) => void;
  /** Persist a user-side session-log entry (already-tagged content). */
  appendUserLog: (content: string) => void;
  /** Insurance/MLU bridge (recordUtterance, source "board_press"). */
  recordUtterance: (text: string) => void;
  /** Passive Observer context note — never a turn, no turnComplete. */
  injectObserverContext: (text: string) => void;
  /** Engagement stamp (rest-timer reset). Only invoked when the AI is
   *  actually participating — a gated-off session may keep winding down. */
  noteEngagement?: () => void;
  /** Flow-log note (why something was skipped). */
  note?: (msg: string) => void;
}

/**
 * Handle a game_press end-to-end. Mirrors the relevant slices of
 * handleButtonPress (UI utterance → student TTS/room publish → session log →
 * MLU bridge) but deliberately routes NO agent turn: no Speaker, no
 * BoardManager, no board rebuild — at most a passive Observer context note,
 * gated by the useAi setting. Repeat-press protection is intentionally
 * omitted: game presses are naturally rate-limited by gameplay.
 */
export async function runGamePress(msg: GamePressMessage, deps: GamePressDeps): Promise<void> {
  const text = (msg.text ?? "").trim();
  if (!text) return;
  const voice = msg.voice ?? deps.options.studentVoice;

  // 1. Surface the utterance in the client UI (header/captions).
  deps.sendUtterance(text);

  // 2. Voice it in the student's own voice through the shared chokepoint
  //    (which also publishes to the conversation room), or — when the client
  //    keeps speech local — still publish the utterance to the room.
  if (voice) {
    try { await deps.streamStudentTts(text); } catch { /* logged inside */ }
  } else {
    deps.publishToRoom(text);
  }

  // 3. Persist as a user-side session-log entry + record for MLU/NDW.
  deps.appendUserLog(`[GAME PRESS] "${text}"`);
  deps.recordUtterance(text);

  // 4. Passive Observer context — only when useAi allows it right now.
  if (gameAiAllowed(deps.options, deps.lowBandActive())) {
    deps.noteEngagement?.();
    deps.injectObserverContext(`[GAME] The student said (via the game board): "${text}"`);
  } else {
    deps.note?.(
      `Game press context note skipped — gameOptions.useAi=${deps.options.useAi}` +
      (deps.options.useAi === "energy" ? " and the budget is in the low band" : ""),
    );
  }
}
