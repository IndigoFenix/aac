// server/services/dual-agent/agent-events.ts
//
// Discriminated union of events flowing through the AgentCoordinator's bus
// in the three-agent AAC architecture (see planning-docs/aac-agent-responsibility-split.md).
//
// Two classes of events ride the bus:
//   - External events  (source: "client") — produced by the client/world
//   - Agent-emitted events — produced by Observer / Speaker / Board Manager
//     when they call their tools; the Coordinator re-casts each tool call as
//     an event and fans it out per the routing table.
//
// Raw audio/video frames are NOT bus events — they are routed directly to
// Observer's LiveProvider and never enter the typed bus.

import type { AACMuteState } from "./types";

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export type EventSource =
  | "client"
  | "observer"
  | "speaker"
  | "board-manager"
  | "monitor"
  | "coordinator";

export type AgentTarget = "observer" | "speaker" | "board-manager";

export interface BaseEvent {
  /** Monotonic milliseconds-since-epoch; preserves bus ordering across
   *  debounce windows. */
  timestamp: number;
  /** Where the event originated. Used for echo-suppression decisions and
   *  for de-duping (e.g. an agent never receives its own emitted events). */
  source: EventSource;
}

// ---------------------------------------------------------------------------
// External events (source: "client")
// ---------------------------------------------------------------------------

export interface ButtonPressedEvent extends BaseEvent {
  type: "button_pressed";
  source: "client";
  label: string;
  /** First-person SENTENCE that TTS voiced when the user pressed. */
  sentence: string;
  /** The button's visual GLYPH encoding (for context — Board Manager uses
   *  it when rebuilding so it knows what shape the user just produced). */
  glyph?: string;
}

export interface SentenceComposedEvent extends BaseEvent {
  type: "sentence_composed";
  source: "client";
  /** Ordered GLYPHs the user assembled in the sentence builder. */
  glyphs: string[];
  /** Pre-interpretation SENTENCE the builder emitted (Speaker will rewrite
   *  it through interpret() into natural language). */
  sentence: string;
}

export interface MuteToggledEvent extends BaseEvent {
  type: "mute_toggled";
  source: "client";
  state: AACMuteState;
}

export interface BuilderOpenedEvent extends BaseEvent {
  type: "builder_opened";
  source: "client";
}

export interface BuilderClosedEvent extends BaseEvent {
  type: "builder_closed";
  source: "client";
}

export interface GuessingEnteredEvent extends BaseEvent {
  type: "guessing_entered";
  source: "client";
}

export interface GuessingExitedEvent extends BaseEvent {
  type: "guessing_exited";
  source: "client";
}

export type ExternalEvent =
  | ButtonPressedEvent
  | SentenceComposedEvent
  | MuteToggledEvent
  | BuilderOpenedEvent
  | BuilderClosedEvent
  | GuessingEnteredEvent
  | GuessingExitedEvent;

// ---------------------------------------------------------------------------
// Observer-emitted events
// ---------------------------------------------------------------------------

/**
 * Whether the transcribed speech was directed at the device, at the user,
 * or was ambient/incidental. Observer labels this; Speaker uses it when
 * deciding whether to respond.
 */
export type SpeechDirection = "device" | "user" | "ambient";

export interface TranscribedEvent extends BaseEvent {
  type: "transcribed";
  source: "observer";
  text: string;
  speaker: string;
  direction: SpeechDirection;
  confidence: "high" | "medium" | "low";
}

/** Same enum as the existing update_context tool's `type` field. */
export type ContextUpdateType =
  | "new_person"
  | "new_voice"
  | "set_person_as_user"
  | "person_identified"
  | "voice_identified"
  | "person_leaves"
  | "new_location"
  | "new_object"
  | "object_leaves"
  | "person_gesture"
  | "person_indicates_object"
  | "ambient_audio_started"
  | "ambient_audio_stopped"
  | "sound_detected"
  | "other";

export interface ContextUpdateEvent extends BaseEvent {
  type: "context_update";
  source: "observer";
  /** Renamed from the tool's `type` field to avoid colliding with this
   *  union's discriminant. */
  updateType: ContextUpdateType;
  key: string;
  description: string;
  /** Optional flag Observer sets when this observation is plausibly the
   *  referent of the user's in-progress sentence-builder selection.
   *  Board Manager consults this when emitting suggestions. */
  relevance?: "builder-candidate";
}

/** Session-profile transitions. Observer is the only agent that emits these
 *  (it has the perception signal); Coordinator executes the profile switch
 *  across all three agents. */
export type EngagementState = "rest" | "wake_up" | "sleep" | "end_session";

export interface EngagementChangeEvent extends BaseEvent {
  type: "engagement_change";
  source: "observer";
  state: EngagementState;
  reason?: string;
}

export interface FocusRequestEvent extends BaseEvent {
  type: "focus_request";
  source: "observer";
  reason: string;
}

export type ObserverEvent =
  | TranscribedEvent
  | ContextUpdateEvent
  | EngagementChangeEvent
  | FocusRequestEvent;

// ---------------------------------------------------------------------------
// Speaker-emitted events
// ---------------------------------------------------------------------------

export interface SpeechStartEvent extends BaseEvent {
  type: "speech_start";
  source: "speaker";
}

export interface SpeechEndEvent extends BaseEvent {
  type: "speech_end";
  source: "speaker";
  /** Best-available transcript of what Speaker just said. Coordinator
   *  injects this into Observer as `[OWN_SPEECH]` for echo suppression
   *  AND forwards to Board Manager as the trigger for a rebuild. */
  transcript: string;
}

export interface EmoteChangeEvent extends BaseEvent {
  type: "emote_change";
  source: "speaker";
  emote: "happy" | "sad" | "neutral";
}

/** Behavioral mode within an active session. `standby` is intentionally
 *  not part of this enum — Observer's `rest` engagement state replaces it. */
export interface ModeChangeEvent extends BaseEvent {
  type: "mode_change";
  source: "speaker";
  mode: "interact" | "assist";
  reason?: string;
}

/** Speaker's call to interpret() — voicing a user-composed SENTENCE
 *  through the student TTS voice. Coordinator routes this to the student-
 *  voice TTS path and re-injects the resulting transcript into Observer
 *  (as `[OWN_SPEECH]` tagged student) and Board Manager (as a rebuild
 *  trigger for the follow-up surface). */
export interface InterpretIntentEvent extends BaseEvent {
  type: "interpret_intent";
  source: "speaker";
  sentence: string;
}

/** Speaker requested a client-side app open. Coordinator forwards the
 *  action to the client and routes a context update to Board Manager
 *  so it can produce app-relevant buttons. */
export interface AppOpenRequestedEvent extends BaseEvent {
  type: "app_open_requested";
  source: "speaker";
  appId: string;
  /** Optional search query / payload (e.g. YouTube videoId). */
  data?: string;
}

/** Speaker requested closing the active app. */
export interface AppCloseRequestedEvent extends BaseEvent {
  type: "app_close_requested";
  source: "speaker";
}

/** Speaker requested opening a permitted website. Coordinator forwards
 *  to the client + routes a context update to Board Manager so it can
 *  produce site-relevant buttons. */
export interface WebsiteOpenRequestedEvent extends BaseEvent {
  type: "website_open_requested";
  source: "speaker";
  url: string;
  label?: string;
}

export type SpeakerEvent =
  | SpeechStartEvent
  | SpeechEndEvent
  | EmoteChangeEvent
  | ModeChangeEvent
  | InterpretIntentEvent
  | AppOpenRequestedEvent
  | AppCloseRequestedEvent
  | WebsiteOpenRequestedEvent;

// ---------------------------------------------------------------------------
// Board Manager-emitted events
// ---------------------------------------------------------------------------

/**
 * One button on the board. Carries every field `parseBoardButtons` extracts
 * from the AI's pipe-encoded string — the Coordinator forwards these
 * straight into the board IR / context-sidebar payload the client expects.
 * The canonical board-button shape is in `shared/schema`; this looser
 * version exists because the parsed input goes through this typed bus
 * before getting wrapped in the IR.
 */
export interface BoardButton {
  label: string;
  /** The natural-language SENTENCE the TTS voices on press. */
  speech?: string;
  /** Alias for speech — `parseBoardButtons` exposes the speech under
   *  `sentence`. Kept here so the Coordinator can forward both. */
  sentence?: string;
  /** Resolved icon reference — emoji or font-awesome class. */
  iconRef?: string;
  /** Internal symbol-store reference (`__SYMBOL__:id` / `__FACE__:id`). */
  symbolPath?: string;
  /** Snake_case key for an AI-generated symbol awaiting generation. */
  imageKey?: string;
  /** GLYPH encoding (sentence-field equivalent in pipe-separated buttons). */
  glyph?: string;
  glyphFallback?: string;
  rowSpan?: number;
  colSpan?: number;
  buttonType?: "guess" | "category" | "suggestion";
  suggestionKey?: string;
  /** Allow forward-compatible extensions without breaking the bus. */
  [k: string]: unknown;
}

export interface BoardRebuiltEvent extends BaseEvent {
  type: "board_rebuilt";
  source: "board-manager";
  buttons: BoardButton[];
}

export interface ContextButtonAddedEvent extends BaseEvent {
  type: "context_button_added";
  source: "board-manager";
  button: BoardButton;
}

export interface BinaryChoiceShownEvent extends BaseEvent {
  type: "binary_choice_shown";
  source: "board-manager";
  option1: BoardButton;
  option2: BoardButton;
}

export interface BuilderSuggestedEvent extends BaseEvent {
  type: "builder_suggested";
  source: "board-manager";
  category: "who" | "do" | "what" | "where" | "when";
  slotIndex: number;
  headCandidates?: string[];
  modifierCandidates?: string[];
}

export interface BoardNoChangeEvent extends BaseEvent {
  type: "board_no_change";
  source: "board-manager";
  reason?: string;
}

export type BoardManagerEvent =
  | BoardRebuiltEvent
  | ContextButtonAddedEvent
  | BinaryChoiceShownEvent
  | BuilderSuggestedEvent
  | BoardNoChangeEvent;

// ---------------------------------------------------------------------------
// Cross-agent events (any agent may emit)
// ---------------------------------------------------------------------------

export interface MonitorCallRequestedEvent extends BaseEvent {
  type: "monitor_call_requested";
  source: "observer" | "speaker" | "board-manager";
  reason: string;
}

export interface PrivateNoteEvent extends BaseEvent {
  type: "private_note";
  source: "observer" | "speaker" | "board-manager";
  note: string;
}

export type CrossAgentEvent = MonitorCallRequestedEvent | PrivateNoteEvent;

// ---------------------------------------------------------------------------
// Monitor-broadcast event
// ---------------------------------------------------------------------------

/** When Monitor returns a contextInjection, Coordinator wraps it in one of
 *  these and broadcasts to all three agents. Carrying it as a typed event
 *  (rather than a raw string parameter) keeps the bus the single source of
 *  truth for "what each agent saw, in what order." */
export interface MonitorBroadcastEvent extends BaseEvent {
  type: "monitor_broadcast";
  source: "monitor";
  contextInjection: string;
}

// ---------------------------------------------------------------------------
// Top-level discriminated union
// ---------------------------------------------------------------------------

export type AgentEvent =
  | ExternalEvent
  | ObserverEvent
  | SpeakerEvent
  | BoardManagerEvent
  | CrossAgentEvent
  | MonitorBroadcastEvent;

/** Subset that only includes agent-emitted (not external) events. Useful
 *  for the dedup logic that prevents an agent from receiving events it
 *  itself produced. */
export type EmittedEvent =
  | ObserverEvent
  | SpeakerEvent
  | BoardManagerEvent
  | CrossAgentEvent
  | MonitorBroadcastEvent;

// ---------------------------------------------------------------------------
// Routing — how the Coordinator delivers an event into each agent's session
// ---------------------------------------------------------------------------

/**
 * The mechanism by which a fanned-out event reaches a target agent.
 * - `context_injection` — a system-role text turn injected into the agent's
 *   Live session via sendContextInjection / sendClientContent (turnComplete
 *   false). The agent doesn't have to act; it just sees the context.
 * - `user_turn` — a user-role text turn that the agent must process and
 *   respond to (or choose not to, in the case of Speaker).
 * - `http_call` — the Coordinator fires a fresh Board Manager HTTP
 *   completion with the event as part of the input prompt.
 * - `direct` — frames/audio routed directly to Observer's provider,
 *   bypassing the bus entirely.
 */
export type DeliveryMechanism =
  | "context_injection"
  | "user_turn"
  | "http_call"
  | "direct";

export interface RoutedDelivery {
  target: AgentTarget;
  mechanism: DeliveryMechanism;
  /** Optional override of the rendered text the agent sees. Useful when
   *  the same event needs different framing for different targets (e.g.
   *  `[OWN_SPEECH]: ...` for Observer vs. a normal transcript event
   *  for Board Manager). */
  text?: string;
}
