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
  /** Set when this press is synthetic — produced by the Coordinator from an
   *  Observer-recognized defined gesture rather than a physical tap. Routing
   *  is identical to a real press; renderers annotate the line so agents
   *  know HOW the statement was made. Source stays "client" because the
   *  press represents a real user action in the world. */
  via?: "gesture";
  /** The defined gesture's name when `via === "gesture"`. */
  gestureName?: string;
  /** The button's visual GLYPH encoding (for context — Board Manager uses
   *  it when rebuilding so it knows what shape the user just produced). */
  glyph?: string;
  /** Conversational role of the pressed button ("reply" | "bid"), resolved by
   *  the Coordinator from the current board. Drives the per-mode press handling
   *  (facilitator timers, social-trainer reply-hold). Defaults to "reply". */
  role?: "reply" | "bid";
  /** Who the press is addressed to. Inherited from the loaded board's
   *  target (set by BoardManager on rebuild_board / show_binary_choice).
   *  Defaults to "DEVICE" when no target was set. When DEVICE, the press
   *  is routed to Speaker as a user_turn; otherwise it's a context note. */
  target?: SpeechParty;
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
 * Speaker / target identifiers used by transcripts and board events.
 *  - "DEVICE" — the AI (Speaker). Observer renders this for transcripts the
 *    AI should respond to; Speaker's prompt treats DEVICE-targeted speech
 *    as "addressed to YOU".
 *  - "USER"   — the active user (the student if present, else whoever is
 *    currently most prominent at the device). The literal student name
 *    is also accepted in place of "USER" and treated as equivalent.
 *  - "UNKNOWN" — reserved for cases where neither side can plausibly be
 *    identified. Observer is told to prefer best-guess between USER and
 *    DEVICE over UNKNOWN.
 *  - Any other string — an identified third party (caregiver, sibling,
 *    teacher, etc.).
 */
export type SpeechParty = "DEVICE" | "USER" | "UNKNOWN" | string;

/** Legacy field, retained for back-compat in renderEventLine fallthroughs. */
export type SpeechDirection = "device" | "user" | "ambient";

export interface TranscribedEvent extends BaseEvent {
  type: "transcribed";
  source: "observer";
  text: string;
  speaker: SpeechParty;
  /** Who the speech is directed at — the actual identity (real name /
   *  role / "DEVICE" for the AI / "UNKNOWN"). The Observer is NO LONGER
   *  asked to overwrite the active user's name with "USER"; identity is
   *  preserved so the Speaker never confuses the user with a third party.
   *  Use `targetIsUser` for routing instead of string-matching this. */
  target: SpeechParty;
  /** Authoritative routing flag set by the Observer: the speech is
   *  directed at the active user (the person operating the AAC device).
   *  When true the Coordinator rebuilds the board so the user can reply.
   *  Undefined on older/sloppy calls — the Coordinator then falls back to
   *  name-matching `target` against the student name. */
  targetIsUser?: boolean;
  confidence: "high" | "medium" | "low";
  /** Legacy field — mirrors `target` for older renderers. Computed by the
   *  parser; do not set when constructing fresh events. */
  direction?: SpeechDirection;
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

/**
 * Observer raised a caretaker-facing alarm based on what it sees/hears.
 * Two tiers, chosen by the model via two distinct tools to keep misfires
 * down:
 *   - "alert"     — non-emergency: get a nearby caretaker's attention
 *     (user seems stuck, distressed, repeatedly asking for help).
 *   - "emergency" — serious: user appears injured, having a seizure, or
 *     doing something physically dangerous.
 * Coordinator pushes this straight to the client (it does NOT route
 * through the blind Monitor) so the device can sound/show the alarm
 * regardless of session profile.
 */
export interface AlarmRaisedEvent extends BaseEvent {
  type: "alarm_raised";
  source: "observer";
  level: "alert" | "emergency";
  reason: string;
}

/**
 * Observer matched a clinician-defined gesture (aac_settings.defined_gestures)
 * performed toward the device — emitted from its `report_gesture` tool.
 * The Coordinator resolves the name against the server-side registry and,
 * on a match, replays the button-press flow with the gesture's `meaning`
 * (student TTS + Speaker user_turn + Board Manager), exactly as if the
 * user had tapped a button voicing that sentence.
 */
export interface GestureRecognizedEvent extends BaseEvent {
  type: "gesture_recognized";
  source: "observer";
  /** The defined gesture's name as the model reported it. */
  gesture: string;
}

export type ObserverEvent =
  | TranscribedEvent
  | ContextUpdateEvent
  | EngagementChangeEvent
  | FocusRequestEvent
  | AlarmRaisedEvent
  | GestureRecognizedEvent;

// ---------------------------------------------------------------------------
// Speaker-emitted events
// ---------------------------------------------------------------------------

export interface SpeechStartEvent extends BaseEvent {
  type: "speech_start";
  source: "speaker";
  /** Whatever transcript has accumulated by the time the first audio
   *  chunk arrives. Native-audio Gemini interleaves text and audio, so
   *  this is typically only PARTIAL (the first chunk of the utterance).
   *  Consumers wanting the full transcript should listen for
   *  `speech_text_finalized` instead. */
  transcript?: string;
}

/** Fires when Gemini emits `outputTranscription.finished: true` — the
 *  text portion of the model's turn is complete (audio may still be
 *  streaming). BoardManager triggers on this so it has the FULL
 *  transcript when building follow-up buttons, but starts generating
 *  while the user is still hearing the audio. */
export interface SpeechTextFinalizedEvent extends BaseEvent {
  type: "speech_text_finalized";
  source: "speaker";
  /** The full accumulated transcript at the moment text completes. */
  transcript: string;
}

export interface SpeechEndEvent extends BaseEvent {
  type: "speech_end";
  source: "speaker";
  /** Best-available transcript of what Speaker just said. Coordinator
   *  injects this into Observer as `[OWN_SPEECH]` for echo suppression
   *  AND forwards to Board Manager as the trigger for a rebuild. */
  transcript: string;
  /** Who Speaker was addressing. Defaults to "USER" unless Speaker
   *  explicitly set a different target via its `set_speech_target` tool
   *  before this turn. BoardManager rebuilds when target=USER. */
  target?: SpeechParty;
  /** Set to the removed prefix when the SpeakerAgent stripped a leaked
   *  leading meta-tag (e.g. "[USER to YOU]") off the front of this
   *  utterance. The transcript above is already cleaned; this field only
   *  signals the Coordinator to inject a one-shot corrective reminding
   *  Speaker not to prefix its speech with bracketed tags. */
  strippedLeadingTag?: string;
}

export interface EmoteChangeEvent extends BaseEvent {
  type: "emote_change";
  source: "speaker";
  emote: "happy" | "sad" | "neutral";
}

/** Behavioral mode within an active session.
 *  - `companion` — AI is the user's conversation partner (back-and-forth chat).
 *  - `facilitator` — AI supports the user in talking to a human in the room
 *    (board does the talking; AI stays quiet unless explicitly addressed).
 *  `standby` is intentionally not part of this enum — Observer's `rest`
 *  engagement state replaces it. Source is "observer" — Observer owns mode
 *  decisions (it has the best environmental context to judge whether someone
 *  else is engaging the user); Coordinator forwards the resulting [MODE]
 *  injection to Speaker.
 *
 *  Legacy values "interact" and "assist" are mapped to "companion" and
 *  "facilitator" respectively at the parser layer for graceful migration. */
export interface ModeChangeEvent extends BaseEvent {
  type: "mode_change";
  source: "observer";
  mode: "companion" | "facilitator";
  reason?: string;
  /** Who the user is talking to in facilitator mode (peer vs helper) — biases
   *  the BoardManager palette. Omitted when the Observer can't tell. */
  register?: "peer" | "helper";
}

/** Board Manager's call to interpret() — voicing a user-composed
 *  SENTENCE through the student TTS voice. Board Manager owns this
 *  because it has the freshest context about the SUGGESTIONs the user
 *  picked during composition; moving it off Speaker also shrinks
 *  Speaker's tool surface (better function-calling reliability) and
 *  eliminates a whole class of spurious-interpret bugs on regular
 *  button presses. Coordinator routes this to the student-voice TTS
 *  path and re-injects the resulting transcript into Observer (as
 *  `[OWN_SPEECH]` tagged student) and Speaker (as the follow-up
 *  [BUTTON PRESS] for the AI's reply). */
export interface InterpretIntentEvent extends BaseEvent {
  type: "interpret_intent";
  source: "board-manager";
  sentence: string;
}

/** Speaker requested a client-side app open. Coordinator forwards the
 *  action to the client and routes a context update to Board Manager
 *  so it can produce app-relevant buttons. */
export interface AppOpenRequestedEvent extends BaseEvent {
  type: "app_open_requested";
  /** "speaker" when the AI calls open_app; "client" when the student presses an
   *  app tile and the client asks the server to open it (request_app_open). */
  source: "speaker" | "client";
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
  | SpeechTextFinalizedEvent
  | SpeechEndEvent
  | EmoteChangeEvent
  | ModeChangeEvent
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
  /** Conversational role: "reply" (answer/reaction, no response expected) vs
   *  "bid" (question/request that hands the turn over). Drives the per-mode
   *  press handling (companion/facilitator/social) + a client color indicator.
   *  Defaults to "reply" when the BoardManager omits it. */
  role?: "reply" | "bid";
  buttonType?: "guess" | "category" | "suggestion" | "narrow" | "wordfinder" | "more";
  suggestionKey?: string;
  /** For `buttonType: "narrow"` — AI-proposed narrowing dimension label. */
  narrowDimension?: string;
  /** For `buttonType: "narrow"` — the value the user is selecting. */
  narrowValue?: string;
  /** Allow forward-compatible extensions without breaking the bus. */
  [k: string]: unknown;
}

export interface BoardRebuiltEvent extends BaseEvent {
  type: "board_rebuilt";
  source: "board-manager";
  buttons: BoardButton[];
  /** Who the buttons are addressed to. Carried over into button-press
   *  events when the user picks one. Defaults to "DEVICE". */
  target?: SpeechParty;
  /** Experiment (glyphInputTranslation): a glyph-string translation of the
   *  incoming speech this board replies to, for the header glyph strip.
   *  Serialized from rebuild_board's `input_glyphs` array via serializeGlyph.
   *  Absent on follow-up rebuilds (the strip then keeps its last value). */
  inputGlyph?: { glyph: string; fallback?: string };
}

export interface ContextButtonAddedEvent extends BaseEvent {
  type: "context_button_added";
  source: "board-manager";
  button: BoardButton;
}

export interface BoardButtonAddedEvent extends BaseEvent {
  type: "board_button_added";
  source: "board-manager";
  button: BoardButton;
  /** Who this button's reply is addressed to (same semantics as
   *  BoardRebuiltEvent.target). When omitted, the Coordinator keeps the
   *  current board's target. */
  target?: SpeechParty;
}

export interface BinaryChoiceShownEvent extends BaseEvent {
  type: "binary_choice_shown";
  source: "board-manager";
  option1: BoardButton;
  option2: BoardButton;
  target?: SpeechParty;
  /** Experiment (glyphInputTranslation): a glyph-string translation of the
   *  incoming speech this choice replies to, shown above the two overlay
   *  buttons so the user sees what was just said to them. Serialized from
   *  show_binary_choice's `input_glyphs` array via serializeGlyph. Absent
   *  when the setting is off or the choice isn't a reply to incoming speech. */
  inputGlyph?: { glyph: string; fallback?: string };
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

/**
 * BoardManager asked to load a pre-built custom board by key.
 * The Coordinator looks up the board in `state.availableBoards`,
 * fetches its IR data, pushes a `set_board` WS message to the client,
 * and updates `loadedBoardId` + related state mirrors. Distinct from
 * `BoardRebuiltEvent` (which is for dynamic, AI-authored boards).
 */
export interface BoardLoadRequestedEvent extends BaseEvent {
  type: "board_load_requested";
  source: "board-manager";
  /** Normalized board key (lowercased, spaces → underscores) — matches
   *  the `key` field on entries in `state.availableBoards`. */
  boardKey: string;
}

/**
 * BoardManager declares that the Word Finder narrowing session should
 * end — the user's word has been identified, OR the conversation has
 * clearly moved past finding a word. The Coordinator handles this by
 * calling clearGuessingState and re-invoking BoardManager with a clean
 * "guessing just ended" trigger.
 */
export interface GuessingExitRequestedEvent extends BaseEvent {
  type: "guessing_exit_requested";
  source: "board-manager";
  reason: string;
}

export type BoardManagerEvent =
  | BoardRebuiltEvent
  | BoardButtonAddedEvent
  | ContextButtonAddedEvent
  | BinaryChoiceShownEvent
  | BuilderSuggestedEvent
  | BoardNoChangeEvent
  | BoardLoadRequestedEvent
  | InterpretIntentEvent
  | GuessingExitRequestedEvent;

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

/**
 * Speaker explicitly chose to stay silent this turn — terminal action.
 * Replaces "private_note as substitute for replying". Emitted purely
 * for logging / Monitor visibility; Coordinator does not fan it out.
 */
export interface RemainSilentEvent extends BaseEvent {
  type: "remain_silent";
  source: "speaker";
  reason: string;
}

/**
 * Native-audio Speaker leaked its reasoning into spoken output — its turn
 * began with the literal token "private_thought" (or the legacy "private_note",
 * or a self-invented "THOUGHT" label) instead of calling the silent tool.
 * The SpeakerAgent detects this on the streaming transcript, has the
 * Coordinator suppress the audio mid-turn, and emits this in place of
 * speech_text_finalized / speech_end so the leaked text is NOT echoed back
 * into the model's context (the self-reinforcing doom-loop) and NOT used to
 * rebuild the board. `note` is the captured reasoning with the leaked marker
 * stripped — routed to supervisor channels exactly like a real private_thought.
 */
export interface ThoughtLeakEvent extends BaseEvent {
  type: "thought_leak";
  source: "speaker";
  note: string;
}

export type CrossAgentEvent =
  | MonitorCallRequestedEvent
  | PrivateNoteEvent
  | RemainSilentEvent
  | ThoughtLeakEvent;

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
