// server/services/dual-agent/live-relay-v2.ts
// WebSocket relay layer v2: bridges a client WebSocket to a live provider session.
// Clean rewrite with explicit state machine replacing boolean guard flags.
// Handles tool call dispatch, TTS synthesis, contact enrollment, monitor triggering.

import type { IncomingMessage } from "http";
import { randomBytes } from "crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { User } from "@shared/schema";
import { authenticateUpgrade } from "../realtime/ws-auth";
import { studentService } from "../studentService";
import type {
  LiveProvider,
  LiveProviderCallbacks,
  LiveProviderConfig,
  ToolCall,
  ToolResponse,
} from "./live-provider";
import { GeminiLiveProvider } from "./gemini-live-provider";
import { parseBoardButtons } from "./interactive-agent";
import { getAppDefinition, APP_REGISTRY } from "./app-registry";
import { buildDefaultHomeBoard, HOME_BOARD_KEY } from "./default-home-board";
import type {
  AACMuteState,
  AACResponseMode,
  DualAgentSessionState,
  TurnToolAccumulator,
} from "./types";
import { createEmptyAccumulator } from "./types";
import { buildToolDeclarations, type ToolDeclarationConfig } from "./tool-declarations";
import { ttsFacade, type ResolvedVoice } from "../voice/tts-facade";
import { GeminiLiveTtsSession } from "../voice/gemini-live-tts-service";
import { searchYouTube } from "../youtube/youtube-search";
import { searchSpotify } from "../spotify/spotify-search";
import {
  findMatchingFace,
  recordContactSighting,
  type FaceMatchResult,
} from "../biometric/recognition-service";
import { logDualAgent, logLiveSession } from "./dual-agent-logger";
import { activityLogService } from "../activityLogService";
import { recordUtterance } from "../insurance/utteranceLogger";
import { dualAgentService, type SessionCache } from "./dual-agent-service";
import { buildInteractiveAgentPrompt, AAC_DEFAULT_PERSONA_PROMPT } from "../memory-schema/aac-memory-schema";
import { boardRepository } from "../../repositories/boardRepository";
import { customAppRepository } from "../../repositories/customAppRepository";
import { validateCustomAppDefinition } from "@shared/custom-app-validator";
import type { PermittedWebsite } from "@shared/schema";
import { isUrlPermitted, mergeBoardWebsitesIntoPermitted } from "@shared/permitted-websites";
import { fetchRecentVideosForChannels } from "../youtube/channel-search";
import { licenseService } from "../licenseService";
import { settingsRepository } from "../../repositories/settingsRepository";
import { aacSettingsRepository } from "../../repositories/aacSettingsRepository";
import { resolveImageKeys, queueSymbolGeneration } from "../symbol/auto-symbol-service";
import { MODEL_OPTIONS, type LLMProviderKey } from "@shared/llm-options";

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Keys that are never the "real content" of a tool call — skip during fallback. */
const EXTRACT_SKIP_KEYS = new Set(["id", "status", "confidence", "speaker", "type", "name"]);

/** Extract a string argument from tool call args.
 *  Gemini's native function calling frequently uses wrong parameter names
 *  (e.g. "board_name" instead of "name", "observations" instead of "text").
 *  Falls back to the first non-ID string value in the args object. */
function extractStringArg(args: Record<string, any>, declaredName: string, fallback = ""): string {
  if (typeof args[declaredName] === "string") return args[declaredName];
  // Fall back: find the first string value that looks like actual content
  for (const [key, val] of Object.entries(args)) {
    if (EXTRACT_SKIP_KEYS.has(key)) continue;
    if (typeof val === "string" && val.length > 0) return val;
  }
  return fallback;
}

/** Stringify a WebSocket message for logging. Truncates large base64 strings inline
 *  but keeps the rest of the object structure intact so we see real content. */
function stringifyMsg(msg: any): string {
  return JSON.stringify(msg, (_key, value) => {
    if (typeof value === "string" && value.length > 200) {
      return `[${value.length} chars]`;
    }
    return value;
  });
}

/** Convert tool-call button args to internal format.
 *  Accepts multiple formats the model may produce:
 *  - String (preferred):  "Play|🎮, Water|💧, Help|face:abc123"  (parseBoardButtons format)
 *  - Array of strings:    ["Play|🎮", "Water|💧"]  (fallback — join and parse)
 *  - Object array:        [{label, icon}]  (OpenAI / legacy) */
function toolArgsToButtons(raw: unknown): Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string; sentence?: string; buttonType?: "guess" | "category"; rowSpan?: number; colSpan?: number }> {
  // String — the expected format from native audio models: "label|icon, label|icon"
  if (typeof raw === "string") {
    return parseBoardButtons(raw as string);
  }

  if (!Array.isArray(raw) || raw.length === 0) return [];

  // Array of strings — join into comma-separated and parse
  if (typeof raw[0] === "string") {
    const joined = raw.map((s: any) => String(s).trim()).filter(Boolean).join(", ");
    return parseBoardButtons(joined);
  }

  // Object array — OpenAI / legacy Gemini format
  return raw.map((b: any) => {
    const label = (typeof b?.label === "string" ? b.label : String(b?.label ?? "")).trim() || "?";
    let iconRef = (typeof b?.icon === "string" ? b.icon : "").trim() || "💬";
    let symbolPath: string | undefined;
    const imageKey = (typeof b?.image_key === "string" ? b.image_key : "").trim() || undefined;
    const sentence = (typeof b?.sentence === "string" ? b.sentence : "").trim() || undefined;
    const rawRowSpan = typeof b?.row_span === "number" ? b.row_span : parseInt(b?.row_span, 10);
    const rawColSpan = typeof b?.col_span === "number" ? b.col_span : parseInt(b?.col_span, 10);
    const rowSpan = rawRowSpan >= 2 ? rawRowSpan : undefined;
    const colSpan = rawColSpan >= 2 ? rawColSpan : undefined;
    if (iconRef.startsWith("face:")) {
      symbolPath = `__FACE__:${iconRef.substring(5).trim()}`;
      iconRef = "👤";
    } else if (iconRef.startsWith("symbol:")) {
      symbolPath = `__SYMBOL__:${iconRef.substring(7).trim()}`;
      iconRef = "🖼️";
    }
    return { label, iconRef, symbolPath, imageKey: symbolPath ? undefined : imageKey, sentence, rowSpan, colSpan };
  });
}

/**
 * When the model violates the "unique imageKey per board" rule and gives two
 * buttons the same imageKey, both buttons resolve to the identical cached
 * symbol — the user sees duplicate images. Detect that case and append a
 * label-derived slug to subsequent duplicates so each routes to its own
 * symbol slot (and triggers fresh symbol generation for the duplicates).
 */
function dedupeImageKeys<T extends { label: string; imageKey?: string }>(buttons: T[]): T[] {
  const seen = new Map<string, number>();
  const collisions: string[] = [];
  for (const btn of buttons) {
    if (!btn.imageKey) continue;
    const key = btn.imageKey;
    const count = seen.get(key) ?? 0;
    if (count > 0) {
      const slug = btn.label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 24) || `dup${count}`;
      btn.imageKey = `${key}_${slug}`;
      collisions.push(`${key} → ${btn.imageKey}`);
    }
    seen.set(key, count + 1);
  }
  if (collisions.length > 0) {
    logLiveSession(
      "IMAGEKEY_DEDUP",
      `Model produced duplicate imageKeys; rewriting: ${collisions.join("; ")}`,
    );
  }
  return buttons;
}

/**
 * Format a construction-board state snapshot as a [CONSTRUCTION STATE]
 * context injection. Compact and structured so the model can quickly route
 * to the suggest_construction_buttons tool.
 */
function formatConstructionStateInjection(state: ConstructionStateWire): string {
  const filled = state.glyph ? state.glyph : "(empty)";
  const lines: string[] = [
    "[CONSTRUCTION STATE]",
    `category: ${state.category}`,
    `mode_chip: ${state.modeChip}`,
    `glyph: ${filled}`,
    `target_slot: ${state.targetSlot ?? "next_empty"}`,
  ];
  if (state.excludeKeys.length > 0) {
    lines.push(`exclude_keys: ${state.excludeKeys.join(", ")}`);
  }
  lines.push("");
  if (state.requestGuessingMode) {
    lines.push(
      `The student pressed Help — enter guessing mode (see <guessing_mode>) to narrow down what they want to put in the target slot. When you've narrowed enough, call suggest_construction_buttons with the resolved key as the single candidate to populate the slot directly.`
    );
  } else {
    lines.push(
      "Call suggest_construction_buttons with up to 4 candidates for the target slot. Skip if nothing helpful comes to mind."
    );
  }
  return lines.join("\n");
}

/** Convert raw PCM buffer (16-bit LE, mono) to a WAV buffer by prepending a 44-byte header */
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

// ---------------------------------------------------------------------------
// Gemini voice mapping for direct audio mode
// ---------------------------------------------------------------------------

/** Map VoiceType to Gemini prebuilt voice names */
const GEMINI_VOICE_MAP: Record<string, string> = {
  man:   "Orus",
  woman: "Zephyr",
  boy:   "Puck",
  girl:  "Leda",
};

// ---------------------------------------------------------------------------
// Client ↔ Server Protocol
// ---------------------------------------------------------------------------

/** Messages from client → server */
export type ClientMessage =
  | { type: "initialize"; studentId: string; userId?: string; sessionId?: string; muteState?: AACMuteState; responseMode?: AACResponseMode; debugMode?: boolean; initialFrame?: string; timezone?: string }
  | { type: "frame_grid"; data: string; timestamps?: number[]; gestureContext?: string; triggerReason?: string }    // base64 JPEG
  | { type: "audio_clip"; data: string; mimeType?: string }        // base64 audio (ignored in live mode — Gemini hears PCM directly)
  | { type: "pcm_audio"; data: string }                            // base64 raw PCM Int16 16kHz — streamed directly to Gemini
  | { type: "user_message"; text: string }
  | { type: "voice_audio"; data: string; mimeType?: string }       // base64 webm (ignored in live mode — Gemini hears PCM directly)
  | { type: "button_press"; buttons: string[]; sentences?: Record<string, string>; board?: any }
  | { type: "board_exit"; label: string; instruction: string }  // exit button pressed on loaded board
  | { type: "gesture_context"; data: string }
  | { type: "person_context"; data: any }
  | { type: "board_state"; data: any }
  | { type: "set_mute_state"; muteState: AACMuteState }
  | { type: "set_response_mode"; mode: AACResponseMode }
  | { type: "unknown_face_descriptors"; data: Array<{ descriptor: number[]; boundingBox?: { x: number; y: number; w: number; h: number }; cameraRole?: "user" | "environment" | "unknown"; cameraLabel?: string }> }
  | { type: "page_navigate"; pageId: string; pageName: string; buttons: string[] }
  | { type: "app_dismissed"; appId: string }
  | { type: "app_canvas"; data: string }                     // base64 PNG — app canvas (e.g. drawing)
  | { type: "focus_frame"; data: string }                    // base64 JPEG — high-res focus frame
  | { type: "set_paused"; paused: boolean }
  | { type: "local_state"; snapshot: import("@shared/aac-local-storage").AacSessionSnapshot }
  | { type: "context_injection"; text: string }           // inject context without triggering a response
  | { type: "client_sleep_state_change"; state: "hibernation" | "waking" | "awake" | "resting" | "asleep"; source: "ai" | "system" | "user" }   // engagement state machine transition (server logs for RTM service-time)
  | { type: "construction_state"; data: ConstructionStateWire };  // sentence construction board state changed — relay formats as context injection

/** Messages from server → client */
export type ServerMessage =
  | { type: "initialized"; sessionId: string }
  | { type: "text"; data: string; noAudioClear?: boolean }
  | { type: "speak"; text: string; audio?: string }
  | { type: "interpret"; text: string; audio?: string; confidence?: string; noAudioClear?: boolean }
  | { type: "board_patch"; data: any }
  | { type: "board"; data: any }
  | { type: "transcript"; data: string; speaker?: string; confidence?: string }
  | { type: "context"; data: string }
  | { type: "emote"; data: string }
  | { type: "interaction_mode_changed"; data: { mode: string; reason?: string; source: "ai" | "user" } }
  | { type: "video_play"; data: any }
  | { type: "app_open"; data: any }
  | { type: "app_close"; data: any }
  | { type: "set_board"; data: { board: any; name: string; boardId: string } }
  | { type: "unload_board"; data: any }
  | { type: "ai_button_press"; data: { label: string; action: string; targetPageId: string; targetPageName: string; buttons: any[] } }
  | { type: "debug"; data: any }
  | { type: "error"; data: string }
  | { type: "thinking"; active: boolean }
  | { type: "avatar_audio"; data: string; format?: "mp3" | "wav" }  // base64 audio chunk (AI voice TTS — avatar mouth animates)
  | { type: "interpretation_audio"; data: string }     // base64 audio chunk (student voice TTS)
  | { type: "monitor_status"; data: any }
  | { type: "audio_interrupt" }                          // Stop client audio playback (model interrupted by user)
  | { type: "audio_clear_tag"; tag: string }             // Clear queued client audio for a specific tag (e.g. "interpret")
  | { type: "yes_no"; data: any }                        // Yes/No question detected — trigger overlay
  | { type: "ask_yes_no"; data: any }                    // Deferred Yes/No — show after TTS playback
  | { type: "reconnecting"; data: string }               // Server is reconnecting to Gemini
  | { type: "client_tts"; data: { text: string; voiceId: string; apiKey: string; language: string; voiceRole: "ai" | "student" } }
  | { type: "client_local_tts"; data: { text: string; language: string; voiceRole: "ai" | "student" } }
  | { type: "reconnected" }                              // Reconnection successful
  | { type: "session_reset"; sessionId: string }         // New session created after repeated failures
  | { type: "rate_limited"; data: string }               // Rate limited — client should NOT auto-reconnect
  | { type: "safety_blocked"; data: string }             // Safety/policy block — transient indicator
  | { type: "focus_request"; data: { reason: string } }  // AI requests a high-res focus frame
  | { type: "session_snapshot"; snapshot: import("@shared/aac-local-storage").AacSessionSnapshot; config: import("@shared/aac-local-storage").AacLocalStorageConfig }
  | { type: "symbol_update"; data: { buttonLabel: string; symbolPath: string } }  // Auto-generated symbol ready — update button
  | { type: "context_button_add"; data: any }                 // Add one button to context sidebar (scrolls oldest out)
  | { type: "context_button_remove"; data: { label: string } } // Remove a button from the context sidebar by label
  | { type: "guessing_mode"; active: boolean }              // Guessing mode entered/exited
  | { type: "people_identified"; data: IdentifiedFaceWire[] } // Server-side face matching results
  | { type: "sleep_state_change"; data: { state: "hibernation" | "waking" | "awake" | "resting" | "asleep"; source: "ai" | "system" } }  // AI-driven sleep state change
  | { type: "false_wake_report"; data: { reason: string } }   // AI flagged the recent wake from Asleep as a false alarm
  | { type: "construction_suggestions"; data: ConstructionSuggestionsWire }  // AI's response to a construction_state injection — populates the AI strip
  | { type: "construction_memory_chips"; data: ConstructionMemoryChipsWire }  // AI-curated dynamic chips for one tab on the construction board
  | { type: "complete"; data?: any };

/** Construction-board state forwarded to the AI as context, on every relevant change. */
export interface ConstructionStateWire {
  category: "who" | "do" | "what" | "where" | "when";
  modeChip: string;
  /** Serialized glyph string ("i_me+want+water.big#question"). */
  glyph: string;
  /** Slot index currently selected by the user, or null. */
  activeSlot: number | null;
  /** Slot index the AI should suggest for (null = next empty slot). */
  targetSlot: number | null;
  /** Keys already shown for this slot — AI should not repeat them. */
  excludeKeys: string[];
  /** When true, the student has requested help — AI should enter guessing mode. */
  requestGuessingMode?: boolean;
}

/** AI's suggestion payload — routed back to the construction board's AI strip. */
export interface ConstructionSuggestionsWire {
  targetSlot: number;
  candidates: Array<{ key: string; label?: string }>;
}

/** AI's memory-driven mode chips for one category tab. */
export interface ConstructionMemoryChipsWire {
  category: "who" | "do" | "what" | "where" | "when";
  chips: Array<{ key: string; label: string }>;
}

/** Public wire format for an identified face (server → client). */
export interface IdentifiedFaceWire {
  /** Index of the face within the descriptor batch (matches client face index when available). */
  faceIndex: number;
  /** True if matched to a known person above the confidence threshold. */
  matched: boolean;
  /** Display name — known person's name, or "Unknown #N" when no match. */
  name: string;
  /** Underlying entity type when matched. */
  entityType?: "student" | "user" | "contact";
  /** Entity id (contact id, user id, or student id) when matched. */
  entityId?: string;
  /** Relationship label (e.g. "mother", "teacher") when matched. */
  relationship?: string;
  /** Match confidence in [0,1]. 0 when unmatched. */
  confidence: number;
  /** Bounding box from the client detection, if provided. */
  boundingBox?: { x: number; y: number; w: number; h: number };
  /** Which camera saw this face — "user" = facing the student (gesture-tracked), "environment" = elsewhere. */
  cameraRole?: "user" | "environment" | "unknown";
  /** Human-readable camera label (for debug). */
  cameraLabel?: string;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type RelayState =
  | "initializing"     // handleInitialize is running
  | "idle"             // ready for input
  | "awaiting_turn"    // sent a turnComplete=true, waiting for model to start responding
  | "in_turn"          // model is making tool calls (between first tool call and TURN_COMPLETE)
  | "processing_turn"  // processTurnEnd is running (TTS, persistence, etc.)
  | "closed";          // session ended

// ---------------------------------------------------------------------------
// LiveRelay — one instance per client WebSocket connection
// ---------------------------------------------------------------------------

export class LiveRelay {
  // Core state
  private state: RelayState = "initializing";
  private ws: WebSocket;
  private provider: LiveProvider | null = null;

  // Session
  private studentId: string | null = null;
  private userId: string | undefined = undefined;
  private sessionId: string | null = null;
  private sessionCache: SessionCache | null = null;
  private muteState: AACMuteState = "unmuted";
  private responseMode: AACResponseMode = "fast";
  private paused = false;
  private debugMode = false;
  /** Client-reported IANA timezone for this session; injected into AI prompts. */
  private timezone: string | undefined = undefined;
  /** Last known sleep state for this session — set whenever client or AI reports a transition. */
  private lastSleepState: "hibernation" | "waking" | "awake" | "resting" | "asleep" = "awake";

  // Voice
  private aiVoice: ResolvedVoice | null = null;
  private studentVoice: ResolvedVoice | null = null;
  private studentTtsSession: GeminiLiveTtsSession | null = null;
  private useLocalTts = false;
  private useDirectAudio = false;

  // Provider/model in use for this session — set at connect() time and read
  // by the usage tracker so credit charges attribute to the right model.
  private currentLiveProvider: LLMProviderKey | null = null;
  private currentLiveModel: string | null = null;

  // Greeting
  private initialConnectionDone = false;
  private pendingGreeting: { prompt: string; frame?: string } | null = null;
  private hasGreeted = false;
  // Whether the AI has greeted within the current "interact window". Reset
  // on wake from hibernation so the AI greets again when re-entering interact
  // mode after the device was put to sleep.
  private hasGreetedInteract = false;
  // Defer the initial set_board(home) send to the client until the model is
  // actually ready (onReady fires). Otherwise the home board buttons appear
  // before the model can handle them and clicks get dropped or queued.
  private pendingHomeBoardSend = false;

  // Turn accumulation
  private turnAccum: TurnToolAccumulator = createEmptyAccumulator();

  // Contact enrollment
  private unknownFaceDescriptors: Array<{ descriptor: number[]; boundingBox?: { x: number; y: number; w: number; h: number } }> = [];

  // Server-side face recognition — populated when the client sends face descriptors.
  // Used both to inject "[PEOPLE PRESENT]" context into the model and to render the
  // identified-people debug list on the client.
  private currentIdentifiedFaces: IdentifiedFaceWire[] = [];
  private currentIdentifiedFacesAt = 0;
  /** Per-contact rate limit for `recordContactSighting()` — keyed by contact id. */
  private lastSightingBumpAt: Map<string, number> = new Map();
  /** TTL after which the identified-faces list is considered stale and dropped. */
  private static readonly IDENTIFIED_FACES_TTL_MS = 30_000;
  /** Minimum gap between sighting bumps for the same contact. */
  private static readonly SIGHTING_BUMP_INTERVAL_MS = 60_000;

  // App canvas
  private latestAppCanvas: string | null = null;

  // Board tracking
  private lastBoardUpdateTime = 0;

  // Symbol settings
  private symbolSettings = { generateSymbols: false, useApprovedSymbols: false, useUnapprovedSymbols: false };

  // Local storage
  private localStorageConfig: import("@shared/aac-local-storage").AacLocalStorageConfig | null = null;
  private pendingLocalState: import("@shared/aac-local-storage").AacSessionSnapshot | null = null;

  // Reconnection
  private reconnectAttempts = 0;
  private consecutiveSafetyBlocks = 0;
  private static readonly MAX_RECONNECT_BEFORE_RESET = 2;

  // Timers
  private boardReminderTimer: ReturnType<typeof setInterval> | null = null;
  private behavioralReminderTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private pongReceived = true;

  // Timer intervals
  private static readonly BOARD_REMINDER_INTERVAL_MS = 45_000;
  private static readonly BEHAVIORAL_REMINDER_INTERVAL_MS = 180_000;
  private static readonly PING_INTERVAL_MS = 30_000;
  private static readonly SNAPSHOT_INTERVAL_MS = 30_000;

  // Default home board data (virtual — not stored in DB)
  private homeBoardData: import("@shared/schema").ParsedBoardData | null = null;

  // Context sidebar buttons (server-side tracking, last 4 visible)
  private contextButtonLabels: string[] = [];

  // Guessing mode tracking
  private guessingMode = false;

  // Pre-generated student TTS (for button presses)
  private preGenTtsPromise: Promise<void> | null = null;
  private studentTtsAbortController: AbortController | null = null;

  // Pending prompt — if the model produces an empty turn after a button press
  // or user message, we retry with this prompt (proactiveAudio can swallow
  // turns when audio-triggered generation coincides with our text message).
  private pendingRetryPrompt: string | null = null;

  // Direct audio buffering — chunks accumulate and flush every 250ms as WAV
  private directAudioChunks: string[] = [];
  private directAudioFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly AUDIO_FLUSH_INTERVAL_MS = 250;
  // Track when the last audio chunk arrived — visual checks are suppressed during active speech
  private lastAudioChunkAt = 0;
  private static readonly AUDIO_COOLDOWN_MS = 3000;

  // Silence keepalive — Gemini's native audio model expects a continuous stream.
  // When the client isn't sending PCM (e.g. mic not yet started, mic muted), we
  // send silent PCM to keep the model from hallucinating spontaneous turns.
  private lastClientPcmAt = 0;
  private silenceKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly SILENCE_KEEPALIVE_MS = 100;     // ~100ms chunks
  private static readonly CLIENT_PCM_TIMEOUT_MS = 200;    // send silence if no client PCM for 200ms
  // 100ms of silent 16kHz mono Int16 PCM = 1600 samples * 2 bytes = 3200 bytes (zeroed)
  private static readonly SILENCE_PCM_BASE64 = Buffer.alloc(3200).toString("base64");

  // Pending queue for client messages received while the AI is generating.
  // Without this queue, button presses during in_turn/processing_turn states are
  // silently dropped, causing buttons to "fail" while the AI is responding.
  private pendingClientMessages: ClientMessage[] = [];

  // When true, the next model turn is a debug introspection response — the
  // model is telling us, in plain text, what it just tried to do (after a
  // MALFORMED_FUNCTION_CALL). We capture the text into debugResponseBuffer
  // and don't forward audio to the client.
  private awaitingDebugResponse = false;
  private debugResponseBuffer = "";
  // Number of times we've asked the model to retry after an abnormal turn.
  private debugRetryCount = 0;
  private static readonly DEBUG_MAX_RETRIES = 2;
  // Cooldown after RESPONSE_REJECTED exhaustion — prevents frame_grid from
  // immediately re-triggering and causing the model to repeat the same
  // rejected content in a tight loop.
  private rejectionCooldownUntil = 0;
  private static readonly REJECTION_COOLDOWN_MS = 15_000;

  // Set when we've just sent an auto-continuation prompt (because the model
  // transcribed the student but produced no audio). Cleared when the next
  // turn completes — bounds the auto-continuation to one retry per silent
  // transcript so the model can't loop on it.
  private autoContinuationPending = false;

  // Set whenever a button press is sent to the model, cleared on the next
  // handleTurnComplete. Auto-continuation uses this as a trigger condition:
  // if the model received a button press and produced no audio, we nudge it
  // once to actually speak.
  private lastTurnHadButtonPress = false;

  // Same pattern for the [GREET] system-injected user message that fires on
  // first interact-mode entry. Without this, the model frequently satisfies the
  // greet by stuffing text into rebuild_board.response with no native audio,
  // and the no-trigger AUTO_CONTINUATION path skips it.
  //
  // Subtle: we send GREET from inside handleSingleToolCall(set_interaction_mode),
  // so the very next TURN_COMPLETE is the close of that tool turn (no audio,
  // empty turnAccum), NOT the model's response to the greet. handleTurnComplete
  // therefore only consumes lastTurnHadGreet when the turn shows real content
  // (rebuildBoardIntendedSpeech / transcript / audio); a pure tool-ack turn
  // leaves the flag set so the actual response turn can trigger nudge logic.
  private lastTurnHadGreet = false;
  // Persists across auto-continuation so hasGreetedInteract finally latches
  // when audio eventually arrives (the auto-continuation turn isn't itself a
  // "greet turn" anymore but we still want to mark the greet as completed).
  private greetAudioPending = false;

  // The authenticated user driving this WebSocket. Established at upgrade time
  // by setupLiveWebSocket; trusted as the source of truth for userId. Any
  // userId in the client's `initialize` message is ignored.
  private readonly authedUser: User;

  constructor(ws: WebSocket, authedUser: User) {
    this.ws = ws;
    this.authedUser = authedUser;

    ws.on("message", (raw) => {
      try {
        const msg: ClientMessage = JSON.parse(raw.toString());
        // Log every incoming client message — truncate only base64 audio/image strings, keep objects intact
        logLiveSession("CLIENT → SERVER", `state=${this.state} ${stringifyMsg(msg)}`);
        this.handleClientMessage(msg);
      } catch (err) {
        console.error("[LiveRelay] Invalid client message:", err);
      }
    });

    ws.on("close", () => {
      console.log("[LiveRelay] Client disconnected");
      this.cleanup();
    });

    ws.on("error", (err) => {
      console.error("[LiveRelay] WebSocket error:", err);
      this.cleanup();
    });

    ws.on("pong", () => {
      this.pongReceived = true;
    });

    this.startPingTimer();
  }

  // -------------------------------------------------------------------------
  // State management
  // -------------------------------------------------------------------------

  private setState(newState: RelayState): void {
    const prev = this.state;
    logLiveSession("STATE", `${prev} -> ${newState}`);
    this.state = newState;
    // When state transitions to idle, drain any queued client messages.
    // Process them on the next tick so the current call stack unwinds first.
    if (newState === "idle" && prev !== "idle" && this.pendingClientMessages.length > 0) {
      setImmediate(() => this.drainPendingMessages());
    }
  }

  private drainPendingMessages(): void {
    if (this.pendingClientMessages.length === 0) return;
    if (this.state !== "idle" && this.state !== "awaiting_turn") return;
    const next = this.pendingClientMessages.shift()!;
    logLiveSession("DRAIN queued", `type=${next.type} remaining=${this.pendingClientMessages.length}`);
    this.handleClientMessage(next);
  }

  // Client-initiated interrupt is implemented at the provider level: when the
  // relay state is non-idle, handleButtonPress / board_exit dispatches via
  // `provider.sendMessage(..., { interrupt: true })`, which routes through
  // `sendClientContent` (the documented interrupt mechanism on Live API).
  // Gemini stops the in-flight turn, sends `interrupted=true`, and our
  // existing `onInterrupted` → `handleInterrupted` cleans up state, audio
  // buffer, and tells the client to stop playback. We do NOT pre-emptively
  // mutate server state — letting the model gracefully process the interrupt
  // avoids confusing it (e.g. unloading the board while tokens are still
  // streaming).

  // -------------------------------------------------------------------------
  // Provider callbacks
  // -------------------------------------------------------------------------

  private buildProviderCallbacks(): LiveProviderCallbacks {
    return {
      onText: (text) => {
        // Stray text — log only (real output comes through tool calls)
        if (text.trim()) {
          logDualAgent("LiveRelay.strayText", { sessionId: this.sessionId, text: text.substring(0, 200) });
        }
      },

      onTurnComplete: (reason?: string) => {
        this.handleTurnComplete(reason).catch(err => {
          console.error("[LiveRelay] handleTurnComplete error:", err);
        });
      },

      onInterrupted: () => {
        this.handleInterrupted();
      },

      onToolCall: (calls) => {
        this.handleToolCalls(calls).catch(err => {
          console.error("[LiveRelay] handleToolCalls error:", err);
        });
      },

      onToolCallCancellation: (ids) => {
        console.log(`[LiveRelay] Tool call cancellation for ids: ${ids.join(", ")}`);
      },

      onAudioData: (data) => {
        // During debug introspection, let audio generate (so the model doesn't
        // get RESPONSE_REJECTED for modality violations) but don't forward it.
        if (this.awaitingDebugResponse) return;
        if (this.useDirectAudio) {
          this.directAudioChunks.push(data.data);
          this.hasGreeted = true;
          this.lastAudioChunkAt = Date.now();
          logLiveSession("GEMINI → audioChunk", `state=${this.state} chunkLength=${data.data.length} totalChunks=${this.directAudioChunks.length}`);
          // Schedule a flush — accumulate chunks for smoother playback
          if (!this.directAudioFlushTimer) {
            this.directAudioFlushTimer = setTimeout(() => {
              this.flushDirectAudio();
            }, LiveRelay.AUDIO_FLUSH_INTERVAL_MS);
          }
        }
      },

      onOutputTranscription: (text) => {
        logLiveSession("GEMINI → outputTranscription", `state=${this.state} text="${text}"`);
        // Capture into debug buffer instead of forwarding when introspecting
        if (this.awaitingDebugResponse) {
          if (text.trim()) this.debugResponseBuffer += text;
          return;
        }
        if (this.useDirectAudio && text.trim()) {
          this.turnAccum.speakText += (this.turnAccum.speakText ? " " : "") + text.trim();
          this.send({ type: "text", data: text, noAudioClear: true });
        }
      },

      onUsage: (usage) => {
        if (this.debugMode) {
          this.send({ type: "debug", data: { usage } });
        }
        // Track credits per turn. Fire-and-forget — failures are logged
        // inside the service and must not interrupt the live session.
        const state = this.sessionCache?.state;
        if (state && this.currentLiveProvider && this.currentLiveModel) {
          dualAgentService
            .trackLiveUsage(
              state.sessionId,
              state.studentId,
              state.userId,
              this.currentLiveProvider,
              this.currentLiveModel,
              usage,
            )
            .catch(err => console.error("[LiveRelay] trackLiveUsage failed:", err));
        }
      },

      onGoAway: () => {
        console.log("[LiveRelay] Provider session goAway — reconnecting");
      },

      onReady: () => {
        console.log("[LiveRelay] Provider session ready");
        this.reconnectAttempts = 0;

        // Start silence keepalive — Gemini's native audio model expects a continuous
        // input stream, and hallucinates spontaneous turns when it gets nothing.
        if (this.useDirectAudio) {
          this.startSilenceKeepalive();
        }

        if (!this.initialConnectionDone) {
          // Initial connection — now tell the client we're ready
          this.initialConnectionDone = true;
          logLiveSession("ON_READY (initial)", `Sending greeting prompt, timestamp=${Date.now()}`);
          this.send({ type: "initialized", sessionId: this.sessionCache?.state?.sessionId || "" });
          this.sendSessionSnapshot();
          // Now that the model is connected and ready, send the home board.
          // The set_board for home was deferred during handleInitialize so the
          // user wouldn't see clickable buttons before the model could handle them.
          this.flushPendingHomeBoardSend();

          if (this.pendingGreeting && this.provider) {
            this.setState("awaiting_turn");
            logLiveSession("GREETING PROMPT", this.pendingGreeting.prompt);
            const greetingPrompt = this.pendingGreeting.prompt;
            if (this.pendingGreeting.frame) {
              this.provider.sendFrameWithPrompt(this.pendingGreeting.frame, greetingPrompt);
            } else {
              this.provider.sendMessage(greetingPrompt, "user");
            }
            this.pendingGreeting = null;
            // Mark the greeting as delivered immediately. Without this, a fast
            // disconnect (e.g. Gemini 1008 in the first second) leaves
            // hasGreeted=false, and onReady's reconnect branch then re-sends
            // the "session start" framing — making the model greet/reset on
            // every recovery. Also persist the prompt to pendingMessages so
            // loadHistoryForReconnect restores it after forceNewSession.
            this.hasGreeted = true;
            if (this.sessionId) {
              dualAgentService
                .addPendingMessage(this.sessionId, {
                  role: "user",
                  content: greetingPrompt,
                  timestamp: Date.now(),
                })
                .catch(err => console.error("[LiveRelay] Failed to persist greeting prompt:", err));
            }
          } else {
            this.setState("idle");
          }
          return;
        }

        // Reconnection
        logLiveSession("ON_READY (reconnect)", `hasGreeted=${this.hasGreeted}`);
        this.send({ type: "reconnected" });
        // Flush the deferred home board send on reconnect too — handleInitialize
        // ran again and set pendingHomeBoardSend. This matches the pre-defer
        // behavior of always loading the home board on reconnect.
        this.flushPendingHomeBoardSend();

        if (!this.hasGreeted) {
          console.log("[LiveRelay] Reconnected before greeting — re-prompting");
          const prompt = this.muteState === "muted"
            ? `Generate 4-12 contextual utterance buttons using rebuild_board().`
            : `The home board is loaded. This is a session start. Default to STANDBY; do NOT greet yet. Observe the camera/audio and call set_interaction_mode() once you can identify who (if anyone) is present. Do NOT change the board until the user presses a button.`;
          this.setState("awaiting_turn");
          this.provider!.sendMessage(prompt, "user");
        } else {
          this.injectReconnectionContext();
          this.setState("idle");
        }
      },

      onReconnecting: () => {
        if (this.provider?.lastCloseWasSafety) {
          this.handleSafetyBlock();
          this.send({ type: "reconnecting", data: "error:RECONNECTING" });
          return;
        }

        this.reconnectAttempts++;
        console.log(`[LiveRelay] Reconnecting (attempt ${this.reconnectAttempts})...`);
        this.send({ type: "reconnecting", data: "error:RECONNECTING" });

        if (this.reconnectAttempts >= LiveRelay.MAX_RECONNECT_BEFORE_RESET && this.sessionId) {
          console.log("[LiveRelay] Too many reconnect attempts — creating new session");
          this.forceNewSession().catch(err => {
            console.error("[LiveRelay] Force new session failed:", err);
          });
        }
      },

      onError: (error) => {
        console.error("[LiveRelay] Provider error:", error.message);
        if (this.provider?.lastCloseWasRateLimit || /resource.exhausted|rate.limit|quota|too many requests|overloaded/i.test(error.message)) {
          this.send({ type: "rate_limited", data: "error:RATE_LIMITED" });
        } else if (this.provider?.lastCloseWasSafety || /policy.violation|unsafe|blocked|safety/i.test(error.message)) {
          // Safety errors are handled by onReconnecting -> handleSafetyBlock
        } else {
          this.send({ type: "error", data: "error:CONNECTION_ERROR" });
        }
      },

      onClose: (code, reason) => {
        console.log(`[LiveRelay] Provider session closed: code=${code} reason=${reason}`);
        logLiveSession("CONNECTION CLOSED", `code=${code} reason=${reason || "(none)"}`);
        if (this.provider?.lastCloseWasRateLimit) {
          this.send({ type: "rate_limited", data: "error:RATE_LIMITED" });
          return;
        }
        if (this.provider?.lastCloseWasSafety) {
          return;
        }
        if (code && code !== 1000) {
          this.send({ type: "error", data: "error:CONNECTION_CLOSED" });
        }
      },

      onReconnectFailed: async () => {
        if (!this.sessionId || !this.provider) return;
        console.log("[LiveRelay] Reconnect failed — reloading history from DB");
        try {
          const excludeSafety = this.consecutiveSafetyBlocks > 0;
          const turns = await dualAgentService.loadHistoryForReconnect(this.sessionId, excludeSafety);
          if (turns.length > 0) {
            this.provider.sendConversationHistory(turns);
            console.log(`[LiveRelay] Sent ${turns.length} history turns to fresh session (excludeSafety=${excludeSafety})`);
          }
        } catch (err) {
          console.error("[LiveRelay] History reload failed:", err);
        }
      },
    };
  }

  // -------------------------------------------------------------------------
  // Client message handling
  // -------------------------------------------------------------------------

  private async handleClientMessage(msg: ClientMessage): Promise<void> {
    try {
      switch (msg.type) {
        case "initialize":
          await this.handleInitialize(msg);
          break;

        case "frame_grid": {
          if (this.paused) break;
          // PROACTIVITY EXPERIMENT (2026-04-12) — REVERTIBLE.
          //
          // The client already runs motion detection and only emits a frame_grid
          // when something visually interesting happens (the timestamps[] array
          // is a burst of frames around the event). So each frame_grid IS an
          // event the model should get a chance to react to.
          //
          // While idle, deliver the frame via sendFrameWithPrompt
          // (sendClientContent + turnComplete=true) so the model gets an actual
          // turn opportunity. The "[scene update] ... stay silent unless..."
          // prompt + proactiveAudio:true is what keeps the model from speaking
          // on every tick — it can choose to call tools (add_context_button,
          // update_context, save transcripts, etc.) and end the turn silently.
          //
          // While in_turn / processing_turn / awaiting_turn, just drop the
          // frame. The model already has visual context from earlier in the
          // turn, and the next frame_grid after we return to idle will pick up
          // any new motion.
          //
          // ⚠️ TO REVERT: replace the whole branch with the prior fire-and-
          // forget version using `this.provider!.sendFrame(msg.data, false)`
          // (and the same for latestAppCanvas). We're switching off that path
          // because (a) it never gave the model a chance to act and (b) the
          // memory note about visual responsiveness suggested sendRealtimeInput
          // .video might be slowing visual updates anyway.
          if (this.state !== "idle") {
            logLiveSession("FRAME_GRID DROPPED", `state=${this.state}`);
            break;
          }
          if (Date.now() < this.rejectionCooldownUntil) {
            logLiveSession("FRAME_GRID DROPPED", `rejection cooldown (${this.rejectionCooldownUntil - Date.now()}ms remaining)`);
            break;
          }
          this.setState("awaiting_turn");
          const extraImages = this.latestAppCanvas
            ? [{ data: this.latestAppCanvas, mimeType: "image/jpeg", label: "[app canvas]" }]
            : undefined;
          const gestureNote = msg.gestureContext
            ? `\n${msg.gestureContext}`
            : "";
          const peopleContext = this.buildPeoplePresentContext();
          const peopleNote = peopleContext ? `\n${peopleContext}` : "";
          // Sleep system: wake-from-Asleep gets a different prompt that asks
          // the AI to evaluate whether the wake was a real re-engagement or a
          // false alarm (in which case it should call report_false_wake).
          const isWakeCheck = msg.triggerReason === "wake_check";
          const prompt = isWakeCheck
            ? `[wake check] Session woken. Respond naturally if the user is engaging with you.${peopleNote}${gestureNote}`
            : `[scene update] React if something here calls for action.${peopleNote}${gestureNote}`;
          this.provider!.sendFrameWithPrompt(msg.data, prompt, extraImages);
          break;
        }

        case "pcm_audio": {
          // PCM audio ALWAYS flows — never gated by state.
          // Don't remove this, the model is designed to ignore echoes so this shouldn't be the cause of bugs.
          if (this.paused) break;
          this.lastClientPcmAt = Date.now();
          this.provider!.sendAudio(msg.data);
          break;
        }

        case "audio_clip":
          // No-op: Gemini already hears audio via continuous PCM streaming
          break;

        case "focus_frame": {
          // High-resolution single frame requested by AI for detailed analysis
          this.setState("awaiting_turn");
          this.provider!.sendFrameWithPrompt(
            msg.data,
            `[FOCUS FRAME] This is a HIGH-RESOLUTION single frame captured at your request. Analyze the image carefully for fine details, text, labels, faces, or objects you couldn't identify before. Update the board if needed.`,
          );
          console.log("[LiveRelay] Focus frame sent to Gemini");
          break;
        }

        case "user_message": {
          if (this.paused) break;
          if (this.state !== "idle" && this.state !== "awaiting_turn") {
            logLiveSession("QUEUED user_message", `state=${this.state} text="${msg.text.substring(0, 60)}"`);
            this.pendingClientMessages.push(msg);
            break;
          }
          this.setState("awaiting_turn");

          // Record user message in session state for monitor context + persist to DB
          if (this.sessionId) {
            dualAgentService.addPendingMessage(this.sessionId, {
              role: "user",
              content: msg.text,
              timestamp: Date.now(),
            }).catch(err => console.error("[LiveRelay] Failed to persist user message:", err));
          }
          // Track for retry in case proactiveAudio swallows the turn
          this.pendingRetryPrompt = msg.text;
          this.provider!.sendMessage(msg.text, "user");
          logDualAgent("LiveRelay.userMessage", {
            sessionId: this.sessionId,
            text: msg.text.substring(0, 80),
            textLength: msg.text.length,
          });
          break;
        }

        case "voice_audio":
          // No-op: Gemini already hears audio via continuous PCM streaming
          break;

        case "button_press": {
          if (this.paused) break;
          // Drop presses received before the model is ready. The client gates
          // the home board on the deferred set_board send, so this should be
          // rare — but if a press still slips through (cached board, race),
          // dropping is safer than queuing because the queued press would fire
          // immediately on init and surprise the user.
          if (this.state === "initializing" || this.state === "closed") {
            logLiveSession("BTN_DROPPED (not ready)", `state=${this.state} buttons=[${msg.buttons.join(", ")}]`);
            break;
          }
          // Out-of-turn press → flag the dispatch as an interrupt. The
          // provider will route via sendClientContent (the documented
          // interrupt path) instead of sendRealtimeInput. Don't touch
          // server-side state — let Gemini's `interrupted` signal trigger
          // the existing onInterrupted → handleInterrupted cleanup.
          const isInterrupt = this.state !== "idle";
          this.setState("awaiting_turn");
          this.handleButtonPress(msg.buttons, msg.sentences, msg.board, isInterrupt);
          break;
        }

        case "board_exit": {
          // Exit button pressed on loaded board — client sends the action directly
          if (this.paused) break;
          if (this.state === "initializing" || this.state === "closed") {
            logLiveSession("BTN_DROPPED (not ready)", `state=${this.state} label="${msg.label}"`);
            break;
          }
          // Out-of-turn exit → mark this dispatch as an interrupt (used below
          // when calling provider.sendMessage). Don't pre-emptively touch state.
          const exitIsInterrupt = this.state !== "idle";

          // Detect Home button press — server loads the home board directly
          // (no AI tool call required) to avoid the rebuild_board side-panel
          // truncation loop. The AI is informed via context injection.
          const isHomePress = msg.label === "Home" ||
            (msg.instruction && /set_board\(["']home["']\)|load.*home board/i.test(msg.instruction));

          if (isHomePress) {
            this.loadHomeBoardInternal();
            if (this.sessionId) {
              dualAgentService.addPendingMessage(this.sessionId, {
                role: "user",
                content: `[BUTTON PRESS] Home`,
                timestamp: Date.now(),
              }).catch(console.error);
            }
            this.provider!.sendContextInjection(
              `[CONTEXT] The user pressed Home. The home board is now loaded with its native navigation buttons. Wait for them to press one of the home buttons before changing the board.`
            );
            break;
          }

          this.setState("awaiting_turn");

          const exitState = this.sessionCache?.state;
          if (exitState) {
            exitState.loadedBoardId = null;
            exitState.loadedBoardData = undefined;
            exitState.currentPageId = null;
            exitState.pageHistory = [];
            exitState.aiAddedButtonLabels = [];
            exitState.boardButtonLabels = [];
            exitState.maxBoardItems = 12;
          }
          this.send({ type: "unload_board", data: {} });

          // Detect guessing mode
          if (msg.instruction.includes("[GUESSING MODE]") && !this.guessingMode) {
            this.guessingMode = true;
            this.send({ type: "guessing_mode", active: true });
            logLiveSession("GUESSING_MODE", "Entered via board exit button");
          }

          if (this.sessionId) {
            dualAgentService.addPendingMessage(this.sessionId, {
              role: "user",
              content: `[BUTTON PRESS] ${msg.label}`,
              timestamp: Date.now(),
            }).catch(console.error);
          }

          // Home-menu button press: chat-style framing matching the
          // dynamic-button path. The press is presented as the student
          // saying the label; the board-defined intent text is appended
          // as parenthetical guidance for context.
          const exitInstruction = msg.instruction
            ? `[BUTTON PRESS] ${msg.label}\n\n(${msg.instruction})`
            : `[BUTTON PRESS] ${msg.label}`;
          this.lastTurnHadButtonPress = true;
          this.provider!.sendMessage(exitInstruction, "user", true, { interrupt: exitIsInterrupt });
          break;
        }

        case "gesture_context":
          this.provider!.sendContextInjection(`[GESTURE CONTEXT]\n${msg.data}`);
          break;

        case "person_context":
          this.provider!.sendContextInjection(`[PERSON IDENTIFIED]\n${JSON.stringify(msg.data)}`);
          break;

        case "board_state": {
          // Update server-side board label tracking from client-reported state
          const bsState = this.sessionCache?.state;
          if (bsState && msg.data?.pages?.[0]?.buttons) {
            const maxSlots = bsState.maxBoardItems || 12;
            bsState.boardButtonLabels = msg.data.pages[0].buttons
              .slice(0, maxSlots)
              .map((b: { label?: string }) => b.label || "")
              .filter((l: string) => l);
          }
          this.lastBoardUpdateTime = Date.now();
          // Board state is a control signal — the AI references existing
          // button labels via add_buttons / rebuild_board / press_button.
          // Wrapping it would force the model to treat its own working set
          // as untrusted, breaking those tools.
          this.provider!.sendContextInjection(`[CURRENT BOARD STATE]\n${JSON.stringify(msg.data)}`);
          break;
        }

        case "set_mute_state": {
          this.muteState = msg.muteState;
          // Rebuild the interactive system prompt for the new mode and inject
          // it as a strong override. The Live API doesn't support changing
          // systemInstruction mid-session, so we re-deliver the mode rules as
          // a high-authority context injection.
          const state = this.sessionCache?.state;
          const student = this.sessionCache?.monitorAgent?.getStudent?.();
          if (state && student) {
            const rawPersona = student.aacSettings?.chatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;
            const persona = state.enhancedPrompt || rawPersona;
            const computeAge = (bd: string | null | undefined) => {
              if (!bd) return undefined;
              const age = Math.floor((Date.now() - new Date(bd).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
              return age > 0 ? String(age) : undefined;
            };
            state.interactivePrompt = buildInteractiveAgentPrompt({
              studentName: student.name,
              persona,
              language: student.primaryLanguage || undefined,
              memoryContext: state.enhancedPrompt ? undefined : state.memoryContext,
              muteState: this.muteState,
              studentAge: computeAge(student.birthDate),
              studentGender: student.gender || undefined,
              studentDiagnosis: state.cachedDiagnosis || undefined,
              aiName: student.aacSettings?.aiName || undefined,
              knownContacts: state.cachedContacts?.length ? state.cachedContacts : undefined,
              availableBoards: state.availableBoards?.length ? state.availableBoards : undefined,
              cachedSymbols: state.cachedSymbols?.length ? state.cachedSymbols : undefined,
              enabledApps: APP_REGISTRY.filter(a => state.appState.enabledApps.includes(a.id)).map(a => ({ id: a.id, name: a.name, description: a.description })),
              permittedWebsites: state.permittedWebsites.length > 0 ? state.permittedWebsites : undefined,
              permittedYoutubeChannels: state.permittedYoutubeChannels.length > 0 ? state.permittedYoutubeChannels : undefined,
              autoSymbolsEnabled: !!(student.aacSettings?.generateSymbols || student.aacSettings?.useApprovedSymbols || student.aacSettings?.useUnapprovedSymbols),
              useDirectAudio: this.useDirectAudio,
            });
          }
          const override = msg.muteState === "muted"
            ? `[MUTE CHANGE] The user has MUTED you. Effective immediately and until the user unmutes by tapping the cave: do NOT call speak(). Do NOT talk to the user. Switch to producing utterance-style buttons via rebuild_board() so the user can speak through them. You cannot unmute yourself.`
            : `[MUTE CHANGE] The user has UNMUTED you. You may now speak() directly with the user again. Greet them.`;
          // sendMessage (turnComplete=true) so the model actually reacts now —
          // muted: switch to utterance-button mode immediately;
          // unmuted: produce the greeting instead of stalling until the next frame.
          this.provider!.sendMessage(override, "user");
          break;
        }

        case "set_response_mode":
          this.responseMode = msg.mode;
          break;

        case "unknown_face_descriptors":
          this.unknownFaceDescriptors = msg.data;
          // Fire-and-forget: match each descriptor against the student's known
          // people (self + linked users + contacts). Results populate
          // currentIdentifiedFaces, get pushed to the client for the debug
          // display, and feed the next frame_grid context string.
          this.recognizeFaces(msg.data).catch(err => {
            logLiveSession("FACE_RECOGNITION_ERROR", (err as Error).message);
          });
          break;

        case "page_navigate":
          this.provider!.sendContextInjection(
            `[PAGE NAVIGATE] User navigated to page "${msg.pageName}". Current buttons: ${msg.buttons.join(", ")}`,
          );
          if (this.sessionCache?.state) {
            this.sessionCache.state.currentPageId = msg.pageId;
          }
          break;

        case "app_canvas":
          this.latestAppCanvas = msg.data;
          break;

        case "set_paused":
          this.paused = msg.paused;
          if (msg.paused) {
            this.provider!.sendContextInjection(
              `[SYSTEM] Session PAUSED by caretaker. The student cannot see or interact with the device. Do NOT speak, update the board, or respond to any input until resumed. Ignore all silence or lack of activity — this is expected.`,
            );
            logLiveSession("SESSION_PAUSED", `sessionId=${this.sessionId}`);
          } else {
            this.provider!.sendContextInjection(
              `[SYSTEM] Session RESUMED. The student can see and interact with the device again. Continue normally.`,
            );
            logLiveSession("SESSION_RESUMED", `sessionId=${this.sessionId}`);
          }
          break;

        case "app_dismissed": {
          this.latestAppCanvas = null;
          if (this.state !== "idle" && this.state !== "awaiting_turn") {
            logLiveSession("QUEUED app_dismissed", `state=${this.state} appId="${msg.appId}"`);
            this.pendingClientMessages.push(msg);
            break;
          }
          this.setState("awaiting_turn");
          this.provider!.sendMessage(
            `[APP CLOSED] The user closed the "${msg.appId}" app and returned to the AAC board. The full board is now restored (up to 12 buttons). Comment briefly on what they were doing in the app, then use rebuild_board() to create a fresh set of communication buttons for the current context.`,
            "user",
          );
          logDualAgent("LiveRelay.appDismissed", { sessionId: this.sessionId, appId: msg.appId });
          break;
        }

        case "local_state":
          this.pendingLocalState = msg.snapshot;
          break;

        case "context_injection":
          if (this.provider) {
            this.provider.sendContextInjection(msg.text);
            logDualAgent("LiveRelay.contextInjection", {
              sessionId: this.sessionId,
              text: msg.text.substring(0, 80),
            });
          }
          break;

        case "construction_state":
          logLiveSession("CONSTRUCTION_STATE_IN",
            `cat=${msg.data.category} target=${msg.data.targetSlot} glyph="${msg.data.glyph}" exclude=${msg.data.excludeKeys.length} hasProvider=${!!this.provider}`);
          if (this.provider) {
            const text = formatConstructionStateInjection(msg.data);
            // Use sendMessage (turnComplete=true) so the model actually
            // responds with a tool call. sendContextInjection uses
            // turnComplete=false, which would inject the state silently
            // and never trigger suggest_construction_buttons.
            this.provider.sendMessage(text, "user", true);
            logLiveSession("CONSTRUCTION_STATE_SENT", `text="${text.replace(/\n/g, " | ")}"`);
          } else {
            logLiveSession("CONSTRUCTION_STATE_DROPPED", "no provider — message ignored");
          }
          break;

        case "client_sleep_state_change":
          this.recordSleepStateChange(msg.state, msg.source);
          break;
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[LiveRelay] Error handling ${msg.type}:`, error.message);
      this.send({ type: "error", data: "error:UNEXPECTED_ERROR" });
    }
  }

  // -------------------------------------------------------------------------
  // Initialize
  // -------------------------------------------------------------------------

  private async handleInitialize(msg: Extract<ClientMessage, { type: "initialize" }>): Promise<void> {
    this.setState("initializing");

    // Authoritative userId comes from the upgrade-time auth check, never from
    // the client message. This closes the path where an authenticated user
    // forged a different userId to inherit another user's license tier or
    // studentId-bound state.
    this.userId = this.authedUser.id;

    // Verify the authenticated user has access to the requested student via
    // any of: direct userStudent link, family-institute membership, or
    // school/clinic admin. Refuse the session otherwise — without this check,
    // anyone authenticated who knows a student UUID could open an AAC
    // session and pull PHI through the live model and monitor.
    if (!msg.studentId) {
      this.send({ type: "error", data: "MISSING_STUDENT_ID" });
      this.ws.close(1008, "missing studentId");
      return;
    }
    const access = await studentService.verifyStudentAccess(msg.studentId, this.authedUser.id);
    if (!access.hasAccess) {
      console.warn(
        `[LiveRelay] Access denied: user=${this.authedUser.id} requested studentId=${msg.studentId}`,
      );
      this.send({ type: "error", data: "FORBIDDEN_STUDENT" });
      this.ws.close(1008, "forbidden");
      return;
    }

    this.studentId = msg.studentId;
    this.muteState = msg.muteState || "unmuted";
    this.responseMode = msg.responseMode || "fast";
    this.debugMode = msg.debugMode || false;
    this.timezone = msg.timezone;

    try {
      // 1. Read LLM config
      const aacChatConfig = await settingsRepository.getLLMConfig("aac_chat");

      // Allow env var override for local testing
      const overrideModel = process.env.OVERRIDE_AAC_LIVE_MODEL;
      if (overrideModel) {
        const overrideInfo = MODEL_OPTIONS.find(m => m.modelId === overrideModel && m.supportsLive);
        if (overrideInfo) {
          aacChatConfig.provider = overrideInfo.provider;
          aacChatConfig.model = overrideInfo.modelId;
          console.log(`[LiveRelay] OVERRIDE_AAC_LIVE_MODEL -> ${overrideInfo.provider}/${overrideInfo.modelId}`);
        } else {
          console.warn(`[LiveRelay] OVERRIDE_AAC_LIVE_MODEL="${overrideModel}" not found or not a live model — ignoring`);
        }
      }

      // Choose Vertex vs public Gemini API based on the model's catalog entry.
      // Live models with availableOnVertex === false (e.g. 3.1 Flash Live Preview)
      // only run on the public API; everything else (GA 2.5 Flash Live, etc.)
      // uses Vertex when gemini is the provider.
      const liveModelInfo =
        aacChatConfig.provider === "gemini"
          ? MODEL_OPTIONS.find(m => m.modelId === aacChatConfig.model && m.supportsLive)
          : undefined;
      const useVertexForLive =
        aacChatConfig.provider === "gemini" &&
        (liveModelInfo?.availableOnVertex ?? true);

      // 2. Initialize session (prompt, contacts, symbols, boards)
      const state = await dualAgentService.initializeSession(
        msg.studentId,
        msg.userId,
        msg.sessionId,
        this.muteState,
        this.pendingLocalState || undefined,
        this.timezone,
      );
      this.pendingLocalState = null;
      this.sessionId = state.sessionId;

      // Get session cache
      const cached = dualAgentService.getSessionCache(state.sessionId);
      if (!cached) {
        throw new Error("Session cache not found after initialization");
      }
      this.sessionCache = cached;

      // Register context injection callback
      cached.state.onContextInjection = (text: string) => {
        logLiveSession("MONITOR INJECTION", text);
        if (this.provider?.isConnected) {
          this.provider.sendContextInjection(`[Monitor Context]\n${text}`);
          logLiveSession("MONITOR INJECTION SENT", `via sendContextInjection, provider connected=${this.provider.isConnected}`);
        } else {
          logLiveSession("MONITOR INJECTION FAILED", `provider not connected`);
        }
        this.send({ type: "context", data: `[Monitor] ${text}` });
      };

      // Server-initiated termination: dualAgentService calls this when the
      // student's consent is revoked mid-session (or any future cascade
      // condition). Send a typed error so the AAC client can surface a
      // "consent required" prompt, then close the socket cleanly.
      cached.state.onTerminate = (reason: string) => {
        try {
          this.send({
            type: "error",
            data: reason === "consent_revoked" ? "error:CONSENT_REVOKED" : "error:SESSION_TERMINATED",
          });
        } catch { /* ignore — close anyway */ }
        try {
          this.ws.close(1000, `terminated:${reason}`);
        } catch { /* ignore */ }
      };

      // 3. Resolve voices
      try {
        const student = cached.monitorAgent.getStudent?.();
        if (student) {
          const voices = await (dualAgentService as any).resolveVoices(cached);
          this.aiVoice = voices?.aiVoice || null;
          this.studentVoice = voices?.studentVoice || null;
          console.log(`[LiveRelay] Voices resolved — AI: ${this.aiVoice?.geminiVoiceName || this.aiVoice?.fallbackType || "none"}, Student: ${this.studentVoice?.fallbackType || "none"} (lang: ${this.studentVoice?.language || "?"}, gemini: ${this.studentVoice?.geminiVoiceName || "none"})`);

          // Start a persistent Gemini Live session for student TTS when a
          // Gemini voice is configured and ElevenLabs won't handle it.
          // This keeps the WebSocket warm for the duration of the AAC
          // conversation, avoiding the ~2.5s HTTP connection overhead of
          // the standard Gemini TTS HTTP API.
          const sv = this.studentVoice;
          const elevenLabsWillHandle =
            !!(sv?.elevenlabsApiKey && sv?.elevenlabsVoiceId) ||
            !!(sv?.customVoice && sv.customVoice.active);
          if (sv?.geminiVoiceName && !elevenLabsWillHandle) {
            this.studentTtsSession = new GeminiLiveTtsSession({
              voiceName: sv.geminiVoiceName,
              language: sv.language,
            });
            sv.geminiLiveSession = this.studentTtsSession;
          }
        } else {
          console.warn("[LiveRelay] No student found — voices not resolved");
        }
      } catch (err) {
        console.warn("[LiveRelay] Voice resolution failed, using defaults:", err);
      }

      // 4. Determine direct audio mode
      // Always use direct audio — Gemini native audio for AI voice,
      // Gemini TTS service for student voice (streamed server-side).
      this.useDirectAudio = true;
      if (this.useDirectAudio) {
        console.log("[LiveRelay] Direct audio mode enabled — model speaks directly via native audio");
      }

      // 5. If direct audio, rebuild prompt with useDirectAudio flag
      // Fetch custom apps assigned to this student (gated by license permission).
      let availableCustomApps: Array<{ id: string; name: string; description?: string | null }> = [];
      if (this.userId && this.studentId) {
        try {
          const perms = await licenseService.getUserPermissions(this.userId);
          if (perms.customAppsEnabled) {
            const apps = await customAppRepository.getAssignedAppsForStudent(this.studentId);
            availableCustomApps = apps.map((a) => ({
              id: a.id,
              name: a.name,
              description: a.description,
            }));
          }
        } catch (err) {
          logLiveSession("CUSTOM_APPS_FETCH_FAILED", String(err));
        }
      }

      if (this.useDirectAudio && cached.monitorAgent.getStudent) {
        const student = cached.monitorAgent.getStudent();
        if (student) {
          const rawPersona = student.aacSettings?.chatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;
          const persona = state.enhancedPrompt || rawPersona;
          const computeAge = (bd: string | null | undefined) => {
            if (!bd) return undefined;
            const age = Math.floor((Date.now() - new Date(bd).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
            return age > 0 ? String(age) : undefined;
          };
          state.interactivePrompt = buildInteractiveAgentPrompt({
            studentName: student.name,
            persona,
            language: student.primaryLanguage || undefined,
            memoryContext: state.enhancedPrompt ? undefined : state.memoryContext,
            muteState: this.muteState,
            studentAge: computeAge(student.birthDate),
            studentGender: student.gender || undefined,
            studentDiagnosis: state.cachedDiagnosis || undefined,
            aiName: student.aacSettings?.aiName || undefined,
            knownContacts: state.cachedContacts?.length ? state.cachedContacts : undefined,
            availableBoards: state.availableBoards?.length ? state.availableBoards : undefined,
            cachedSymbols: state.cachedSymbols?.length ? state.cachedSymbols : undefined,
            enabledApps: APP_REGISTRY.filter(a => state.appState.enabledApps.includes(a.id)).map(a => ({ id: a.id, name: a.name, description: a.description })),
            availableCustomApps,
            permittedWebsites: state.permittedWebsites.length > 0 ? state.permittedWebsites : undefined,
            permittedYoutubeChannels: state.permittedYoutubeChannels.length > 0 ? state.permittedYoutubeChannels : undefined,
            youtubeChannelVideos: state.permittedYoutubeChannels.length > 0
              ? await fetchRecentVideosForChannels(state.permittedYoutubeChannels)
              : undefined,
            autoSymbolsEnabled: !!(student.aacSettings?.generateSymbols || student.aacSettings?.useApprovedSymbols || student.aacSettings?.useUnapprovedSymbols),
            useDirectAudio: true,
          });
        }
      }

      // 5b. Build the default home board (virtual — not stored in DB).
      // The home board is loaded on init and on Home button press. The AI
      // can also load it explicitly via set_board("home") — it's included
      // in availableBoards so the AI understands when it's loaded and can
      // return to it deliberately.
      const studentLang = cached.monitorAgent.getStudent?.()?.primaryLanguage || "en";
      this.homeBoardData = buildDefaultHomeBoard(studentLang);
      // Load the home board into session state, but defer the client `set_board`
      // send until onReady. This prevents the home buttons from appearing
      // (and being clickable) before the model is connected.
      this.loadHomeBoardInternal(state, /* deferClientSend */ true);
      // Add home to available boards so the AI can call set_board("home")
      if (!state.availableBoards) state.availableBoards = [];
      if (!state.availableBoards.some(b => b.key === HOME_BOARD_KEY)) {
        state.availableBoards.unshift({ key: HOME_BOARD_KEY, name: "Home", id: "__home__" } as any);
      }

      // 6. Build tools (availableCustomApps was fetched above for the prompt)
      const toolConfig: ToolDeclarationConfig = {
        enabledApps: (cached.state.appState?.enabledApps || [])
          .map(id => getAppDefinition(id))
          .filter((a): a is import("./types").AACAppDefinition => !!a),
        availableBoards: (cached.state.availableBoards || []).map(b => ({ key: b.key, name: b.name })),
        availableCustomApps,
        hasLoadedBoard: !!cached.state.loadedBoardId,
        faceRecognitionActive: (cached.state.cachedContacts?.length || 0) > 0 || this.unknownFaceDescriptors.length > 0,
        isMutedMode: this.muteState === "muted",
        maxBoardItems: cached.state.maxBoardItems || 12,
        loadedBoardName: cached.state.loadedBoardData?.name || null,
        currentEmote: cached.state.currentEmote,
        activeApp: cached.state.appState?.activeApp || null,
        useDirectAudio: this.useDirectAudio,
        permittedWebsites: cached.state.permittedWebsites || [],
      };

      // Close any existing provider (for forceNewSession re-init)
      this.provider?.close();

      const callbacks = this.buildProviderCallbacks();
      const tools = buildToolDeclarations(toolConfig);

      // 7. Build system prompt
      const echoAwareness = this.buildEchoAwareness();
      const tzSection = this.buildTimezoneSection();
      const systemPrompt = state.interactivePrompt + "\n\n" + echoAwareness + (tzSection ? "\n\n" + tzSection : "");

      // 8. Connect to Gemini
      const geminiVoice = this.aiVoice?.geminiVoiceName || GEMINI_VOICE_MAP[this.aiVoice?.fallbackType || "woman"] || "Zephyr";

      const providerConfig: LiveProviderConfig = {
        model: aacChatConfig.model,
        temperature: 0.7,
        tools,
        compressionTriggerTokens: 100_000,
        compressionTargetTokens: 50_000,
        responseModality: "AUDIO",
        proactiveAudio: true,
        voiceName: geminiVoice,
      };

      this.provider = new GeminiLiveProvider(callbacks, useVertexForLive /* useVertexAI */);
      this.currentLiveProvider = aacChatConfig.provider;
      this.currentLiveModel = aacChatConfig.model;
      await this.provider.connect(systemPrompt, providerConfig);

      // Log session start
      const providerLabel = useVertexForLive ? `vertex:${aacChatConfig.model}` : `api-key:${aacChatConfig.model}`;
      logLiveSession("SESSION START", [
        `Session: ${state.sessionId}`,
        `Student: ${msg.studentId}`,
        `Provider: ${providerLabel}`,
        `Model: ${providerConfig.model}`,
        `Response Modality: ${providerConfig.responseModality || "default"}`,
        `Interaction: ${this.muteState}`,
        `Response: ${this.responseMode}`,
        `DirectAudio: ${this.useDirectAudio}`,
        `Startup: ${state.enhancedPrompt ? "thorough" : "fast"}`,
      ].join("\n"));
      logLiveSession("SYSTEM PROMPT", systemPrompt);
      if (tools.length > 0) {
        logLiveSession("TOOL DECLARATIONS", JSON.stringify(tools, null, 2));
      }

      // 9. Store greeting for onReady to send
      const isMuted = this.muteState === "muted";
      const student = cached.monitorAgent.getStudent?.();
      const personaHint = student?.aacSettings?.chatAgentPrompt?.trim()
        ? `\nThe student is ${student.name}. Use their profile (in the system prompt) to personalize the board — reflect their interests, communication level, and needs.`
        : "";
      const imageHint = msg.initialFrame ? "\nUse the camera image to observe the environment and make the buttons contextually relevant." : "";
      const boardHint = state.availableBoards && state.availableBoards.length > 0
        ? ` If a custom board from the Available Custom Boards list is appropriate for this student, use set_board() instead of rebuild_board().`
        : "";
      const homeBoardButtons = this.getNativePageButtonLabels(state);
      const contextScan = ``;
      // Greeting is deferred to the first set_interaction_mode("interact") call
      // (see handleToolCalls) — by that point face recognition has resolved and
      // the AI knows who, if anyone, to address. Start in STANDBY and only
      // transition (and greet) once presence is confirmed.
      const modeGuidance = ` Default to STANDBY; do NOT greet yet. Observe the camera/audio and call set_interaction_mode() once you can identify who (if anyone) is present.`;
      const greetingPrompt = isMuted
        ? `Generate 4-12 contextual utterance buttons via rebuild_board() using the student's profile/interests.${imageHint}${boardHint}${personaHint}${contextScan}`
        : this.useDirectAudio
        ? `Session start. Home board buttons: ${homeBoardButtons.join(", ")}.${modeGuidance} Don't change the board until a button is pressed.${imageHint}${personaHint}${contextScan}`
        : `Session start. Function calls only. Home board buttons: ${homeBoardButtons.join(", ")}.${modeGuidance} Wait for a button press.${imageHint}${personaHint}${contextScan}`;

      this.hasGreeted = false;
      // Do NOT include the initial frame in the greeting prompt — sending it via
      // sendFrameWithPrompt consistently triggers MALFORMED_FUNCTION_CALL on the
      // first turn. The frame will be sent separately as passive context shortly
      // after via frame_grid.
      this.pendingGreeting = { prompt: greetingPrompt };

      // Resolve local storage config
      const aacStudentSettings = cached.monitorAgent.getStudent?.()?.aacSettings;
      let encryptionKey = aacStudentSettings?.localStorageEncryptionKey ?? null;
      if (aacStudentSettings?.localStorageEnabled && !encryptionKey) {
        encryptionKey = randomBytes(32).toString("base64");
        aacSettingsRepository.upsert(msg.studentId, { localStorageEncryptionKey: encryptionKey }).catch(err =>
          console.error("[LiveRelay] Failed to persist encryption key:", err)
        );
      }
      this.localStorageConfig = {
        localStorageEnabled: aacStudentSettings?.localStorageEnabled ?? true,
        remoteStorageEnabled: aacStudentSettings?.remoteStorageEnabled ?? true,
        encryptionKey,
      };
      this.symbolSettings = {
        generateSymbols: aacStudentSettings?.generateSymbols ?? false,
        useApprovedSymbols: aacStudentSettings?.useApprovedSymbols ?? false,
        useUnapprovedSymbols: aacStudentSettings?.useUnapprovedSymbols ?? false,
      };
      console.log(`[LiveRelay] Symbol settings loaded:`, JSON.stringify(this.symbolSettings));

      // 10. Start timers
      this.startTimers();

      // 11. "initialized" is sent when the provider's onReady fires (see
      // onReady callback) so the client keeps showing the loading screen
      // until the Gemini connection is actually established.

      logDualAgent("LiveRelay.initialize", {
        sessionId: state.sessionId,
        studentId: msg.studentId,
        provider: providerLabel,
        model: providerConfig.model,
        responseModality: providerConfig.responseModality || "default",
        muteState: this.muteState,
        responseMode: this.responseMode,
        useDirectAudio: this.useDirectAudio,
      });

      console.log(`[LiveRelay] Initialized session ${state.sessionId} for student ${msg.studentId} (provider: ${providerLabel}, modality: ${providerConfig.responseModality || "default"}, model: ${providerConfig.model})`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // Distinguish consent-gate failures so the AAC client can surface a
      // "consent required" prompt instead of a generic init failure.
      if (error.name === "ConsentGateError" || /consent[_ ]required/i.test(error.message)) {
        console.warn("[LiveRelay] Initialize blocked by consent gate:", error.message);
        this.send({ type: "error", data: "error:CONSENT_REQUIRED" });
      } else {
        console.error("[LiveRelay] Initialize failed:", error.message);
        this.send({ type: "error", data: "error:INIT_FAILED" });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Button press handling
  // -------------------------------------------------------------------------

  private handleButtonPress(
    buttons: string[],
    sentences?: Record<string, string>,
    board?: any,
    interrupt = false,
  ): void {
    const buttonList = buttons.join(", ");
    console.log(`[LiveRelay] Interpreting buttons: ${buttonList}${interrupt ? " (interrupt)" : ""}`);

    // [MORE] — user wants more button options, NOT a spoken response
    if (buttons.length === 1 && buttons[0] === "[MORE]") {
      if (this.sessionId) {
        dualAgentService.addPendingMessage(this.sessionId, {
          role: "user",
          content: "[MORE OPTIONS REQUESTED]",
          timestamp: Date.now(),
        }).catch(err => console.error("[LiveRelay] Failed to persist [MORE]:", err));
      }
      this.provider!.sendMessage(`[MORE OPTIONS REQUESTED]
The user pressed "More" — they can't find the button they need on the current board. Use add_buttons() to add more relevant options to the board. Do NOT respond with speech — just silently add buttons.`, "user", true, { interrupt });
      return;
    }

    // For a single button press, use the pre-generated sentence directly.
    const singleSentence = (buttons.length === 1 && sentences?.[buttons[0]]) || "";

    // Send interpretation to client for UI display
    if (singleSentence) {
      this.send({ type: "interpret", text: singleSentence, confidence: "high", noAudioClear: false });
      this.turnAccum.interpretText = singleSentence;
      this.turnAccum.interpretConfidence = "high";
    }

    // Record button press as a user message in session log
    if (this.sessionId) {
      dualAgentService.addPendingMessage(this.sessionId, {
        role: "user",
        content: `[BUTTON PRESS] ${buttonList}`,
        timestamp: Date.now(),
      }).catch(err => console.error("[LiveRelay] Failed to persist button press:", err));
    }

    // Insurance Bridge: record the utterance for MLU/NDW aggregation. We
    // prefer the pre-generated sentence (more natural language) but fall back
    // to the raw button labels when no sentence is available.
    if (this.studentId) {
      recordUtterance({
        studentId: this.studentId,
        chatSessionId: this.sessionId,
        text: singleSentence || buttonList,
        source: "board_press",
      });
    }

    // Minimal natural framing: present the press as the student speaking.
    // No system markers, no procedural instructions — the per-turn payload
    // looks like a chat message. The system prompt's
    // <how_the_student_talks_to_you> block handles the "respond aloud +
    // rebuild_board" behavior expectation.
    const prompt = `[BUTTON PRESS] ${singleSentence || buttonList}`;

    // Send prompt with turnComplete=true immediately. Student TTS runs in
    // parallel. With Google Cloud TTS (~300ms) and AI response time (~1s),
    // the student voice finishes before the AI starts speaking.
    //
    // Track the prompt so we can retry if proactiveAudio swallows the turn.
    this.pendingRetryPrompt = prompt;
    this.lastTurnHadButtonPress = true;
    this.provider!.sendMessage(prompt, "user", true, { interrupt });

    // Stream student voice TTS in parallel
    if (singleSentence && this.studentVoice) {
      // Cancel any in-flight student TTS from a previous press — without this,
      // overlapping streams interleave on the `interpretation_audio` channel
      // and the client plays a garbled mix. We send a tag-scoped clear so the
      // AI's avatar_audio queue is preserved.
      if (this.studentTtsAbortController) {
        this.studentTtsAbortController.abort();
        this.send({ type: "audio_clear_tag", tag: "interpret" });
      }
      const controller = new AbortController();
      this.studentTtsAbortController = controller;

      logLiveSession("STUDENT TTS START", `text="${singleSentence}" voice=${JSON.stringify({ fallbackType: this.studentVoice.fallbackType, language: this.studentVoice.language, hasGemini: !!this.studentVoice.geminiVoiceName, hasCustom: !!this.studentVoice.customVoice })}`);
      this.preGenTtsPromise = this.streamTtsWithTimeout(
        singleSentence,
        this.studentVoice,
        "interpretation_audio",
        "Student",
        15_000,
        controller.signal,
      ).then(() => {
        if (this.studentTtsAbortController === controller) this.studentTtsAbortController = null;
        logLiveSession("STUDENT TTS DONE", `text="${singleSentence}"`);
      }).catch(err => {
        if (this.studentTtsAbortController === controller) this.studentTtsAbortController = null;
        logLiveSession("STUDENT TTS ERROR", (err as Error).message);
        console.error("[LiveRelay] Student TTS error:", (err as Error).message);
      });
    } else {
      logLiveSession("STUDENT TTS SKIPPED", `singleSentence=${!!singleSentence} studentVoice=${!!this.studentVoice}`);
    }
  }

  // -------------------------------------------------------------------------
  // Tool handling
  // -------------------------------------------------------------------------

  private async handleToolCalls(calls: ToolCall[]): Promise<void> {
    const callNames = calls.map(c => c.name).join(", ");
    logLiveSession("handleToolCalls", `calls=[${callNames}] state=${this.state}`);

    // During debug introspection: check if the model called debug_message
    // (the intended way to report what it tried). If so, capture the message.
    // Any other tool calls during debug are acknowledged but not executed.
    if (this.awaitingDebugResponse) {
      for (const call of calls) {
        if (call.name === "debug_message") {
          const msg = extractStringArg(call.args, "message");
          if (msg) this.debugResponseBuffer += msg;
          logLiveSession("DEBUG: debug_message received", msg || "(empty)");
        } else {
          logLiveSession("DEBUG: non-debug tool call suppressed", `${call.name}(${JSON.stringify(call.args)})`);
          this.debugResponseBuffer += `\n[Also tried to call: ${call.name}(${JSON.stringify(call.args)})]`;
        }
      }
      this.provider?.sendToolResponseAsContent(
        calls.map(c => ({ id: c.id, name: c.name || "unknown", response: { output: "ok" } })),
      );
      return;
    }

    // If we're in processing_turn (duplicate turn), resolve the open
    // functionCall(s) with a structured "already handled" response so the
    // model's state stays consistent without triggering another generation.
    if (this.state === "processing_turn") {
      logLiveSession("DUPLICATE TURN", `Suppressed ${callNames} — state=processing_turn`);
      this.provider?.sendToolResponseAsContent(
        calls.map(c => ({ id: c.id, name: c.name || "unknown", response: { output: "already handled" } })),
      );
      return;
    }

    // Move to in_turn state — model is responding to the button press
    this.setState("in_turn");
    this.consecutiveSafetyBlocks = 0;
    this.rejectionCooldownUntil = 0;
    this.pendingRetryPrompt = null;  // model responded — no retry needed

    // ────────────────────────────────────────────────────────────────────────
    // Tool result delivery — CRITICAL TIMING
    //
    // Send tool responses IMMEDIATELY before processing (board building,
    // symbol lookup, etc.). The model waits for the functionResponse before
    // continuing to generate audio — if we process the tools first (which
    // can take 500ms+ for symbol lookups), the model times out and completes
    // its turn with zero audio output.
    //
    // Using sendToolResponse (protocol-native path) — verified 2026-05-11
    // that this is required for the upgraded model to actually generate
    // audio after tool calls. The previous sendToolResponseAsContent
    // workaround broke responsiveness on the upgraded native-audio model.
    //
    // scheduling: "SILENT" — request that this functionResponse NOT trigger
    // a new generation. Per project memory, on older model versions this was
    // silently ignored for BLOCKING tools (and all tools are BLOCKING on
    // Vertex because NON_BLOCKING is rejected), so every tool response
    // triggered a duplicate turn. Re-trying on the upgraded model in case
    // server-side behavior changed.
    if (this.provider) {
      this.provider.sendToolResponse(
        calls.map(c => ({
          id: c.id,
          name: c.name || "unknown",
          response: { output: "ok" },
          scheduling: "SILENT" as const,
        })),
      );
    }

    // Now process tools (board building, symbol lookup, etc.) — the model
    // is already continuing to generate audio in parallel.
    for (const call of calls) {
      try {
        logDualAgent("LiveRelay.toolCall", { sessionId: this.sessionId, name: call.name, args: call.args });
        logLiveSession(`TOOL CALL: ${call.name}`, JSON.stringify({ id: call.id, args: call.args }, null, 2));
        await this.handleSingleToolCall(call);
      } catch (err) {
        const errMsg = (err as Error).message;
        console.error(`[LiveRelay] Tool call "${call.name}" failed:`, errMsg);
        logLiveSession(`TOOL ERROR: ${call.name}`, errMsg);
      }
    }
  }

  /**
   * Process a single tool call and return the tool response.
   */
  private async handleSingleToolCall(call: ToolCall): Promise<ToolResponse> {
    const name = call.name || "unknown";
    const args = call.args || {};
    const isMuted = this.muteState === "muted";
    const state = this.sessionCache?.state;

    switch (name) {
      case "speak": {
        const text = extractStringArg(args, "text");
        // In direct audio mode, the model speaks via native audio — ignore hallucinated speak() calls
        if (this.useDirectAudio) {
          logLiveSession("IGNORED TOOL CALL", `speak() in direct audio mode — model speaks natively`);
          if (text) this.hasGreeted = true;
          return { id: call.id, name, response: { output: "ok — you speak directly, no need to call speak()" } };
        }
        if (!text) {
          logLiveSession("EMPTY TOOL CALL", `speak() got empty text. Raw args: ${JSON.stringify(args)}`);
        }
        if (text && !isMuted) {
          const hasPreGenTts = this.preGenTtsPromise !== null;
          this.send({ type: "text", data: text, noAudioClear: hasPreGenTts || undefined });
        }
        if (text) this.hasGreeted = true;
        this.turnAccum.speakText += (this.turnAccum.speakText ? " " : "") + text;
        return { id: call.id, name, response: { output: "ok" } };
      }

      case "interpret": {
        // interpret() is no longer a declared tool — ignore if model hallucates it
        logLiveSession("IGNORED TOOL CALL", `interpret() — not a declared tool`);
        return { id: call.id, name, response: { output: "ok" } };
      }

      case "transcript": {
        const text = extractStringArg(args, "text");
        const speaker = (typeof args.speaker === "string" ? args.speaker : "Unknown");
        const confidence = args.confidence as string | undefined;
        this.send({ type: "transcript", data: text, speaker, confidence });
        this.turnAccum.transcriptText += `[${speaker}] ${text} `;
        this.turnAccum.transcriptSpeaker = speaker;
        return { id: call.id, name, response: { output: "ok" } };
      }

      case "update_context": {
        // Typed observations — build a structured world model over time.
        // These are logged/displayed but don't trigger any side effects.
        const obsType = extractStringArg(args, "type") || "other";
        const key = extractStringArg(args, "key");
        const description = extractStringArg(args, "description");
        // Backwards-compat: if the model passes the old "text" arg, use it
        const legacyText = extractStringArg(args, "text");
        const formatted = description || legacyText
          ? `[${obsType}${key ? `: ${key}` : ""}] ${description || legacyText}`
          : `[${obsType}${key ? `: ${key}` : ""}]`;
        logLiveSession("CONTEXT OBSERVATION", formatted);
        this.send({ type: "context", data: formatted });
        this.turnAccum.contextText += (this.turnAccum.contextText ? " " : "") + formatted;
        return { id: call.id, name, response: { output: "ok" } };
      }

      case "add_context_button": {
        // Add ONE button to the context sidebar. Oldest scrolls out when full.
        const ctxButtons = toolArgsToButtons(args.button);
        if (ctxButtons.length === 0) {
          return { id: call.id, name, response: { error: "No valid button provided" } };
        }
        const btn = ctxButtons[0];
        const labelLower = btn.label.toLowerCase();

        // Reject collision with main board — same label on both sidebars makes
        // sentence lookup ambiguous on the client (the press dispatches whichever
        // button was tapped, but with identical labels users can't tell them apart).
        if (state?.boardButtonLabels.some(l => l.toLowerCase() === labelLower)) {
          return { id: call.id, name, response: {
            error: `A button labeled "${btn.label}" already exists on the main board. Choose a different label for the context sidebar (e.g. add a qualifier).`,
            main_board_buttons: state.boardButtonLabels.join(", "),
          }};
        }

        // Deduplicate: if a button with the same label already exists, skip it
        const existingIdx = this.contextButtonLabels.findIndex(
          l => l.toLowerCase() === labelLower
        );
        if (existingIdx >= 0) {
          return { id: call.id, name, response: {
            output: "already exists",
            current_context_buttons: this.contextButtonLabels.join(", "),
          }};
        }

        const unresolvedKeys = await this.resolveExistingSymbols([btn]);
        this.queueMissingSymbolGeneration([btn], unresolvedKeys);

        // Track server-side and send to client
        this.contextButtonLabels.push(btn.label);
        if (this.contextButtonLabels.length > 4) {
          this.contextButtonLabels.shift(); // oldest scrolls out
        }

        this.send({ type: "context_button_add", data: {
          label: btn.label,
          iconRef: btn.iconRef,
          symbolPath: btn.symbolPath,
          imageKey: btn.imageKey,
          sentence: btn.sentence,
          buttonType: btn.buttonType,
        }});
        logLiveSession("CONTEXT_BUTTON", `Added: ${btn.label} | Visible: [${this.contextButtonLabels.join(", ")}]`);

        return { id: call.id, name, response: {
          output: "ok",
          added: btn.label,
          current_context_buttons: this.contextButtonLabels.join(", "),
        }};
      }

      case "suggest_construction_buttons": {
        const rawCandidates = Array.isArray(args.candidates) ? args.candidates : [];
        const slotIndex = Number.isInteger(args.slot_index) ? args.slot_index as number : 0;
        // Tolerate both shapes the model emits in practice:
        //   1. {key: "water", label?: "Water"} — what the schema specifies
        //   2. "water" — bare string (Vertex Live often ignores object schemas)
        const candidates = rawCandidates
          .map((c) => {
            if (typeof c === "string" && c.trim().length > 0) {
              return { key: c.trim(), label: undefined as string | undefined };
            }
            if (c && typeof c === "object" && typeof c.key === "string" && c.key.trim().length > 0) {
              return { key: c.key.trim(), label: typeof c.label === "string" ? c.label : undefined };
            }
            return null;
          })
          .filter((c): c is { key: string; label: string | undefined } => c !== null)
          .slice(0, 4);

        logLiveSession("CONSTRUCTION_SUGGEST_RAW",
          `slot=${slotIndex} rawCount=${rawCandidates.length} validCount=${candidates.length} rawShape=${JSON.stringify(rawCandidates).substring(0, 200)}`);

        if (candidates.length === 0) {
          logLiveSession("CONSTRUCTION_SUGGEST_REJECT", "no valid candidates after normalization");
          return { id: call.id, name, response: { error: "No valid candidates provided" } };
        }

        this.send({
          type: "construction_suggestions",
          data: { targetSlot: slotIndex, candidates },
        });
        logLiveSession("CONSTRUCTION_SUGGEST", `slot=${slotIndex} keys=[${candidates.map(c => c.key).join(", ")}]`);
        return { id: call.id, name, response: { output: "ok", count: candidates.length } };
      }

      case "set_construction_memory_chips": {
        const category = args.category;
        const validCategories = new Set(["who", "do", "what", "where", "when"]);
        if (typeof category !== "string" || !validCategories.has(category)) {
          return { id: call.id, name, response: { error: "Invalid category" } };
        }
        const rawChips = Array.isArray(args.chips) ? args.chips : [];
        const chips = rawChips
          .filter((c): c is { key: string; label: string } =>
            !!c && typeof c.key === "string" && typeof c.label === "string" &&
            c.key.trim().length > 0 && c.label.trim().length > 0
          )
          .slice(0, 3)
          .map((c) => ({ key: c.key.trim(), label: c.label.trim() }));

        this.send({
          type: "construction_memory_chips",
          data: { category: category as ConstructionMemoryChipsWire["category"], chips },
        });
        logLiveSession("CONSTRUCTION_MEMORY_CHIPS", `category=${category} chips=[${chips.map(c => c.key).join(", ")}]`);
        return { id: call.id, name, response: { output: "ok", count: chips.length } };
      }

      case "add_buttons": {
        const buttons = dedupeImageKeys(toolArgsToButtons(args.buttons));
        const maxSlots = state?.maxBoardItems || 8;

        // When a prebuilt board is loaded, redirect to rebuild_board for the side panel
        if (state?.loadedBoardId) {
          return {
            id: call.id,
            name,
            response: { error: "Cannot add buttons to a prebuilt board. Call rebuild_board() to replace it with a dynamic board, or use add_context_button() to add to the context sidebar." },
          };
        }

        // Split buttons: those that fit go on the main board, overflow goes to context sidebar
        let mainButtons = buttons;
        let overflowButtons: typeof buttons = [];
        if (state) {
          const available = maxSlots - state.boardButtonLabels.length;
          if (buttons.length > available) {
            mainButtons = buttons.slice(0, available);
            overflowButtons = buttons.slice(available);
            logLiveSession("ADD_BUTTONS OVERFLOW", `${overflowButtons.length} button(s) overflow to context sidebar (board ${state.boardButtonLabels.length}/${maxSlots})`);
          }
          state.boardButtonLabels = [...state.boardButtonLabels, ...mainButtons.map(b => b.label)];
        }

        // Resolve existing symbols from DB
        const allButtons = [...mainButtons, ...overflowButtons];
        const unresolvedKeys = await this.resolveExistingSymbols(allButtons);
        this.queueMissingSymbolGeneration(allButtons, unresolvedKeys);

        // Add main buttons to the board
        if (mainButtons.length > 0) {
          this.lastBoardUpdateTime = Date.now();

          // Evict any context-sidebar buttons that share a label with the new
          // main buttons — collision causes ambiguous sentence playback.
          const newMainLabelsLower = new Set(mainButtons.map(b => b.label.toLowerCase()));
          const removedFromContext: string[] = [];
          this.contextButtonLabels = this.contextButtonLabels.filter(label => {
            if (newMainLabelsLower.has(label.toLowerCase())) {
              removedFromContext.push(label);
              return false;
            }
            return true;
          });
          for (const label of removedFromContext) {
            this.send({ type: "context_button_remove", data: { label } });
          }

          this.send({ type: "board_patch", data: { add: mainButtons, remove: [] } });
          this.turnAccum.boardChanged = true;
          this.turnAccum.boardAddLabels.push(...mainButtons.map(b => b.label));
        }

        // Send overflow buttons to context sidebar
        for (const btn of overflowButtons) {
          if (this.contextButtonLabels.some(l => l.toLowerCase() === btn.label.toLowerCase())) continue;
          this.contextButtonLabels.push(btn.label);
          if (this.contextButtonLabels.length > 4) this.contextButtonLabels.shift();
          this.send({ type: "context_button_add", data: {
            label: btn.label,
            iconRef: btn.iconRef,
            symbolPath: btn.symbolPath,
            imageKey: btn.imageKey,
            sentence: btn.sentence,
          }});
        }

        let stateMsg = "";
        if (state) {
          const available = maxSlots - state.boardButtonLabels.length;
          stateMsg = `Board: ${state.boardButtonLabels.length}/${maxSlots} buttons (${available} available): ${state.boardButtonLabels.join(", ")}`;
          if (overflowButtons.length > 0) {
            stateMsg += `. ${overflowButtons.length} button(s) moved to context sidebar.`;
          }
        }

        return { id: call.id, name, response: { output: "ok", board_state: stateMsg } };
      }

      case "remove_buttons": {
        const labels = args.labels as string[] || [];
        const maxSlots = state?.maxBoardItems || 12;

        if (state?.loadedBoardId) {
          return {
            id: call.id,
            name,
            response: { error: "Cannot remove buttons from a prebuilt board. Call rebuild_board() to replace it with a dynamic board." },
          };
        }

        if (state) {
          const removeSet = new Set(labels.map(l => l.toLowerCase()));
          state.boardButtonLabels = state.boardButtonLabels.filter(l => !removeSet.has(l.toLowerCase()));
        }

        this.lastBoardUpdateTime = Date.now();
        this.send({ type: "board_patch", data: { add: [], remove: labels } });
        this.turnAccum.boardChanged = true;
        this.turnAccum.boardRemoveLabels.push(...labels);

        let stateMsg = "";
        if (state) {
          const available = maxSlots - state.boardButtonLabels.length;
          stateMsg = `Board: ${state.boardButtonLabels.length}/${maxSlots} buttons (${available} available): ${state.boardButtonLabels.join(", ") || "none"}`;
        }

        return { id: call.id, name, response: { output: "ok", board_state: stateMsg } };
      }

      case "rebuild_board": {
        // rebuild_board ALWAYS replaces the main board (max 8 buttons). If a custom
        // board is currently loaded, it's unloaded first. The side panel (context
        // sidebar) is separate and managed only by add_context_button.

        // Optional 'response' parameter — the model's declaration of what
        // it intends to say aloud, alongside this board update. NOT routed
        // through TTS; the model still produces native audio for the actual
        // speech. Writing the response text in the tool call is meant to
        // help the model commit to producing the audio (the function-call
        // pathway is more reliable on this model than audio output alone).
        // The text is logged for the monitor agent and shows up in the UI.
        const responseText = extractStringArg(args, "response").trim();
        if (responseText) {
          // Recorded as INTENDED speech, NOT actual speech. We don't add it
          // to speakText (which tracks actual audio output via
          // outputTranscription) — the auto-continuation logic uses the
          // gap between intended speech and produced audio to decide
          // whether to nudge.
          this.turnAccum.rebuildBoardIntendedSpeech = responseText;
          logLiveSession("REBUILD_BOARD response param", responseText);
          // NOTE: We deliberately do NOT send the response text to the client
          // here. The visible header text comes from the model's actual
          // outputTranscription as it speaks the audio. Emitting it now would
          // double-print: rebuild_board's response → "X" appended; then the
          // auto-continuation nudge fires → model speaks → outputTranscription
          // chunks of "X" appended to the SAME accumulator (no `complete`
          // event resets the buffer between the two turns). Net result: header
          // shows "XX". The intended-speech string is kept purely for
          // auto-continuation steering (see handleTurnComplete).
        }

        const wasPrebuiltLoaded = !!state?.loadedBoardId;
        const maxSlots = 8;
        const buttons = dedupeImageKeys(toolArgsToButtons(args.buttons).slice(0, maxSlots));

        if (state) {
          state.loadedBoardId = null;
          state.loadedBoardData = undefined;
          state.currentPageId = null;
          state.pageHistory = [];
          state.maxBoardItems = maxSlots;
          state.aiAddedButtonLabels = [];
          state.boardButtonLabels = buttons.map(b => b.label);
        }

        const unresolvedKeys = await this.resolveExistingSymbols(buttons);
        this.queueMissingSymbolGeneration(buttons, unresolvedKeys);

        // Evict any context-sidebar buttons whose label collides with the new
        // main board — same-label buttons on both sidebars cause ambiguous
        // sentence playback when the user taps "the wrong one".
        const newMainLabelsLower = new Set(buttons.map(b => b.label.toLowerCase()));
        const removedFromContext: string[] = [];
        this.contextButtonLabels = this.contextButtonLabels.filter(label => {
          if (newMainLabelsLower.has(label.toLowerCase())) {
            removedFromContext.push(label);
            return false;
          }
          return true;
        });
        for (const label of removedFromContext) {
          this.send({ type: "context_button_remove", data: { label } });
        }
        if (removedFromContext.length > 0) {
          logLiveSession("CONTEXT_BUTTON", `Evicted on rebuild (collide with main): ${removedFromContext.join(", ")}`);
        }

        this.lastBoardUpdateTime = Date.now();
        if (wasPrebuiltLoaded) {
          this.send({ type: "unload_board", data: {} });
        }
        this.send({ type: "board", data: this.buildBoardFromButtons(buttons) });


        this.turnAccum.boardChanged = true;
        this.turnAccum.boardRebuilt = true;
        this.turnAccum.boardAddLabels.push(...buttons.map(b => b.label));

        // Guessing mode: exit if no [GUESS] buttons in the rebuild
        if (this.guessingMode && !buttons.some(b => b.buttonType === "guess")) {
          this.guessingMode = false;
          this.send({ type: "guessing_mode", active: false });
          logLiveSession("GUESSING_MODE", "Exited — rebuild_board has no [GUESS] buttons");
        }

        const stateMsg = `Main board rebuilt. ${buttons.length}/${maxSlots} buttons: ${buttons.map(b => b.label).join(", ")}`;
        return { id: call.id, name, response: { output: "ok", board_state: stateMsg } };
      }

      case "set_board": {
        const boardKey = extractStringArg(args, "board_key").toLowerCase().replace(/ /g, "_");
        if (!state) {
          return { id: call.id, name, response: { error: "No session state" } };
        }
        const match = state.availableBoards?.find(b => b.key === boardKey);
        if (!match) {
          const availableKeys = state.availableBoards?.map(b => b.key).join(", ") || "none";
          return { id: call.id, name, response: { error: `Board "${boardKey}" not found. Available: ${availableKeys}` } };
        }

        try {
          // Virtual home board is in memory, not the DB
          let boardData: any;
          if (match.key === HOME_BOARD_KEY && this.homeBoardData) {
            boardData = this.homeBoardData;
          } else {
            const fullBoard = await boardRepository.getBoard(match.id);
            if (!fullBoard?.irData) {
              return { id: call.id, name, response: { error: "Board has no data" } };
            }
            boardData = fullBoard.irData as any;
          }
          state.loadedBoardId = match.id;
          state.loadedBoardData = boardData;
          state.permittedWebsites = mergeBoardWebsitesIntoPermitted(state.permittedWebsites, boardData);
          state.currentPageId = boardData.pages?.[0]?.id || null;
          state.pageHistory = [];
          state.maxBoardItems = (boardData.grid?.rows || 3) * (boardData.grid?.cols || 4);
          state.aiAddedButtonLabels = [];
          const nativeLabels = this.getNativePageButtonLabels(state);
          state.boardButtonLabels = [...nativeLabels];

          this.send({ type: "set_board", data: { board: boardData, name: match.name, boardId: match.id } });
          this.turnAccum.setBoardName = match.name;
          this.turnAccum.boardChanged = true;

          logDualAgent("LiveRelay.setBoard", { sessionId: this.sessionId, boardName: match.name, boardId: match.id });

          return {
            id: call.id,
            name,
            response: {
              output: "ok",
              board_name: match.name,
              pages: boardData.pages?.length || 1,
              board_buttons: nativeLabels.join(", "),
              note: "Board loaded. Its buttons are shown in the main area and cannot be modified by add_buttons/remove_buttons. To replace this board with a dynamic one, call rebuild_board(). The context sidebar (left) is separate — use add_context_button() for environment observations.",
            },
          };
        } catch (err) {
          return { id: call.id, name, response: { error: `Failed to load board: ${(err as Error).message}` } };
        }
      }

      case "press_button": {
        const label = extractStringArg(args, "label").trim();
        if (!state?.loadedBoardData) {
          return { id: call.id, name, response: { error: "No custom board loaded" } };
        }

        const currentPage = state.loadedBoardData.pages?.find((p: any) => p.id === state.currentPageId)
          || state.loadedBoardData.pages?.[0];
        if (!currentPage?.buttons) {
          return { id: call.id, name, response: { error: "Current page has no buttons" } };
        }

        const btn = currentPage.buttons.find((b: any) =>
          b.label.toLowerCase().trim() === label.toLowerCase().trim()
        );
        if (!btn?.action) {
          return { id: call.id, name, response: { error: `Button "${label}" not found or has no action` } };
        }

        const navResult = this.executeButtonNavigation(btn, state);
        this.turnAccum.pressButtonLabel = label;
        this.turnAccum.boardChanged = true;

        return { id: call.id, name, response: navResult };
      }

      case "emote": {
        const emotion = extractStringArg(args, "emotion", "neutral");
        if (state) {
          state.currentEmote = emotion as any;
        }
        this.send({ type: "emote", data: emotion });
        this.turnAccum.emote = emotion as any;
        return { id: call.id, name, response: { output: "ok" } };
      }

      case "open_app": {
        const appId = extractStringArg(args, "app_id");
        const data = args.data as string | undefined;

        // If the id matches a built-in AAC app, use the existing flow.
        const builtIn = getAppDefinition(appId);
        if (builtIn) {
          this.turnAccum.openAppData = { appId, data };

          // YouTube and Spotify need a search to resolve a specific video/track
          // before the client can render anything. We run the search in the
          // post-turn handler and send `video_play` / `app_open` (with trackId)
          // from there. For YouTube with permitted channels, an empty query is
          // valid (returns most-recent). For YouTube without channels + no API
          // key, the search will return null and we need to tell the model.
          if (appId === "youtube") {
            const channels = state?.permittedYoutubeChannels || [];
            const hasChannels = channels.length > 0;
            const hasApiKey = !!process.env.YOUTUBE_API_KEY;

            // No data + no channels → nothing to show. Tell the AI.
            if (!data && !hasChannels) {
              return {
                id: call.id,
                name,
                response: {
                  output: "error: open_app(youtube) needs a `data` parameter (search query) when no permitted channels are configured. Pass e.g. 'counting songs'.",
                },
              };
            }
            // No channels and no API key → search can't run at all.
            if (!hasChannels && !hasApiKey) {
              return {
                id: call.id,
                name,
                response: {
                  output: "error: YouTube search is unavailable — no permitted channels are configured and no API key is set. Tell the student this activity isn't available and suggest something else.",
                },
              };
            }
            // No data + channels → open the browse UI so the student picks
            // a channel and video manually. Don't run a search, don't auto-play.
            if (!data && hasChannels) {
              this.send({
                type: "app_open",
                data: { appId: "youtube", appData: { channels } },
              });
              // Clear openAppData so the post-turn handler doesn't also run a search.
              this.turnAccum.openAppData = null;
              return {
                id: call.id,
                name,
                response: {
                  output: "ok. The YouTube app is now open showing the permitted channels. The student will pick a channel and a video. Call rebuild_board() with buttons relevant to this activity. You'll receive a [YOUTUBE] context update when they pick a video.",
                },
              };
            }
            // Data + channels/key → search-to-play. The post-turn handler will
            // send video_play (or inject a [SYSTEM] message if nothing matched).
            return {
              id: call.id,
              name,
              response: { output: "ok. Looking up a video now — the player will appear on screen in a moment. Call rebuild_board() with buttons relevant to this activity." },
            };
          }

          const needsSearch = data && appId === "spotify";
          if (!needsSearch) {
            this.send({ type: "app_open", data: { appId, data } });
          }
          return {
            id: call.id,
            name,
            response: { output: "ok. The app is now open on screen. Call rebuild_board() with contextual buttons relevant to this app activity." },
          };
        }

        // Otherwise assume it's a custom app (game) — load + ship to client.
        try {
          const app = await customAppRepository.getApp(appId);
          if (!app) {
            return { id: call.id, name, response: { output: `error: app ${appId} not found` } };
          }
          const validation = validateCustomAppDefinition(app.definition);
          if (!validation.ok) {
            return {
              id: call.id,
              name,
              response: { output: `error: custom app definition is invalid: ${validation.errors.slice(0, 2).join("; ")}` },
            };
          }
          this.send({
            type: "app_open",
            data: {
              appId: "custom_app",
              appData: { id: app.id, definition: validation.data },
            },
          });
          return {
            id: call.id,
            name,
            response: {
              output:
                "ok. The game is now on screen. The student is playing. You will receive [GAME] context updates as they play — narrate, encourage, and guide. Call rebuild_board() with contextual buttons relevant to this game.",
            },
          };
        } catch (err) {
          return { id: call.id, name, response: { output: `error: ${String(err)}` } };
        }
      }

      case "close_app": {
        this.turnAccum.closeApp = true;
        this.send({ type: "app_close", data: {} });
        return { id: call.id, name, response: { output: "ok" } };
      }

      case "open_website": {
        const url = extractStringArg(args, "url");
        const label = (args.label as string | undefined)?.trim() || url;
        if (!url) {
          return { id: call.id, name, response: { output: "error: url is required" } };
        }

        const permitted = state?.permittedWebsites || [];
        if (!isUrlPermitted(url, permitted)) {
          return {
            id: call.id,
            name,
            response: { output: `error: the URL "${url}" is not in the permitted-websites list. Choose a URL that matches one of the permitted entries (or ask the caretaker to add it).` },
          };
        }

        this.turnAccum.openWebsiteData = { url, label };
        this.send({ type: "app_open", data: { appId: "browser", appData: { url, label } } });
        return {
          id: call.id,
          name,
          response: {
            output: `ok. The browser is now open at ${url}. Call rebuild_board() with contextual buttons relevant to the site. You will receive [BROWSER] updates as the student navigates.`,
          },
        };
      }


      case "call_monitor": {
        const reason = args.reason as string || "unspecified";
        this.turnAccum.callMonitorReason = reason;
        return { id: call.id, name, response: { output: "ok" } };
      }

      case "yes_no": {
        this.send({ type: "yes_no", data: {} });
        return { id: call.id, name, response: { output: "ok" } };
      }

      case "ask_yes_no": {
        this.send({ type: "ask_yes_no", data: {} });
        return { id: call.id, name, response: { output: "ok" } };
      }

      case "request_focus": {
        const reason = args.reason as string || "";
        this.turnAccum.focusReason = reason;
        this.send({ type: "focus_request", data: { reason } });
        return { id: call.id, name, response: { output: "ok" } };
      }

      case "set_interaction_mode": {
        const mode = args.mode as string;
        const reason = (args.reason as string) || "";
        if (mode !== "interact" && mode !== "assist" && mode !== "standby") {
          return { id: call.id, name, response: { error: "mode must be 'interact', 'assist', or 'standby'" } };
        }
        logLiveSession("MODE CHANGE (AI)", `→ ${mode} (reason: ${reason})`);
        // "assist" / "standby" are lighter states — AI stays active but less proactive.
        // Don't change muteState (that's user-controlled via cave click).
        // Instead, set the avatar emote and notify the client.
        this.send({ type: "interaction_mode_changed", data: { mode, reason, source: "ai" } });
        // First entry into interact mode in this session (or first entry after
        // waking from hibernation) — nudge the AI to greet now that presence
        // is confirmed. Skip when muted: the AI must not speak in mute mode.
        if (
          mode === "interact" &&
          !this.hasGreetedInteract &&
          this.muteState !== "muted" &&
          this.provider
        ) {
          // Voice-first phrasing — analytical checklists trigger proactivity to
          // route the greeting silently into rebuild_board.response instead of
          // emitting native audio. Make the audio command explicit and primary.
          const hour = new Date().getHours();
          const partOfDay =
            hour < 5 ? "night" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 22 ? "evening" : "night";
          const presenceClause = reason ? ` ${reason}` : "";
          const greetingNudge = `[GREET]${presenceClause} You are now in interact mode (${partOfDay}). Greet them out loud right now using your voice — one short, warm sentence appropriate to the ${partOfDay} and what you can see of their mood. Immediately after greeting, call rebuild_board() with 3-4 follow-up buttons.`;
          logLiveSession("GREETING (interact entry)", greetingNudge);
          // sendMessage (turnComplete=true) — sendContextInjection would set
          // turnComplete=false and the nudge would just sit in the buffer until
          // the next frame_grid arrived, leaving the greeting silent.
          this.provider.sendMessage(greetingNudge, "user");
          // Mark this turn so AUTO_CONTINUATION (handleTurnComplete) can re-prompt
          // if the model produces a board with declared intent but no audio.
          this.lastTurnHadGreet = true;
          // Tracks across the whole greet+retry sequence — latches hasGreetedInteract
          // only when audio actually comes out, even if it takes an auto-continuation.
          this.greetAudioPending = true;
          // Note: hasGreetedInteract is NOT set here. We only latch it in
          // handleTurnComplete once the greet actually produces audio. Otherwise
          // a silent first attempt would lock the session out of ever greeting,
          // even if the model rapidly cycles standby ↔ interact afterwards.
        }
        return { id: call.id, name, response: { output: `mode set to ${mode}` } };
      }

      case "debug_message": {
        // Outside of debug context this is a no-op. During debug, the message
        // is captured by the handleToolCalls guard above, not here.
        logLiveSession("IGNORED TOOL CALL", `debug_message outside debug context`);
        return { id: call.id, name, response: { output: "ok" } };
      }

      case "sleep": {
        logLiveSession("SLEEP TOOL", "AI requested transition to Asleep");
        this.send({ type: "sleep_state_change", data: { state: "asleep", source: "ai" } });
        this.recordSleepStateChange("asleep", "ai");
        return { id: call.id, name, response: { output: "session marked asleep" } };
      }

      case "end_session": {
        logLiveSession("END_SESSION TOOL", "AI requested transition to Hibernation");
        this.send({ type: "sleep_state_change", data: { state: "hibernation", source: "ai" } });
        this.recordSleepStateChange("hibernation", "ai");
        return { id: call.id, name, response: { output: "session ended" } };
      }

      case "report_false_wake": {
        const reason = (args.reason as string) || "unspecified";
        logLiveSession("FALSE_WAKE TOOL", `reason: ${reason}`);
        this.send({ type: "false_wake_report", data: { reason } });
        return { id: call.id, name, response: { output: "false wake noted" } };
      }

      case "stay_silent": {
        const reason = extractStringArg(args, "reason").trim();
        if (!reason) {
          return { id: call.id, name, response: { error: "reason is required" } };
        }
        logLiveSession("STAY_SILENT", reason);
        this.turnAccum.staySilentReason = reason;
        // Persist to pendingMessages so the monitor agent and any future
        // reconnection sees it as part of the conversation history. It is
        // never sent to the client, so the user never sees or hears it.
        if (this.sessionId) {
          await dualAgentService.addPendingMessage(this.sessionId, {
            role: "assistant",
            content: `[STAY_SILENT] ${reason}`,
            timestamp: Date.now(),
          });
        }
        return { id: call.id, name, response: { output: "silence acknowledged" } };
      }

      case "private_note": {
        const note = extractStringArg(args, "note").trim();
        if (!note) {
          return { id: call.id, name, response: { error: "note is required" } };
        }
        logLiveSession("PRIVATE_NOTE", note);
        // Persist to pendingMessages so the monitor agent and any future
        // reconnection sees it as part of the conversation history. It is
        // never sent to the client, so the user never sees or hears it.
        if (this.sessionId) {
          await dualAgentService.addPendingMessage(this.sessionId, {
            role: "assistant",
            content: `[PRIVATE_NOTE] ${note}`,
            timestamp: Date.now(),
          });
        }
        return { id: call.id, name, response: { output: "noted" } };
      }

      default:
        console.warn(`[LiveRelay] Unknown tool call: ${name}`);
        return { id: call.id, name, response: { error: `Unknown tool: ${name}` } };
    }
  }

  /**
   * Execute a navigation button press on a custom board.
   */
  private executeButtonNavigation(btn: any, state: DualAgentSessionState): Record<string, unknown> {
    const action = btn.action;

    if (action.type === "link" && action.toPageId) {
      const targetPage = state.loadedBoardData?.pages?.find((p: any) => p.id === action.toPageId);
      if (!targetPage) return { error: "Target page not found" };

      if (state.currentPageId) {
        state.pageHistory = [...(state.pageHistory || []), state.currentPageId];
      }
      state.currentPageId = targetPage.id;
      state.aiAddedButtonLabels = [];
      state.boardButtonLabels = this.getNativePageButtonLabels(state);

      this.send({
        type: "ai_button_press",
        data: {
          label: btn.label,
          action: "link",
          targetPageId: targetPage.id,
          targetPageName: targetPage.name || targetPage.id,
          buttons: targetPage.buttons || [],
        },
      });

      if (this.sessionId) {
        dualAgentService.addPendingMessage(this.sessionId, {
          role: "assistant",
          content: `[AI navigated to page "${targetPage.name || targetPage.id}"]`,
          timestamp: Date.now(),
        }).catch(err => console.error("[LiveRelay] Failed to persist nav message:", err));
      }

      const buttonLabels = (targetPage.buttons || []).map((b: any) => b.label).join(", ");
      return { output: "ok", page: targetPage.name || targetPage.id, buttons: buttonLabels };
    }

    if (action.type === "back") {
      const history = state.pageHistory || [];
      if (history.length === 0) return { error: "No page history to go back to" };

      const prevPageId = history[history.length - 1];
      state.pageHistory = history.slice(0, -1);
      state.currentPageId = prevPageId;
      state.aiAddedButtonLabels = [];
      state.boardButtonLabels = this.getNativePageButtonLabels(state);

      const prevPage = state.loadedBoardData?.pages?.find((p: any) => p.id === prevPageId);
      if (prevPage) {
        this.send({
          type: "ai_button_press",
          data: {
            label: btn.label,
            action: "back",
            targetPageId: prevPageId,
            targetPageName: prevPage.name || prevPageId,
            buttons: prevPage.buttons || [],
          },
        });
        const buttonLabels = (prevPage.buttons || []).map((b: any) => b.label).join(", ");
        return { output: "ok", page: prevPage.name || prevPageId, buttons: buttonLabels };
      }
      return { output: "ok" };
    }

    if (action.type === "home") {
      const homePage = state.loadedBoardData?.pages?.[0];
      if (!homePage) return { error: "No home page found" };

      state.pageHistory = [];
      state.currentPageId = homePage.id;
      state.aiAddedButtonLabels = [];
      state.boardButtonLabels = this.getNativePageButtonLabels(state);

      this.send({
        type: "ai_button_press",
        data: {
          label: btn.label,
          action: "home",
          targetPageId: homePage.id,
          targetPageName: homePage.name || homePage.id,
          buttons: homePage.buttons || [],
        },
      });
      const buttonLabels = (homePage.buttons || []).map((b: any) => b.label).join(", ");
      return { output: "ok", page: homePage.name || homePage.id, buttons: buttonLabels };
    }

    if (action.type === "exit") {
      // Unload the board and return to the dynamic board
      state.loadedBoardId = null;
      state.loadedBoardData = undefined;
      state.currentPageId = null;
      state.pageHistory = [];
      state.aiAddedButtonLabels = [];
      state.boardButtonLabels = [];
      state.maxBoardItems = 12;

      this.send({ type: "unload_board", data: {} });

      const instruction = action.text || "";

      // Detect guessing mode entry
      if (instruction.includes("[GUESSING MODE]") && !this.guessingMode) {
        this.guessingMode = true;
        this.send({ type: "guessing_mode", active: true });
        logLiveSession("GUESSING_MODE", "Entered via home board button");
      }

      const message = instruction
        ? `Board exited. The user pressed "${btn.label}". ${instruction}`
        : `Board exited. The user pressed "${btn.label}". Use rebuild_board() to create a new board or set_board() to load another.`;

      return { output: message };
    }

    return { error: `Unknown action type: ${action.type}` };
  }

  // -------------------------------------------------------------------------
  // Turn lifecycle
  // -------------------------------------------------------------------------

  private async handleTurnComplete(reason?: string): Promise<void> {
    logLiveSession("handleTurnComplete", `state=${this.state} reason=${reason || "normal"} accum=[speak=${!!this.turnAccum.speakText}, interpret=${!!this.turnAccum.interpretText}, board=${this.turnAccum.boardChanged}, directAudioChunks=${this.directAudioChunks.length}]`);

    // Snapshot the auto-continuation flag and clear it eagerly. If this turn
    // is itself the response to a continuation prompt we sent last time, the
    // snapshot blocks us from firing a second continuation; the cleared field
    // means the *next* genuinely-silent transcript can fire normally.
    const wasAutoContinuationPending = this.autoContinuationPending;
    this.autoContinuationPending = false;

    // Same snapshot-and-clear pattern for the button-press flag. If this turn
    // was a response to a button press, the snapshot is true; the flag is
    // cleared so subsequent turns (frame_grids, etc.) don't false-trigger
    // the nudge.
    const wasButtonPressTurn = this.lastTurnHadButtonPress;
    this.lastTurnHadButtonPress = false;

    // Same for the [GREET] system message we send on first interact entry —
    // but only consume the flag if this turn carries real content. The very
    // next TURN_COMPLETE after sending GREET is the close of the
    // set_interaction_mode tool turn (no audio, no rebuild_board, no transcript).
    // Treat that as transparent and let the flag carry forward to the actual
    // response turn that follows ~1s later.
    const turnHasContent =
      this.directAudioChunks.length > 0 ||
      this.turnAccum.speakText.trim().length > 0 ||
      (this.turnAccum.rebuildBoardIntendedSpeech?.trim().length ?? 0) > 0 ||
      this.turnAccum.transcriptText.trim().length > 0 ||
      !!this.turnAccum.staySilentReason;
    const wasGreetTurn = this.lastTurnHadGreet && turnHasContent;
    if (this.lastTurnHadGreet && !turnHasContent) {
      logLiveSession("GREET FLAG PRESERVED", `intermediate empty tool-ack turn — waiting for real response`);
    }
    if (turnHasContent) {
      this.lastTurnHadGreet = false;
    }

    // If we were waiting for a debug-introspection response (the model calls
    // debug_message() to tell us what it tried), capture it and retry.
    if (this.awaitingDebugResponse) {
      this.awaitingDebugResponse = false;
      const debugAnswer = this.debugResponseBuffer.trim();
      this.debugResponseBuffer = "";
      logLiveSession("DEBUG RESPONSE", debugAnswer || "(empty)");
      // Discard any audio from the debug turn — it was for us, not the user
      if (this.directAudioFlushTimer) { clearTimeout(this.directAudioFlushTimer); this.directAudioFlushTimer = null; }
      this.directAudioChunks = [];
      this.turnAccum = createEmptyAccumulator();
      this.send({ type: "audio_interrupt" });

      // Ask the model to retry, providing its own description of what it tried.
      if (this.debugRetryCount < LiveRelay.DEBUG_MAX_RETRIES && this.provider) {
        this.debugRetryCount++;
        this.setState("awaiting_turn");
        const retryPrompt = `[RETRY ${this.debugRetryCount}/${LiveRelay.DEBUG_MAX_RETRIES}] You said you were trying to: ${debugAnswer || "(no description)"}. Try again now. If you were calling a tool, double-check the function name and argument schema and call ONLY ONE function this turn. If you were speaking, rephrase simply.`;
        logLiveSession("DEBUG RETRY PROMPT", retryPrompt);
        this.provider.sendMessage(retryPrompt, "user");
        return;
      }

      // Out of retries — give up and return to idle with a cooldown so
      // frame_grid doesn't immediately re-trigger the same cycle.
      logLiveSession("DEBUG RETRY EXHAUSTED", `Gave up after ${this.debugRetryCount} retries — cooldown ${LiveRelay.REJECTION_COOLDOWN_MS}ms`);
      this.debugRetryCount = 0;
      this.rejectionCooldownUntil = Date.now() + LiveRelay.REJECTION_COOLDOWN_MS;
      this.setState("idle");
      return;
    }

    // Abnormal turn ends (RESPONSE_REJECTED, MALFORMED_FUNCTION_CALL, etc.) —
    // discard any partial audio that streamed before the rejection. Otherwise the
    // user hears half-words from rejected responses, perceived as duplication.
    const isAbnormal = reason && reason !== "STOP" && reason !== "normal";
    if (isAbnormal) {
      const hadOutput = this.directAudioChunks.length > 0 || this.turnAccum.speakText.trim().length > 0 || this.turnAccum.boardChanged;

      // RESPONSE_REJECTED with zero output = proactiveAudio decided not to
      // respond, OR safety filter rejection. We retry ONCE in case it was a
      // proactive-audio swallow; if the retry also gets rejected, the content
      // is genuinely being filtered and re-sending will get the same result.
      // Clear pendingRetryPrompt before resending so a second rejection falls
      // through to cooldown rather than looping.
      if (reason === "RESPONSE_REJECTED" && !hadOutput) {
        if (this.pendingRetryPrompt && this.provider) {
          const promptToRetry = this.pendingRetryPrompt;
          this.pendingRetryPrompt = null;  // bound retries to one
          logLiveSession("RETRY PROMPT", "RESPONSE_REJECTED after user prompt — resending once");
          this.setState("awaiting_turn");
          this.provider.sendMessage(promptToRetry, "user");
          return;
        }
        logLiveSession("PROACTIVE_SKIP", `RESPONSE_REJECTED with no output — model chose not to respond (or content filter); cooling down`);
        this.debugRetryCount = 0;
        // Cooldown so the next frame_grid / scene update doesn't immediately
        // re-trigger the same content path and burn another rejection cycle.
        this.rejectionCooldownUntil = Date.now() + LiveRelay.REJECTION_COOLDOWN_MS;
        this.setState("idle");
        return;
      }

      logLiveSession("DISCARDING TURN", `reason=${reason} chunks=${this.directAudioChunks.length}`);
      if (this.directAudioFlushTimer) { clearTimeout(this.directAudioFlushTimer); this.directAudioFlushTimer = null; }
      this.directAudioChunks = [];
      this.turnAccum = createEmptyAccumulator();
      // Tell the client to stop any audio it's currently playing from this rejected turn
      this.send({ type: "audio_interrupt" });

      // On MALFORMED_FUNCTION_CALL or RESPONSE_REJECTED (with partial output),
      // optionally ask the model to introspect via the debug_message() tool.
      // Off by default — the round-trip can self-perpetuate: the retry prompt
      // forces the model to respond when it had nothing to say, which produces
      // a filler stall ("Let me check") with no tool call, which is itself
      // rejected as MALFORMED_FUNCTION_CALL, restarting the cycle. Opt-in via
      // env (AAC_DEBUG_INTROSPECTION=1) when actively debugging rejection bugs.
      const introspectionEnabled = process.env.AAC_DEBUG_INTROSPECTION === "1";
      if (introspectionEnabled && (reason === "MALFORMED_FUNCTION_CALL" || reason === "RESPONSE_REJECTED") && this.provider) {
        this.awaitingDebugResponse = true;
        this.debugResponseBuffer = "";
        this.setState("awaiting_turn");
        const debugQuery = reason === "RESPONSE_REJECTED"
          ? `[DEBUG] Your last response was rejected by the system. Call debug_message() with a description of what you were trying to do — what you were going to say and/or which function you were going to call with what arguments.`
          : `[DEBUG] Your last function call was rejected as MALFORMED. Call debug_message() with: 1) the function name you tried to call, 2) the arguments you tried to pass.`;
        logLiveSession(`${reason} DEBUG QUERY`, debugQuery);
        this.provider.sendMessage(debugQuery, "user");
        return;
      }

      // Apply rejection cooldown so the next frame_grid / scene update doesn't
      // immediately re-trigger the same rejected content path.
      this.rejectionCooldownUntil = Date.now() + LiveRelay.REJECTION_COOLDOWN_MS;
      this.debugRetryCount = 0;
      this.setState("idle");
      return;
    }

    // Empty turn — no tool calls happened and no direct audio
    if (this.state === "awaiting_turn") {
      const hasDirectAudio = this.useDirectAudio && this.directAudioChunks.length > 0;
      if (!hasDirectAudio) {
        // If a user prompt is pending, the model was swallowed by a
        // proactive-audio empty turn. Retry the prompt — once. Clear the
        // pending prompt before resending so a second empty turn doesn't loop.
        if (this.pendingRetryPrompt && this.provider) {
          const promptToRetry = this.pendingRetryPrompt;
          this.pendingRetryPrompt = null;
          logLiveSession("RETRY PROMPT", "Empty turn after user prompt — resending once");
          this.provider.sendMessage(promptToRetry, "user");
          return;  // stay in awaiting_turn
        }
        this.setState("idle");
        return;
      }
      // Direct audio only turn (no tool calls) — still needs processTurnEnd
    }

    // Already processing (shouldn't happen, but guard)
    if (this.state === "processing_turn") {
      logLiveSession("TURN_COMPLETE SKIPPED", "already processing");
      return;
    }

    // If we're idle, we might still have activity to process: Gemini Live's
    // built-in VAD can trigger spontaneous model turns (it hears the user
    // speak and starts generating audio without us sending turnComplete=true).
    // The audio arrives while state is idle, but it IS a real turn. Only
    // return early if absolutely nothing happened.
    if (this.state === "idle") {
      const hadActivity =
        this.directAudioChunks.length > 0 ||
        this.turnAccum.speakText.trim().length > 0 ||
        this.turnAccum.transcriptText.trim().length > 0 ||
        this.turnAccum.contextText.trim().length > 0 ||
        this.turnAccum.boardChanged ||
        !!this.turnAccum.staySilentReason;
      if (!hadActivity) {
        return;
      }
      // Activity happened in idle state — fall through to processTurnEnd so
      // audio is flushed and post-turn hooks fire. Note: we skip the auto-
      // continuation block below because the spontaneous-audio path means
      // either (a) the model already responded with audio, or (b) tool calls
      // ran and we want them to be handled normally.
      logLiveSession(
        "IDLE_TURN_RECOVERY",
        `state was idle but turn had activity — escalating to processing_turn (audio=${this.directAudioChunks.length}, transcript=${!!this.turnAccum.transcriptText.trim()}, board=${this.turnAccum.boardChanged})`,
      );
      this.setState("processing_turn");
      try {
        await Promise.race([
          this.processTurnEnd(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("processTurnEnd timed out after 60s")), 60_000),
          ),
        ]);
      } catch (err) {
        console.error("[LiveRelay] processTurnEnd error (idle recovery):", (err as Error).message);
        this.send({ type: "error", data: "error:TURN_FAILED" });
      } finally {
        this.turnAccum = createEmptyAccumulator();
        this.flushDirectAudio();
        this.directAudioChunks = [];
        this.preGenTtsPromise = null;
        this.pendingRetryPrompt = null;
        this.debugRetryCount = 0;
        this.setState("idle");
      }
      return;
    }

    // Auto-continuation: when the model "should have spoken" but didn't,
    // nudge it once. Trigger conditions:
    //   (a) transcript() called for the identified student + no audio
    //   (b) button press was sent + no audio
    //   (c) [GREET] system message was sent (interact-mode entry) + no audio
    // Plus the always-on guards:
    //   - We didn't already auto-continue on the previous turn (one retry max)
    //   - muteState === "unmuted"
    //   - The model didn't explicitly call stay_silent
    const noAudioThisTurn =
      this.directAudioChunks.length === 0 &&
      this.turnAccum.speakText.trim().length === 0;

    const studentName =
      this.sessionCache?.monitorAgent.getStudent?.()?.name?.trim() || "";
    const speaker = (this.turnAccum.transcriptSpeaker || "").trim();
    const studentFirstName = studentName.split(/\s+/)[0] || "";
    const speakerIsStudent =
      !!studentFirstName &&
      speaker.toLowerCase().includes(studentFirstName.toLowerCase());

    const transcriptTrigger =
      this.turnAccum.transcriptText.trim().length > 0 && speakerIsStudent;
    const buttonPressTrigger = wasButtonPressTurn;
    const greetTrigger = wasGreetTurn;

    // Latch hasGreetedInteract once audio actually arrives during the greet
    // window (covers both the direct-success case and the post-auto-continuation
    // case). Deferred from set_interaction_mode so a silent first attempt
    // doesn't permanently disable greeting on subsequent interact entries.
    if (this.greetAudioPending && !noAudioThisTurn) {
      this.hasGreetedInteract = true;
      this.greetAudioPending = false;
    }

    if (
      !wasAutoContinuationPending &&
      this.muteState === "unmuted" &&
      noAudioThisTurn &&
      !this.turnAccum.staySilentReason &&
      this.provider &&
      (transcriptTrigger || buttonPressTrigger || greetTrigger)
    ) {
      const intent = this.turnAccum.rebuildBoardIntendedSpeech;
      const reason = greetTrigger
        ? (intent
          ? `greet, model declared intent "${intent.substring(0, 80)}" but did not speak it`
          : `greet, model produced no audio`)
        : buttonPressTrigger
        ? (intent
          ? `button press, model declared intent "${intent.substring(0, 80)}" but did not speak it`
          : `button press, model produced no audio`)
        : `transcript=${JSON.stringify(this.turnAccum.transcriptText.trim())} speaker=${speaker}`;
      logLiveSession("AUTO_CONTINUATION", `${reason} — re-prompting`);

      // Prompt is tailored to the trigger. When the model declared intent via
      // rebuild_board.response (button or greet path), echoing that intent back
      // is strong steering.
      let continuePrompt: string;
      if (greetTrigger && intent) {
        continuePrompt = `[continue] You declared you would greet with "${intent}" but didn't speak it aloud. Say it now in your own voice.`;
      } else if (greetTrigger) {
        continuePrompt = `[continue] You set interact mode but didn't greet aloud. Greet the user now in your own voice — one short sentence.`;
      } else if (buttonPressTrigger && intent) {
        continuePrompt = `[continue] You declared you would say "${intent}" but didn't speak it aloud. Say it now in your own voice.`;
      } else if (buttonPressTrigger) {
        continuePrompt = `[continue] The user pressed a button but you didn't respond aloud. Respond now in your own voice.`;
      } else {
        // transcript trigger
        continuePrompt = `[continue] You transcribed the student's speech but did not respond. Speak your reply now in your own voice. Do not repeat their words or imitate their voice.`;
      }
      // Reset turn state so the next TURN_COMPLETE sees a clean accumulator
      // and can't retrigger this branch unless the model transcribes anew.
      this.turnAccum = createEmptyAccumulator();
      if (this.directAudioFlushTimer) {
        clearTimeout(this.directAudioFlushTimer);
        this.directAudioFlushTimer = null;
      }
      this.directAudioChunks = [];
      this.autoContinuationPending = true;
      this.setState("awaiting_turn");
      this.provider.sendMessage(continuePrompt, "user");
      return;
    }

    this.setState("processing_turn");
    try {
      const turnEndPromise = this.processTurnEnd();
      const timeoutPromise = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("processTurnEnd timed out after 60s")), 60_000)
      );
      await Promise.race([turnEndPromise, timeoutPromise]);
    } catch (err) {
      console.error("[LiveRelay] processTurnEnd error:", (err as Error).message);
      this.send({ type: "error", data: "error:TURN_FAILED" });
    } finally {
      this.turnAccum = createEmptyAccumulator();
      // Flush any remaining buffered audio before clearing
      this.flushDirectAudio();
      this.directAudioChunks = [];
      this.preGenTtsPromise = null;
      this.pendingRetryPrompt = null;
      // Reset retry counter on successful turn — only count consecutive failures
      this.debugRetryCount = 0;
      this.setState("idle");
    }
  }

  private handleInterrupted(): void {
    // Only tell the client to stop playback if we actually sent audio during
    // THIS turn. If the model interrupts an empty turn (e.g. a frame_grid
    // tick that produced nothing), the client may still be playing audio from
    // the PREVIOUS turn — interrupting that would cut the user off mid-sentence.
    const hasSentAudio = this.directAudioChunks.length > 0 || this.turnAccum.speakText.trim().length > 0;
    if (hasSentAudio) {
      this.send({ type: "audio_interrupt" });
    }
    logLiveSession("INTERRUPTED", `hasSentAudio=${hasSentAudio} chunks=${this.directAudioChunks.length} state=${this.state}`);
    this.turnAccum = createEmptyAccumulator();
    // Cancel pending flush and discard buffered audio
    if (this.directAudioFlushTimer) { clearTimeout(this.directAudioFlushTimer); this.directAudioFlushTimer = null; }
    this.directAudioChunks = [];
    this.preGenTtsPromise = null;
    this.setState("idle");
  }

  // -------------------------------------------------------------------------
  // Post-turn processing
  // -------------------------------------------------------------------------

  private async processTurnEnd(): Promise<void> {
    const isMuted = this.muteState === "muted";
    const state = this.sessionCache?.state;
    const accum = this.turnAccum;

    const fullSpeakText = accum.speakText.trim();
    const fullInterpretText = accum.interpretText.trim();
    const fullContextText = accum.contextText.trim();
    const fullTranscriptText = accum.transcriptText.trim();
    const callMonitorReason = accum.callMonitorReason || undefined;
    const openAppData = accum.openAppData || undefined;
    const closeAppTriggered = accum.closeApp;
    const focusReason = accum.focusReason || undefined;

    const boardRebuilt = accum.boardRebuilt;
    const boardAddLabels = accum.boardAddLabels;
    const boardRemoveLabels = accum.boardRemoveLabels;
    const boardAddCount = boardAddLabels.length;
    const boardRemoveCount = boardRemoveLabels.length;
    const hasBoardChange = accum.boardChanged;

    // Debug logging
    logDualAgent("LiveRelay.turnComplete", {
      sessionId: this.sessionId,
      toolCalls: [
        fullSpeakText && "speak",
        fullInterpretText && "interpret",
        fullTranscriptText && "transcript",
        fullContextText && "context",
        hasBoardChange && "board",
        callMonitorReason && "call_monitor",
      ].filter(Boolean).join(", ") || "(none)",
      speak: fullSpeakText || "(none)",
      interpret: fullInterpretText || "(none)",
      transcript: fullTranscriptText || "(none)",
      context: fullContextText.substring(0, 200) || "(none)",
      board: hasBoardChange
        ? {
            rebuilt: boardRebuilt,
            added: boardAddCount,
            removed: boardRemoveCount,
            addLabels: boardAddLabels.join(", "),
            removeLabels: boardRemoveLabels.join(", "),
          }
        : "(no changes)",
      callMonitor: callMonitorReason || false,
      setBoard: accum.setBoardName || false,
      pressButton: accum.pressButtonLabel || false,
      openApp: openAppData?.appId || false,
      closeApp: closeAppTriggered,
    });

    // -----------------------------------------------------------------------
    // 1. Persist messages
    // -----------------------------------------------------------------------
    if (state) {
      const now = Date.now();
      state.lastInteractiveActivity = now;

      const turnMessages: import("./types").PendingMessage[] = [];

      if (fullInterpretText) {
        turnMessages.push({
          role: "assistant",
          content: `[INTERPRET] ${fullInterpretText}`,
          timestamp: now,
        });
      }

      if (fullSpeakText) {
        turnMessages.push({
          role: "assistant",
          content: fullSpeakText,
          timestamp: now + 1,
        });
      }

      if (fullContextText) {
        turnMessages.push({
          role: "assistant",
          content: `[CONTEXT] ${fullContextText}`,
          timestamp: now + 2,
        });
      }

      if (fullTranscriptText) {
        turnMessages.push({
          role: "user",
          content: `[TRANSCRIPT] ${fullTranscriptText}`,
          timestamp: now + 3,
        });
      }

      if (callMonitorReason) {
        turnMessages.push({
          role: "assistant",
          content: `[CALL_MONITOR] ${callMonitorReason}`,
          timestamp: now + 4,
        });
      }

      if (hasBoardChange) {
        const boardSuffix = boardRebuilt
          ? `Board rebuilt: ${boardAddLabels.join(", ")}`
          : [
              boardAddCount > 0 ? `Added: ${boardAddLabels.join(", ")}` : "",
              boardRemoveCount > 0 ? `Removed: ${boardRemoveLabels.join(", ")}` : "",
            ].filter(Boolean).join(". ");
        turnMessages.push({
          role: "assistant",
          content: `[SYSTEM — Board changes: ${boardSuffix}]`,
          timestamp: now + 5,
        });
      }

      if (this.sessionId && turnMessages.length > 0) {
        dualAgentService.addPendingMessages(this.sessionId, turnMessages)
          .catch(err => console.error("[LiveRelay] Failed to persist turn messages:", err));
      }
    }

    // -----------------------------------------------------------------------
    // 2. App handling (YouTube/Spotify search)
    // -----------------------------------------------------------------------
    if (openAppData) {
      if (openAppData.appId === "youtube") {
        try {
          const channels = this.sessionCache?.state?.permittedYoutubeChannels || [];
          const results = await searchYouTube(openAppData.data || "", channels);
          if (results) {
            logLiveSession(
              "YOUTUBE_SEARCH",
              `query="${openAppData.data || "(empty)"}" result="${results.title}" id=${results.videoId}`,
            );
            this.send({
              type: "video_play",
              data: {
                videoId: results.videoId,
                title: results.title,
                // Include permitted channels so the player can offer a
                // "← channels" button to browse other approved videos.
                channels: channels.length > 0 ? channels : undefined,
              },
            });
          } else if (channels.length > 0) {
            // No title matched — fall back to browse mode instead of playing
            // something unrelated. Student can pick from the channel list.
            logLiveSession(
              "YOUTUBE_SEARCH_NO_MATCH_BROWSE",
              `query="${openAppData.data || ""}" channels=${channels.length}`,
            );
            this.send({
              type: "app_open",
              data: { appId: "youtube", appData: { channels } },
            });
            this.provider?.sendContextInjection(
              `[SYSTEM] YouTube search for "${openAppData.data || ""}" didn't match any permitted video titles. The channel browser is now open on screen so the student can pick something themselves.`,
            );
          } else {
            // No channels and search returned null (e.g. API key missing or
            // quota exceeded). Nothing to show.
            logLiveSession(
              "YOUTUBE_SEARCH_EMPTY",
              `query="${openAppData.data || "(empty)"}" hasKey=${!!process.env.YOUTUBE_API_KEY}`,
            );
            this.provider?.sendContextInjection(
              `[SYSTEM] YouTube search returned no videos for "${openAppData.data || ""}". The player is not open. Suggest a different activity.`,
            );
          }
        } catch (err) {
          console.error("[LiveRelay] YouTube search failed:", err);
          this.provider?.sendContextInjection(
            `[SYSTEM] YouTube search failed with an error. The player is not open. Suggest a different activity.`,
          );
        }
      } else if (openAppData.appId === "spotify" && openAppData.data) {
        let appData: any = { query: openAppData.data };
        try {
          const results = await searchSpotify(openAppData.data);
          if (results) {
            appData = { trackId: results.trackId, title: results.title, artist: results.artist, albumArt: results.albumArt };
          }
        } catch (err) {
          console.error("[LiveRelay] Spotify search failed:", err);
        }
        this.send({ type: "app_open", data: { appId: "spotify", appData } });
      }
    }

    // -----------------------------------------------------------------------
    // (Contact enrollment via AAC face-learning removed. New contacts are
    //  created from the Contacts panel; physical descriptors are populated
    //  server-side by the photo-analyzer AI pipeline on image upload.)
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // 4. TTS
    // -----------------------------------------------------------------------

    // Student voice (pre-generated from button press)
    if (this.preGenTtsPromise) {
      try {
        await this.preGenTtsPromise;
      } catch (err) {
        // Error already logged in the catch handler of the original promise
      }
      this.preGenTtsPromise = null;
    } else if (fullInterpretText && this.studentVoice) {
      // Normal path: Gemini called interpret() — synthesize student voice now
      try {
        await this.streamTtsWithTimeout(
          fullInterpretText,
          this.studentVoice,
          "interpretation_audio",
          "Student",
        );
      } catch (err) {
        console.error("[LiveRelay] Student TTS error:", (err as Error).message);
      }
    }

    // AI voice: direct audio chunks were already forwarded in real time via onAudioData,
    // so no buffered send needed. For external TTS mode, synthesize now.
    if (!this.useDirectAudio && fullSpeakText && !isMuted && this.aiVoice) {
      try {
        await this.streamTtsWithTimeout(
          fullSpeakText,
          this.aiVoice,
          "avatar_audio",
          "AI",
        );
      } catch (err) {
        console.error("[LiveRelay] AI TTS error:", (err as Error).message);
      }
    }

    // -----------------------------------------------------------------------
    // 5. Focus frame
    // -----------------------------------------------------------------------
    if (focusReason) {
      this.send({ type: "focus_request", data: { reason: focusReason } });
      console.log("[LiveRelay] Focus frame requested:", focusReason);
    }

    // -----------------------------------------------------------------------
    // 6. Monitor
    // -----------------------------------------------------------------------
    if (this.sessionId) {
      try {
        await dualAgentService.triggerMonitor(
          this.sessionId,
          !!callMonitorReason,
          state?.currentBoard,
        );
      } catch (err) {
        console.error("[LiveRelay] Monitor trigger failed:", err);
        this.send({ type: "monitor_status", data: { error: (err as Error).message } });
      }
    }

    // -----------------------------------------------------------------------
    // 7. Snapshot + complete
    // -----------------------------------------------------------------------
    this.sendSessionSnapshot();
    this.send({ type: "complete", data: {} });
  }

  // -------------------------------------------------------------------------
  // TTS
  // -------------------------------------------------------------------------

  /** Check if a voice should use client-side ElevenLabs TTS */
  /**
   * Flush buffered direct audio chunks to the client as a single WAV.
   * Called on a 250ms timer to batch small PCM chunks into smooth playback.
   */
  private flushDirectAudio(): void {
    this.directAudioFlushTimer = null;
    if (this.directAudioChunks.length === 0) return;
    try {
      const chunks = this.directAudioChunks.splice(0);
      const pcmBuf = Buffer.concat(chunks.map(c => Buffer.from(c, "base64")));
      if (pcmBuf.length === 0) return;
      const wavBuf = pcmToWav(pcmBuf);
      logLiveSession("flushDirectAudio", `state=${this.state} chunks=${chunks.length} pcmBytes=${pcmBuf.length} wavBytes=${wavBuf.length}`);
      this.send({ type: "avatar_audio", data: wavBuf.toString("base64"), format: "wav" });
    } catch (err) {
      console.error("[LiveRelay] Direct audio flush error:", (err as Error).message);
    }
  }

  private isClientTts(voice: ResolvedVoice): boolean {
    return !!(voice.elevenlabsApiKey && voice.elevenlabsVoiceId);
  }

  /**
   * Stream TTS with a timeout guard. Streams audio chunks to the client
   * as they arrive from the Gemini TTS service.
   */
  private async streamTtsWithTimeout(
    text: string,
    voice: ResolvedVoice,
    msgType: "avatar_audio" | "interpretation_audio",
    label: string,
    timeoutMs = 15_000,
    signal?: AbortSignal,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} TTS timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
      const streamPromise = (async () => {
        for await (const chunk of ttsFacade.synthesizeStream(text, voice, signal)) {
          if (signal?.aborted) return;
          this.send({ type: msgType, data: chunk.toString("base64") } as any);
        }
      })();
      await Promise.race([streamPromise, timeoutPromise]);
    } catch (err) {
      if (signal?.aborted) return;
      console.error(`[LiveRelay] ${label} TTS failed:`, (err as Error).message);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Board / Symbol helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve existing symbols from DB (fast). Must be awaited before sending the board.
   * Mutates buttons in-place to set symbolPath for already-generated symbols.
   * Returns the list of unresolved image keys.
   */
  private async resolveExistingSymbols(
    buttons: Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string; sentence?: string }>,
  ): Promise<string[]> {
    const { generateSymbols, useApprovedSymbols, useUnapprovedSymbols } = this.symbolSettings;

    // If no symbol features are enabled, strip imageKeys so client doesn't show spinners
    if (!generateSymbols && !useApprovedSymbols && !useUnapprovedSymbols) {
      for (const btn of buttons) { delete btn.imageKey; }
      return [];
    }

    if (!useApprovedSymbols && !useUnapprovedSymbols) {
      return buttons.filter(b => b.imageKey && !b.symbolPath).map(b => b.imageKey!);
    }

    const unresolved = await resolveImageKeys(buttons, {
      symbolPathFormat: "internal",
      useUnapproved: useUnapprovedSymbols,
    });

    // Strip imageKey from unresolved buttons when generation is disabled
    if (!generateSymbols) {
      for (const btn of buttons) {
        if (btn.imageKey && !btn.symbolPath) delete btn.imageKey;
      }
      return [];
    }

    return unresolved;
  }

  /**
   * Queue background generation for unresolved image keys (fire-and-forget).
   * Sends symbol_update WS messages as symbols are generated.
   */
  private queueMissingSymbolGeneration(
    buttons: Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string }>,
    unresolvedKeys: string[],
  ): void {
    const { generateSymbols } = this.symbolSettings;
    if (!generateSymbols || unresolvedKeys.length === 0) return;

    const keyToLabel = new Map<string, string>();
    for (const btn of buttons) {
      if (btn.imageKey && !btn.symbolPath) keyToLabel.set(btn.imageKey, btn.label);
    }

    queueSymbolGeneration(unresolvedKeys, (imageKey, symbol) => {
      const label = keyToLabel.get(imageKey) || imageKey;
      logLiveSession("SYMBOL_READY", `imageKey=${imageKey} label=${label} symbolId=${symbol.id} wsOpen=${this.ws.readyState === 1}`);
      this.send({ type: "symbol_update", data: { buttonLabel: label, symbolPath: `__SYMBOL__:${symbol.id}` } });
    });
  }

  private buildBoardFromButtons(buttons: Array<{ label: string; iconRef: string; symbolPath?: string; sentence?: string; buttonType?: "guess" | "category"; rowSpan?: number; colSpan?: number }>): any {
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
          ...(b.rowSpan && b.rowSpan > 1 ? { rowSpan: b.rowSpan } : {}),
          ...(b.colSpan && b.colSpan > 1 ? { colSpan: b.colSpan } : {}),
          row: Math.floor(i / cols),
          col: i % cols,
          action: { type: "speak" as const, text: b.label },
          style: {},
          iconRef: b.iconRef,
          symbolPath: b.symbolPath,
        })),
      }],
      currentPageId: pageId,
    };
  }

  /**
   * Get the native (built-in) button labels for the current page of a loaded custom board.
   */
  private getNativePageButtonLabels(state: DualAgentSessionState): string[] {
    if (!state.loadedBoardData) return [];
    const page = state.loadedBoardData.pages?.find((p: any) => p.id === state.currentPageId)
      || state.loadedBoardData.pages?.[0];
    if (!page?.buttons) return [];
    return page.buttons.filter((b: any) => b.label).map((b: any) => b.label);
  }

  // -------------------------------------------------------------------------
  // Context injection
  // -------------------------------------------------------------------------

  /**
   * Inject session context after a reconnection so the model doesn't start over.
   */
  private injectReconnectionContext(): void {
    const state = this.sessionCache?.state;
    if (!state) return;

    const parts: string[] = [];

    // Current board state
    const maxSlots = state.maxBoardItems || 12;
    const labels = state.boardButtonLabels;
    if (state.loadedBoardId) {
      const nativeLabels = this.getNativePageButtonLabels(state);
      const blankSlots = maxSlots - nativeLabels.length;
      const available = blankSlots - state.aiAddedButtonLabels.length;
      parts.push(`Custom board loaded — Fixed buttons (cannot remove): ${nativeLabels.join(", ")} | AI-added (can remove): ${state.aiAddedButtonLabels.join(", ") || "none"} | ${available} slots available`);
    } else if (labels.length > 0) {
      parts.push(`Current AAC board buttons (${labels.length}/${maxSlots}): ${labels.join(", ")}`);
    }

    parts.push(`Interaction mode: ${this.muteState}`);

    if (state.currentEmote) {
      parts.push(`Current emotion: ${state.currentEmote}`);
    }

    // Recent conversation from pending messages (last 20), filtering out safety-excluded
    const recent = (state.pendingMessages || [])
      .filter(m => !m.safetyExcluded)
      .slice(-20);
    if (recent.length > 0) {
      const summary = recent.map(m => {
        const role = m.role === "assistant" ? "AI" : "User";
        const content = m.content.length > 150 ? m.content.substring(0, 150) + "..." : m.content;
        return `  ${role}: ${content}`;
      }).join("\n");
      parts.push(`Recent conversation:\n${summary}`);
    }

    const header = this.consecutiveSafetyBlocks > 0
      ? `[SESSION RESUMED] Your connection was briefly interrupted due to a content filter. Continue the conversation naturally.`
      : `[SESSION RECONNECTED] The connection was briefly interrupted but has been restored.`;

    const contextText = [
      header,
      ...parts,
      `IMPORTANT: Continue the conversation naturally from where you left off.`,
      `Do NOT greet the user again. Do NOT use rebuild_board() — the board is already displayed correctly on the client.`,
    ].join("\n");

    this.provider!.sendContextInjection(contextText);
    logDualAgent("LiveRelay.reconnectionContext", {
      sessionId: this.sessionId,
      boardButtons: labels.length,
      recentMessages: recent.length,
    });

    // Re-inject behavioral rules immediately after reconnection
    const behavioralReminder = this.buildBehavioralReminder();
    if (behavioralReminder) {
      this.provider!.sendContextInjection(behavioralReminder);
      logDualAgent("LiveRelay.behavioralReminder", { sessionId: this.sessionId, trigger: "reconnect" });
    }
  }

  /**
   * Build a compact model-role summary of what the model did during this turn.
   */
  private buildTurnSummary(accum: TurnToolAccumulator): string | null {
    const parts: string[] = [];
    if (accum.interpretText.trim() && !this.useDirectAudio) {
      parts.push(`interpret("${accum.interpretText.trim()}")`);
    }
    if (accum.boardRebuilt) {
      const labels = accum.boardAddLabels.join(", ");
      parts.push(`rebuild_board(${labels})`);
    } else {
      if (accum.boardAddLabels.length > 0) {
        parts.push(`add_buttons(${accum.boardAddLabels.join(", ")})`);
      }
      if (accum.boardRemoveLabels.length > 0) {
        parts.push(`remove_buttons(${accum.boardRemoveLabels.join(", ")})`);
      }
    }
    if (accum.speakText.trim()) {
      // In direct audio mode, speakText comes from outputTranscription — record it
      // so the model has a text record of what it said (native audio context alone
      // isn't enough for complex multi-turn reasoning).
      parts.push(`[I said: "${accum.speakText.trim()}"]`);
    }
    if (accum.setBoardName) {
      parts.push(`set_board("${accum.setBoardName}")`);
    }
    if (accum.pressButtonLabel) {
      parts.push(`press_button("${accum.pressButtonLabel}")`);
    }
    if (accum.openAppData) {
      parts.push(`open_app("${accum.openAppData.appId}")`);
    }
    if (accum.emote) {
      parts.push(`emote("${accum.emote}")`);
    }
    if (parts.length === 0) return null;
    return `[I just called: ${parts.join(", ")}]`;
  }

  /**
   * Build a concise behavioral reminder based on current session state.
   */
  private buildBehavioralReminder(): string | null {
    const state = this.sessionCache?.state;
    if (!state) return null;

    const isMuted = this.muteState === "muted";

    const sRef = "speak()";
    const abRef = "add_buttons()";
    const rbRef = "remove_buttons()";
    const sbRef = "set_board()";

    const parts: string[] = [
      `[BEHAVIORAL REMINDER]`,
      `On every [BUTTON PRESS], RESPOND ALOUD to the student's statement and then call rebuild_board() — that is the expected flow. Separately: the button's sentence is voiced by a TTS layer through the device speaker, which the mic will pick up. That re-heard audio is NOT new user speech — do not transcribe it. The transcription rule does NOT change the response rule: respond to the [BUTTON PRESS] text turn, ignore the echoed TTS audio.`,
    ];

    parts.push("Visual checks: Stay silent if nothing important changed. Only report meaningful context changes.");

    if (isMuted) {
      parts.push(`Mode: silent — You are INVISIBLE. NEVER speak. Only use board tools.`);
    } else if (this.useDirectAudio) {
      parts.push(`Mode: standard — You speak directly with your voice. Do NOT narrate tool calls.`);
    } else {
      parts.push(`Mode: standard — AI voice active via ${sRef}.`);
    }

    if (this.useDirectAudio) {
      parts.push(`Echo: You will hear your own voice echoed back through the mic — ignore it. Button press sentences are also echoed via TTS — ignore those too.`);
    } else {
      parts.push(`Echo: Speech you hear shortly after your own ${sRef} output is YOUR echo — ignore it completely. Do NOT transcribe or respond to it.`);
    }

    const maxSlots = state.maxBoardItems || 12;
    parts.push(`Board limit: ${maxSlots} buttons max. Use ${rbRef} before ${abRef} if near the limit.`);

    if (state.availableBoards && state.availableBoards.length > 0 && !state.loadedBoardId) {
      const boardKeys = state.availableBoards.map(b => {
        const hint = b.hint ? ` (${b.hint})` : "";
        return `${b.key}${hint}`;
      }).join(", ");
      parts.push(`Custom boards available: ${boardKeys}. Use ${sbRef} silently when the context matches a board's purpose${this.useDirectAudio ? "." : ` — do NOT announce board switches with ${sRef}.`}`);
    }

    return parts.join("\n");
  }

  private buildEchoAwareness(): string {
    if (this.useDirectAudio) {
      return `AUDIO ECHO AWARENESS:
The microphone picks up audio that came from your own speaker — your own voice playing back, and the student's button-press TTS playing back. That re-heard audio is NOT new user speech. Don't TRANSCRIBE it (no transcript() calls for it). This rule is about transcription only — it does NOT mean "don't respond". When a [BUTTON PRESS] text turn arrives, respond to it normally as the user's statement, even though you may hear the TTS echo right after.`;
    }

    return `AUDIO ECHO AWARENESS:
You receive continuous microphone audio. Because speak() text is voiced by external TTS through speakers near the mic, you WILL hear your own output echoed back. Recognize these echoes as YOUR OWN output — never transcribe or respond to them. Only treat audio as genuine user speech if it clearly does NOT match something you recently said.
When a button is pressed, the student's pre-generated sentence is also voiced via TTS — you will hear this echo too. Do NOT transcribe it.`;
  }

  /** Build a TZ + local-time section for the interactive agent system prompt. */
  private buildTimezoneSection(): string {
    if (!this.timezone) return "";
    const now = new Date();
    let local: string;
    try {
      local = new Intl.DateTimeFormat("en-US", {
        timeZone: this.timezone,
        weekday: "long", year: "numeric", month: "long", day: "numeric",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(now);
    } catch {
      local = now.toISOString();
    }
    return `USER LOCAL TIME:
Time zone: ${this.timezone}
Current local time: ${local}
When creating or referencing calendar events, interpret and speak in this local time.`;
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  private startTimers(): void {
    this.stopTimers();

    // Board reminder (45s)
    this.lastBoardUpdateTime = Date.now();
    this.boardReminderTimer = setInterval(() => {
      this.sendBoardStateReminder();
    }, LiveRelay.BOARD_REMINDER_INTERVAL_MS);

    // Behavioral reminder (3min)
    this.behavioralReminderTimer = setInterval(() => {
      const reminder = this.buildBehavioralReminder();
      if (reminder) {
        this.provider!.sendContextInjection(reminder);
        logDualAgent("LiveRelay.behavioralReminder", { sessionId: this.sessionId, trigger: "periodic" });
      }
    }, LiveRelay.BEHAVIORAL_REMINDER_INTERVAL_MS);

    // Client ping (30s)
    this.startPingTimer();

    // Snapshot timer (30s)
    this.snapshotTimer = setInterval(() => {
      this.sendSessionSnapshot();
    }, LiveRelay.SNAPSHOT_INTERVAL_MS);
  }

  private stopTimers(): void {
    if (this.boardReminderTimer) {
      clearInterval(this.boardReminderTimer);
      this.boardReminderTimer = null;
    }
    if (this.behavioralReminderTimer) {
      clearInterval(this.behavioralReminderTimer);
      this.behavioralReminderTimer = null;
    }
    this.stopPingTimer();
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  private startPingTimer(): void {
    this.stopPingTimer();
    this.pongReceived = true;
    this.pingTimer = setInterval(() => {
      if (!this.pongReceived) {
        console.warn("[LiveRelay] Client WebSocket failed health check (no pong) — terminating");
        this.ws.terminate();
        return;
      }
      this.pongReceived = false;
      try {
        this.ws.ping();
      } catch {
        // ws already closed
      }
    }, LiveRelay.PING_INTERVAL_MS);
  }

  private stopPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Send a periodic board state context injection so Gemini stays aware
   * of current buttons and available slots.
   */
  private sendBoardStateReminder(): void {
    const state = this.sessionCache?.state;
    if (!state) return;

    const timeSinceUpdate = Date.now() - this.lastBoardUpdateTime;
    if (timeSinceUpdate < LiveRelay.BOARD_REMINDER_INTERVAL_MS) {
      logLiveSession("BOARD REMINDER SKIPPED", `timeSinceUpdate=${timeSinceUpdate}ms < ${LiveRelay.BOARD_REMINDER_INTERVAL_MS}ms`);
      return;
    }
    logLiveSession("BOARD REMINDER FIRING", `timeSinceUpdate=${timeSinceUpdate}ms`);

    const maxSlots = state.maxBoardItems || 12;
    const labels = state.boardButtonLabels;

    if (state.loadedBoardId) {
      const nativeLabels = this.getNativePageButtonLabels(state);
      const blankSlots = maxSlots - nativeLabels.length;
      const available = blankSlots - state.aiAddedButtonLabels.length;
      this.provider!.sendContextInjection(
        `[BOARD STATE REMINDER] Custom board — Fixed buttons (cannot remove): ${nativeLabels.join(", ")} | AI-added (can remove, ${state.aiAddedButtonLabels.length}/${blankSlots}): ${state.aiAddedButtonLabels.join(", ") || "none"} | ${available} slots available`,
      );
    } else {
      const available = maxSlots - labels.length;
      const ctxInfo = this.contextButtonLabels.length > 0
        ? ` | Context sidebar: ${this.contextButtonLabels.join(", ")}`
        : "";
      this.provider!.sendContextInjection(
        `[BOARD STATE REMINDER] Main board (${labels.length}/${maxSlots}, ${available} slots available): ${labels.join(", ") || "none"}${ctxInfo}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Reconnection
  // -------------------------------------------------------------------------

  /**
   * Force a completely new session when reconnection keeps failing.
   */
  private async forceNewSession(): Promise<void> {
    if (!this.studentId || !this.sessionId) return;

    this.provider?.close();

    try {
      await this.handleInitialize({
        type: "initialize",
        studentId: this.studentId,
        userId: this.userId,
        muteState: this.muteState,
        responseMode: this.responseMode,
        debugMode: this.debugMode,
      });
      if (this.sessionId) {
        this.send({ type: "session_reset", sessionId: this.sessionId });
      }
      this.reconnectAttempts = 0;
    } catch (err) {
      console.error("[LiveRelay] Force new session failed:", err);
      this.send({ type: "error", data: "error:SESSION_RESET_FAILED" });
    }
  }

  /**
   * Handle a safety/policy block from Gemini.
   * Simplified: exclude all messages on safety block.
   */
  private handleSafetyBlock(): void {
    this.consecutiveSafetyBlocks++;

    const state = this.sessionCache?.state;
    if (state) {
      const msgs = state.pendingMessages;
      // Exclude all non-excluded messages
      for (const msg of msgs) {
        if (!msg.safetyExcluded) {
          msg.safetyExcluded = true;
        }
      }

      dualAgentService.addPendingMessage(this.sessionId!, {
        role: "system",
        content: `[SAFETY BLOCK] A response was blocked by the content safety filter (attempt ${this.consecutiveSafetyBlocks}). All messages excluded from AI context.`,
        timestamp: Date.now(),
      }).catch(err => console.error("[LiveRelay] Failed to persist safety block:", err));
    }

    this.send({ type: "safety_blocked", data: "error:SAFETY_BLOCKED" });

    logDualAgent("LiveRelay.safetyBlock", {
      sessionId: this.sessionId,
      level: this.consecutiveSafetyBlocks,
      lastCloseCode: this.provider?.lastCloseCode,
    });
  }

  // -------------------------------------------------------------------------
  // Face recognition
  // -------------------------------------------------------------------------

  /**
   * Match each incoming face descriptor against the student's known people
   * (self + linked users + contacts) via the database. Populates
   * `currentIdentifiedFaces`, pushes the list to the client for the debug
   * display, and rate-limit-bumps `recordContactSighting()` for matches.
   */
  private async recognizeFaces(
    descriptors: Array<{
      descriptor: number[];
      boundingBox?: { x: number; y: number; w: number; h: number };
      cameraRole?: "user" | "environment" | "unknown";
      cameraLabel?: string;
    }>,
  ): Promise<void> {
    if (!this.studentId) return;

    if (!descriptors.length) {
      if (this.currentIdentifiedFaces.length) {
        this.currentIdentifiedFaces = [];
        this.currentIdentifiedFacesAt = Date.now();
        this.send({ type: "people_identified", data: [] });
      }
      return;
    }

    const matches = await Promise.all(
      descriptors.map(d => findMatchingFace(d.descriptor, this.studentId!).catch(() => null as FaceMatchResult | null)),
    );

    let unknownCounter = 0;
    const wire: IdentifiedFaceWire[] = descriptors.map((d, i) => {
      const m = matches[i];
      if (m && m.matched) {
        return {
          faceIndex: i,
          matched: true,
          name: m.name,
          entityType: m.entityType,
          entityId: m.entityId,
          relationship: m.relationship,
          confidence: m.confidence,
          boundingBox: d.boundingBox,
          cameraRole: d.cameraRole,
          cameraLabel: d.cameraLabel,
        };
      }
      unknownCounter += 1;
      return {
        faceIndex: i,
        matched: false,
        name: `Unknown #${unknownCounter}`,
        confidence: 0,
        boundingBox: d.boundingBox,
        cameraRole: d.cameraRole,
        cameraLabel: d.cameraLabel,
      };
    });

    this.currentIdentifiedFaces = wire;
    this.currentIdentifiedFacesAt = Date.now();
    this.send({ type: "people_identified", data: wire });

    // Rate-limited sighting bumps for confidently-matched contacts only
    const now = Date.now();
    for (const f of wire) {
      if (!f.matched || f.entityType !== "contact" || !f.entityId) continue;
      if (f.confidence < 0.4) continue;
      const last = this.lastSightingBumpAt.get(f.entityId) ?? 0;
      if (now - last < LiveRelay.SIGHTING_BUMP_INTERVAL_MS) continue;
      this.lastSightingBumpAt.set(f.entityId, now);
      recordContactSighting(f.entityId).catch(err => {
        logLiveSession("SIGHTING_BUMP_ERROR", `${f.entityId}: ${(err as Error).message}`);
      });
    }
  }

  /**
   * Render the currently-identified faces as a compact context block for the
   * model. Returns an empty string when nothing recent is on file. The block
   * is appended to the frame_grid prompt so the model knows who is visible
   * and how confident the match is.
   */
  private buildPeoplePresentContext(): string {
    if (!this.currentIdentifiedFaces.length) return "";
    if (Date.now() - this.currentIdentifiedFacesAt > LiveRelay.IDENTIFIED_FACES_TTL_MS) return "";
    // Camera-role suffix tells the AI whether the person is in front of the
    // student (gesture-tracked) or seen on an environment camera elsewhere.
    const cameraSuffix = (role?: string): string => {
      if (role === "user") return " — in front of student";
      if (role === "environment") return " — environment camera";
      return "";
    };
    // Explicit student tag: face-match returns entityType="student" when the
    // visible face matches the bound student. Marking it inline lets the
    // prompt require positive identification — without this, the model can
    // mistake a visible non-student (parent, sibling, clinician) for the
    // student and address them as if they were the primary user.
    const lines = this.currentIdentifiedFaces.map(f => {
      const where = cameraSuffix(f.cameraRole);
      if (!f.matched) return `- ${f.name} (no database match)${where}`;
      const conf = (f.confidence * 100).toFixed(0);
      const rel = f.relationship ? `, ${f.relationship}` : "";
      const tag = f.entityType === "student" ? " [THE STUDENT]" : "";
      return `- ${f.name}${rel} — ${conf}% confidence${where}${tag}`;
    });
    const sawStudent = this.currentIdentifiedFaces.some(f => f.matched && f.entityType === "student");
    const presenceLine = sawStudent
      ? ""
      : `\n(NOTE: the student is NOT among the identified faces. The visible person, if any, is someone else — likely a caregiver, family member, or visitor.)`;
    return `[PEOPLE PRESENT]\n${lines.join("\n")}${presenceLine}`;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private send(msg: ServerMessage): void {
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        logLiveSession("SERVER → CLIENT", `state=${this.state} ${stringifyMsg(msg)}`);
        this.ws.send(JSON.stringify(msg));
      } else {
        logLiveSession("SERVER → CLIENT (WS CLOSED)", `state=${this.state} type=${msg.type}`);
      }
    } catch (err) {
      console.error("[LiveRelay] send() failed:", (err as Error).message, "msgType:", msg.type);
    }
  }

  /**
   * Record an AAC sleep state transition to the activity log.
   * Idempotent against same-state repeats. Used by the Insurance Bridge module
   * to subtract sleep windows from RTM service-time totals.
   */
  private recordSleepStateChange(
    toState: "hibernation" | "waking" | "awake" | "resting" | "asleep",
    source: "ai" | "system" | "user",
  ): void {
    if (toState === this.lastSleepState) return;
    const fromState = this.lastSleepState;
    this.lastSleepState = toState;
    // Re-arm the interact-mode greeting on any wake from hibernation, so
    // the next set_interaction_mode("interact") triggers a fresh greeting.
    if (fromState === "hibernation" && toState !== "hibernation") {
      this.hasGreetedInteract = false;
    }
    if (!this.studentId) return;
    activityLogService.log({
      userId: this.userId ?? null,
      eventType: "aac_sleep_state_change",
      subjectType1: "student",
      subjectId1: this.studentId,
      details: {
        sessionId: this.sessionId,
        fromState,
        toState,
        source,
      },
      isAiInitiated: source === "ai",
    });
  }

  /** Build and send a session_snapshot message to the client for local persistence. */
  sendSessionSnapshot(): void {
    if (!this.localStorageConfig || !this.sessionCache?.state) return;

    const state = this.sessionCache.state;
    const student = this.sessionCache.monitorAgent.getStudent?.();
    const memory = (student?.chatMemory as Record<string, any>) || {};

    const snapshot: import("@shared/aac-local-storage").AacSessionSnapshot = {
      sessionId: state.sessionId,
      studentId: state.studentId,
      userId: state.userId,
      messages: state.messages,
      pendingMessages: state.pendingMessages.map(pm => ({
        role: pm.role,
        content: pm.content,
        timestamp: pm.timestamp,
      })),
      muteState: state.muteState,
      responseMode: this.responseMode,
      currentBoard: state.currentBoard || null,
      boardButtonLabels: state.boardButtonLabels,
      aiAddedButtonLabels: state.aiAddedButtonLabels,
      loadedBoardId: state.loadedBoardId,
      currentPageId: state.currentPageId,
      monitorNotes: memory.Student_Notes || undefined,
      timestamp: Date.now(),
    };

    this.send({
      type: "session_snapshot",
      snapshot,
      config: this.localStorageConfig,
    });
  }

  /**
   * Load the home board directly (server-side, no AI tool call required).
   * Called on session init and when the user presses Home. The AI is informed
   * via context injection and can use rebuild_board() to add side panel buttons.
   *
   * @param deferClientSend  When true, only update server-side state. The
   *   `set_board` message to the client is held until `flushPendingHomeBoardSend`
   *   runs from `onReady`. Used during init so the home board buttons don't
   *   appear before the model is connected and ready to handle clicks.
   */
  private loadHomeBoardInternal(
    state?: import("./types").DualAgentSessionState,
    deferClientSend = false,
  ): void {
    const targetState = state || this.sessionCache?.state;
    if (!targetState || !this.homeBoardData) return;
    targetState.loadedBoardId = "__home__";
    targetState.loadedBoardData = this.homeBoardData as any;
    targetState.currentPageId = this.homeBoardData.pages?.[0]?.id || null;
    targetState.pageHistory = [];
    targetState.maxBoardItems = (this.homeBoardData.grid?.rows || 3) * (this.homeBoardData.grid?.cols || 4);
    targetState.aiAddedButtonLabels = [];
    const nativeLabels = this.getNativePageButtonLabels(targetState);
    targetState.boardButtonLabels = [...nativeLabels];
    if (deferClientSend) {
      this.pendingHomeBoardSend = true;
      logLiveSession("HOME_BOARD_LOADED (deferred)", `state updated; client send held until onReady — buttons: ${nativeLabels.join(", ")}`);
    } else {
      this.send({ type: "set_board", data: { board: this.homeBoardData, name: this.homeBoardData.name, boardId: "__home__" } });
      logLiveSession("HOME_BOARD_LOADED", `server-side load — buttons: ${nativeLabels.join(", ")}`);
    }
  }

  private flushPendingHomeBoardSend(): void {
    if (!this.pendingHomeBoardSend || !this.homeBoardData) return;
    this.pendingHomeBoardSend = false;
    this.send({ type: "set_board", data: { board: this.homeBoardData, name: this.homeBoardData.name, boardId: "__home__" } });
    logLiveSession("HOME_BOARD_LOADED (flushed)", "sent set_board to client now that model is ready");
  }

  private startSilenceKeepalive(): void {
    if (this.silenceKeepaliveTimer) return;
    logLiveSession("SILENCE_KEEPALIVE", `started — ${LiveRelay.SILENCE_KEEPALIVE_MS}ms intervals`);
    this.silenceKeepaliveTimer = setInterval(() => {
      // Skip if client PCM has arrived recently — real audio takes priority
      if (Date.now() - this.lastClientPcmAt < LiveRelay.CLIENT_PCM_TIMEOUT_MS) return;
      // Skip if paused or no provider
      if (this.paused || !this.provider) return;
      this.provider.sendAudio(LiveRelay.SILENCE_PCM_BASE64);
    }, LiveRelay.SILENCE_KEEPALIVE_MS);
  }

  private stopSilenceKeepalive(): void {
    if (this.silenceKeepaliveTimer) {
      clearInterval(this.silenceKeepaliveTimer);
      this.silenceKeepaliveTimer = null;
      logLiveSession("SILENCE_KEEPALIVE", "stopped");
    }
  }

  private cleanup(): void {
    this.setState("closed");
    this.stopTimers();
    this.stopSilenceKeepalive();
    this.pendingClientMessages = [];
    if (this.directAudioFlushTimer) { clearTimeout(this.directAudioFlushTimer); this.directAudioFlushTimer = null; }

    // Remove context injection callback to prevent leaks
    if (this.sessionCache?.state) {
      this.sessionCache.state.onContextInjection = undefined;
    }

    // Trigger final monitor run (fire-and-forget)
    if (this.sessionId) {
      this.handleSessionClose().catch(err => {
        console.error("[LiveRelay] Session close handler failed:", err);
      });
    }

    this.provider?.close();
    if (this.studentTtsSession) {
      this.studentTtsSession.close();
      this.studentTtsSession = null;
    }
    logDualAgent("LiveRelay.cleanup", { sessionId: this.sessionId });
  }

  /**
   * Handle session close: add a close marker and force-trigger the monitor
   * for a final summary of the session.
   */
  private async handleSessionClose(): Promise<void> {
    if (!this.sessionId) return;

    // Skip final summary when notes are disabled
    if (this.sessionCache?.state.privacyOptions?.allowNotes === false) {
      logDualAgent("LiveRelay.handleSessionClose.skipped", { sessionId: this.sessionId, reason: "allowNotes=false" });
      return;
    }

    await dualAgentService.addPendingMessage(this.sessionId, {
      role: "user",
      content: `[SESSION_CLOSED] The AAC session has ended. Perform these final tasks:
1. Summarize the session — note anything significant that happened.
2. Clean up Student_Notes: view the notes, then delete duplicate or redundant entries and consolidate related information where possible. The goal is a concise, non-repetitive set of notes.`,
      timestamp: Date.now(),
    });

    await dualAgentService.triggerMonitor(this.sessionId, true);

    // Populate the generic session summary/title/importance (used by deep-analysis
    // session search). This runs after the monitor pass so any final Student_Notes
    // updates are already persisted. Fire-and-forget — errors are logged internally.
    const sessionId = this.sessionId;
    import("../sessionSummary").then(({ generateSessionSummaryAsync }) => {
      generateSessionSummaryAsync(sessionId);
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// WebSocket Server Setup — called from routes.ts
// ---------------------------------------------------------------------------

export function setupLiveWebSocket(server: import("http").Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);

    // Only handle /ws/live path
    if (url.pathname !== "/ws/live") return;

    // Authenticate at the upgrade boundary. Without this check anyone on the
    // internet who guesses or harvests a student UUID can open a session and
    // exfiltrate PHI through the live model; the per-student authorization
    // check inside handleInitialize relies on having an authenticated user.
    const user = await authenticateUpgrade(req);
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // ?test=1 routes to the minimal pass-through relay (no tools, no system
    // prompt, no state machine — used to isolate Gemini behavior from our
    // production middleware).
    const useMinimal = url.searchParams.get("test") === "1";

    wss.handleUpgrade(req, socket as any, head as any, async (ws) => {
      if (useMinimal) {
        console.log(`[LiveRelay] New MINIMAL WebSocket connection (test mode) user=${user.id}`);
        const { MinimalLiveRelay } = await import("./minimal-live-relay");
        new MinimalLiveRelay(ws as any);
      } else {
        console.log(`[LiveRelay] New WebSocket connection user=${user.id}`);
        new LiveRelay(ws, user);
      }
    });
  });

  console.log("[LiveRelay] WebSocket server ready on /ws/live (append ?test=1 for minimal relay)");
}
