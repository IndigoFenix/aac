// server/services/dual-agent/agent-coordinator.ts
//
// AgentCoordinator — central broker for the three-agent AAC architecture.
// See planning-docs/aac-agent-responsibility-split.md.
//
// Owns:
//   - The client WebSocket (replaces LiveRelay-as-orchestrator for the new path)
//   - DualAgentSessionState (extended for multi-agent)
//   - Three agent handles (Observer, Speaker, Board Manager)
//   - The event bus: routing table, debounce policy, echo suppression
//   - Board Manager invocation serialization
//   - Monitor invocation + broadcast
//
// MVP scope (deferred to follow-up: profile transitions / cost tracking /
// symbol-generation queue / safety-block recovery / fancy reconnection).

import type { IncomingMessage } from "http";
import { WebSocketServer, type WebSocket as WSWebSocket } from "ws";
import { eq } from "drizzle-orm";

import { db } from "../../db";
import { students, type User } from "@shared/schema";
import { settingsRepository } from "../../repositories/settingsRepository";
import { dualAgentService } from "./dual-agent-service";
import { ttsFacade, type ResolvedVoice } from "../voice/tts-facade";
import { voiceRecordRepository } from "../../repositories/voiceRecordRepository";

import { ObserverAgent, type ObserverOutputEvent } from "./observer-agent";
import { SpeakerAgent, type SpeakerOutputEvent } from "./speaker-agent";
import { HttpSpeakerAgent } from "./http-speaker-agent";
import type { ISpeakerAgent } from "./speaker-interface";
import {
  BoardManagerAgent,
  type BoardManagerOutputEvent,
  type BoardManagerInvocationInput,
} from "./board-manager-agent";
import {
  buildObserverPrompt,
  buildSpeakerPrompt,
  buildBoardManagerPrompt,
  type ObserverPromptConfig,
  type SpeakerPromptConfig,
  type BoardManagerPromptConfig,
} from "./agent-prompts";
import { composeAacPersona } from "../memory-schema/aac-memory-schema";
import type { ObserverToolConfig } from "./tool-declarations-observer";
import type { SpeakerToolConfig } from "./tool-declarations-speaker";
import type { BoardManagerToolConfig } from "./tool-declarations-board-manager";
import { buildDefaultClientConfig } from "./client-config";
import { APP_REGISTRY, getEnabledAppsFromConfig } from "./app-registry";
import type { AppConfig } from "./app-registry";

import type {
  AgentEvent,
  ButtonPressedEvent,
  SentenceComposedEvent,
  MuteToggledEvent,
  BuilderOpenedEvent,
  BuilderClosedEvent,
  GuessingEnteredEvent,
  GuessingExitedEvent,
  TranscribedEvent,
  ContextUpdateEvent,
  EngagementChangeEvent,
  SpeechStartEvent,
  SpeechTextFinalizedEvent,
  SpeechEndEvent,
  InterpretIntentEvent,
  ModeChangeEvent,
  EmoteChangeEvent,
  AppOpenRequestedEvent,
  AppCloseRequestedEvent,
  WebsiteOpenRequestedEvent,
  BoardRebuiltEvent,
  BoardButtonAddedEvent,
  ContextButtonAddedEvent,
  BinaryChoiceShownEvent,
  BuilderSuggestedEvent,
  MonitorBroadcastEvent,
  FocusRequestEvent,
  AlarmRaisedEvent,
} from "./agent-events";

import type { ClientMessage, ServerMessage } from "./live-relay";
import type { AACMuteState } from "./types";
import { T } from "../memory-schema/canonical-terms";
import { authenticateUpgrade } from "../realtime/ws-auth";
import { parseBoardButtons, parseSinglePipeButton } from "./interactive-agent";
import { resolveImageKeys, queueSymbolGeneration } from "../symbol/auto-symbol-service";
import { collectGlyphImageKeys, validateBoardButtons } from "./board-button-validator";
import { expandSuggestionKey } from "./interactive-agent";
import { isValidSuggestionKey, parseSuggestionKey } from "@shared/guessing-mode/suggestion-registry";
import {
  createState as createGuessingState,
  applyPress as applyGuessingPress,
  applyCustomFact as applyGuessingCustomFact,
  rejectCurrentDimension as rejectGuessingDimension,
  expandDimension as expandGuessingDimension,
  buildStateInjection as buildGuessingInjection,
} from "@shared/guessing-mode/state";
import { seedGuessingFromConversation, parseInterestsList, computeAgeYears } from "./guessing-seeder";
import type { GuessingModeState } from "@shared/guessing-mode/types";
import { CATEGORY_DIM_ID } from "@shared/guessing-mode/dimensions";

/** Builder category → top-level guessing category. The sentence builder's
 *  active tab is what tells the engine which top-level dimension to land
 *  in when guessing is launched from the builder (instead of starting at
 *  the "what kind of thing are you looking for?" category step). */
const BUILDER_TAB_TO_GUESSING: Record<string, string> = {
  who: "people",
  do: "actions",
  what: "things",
  where: "places",
  when: "time",
};
import { logLiveSession, logDualAgent, runInSessionContext } from "./dual-agent-logger";
import {
  flowSessionStart,
  flowSystemPrompt,
  flowInput,
  flowOutput,
  flowNote,
} from "./agent-flow-logger";
import { buildDefaultHomeBoard, HOME_BOARD_KEY } from "./default-home-board";
import { smartMergeButtons, type MergeButton } from "./board-merge";
import { isDeviceTarget, isUserTarget, PARTY_DEVICE, PARTY_USER } from "./speech-party";

// ---------------------------------------------------------------------------
// Defaults — Board Manager is hardcoded to a fast model for the MVP. Move
// to a per-agent settings row in a follow-up.
// ---------------------------------------------------------------------------

const BOARD_MANAGER_DEFAULT_PROVIDER = "gemini" as const;
const BOARD_MANAGER_DEFAULT_MODEL = "gemini-2.5-flash";

// ---------------------------------------------------------------------------
// Home-board navigation intents — behavior hints attached to each home
// button. The button press itself flows through the standard SENTENCE
// BUTTON pipeline (TTS-voiced label, button_pressed event, target=DEVICE).
// These hints are injected as ADDITIONAL context so each agent has the
// right framing when the press lands.
//
// Keyed by the tag prefix that appears at the start of the home button's
// `instruction` string in default-home-board.ts (e.g. "INTERACT" for
// `[INTERACT] ...`).
//
// Each entry describes:
//   - setMode:         programmatic mode set on press (or undefined when
//                      the button doesn't change the mode)
//   - topic:           short identifier used in logs
//   - speakerInteract: behavioral hint for Speaker when in interact mode
//                      ("Greet warmly", "Ask gently", etc.). Delivered as
//                      `[HINT] ...` context BEFORE the press.
//   - speakerAssist:   same, for assist mode. null = no hint (Speaker
//                      stays quiet by default).
//   - board:           topic-palette directive for BoardManager. Delivered
//                      as a synthetic context_update on recent_events.
// ---------------------------------------------------------------------------
interface HomeIntent {
  setMode?: "companion" | "facilitator";
  topic: string;
  /** Speaker hint when the session is in `companion` mode. */
  speakerCompanion: string;
  /** Speaker hint when the session is in `facilitator` mode. */
  speakerFacilitator: string | null;
  board: string;
  /** When true, skip the student-voice TTS for this press AND skip
   *  delivering it to Speaker as a user_turn. The button is a mode /
   *  navigation signal, not something the user is "saying" — there's
   *  nothing to voice and nothing for Speaker to reply to. Coordinator
   *  still applies the mode change, fires speaker/board hints, and
   *  triggers BoardManager. */
  silent?: boolean;
}
const HOME_INTENTS: Record<string, HomeIntent> = {
  INTERACT: {
    setMode: "companion",
    topic: "open conversation",
    speakerCompanion: "The user just opened the conversation with you. Greet them warmly and invite them to talk.",
    speakerFacilitator: "The user just opened the conversation with you. Greet them warmly and invite them to talk.",
    board: "Topic palette: open-conversation starters — general topics the user might pick from (their interests, their day, their feelings, things they might want to ask you).",
  },
  ASSIST: {
    setMode: "facilitator",
    topic: "talking to someone else",
    speakerCompanion: "The user is now talking to someone else, not you. Stay quiet.",
    speakerFacilitator: "The user is talking to someone else. Stay quiet.",
    silent: true,
    board: "Topic palette: conversation starters and replies for the user to say to a person in their environment. Mix GENERIC openers (greetings, 'how are you?', 'I want to tell you something', 'what's up?', 'can I ask you a question?') with CONTEXT-SPECIFIC starters derived from <recent_events> (people present, objects observed, ongoing activities, recent transcripts). Lead with the context-specific ones when there's clear context to build on — they're more useful than generic phrases. The user is initiating a conversation with someone real in the room; pick buttons that help them OPEN that exchange.",
  },
  "MY DAY": {
    topic: "my day",
    speakerCompanion: "The user wants to talk about their day. Ask an open question about what happened today.",
    speakerFacilitator: null,
    board: "Topic palette: today's activities — morning routine, school, lunch, afternoon, evening, plus 'something good happened', 'something hard happened', 'nothing special'.",
  },
  INTERESTS: {
    topic: "interests",
    speakerCompanion: "The user wants to talk about their interests. Mention one you remember and ask them about it.",
    speakerFacilitator: null,
    board: "Topic palette: the user's known interests / hobbies / favorite topics from memory. If memory is thin, offer broad categories the user can pick from.",
  },
  FEELINGS: {
    topic: "feelings",
    speakerCompanion: "The user wants to talk about how they feel. Ask them gently.",
    speakerFacilitator: null,
    board: "Topic palette: emotions — happy, sad, tired, excited, angry, scared, bored, frustrated, calm. Include 'I want to talk about something else'.",
  },
  HELP: {
    topic: "help",
    speakerCompanion: "The user pressed Help. Ask what they need.",
    speakerFacilitator: "The user pressed Help while in facilitator mode. Briefly say to the person nearby: they need something.",
    board: "Topic palette: common needs — I need help, I'm hurt, I need the bathroom, I'm hungry, I'm thirsty, I'm cold, I'm hot, please call someone.",
  },
};

const DEBOUNCE_CONTEXT_UPDATE_MS = 400;
const DEBOUNCE_MONITOR_CALL_MS = 30_000;
const RECENT_EVENTS_WINDOW = 20;
/** How many conversational events accumulate before a rolling session
 *  summary refresh is triggered. Mirrors LiveRelay's threshold. */
const SUMMARY_EVERY_N_MESSAGES = 20;

// Compression-window thresholds per profile. These are the main cost
// lever for long quiet sessions: Live bills the FULL running context on
// every turn, and non-text input (audio + image frames at $3/M tokens)
// dominates that cost. Tighter resting thresholds keep Observer's context
// at ~6–12k during quiet stretches instead of ~15–30k, ~2.5× cheaper per
// turn. Speaker is closed entirely in resting (saves the whole second
// session), so its thresholds only apply when awake.
const AWAKE_COMPRESSION_TRIGGER = 30_000;
const AWAKE_COMPRESSION_TARGET = 15_000;
const RESTING_COMPRESSION_TRIGGER = 12_000;
const RESTING_COMPRESSION_TARGET = 6_000;

/** How often to batch buffered Speaker PCM chunks into a single WAV
 *  and send to the client. Mirrors LiveRelay.AUDIO_FLUSH_INTERVAL_MS. */
const AUDIO_FLUSH_INTERVAL_MS = 250;

/** Convert a raw 16-bit-LE mono PCM buffer to a WAV buffer by prepending
 *  a 44-byte header. Mirrors LiveRelay.pcmToWav so the new path produces
 *  the same `avatar_audio` payload shape the client already decodes. */
function pcmToWav(pcm: Buffer, sampleRate = 24000): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);              // fmt chunk size
  header.writeUInt16LE(1, 20);               // PCM format
  header.writeUInt16LE(1, 22);               // mono
  header.writeUInt32LE(sampleRate, 24);      // sample rate
  header.writeUInt32LE(sampleRate * 2, 28);  // byte rate (16-bit mono)
  header.writeUInt16LE(2, 32);               // block align
  header.writeUInt16LE(16, 34);              // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Inspect a single glyph for the canonical `yes` / `no` SYMBOL token.
 * Mirrors the client's `detectYesNoDefaultColor` so the server can decide
 * binary-choice escape semantics without round-tripping to the renderer.
 * Splits on the same set of glyph delimiters (`+ . # ( )`).
 */
function detectYesNoColor(glyph: string | undefined): "green" | "red" | undefined {
  if (!glyph) return undefined;
  const tokens = glyph.split(/[+.#()]/).map((t) => t.trim()).filter(Boolean);
  let hasYes = false;
  let hasNo = false;
  for (const t of tokens) {
    if (t === "yes") hasYes = true;
    else if (t === "no") hasNo = true;
  }
  if (hasYes && hasNo) return undefined;
  if (hasYes) return "green";
  if (hasNo) return "red";
  return undefined;
}

/**
 * Decide which escape button to render alongside a binary-choice overlay.
 * Yes/no pair (one option yes-tagged, one no-tagged) → `"maybe"` (yellow);
 * anything else → `"neither"` (red, no-symbol).
 *
 * Server-side decision so the client can ship a generic 3-button renderer
 * without baking the yes/no detection rule into its display layer.
 */
function detectBinaryChoiceEscapeKind(
  glyph1: string | undefined,
  glyph2: string | undefined,
): "maybe" | "neither" {
  const c1 = detectYesNoColor(glyph1);
  const c2 = detectYesNoColor(glyph2);
  const colors = [c1, c2];
  if (colors.includes("green") && colors.includes("red")) return "maybe";
  return "neither";
}

/**
 * Render a brief, log-friendly summary of an incoming client WS message.
 * Used only for flow-log visibility — pulls out the salient field(s) from
 * each message type so a one-line entry tells the operator what the press
 * carried. Falls back to "(no payload)" for types with no useful detail.
 */
function clientMsgSummary(msg: ClientMessage): string {
  switch (msg.type) {
    case "button_press": {
      const labels = msg.buttons?.join(", ") ?? "";
      const first = msg.buttons?.[0] ?? "";
      const sentence = (msg.sentences && first && msg.sentences[first] !== first)
        ? ` → "${msg.sentences[first]}"` : "";
      return `buttons=[${labels}]${sentence}`;
    }
    case "board_exit":
      return `label="${msg.label}" instruction="${(msg.instruction || "").slice(0, 80)}${(msg.instruction || "").length > 80 ? "…" : ""}"`;
    case "glyph_press":
      return `glyph="${msg.glyph}"`;
    case "guessing_state":
      return `(legacy) keys=[${msg.suggestionKeys?.join(", ") ?? ""}] custom=${msg.customFacts?.length ?? 0} rejected=${msg.rejectedFacts?.length ?? 0}${msg.origin ? ` origin=${msg.origin}` : ""}`;
    case "guessing_enter":
      return msg.builderContext
        ? `from=builder category=${msg.builderContext.category} slot=${msg.builderContext.targetSlot ?? "?"}`
        : "from=conversation";
    case "guessing_press":
      return `key=${msg.suggestionKey}`;
    case "guessing_reject":
      return "(no payload)";
    case "guessing_narrow":
      return `${msg.dimension}=${msg.value}${msg.sourceText ? ` ("${msg.sourceText}")` : ""}`;
    case "exit_guessing":
      return `reason="${msg.reason || ""}"`;
    case "construction_state":
      return `category=${(msg.data as any)?.category ?? "?"} partial="${(msg.data as any)?.partial ?? ""}"`;
    case "set_mute_state":
      return `mute=${msg.muteState}`;
    case "set_paused":
      return `paused=${msg.paused}`;
    case "user_message":
      return `text="${msg.text.slice(0, 80)}${msg.text.length > 80 ? "…" : ""}"`;
    case "context_injection":
      return `text="${msg.text.slice(0, 80)}${msg.text.length > 80 ? "…" : ""}"`;
    case "initialize":
      return `student=${msg.studentId}${msg.sessionId ? ` session=${msg.sessionId}` : ""}`;
    default:
      return "(no payload)";
  }
}

/**
 * Wrap a list of board buttons into the full board IR the client expects
 * — grid + single "Main" page + per-button row/col/action/style. Mirrors
 * LiveRelay.buildBoardFromButtons so the new path's `set_board`/`board`
 * messages have the same shape the AAC client already knows how to render.
 */
function buildBoardFromButtons(
  buttons: Array<{
    label: string;
    sentence?: string;
    speech?: string;
    iconRef?: string;
    symbolPath?: string;
    imageKey?: string;
    glyph?: string;
    glyphFallback?: string;
    rowSpan?: number;
    colSpan?: number;
    buttonType?: "guess" | "category" | "suggestion" | "narrow" | "wordfinder" | "more";
    suggestionKey?: string;
    narrowDimension?: string;
    narrowValue?: string;
  }>,
): unknown {
  const pageId = `page-${Date.now()}`;
  const cols = 4;
  const rows = Math.max(2, Math.ceil(buttons.length / cols));
  return {
    grid: { rows, cols },
    pages: [{
      id: pageId,
      name: "Main",
      buttons: buttons.map((b, i) => ({
        id: `btn-${Date.now()}-${i}`,
        label: b.label,
        spokenText: b.label,
        ...(b.sentence ? { sentence: b.sentence } : {}),
        ...(b.buttonType ? { buttonType: b.buttonType } : {}),
        ...(b.suggestionKey ? { suggestionKey: b.suggestionKey } : {}),
        ...(b.narrowDimension ? { narrowDimension: b.narrowDimension } : {}),
        ...(b.narrowValue ? { narrowValue: b.narrowValue } : {}),
        ...(b.rowSpan && b.rowSpan > 1 ? { rowSpan: b.rowSpan } : {}),
        ...(b.colSpan && b.colSpan > 1 ? { colSpan: b.colSpan } : {}),
        row: Math.floor(i / cols),
        col: i % cols,
        action: { type: "speak" as const, text: b.sentence ?? b.speech ?? b.label },
        style: {},
        iconRef: b.iconRef || "fas fa-comment",
        symbolPath: b.symbolPath,
        ...(b.glyph ? { glyph: b.glyph } : {}),
        ...(b.glyphFallback ? { glyphFallback: b.glyphFallback } : {}),
      })),
    }],
    currentPageId: pageId,
  };
}

// ---------------------------------------------------------------------------
// Builder / guessing state mirrors — what Board Manager needs to know about
// the user's in-progress composition.
// ---------------------------------------------------------------------------

interface BuilderState {
  category: "who" | "do" | "what" | "where" | "when";
  modeChip?: string;
  partialSentence: string;
  targetSlot: number;
  excludeKeys: string[];
  currentBoard?: string[];
  payloadTarget?: { slotIndex: number; host: string };
}

interface GuessingNarrowingFact {
  dimension: string;
  value: string;
  sourceText?: string;
  addedAt: number;
}

interface GuessingState {
  dimension: string;
  offeredKeys: string[];
  questionHint: string;
  /** AI-proposed narrowing steps the user has confirmed (parallel track to registry). */
  customFacts: GuessingNarrowingFact[];
  /** Facts (registry or custom) the user explicitly rejected — must not be re-proposed. */
  rejectedFacts: GuessingNarrowingFact[];
}

// ---------------------------------------------------------------------------
// AgentCoordinator
// ---------------------------------------------------------------------------

type CoordinatorState = "initializing" | "ready" | "closing" | "closed";

export class AgentCoordinator {
  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------
  private state: CoordinatorState = "initializing";
  private readonly ws: WSWebSocket;
  private readonly authedUser: User;

  // Session identity
  private sessionId: string | null = null;
  private studentId: string | null = null;
  private userId: string | undefined;
  private classroomId: string | null = null;

  // -------------------------------------------------------------------------
  // Agent handles
  // -------------------------------------------------------------------------
  private observer: ObserverAgent | null = null;
  private speaker: ISpeakerAgent | null = null;
  private boardManager: BoardManagerAgent | null = null;
  /** Selected Speaker implementation. Driven by AAC_SPEAKER_MODE env var
   *  (default "http"). HTTP uses Gemini chat completion + streaming TTS;
   *  "live" uses the legacy Gemini Live path with native audio / speak()
   *  tool depending on model. Cached once per session. */
  private speakerMode: "http" | "live" = "http";

  // Per-agent runtime config (rebuilt on transitions; cached here so
  // re-routing decisions don't need to walk back to settings).
  private observerModel = "";
  private speakerModel = "";
  private useVertex = false;
  /** Cached provider key from settingsRepository — needed by createSpeakerAgent
   *  to bind onUsage outside of the original start() closure. */
  private aacChatProvider: string = "gemini";
  private useDirectAudio = true;
  private aiVoiceName: string | undefined;
  private debugMode = false;
  /** Current session profile — drives the tool set + compression on the
   *  two Live agents. Toggled by Observer's rest()/wake_up() events. */
  private sessionProfile: "awake" | "resting" = "awake";

  /** Deferred-rest mechanism. Observer's `rest()` is a REQUEST, not an
   *  immediate command — we only honor it when the user has been
   *  conversation-inactive for REST_DEBOUNCE_MS. A button press,
   *  composed sentence, USER-or-DEVICE-targeted transcript, or
   *  Speaker utterance is "conversation activity" and resets the
   *  timer + clears any pending rest. */
  private static readonly REST_DEBOUNCE_MS = 60_000;
  private lastEngagementActivityAt = Date.now();
  private pendingRestTimer: ReturnType<typeof setTimeout> | null = null;

  // Voice routing (fallback Speaker + student-interpret paths)
  private aiVoice: ResolvedVoice | null = null;
  private studentVoice: ResolvedVoice | null = null;

  // -------------------------------------------------------------------------
  // Per-session state mirrors
  // -------------------------------------------------------------------------
  private muteState: AACMuteState = "unmuted";
  /** Client-side pause (e.g. user tab backgrounded). When true, we don't
   *  forward frames/audio to Observer. */
  private paused = false;

  /** Coordinator-owned interaction mode. Speaker emits the change via
   *  set_interaction_mode, but the source of truth lives here so it
   *  survives profile transitions (awake ↔ resting reconnect both Live
   *  agents with fresh prompts; without persistence the mode would
   *  default to whatever the new prompt's defaults imply). Re-broadcast
   *  to all three agents at the end of every wake transition. */
  private currentInteractionMode: "companion" | "facilitator" = "companion";

  /** Cached AI name from this session's settings, used for DEVICE
   *  identity matching in transcripts. */
  private aiName: string | undefined;
  /** Cached active-student first-name; treated as a synonym for USER in
   *  transcript speaker/target comparisons. */
  private currentStudentName: string | undefined;

  /** Default target the BoardManager's next rebuild applies to its
   *  buttons. Updated by routeBoardRebuilt (carries through to
   *  ButtonPressedEvent.target on the next press). */
  private currentBoardTarget: string = "DEVICE";

  /** Counters for periodic flow-confirmation logging. */
  private frameCount = 0;
  private pcmCount = 0;

  // Echo suppression is prompt-side only — Observer's <transcription>
  // section tells it to ignore device-speaker playback (button-press TTS
  // + Speaker's own voice), and we inject [OWN_SPEECH] / [BUTTON PRESS]
  // context so it knows which audio to disregard. No hard mic mute; the
  // single-agent system relied on the same prompt-side mechanism and it
  // worked reliably.

  /** Buffer for Speaker native-audio chunks. Raw PCM (base64) — flushed
   *  as a single WAV every 250ms (or on SpeechEnd). Mirrors the legacy
   *  LiveRelay's directAudioChunks/flushDirectAudio pattern. */
  private speakerAudioChunks: string[] = [];
  private speakerAudioFlushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Cancellation handle for the in-flight student-voice TTS stream.
   *  A new press / interpret aborts the previous and tells the client
   *  to clear any queued utterance audio so the SENTENCE plays once. */
  private studentTtsAbortController: AbortController | null = null;

  /** Type of the most recent user input. interpret() is only valid
   *  immediately after a sentence_composed turn; the tool description
   *  says so but native audio doesn't always honor it. We gate
   *  interpret_intent server-side so a stray call on a button press
   *  doesn't fire a second student-TTS for the same SENTENCE. Reset
   *  to "none" once consumed (after interpret runs) so a duplicate
   *  interpret on the same composed turn is also blocked. */
  private lastUserInputType: "button_pressed" | "sentence_composed" | "transcribed" | "none" = "none";

  // Debouncing
  private contextUpdateBuffer: ContextUpdateEvent[] = [];
  private contextUpdateDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Monitor de-dup
  private pendingMonitorCalls: Array<{ reason: string; source: string }> = [];
  private monitorCallDedupTimer: ReturnType<typeof setTimeout> | null = null;

  // Board Manager invocation serialization (no two HTTP calls in flight
  // per session — chained instead).
  private boardMgrInFlight = false;
  private boardMgrPendingTriggers: AgentEvent[] = [];
  /** Single-shot flag set by handleGuessingPress / handleGuessingNarrow /
   *  handleGuessingReject and consumed by the very next button_pressed
   *  event. A guessing-intent button press fires TWO server events —
   *  the button_press (TTS + Speaker user_turn) and the guessing_*
   *  intent (engine update → narrowing directive to Speaker). Speaker
   *  responds to both unless one is suppressed. The flag tells the
   *  button_pressed routing to send the press as a CONTEXT injection
   *  only; the narrowing directive carries the turn. Cleared on first
   *  consume so a subsequent non-narrowing press isn't accidentally
   *  silenced.
   *
   *  We can't infer "is this a narrowing press?" from button data alone
   *  because suggestion buttons render with the registry's English
   *  labelEn server-side but arrive with the localized Hebrew label
   *  from the client — a label-match lookup misses every time. */
  private suppressNextPressUserTurn = false;
  /** AbortController for the currently in-flight BoardMgr invocation.
   *  When a newer Speaker speech arrives mid-flight the in-flight result
   *  is stale by definition — abort the LLM call, skip applying any
   *  events that do come back, and let the queued invocation run with
   *  the fresh context. The Gemini SDK cancels client-side only (server
   *  still bills) but we stop blocking on a useless wait. */
  private boardMgrAbortController: AbortController | null = null;
  /**
   * Deferred press-triggered BoardManager invocation. When the user presses
   * a button addressed to DEVICE, Speaker will reply within ~2s and
   * speech_text_finalized supersedes the press for the board rebuild —
   * running FOLLOW-UPS first and REPLIES second wastes ~4s of latency
   * AND doubles MALFORMED exposure. We defer the press invocation and let
   * speech_text_finalized cancel it. If Speaker doesn't reply (mute mode,
   * MALFORMED, etc.) within DEFERRED_BM_PRESS_MS, the timer fires and BM
   * builds FOLLOW-UPS as a fallback so the user isn't stranded.
   */
  private deferredBoardMgrTrigger: AgentEvent | null = null;
  private deferredBoardMgrTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly DEFERRED_BM_PRESS_MS = 4_000;

  /** Validator-error feedback to fold into the NEXT BoardManager
   *  invocation's prompt. When set, the next invoke uses this as a
   *  retry context so the model can correct the rejected buttons.
   *  Cleared after delivery; bounded by `boardMgrRetryAttempt` so a
   *  pathological input can't loop forever. */
  private boardMgrPendingFeedback: string | null = null;
  private boardMgrRetryAttempt = 0;
  private static readonly BOARD_MGR_MAX_RETRIES = 1;

  // Recent events window — feeds BoardMgr invocations for continuity.
  private recentEvents: AgentEvent[] = [];

  // State mirrors (so each BoardMgr invocation has a snapshot)
  private currentBoardLabels: string[] = [];
  /**
   * Full button objects of the current MAIN board. Tracked alongside
   * `currentBoardLabels` so `add_board_button` can run `smartMergeButtons`
   * against the real button shapes (not just labels) — preserves slot
   * positions for the client's animation and matches incoming buttons
   * against existing ones by glyph/sentence overlap, not just label.
   */
  private currentBoardButtons: MergeButton[] = [];
  /** Max buttons on the main board. Mirrors maxBoardItems on the
   *  BoardManager tool config; kept here so add_board_button merge has
   *  a single source of truth. */
  private static readonly MAIN_BOARD_MAX = 8;
  private contextSidebarLabels: string[] = [];
  private loadedBoardId: string | null = null;
  private builderState: BuilderState | null = null;
  private guessingState: GuessingState | null = null;
  /**
   * Authoritative Word Finder engine state (from `shared/guessing-mode/`).
   * Owns the dimensions / weights / history / facts that drive narrowing.
   * The flat `guessingState` field above is a DERIVED snapshot recomputed
   * from this whenever the engine state changes (so all the downstream
   * readers — Speaker directive, BoardManager invocation, etc. — keep
   * their existing shape).
   *
   * Moved server-side 2026-06: previously the client owned the engine
   * and shipped a rendered injection per turn, which meant any logic
   * tweak required a client rebuild + redeploy. With the engine here,
   * intent messages (`guessing_enter` / `guessing_press` /
   * `guessing_reject` / `guessing_narrow`) drive all mutations.
   */
  private guessingEngineState: GuessingModeState | null = null;
  /** Where the current Word Finder session was launched from. Used so a
   *  builder-origin resolution can feed the concept back into the active
   *  slot when guessing ends. */
  private guessingOrigin: "conversation" | "builder" = "conversation";
  private guessingBuilderContext: { targetSlot: number | null; partialGlyph: string; category: string } | null = null;

  // Cached prompts + tool configs — reused by profile transitions so we
  // don't have to walk back through buildPromptInputs on every switch.
  private observerPrompt = "";
  private speakerPrompt = "";
  /** Full composed BoardManager prompt — debug/logging only. The live prompt is
   *  assembled per-invocation by composeBoardManagerPrompt from the parts below. */
  private boardManagerPrompt = "";
  /** Stable prefix+tail (always sent). */
  private boardManagerPromptBase = "";
  /** Appended only while the sentence builder is active. */
  private boardManagerBuilderBlock = "";
  /** Appended only while the Word Finder is active. */
  private boardManagerGuessingBlock = "";
  private observerToolConfigBase: ObserverToolConfig = {};
  private speakerToolConfigBase: Omit<SpeakerToolConfig, "restingMode"> = {
    useDirectAudio: true,
    isMutedMode: false,
    enabledApps: [],
  };
  private boardManagerToolConfig: BoardManagerToolConfig = {
    availableBoards: [],
    hasLoadedBoard: false,
  };

  // Symbol-generation settings (mirrors live-relay's pattern). Drives
  // whether unresolved generate:KEY symbols get queued for background
  // generation and which resolved (approved/unapproved) symbols the
  // renderer should prefer.
  private symbolSettings = {
    generateSymbols: false,
    useApprovedSymbols: false,
    useUnapprovedSymbols: false,
  };

  // Rolling session summary state. `conversationLog` is the canonical
  // record of conversational turns this session (user presses, transcripts
  // we replied to, our own utterances). It feeds Monitor's summarizer
  // every SUMMARY_EVERY_N_MESSAGES new entries. The resulting summary is
  // both injected as a [SESSION SUMMARY] context message AND folded into
  // the per-agent prompts on the next profile-switch reconnect.
  private conversationLog: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];
  private summarizedMsgCount = 0;
  private summaryInFlight = false;
  private currentSessionSummary: string | undefined;

  /**
   * @param ws            the live WebSocket
   * @param authedUser    authenticated user (from upgrade-time auth)
   * @param initialMessage optional `initialize` message already received by
   *                       a prior handler (e.g. LiveRelay handed off after
   *                       reading the student's three-agent flag). When
   *                       provided, processed after listener binding.
   */
  constructor(ws: WSWebSocket, authedUser: User, initialMessage?: ClientMessage) {
    this.ws = ws;
    this.authedUser = authedUser;
    this.userId = authedUser.id;

    ws.on("message", (raw) => this.handleRawMessage(raw));
    ws.on("close", (code, reason) => this.cleanup(`ws closed code=${code} reason=${reason?.toString() || ""}`));
    ws.on("error", (err) => {
      console.error("[AgentCoordinator] WS error:", err);
      this.cleanup("ws error");
    });

    if (initialMessage) {
      // Re-deliver via the normal client-message dispatch path so we don't
      // duplicate handleInitialize logic. Errors propagate via sendError.
      this.handleClientMessage(initialMessage).catch(err => {
        console.error("[AgentCoordinator] initial message processing failed:", err);
        this.sendError(`init failed: ${(err as Error).message}`);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Public lifecycle
  // -------------------------------------------------------------------------

  cleanup(reason?: string): void {
    if (this.state === "closed") return;
    console.log(`[AgentCoordinator] cleanup: ${reason || "(no reason)"}`);
    this.state = "closing";

    // Clear timers
    if (this.contextUpdateDebounceTimer) clearTimeout(this.contextUpdateDebounceTimer);
    if (this.monitorCallDedupTimer) clearTimeout(this.monitorCallDedupTimer);
    if (this.speakerAudioFlushTimer) clearTimeout(this.speakerAudioFlushTimer);
    if (this.pendingRestTimer) { clearTimeout(this.pendingRestTimer); this.pendingRestTimer = null; }
    if (this.deferredBoardMgrTimer) { clearTimeout(this.deferredBoardMgrTimer); this.deferredBoardMgrTimer = null; this.deferredBoardMgrTrigger = null; }
    // Cancel any in-flight student TTS so the synthesizeStream loop
    // exits promptly instead of pushing chunks at a dead WebSocket.
    if (this.studentTtsAbortController) {
      this.studentTtsAbortController.abort();
      this.studentTtsAbortController = null;
    }

    // Final Monitor flush — push a [SESSION_CLOSED] directive into
    // pendingMessages and force-trigger Monitor so it summarizes the
    // session and consolidates Student_Notes before we lose the
    // conversation. Fire-and-forget; the Monitor pipeline reads from
    // the DB so it doesn't depend on the Live agents staying open.
    // Mirrors legacy LiveRelay.handleSessionClose.
    this.runFinalMonitorPass().catch(err => {
      console.error("[AgentCoordinator] Final monitor pass failed:", err);
    });

    // Close agents
    try { this.observer?.close(); } catch {}
    try { this.speaker?.close(); } catch {}
    this.observer = null;
    this.speaker = null;
    this.boardManager = null;

    // Close WS if still open
    try {
      if (this.ws.readyState === this.ws.OPEN) this.ws.close();
    } catch {}

    this.state = "closed";
  }

  /**
   * On session close: queue a final directive and force-fire Monitor so
   * the session ends with a clean summary + deduped Student_Notes.
   * Mirrors legacy LiveRelay.handleSessionClose.
   *
   * Skipped when the session's privacy options disable notes — we don't
   * write any persistent observations in that mode.
   */
  private async runFinalMonitorPass(): Promise<void> {
    if (!this.sessionId) return;
    const cache = dualAgentService.getSessionCache(this.sessionId);
    if (cache?.state?.privacyOptions?.allowNotes === false) {
      flowNote("MONITOR", "Final pass skipped — allowNotes=false");
      return;
    }

    flowNote("MONITOR", "Session closed — queueing final directive and forcing Monitor.");
    await dualAgentService.addPendingMessage(this.sessionId, {
      role: "user",
      content: `[SESSION_CLOSED] The AAC session has ended. Perform these final tasks:
1. Summarize the session — note anything significant that happened.
2. Clean up Student_Notes: view the notes, then delete duplicate or redundant entries and consolidate related information where possible. The goal is a concise, non-repetitive set of notes.`,
      timestamp: Date.now(),
    });
    await dualAgentService.triggerMonitor(this.sessionId, /* force */ true);

    // Populate the generic session summary/title/importance used by
    // deep-analysis search. Runs after the Monitor pass so any final
    // Student_Notes updates are already persisted.
    const sessionId = this.sessionId;
    import("../sessionSummary").then(({ generateSessionSummaryAsync }) => {
      generateSessionSummaryAsync(sessionId);
    }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Raw WS message ingest
  // -------------------------------------------------------------------------

  private handleRawMessage(raw: unknown): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch (err) {
      console.warn("[AgentCoordinator] malformed WS message:", (err as Error).message);
      return;
    }
    // Wrap the message handler in a session-scoped context so every
    // flow-logger call (and any nested async work) gets its session_debug_logs
    // row attributed to this session. AsyncLocalStorage propagates through
    // awaits + EventEmitter listeners registered inside, so events from the
    // Observer/Speaker that arrive later inherit the context too.
    this.withSessionContext(() => {
      this.handleClientMessage(msg).catch(err => {
        console.error("[AgentCoordinator] handleClientMessage error:", err);
        this.sendError(`internal error: ${(err as Error).message}`);
      });
    });
  }

  /**
   * Run `fn` inside a session-scoped AsyncLocalStorage context, so the
   * shared flow-logger / live-session-logger know which session their
   * entries belong to. Sessions before initialize() ran (no sessionId
   * yet) bind with "?" so logs still get attributed somewhere stable.
   */
  private withSessionContext<T>(fn: () => T): T {
    return runInSessionContext(this.sessionId || "?", this.debugMode, fn);
  }

  private async handleClientMessage(msg: ClientMessage): Promise<void> {
    // High-signal client-message visibility — every non-streaming press /
    // navigation / state event gets surfaced in the flow log so "did the
    // press even reach the server?" can be answered by reading the log.
    // Excludes the high-volume streaming types (frame_grid, pcm_audio) —
    // those have their own periodic sampling counters below.
    if (msg.type !== "frame_grid" && msg.type !== "pcm_audio") {
      const summary = clientMsgSummary(msg);
      flowInput("CLIENT", msg.type, summary);
    }

    switch (msg.type) {
      case "initialize":
        await this.handleInitialize(msg);
        return;
      case "frame_grid":
        if (this.paused) return;
        this.observer?.sendFrame(msg.data);
        this.frameCount += 1;
        // Periodic log so we can confirm frames are flowing.
        if (this.frameCount === 1 || this.frameCount % 50 === 0) {
          runInSessionContext(this.sessionId || "?", this.debugMode, () => {
            logLiveSession("CLIENT → frame_grid", `count=${this.frameCount} observerConnected=${this.observer?.isConnected ?? false}`);
          });
        }
        return;
      case "pcm_audio":
        if (this.paused) return;
        this.observer?.sendAudio(msg.data, "audio/pcm;rate=16000");
        this.pcmCount += 1;
        if (this.pcmCount === 1 || this.pcmCount % 500 === 0) {
          runInSessionContext(this.sessionId || "?", this.debugMode, () => {
            logLiveSession("CLIENT → pcm_audio", `count=${this.pcmCount}`);
          });
        }
        return;
      case "focus_frame":
        // High-resolution single frame requested by Observer via
        // request_focus. The prompt mirrors legacy's wording.
        this.observer?.sendFrame(
          msg.data,
          "[FOCUS FRAME] This is a HIGH-RESOLUTION single frame captured at your request. Analyze it carefully for fine details, text, labels, faces, or objects you couldn't identify before. Record what you see via update_context.",
        );
        return;
      case "set_paused":
        this.paused = msg.paused;
        runInSessionContext(this.sessionId || "?", this.debugMode, () => {
          logLiveSession("CLIENT → set_paused", `paused=${msg.paused}`);
        });
        return;
      case "audio_clip":
      case "voice_audio":
        // Legacy non-PCM paths — ignore in live mode.
        return;
      case "button_press":
        await this.handleButtonPress(msg);
        return;
      case "board_exit":
        this.handleBoardExit(msg);
        return;
      case "glyph_press":
        // The client sends `glyph_press` when the user presses Play in
        // the sentence builder — the glyph IS the composed sentence,
        // ready for BoardManager to interpret() into natural language.
        // This must emit a `sentence_composed` event (not button_pressed):
        // the interpret-intent gate in routeInterpretIntent requires
        // lastUserInputType === "sentence_composed", and a button_pressed
        // event would cause every interpret() call from BoardManager to
        // be rejected as "spurious."
        //
        // Split the glyph string on '+' to recover the individual GLYPHs;
        // the field is informational (sentence is the canonical payload).
        this.emitClientEvent({
          type: "sentence_composed",
          source: "client",
          timestamp: Date.now(),
          glyphs: msg.glyph.split("+").map(s => s.trim()).filter(Boolean),
          sentence: msg.glyph,
        });
        return;
      case "construction_state":
        this.handleConstructionState(msg.data);
        return;
      case "guessing_state":
        // LEGACY client-owned-state path. Older client builds still send
        // this; new clients use the intent messages below. The legacy
        // path is preserved temporarily — once all clients have shipped
        // with the intent protocol it can be removed entirely. For now,
        // map it into the engine by overwriting the snapshot only (no
        // engine-state hydration — the legacy state is opaque to us).
        flowNote("COORDINATOR", "Received legacy guessing_state — treating snapshot as authoritative; new client builds should send intents instead.");
        this.handleLegacyGuessingState(msg);
        return;
      case "guessing_enter":
        this.handleGuessingEnter(msg);
        return;
      case "guessing_press":
        this.handleGuessingPress(msg);
        return;
      case "guessing_reject":
        this.handleGuessingReject();
        return;
      case "guessing_narrow":
        this.handleGuessingNarrow(msg);
        return;
      case "exit_guessing":
        // Single client-initiated exit path for the Word Finder. Replaces
        // the older [EXIT GUESSING]-tagged board_exit kludge (which also
        // emitted a spurious "Back" button_pressed event downstream).
        this.clearGuessingState(`client_exit:${msg.reason || "user_request"}`);
        return;
      case "builder_open":
        this.builderState = null; // cleared until first construction_state arrives
        this.emitClientEvent({
          type: "builder_opened",
          source: "client",
          timestamp: Date.now(),
        });
        return;
      case "builder_close":
        this.builderState = null;
        // Closing the builder also ends any in-progress word finder.
        this.clearGuessingState("builder_close");
        this.emitClientEvent({
          type: "builder_closed",
          source: "client",
          timestamp: Date.now(),
        });
        return;
      case "set_mute_state":
        this.handleMuteToggled(msg.muteState);
        return;
      case "user_message":
        // Treat as a transcribed user statement directed at the device.
        this.speaker?.sendUserTurn(`[TRANSCRIPT] user → device: "${msg.text}"`);
        return;
      default:
        // Many client message types (focus_frame, page_navigate, etc.) are
        // handled by the legacy path but aren't part of the MVP routing
        // here. Silently ignore so we don't crash on protocol-superset
        // messages.
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  private async handleInitialize(msg: Extract<ClientMessage, { type: "initialize" }>): Promise<void> {
    if (this.state !== "initializing") {
      this.sendError("already initialized");
      return;
    }

    // 1. Load / create session via the shared service. This populates the
    //    in-memory SessionCache the dual-agent-service already manages and
    //    gives us the per-agent prompts already built (the service can
    //    branch on useThreeAgentSystem in Task #9 and populate observerPrompt
    //    / speakerPrompt / boardManagerPrompt directly).
    const state = await dualAgentService.initializeSession(
      msg.studentId,
      this.authedUser.id,
      msg.sessionId,
      msg.muteState ?? "unmuted",
      undefined,
      msg.timezone,
      msg.classroomId,
    );
    this.sessionId = state.sessionId;
    this.studentId = state.studentId;
    this.userId = state.userId;
    this.classroomId = state.classroomId ?? null;
    this.muteState = state.muteState;
    this.debugMode = !!msg.debugMode;

    // Wire context-injection broadcast: when Monitor produces context,
    // route through our broadcast helper so all three agents see it.
    state.onContextInjection = (text) => this.broadcastMonitorContext(text);

    // Tear-down hook: dualAgentService uses this to terminate sessions
    // mid-flight (e.g. consent revoked).
    state.onTerminate = (reason) => this.cleanup(`onTerminate: ${reason}`);

    // 2. Resolve voices (used by fallback Speaker path and student-interpret path).
    await this.resolveVoices();

    // 3. Determine models. Default both Observer and Speaker to the
    //    `aac_chat` Live model; Board Manager uses the hardcoded fast model.
    //    Per-agent env-var overrides let us experiment with different Live
    //    variants without touching settings — e.g. point Observer at a
    //    half-cascade Live model with stronger function-calling reliability
    //    if the GA native-audio model keeps malforming its tool calls.
    const aacChat = await settingsRepository.getLLMConfig("aac_chat");
    this.observerModel = process.env.AAC_OBSERVER_MODEL || aacChat.model;
    this.speakerModel = process.env.AAC_SPEAKER_MODEL || aacChat.model;
    this.useVertex = aacChat.provider === "gemini";
    this.aacChatProvider = aacChat.provider;
    // HTTP path needs a text-completion-capable model — the configured
    // `aac_chat` model is typically a Live variant (native-audio) which
    // 404s on generateContent. Default to the same text model the Board
    // Manager uses; override via AAC_SPEAKER_HTTP_MODEL when tuning.
    const httpSpeakerModel = process.env.AAC_SPEAKER_HTTP_MODEL || BOARD_MANAGER_DEFAULT_MODEL;
    // Speaker backend selection — env-driven. Default "http" for the
    // cheap/reliable HTTP completion + streaming TTS path; "live" keeps
    // the legacy Gemini Live behavior (native audio when the model
    // supports it; speak() tool otherwise). Any other value falls back
    // to http with a warning.
    const speakerModeRaw = (process.env.AAC_SPEAKER_MODE || "http").toLowerCase();
    if (speakerModeRaw !== "http" && speakerModeRaw !== "live") {
      console.warn(`[AgentCoordinator] Unknown AAC_SPEAKER_MODE="${speakerModeRaw}" — defaulting to "http"`);
    }
    this.speakerMode = speakerModeRaw === "live" ? "live" : "http";
    // Swap the Speaker model when we're on the HTTP path — the configured
    // aac_chat model is a Live variant that generateContent will 404 on.
    if (this.speakerMode === "http") {
      this.speakerModel = httpSpeakerModel;
    }
    // useDirectAudio drives runtime audio-chunk routing for the Live
    // path (native-audio model emits PCM via onAudioChunk). In HTTP mode
    // there is no live audio stream — text → server TTS → avatar_audio.
    this.useDirectAudio = this.speakerMode === "live"
      && (this.speakerModel.includes("native-audio") || this.speakerModel.includes("live"));
    this.aiVoiceName = this.aiVoice?.geminiVoiceName;
    if (this.observerModel !== aacChat.model || this.speakerModel !== aacChat.model) {
      console.log(`[AgentCoordinator] Per-agent model override: observer=${this.observerModel} speaker=${this.speakerModel}`);
    }

    // 4. Build the three prompts.
    const promptInputs = await this.buildPromptInputs();
    const observerPrompt = buildObserverPrompt(promptInputs.observer);
    const speakerPrompt = buildSpeakerPrompt(promptInputs.speaker);
    const boardManagerParts = buildBoardManagerPrompt(promptInputs.boardManager);
    // The mode blocks (builder / guessing) are appended per-invocation only when
    // that mode is active — see composeBoardManagerPrompt. Store the parts;
    // `boardManagerPrompt` keeps the full composed string for debug/logging.
    this.boardManagerPromptBase = boardManagerParts.base;
    this.boardManagerBuilderBlock = boardManagerParts.builderBlock;
    this.boardManagerGuessingBlock = boardManagerParts.guessingBlock;
    const boardManagerPrompt = `${boardManagerParts.base}\n\n${boardManagerParts.builderBlock}\n\n${boardManagerParts.guessingBlock}`;

    state.observerPrompt = observerPrompt;
    state.speakerPrompt = speakerPrompt;
    state.boardManagerPrompt = boardManagerPrompt;
    this.observerPrompt = observerPrompt;
    this.speakerPrompt = speakerPrompt;
    this.boardManagerPrompt = boardManagerPrompt;

    // Cache symbol settings so the post-rebuild generation pass can apply
    // the right policy (generate? prefer approved/unapproved?).
    const sessionCache = dualAgentService.getSessionCache(this.sessionId!);
    const studentRowAac = sessionCache?.monitorAgent.getStudent?.()?.aacSettings;
    this.symbolSettings = {
      generateSymbols: !!studentRowAac?.generateSymbols,
      useApprovedSymbols: !!studentRowAac?.useApprovedSymbols,
      useUnapprovedSymbols: !!studentRowAac?.useUnapprovedSymbols,
    };

    // 5. Build tool configs. Cache the bases so profile transitions can
    //    re-derive them with restingMode flipped.
    const observerToolConfig: ObserverToolConfig = {};
    this.observerToolConfigBase = observerToolConfig;
    // Speaker's tool config wants full AACAppDefinition objects (with
    // icon / enabledByDefault). The prompt config only carries the
    // narrowed name/description/id shape, so we walk back to the registry
    // to populate the full ones.
    const enabledAppIds = (promptInputs.speaker.enabledApps ?? []).map(a => a.id);
    const speakerToolConfigBase = {
      useDirectAudio: this.useDirectAudio,
      isMutedMode: this.muteState === "muted",
      enabledApps: APP_REGISTRY.filter(a => enabledAppIds.includes(a.id)),
      availableCustomApps: promptInputs.speaker.availableCustomApps,
      permittedWebsites: promptInputs.speaker.permittedWebsites,
    };
    this.speakerToolConfigBase = speakerToolConfigBase;
    const speakerToolConfig: SpeakerToolConfig = { ...speakerToolConfigBase };
    const bmToolConfig: BoardManagerToolConfig = {
      availableBoards: (promptInputs.boardManager.availableBoards ?? []).map(b => ({ key: b.key, name: b.name })),
      hasLoadedBoard: !!promptInputs.boardManager.loadedBoardName,
      loadedBoardName: promptInputs.boardManager.loadedBoardName ?? null,
      maxBoardItems: 12,
      language: promptInputs.boardManager.language,
      singleGlyphButtons: promptInputs.boardManager.singleGlyphButtons,
    };
    this.boardManagerToolConfig = bmToolConfig;

    // 6. Construct agent handles.
    this.observer = new ObserverAgent("gemini", {
      onEvent: (e) => this.onObserverEvent(e),
      onError: (err) => console.error("[AgentCoordinator] Observer error:", err),
      onClose: () => console.log("[AgentCoordinator] Observer closed"),
      onUsage: (usage) => this.trackLiveUsage("observer", aacChat.provider, this.observerModel, usage),
    });
    this.speaker = this.createSpeakerAgent();
    this.boardManager = new BoardManagerAgent(BOARD_MANAGER_DEFAULT_PROVIDER);

    // 7. Connect Observer + Speaker in parallel. If either fails, tear down.
    try {
      await Promise.all([
        this.observer.start({
          systemPrompt: observerPrompt,
          model: this.observerModel,
          toolConfig: observerToolConfig,
          useVertex: this.useVertex,
          // Match the single-agent's provider config — same voice, same
          // compression thresholds. Observer doesn't emit audio to the
          // client (no audio sink), but the native-audio model expects
          // a voice configured in AUDIO modality.
          voiceName: this.aiVoiceName,
          compressionTriggerTokens: AWAKE_COMPRESSION_TRIGGER,
          compressionTargetTokens: AWAKE_COMPRESSION_TARGET,
        }),
        this.speaker.start({
          systemPrompt: speakerPrompt,
          model: this.speakerModel,
          toolConfig: speakerToolConfig,
          useVertex: this.useVertex,
          voiceName: this.aiVoiceName,
          useDirectAudio: this.useDirectAudio,
          compressionTriggerTokens: AWAKE_COMPRESSION_TRIGGER,
          compressionTargetTokens: AWAKE_COMPRESSION_TARGET,
        }),
      ]);
    } catch (err) {
      console.error("[AgentCoordinator] agent connect failed:", err);
      this.sendError(`agent connect failed: ${(err as Error).message}`);
      this.cleanup("agent connect failed");
      return;
    }

    // 7a. Bind debug logging context on the Live agents so provider-side
    //     events (RAW_MSG, SERVER → toolCall, etc.) get attributed to
    //     this session_debug_logs row.
    this.observer.setDebugSessionContext(this.sessionId, this.debugMode);
    this.speaker.setDebugSessionContext(this.sessionId, this.debugMode);

    // 7c. Prime Speaker with the initial interaction mode. Without this,
    //     Speaker has no signal about which mode it's in until Observer
    //     fires set_interaction_mode mid-session — and the
    //     transitionToProfile re-broadcast only fires on wake, not at
    //     fresh start. Default mode is `companion`; the injection here
    //     keeps Speaker aligned from turn one.
    flowNote("COORDINATOR", `Initial mode = ${this.currentInteractionMode}`);
    const initialModeRendered = `[MODE] ${this.currentInteractionMode} (session start)`;
    this.speaker.sendContextInjection(initialModeRendered);
    this.observer.sendContextInjection(initialModeRendered);

    // 7d. Reset the rest debounce window now that the session is actually
    //     ready. The class-field initializer set lastEngagementActivityAt
    //     at Coordinator construction time, which can be several seconds
    //     before agents finish connecting — so Observer's very first
    //     rest() call after coming online sees a depleted window and the
    //     session drops to resting almost immediately. Reset here so the
    //     user gets a fresh full 60s before the first rest is considered.
    this.noteEngagementActivity();

    // 7b. Log session start. Wrap in runInSessionContext so the
    //     SESSION START / SYSTEM PROMPT / TOOL DECLARATIONS entries get
    //     DB-attributed when debugMode is on.
    runInSessionContext(this.sessionId, this.debugMode, () => {
      logLiveSession("SESSION START", [
        `Path: three-agent (AgentCoordinator)`,
        `Session: ${this.sessionId}`,
        `Student: ${this.studentId}`,
        `Observer: ${aacChat.provider}/${this.observerModel}`,
        `Speaker:  ${aacChat.provider}/${this.speakerModel}`,
        `BoardMgr: ${BOARD_MANAGER_DEFAULT_PROVIDER}/${BOARD_MANAGER_DEFAULT_MODEL}`,
        `Mute: ${this.muteState}`,
        `DirectAudio: ${this.useDirectAudio}`,
      ].join("\n"));
      logLiveSession("OBSERVER PROMPT", observerPrompt);
      logLiveSession("SPEAKER PROMPT", speakerPrompt);
      logLiveSession("BOARD MANAGER PROMPT", boardManagerPrompt);
    });

    // High-signal flow log (separate from the verbose live-session log).
    const studentRow = sessionCache?.monitorAgent.getStudent?.();
    flowSessionStart(this.sessionId, {
      studentName: studentRow?.firstName || studentRow?.name?.split(" ")[0],
      observerModel: this.observerModel,
      speakerModel: this.speakerModel,
      boardMgrModel: BOARD_MANAGER_DEFAULT_MODEL,
      useDirectAudio: this.useDirectAudio,
    });
    flowSystemPrompt("OBSERVER", observerPrompt);
    flowSystemPrompt("SPEAKER", speakerPrompt);
    flowSystemPrompt("BOARD_MGR", boardManagerPrompt);

    // 8. Announce ready to client.
    this.state = "ready";
    this.send({
      type: "initialized",
      sessionId: this.sessionId,
      // Ship the tunable client-side constants (activity monitor cadence,
      // sleep thresholds, gesture window) from the server so they can
      // change without a client rebuild. Future: read per-student
      // overrides from settings and merge here.
      clientConfig: buildDefaultClientConfig(),
    });

    // 9. Push the default home board so the client has a surface to render
    //    before Board Manager produces anything. The legacy path does the
    //    same — without it, the user sees a blank screen until conversation
    //    starts. The home board is virtual (not in the DB); its native
    //    buttons emit board_exit messages that the AI handles as
    //    conversation kick-offs.
    const student = sessionCache?.monitorAgent.getStudent?.();
    const studentLang = student?.primaryLanguage || "en";
    const homeBoard = buildDefaultHomeBoard(studentLang);
    this.loadedBoardId = "__home__";
    const homePage = (homeBoard as any).pages?.[0];
    if (homePage?.buttons) {
      const nativeButtons = homePage.buttons.filter((b: any) => typeof b?.label === "string");
      this.currentBoardLabels = nativeButtons.map((b: any) => b.label);
      this.currentBoardButtons = nativeButtons.map((b: any) => ({ ...b } as MergeButton));
    }
    this.send({
      type: "set_board",
      data: { board: homeBoard, name: (homeBoard as any).name || "Home", boardId: "__home__" },
    });
    runInSessionContext(this.sessionId, this.debugMode, () => {
      logLiveSession("HOME_BOARD_PUSHED", `lang=${studentLang} buttons=[${this.currentBoardLabels.join(", ")}]`);
    });

    // 10. Make sure the home board is in availableBoards so Board Manager
    //     can call set_board("home") to return to it.
    if (state.availableBoards && !state.availableBoards.some(b => b.key === HOME_BOARD_KEY)) {
      state.availableBoards.unshift({ key: HOME_BOARD_KEY, name: "Home", id: "__home__" } as any);
    }
  }

  // -------------------------------------------------------------------------
  // Voice resolution (mirrors dualAgentService.resolveVoices)
  // -------------------------------------------------------------------------

  private async resolveVoices(): Promise<void> {
    if (!this.studentId) return;
    const [studentRow] = await db.select().from(students).where(eq(students.id, this.studentId)).limit(1);
    if (!studentRow) return;
    const aac = (studentRow as any).aacSettings;
    const gender = (studentRow as any).gender as string | undefined;
    const elEnabled = aac?.elevenlabsEnabled !== false;

    const [aiCustom, studentCustom] = await Promise.all([
      aac?.customVoiceId ? voiceRecordRepository.getVoiceById(aac.customVoiceId) : Promise.resolve(undefined),
      aac?.customStudentVoiceId ? voiceRecordRepository.getVoiceById(aac.customStudentVoiceId) : Promise.resolve(undefined),
    ]);

    const studentFallback = gender === "female" ? "girl" : "boy";
    const defaultStudentGeminiVoice = gender === "female" ? "Leda" : "Puck";
    const defaultAiGeminiVoice = "Zephyr";

    this.aiVoice = {
      fallbackType: "woman",
      customVoice: aiCustom || null,
      language: (studentRow as any).primaryLanguage || "en",
      elevenlabsApiKey: elEnabled ? (aac?.elevenlabsApiKey || undefined) : undefined,
      elevenlabsVoiceId: elEnabled ? (aac?.elevenlabsAiVoiceId || undefined) : undefined,
      geminiVoiceName: aac?.geminiAiVoice || defaultAiGeminiVoice,
    };
    this.studentVoice = {
      fallbackType: studentFallback as any,
      customVoice: studentCustom || null,
      language: (studentRow as any).primaryLanguage || "en",
      elevenlabsApiKey: elEnabled ? (aac?.elevenlabsApiKey || undefined) : undefined,
      elevenlabsVoiceId: elEnabled ? (aac?.elevenlabsStudentVoiceId || undefined) : undefined,
      geminiVoiceName: aac?.geminiStudentVoice || defaultStudentGeminiVoice,
    };
  }

  // -------------------------------------------------------------------------
  // Prompt input assembly
  // -------------------------------------------------------------------------

  private async buildPromptInputs(): Promise<{
    observer: ObserverPromptConfig;
    speaker: SpeakerPromptConfig;
    boardManager: BoardManagerPromptConfig;
  }> {
    const cache = dualAgentService.getSessionCache(this.sessionId!);
    if (!cache) throw new Error("session cache missing during prompt build");
    const state = cache.state;
    const monitorAgent = cache.monitorAgent;
    const student = monitorAgent.getStudent?.();
    const studentName = student?.firstName || student?.name?.split(" ")[0] || "the user";
    const language = student?.primaryLanguage || undefined;
    const sections = state.enhancedSections;
    const aiName = student?.aacSettings?.aiName || undefined;

    // Cache for downstream speech-party comparisons (routeTranscribed, etc.)
    this.currentStudentName = studentName;
    this.aiName = aiName;

    const base = {
      studentName,
      language,
      studentAge: undefined as string | undefined,
      studentGender: (student as any)?.gender,
      studentDiagnosis: state.cachedDiagnosis || undefined,
      aiName,
      knownContacts: state.cachedContacts,
      classroom: undefined as any, // classroom plumbing wired in a follow-up
      gestureOverrides: sections?.gestureOverrides,
      safetyNotes: sections?.safetyNotes,
    };

    return {
      observer: {
        ...base,
        observerInstructions: sections?.observerInstructions,
        alarmConditions: sections?.alarmConditions,
        perceptionMemory: state.memoryContext,
      },
      speaker: {
        ...base,
        persona: sections?.persona || composeAacPersona({ custom: student?.aacSettings?.chatAgentPrompt, auto: student?.aacSettings?.autoAacPrompt }),
        memoryContext: state.memoryContext,
        muteState: state.muteState,
        // In HTTP mode the assistant text content IS the spoken reply —
        // there is no speak() tool. Mirror that to the prompt builder via
        // the same useDirectAudio flag the native-audio path uses so the
        // model doesn't get instructed to call a tool that isn't there.
        useDirectAudio: this.useDirectAudio || this.speakerMode === "http",
        sessionGoals: sections?.sessionGoals,
        // Three-agent path uses speech-only examples; DON'T fall back to
        // the legacy interactModeExamples (those contain rebuild_board
        // calls Speaker doesn't have). When the enhancer hasn't been
        // re-run, buildSpeakerPrompt falls back to the static
        // speaker.interact_dialogue / speaker.assist_dialogue examples.
        interactModeExamples: sections?.speakerInteractExamples,
        assistModeExamples: sections?.speakerAssistExamples,
        // sentenceInterpretationExamples moved to Board Manager along
        // with the interpret() tool — Speaker no longer needs it.
        sessionSummary: state.sessionSummary,
        availableBoards: state.availableBoards?.map(b => ({ key: b.key, name: b.name, hint: b.hint })),
      },
      boardManager: {
        ...base,
        memoryContext: state.memoryContext,
        muteState: state.muteState,
        cachedSymbols: state.cachedSymbols,
        availableBoards: state.availableBoards,
        loadedBoardName: state.loadedBoardData?.name ?? null,
        autoSymbolsEnabled: !!(student?.aacSettings?.generateSymbols),
        singleGlyphButtons: !!student?.aacSettings?.singleGlyphButtons,
        boardManagerGuidance: sections?.boardManagerGuidance,
        sentenceInterpretationExamples: sections?.sentenceInterpretationExamples,
        boardManagerExamples: sections?.boardManagerExamples,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Client → bus
  // -------------------------------------------------------------------------

  private async handleButtonPress(msg: Extract<ClientMessage, { type: "button_press" }>): Promise<void> {
    const label = msg.buttons[0] || "";
    const sentence = msg.sentences?.[label] || label;

    // 0. Stamp engagement activity IMMEDIATELY on arrival. The press is
    //    real user activity the moment it lands on the server. Without
    //    this, a pending rest timer can fire during the ~2-3s TTS
    //    streaming await below — the press is honored later, but the
    //    session has already dropped to resting in the meantime,
    //    triggering a needless wake cycle (and possible MALFORMED on
    //    the freshly-rebuilt Speaker). emitClientEvent later in this
    //    handler also calls noteEngagementActivity, but that's gated
    //    behind the await; we need the timer cancellation NOW.
    this.noteEngagementActivity();

    // 0a. "More" button — the user wants more options on the current
    //     board, NOT to say "[MORE]" aloud or to trigger a conversational
    //     beat. Skip TTS, skip Speaker user_turn, and just kick
    //     BoardManager with a "give me more options" hint. The hint
    //     rides in on recentEvents as a synthetic context_update so
    //     BoardManager's next invocation sees the intent.
    if (label === "[MORE]") {
      // In Word Finder, "More" pages the CURRENT question's long tail (rarer
      // answers to the same question) via the engine — it does NOT ask
      // BoardManager for free-form alternatives. The engine owns the narrowing
      // surface while guessing is active.
      if (this.guessingEngineState) {
        void this.wakeForGuessingIntent("guessing_more", () => {
          if (!this.guessingEngineState) return;
          expandGuessingDimension(this.guessingEngineState);
          this.refreshGuessingSnapshot(false);
        });
        flowNote("COORDINATOR", "[MORE] pressed in Word Finder — paging current dimension's long tail.");
        return;
      }
      if (this.sessionProfile === "resting") {
        flowNote("COORDINATOR", "[MORE] arrived while resting — waking before invoking BoardManager.");
        await this.transitionToProfile("awake");
      }
      const moreHint: ContextUpdateEvent = {
        type: "context_update",
        source: "observer",
        timestamp: Date.now(),
        updateType: "other",
        key: "more_options_requested",
        description: "The user pressed More — they couldn't find the right button on the current board. Call add_board_button or rebuild_board with FRESH alternative options (different angles on the same topic, related but not previously offered). Do NOT speak; this is a board-only request.",
      };
      this.recordEvent(moreHint);
      // Tell Speaker silently so it knows the press happened but does
      // not respond — this is not a conversational turn.
      this.speaker?.sendContextInjection(`[MORE] The user pressed More — they want more button options. Do NOT speak; let BoardManager refresh the surface.`);
      flowNote("COORDINATOR", `[MORE] pressed — BoardManager invoked, no TTS, no Speaker user_turn.`);
      void this.invokeBoardManager([moreHint]);
      return;
    }

    // 1. Surface the utterance to the client UI immediately (clears
    //    previous text). noAudioClear=false matches the legacy contract.
    //    NOTE: this message is for UI display only — it carries text,
    //    not audio. If the client TTSes this text locally in addition
    //    to playing the streamed utterance_audio, we'd hear the SENTENCE
    //    twice. The flow log below makes the send visible so the source
    //    of any doubling is traceable.
    if (sentence) {
      flowOutput("COORDINATOR", "ws_send_utterance", sentence);
      this.send({ type: "utterance", text: sentence, confidence: "high", noAudioClear: false });
    }

    // 2. Stream the student-voice TTS AND WAIT for it to finish before
    //    delivering the press to Speaker. Without the await, the AI's
    //    response audio sometimes lands before the student voice has
    //    finished playing on the client — the press feels skipped.
    //    The await covers server-side stream completion; the client
    //    plays the audio out a beat later, but at this point the audio
    //    chunks have arrived in order ahead of Speaker's reply.
    if (sentence) {
      try { await this.streamStudentTts(sentence, "button_press"); } catch { /* logged inside */ }
    }

    // 3. Route the event so Observer / Speaker / Board Manager all see it.
    this.emitClientEvent({
      type: "button_pressed",
      source: "client",
      timestamp: Date.now(),
      label,
      sentence,
    });
  }

  /**
   * The user pressed an exit button on a loaded custom board (e.g. one of
   * the home-board navigation buttons — "Interact", "Assist", "Build
   * sentence"). The board carries an instruction string that's directed at
   * the AI (e.g. "[INTERACT] The user wants to talk to you. Rebuild the
   * board with conversation starters..."). We route it the same shape as a
   * button press: Observer context, Speaker user turn, Board Manager HTTP.
   *
   * Special-case the Home press — load the home board directly without an
   * AI roundtrip so the user always gets back to the menu instantly.
   */
  private handleBoardExit(msg: Extract<ClientMessage, { type: "board_exit" }>): void {
    // Hoist the wake-gate: ANY board-exit press while resting wakes the
    // session before downstream routing. The downstream paths
    // (routeHomeTopicPress, emitClientEvent) each have their own wake
    // checks, but they only fire on specific event shapes — a press
    // that takes the "reload home" fast-path below or the fallback
    // generic-press path would otherwise miss the wake. Doing it here
    // covers every menu-button press uniformly.
    if (this.sessionProfile === "resting") {
      flowNote("COORDINATOR", `Board exit "${msg.label}" arrived while resting; waking before routing.`);
      void this.transitionToProfile("awake").then(() => this.handleBoardExitInner(msg));
      return;
    }
    this.handleBoardExitInner(msg);
  }

  private handleBoardExitInner(msg: Extract<ClientMessage, { type: "board_exit" }>): void {
    // Client signals an explicit word-finder cancel via an EXIT GUESSING
    // tag on the instruction. Clear server-side guessingState before
    // routing, so BoardManager's next invocation doesn't keep producing
    // suggestion-keyed buttons.
    if (msg.instruction?.includes("[EXIT GUESSING]")) {
      this.clearGuessingState("board_exit_tag");
    }

    const isHomePress = msg.label === "Home" ||
      (msg.instruction && /set_board\(["']home["']\)|load.*home board/i.test(msg.instruction));

    if (isHomePress) {
      // Reload the home board directly. Notify the AI via context only.
      const cache = dualAgentService.getSessionCache(this.sessionId!);
      const studentLang = cache?.monitorAgent.getStudent?.()?.primaryLanguage || "en";
      const homeBoard = buildDefaultHomeBoard(studentLang);
      this.loadedBoardId = "__home__";
      const homePage = (homeBoard as any).pages?.[0];
      if (homePage?.buttons) {
        const nativeButtons = homePage.buttons.filter((b: any) => typeof b?.label === "string");
        this.currentBoardLabels = nativeButtons.map((b: any) => b.label);
        this.currentBoardButtons = nativeButtons.map((b: any) => ({ ...b } as MergeButton));
      }
      this.send({
        type: "set_board",
        data: { board: homeBoard, name: (homeBoard as any).name || "Home", boardId: "__home__" },
      });
      const homeContext = `[CONTEXT] The user pressed Home. The home ${T.board} is loaded with its native navigation ${T.button}s. Wait for them to press one before changing the board.`;
      this.observer?.sendContextInjection(homeContext);
      this.speaker?.sendContextInjection(homeContext);
      return;
    }

    // Home-board navigation presses carry a tag prefix on their
    // instruction (`[INTERACT] ...`, `[FEELINGS] ...`, etc.). Each tag
    // maps to a HOME_INTENTS entry: an optional mode-set + per-agent
    // behavior hints. The press itself is routed exactly like any other
    // SENTENCE BUTTON tap (TTS-voiced label + button_pressed event); the
    // hints are injected as ADDITIONAL context so each agent has the
    // right framing when the press lands.
    const tagMatch = (msg.instruction ?? "").match(/^\[([A-Z ]+)\]/);
    const tag = tagMatch?.[1]?.trim();
    if (tag && this.routeHomeTopicPress(tag, msg.label)) return;

    // Fallback: any other exit-button press (custom boards, etc.) goes
    // through the normal button-press flow with the raw instruction.
    this.emitClientEvent({
      type: "button_pressed",
      source: "client",
      timestamp: Date.now(),
      label: msg.label,
      sentence: msg.instruction || msg.label,
    });
  }

  /**
   * Home-board navigation press: same downstream flow as a regular
   * SENTENCE BUTTON tap (TTS-voice the label, then emit a button_pressed
   * event), plus the HOME_INTENTS entry's behavior hints fed to Speaker
   * and BoardManager as context. Returns true on a recognized tag.
   */
  private routeHomeTopicPress(tag: string, label: string): boolean {
    const intent = HOME_INTENTS[tag];
    if (!intent) return false;

    // Wake the session before any per-agent routing — same reason as
    // the gate in emitClientEvent. Otherwise the press lands on resting
    // Speaker and gets swallowed.
    if (this.sessionProfile === "resting") {
      flowNote("COORDINATOR", `Home press ${tag} arrived while resting; waking before routing.`);
      void this.transitionToProfile("awake").then(() => this.routeHomeTopicPressInner(intent, label));
      return true;
    }
    void this.routeHomeTopicPressInner(intent, label);
    return true;
  }

  private async routeHomeTopicPressInner(intent: HomeIntent, label: string): Promise<void> {
    // Mode set: programmatically switch BEFORE routing so downstream
    // hints see the new mode. We bypass Speaker's set_interaction_mode
    // tool — this came from the user, not the AI.
    if (intent.setMode && this.currentInteractionMode !== intent.setMode) {
      this.routeModeChange({
        type: "mode_change",
        source: "observer",
        timestamp: Date.now(),
        mode: intent.setMode,
        reason: "User pressed home-board navigation.",
      });
    }
    const effectiveMode = intent.setMode ?? this.currentInteractionMode;

    // Inject behavior hints BEFORE the press lands so each agent has the
    // framing when they process the button_pressed event. Speaker gets a
    // behavioral hint; BoardManager gets a topic-palette directive that
    // rides in via a context_update entry on the recent-events trail.
    const speakerHint = effectiveMode === "companion"
      ? intent.speakerCompanion
      : intent.speakerFacilitator;
    if (speakerHint) {
      this.speaker?.sendContextInjection(`[HINT] ${speakerHint}`);
    }
    const boardHint: ContextUpdateEvent = {
      type: "context_update",
      source: "observer",
      timestamp: Date.now(),
      updateType: "other",
      key: "topic_palette",
      description: intent.board,
    };
    this.recordEvent(boardHint);

    if (intent.silent) {
      // Silent home press — the button is a navigation/mode signal, not
      // a user utterance. Skip the student-voice TTS and the
      // [BUTTON PRESS to YOU] route to Speaker entirely. The mode change,
      // speaker hint, and board hint above are the whole effect; trigger
      // BoardManager directly so the new surface arrives without
      // needing a press event to ride on. We DO note engagement
      // activity so the rest debounce resets.
      this.noteEngagementActivity();
      flowNote("COORDINATOR", `Silent home press "${label}" — no TTS, BoardManager invoked directly.`);
      void this.invokeBoardManager([]);
      return;
    }

    // Now emit the press through the normal flow: this voices the label
    // via TTS (so the room hears it the way any SENTENCE BUTTON would)
    // AND emits button_pressed, which routes through emitClientEvent ->
    // routeClientEvent like a regular tap. Target defaults to DEVICE so
    // Speaker sees `[BUTTON PRESS → YOU] "<label>"` and replies.
    await this.handleSyntheticPress(label);
  }

  /**
   * Voice a press through TTS and route it as a button_pressed event,
   * the same way handleButtonPress does for client-originated presses.
   * Used by home-board navigation so synthetic presses get the full
   * standard treatment (utterance display + student-voice TTS + the
   * standard target-aware routing).
   */
  private async handleSyntheticPress(label: string): Promise<void> {
    // Stamp engagement activity immediately — see handleButtonPress for
    // the rationale. The press is real activity the moment it lands;
    // the TTS await below mustn't let a pending rest timer slip through.
    this.noteEngagementActivity();
    if (label) {
      flowOutput("COORDINATOR", "ws_send_utterance", label);
      this.send({ type: "utterance", text: label, confidence: "high", noAudioClear: false });
      try { await this.streamStudentTts(label, "button_press"); } catch { /* logged inside */ }
    }
    this.emitClientEvent({
      type: "button_pressed",
      source: "client",
      timestamp: Date.now(),
      label,
      sentence: label,
    });
  }

  private handleMuteToggled(state: AACMuteState): void {
    this.muteState = state;
    this.emitClientEvent({
      type: "mute_toggled",
      source: "client",
      timestamp: Date.now(),
      state,
    });
  }

  private handleConstructionState(data: any): void {
    // Composing in the sentence builder is real user activity — each
    // construction_state push (glyph added, removed, slot changed)
    // counts. Without this reset, a long compose session can let a
    // pending rest timer fire mid-composition. Also wake if we're
    // currently resting so the BoardManager can produce suggestions
    // (resting profile gates BM out — see invokeBoardManager).
    this.noteEngagementActivity();
    if (this.sessionProfile === "resting") {
      flowNote("COORDINATOR", "construction_state arrived while resting — waking before routing.");
      void this.transitionToProfile("awake").then(() => this.applyConstructionState(data));
      return;
    }
    this.applyConstructionState(data);
  }

  /** Inner half of handleConstructionState — runs after the wake gate. */
  private applyConstructionState(data: any): void {
    this.builderState = {
      category: data.category,
      modeChip: data.modeChip,
      partialSentence: data.glyph,
      targetSlot: data.targetSlot ?? 0,
      excludeKeys: data.excludeKeys ?? [],
      currentBoard: data.currentBoard,
      payloadTarget: data.payloadTarget
        ? { slotIndex: data.payloadTarget.slotIndex, host: data.payloadTarget.hostKey }
        : undefined,
    };

    // Notify Observer so it can flag environmental objects that match the
    // category the user is filling — when something becomes the likely
    // referent, Observer emits update_context with relevance:
    // "builder-candidate", which loops back through routeContextUpdate to
    // re-invoke BoardManager with a fresh suggest_construction_buttons call.
    this.observer?.sendContextInjection(
      `[${T.tagBuilderState}] category=${data.category} target_slot=${data.targetSlot ?? "next_empty"} partial="${data.glyph || "(empty)"}". Watch the environment for objects the user might be referencing for this slot — flag them via update_context(person_indicates_object / new_object) with relevance: "builder-candidate".`,
    );

    // Drive Board Manager — the builder state change IS the trigger.
    void this.invokeBoardManager([]);
  }

  /**
   * Legacy compat shim — accepts a pre-rendered snapshot from older
   * client builds that still own their own GuessingModeState. We can't
   * recreate the engine state from the snapshot (the wire shape doesn't
   * carry weights/history), so we accept it verbatim and any subsequent
   * intent messages from the same session will trigger a fresh engine
   * on the server. This path will be removed once all clients have
   * shipped with the intent protocol.
   */
  private handleLegacyGuessingState(
    msg: Extract<ClientMessage, { type: "guessing_state" }>,
  ): void {
    this.noteEngagementActivity();
    const apply = () => {
      const wasInGuessing = this.guessingState !== null;
      this.guessingState = {
        dimension: "",
        offeredKeys: msg.suggestionKeys,
        questionHint: msg.text,
        customFacts: (msg.customFacts ?? []).map((f) => ({ ...f })),
        rejectedFacts: (msg.rejectedFacts ?? []).map((f) => ({ ...f })),
      };
      if (!wasInGuessing) {
        this.emitClientEvent({
          type: "guessing_entered",
          source: "client",
          timestamp: Date.now(),
        });
        this.send({ type: "guessing_mode", active: true });
      }
      this.broadcastGuessingStateToAgents();
      void this.invokeBoardManager([]);
    };
    if (this.sessionProfile === "resting") {
      flowNote("COORDINATOR", "legacy guessing_state arrived while resting — waking before broadcasting.");
      void this.transitionToProfile("awake").then(apply);
      return;
    }
    apply();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Word Finder intent handlers. The client sends INTENTS (enter / press /
  // reject / narrow / exit); the server owns the engine state and runs
  // applyPress / applyCustomFact / rejectCurrentDimension. Each handler
  // wakes-from-resting if needed, mutates the engine state, refreshes the
  // snapshot, and broadcasts.
  // ─────────────────────────────────────────────────────────────────────

  /** Run `fn` inside the wake gate + engagement-activity reset that every
   *  guessing-mode intent needs. `label` is for the flow-log on the wake
   *  message. `fn` may be async (e.g. `handleGuessingEnter` awaits the
   *  category seeder before applying it). */
  private async wakeForGuessingIntent(label: string, fn: () => void | Promise<void>): Promise<void> {
    this.noteEngagementActivity();
    if (this.sessionProfile === "resting") {
      flowNote("COORDINATOR", `${label} arrived while resting — waking before applying.`);
      await this.transitionToProfile("awake");
    }
    await fn();
  }

  /**
   * Begin a Word Finder session. If launched from the sentence builder, the
   * builder's active tab pre-selects the top-level category (via
   * `BUILDER_TAB_TO_GUESSING`) so the user skips the "what kind of thing
   * are you looking for?" step. The origin + builderContext are remembered
   * so a builder-origin resolution can feed back into the active slot
   * when guessing ends.
   */
  private handleGuessingEnter(
    msg: Extract<ClientMessage, { type: "guessing_enter" }>,
  ): void {
    void this.wakeForGuessingIntent("guessing_enter", async () => {
      // Seed from what we know about the student: their interests (from monitor
      // memory) personalize the first board + the AI's guesses; their age keeps
      // those guesses age-appropriate. Both are best-effort — absent data just
      // yields the generic, age-agnostic engine.
      const student = dualAgentService.getSessionCache(this.sessionId!)?.monitorAgent.getStudent?.();
      const interests = parseInterestsList((student?.chatMemory as Record<string, any> | undefined)?.Student_Interests);
      const userAge = computeAgeYears((student as any)?.birthDate);
      this.guessingEngineState = createGuessingState(interests, userAge);
      if (msg.builderContext) {
        // Builder origin: the active builder tab maps directly to a
        // top-level category, so we know the right starting point
        // without consulting an LLM. Skip the seeder entirely.
        this.guessingOrigin = "builder";
        this.guessingBuilderContext = msg.builderContext;
        const cat = BUILDER_TAB_TO_GUESSING[msg.builderContext.category];
        if (cat) applyGuessingPress(this.guessingEngineState, CATEGORY_DIM_ID, cat);
      } else {
        // Conversation origin: ask a fast LLM to classify the most
        // recent AI question into one of the 6 predefined categories,
        // a "new" freeform topic, or "unknown". On predefined we
        // pre-press the engine so the first narrowing board lands
        // inside the right category; on "new" we record the topic as
        // a custom fact (so subsequent AI [NARROW:]/[GUESS] buttons
        // have it as context); on "unknown" we leave the engine as
        // is and the user sees the generic category menu.
        this.guessingOrigin = "conversation";
        this.guessingBuilderContext = null;
        await this.applyConversationSeedToGuessingEngine();
      }
      this.refreshGuessingSnapshot(/* firstEntry */ true);
    });
  }

  /** Run the conversation classifier and apply the result to the engine.
   *  Best-effort: any failure (no recent AI question, LLM error, parse
   *  fail) leaves the engine in its initial state, which is correct —
   *  the user just sees the top-level category menu. */
  private async applyConversationSeedToGuessingEngine(): Promise<void> {
    if (!this.guessingEngineState) return;
    const lastAIQuestion = this.findLastAIQuestion();
    if (!lastAIQuestion) {
      flowNote("COORDINATOR", "guessing seeder skipped — no recent AI question to seed from.");
      return;
    }
    const seed = await seedGuessingFromConversation({ lastAIQuestion }).catch((err) => {
      flowNote("COORDINATOR", `guessing seeder errored: ${err?.message ?? err}`);
      return null;
    });
    if (!seed) {
      flowNote("COORDINATOR", "guessing seeder returned no result — using top-level menu.");
      return;
    }
    switch (seed.kind) {
      case "predefined":
        flowNote("COORDINATOR", `guessing seeded: category=${seed.category}`);
        applyGuessingPress(this.guessingEngineState, CATEGORY_DIM_ID, seed.category);
        return;
      case "new":
        flowNote("COORDINATOR", `guessing seeded: new topic="${seed.label}"`);
        applyGuessingCustomFact(this.guessingEngineState, "topic", seed.label);
        return;
      case "unknown":
        flowNote("COORDINATOR", "guessing seeded: unknown — using top-level menu.");
        return;
    }
  }

  /** Scan `recentEvents` newest-first for the most recent finalized AI
   *  utterance. Used by the guessing seeder to anchor its classification
   *  on what was just being discussed. */
  private findLastAIQuestion(): string | null {
    for (let i = this.recentEvents.length - 1; i >= 0; i--) {
      const e = this.recentEvents[i];
      if (e.type === "speech_text_finalized" && e.transcript) {
        return e.transcript;
      }
    }
    return null;
  }

  /** A suggestion-key press (e.g. `suggestion:things.kind:animal`). */
  private handleGuessingPress(
    msg: Extract<ClientMessage, { type: "guessing_press" }>,
  ): void {
    if (!this.guessingEngineState) {
      flowNote("COORDINATOR", `guessing_press "${msg.suggestionKey}" dropped — no active session.`);
      return;
    }
    const parsed = parseSuggestionKey(msg.suggestionKey);
    if (!parsed) {
      flowNote("COORDINATOR", `guessing_press dropped — unparseable key "${msg.suggestionKey}".`);
      return;
    }
    // The paired button_press will arrive within milliseconds; the
    // narrowing directive (from refreshGuessingSnapshot below) carries
    // the turn, so the press shouldn't double-fire Speaker.
    this.suppressNextPressUserTurn = true;
    void this.wakeForGuessingIntent("guessing_press", () => {
      if (!this.guessingEngineState) return;
      applyGuessingPress(this.guessingEngineState, parsed.dimension, parsed.value);
      this.refreshGuessingSnapshot(false);
    });
  }

  /** "No" — the offered options don't fit right now. DEFERS (not dismisses)
   *  the current dimension: the engine moves on to a different question and
   *  advances this one's page, so it can return later with answers the user
   *  hasn't seen. Framed positively for the next injection (`lastAction =
   *  "defer"`). Distinct from "More" (page the SAME question's long tail) and
   *  from a genuine fact-undo. Does NOT pop a previously-confirmed positive
   *  fact — that produced the "Known: X" + "Rejected: X" contradiction the
   *  engine used to ship. */
  private handleGuessingReject(): void {
    if (!this.guessingEngineState) {
      flowNote("COORDINATOR", "guessing_reject dropped — no active session.");
      return;
    }
    this.suppressNextPressUserTurn = true;
    void this.wakeForGuessingIntent("guessing_reject", () => {
      if (!this.guessingEngineState) return;
      rejectGuessingDimension(this.guessingEngineState);
      this.refreshGuessingSnapshot(false);
    });
  }

  /** AI-proposed `[NARROW:<dim>] <value>` press — records as a custom
   *  fact on the parallel track. */
  private handleGuessingNarrow(
    msg: Extract<ClientMessage, { type: "guessing_narrow" }>,
  ): void {
    if (!this.guessingEngineState) {
      flowNote("COORDINATOR", `guessing_narrow ${msg.dimension}=${msg.value} dropped — no active session.`);
      return;
    }
    this.suppressNextPressUserTurn = true;
    void this.wakeForGuessingIntent("guessing_narrow", () => {
      if (!this.guessingEngineState) return;
      applyGuessingCustomFact(this.guessingEngineState, msg.dimension, msg.value, msg.sourceText);
      this.refreshGuessingSnapshot(false);
    });
  }

  /**
   * Re-derive the flat `guessingState` snapshot from the engine state and
   * fan it out. On first entry, also emits the `guessing_entered` event
   * and tells the client to flip its `guessingMode` flag. Subsequent
   * refreshes just rebroadcast the latest snapshot to the live agents
   * and trigger a BoardManager rebuild.
   *
   * This is the ONLY path that updates `this.guessingState` —
   * everything else reads it as a derived view of `guessingEngineState`.
   */
  private refreshGuessingSnapshot(firstEntry: boolean): void {
    if (!this.guessingEngineState) return;
    const inj = buildGuessingInjection(this.guessingEngineState);
    this.guessingState = {
      dimension: "",
      offeredKeys: inj.suggestionKeys,
      questionHint: inj.text,
      customFacts: inj.customFacts.map((f) => ({ ...f })),
      rejectedFacts: inj.rejectedFacts.map((f) => ({ ...f })),
    };

    if (firstEntry) {
      // emitClientEvent("guessing_entered") schedules the deferred
      // BoardMgr (see the guessing_entered branch of emitClientEvent);
      // we don't need to invoke BM again here.
      this.emitClientEvent({
        type: "guessing_entered",
        source: "client",
        timestamp: Date.now(),
      });
      this.send({ type: "guessing_mode", active: true });
      this.broadcastGuessingStateToAgents();
      return;
    }

    // Subsequent state refresh (a press / reject / narrow). Broadcast
    // the new state to the live agents and defer BoardMgr so its
    // buttons follow whatever Speaker says next. Empty trigger is
    // fine — renderInvocationContext already labels an empty-trigger
    // invocation with `guessingState` set as "guessing_state_change"
    // in its flow-log summary.
    this.broadcastGuessingStateToAgents();
    this.scheduleDeferredBoardMgr(null, "guessing_state_change");
  }

  /** Single point of exit-guessing cleanup. Clears server state, notifies
   *  the client (so its `guessingMode` / refs clear too), tells the Live
   *  agents that the word-finder closed, and kicks BoardManager so the
   *  board returns to conversation context rather than leaving stale
   *  suggestion buttons on screen. Safe to call when not in guessing
   *  mode — no-op in that case.
   */
  private clearGuessingState(reason: string): void {
    if (!this.guessingState) return;
    flowNote("COORDINATOR", `Clearing guessing state: ${reason}`);
    const aiInitiated = reason.startsWith("ai_exit:");
    this.guessingState = null;
    this.guessingEngineState = null;
    this.guessingOrigin = "conversation";
    this.guessingBuilderContext = null;
    this.send({ type: "guessing_mode", active: false });
    // Tell Speaker the word-finder closed so it switches back to normal
    // conversation framing on its next turn. Skip raw [GUESSING] tags in
    // the directive — native-audio models echo those.
    this.speaker?.sendContextInjection(
      aiInitiated
        ? `The Word Finder is over — you ended it because narrowing converged. Continue the conversation normally about whatever was just resolved. No more narrowing questions.`
        : `The user closed the word-finder. Return to normal conversation — no more narrowing questions.`,
    );
    this.observer?.sendContextInjection(`[GUESSING] Word-finder closed.`);
    this.emitClientEvent({
      type: "guessing_exited",
      source: "client",
      timestamp: Date.now(),
    });
    // Re-trigger BoardManager with an EXPLICIT directive on what to build
    // next. An empty triggers array + a bare [GUESSING EXITED] event in
    // recent_events isn't enough — the model needs to know it's no longer
    // narrowing. Without this hint, recent-events tails of `[YOU]
    // rebuild_board(suggestion:...)` keep nudging the model toward more
    // suggestion buttons and it tends to MALFORMED instead of rebuilding
    // for normal conversation.
    const exitHint: ContextUpdateEvent = {
      type: "context_update",
      source: "observer", // synthetic — sourced from Coordinator on behalf
      timestamp: Date.now(),
      updateType: "other",
      key: "guessing_just_ended",
      description: aiInitiated
        ? `The Word Finder narrowing session just ended (you called exit_guessing: ${reason.replace(/^ai_exit:/, "")}). The user's word/concept has been identified. Rebuild the USER RESPONSE BOARD with a FRESH set of normal SENTENCE BUTTONs for talking about what was just resolved — reactions to the topic, follow-up questions, related things the user might want to say. Do NOT include suggestion:/[NARROW:]/[GUESS] buttons; those are for active narrowing only.`
        : `The Word Finder was just closed by the user (no AI-initiated exit). Rebuild the USER RESPONSE BOARD with a FRESH set of normal SENTENCE BUTTONs appropriate to the current conversation. Do NOT include suggestion:/[NARROW:]/[GUESS] buttons; those are for active narrowing only.`,
    };
    void this.invokeBoardManager([exitHint]);
  }

  /** Push the current guessingState to Speaker (as a directive user_turn)
   *  and Observer (as a context_injection). Called from applyGuessingState
   *  for every state push, and from transitionToProfile on wake when
   *  guessing is active — both Live sessions just reconnected with fresh
   *  prompts and lost the prior [GUESSING STATE] context. Speaker hears
   *  a synthesized natural-language framing (NOT the raw [GUESSING STATE]
   *  text dump) because native-audio models that see structured tags in
   *  their input often echo those tags verbatim in voiced speech.
   */
  private broadcastGuessingStateToAgents(): void {
    if (!this.guessingState) return;
    const s = this.guessingState;
    const muted = this.muteState === "muted";
    const directive = muted
      ? `[GUESSING STATE — muted, do not speak]`
      : this.buildSpeakerGuessingDirective(s);
    this.speaker?.sendUserTurn(directive);
    // Observer gets a brief one-liner — it doesn't need to ask, just to
    // know we're in word-finder mode so its environment scanning frames
    // detected objects as candidate referents.
    this.observer?.sendContextInjection(
      `[GUESSING] Word-finder active. The user is trying to find a specific word. Watch the environment for candidate referents.`,
    );
  }

  /** Convert the structured guessing state into a Speaker-friendly prose
   *  directive. Native-audio models echo whatever shape they see; feeding
   *  them `suggestion:dim:value`/`custom_facts: [...]`/`rejected_facts:`
   *  caused the Speaker to voice those tags. This builder yields plain
   *  English the model can act on directly. */
  private buildSpeakerGuessingDirective(s: GuessingState): string {
    const text = s.questionHint || "";
    const parts: string[] = [];

    // What to ask about (priority: registry's "Suggested next dimension",
    // falling back to a generic prompt when the registry is exhausted or
    // the AI is driving open-ended narrowing).
    const dimMatch = text.match(
      /Suggested next dimension:\s*([a-z_]+)(?:\s*—\s*([^\n]*?))?(?=\s+(?:Offer|Ready|Presses|$))/i,
    );
    const dimensionHint = dimMatch?.[2]?.trim() || dimMatch?.[1]?.trim();
    // The conversation-classifier seeder records a "new"-shaped result
    // as a custom fact with dimension="topic" (engine category stays
    // null — the topic doesn't fit any predefined branch). Surface
    // that topic to Speaker so it asks WITHIN it, instead of falling
    // through to the generic "what kind of thing?" opener.
    const seededTopic = s.customFacts.find((f) => f.dimension === "topic")?.value;
    if (dimensionHint) {
      parts.push(`Voice ONE short, warm question helping the user narrow down: ${dimensionHint}.`);
    } else if (text.includes("No more narrowing dimensions") || text.includes("Ready for guesses: yes")) {
      parts.push(`Voice ONE short, warm guess (or "is it X or Y?") about what the user is trying to say.`);
    } else if (seededTopic && text.includes("No category chosen yet")) {
      parts.push(`The user just opened the word finder. The conversation has been about ${seededTopic} — voice ONE short, warm narrowing question WITHIN that topic.`);
    } else if (text.includes("No category chosen yet")) {
      parts.push(`The user just opened the word finder. Voice ONE short, warm question: "What kind of thing are you thinking of?"`);
    } else {
      parts.push(`Voice ONE short, warm narrowing question to help the user find their word.`);
    }
    parts.push(`Don't list the options — the buttons appear on screen.`);

    // Known facts (registry-confirmed, prose form).
    const knownMatch = text.match(/^Known:\s*(.+)$/m);
    if (knownMatch) {
      parts.push(`What we know so far: ${knownMatch[1]}.`);
    }

    // Custom narrowing facts the AI already established with the user.
    if (s.customFacts.length) {
      const formatted = s.customFacts.map((f) => `${f.dimension} = ${f.value}`).join(", ");
      parts.push(`The user already confirmed: ${formatted}.`);
    }

    // Rejected facts — the user just said "no" to something. Pivot.
    if (s.rejectedFacts.length) {
      const formatted = s.rejectedFacts.map((f) => `${f.dimension} = ${f.value}`).join(", ");
      parts.push(`The user rejected: ${formatted}. Do NOT ask about those again — pivot to a different angle.`);
    } else if (text.includes("none of these")) {
      parts.push(`The user just said "none of these" to the last batch. Try a fresh angle or a [GUESS].`);
    }

    return parts.join(" ");
  }

  // Route a client-originated event to the agents per the spec table.
  private emitClientEvent(event:
    | ButtonPressedEvent
    | SentenceComposedEvent
    | MuteToggledEvent
    | BuilderOpenedEvent
    | BuilderClosedEvent
    | GuessingEnteredEvent
    | GuessingExitedEvent,
  ): void {
    this.recordEvent(event);

    // A real user action (button press, composed sentence, builder open)
    // must wake the session before routing. Otherwise Speaker, still on
    // the resting profile, receives the user_turn and stays silent until
    // Observer eventually notices and calls wake_up — sometimes 10+
    // seconds after the press, by which point the press is dead.
    const wakeRequired =
      this.sessionProfile === "resting" &&
      (event.type === "button_pressed" ||
        event.type === "sentence_composed" ||
        event.type === "builder_opened");
    if (wakeRequired) {
      flowNote("COORDINATOR", `User action ${event.type} arrived while resting; waking before routing.`);
      void this.transitionToProfile("awake").then(() => {
        this.routeClientEvent(event);
      });
      return;
    }

    this.routeClientEvent(event);
  }

  /** Inner half of emitClientEvent — the actual fan-out. Split out so
   *  the wake-up gate can defer it until the awake profile is live. */
  private routeClientEvent(event:
    | ButtonPressedEvent
    | SentenceComposedEvent
    | MuteToggledEvent
    | BuilderOpenedEvent
    | BuilderClosedEvent
    | GuessingEnteredEvent
    | GuessingExitedEvent,
  ): void {
    switch (event.type) {
      case "button_pressed": {
        this.lastUserInputType = "button_pressed";
        // User just acted — this is conversation engagement. Reset the
        // rest debounce window and cancel any pending rest request.
        this.noteEngagementActivity();
        // Target comes from the loaded board's target if the event
        // didn't carry one (synthetic home presses set their own).
        const target = event.target ?? this.currentBoardTarget ?? PARTY_DEVICE;
        const toDevice = isDeviceTarget(target, this.aiName);
        const targetLabel = toDevice ? "YOU" : target;

        // A button press is functionally a USER statement — the press
        // is just the mechanism. Speaker and BoardManager see it as
        // `[USER to <target>] "..."` so it slots into the same
        // "someone said something" mental model as a transcript.
        // Observer keeps the explicit `[BUTTON PRESS to <target>]`
        // marker because it's the agent that records HOW statements
        // were made.
        const pressInner = T.tagPress.replace(/^\[|\]$/g, "");
        const observerRendered = `[${pressInner} to ${targetLabel}] "${event.sentence}"`;
        const speakerRendered = `[USER to ${targetLabel}] "${event.sentence}"`;

        this.observer?.sendContextInjection(observerRendered);
        // A guessing-mode narrowing press (suggestion: / [NARROW:] /
        // "no") ALSO fires its own guessing_* intent, which triggers
        // refreshGuessingSnapshot → broadcastGuessingStateToAgents and
        // sends Speaker the narrowing directive. Without suppression
        // Speaker responds twice: once to the press, once to the
        // directive. The intent handler sets suppressNextPressUserTurn
        // immediately on arrival; we consume it here. A 1:1 pairing of
        // guessing intent + button_press is guaranteed by the client
        // (both fire from the same handler), so single-shot is safe.
        // (Can't infer "is this a narrowing press?" from button data —
        // suggestion buttons render the English labelEn server-side
        // but the press arrives with the localized label, so a
        // label-match misses every time.)
        const suppressUserTurn = this.suppressNextPressUserTurn;
        this.suppressNextPressUserTurn = false;

        if (toDevice) {
          if (suppressUserTurn) {
            // Speaker just gets context — the narrowing directive
            // already on its way (from refreshGuessingSnapshot) is the
            // single turn-driving signal.
            this.speaker?.sendContextInjection(speakerRendered);
            flowNote(
              "COORDINATOR",
              `narrowing-press "${event.label}" → Speaker context only (directive drives turn).`,
            );
          } else {
            // Press addressed to the AI — Speaker should respond.
            this.speaker?.sendUserTurn(speakerRendered);
            // Defer the BM invocation: Speaker's reply will trigger a
            // REPLIES rebuild that supersedes FOLLOW-UPS. If Speaker
            // doesn't reply within DEFERRED_BM_PRESS_MS, the timer fires
            // FOLLOW-UPS as a fallback.
            this.scheduleDeferredBoardMgr(event, "press");
          }
        } else {
          // Press addressed to someone else (or USER itself) — Speaker
          // stays quiet, no REPLIES event coming. Build FOLLOW-UPS now.
          this.speaker?.sendContextInjection(speakerRendered);
          this.invokeBoardManager([event]);
        }
        this.appendToConversationLog("user", speakerRendered);
        return;
      }
      case "sentence_composed": {
        this.lastUserInputType = "sentence_composed";
        this.noteEngagementActivity();
        const rendered = `[${T.tagComposed}] "${event.sentence}"`;
        this.observer?.sendContextInjection(rendered);
        // Speaker gets this as CONTEXT, not a user_turn. The composed
        // glyph string is not what the user is "saying" — BoardManager
        // interprets it via interpret() into natural language, the
        // student TTS voices the interpretation, and then Speaker
        // receives a synthetic [BUTTON PRESS] turn with the natural
        // language to respond to. Sending Speaker the raw glyph string
        // as a user_turn here would make it respond to symbol notation
        // directly, skipping the interpretation entirely.
        this.speaker?.sendContextInjection(rendered);
        this.invokeBoardManager([event]);
        this.appendToConversationLog("user", rendered);
        return;
      }
      case "mute_toggled": {
        const rendered = `[MUTE TOGGLED] now ${event.state}`;
        this.observer?.sendContextInjection(rendered);
        this.speaker?.sendContextInjection(rendered);
        this.invokeBoardManager([event]);
        return;
      }
      case "builder_opened":
      case "builder_closed":
      case "guessing_exited": {
        const rendered = `[${event.type.toUpperCase().replace(/_/g, " ")}]`;
        this.observer?.sendContextInjection(rendered);
        this.speaker?.sendContextInjection(rendered);
        this.invokeBoardManager([event]);
        return;
      }
      case "guessing_entered": {
        // Word Finder just opened. Notify both live agents — Speaker
        // will get a follow-up user_turn directive with the actual
        // narrowing question via broadcastGuessingStateToAgents — and
        // DEFER BoardMgr so its buttons match whatever Speaker decides
        // to ask aloud. The defer is cleared by
        // onSpeakerSpeechTextFinalized, which invokes BM with the
        // speech as context. If Speaker stays silent, the 4s timer
        // fires BM with the guessing_entered event alone.
        const rendered = `[${event.type.toUpperCase().replace(/_/g, " ")}]`;
        this.observer?.sendContextInjection(rendered);
        this.speaker?.sendContextInjection(rendered);
        this.scheduleDeferredBoardMgr(event, "guessing_entered");
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Observer → bus
  // -------------------------------------------------------------------------

  private onObserverEvent(event: ObserverOutputEvent): void {
    this.recordEvent(event);
    this.logEvent("OBSERVER", event);

    switch (event.type) {
      case "transcribed":
        this.routeTranscribed(event);
        return;
      case "context_update":
        this.enqueueContextUpdate(event);
        return;
      case "engagement_change":
        this.routeEngagementChange(event);
        return;
      case "focus_request":
        this.routeFocusRequest(event);
        return;
      case "mode_change":
        // Observer owns the interact/assist switch in the three-agent
        // path — it has the camera/mic context to judge whether the
        // user is conversing with the AI or with someone in the room.
        // Coordinator persists currentInteractionMode and forwards the
        // resulting [MODE] context injection to Speaker.
        this.routeModeChange(event);
        return;
      case "alarm_raised":
        this.routeAlarm(event);
        return;
      case "monitor_call_requested":
        this.requestMonitor(event.reason, "observer");
        return;
      case "private_note":
        // Already in Observer's own history via the tool-call ack.
        // Per user feedback: echo back is fine; agent retains action log.
        this.observer?.sendContextInjection(`[PRIVATE NOTE] (you noted) ${event.note}`);
        return;
    }
  }

  private routeTranscribed(event: TranscribedEvent): void {
    const target = event.target ?? "UNKNOWN";
    const aiName = this.aiName;
    const studentName = this.currentStudentName;
    const toDevice = isDeviceTarget(target, aiName);
    const toUser = isUserTarget(target, studentName);

    // Same `<speaker> to <target>` shape as button presses. Speaker
    // identity is the actual person who spoke (or USER for a USER alias).
    const targetLabel = toDevice ? "YOU" : target;
    const rendered = `[${event.speaker} to ${targetLabel}] "${event.text}"`;

    // Conversation activity — transcripts directed at USER or DEVICE
    // (i.e. someone speaking with the user or the AI) reset the rest
    // debounce. Ambient / third-party transcripts don't count.
    if (toDevice || toUser) this.noteEngagementActivity();

    // Wake from resting on directed live speech. Without this, Speaker
    // stays on the resting profile and won't respond to DEVICE-targeted
    // speech, and BoardManager runs in a stale-context state when the
    // USER is being addressed. Match the button-press wake gate in
    // emitClientEvent.
    if ((toDevice || toUser) && this.sessionProfile === "resting") {
      flowNote("COORDINATOR", `Directed transcript arrived while resting; waking before routing.`);
      void this.transitionToProfile("awake").then(() => {
        this.routeTranscribedInner(event, rendered, toDevice, toUser);
      });
      return;
    }
    this.routeTranscribedInner(event, rendered, toDevice, toUser);
  }

  /** Inner half of routeTranscribed — runs after the wake gate. Split
   *  out so the wake transition can defer execution to the awake
   *  profile. */
  private routeTranscribedInner(
    event: TranscribedEvent,
    rendered: string,
    toDevice: boolean,
    toUser: boolean,
  ): void {
    // Echo back to Observer for unified action log.
    this.observer?.sendContextInjection(rendered);

    if (toDevice) {
      // Someone addressed the AI directly — deliver as a user_turn from
      // Speaker's perspective (Speaker prompt treats DEVICE-targeted
      // speech as "addressed to YOU").
      this.lastUserInputType = "transcribed";
      this.speaker?.sendUserTurn(rendered);
      this.appendToConversationLog("user", rendered);
    } else {
      // Either USER-targeted or 3rd-party / UNKNOWN. Speaker sees it as
      // context only — it doesn't respond unless directly addressed.
      this.speaker?.sendContextInjection(rendered);
      // Persist USER-targeted and ambient transcripts as observer-side
      // observations so Monitor (and the admin log) retain conversational
      // context that wasn't directly aimed at the AI. Without this, the
      // session log only captures DEVICE turns and the AI never gets
      // memory updates from real-world conversation around the student.
      this.appendToConversationLog("system", rendered);
    }

    // BoardManager rebuilds whenever the USER needs to reply — i.e. the
    // target was USER. DEVICE-targeted speech goes to Speaker; ambient
    // speech doesn't move the board.
    if (toUser) this.invokeBoardManager([event]);
  }

  private enqueueContextUpdate(event: ContextUpdateEvent): void {
    this.contextUpdateBuffer.push(event);
    if (this.contextUpdateDebounceTimer) clearTimeout(this.contextUpdateDebounceTimer);
    this.contextUpdateDebounceTimer = setTimeout(
      () => this.flushContextUpdates(),
      DEBOUNCE_CONTEXT_UPDATE_MS,
    );
  }

  private flushContextUpdates(): void {
    const batch = this.contextUpdateBuffer;
    this.contextUpdateBuffer = [];
    this.contextUpdateDebounceTimer = null;
    if (batch.length === 0) return;

    // Join into a single context injection for Speaker, and a single
    // Board Manager invocation with the whole batch as triggers.
    const lines = batch.map(e =>
      `[CONTEXT] ${e.updateType}: ${e.key} — ${e.description}${e.relevance ? ` (relevance: ${e.relevance})` : ""}`,
    );
    const joined = lines.join("\n");
    this.observer?.sendContextInjection(joined);
    this.speaker?.sendContextInjection(joined);
    // Observer's observations are session memory — persist them to the
    // conversation log so Monitor incorporates them into Notes/Interests/
    // People updates and the admin log shows the perceived context, not
    // just the spoken turns.
    this.appendToConversationLog("system", joined);
    this.invokeBoardManager(batch);
  }

  /** A user-or-device-directed action just happened — reset the rest
   *  debounce window and cancel any pending rest. Called from
   *  routeClientEvent (button presses, composed sentences), from
   *  routeTranscribed (live transcripts targeted at USER or DEVICE),
   *  and from the Speaker speech_end handler. */
  private noteEngagementActivity(): void {
    this.lastEngagementActivityAt = Date.now();
    if (this.pendingRestTimer) {
      clearTimeout(this.pendingRestTimer);
      this.pendingRestTimer = null;
      flowNote("COORDINATOR", "Engagement activity — pending rest request cleared.");
    }
  }

  /** Observer asked to enter rest. If the last engagement activity was
   *  more than REST_DEBOUNCE_MS ago, transition immediately; otherwise
   *  schedule it for when the timer expires. The schedule is canceled
   *  by noteEngagementActivity if activity resumes meanwhile. */
  private requestRest(reason?: string): void {
    if (this.sessionProfile === "resting") return;
    const elapsed = Date.now() - this.lastEngagementActivityAt;
    if (elapsed >= AgentCoordinator.REST_DEBOUNCE_MS) {
      flowNote("COORDINATOR", `Rest request: ${elapsed}ms since last activity — resting now.${reason ? ` (${reason})` : ""}`);
      void this.transitionToProfile("resting");
      return;
    }
    const remaining = AgentCoordinator.REST_DEBOUNCE_MS - elapsed;
    if (this.pendingRestTimer) clearTimeout(this.pendingRestTimer);
    flowNote("COORDINATOR", `Rest request deferred ~${Math.round(remaining / 1000)}s (last activity ${Math.round(elapsed / 1000)}s ago).${reason ? ` (${reason})` : ""}`);
    this.pendingRestTimer = setTimeout(() => {
      this.pendingRestTimer = null;
      if (this.sessionProfile === "resting") return;
      flowNote("COORDINATOR", "Deferred rest timer expired — entering rest.");
      void this.transitionToProfile("resting");
    }, remaining);
  }

  private routeEngagementChange(event: EngagementChangeEvent): void {
    this.observer?.sendContextInjection(`[ENGAGEMENT] ${event.state}${event.reason ? ` — ${event.reason}` : ""}`);

    // Execute the actual profile transition. Fire-and-forget — failures
    // are logged inside transitionToProfile and must not block the bus.
    // sleep_state_change for resting/awake transitions is emitted by
    // transitionToProfile itself, so both Observer-initiated transitions
    // AND press-initiated wakes notify the client. sleep/end_session
    // don't go through transitionToProfile — we send their state here.
    switch (event.state) {
      case "rest":
        this.requestRest(event.reason);
        return;
      case "wake_up":
        // wake_up is immediate — note the activity and transition. The
        // transitionToProfile call sends sleep_state_change.
        this.noteEngagementActivity();
        void this.transitionToProfile("awake");
        return;
      case "sleep":
        // Cost-saving close: tear down both Live sessions, keep the WS
        // open so the client can re-wake on activity. Coordinator stays
        // ready and can rebuild agents on the next client signal.
        this.send({ type: "sleep_state_change", data: { state: "asleep", source: "ai" } });
        try { this.observer?.close(); } catch {}
        try { this.speaker?.close(); } catch {}
        this.observer = null;
        this.speaker = null;
        return;
      case "end_session":
        // Defensive only — the tool is no longer declared on Observer's
        // surface (we never want the AI to kill a session unilaterally;
        // sleep() handles "user is done for now"). If a stale model call
        // ever surfaces, downgrade to sleep instead of cleaning up.
        flowNote("COORDINATOR", "Ignored stale end_session call — downgrading to sleep");
        this.send({ type: "sleep_state_change", data: { state: "asleep", source: "ai" } });
        try { this.observer?.close(); } catch {}
        try { this.speaker?.close(); } catch {}
        this.observer = null;
        this.speaker = null;
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Profile transitions (awake ↔ resting)
  // -------------------------------------------------------------------------

  /**
   * Profile transition (awake ↔ resting).
   *
   * Observer reconnects with the SAME prompt and tools — only its
   * compression thresholds change. The Live session resumption handle
   * preserves conversation history across the reconnect, so Observer
   * doesn't lose context (and doesn't drift into a different persona).
   * Tighter resting compression is the main cost lever during long
   * quiet stretches — Observer's billed context drops from ~15–30k to
   * ~6–12k per turn.
   *
   * Speaker is closed entirely on resting and freshly started on wake
   * (it's the expensive second Live session, and we want it gone during
   * quiet stretches — not just compressed).
   *
   * BoardManager is HTTP/stateless — no "close." Instead invokeBoardManager
   * short-circuits while resting (see its profile gate).
   */
  private async transitionToProfile(target: "awake" | "resting"): Promise<void> {
    if (this.sessionProfile === target) return;
    if (!this.observer) {
      console.warn(`[AgentCoordinator] transitionToProfile(${target}): observer missing`);
      return;
    }

    // Notify the client of the new state.
    this.send({
      type: "sleep_state_change",
      data: { state: target === "resting" ? "resting" : "awake", source: "ai" },
    });
    if (target === "awake" && this.pendingRestTimer) {
      clearTimeout(this.pendingRestTimer);
      this.pendingRestTimer = null;
    }

    runInSessionContext(this.sessionId!, this.debugMode, () => {
      logLiveSession("PROFILE_TRANSITION", `${this.sessionProfile} → ${target}`);
    });
    flowNote("COORDINATOR", `Profile transition: ${this.sessionProfile} → ${target}`);

    const observerTrigger = target === "resting" ? RESTING_COMPRESSION_TRIGGER : AWAKE_COMPRESSION_TRIGGER;
    const observerTarget = target === "resting" ? RESTING_COMPRESSION_TARGET : AWAKE_COMPRESSION_TARGET;

    try {
      // Observer: reconnect with new compression thresholds. Same prompt,
      // same tools — session-resumption handle preserves conversation
      // history. Don't await Speaker close/start together with this — if
      // Speaker fails to come back, Observer's reconnect should still
      // complete and the session can recover.
      await this.observer.reconnectWithConfig({
        systemPrompt: this.observerPrompt,
        model: this.observerModel,
        toolConfig: this.observerToolConfigBase,
        useVertex: this.useVertex,
        compressionTriggerTokens: observerTrigger,
        compressionTargetTokens: observerTarget,
      });

      if (target === "resting") {
        // Tear down Speaker.
        try { this.speaker?.close(); } catch (err) {
          console.warn("[AgentCoordinator] Speaker close failed on transition to resting:", err);
        }
        this.speaker = null;
      } else {
        // target === "awake" — bring Speaker back online. Already running
        // means we're recovering from a partial transition — leave it alone.
        if (!this.speaker) {
          this.speaker = this.createSpeakerAgent();
          await this.speaker.start({
            systemPrompt: this.speakerPrompt,
            model: this.speakerModel,
            toolConfig: this.speakerToolConfigBase,
            useVertex: this.useVertex,
            voiceName: this.aiVoiceName,
            useDirectAudio: this.useDirectAudio,
            compressionTriggerTokens: AWAKE_COMPRESSION_TRIGGER,
            compressionTargetTokens: AWAKE_COMPRESSION_TARGET,
          });
          this.speaker.setDebugSessionContext(this.sessionId!, this.debugMode);
        }
      }
      this.sessionProfile = target;
      runInSessionContext(this.sessionId!, this.debugMode, () => {
        logLiveSession("PROFILE_TRANSITION_DONE", `now=${target}`);
      });

      // After waking, prime the fresh Speaker with everything it needs
      // to pick up the conversation: recent dialogue, rolling session
      // summary (if any), interaction mode, active guessing context.
      // Without history replay the fresh Speaker had ZERO context — a
      // press of "something light" landed without the food discussion
      // that preceded rest, and got reinterpreted as "you want to take
      // it easy." Observer doesn't need this — its Live session was
      // preserved via reconnectWithConfig.
      if (target === "awake" && this.speaker) {
        // 1. Replay rolling session summary (built every N user/assistant
        //    messages by the Monitor) if it exists — gives the fresh
        //    Speaker the long-tail context that's been compressed out of
        //    the per-turn replay below.
        if (this.currentSessionSummary) {
          flowNote("COORDINATOR", `Replaying [SESSION SUMMARY] (${this.currentSessionSummary.length} chars) to fresh Speaker`);
          this.speaker.sendContextInjection(`[SESSION SUMMARY]\n${this.currentSessionSummary}`);
        }
        // 2. Replay the last N conversation turns so the model sees what
        //    just happened. Cap at 20 to avoid blowing the new session's
        //    context window on history alone.
        const replayCount = Math.min(20, this.conversationLog.length);
        if (replayCount > 0) {
          const recent = this.conversationLog.slice(-replayCount).map(t => ({
            role: t.role === "assistant" ? ("model" as const) : ("user" as const),
            text: t.content,
          }));
          flowNote("COORDINATOR", `Replaying ${recent.length} recent turns to fresh Speaker`);
          this.speaker.sendConversationHistory(recent);
        }
        // 3. Persistent state the new Speaker doesn't otherwise know.
        const rendered = `[MODE] ${this.currentInteractionMode} (restored on wake)`;
        flowNote("COORDINATOR", `Re-broadcasting mode=${this.currentInteractionMode} to fresh Speaker`);
        this.speaker.sendContextInjection(rendered);
        if (this.guessingState) {
          flowNote("COORDINATOR", "Re-broadcasting active guessing state to fresh Speaker");
          this.broadcastGuessingStateToAgents();
        }
      }
    } catch (err) {
      console.error(`[AgentCoordinator] transitionToProfile(${target}) failed:`, err);
      runInSessionContext(this.sessionId!, this.debugMode, () => {
        logLiveSession("PROFILE_TRANSITION_ERROR", `target=${target} err=${(err as Error).message}`);
      });
    }
  }

  /** Build a fresh SpeakerAgent with the standard callback bundle. Used
   *  by initial start AND by transitionToProfile("awake") when recreating
   *  Speaker after a resting close. Picks SpeakerAgent (Live) or
   *  HttpSpeakerAgent based on `this.speakerMode`. */
  private createSpeakerAgent(): ISpeakerAgent {
    const provider = "gemini" as const;
    const aacChatProvider = this.aacChatProvider;
    const speakerModel = this.speakerModel;
    const callbacks = {
      onEvent: (e: SpeakerOutputEvent) => this.onSpeakerEvent(e),
      onAudioChunk: (data: { mimeType: string; data: string }) => this.onSpeakerAudioChunk(data),
      onTranscriptionDelta: (text: string) => this.onSpeakerTranscriptionDelta(text),
      onSpeakText: (text: string) => this.onSpeakerSpeakText(text),
      onError: (err: Error) => console.error("[AgentCoordinator] Speaker error:", err),
      onClose: () => console.log("[AgentCoordinator] Speaker closed"),
      onUsage: (usage: any) => this.trackLiveUsage("speaker", aacChatProvider, speakerModel, usage),
    };
    if (this.speakerMode === "http") {
      flowNote("COORDINATOR", `Speaker mode=http (Gemini chat completion + streaming TTS)`);
      return new HttpSpeakerAgent(provider, callbacks);
    }
    flowNote("COORDINATOR", `Speaker mode=live (Gemini Live, useDirectAudio=${this.useDirectAudio})`);
    return new SpeakerAgent(provider, {
      onEvent: (e) => this.onSpeakerEvent(e),
      onAudioChunk: (data) => this.onSpeakerAudioChunk(data),
      onTranscriptionDelta: (text) => this.onSpeakerTranscriptionDelta(text),
      onSpeakText: (text) => this.onSpeakerSpeakText(text),
      onError: (err) => console.error("[AgentCoordinator] Speaker error:", err),
      onClose: () => console.log("[AgentCoordinator] Speaker closed"),
      onUsage: (usage) => this.trackLiveUsage("speaker", aacChatProvider, speakerModel, usage),
    });
  }

  private routeFocusRequest(event: FocusRequestEvent): void {
    this.send({ type: "focus_request", data: { reason: event.reason } });
    // Echo back so Observer doesn't request the same thing in rapid succession.
    this.observer?.sendContextInjection(`[FOCUS REQUESTED] ${event.reason}`);
  }

  /**
   * Observer raised a caretaker alarm. Push it straight to the client —
   * NOT through the Monitor, which is blind (text/HTTP only) and too slow
   * for something time-sensitive. The client owns the audible/visible
   * effect (short nudge for "alert"; rising tone + on-screen cancel for
   * "emergency"). We deliberately do not gate this on session profile:
   * the message reaches the device even while resting. Echo the alarm
   * back into Observer's own context so it doesn't re-fire the same alarm
   * every frame.
   */
  private routeAlarm(event: AlarmRaisedEvent): void {
    this.send({ type: "alarm", data: { level: event.level, reason: event.reason } });
    const tag = event.level === "emergency" ? "EMERGENCY ALARM RAISED" : "ALERT RAISED";
    this.observer?.sendContextInjection(`[${tag}] ${event.reason} — the device is now signalling a caretaker; do not raise it again unless the situation changes.`);
  }

  // -------------------------------------------------------------------------
  // Speaker → bus
  // -------------------------------------------------------------------------

  private onSpeakerEvent(event: SpeakerOutputEvent): void {
    this.recordEvent(event);
    this.logEvent("SPEAKER", event);

    switch (event.type) {
      case "speech_start":
        this.onSpeakerSpeechStart(event);
        return;
      case "speech_text_finalized":
        this.onSpeakerSpeechTextFinalized(event);
        return;
      case "speech_end":
        this.onSpeakerSpeechEnd(event);
        return;
      case "emote_change":
        this.routeEmoteChange(event);
        return;
      case "mode_change":
        this.routeModeChange(event);
        return;
      case "app_open_requested":
        this.routeAppOpen(event);
        return;
      case "app_close_requested":
        this.routeAppClose(event);
        return;
      case "website_open_requested":
        this.routeWebsiteOpen(event);
        return;
      case "monitor_call_requested":
        this.requestMonitor(event.reason, "speaker");
        return;
      case "private_note":
        this.speaker?.sendContextInjection(`[PRIVATE NOTE] (you noted) ${event.note}`);
        return;
    }
  }

  private onSpeakerSpeechStart(event: SpeechStartEvent): void {
    // No mic mute — Observer's prompt handles echo via the
    // <transcription> rule + the [OWN_SPEECH] / [BUTTON PRESS] context
    // we inject around AAC audio playback.

    // Speech_start fires on the FIRST audio chunk — at that point the
    // transcript is typically only partial (text and audio interleave
    // in native audio, contrary to an earlier assumption). Don't fire
    // BoardManager here; wait for speech_text_finalized which carries
    // the FULL transcript and arrives well before turnComplete.
    void event;
  }

  /** Text portion of Speaker's turn finished. Audio may still be
   *  streaming, but the transcript is complete. Fire BoardManager so
   *  it can build REPLIES to what the AI just said — distinct from the
   *  press-time rebuild which builds FOLLOW-UPS to the user's own
   *  statement. Both rebuild perspectives matter, especially when the
   *  user is conversing with a non-AI person (the press is the user's
   *  turn, the speech is the other side's turn). */
  private onSpeakerSpeechTextFinalized(event: SpeechTextFinalizedEvent): void {
    this.noteEngagementActivity();
    // Speaker replied — supersede any deferred press-triggered BM
    // invocation. REPLIES (built from this event) is more current than
    // FOLLOW-UPS (built from the press) for an AI-targeted press.
    this.clearDeferredBoardMgr("speech_text_finalized supersedes press");
    // If a BM call is already running, its in-flight context is older
    // than the speech that just landed. Abort it: the queued invocation
    // we're about to fire will run with this new speech as trigger, so
    // the result of the in-flight one would only paint stale buttons.
    if (this.boardMgrInFlight && this.boardMgrAbortController) {
      flowNote("BOARD_MGR", "Aborting in-flight invocation — newer speech_text_finalized supersedes.");
      this.boardMgrAbortController.abort();
    }
    this.invokeBoardManager([event]);
  }

  private onSpeakerSpeechEnd(event: SpeechEndEvent): void {
    // Flush any remaining buffered PCM chunks so the tail of the
    // utterance reaches the client even when the timer hasn't fired yet.
    this.flushSpeakerAudio();
    // Signal end-of-turn to the client so its text accumulator resets
    // for the next utterance. Without this, each Speaker turn's text is
    // appended to the previous instead of replacing it. Mirrors the
    // legacy LiveRelay.processTurnEnd's `complete` send.
    this.send({ type: "complete", data: {} });

    // Speaker addressed `target` (default USER). Mirror the unified
    // `[<speaker> to <target>] "..."` shape used everywhere else.
    const target = event.target ?? PARTY_USER;
    const targetForLog = isUserTarget(target, this.currentStudentName)
      ? "USER"
      : target;
    if (event.transcript) {
      // Observer hears the speakers playback through the mic — tag it
      // as the AI's voice so it doesn't transcribe the room playback.
      this.observer?.sendContextInjection(`[AI to ${targetForLog}] "${event.transcript}"`);
      // Echo back to Speaker so it remembers what it said.
      this.speaker?.sendContextInjection(`[YOU to ${targetForLog}] "${event.transcript}" (you just said this)`);
      this.appendToConversationLog("assistant", event.transcript);
    }

    // BoardManager rebuild already fired on speech_start (where the
    // SpeechStartEvent carries the same transcript). Do NOT fire again
    // here — it would duplicate the call with no new information and
    // produce flicker.

    // Monitor heartbeat — turn-end is the natural hook to let Monitor
    // catch up on accumulated pending messages. Non-forced; the service
    // throttle (MONITOR_THROTTLE_MS, ~2 min) drops excess calls so this
    // effectively runs every couple of turns at peak conversation, then
    // backs off to once per throttle window. Without this hook, Monitor
    // only ever fires when an agent explicitly emits monitor_call_requested,
    // which means Student_Notes / Student_Interests / Student_People are
    // never written. Mirrors legacy LiveRelay's per-turn triggerMonitor.
    if (this.sessionId) {
      flowNote("MONITOR", "turn-end heartbeat — triggerMonitor(force=false)");
      dualAgentService.triggerMonitor(this.sessionId, false).catch(err => {
        console.warn("[AgentCoordinator] triggerMonitor failed:", (err as Error).message);
      });
    }
  }

  private routeEmoteChange(event: EmoteChangeEvent): void {
    this.send({ type: "emote", data: event.emote });
    this.speaker?.sendContextInjection(`[EMOTE] ${event.emote}`);
  }

  private routeModeChange(event: ModeChangeEvent): void {
    // Persist on the Coordinator so the mode survives profile
    // transitions. transitionToProfile("awake") re-broadcasts whatever
    // value lives here after the Live agents reconnect.
    const prev = this.currentInteractionMode;
    this.currentInteractionMode = event.mode;
    flowNote(
      "COORDINATOR",
      `Mode change: ${prev} → ${event.mode}${event.reason ? ` (${event.reason})` : ""}`,
    );
    this.send({
      type: "interaction_mode_changed",
      data: { mode: event.mode, reason: event.reason, source: "ai" },
    });
    const rendered = `[MODE] ${event.mode}${event.reason ? ` — ${event.reason}` : ""}`;
    this.speaker?.sendContextInjection(rendered);
    this.observer?.sendContextInjection(rendered);
  }

  private routeInterpretIntent(event: InterpretIntentEvent): void {
    // Gate: interpret() is only valid as Speaker's response to a
    // sentence_composed turn (user played the SENTENCE BUILDER's Play
    // button). Native audio's tool-calling sometimes calls interpret()
    // on regular button presses anyway, which double-voices the user's
    // SENTENCE. Server-side drop on a wrong context.
    if (this.lastUserInputType !== "sentence_composed") {
      flowNote(
        "SPEAKER",
        `Dropped spurious interpret_intent (lastInput=${this.lastUserInputType}; expected sentence_composed). sentence="${event.sentence}"`,
      );
      // Inform Speaker that the call was rejected so it doesn't keep
      // retrying. No TTS, no re-injection of the SENTENCE.
      this.speaker?.sendContextInjection(
        `[INTERPRET REJECTED] interpret() is only valid after a [${T.tagComposed}] turn. The most recent user input was a ${this.lastUserInputType === "button_pressed" ? `[${T.tagPress}] (the device already voiced it; do NOT call interpret)` : "transcript / context update"}. Respond normally instead.`,
      );
      return;
    }
    // Consume the sentence_composed context so a duplicate interpret on
    // the same turn is also blocked.
    this.lastUserInputType = "none";

    // Stream the user's interpreted sentence through student-voice TTS.
    void this.streamStudentTts(event.sentence, "interpret_intent");
    // Inject OWN_SPEECH (tagged as student-voice) so Observer doesn't
    // transcribe the device speakers as a fresh user statement.
    this.observer?.sendContextInjection(`[OWN_SPEECH] (student voice) ${event.sentence}`);
    // Echo back to Speaker.
    this.speaker?.sendContextInjection(`[INTERPRET] (you voiced for the user) ${event.sentence}`);
    // Re-deliver as a [BUTTON PRESS] so Speaker can respond on a later turn.
    this.speaker?.sendUserTurn(`[${T.tagPress}] "${event.sentence}"`);
    this.appendToConversationLog("user", `[${T.tagPress}] "${event.sentence}"`);
    // Trigger Board Manager rebuild for the follow-up surface.
    this.invokeBoardManager([event]);
  }

  private routeAppOpen(event: AppOpenRequestedEvent): void {
    this.send({ type: "app_open", data: { appId: event.appId, data: event.data } });
    this.speaker?.sendContextInjection(`[APP OPEN] ${event.appId}${event.data ? ` (${event.data})` : ""}`);
    // Board Manager may want to surface app-specific buttons.
    this.invokeBoardManager([event]);
  }

  private routeAppClose(event: AppCloseRequestedEvent): void {
    this.send({ type: "app_close", data: {} });
    this.speaker?.sendContextInjection(`[APP CLOSE]`);
    this.invokeBoardManager([event]);
  }

  private routeWebsiteOpen(event: WebsiteOpenRequestedEvent): void {
    this.send({ type: "app_open", data: { appId: "browser", url: event.url, label: event.label } });
    this.speaker?.sendContextInjection(`[WEBSITE OPEN] ${event.url}${event.label ? ` (${event.label})` : ""}`);
    this.invokeBoardManager([event]);
  }

  // -------------------------------------------------------------------------
  // Speaker output routing (audio + fallback text)
  // -------------------------------------------------------------------------

  private onSpeakerAudioChunk(data: { mimeType: string; data: string }): void {
    // Speaker emits raw PCM chunks. The client expects WAV (with a 44-byte
    // header). Buffer chunks for ~250ms, then flush as a single WAV — the
    // same pattern legacy LiveRelay uses for smoother playback.
    this.speakerAudioChunks.push(data.data);
    if (!this.speakerAudioFlushTimer) {
      this.speakerAudioFlushTimer = setTimeout(
        () => this.flushSpeakerAudio(),
        AUDIO_FLUSH_INTERVAL_MS,
      );
    }
  }

  /** Forward Gemini's outputAudioTranscription deltas to the client as
   *  `text` so the subtitle line + avatar mouth animate alongside audio. */
  private onSpeakerTranscriptionDelta(text: string): void {
    this.send({ type: "text", data: text, noAudioClear: true });
  }

  /** Join buffered Speaker PCM chunks into a single WAV and send as one
   *  avatar_audio message. Called on the flush timer and at SpeechEnd. */
  private flushSpeakerAudio(): void {
    if (this.speakerAudioFlushTimer) {
      clearTimeout(this.speakerAudioFlushTimer);
      this.speakerAudioFlushTimer = null;
    }
    if (this.speakerAudioChunks.length === 0) return;
    try {
      const chunks = this.speakerAudioChunks.splice(0);
      const pcmBuf = Buffer.concat(chunks.map(c => Buffer.from(c, "base64")));
      if (pcmBuf.length === 0) return;
      const wavBuf = pcmToWav(pcmBuf);
      this.send({ type: "avatar_audio", data: wavBuf.toString("base64"), format: "wav" });
    } catch (err) {
      console.error("[AgentCoordinator] flushSpeakerAudio failed:", (err as Error).message);
    }
  }

  /** Credit-tracking callback shared by both TTS paths. Fires once per
   *  synth call for the provider that actually rendered the audio.
   *  Aborted streams report nothing — we don't bill for cancelled
   *  synthesis. */
  private ttsUsageCallback() {
    return (usage: { provider: import("../chat/cost-helpers").TtsProvider; characters: number }) => {
      if (!this.sessionId || !this.studentId) return;
      dualAgentService
        .trackTtsUsage(this.sessionId, this.studentId, this.userId, usage.provider, usage.characters)
        .catch(err => console.error("[AgentCoordinator] trackTtsUsage failed:", err));
    };
  }

  /** Iterate a pre-started TTS stream and emit each chunk to the client
   *  as `messageType`. Returns the chunk count. The iterator is started
   *  by the caller (with first chunk pre-requested) so the HTTP call
   *  fires immediately — important for the AI path where this method
   *  runs serialized via `aiTtsChain` while the previous sentence is
   *  still emitting. */
  private async drainTtsToClient(opts: {
    iter: AsyncIterator<Buffer>;
    firstChunk: Promise<IteratorResult<Buffer>>;
    messageType: "avatar_audio" | "utterance_audio";
    signal?: AbortSignal;
  }): Promise<number> {
    let count = 0;
    try {
      let result = await opts.firstChunk;
      while (!result.done) {
        if (opts.signal?.aborted) break;
        this.send({ type: opts.messageType, data: result.value.toString("base64") });
        count++;
        result = await opts.iter.next();
      }
    } catch (err) {
      if (!opts.signal?.aborted) {
        console.error("[AgentCoordinator] TTS emission failed:", err);
      }
    }
    return count;
  }

  /** Sequential emission queue for AI TTS audio. The HTTP Speaker path
   *  calls `onSpeakText` once per completed sentence as the LLM stream
   *  lands. Each call pre-fires the TTS HTTP request IMMEDIATELY, then
   *  queues client emission behind any in-flight prior sentence — so
   *  sentence N's TTS rendering overlaps with sentence N-1's playback
   *  and chunks land back-to-back with no audible gap. The Live
   *  `speak()` path only fires once per turn, so the chain is a no-op
   *  there. */
  private aiTtsChain: Promise<void> = Promise.resolve();

  private onSpeakerSpeakText(text: string): void {
    if (!this.aiVoice || !text.trim()) return;
    const iter = ttsFacade.synthesizeStream(text, this.aiVoice, undefined, this.ttsUsageCallback())[Symbol.asyncIterator]();
    const firstChunk = iter.next();
    const prior = this.aiTtsChain;
    this.aiTtsChain = (async () => {
      await prior;
      await this.drainTtsToClient({ iter, firstChunk, messageType: "avatar_audio" });
    })();
  }

  private async streamStudentTts(text: string, source: string = "?"): Promise<void> {
    if (!this.studentVoice) return;
    // Cancel any in-flight TTS from a prior press / interpret AND tell
    // the client to drop queued utterance audio. Without this, a second
    // press while the first stream is still arriving produces doubled
    // playback. `audio_clear_tag` is tag-scoped — the AI's avatar_audio
    // queue is preserved.
    if (this.studentTtsAbortController) {
      this.studentTtsAbortController.abort();
      this.send({ type: "audio_clear_tag", tag: "utterance" });
    }
    const controller = new AbortController();
    this.studentTtsAbortController = controller;

    flowOutput("COORDINATOR", "student_tts_start", `[${source}] "${text}"`);
    const iter = ttsFacade.synthesizeStream(text, this.studentVoice, controller.signal, this.ttsUsageCallback())[Symbol.asyncIterator]();
    const firstChunk = iter.next();
    try {
      const count = await this.drainTtsToClient({
        iter,
        firstChunk,
        messageType: "utterance_audio",
        signal: controller.signal,
      });
      flowOutput(
        "COORDINATOR",
        controller.signal.aborted ? "student_tts_aborted" : "student_tts_end",
        `[${source}] chunks=${count}`,
      );
    } finally {
      if (this.studentTtsAbortController === controller) {
        this.studentTtsAbortController = null;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Board Manager invocation
  // -------------------------------------------------------------------------

  /**
   * Schedule a deferred BoardManager invocation that holds for
   * DEFERRED_BM_PRESS_MS waiting for Speaker to speak first. If Speaker's
   * speech_text_finalized fires within the window, the deferred trigger
   * is cleared (see onSpeakerSpeechTextFinalized) and BoardMgr is fired
   * with the SPEECH as context — so the buttons it builds match what
   * Speaker just said. If Speaker stays silent (mute mode, MALFORMED,
   * Word Finder with no question), the timer fires and BM builds from
   * the deferred trigger alone.
   *
   * Used by: DEVICE-targeted presses (the original use), guessing-mode
   * entries, and guessing-mode state refreshes. The wait-for-Speaker
   * pattern is the same in all three cases.
   */
  private scheduleDeferredBoardMgr(event: AgentEvent | null, contextLabel: string): void {
    this.clearDeferredBoardMgr("superseded by newer schedule");
    this.deferredBoardMgrTrigger = event;
    // The timer is always set, even when event is null (state-change
    // refresh). The active timer is what onSpeakerSpeechTextFinalized
    // looks for to know there's something to supersede; without it,
    // Speaker's reply wouldn't drive a board rebuild and we'd lose
    // alignment between what Speaker asks and what BM offers.
    this.deferredBoardMgrTimer = setTimeout(() => {
      const trigger = this.deferredBoardMgrTrigger;
      this.deferredBoardMgrTrigger = null;
      this.deferredBoardMgrTimer = null;
      flowNote("BOARD_MGR", `Deferred ${contextLabel} timer fired — Speaker didn't reply within ${AgentCoordinator.DEFERRED_BM_PRESS_MS}ms; building from the trigger alone.`);
      void this.invokeBoardManager(trigger ? [trigger] : []);
    }, AgentCoordinator.DEFERRED_BM_PRESS_MS);
  }

  /** Cancel a scheduled deferred BM invocation. Called when something
   *  supersedes it (Speaker replies, profile transition, new press, etc.). */
  private clearDeferredBoardMgr(reason: string): void {
    if (!this.deferredBoardMgrTimer) return;
    clearTimeout(this.deferredBoardMgrTimer);
    this.deferredBoardMgrTimer = null;
    this.deferredBoardMgrTrigger = null;
    flowNote("BOARD_MGR", `Deferred press cleared: ${reason}`);
  }

  private async invokeBoardManager(triggeringEvents: AgentEvent[]): Promise<void> {
    if (!this.boardManager) return;
    // Profile gate — resting means no board mutations. Observer keeps
    // running and recording; the board stays frozen at whatever was last
    // emitted. Wake-from-rest gates (button press, directed transcript,
    // builder open, board exit) wake first and then route, so legitimate
    // user-triggered rebuilds get through; this is just a safety against
    // ambient context-update invocations rebuilding the board while
    // nobody is at the device.
    if (this.sessionProfile === "resting") {
      flowNote("BOARD_MGR", "Skipped invocation — session is resting.");
      return;
    }
    if (this.boardMgrInFlight) {
      this.boardMgrPendingTriggers.push(...triggeringEvents);
      return;
    }
    this.boardMgrInFlight = true;
    // Fresh AbortController so onSpeakerSpeechTextFinalized can cancel
    // this call if a newer Speaker turn lands mid-flight.
    const controller = new AbortController();
    this.boardMgrAbortController = controller;
    // Pull and clear the pending validator-feedback (if any) so the
    // next invocation knows to retry. Bump the retry counter; reset on
    // a successful no-error invocation below.
    const pendingFeedback = this.boardMgrPendingFeedback;
    this.boardMgrPendingFeedback = null;
    // Single source of truth for the retry budget: a RETRY invocation
    // (pendingFeedback set) increments the consecutive-retry counter; a FRESH
    // invocation (a normal trigger) starts a new chain, so reset it here. Do
    // NOT reset the counter again later in this handler — a mid-handler reset
    // (e.g. after a clean dispatch) zeroes it before the state-triggered /
    // beat / malformed retry decision runs, so the BOARD_MGR_MAX_RETRIES cap in
    // queueBoardMgrEmptyResponseRetry always sees 0 and a deterministic
    // no_change (board already matches the state) retries forever.
    if (pendingFeedback) this.boardMgrRetryAttempt += 1;
    else this.boardMgrRetryAttempt = 0;
    try {
      // Tool config is rebuilt per invocation so `guessingActive` reflects
      // the LIVE state — the exit_guessing tool only appears while the
      // Word Finder is active, and is gone the next turn after exit.
      // hasLoadedBoard / loadedBoardName likewise track the current board
      // state so press_button surfaces only when there's a custom board.
      const dynamicToolConfig: BoardManagerToolConfig = {
        ...this.boardManagerToolConfig,
        guessingActive: this.guessingState !== null,
        hasLoadedBoard: this.loadedBoardId !== null,
        loadedBoardName: this.loadedBoardId
          ? this.boardManagerToolConfig.loadedBoardName ?? null
          : null,
      };
      // Compose from cached parts: base is always sent; the builder / guessing
      // blocks ride along ONLY while that mode is active (saves ~2.9k tok on a
      // normal turn). The stable base stays cacheable.
      const composedPrompt = this.boardManagerPromptBase
        + (this.builderState ? `\n\n${this.boardManagerBuilderBlock}` : "")
        + (this.guessingState ? `\n\n${this.boardManagerGuessingBlock}` : "");
      const input: BoardManagerInvocationInput = {
        systemPrompt: pendingFeedback
          ? `${composedPrompt}\n\n<retry_feedback>\n${pendingFeedback}\n</retry_feedback>`
          : composedPrompt,
        toolConfig: dynamicToolConfig,
        triggeringEvents,
        recentEvents: [...this.recentEvents],
        currentBoardLabels: [...this.currentBoardLabels],
        currentBoardButtons: this.currentBoardButtons.map((b) => ({
          label: b.label,
          speech: b.speech ?? b.sentence,
          glyph: b.glyph,
          glyphFallback: b.glyphFallback,
          buttonType: b.buttonType,
        })),
        contextSidebarLabels: [...this.contextSidebarLabels],
        loadedBoardId: this.loadedBoardId,
        builderState: this.builderState ?? undefined,
        guessingState: this.guessingState ?? undefined,
        provider: BOARD_MANAGER_DEFAULT_PROVIDER,
        model: BOARD_MANAGER_DEFAULT_MODEL,
        signal: controller.signal,
      };
      let result;
      try {
        result = await this.boardManager.invoke(input);
      } catch (err: any) {
        // AbortError is the only expected throw — the Gemini SDK
        // rejects with a DOMException/AbortError when abortSignal fires.
        // Treat it as a clean cancellation: queued triggers run next,
        // no events applied, no retry queued.
        if (controller.signal.aborted) {
          flowNote("BOARD_MGR", "In-flight invocation aborted — result discarded.");
          return;
        }
        throw err;
      }
      // Defensive: if abort fired between the await resolving and here
      // (unlikely but possible), drop the stale result.
      if (controller.signal.aborted) {
        flowNote("BOARD_MGR", "In-flight invocation aborted after resolution — result discarded.");
        return;
      }
      // (Retry counter is reset at invocation start — see the pendingFeedback
      // handling above. Resetting it here would defeat the retry cap.)
      // Track Board Manager HTTP usage (no modality details — text-only).
      if (result.usage) {
        this.trackLiveUsage("board-manager", BOARD_MANAGER_DEFAULT_PROVIDER, BOARD_MANAGER_DEFAULT_MODEL, {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          cachedTokens: result.usage.cachedTokens ?? 0,
          cacheCreationTokens: result.usage.cacheCreationTokens ?? 0,
        });
      }
      for (const event of result.events) {
        this.onBoardManagerEvent(event);
      }
      // Fusion-feedback retry. The model called a fused PascalCase tool
      // name (e.g. RebuildBoardButtons) instead of the canonical
      // rebuild_board. parseToolCall already rewrote the call to the
      // real tool and dispatched the event (and downgraded single-button
      // rebuilds to add_board_button so the existing board isn't
      // wiped). BoardManager is stateless — each invocation rebuilds
      // its message list from scratch with no history of prior tool
      // calls — so there's no carry-over "memory" of the fused name
      // for a retry to correct. A `<retry_feedback>` block would just
      // burn tokens for nothing: the model's next invocation can't see
      // its previous bad call either way. We log the fusion below for
      // debugging visibility but do NOT queue a retry.
      if (result.fusionFeedback && result.fusionFeedback.length > 0) {
        const summary = result.fusionFeedback
          .map(f => `${f.fusedName}→${f.toolName}`)
          .join(", ");
        flowNote("BOARD_MGR", `Fusion detected & auto-corrected (no retry — BM is stateless, no memory to inject into): ${summary}`);
      }
      // Retry policy. Two distinct failure modes, both warrant a retry:
      //
      //  (a) MALFORMED / empty response — the model produced ZERO valid
      //      tool calls (MALFORMED_FUNCTION_CALL, safety block, empty
      //      output). We have no information from this invocation
      //      regardless of trigger type. ALWAYS retry; the retry cap
      //      prevents loops if the failure is structural.
      //
      //  (b) Beat needed a rebuild but model gave up — the model
      //      emitted a real no_change(reason) for a trigger that
      //      genuinely required a board update (button press, AI
      //      reply, etc.). This is a judgment error, not a failure;
      //      we re-prompt with an explicit directive so the next turn
      //      produces buttons.
      //
      // Fusion-feedback retries are a separate path (queued elsewhere)
      // — skip the empty-response/beat retries when fusion was the
      // problem, to avoid double-retrying.
      const isMalformedOrEmpty = result.rawToolCalls.length === 0;
      const hadFusion = !!(result.fusionFeedback && result.fusionFeedback.length > 0);
      const producedRebuild = result.events.some(
        e => e.type === "board_rebuilt"
          || e.type === "board_button_added"
          || e.type === "binary_choice_shown",
      );
      const producedBuilderSuggestions = result.events.some(
        e => e.type === "builder_suggested",
      );
      const onlyNoChange = result.events.length > 0
        && result.events.every(e => e.type === "board_no_change");
      const triggerDemandsRebuild = triggeringEvents.some(
        e => e.type === "button_pressed"
          || e.type === "sentence_composed"
          || e.type === "speech_text_finalized"
          || e.type === "transcribed",
      );
      const stateTriggered = triggeringEvents.length === 0 &&
        (!!this.guessingState || !!this.builderState);
      const stateRequiresOutput = stateTriggered && !producedRebuild && !producedBuilderSuggestions && !hadFusion && onlyNoChange;
      // A REAL no_change tool call (model judged the surface fine) on
      // a trigger that genuinely required a rebuild → judgment-error
      // retry. Distinct from malformed: rawToolCalls.length > 0 here.
      const beatGotNoChange = triggerDemandsRebuild
        && !producedRebuild
        && !hadFusion
        && onlyNoChange
        && !isMalformedOrEmpty;

      if ((isMalformedOrEmpty && !hadFusion) || beatGotNoChange || stateRequiresOutput) {
        const why = isMalformedOrEmpty
          ? `malformed/empty (finish: ${result.finishReason ?? "unknown"})`
          : beatGotNoChange
            ? `no_change on a beat that needed rebuild (${triggeringEvents.map(e => e.type).join("+")})`
            : "state-triggered no-output";
        flowNote("BOARD_MGR", `Queueing retry — ${why}.`);
        this.queueBoardMgrEmptyResponseRetry();
      }
    } catch (err) {
      console.error("[AgentCoordinator] BoardManager invocation failed:", err);
    } finally {
      // Clear the abort handle ONLY if it still points at this
      // invocation's controller. A late stale-abort path could
      // re-assign before our finally runs; we don't want to null out
      // someone else's controller.
      if (this.boardMgrAbortController === controller) {
        this.boardMgrAbortController = null;
      }
      this.boardMgrInFlight = false;
      // Re-invoke if EITHER triggers were queued during the in-flight
      // invocation OR pending feedback is set (retry path —
      // queueBoardMgrEmptyResponseRetry / queueBoardMgrFeedback set
      // pendingFeedback and call invokeBoardManager([]) which, while
      // we're still inFlight, just pushes [] onto pendingTriggers —
      // adding nothing, since push(...[]) is a no-op). Without the
      // feedback check, the retry sets pendingFeedback but the finally
      // block sees zero queued triggers and skips re-entry — the retry
      // is orphaned. (Fusion-correction retries were removed: fused
      // calls are now auto-corrected in parseToolCall and dispatched,
      // and BoardManager is stateless so there's no memory for a retry
      // to fix — see the fusion-detection branch in the try block.)
      const hasFeedback = !!this.boardMgrPendingFeedback;
      const hasTriggers = this.boardMgrPendingTriggers.length > 0;
      if (hasFeedback || hasTriggers) {
        const queued = this.boardMgrPendingTriggers;
        this.boardMgrPendingTriggers = [];
        // Re-enter via microtask to avoid stack growth.
        Promise.resolve().then(() => this.invokeBoardManager(queued));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Board Manager → bus
  // -------------------------------------------------------------------------

  private onBoardManagerEvent(event: BoardManagerOutputEvent): void {
    this.recordEvent(event);
    this.logEvent("BOARD_MANAGER", event);

    switch (event.type) {
      case "board_rebuilt":
        this.applyBoardRebuilt(event);
        return;
      case "board_button_added":
        this.applyBoardButtonAdded(event);
        return;
      case "context_button_added":
        this.applyContextButtonAdded(event);
        return;
      case "binary_choice_shown":
        this.applyBinaryChoiceShown(event);
        return;
      case "builder_suggested":
        this.applyBuilderSuggested(event);
        return;
      case "board_no_change":
        // No-op. Logged via recentEvents only.
        return;
      case "guessing_exit_requested":
        // BoardManager declared narrowing has converged (user confirmed
        // a guess, conversation moved on, etc.). Run the same exit path
        // as a client-initiated cancel, but with the AI's reason for
        // audit + flow-log visibility.
        flowNote("BOARD_MGR", `exit_guessing requested: ${event.reason}`);
        this.clearGuessingState(`ai_exit:${event.reason}`);
        return;
      case "interpret_intent":
        // BoardManager produced a natural-language interpretation of a
        // composed SENTENCE — route to the existing TTS + follow-up
        // pipeline. Server-side gate still applies (drops if the last
        // user input wasn't sentence_composed).
        this.routeInterpretIntent(event);
        return;
      case "monitor_call_requested":
        this.requestMonitor(event.reason, "board-manager");
        return;
      case "private_note":
        // Board Manager is stateless — no point echoing back. Coordinator
        // records it in recentEvents for posterity.
        return;
    }
  }

  private applyBoardRebuilt(event: BoardRebuiltEvent): void {
    // Partition: suggestion buttons (whose `glyph` is a valid
    // `suggestion:dim:value` key) are trusted system-expanded content
    // — they bypass the validator (which would reject them as unknown
    // imageKeys) and are rendered via expandSuggestionKey which
    // attaches the system-provided icon + label. Non-suggestion
    // buttons go through the normal validator.
    type Btn = {
      label: string;
      glyph?: string;
      glyphFallback?: string;
      imageKey?: string;
      iconRef?: string;
      symbolPath?: string;
      [k: string]: unknown;
    };
    const suggestionExpanded: any[] = [];
    const specialButtons: Btn[] = [];     // wordfinder / more — bypass validator
    const regular: Btn[] = [];
    for (const b of event.buttons) {
      const glyph = (b.glyph || "").trim();
      if (glyph && isValidSuggestionKey(glyph)) {
        const expanded = expandSuggestionKey(glyph);
        if (expanded) {
          suggestionExpanded.push(expanded);
          continue;
        }
      }
      const entry: Btn = {
        label: b.label,
        glyph: b.glyph,
        glyphFallback: b.glyphFallback,
        imageKey: b.imageKey,
        iconRef: b.iconRef,
        symbolPath: b.symbolPath,
        sentence: b.sentence,
        speech: b.speech,
        buttonType: b.buttonType,
        narrowDimension: (b as any).narrowDimension,
        narrowValue: (b as any).narrowValue,
        rowSpan: b.rowSpan,
        colSpan: b.colSpan,
      };
      if (b.buttonType === "wordfinder") {
        // Drop the wordfinder entry while already guessing — the entry
        // is a no-op in that state and the gate keeps it off-screen.
        if (this.guessingState !== null) {
          flowNote("COORDINATOR", "rebuild_board: dropping wordfinder button — already in guessing mode.");
          continue;
        }
        specialButtons.push(entry);
      } else if (b.buttonType === "more") {
        specialButtons.push(entry);
      } else {
        regular.push(entry);
      }
    }

    const { buttons: kept, errors } = validateBoardButtons(regular);
    if (errors.length > 0) {
      this.queueBoardMgrFeedback("rebuild_board", errors);
    }
    // When in guessing mode, tag every non-suggestion button as a
    // "guess" so the word-finder UI on the client renders it alongside
    // the system suggestion buttons. The AI's prompt asks it to prefix
    // these labels with [GUESS] but it doesn't always do so reliably —
    // applying the type server-side guarantees they reach the strip.
    if (this.guessingState) {
      for (const b of kept) {
        if (!(b as any).buttonType) (b as any).buttonType = "guess";
      }
    }
    const merged = [...kept, ...specialButtons, ...suggestionExpanded].slice(0, 8);
    if (merged.length === 0) {
      // Nothing renderable in the rebuild — leave the current surface
      // intact rather than wipe the board to empty.
      return;
    }

    // If a custom board is loaded (e.g. the home board pushed at init),
    // the client is in "custom board mode" and ignores `board` updates
    // until the custom board is unloaded.
    if (this.loadedBoardId) {
      this.send({ type: "unload_board", data: {} });
      this.loadedBoardId = null;
    }
    this.currentBoardLabels = merged.map(b => b.label);
    this.currentBoardButtons = merged.map(b => ({ ...b } as MergeButton));
    // Remember who this board's buttons are addressed to. Always default
    // to DEVICE unless BoardManager explicitly set a different target;
    // never inherit from a prior transcript speaker. (BoardManager is
    // told to set target explicitly when the user is replying to a
    // person in the room.)
    this.currentBoardTarget = event.target ?? PARTY_DEVICE;
    this.send({
      type: "board",
      data: buildBoardFromButtons(merged as any),
    });
    void this.applySymbolPipeline(merged as any);
  }

  /**
   * Merge a single incoming button into the current main board via
   * smartMergeButtons. Preserves slot positions for the client's
   * fade-in/fade-out animation; if the board is full, the most-similar
   * (or in the worst case, oldest) existing button is displaced.
   */
  private applyBoardButtonAdded(event: BoardButtonAddedEvent): void {
    const b = event.button;
    // Special-type buttons (wordfinder, more) skip the visual-content
    // validator — they have no glyph or sentence, just a hardcoded marker
    // the client renders with its own styling.
    const isSpecial = b.buttonType === "wordfinder" || b.buttonType === "more";
    if (b.buttonType === "wordfinder" && this.guessingState !== null) {
      // Gate: don't surface a Word Finder entry when one's already active.
      flowNote(
        "COORDINATOR",
        "wordfinder button dropped — already in guessing mode.",
      );
      return;
    }
    if (!isSpecial) {
      // Run the same validator path as add_context_button — drop on
      // structural errors and queue feedback.
      const { buttons: kept, errors } = validateBoardButtons([{
        label: b.label,
        glyph: b.glyph,
        glyphFallback: b.glyphFallback,
        imageKey: b.imageKey,
        iconRef: b.iconRef,
        symbolPath: b.symbolPath,
      }]);
      if (errors.length > 0) {
        this.queueBoardMgrFeedback("add_board_button", errors);
      }
      if (kept.length === 0) return;
    }

    const incoming: MergeButton = {
      label: b.label,
      glyph: b.glyph,
      glyphFallback: b.glyphFallback,
      imageKey: b.imageKey,
      iconRef: b.iconRef,
      symbolPath: b.symbolPath,
      sentence: b.sentence,
      speech: b.speech,
      buttonType: b.buttonType,
      narrowDimension: (b as any).narrowDimension,
      narrowValue: (b as any).narrowValue,
    };

    let newIdCounter = 0;
    const newId = () => `btn-${Date.now()}-${newIdCounter++}`;
    const { merged } = smartMergeButtons(
      this.currentBoardButtons,
      [incoming],
      AgentCoordinator.MAIN_BOARD_MAX,
      newId,
    );
    if (merged.length === 0) return;

    // If a custom board is loaded, unload it before pushing the new merged
    // board — the client only renders dynamic boards otherwise.
    if (this.loadedBoardId) {
      this.send({ type: "unload_board", data: {} });
      this.loadedBoardId = null;
    }
    this.currentBoardLabels = merged.map(m => m.label);
    this.currentBoardButtons = merged.map(m => ({ ...m }));
    if (event.target !== undefined) this.currentBoardTarget = event.target;
    this.send({
      type: "board",
      data: buildBoardFromButtons(merged as any),
    });
    void this.applySymbolPipeline(merged as any);
  }

  private applyContextButtonAdded(event: ContextButtonAddedEvent): void {
    // Same validator — one-button input. Drops on any rule violation
    // and queues feedback for the next invocation.
    const b = event.button;
    const { buttons: kept, errors } = validateBoardButtons([{
      label: b.label,
      glyph: b.glyph,
      glyphFallback: b.glyphFallback,
      imageKey: b.imageKey,
      iconRef: b.iconRef,
      symbolPath: b.symbolPath,
    }]);
    if (errors.length > 0) {
      this.queueBoardMgrFeedback("add_context_button", errors);
    }
    if (kept.length === 0) return;

    this.contextSidebarLabels.push(b.label);
    if (this.contextSidebarLabels.length > 4) {
      this.contextSidebarLabels.shift();
    }
    this.send({
      type: "context_button_add",
      data: {
        label: b.label,
        iconRef: b.iconRef || "fas fa-comment",
        symbolPath: b.symbolPath,
        imageKey: b.imageKey,
        glyph: b.glyph,
        glyphFallback: b.glyphFallback,
        sentence: b.sentence ?? b.speech,
        buttonType: b.buttonType,
      },
    });
    void this.applySymbolPipeline([b]);
  }

  /** Queue a corrective retry when BoardManager produced no tool calls
   *  on a user-input trigger that demanded a rebuild. Same retry-cap as
   *  the validator/fusion paths so a pathological loop can't lock the
   *  agent. */
  private queueBoardMgrEmptyResponseRetry(): void {
    if (this.boardMgrRetryAttempt >= AgentCoordinator.BOARD_MGR_MAX_RETRIES) {
      runInSessionContext(this.sessionId || "?", this.debugMode, () => {
        logLiveSession("BOARD_MGR_EMPTY", `Past retry cap — dropping empty-response retry.`);
      });
      return;
    }
    // Tailor the retry instruction to the current state.
    let directive: string;
    if (this.guessingState) {
      directive = `The user is in word-finder mode. Call \`rebuild_board(buttons=[...])\` using the \`suggestion:dim:value\` keys from the latest [GUESSING STATE] as the ${T.button}s' \`sentence\` fields.`;
    } else if (this.builderState) {
      directive = `The user is composing in the ${T.builder}. Call \`suggest_construction_buttons(slot_index, head_candidates, modifier_candidates)\` with appropriate SYMBOLs.`;
    } else {
      directive = `The user (or someone speaking to them) just took an action — they need response options now. Call \`rebuild_board(buttons=[...])\` with a fresh set of ${T.button}s.`;
    }
    this.boardMgrPendingFeedback =
      `[empty response]\nYour previous response had no tool calls. ${directive} If the current ${T.board} genuinely still fits the moment and no rebuild is warranted, call \`no_change("<short reason>")\` instead — empty responses are never valid.`;
    runInSessionContext(this.sessionId || "?", this.debugMode, () => {
      logLiveSession("BOARD_MGR_EMPTY", `Queued empty-response retry attempt ${this.boardMgrRetryAttempt + 1}/${AgentCoordinator.BOARD_MGR_MAX_RETRIES}.`);
    });
    void this.invokeBoardManager([]);
  }

  /** Queue validator-error feedback for the next BoardManager
   *  invocation, with a retry cap so a pathological response can't
   *  loop forever. */
  private queueBoardMgrFeedback(toolName: string, errors: string[]): void {
    if (this.boardMgrRetryAttempt >= AgentCoordinator.BOARD_MGR_MAX_RETRIES) {
      runInSessionContext(this.sessionId || "?", this.debugMode, () => {
        logLiveSession("BOARD_MGR_VALIDATOR", `Errors past retry cap — dropping. tool=${toolName} errors=${errors.length}`);
      });
      return;
    }
    const header = `[${toolName} — rejected ${T.button}s]`;
    const body = errors.map(e => `• ${e}`).join("\n");
    this.boardMgrPendingFeedback = `${header}\n${body}\n\nRebuild correctly — supply a fallback when sentence uses \`generate:\`, omit the fallback field entirely otherwise, use only canonical modifiers, and give every ${T.button} a unique visual. (If you can't repair the rebuild and the current ${T.board} still fits, call \`no_change("<short reason>")\` instead — don't return empty.)`;
    runInSessionContext(this.sessionId || "?", this.debugMode, () => {
      logLiveSession("BOARD_MGR_VALIDATOR", `${toolName} → ${errors.length} errors, queued retry attempt ${this.boardMgrRetryAttempt + 1}/${AgentCoordinator.BOARD_MGR_MAX_RETRIES}`);
    });
    // Fire a self-rebuild invocation with the feedback. Synthetic
    // trigger lets renderInvocationContext display the retry framing.
    void this.invokeBoardManager([]);
  }

  private applyBinaryChoiceShown(event: BinaryChoiceShownEvent): void {
    // Decide the third "escape" button kind server-side so the client
    // doesn't need to re-derive it from glyph inspection. Mirrors the
    // client's `detectYesNoDefaultColor`: when both options together
    // form a yes/no pair (one yes-tagged, one no-tagged), the escape
    // becomes a yellow "maybe"; otherwise a red "neither of these"
    // (using the `no` symbol). Client renders by the kind only.
    const escapeKind = detectBinaryChoiceEscapeKind(event.option1?.glyph, event.option2?.glyph);
    this.send({
      type: "binary_choice",
      data: { options: [event.option1, event.option2], escapeKind },
    });
  }

  private applyBuilderSuggested(event: BuilderSuggestedEvent): void {
    // Map our typed event to the existing wire shape the AAC client expects.
    // Use parseSinglePipeButton (NOT parseBoardButtons) so a comma inside a
    // label fragment doesn't split the candidate into two empty pieces.
    const toCandidate = (raw: string) => {
      const b = parseSinglePipeButton(raw);
      if (!b) return null;
      return {
        key: b.glyph || b.sentence || b.label,
        label: b.label,
        fallback: b.glyphFallback,
      };
    };
    const heads = (event.headCandidates ?? []).map(toCandidate).filter((c): c is NonNullable<ReturnType<typeof toCandidate>> => c !== null);
    const mods = (event.modifierCandidates ?? []).map(toCandidate).filter((c): c is NonNullable<ReturnType<typeof toCandidate>> => c !== null);
    this.send({
      type: "construction_suggestions",
      data: {
        targetSlot: event.slotIndex,
        headCandidates: heads as any,
        modifierCandidates: mods as any,
        candidates: heads as any,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Monitor integration
  // -------------------------------------------------------------------------

  private requestMonitor(reason: string, source: string): void {
    flowInput("MONITOR", "call_request", `from=${source} reason="${reason}"`);
    this.pendingMonitorCalls.push({ reason, source });
    if (this.monitorCallDedupTimer) return; // already scheduled
    this.monitorCallDedupTimer = setTimeout(() => {
      this.monitorCallDedupTimer = null;
      this.flushMonitorCall();
    }, DEBOUNCE_MONITOR_CALL_MS);
  }

  private async flushMonitorCall(): Promise<void> {
    if (!this.sessionId || this.pendingMonitorCalls.length === 0) return;
    const calls = this.pendingMonitorCalls;
    this.pendingMonitorCalls = [];
    const combinedReason = calls
      .map(c => `(${c.source}) ${c.reason}`)
      .join(" | ");
    flowNote("MONITOR", `Invoking monitor — ${combinedReason}`);
    console.log(`[AgentCoordinator] Monitor call: ${combinedReason}`);
    const t0 = Date.now();
    try {
      await dualAgentService.triggerMonitor(this.sessionId, /* force */ true);
      flowNote("MONITOR", `Monitor invocation completed in ${Date.now() - t0}ms`);
      // Response is broadcast via state.onContextInjection which we wired up
      // in handleInitialize.
    } catch (err) {
      flowNote("MONITOR", `Monitor invocation failed: ${(err as Error).message}`);
      console.error("[AgentCoordinator] Monitor invocation failed:", err);
    }
  }

  private broadcastMonitorContext(text: string): void {
    const event: MonitorBroadcastEvent = {
      type: "monitor_broadcast",
      source: "monitor",
      timestamp: Date.now(),
      contextInjection: text,
    };
    this.recordEvent(event);

    flowOutput("MONITOR", "broadcast", text);
    const rendered = `[MONITOR CONTEXT] ${text}`;
    this.observer?.sendContextInjection(rendered);
    this.speaker?.sendContextInjection(rendered);
    // Board Manager picks it up on its next invocation via recentEvents.
  }

  // -------------------------------------------------------------------------
  // Session summarizing
  // -------------------------------------------------------------------------

  /** Append a conversational turn to the rolling log and check whether a
   *  new summary is due. Also pushes the turn into the session's
   *  pendingMessages queue so Monitor can process it on its next run —
   *  without this the three-agent path never feeds Monitor, and
   *  Student_Notes / Student_Interests / Student_People never update
   *  (the queue Monitor reads from stays permanently empty). Mirrors
   *  the legacy LiveRelay's addPendingMessage calls in every turn-end
   *  path. */
  private appendToConversationLog(role: "user" | "assistant" | "system", content: string): void {
    this.conversationLog.push({ role, content });
    this.maybeProduceSessionSummary();
    if (this.sessionId) {
      // Fire-and-forget — Monitor's atomic DB-pending lock handles
      // concurrency. A failure here is non-fatal; we already have the
      // turn in conversationLog for summary purposes.
      dualAgentService
        .addPendingMessage(this.sessionId, { role, content, timestamp: Date.now() })
        .catch(err => {
          console.warn("[AgentCoordinator] addPendingMessage failed:", (err as Error).message);
        });
    }
  }

  /** Fire a summarizer call when enough new turns have landed. Async
   *  fire-and-forget; injection happens when the LLM call resolves. */
  private maybeProduceSessionSummary(): void {
    if (!this.sessionId || this.summaryInFlight) return;
    const total = this.conversationLog.length;
    if (total - this.summarizedMsgCount < SUMMARY_EVERY_N_MESSAGES) return;

    const cache = dualAgentService.getSessionCache(this.sessionId);
    const monitor: any = cache?.monitorAgent;
    if (!monitor?.produceSessionSummary) return;

    const newMessages = this.conversationLog.slice(this.summarizedMsgCount);
    const markCount = total;
    this.summaryInFlight = true;
    flowInput("MONITOR", "summarize_request", `${newMessages.length} new msgs (total=${total})`);
    const summaryT0 = Date.now();
    monitor
      .produceSessionSummary(this.currentSessionSummary, newMessages)
      .then((result: { summary?: string; usage?: { provider: any; model: string; promptTokens: number; completionTokens: number; cachedTokens?: number; cacheCreationTokens?: number } }) => {
        this.summaryInFlight = false;
        // Bill credits regardless of whether the summary changed — the
        // LLM call still happened and tokens were consumed.
        if (result.usage && this.sessionId && this.studentId) {
          dualAgentService.trackHttpUsage(
            this.sessionId,
            this.studentId,
            this.userId,
            result.usage.provider,
            result.usage.model,
            result.usage.promptTokens,
            result.usage.completionTokens,
            result.usage.cachedTokens ?? 0,
            "monitor-summary",
            result.usage.cacheCreationTokens ?? 0,
          ).catch(err => console.error("[AgentCoordinator] trackHttpUsage(summary) failed:", err));
        }
        const summary = result.summary;
        if (!summary || summary === this.currentSessionSummary) {
          flowNote("MONITOR", `summarize: no change after ${Date.now() - summaryT0}ms`);
          // Advance the marker so we don't re-summarize the same batch.
          this.summarizedMsgCount = markCount;
          return;
        }
        this.currentSessionSummary = summary;
        this.summarizedMsgCount = markCount;
        flowOutput("MONITOR", "session_summary", `${summary.length} chars (${Date.now() - summaryT0}ms)`);
        // Mirror onto session state so reconnects / profile-switches see
        // the latest summary in their prompt rebuild.
        if (cache?.state) cache.state.sessionSummary = summary;
        // Inject so the live agents see it before their next reconnect.
        const injection = `[SESSION SUMMARY]\n${summary}`;
        this.observer?.sendContextInjection(injection);
        this.speaker?.sendContextInjection(injection);
        runInSessionContext(this.sessionId!, this.debugMode, () => {
          logLiveSession("SESSION_SUMMARY_INJECTED", `${summary.length} chars, summarized ${markCount} msgs`);
        });
      })
      .catch((err: Error) => {
        this.summaryInFlight = false;
        flowNote("MONITOR", `summarize failed: ${err.message}`);
        console.warn(`[AgentCoordinator] session summary failed:`, err.message);
      });
  }

  // -------------------------------------------------------------------------
  // Symbol-generation pipeline
  // -------------------------------------------------------------------------

  /**
   * For each generate:KEY symbol referenced in `buttons`:
   *   1. Look up existing matching custom symbols in the DB.
   *   2. Push immediate `construction_symbol_ready` messages for any
   *      that already resolved (so glyph parts render right away).
   *   3. Queue generation for the unresolved keys. Each generation
   *      callback emits a `symbol_update` (top-level button) or a
   *      `construction_symbol_ready` (in-glyph part) WS message.
   *
   * Fire-and-forget — the buttons render with their fallback in the
   * meantime; generation is async.
   */
  private async applySymbolPipeline(
    buttons: Array<{ label?: string; glyph?: string; glyphFallback?: string }>,
  ): Promise<void> {
    const { generateSymbols, useApprovedSymbols, useUnapprovedSymbols } = this.symbolSettings;
    if (!generateSymbols && !useApprovedSymbols && !useUnapprovedSymbols) return;

    // ── Top-level button imageKeys (single-slot glyphs) ──────────────────
    // Extract any bare imageKey from each button's glyph (single slot,
    // not emoji, not symbol:/face:). resolveImageKeys looks them up and
    // mutates the array; we then queue generation for unresolved ones.
    const buttonShapes: Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string }> = [];
    const keyToLabel = new Map<string, string>();
    for (const b of buttons) {
      if (!b.glyph) continue;
      const slots = b.glyph.split("+").map(s => s.trim()).filter(Boolean);
      if (slots.length !== 1) continue; // multi-glyph SENTENCEs handled below
      const head = slots[0].split(".")[0].split("(")[0].replace(/^\[|\]$/g, "");
      const isEmoji = /^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u.test(head);
      if (!head || isEmoji || head.startsWith("symbol:") || head.startsWith("face:")) continue;
      buttonShapes.push({ label: b.label || head, iconRef: "", imageKey: head });
      keyToLabel.set(head, b.label || head);
    }
    if (buttonShapes.length > 0 && (useApprovedSymbols || useUnapprovedSymbols)) {
      try {
        const unresolved = await resolveImageKeys(buttonShapes, {
          symbolPathFormat: "internal",
          useUnapproved: useUnapprovedSymbols,
        });
        if (generateSymbols && unresolved.length > 0) {
          queueSymbolGeneration(unresolved, (imageKey, symbol) => {
            const label = keyToLabel.get(imageKey) || imageKey;
            this.send({
              type: "symbol_update",
              data: { buttonLabel: label, symbolPath: `__SYMBOL__:${symbol.id}` },
            });
          });
        }
      } catch (err) {
        console.warn("[AgentCoordinator] top-level symbol resolution failed:", (err as Error).message);
      }
    }

    // ── Multi-slot glyph parts ───────────────────────────────────────────
    // Collect every distinct imageKey referenced inside a multi-glyph
    // SENTENCE. Resolved ones broadcast as `construction_symbol_ready`
    // right away; unresolved ones go through the generation queue and
    // broadcast the same event when they land.
    const partKeys = new Set<string>();
    for (const b of buttons) {
      if (b.glyph) collectGlyphImageKeys(b.glyph, partKeys);
    }
    if (partKeys.size === 0) return;

    const synthesized: Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string }> =
      Array.from(partKeys).map(k => ({ label: k, iconRef: "", imageKey: k }));

    let unresolved: string[] = Array.from(partKeys);
    if (useApprovedSymbols || useUnapprovedSymbols) {
      try {
        unresolved = await resolveImageKeys(synthesized, {
          symbolPathFormat: "api-path",
          useUnapproved: useUnapprovedSymbols,
        });
      } catch (err) {
        console.warn("[AgentCoordinator] glyph-part resolution failed:", (err as Error).message);
      }
    }

    for (const b of synthesized) {
      if (b.imageKey && b.symbolPath) {
        this.send({
          type: "construction_symbol_ready",
          data: { imageKey: b.imageKey, symbolPath: b.symbolPath },
        });
      }
    }

    if (generateSymbols && unresolved.length > 0) {
      queueSymbolGeneration(unresolved, (imageKey, symbol) => {
        this.send({
          type: "construction_symbol_ready",
          data: { imageKey, symbolPath: `/api/custom-symbols/${symbol.id}/image` },
        });
      });
    }
  }

  // -------------------------------------------------------------------------
  // Cost tracking
  // -------------------------------------------------------------------------

  /** Fire-and-forget credit charge per agent turn. Failures are logged
   *  inside dualAgentService and must not interrupt the session. */
  private trackLiveUsage(
    agent: "observer" | "speaker" | "board-manager",
    provider: string,
    model: string,
    usage: import("./live-provider").LiveUsage,
  ): void {
    if (!this.sessionId || !this.studentId) return;
    dualAgentService
      .trackLiveUsage(
        this.sessionId,
        this.studentId,
        this.userId,
        provider as any,
        model,            // real catalog model id — used for PRICING
        usage,
        `${agent}:${model}`,  // attribution label — used for the cost LOG only
      )
      .catch(err => console.error(`[AgentCoordinator] trackLiveUsage(${agent}) failed:`, err));
  }

  // -------------------------------------------------------------------------
  // Bookkeeping
  // -------------------------------------------------------------------------

  private recordEvent(event: AgentEvent): void {
    this.recentEvents.push(event);
    if (this.recentEvents.length > RECENT_EVENTS_WINDOW) {
      this.recentEvents.splice(0, this.recentEvents.length - RECENT_EVENTS_WINDOW);
    }
  }

  /** Log a routed event. Wrapped in session context so debug-mode rows
   *  land in session_debug_logs too. */
  private logEvent(agentLabel: string, event: AgentEvent): void {
    if (!this.sessionId) return;
    runInSessionContext(this.sessionId, this.debugMode, () => {
      logDualAgent(`${agentLabel} → ${event.type}`, { event });
    });
  }

  // -------------------------------------------------------------------------
  // Send-to-client helpers
  // -------------------------------------------------------------------------

  private send(msg: ServerMessage): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error("[AgentCoordinator] ws.send failed:", err);
    }
  }

  private sendError(text: string): void {
    this.send({ type: "error", data: text });
  }
}

// ---------------------------------------------------------------------------
// WebSocket setup — parallel to setupLiveWebSocket. The wiring in Task #9
// decides which entry point the client connects to (per-student flag).
// ---------------------------------------------------------------------------

export function setupCoordinatorWebSocket(server: import("http").Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    if (url.pathname !== "/ws/live-v2") return;

    const user = await authenticateUpgrade(req);
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket as any, head as any, (ws) => {
      console.log(`[AgentCoordinator] New WebSocket connection user=${user.id}`);
      new AgentCoordinator(ws as any, user);
    });
  });

  console.log("[AgentCoordinator] WebSocket server ready on /ws/live-v2");
}
