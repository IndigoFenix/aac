// server/services/dual-agent/live-relay.ts
// WebSocket relay layer: bridges a client WebSocket to a live provider session.
// Handles tool call dispatch, TTS synthesis, contact enrollment, monitor triggering.
// Provider-agnostic: works with GeminiLiveProvider.

import type { IncomingMessage } from "http";
import { WebSocket, WebSocketServer } from "ws";
import type {
  LiveProvider,
  LiveProviderCallbacks,
  LiveProviderConfig,
  ToolCall,
  ToolResponse,
} from "./live-provider";
import { GeminiLiveProvider } from "./gemini-live-provider";
import { parseBoardButtons } from "./interactive-agent";

/** Extract a string argument from tool call args.
 *  Gemini's native function calling frequently uses wrong parameter names
 *  (e.g. "board_name" instead of "name", "observations" instead of "text").
 *  Falls back to the first non-ID string value in the args object. */
/** Keys that are never the "real content" of a tool call — skip during fallback. */
const EXTRACT_SKIP_KEYS = new Set(["id", "status", "confidence", "speaker", "type", "name"]);

function extractStringArg(args: Record<string, any>, declaredName: string, fallback = ""): string {
  if (typeof args[declaredName] === "string") return args[declaredName];
  // Fall back: find the first string value that looks like actual content
  for (const [key, val] of Object.entries(args)) {
    if (EXTRACT_SKIP_KEYS.has(key)) continue;
    if (typeof val === "string" && val.length > 0) return val;
  }
  return fallback;
}

/** Convert tool-call button args to internal format.
 *  Accepts multiple formats the model may produce:
 *  - String (preferred):  "Play|🎮, Water|💧, Help|face:abc123"  (parseBoardButtons format)
 *  - Array of strings:    ["Play|🎮", "Water|💧"]  (fallback — join and parse)
 *  - Object array:        [{label, icon}]  (OpenAI / legacy) */
function toolArgsToButtons(raw: unknown): Array<{ label: string; iconRef: string; symbolPath?: string }> {
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
    if (iconRef.startsWith("face:")) {
      symbolPath = `__FACE__:${iconRef.substring(5).trim()}`;
      iconRef = "👤";
    } else if (iconRef.startsWith("symbol:")) {
      symbolPath = `__SYMBOL__:${iconRef.substring(7).trim()}`;
      iconRef = "🖼️";
    }
    return { label, iconRef, symbolPath };
  });
}
import type {
  AACInteractionMode,
  AACResponseMode,
  DualAgentSessionState,
  TurnToolAccumulator,
} from "./types";
import { createEmptyAccumulator } from "./types";
import { buildToolDeclarations, type ToolDeclarationConfig } from "./tool-declarations";
import { ttsFacade, type ResolvedVoice } from "../voice/tts-facade";
import { searchYouTube } from "../youtube/youtube-search";
import { createContact, findSimilarContact, updateContact, getContactsByStudent } from "../biometric";
import { logDualAgent, logLiveSession } from "./dual-agent-logger";

// Re-use the existing dual-agent service for session management (monitor, voices, state)
import { dualAgentService, type SessionCache } from "./dual-agent-service";
import { boardRepository } from "../../repositories/boardRepository";
import { settingsRepository } from "../../repositories/settingsRepository";
import { MODEL_OPTIONS, type LLMProviderKey } from "@shared/llm-options";

// ---------------------------------------------------------------------------
// Client ↔ Server Protocol
// ---------------------------------------------------------------------------

/** Messages from client → server */
export type ClientMessage =
  | { type: "initialize"; studentId: string; userId?: string; sessionId?: string; interactionMode?: AACInteractionMode; responseMode?: AACResponseMode; debugMode?: boolean; initialFrame?: string }
  | { type: "frame_grid"; data: string; timestamps?: number[] }    // base64 JPEG
  | { type: "audio_clip"; data: string; mimeType?: string }        // base64 audio (ignored in live mode — Gemini hears PCM directly)
  | { type: "pcm_audio"; data: string }                            // base64 raw PCM Int16 16kHz — streamed directly to Gemini
  | { type: "user_message"; text: string }
  | { type: "voice_audio"; data: string; mimeType?: string }       // base64 webm (ignored in live mode — Gemini hears PCM directly)
  | { type: "button_press"; buttons: string[]; board?: any }
  | { type: "gesture_context"; data: string }
  | { type: "person_context"; data: any }
  | { type: "board_state"; data: any }
  | { type: "set_mode"; mode: AACInteractionMode }
  | { type: "set_response_mode"; mode: AACResponseMode }
  | { type: "unknown_face_descriptors"; data: Array<{ descriptor: number[]; boundingBox?: { x: number; y: number; w: number; h: number } }> }
  | { type: "page_navigate"; pageId: string; pageName: string; buttons: string[] }
  | { type: "app_dismissed"; appId: string }
  | { type: "app_canvas"; data: string }                     // base64 PNG — app canvas (e.g. drawing)
  | { type: "focus_frame"; data: string }                    // base64 JPEG — high-res focus frame
  | { type: "set_paused"; paused: boolean };

/** Messages from server → client */
export type ServerMessage =
  | { type: "initialized"; sessionId: string }
  | { type: "text"; data: string }
  | { type: "speak"; text: string; audio?: string }
  | { type: "interpret"; text: string; audio?: string; confidence?: string }
  | { type: "board_patch"; data: any }
  | { type: "board"; data: any }
  | { type: "transcript"; data: string; speaker?: string; confidence?: string }
  | { type: "context"; data: string }
  | { type: "emote"; data: string }
  | { type: "video_play"; data: any }
  | { type: "app_open"; data: any }
  | { type: "app_close"; data: any }
  | { type: "set_board"; data: { board: any; name: string; boardId: string } }
  | { type: "ai_button_press"; data: { label: string; action: string; targetPageId: string; targetPageName: string; buttons: any[] } }
  | { type: "debug"; data: any }
  | { type: "error"; data: string }
  | { type: "thinking"; active: boolean }
  | { type: "avatar_audio"; data: string }              // base64 audio chunk (AI voice TTS — avatar mouth animates)
  | { type: "interpretation_audio"; data: string }     // base64 audio chunk (student voice TTS)
  | { type: "monitor_status"; data: any }
  | { type: "audio_interrupt" }                          // Stop client audio playback (model interrupted by user)
  | { type: "yes_no"; data: any }                        // Yes/No question detected — trigger overlay
  | { type: "ask_yes_no"; data: any }                    // Deferred Yes/No — show after TTS playback
  | { type: "reconnecting"; data: string }               // Server is reconnecting to Gemini
  | { type: "client_tts"; data: { text: string; voiceId: string; apiKey: string; language: string; voiceRole: "ai" | "student" } }
  | { type: "reconnected" }                              // Reconnection successful
  | { type: "session_reset"; sessionId: string }         // New session created after repeated failures
  | { type: "rate_limited"; data: string }               // Rate limited — client should NOT auto-reconnect
  | { type: "safety_blocked"; data: string }             // Safety/policy block — transient indicator
  | { type: "focus_request"; data: { reason: string } }  // AI requests a high-res focus frame
  | { type: "complete"; data?: any };

// ---------------------------------------------------------------------------
// LiveRelay — one instance per client WebSocket connection
// ---------------------------------------------------------------------------

export class LiveRelay {
  private ws: WebSocket;
  private provider: LiveProvider | null = null;
  private providerKey: LLMProviderKey = "gemini";

  // Session state
  private studentId: string | null = null;
  private userId: string | undefined = undefined;
  private sessionId: string | null = null;
  private sessionCache: SessionCache | null = null;
  private interactionMode: AACInteractionMode = "interact";
  private responseMode: AACResponseMode = "fast";
  private paused = false;
  private debugMode = false;
  private hasLoggedInitialSession = false;

  // Voice config (resolved once during init)
  private aiVoice: ResolvedVoice | null = null;
  private studentVoice: ResolvedVoice | null = null;

  // For contact enrollment
  private unknownFaceDescriptors: Array<{ descriptor: number[]; boundingBox?: { x: number; y: number; w: number; h: number } }> = [];

  // Latest app canvas snapshot (e.g. drawing) — included with next frame_grid
  private latestAppCanvas: string | null = null; // base64 PNG

  // Board state reminder: periodically remind Gemini of current board state
  private boardReminderTimer: ReturnType<typeof setInterval> | null = null;
  private lastBoardUpdateTime = 0;
  private static readonly BOARD_REMINDER_INTERVAL_MS = 45_000; // 45s

  // Behavioral reminder: periodically re-inject critical rules to prevent prompt drift
  private behavioralReminderTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly BEHAVIORAL_REMINDER_INTERVAL_MS = 180_000; // 3 min

  // Dedup guard: track last user message to prevent rapid duplicates
  private lastUserMessage: { text: string; timestamp: number } | null = null;
  private static readonly DEDUP_WINDOW_MS = 2000;

  // Response dedup: suppress identical AI speech within a short window
  private lastAiSpeak: { text: string; timestamp: number } | null = null;
  private static readonly RESPONSE_DEDUP_WINDOW_MS = 5000;

  // Tool call dedup: suppress identical consecutive tool calls within a short window
  private lastToolCallSig: { sig: string; timestamp: number } | null = null;
  private static readonly TOOL_DEDUP_WINDOW_MS = 5000;

  // User message priority: suppress frame_grids briefly after user messages
  // so Gemini processes the user message without visual check interference
  private userMessageSentAt = 0;
  private static readonly USER_MSG_PRIORITY_MS = 3000;

  // Reconnection tracking
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_BEFORE_RESET = 2;
  private initialConnectionDone = false;

  // Safety block tracking — progressive content scrubbing
  private consecutiveSafetyBlocks = 0;

  // Greeting tracking: detect if the model greets via speak() or just generates audio
  private hasGreeted = false;
  private greetingReminderSent = false;

  // Client WebSocket health check (ping/pong)
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongReceived = true;
  private static readonly PING_INTERVAL_MS = 30_000; // 30s

  // When true, tool responses include scheduling: "SILENT" (Gemini native audio mode)
  private useToolResponseScheduling = false;

  // Accumulation for turn processing (both modes share this)
  private turnAccum: TurnToolAccumulator = createEmptyAccumulator();
  private turnStartTime = 0;

  // Prevents sending overlapping turnComplete=true messages.
  // Set when we send ANY message with turnComplete=true to the provider.
  // Cleared when the model's first tool call or TURN_COMPLETE arrives.
  // Without this, a frame_grid can arrive during the "thinking gap" between
  // sending a prompt and receiving the first tool call, queueing a second
  // "please respond" signal that causes duplicate model turns.
  private awaitingModelResponse = false;

  // Turn processing guard: prevents concurrent processTurnEnd() calls
  private turnProcessingBusy = false;

  // Post-turn cooldown: suppress frame_grids briefly after the model finishes a turn
  // to prevent immediate re-triggering of tool calls on the same visual input.
  private lastTurnCompleteAt = 0;
  private static readonly POST_TURN_COOLDOWN_MS = 4000;

  // Consecutive model turn counter: tracks how many turns the model takes without
  // user input in between. Used to detect and suppress rapid repeating tool calls.
  private consecutiveModelTurns = 0;
  private lastUserInputAt = 0;

  // Sequence counter for debug logging — monotonically increasing per relay instance
  private seqCounter = 0;

  constructor(ws: WebSocket) {
    this.ws = ws;

    // Handle client messages
    ws.on("message", (raw) => {
      try {
        const msg: ClientMessage = JSON.parse(raw.toString());
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

    // Respond to pong frames (for health check)
    ws.on("pong", () => {
      this.pongReceived = true;
    });

    // Start client WebSocket health check
    this.startPingTimer();
  }

  /**
   * Build the LiveProviderCallbacks object wired to this relay instance.
   * Shared by all providers — the interface is provider-agnostic.
   */
  private buildProviderCallbacks(): LiveProviderCallbacks {
    return {
      onText: (text) => this.handleProviderText(text),
      onTurnComplete: () => this.handleProviderTurnComplete(),
      onInterrupted: () => this.handleProviderInterrupted(),
      onToolCall: (calls) => this.handleToolCalls(calls),
      onToolCallCancellation: (ids) => {
        console.log(`[LiveRelay] Tool call cancellation for ids: ${ids.join(", ")}`);
      },
      onAudioData: () => { /* Discard — we use ElevenLabs TTS */ },
      onUsage: (usage) => this.handleUsage(usage),
      onGoAway: () => {
        console.log("[LiveRelay] Provider session goAway — reconnecting");
      },
      onReady: () => {
        console.log("[LiveRelay] Provider session ready");
        this.reconnectAttempts = 0;

        if (this.initialConnectionDone) {
          this.send({ type: "reconnected" });
          this.injectReconnectionContext();
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
          // Safety errors are handled by onReconnecting → handleSafetyBlock
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
      // No onInputTranscription — the model decides what to transcribe via the transcript() tool,
      // which gives it control over echo filtering (it knows what it recently said).
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
          // Block all input while paused
          if (this.paused) break;
          // Suppress frames while the model is processing tool calls, or we're already
          // waiting for a model response (prevents overlapping turnComplete=true signals
          // that cause duplicate model turns).
          if (this.turnProcessingBusy || this.turnStartTime > 0 || this.awaitingModelResponse) {
            logLiveSession("FRAME_GRID SUPPRESSED", `turnProcessingBusy=${this.turnProcessingBusy} turnStartTime=${this.turnStartTime} awaitingModelResponse=${this.awaitingModelResponse}`);
            break;
          }
          const frameSendTime = Date.now();
          if (frameSendTime - this.userMessageSentAt < LiveRelay.USER_MSG_PRIORITY_MS) {
            logLiveSession("FRAME_GRID SUPPRESSED", `userMessagePriority (${frameSendTime - this.userMessageSentAt}ms < ${LiveRelay.USER_MSG_PRIORITY_MS}ms)`);
            break;
          }
          // Post-turn cooldown: don't immediately re-trigger the model after it just finished
          if (frameSendTime - this.lastTurnCompleteAt < LiveRelay.POST_TURN_COOLDOWN_MS) {
            logLiveSession("FRAME_GRID SUPPRESSED", `postTurnCooldown (${frameSendTime - this.lastTurnCompleteAt}ms < ${LiveRelay.POST_TURN_COOLDOWN_MS}ms)`);
            break;
          }

          // A frame grid that passes all gates counts as new input — reset consecutive turn counter
          this.consecutiveModelTurns = 0;
          this.lastUserInputAt = frameSendTime;
          this.awaitingModelResponse = true;

          const extraImages = this.latestAppCanvas
            ? [{ data: this.latestAppCanvas, mimeType: "image/png", label: "The student is using the Drawing app. This image shows their current drawing." }]
            : undefined;
          this.provider!.sendFrameWithPrompt(
            msg.data,
            `[VISUAL CHECK] Observe the scene. Update the AAC board if you see new objects, activities, or communication opportunities. Stay silent if nothing important changed.`,
            extraImages,
          );
          break;
        }

        case "pcm_audio": {
          // Block all input while paused
          if (this.paused) break;
          // Raw PCM Int16 16kHz — stream directly to Gemini via sendRealtimeInput.
          // Gate audio during ALL active processing states to prevent VAD from
          // triggering new model turns that cause repeated tool calls.
          // Audio only flows when the system is truly idle.
          if (this.turnStartTime > 0 || this.turnProcessingBusy || this.awaitingModelResponse) break;
          const pcmTime = Date.now();
          if (pcmTime - this.lastTurnCompleteAt < LiveRelay.POST_TURN_COOLDOWN_MS) break;
          this.provider!.sendAudio(msg.data);
          break;
        }

        case "audio_clip":
          // No-op: Gemini already hears audio via continuous PCM streaming
          break;

        case "focus_frame": {
          // High-resolution single frame requested by AI for detailed analysis
          this.awaitingModelResponse = true;
          this.provider!.sendFrameWithPrompt(
            msg.data,
            `[FOCUS FRAME] This is a HIGH-RESOLUTION single frame captured at your request. Analyze the image carefully for fine details, text, labels, faces, or objects you couldn't identify before. Report findings via context() tool and update the board if needed.`,
          );
          console.log("[LiveRelay] Focus frame sent to Gemini");
          break;
        }

        case "user_message": {
          // Dedup guard: skip identical messages within 500ms window
          const now = Date.now();
          if (
            this.lastUserMessage &&
            this.lastUserMessage.text === msg.text &&
            now - this.lastUserMessage.timestamp < LiveRelay.DEDUP_WINDOW_MS
          ) {
            logDualAgent("LiveRelay.userMessage [dedup]", {
              sessionId: this.sessionId,
              text: msg.text.substring(0, 80),
              elapsed: `${now - this.lastUserMessage.timestamp}ms`,
            });
            break;
          }
          this.lastUserMessage = { text: msg.text, timestamp: now };
          this.userMessageSentAt = now;
          this.lastUserInputAt = now;
          this.consecutiveModelTurns = 0;
          this.awaitingModelResponse = true;

          // Record user message in session state for monitor context + persist to DB
          if (this.sessionId) {
            dualAgentService.addPendingMessage(this.sessionId, {
              role: "user",
              content: msg.text,
              timestamp: now,
            }).catch(err => console.error("[LiveRelay] Failed to persist user message:", err));
          }
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

        case "button_press":
          this.userMessageSentAt = Date.now();
          this.lastUserInputAt = Date.now();
          this.consecutiveModelTurns = 0;
          this.awaitingModelResponse = true;
          this.handleInterpretButtons(msg.buttons, msg.board);
          break;

        case "gesture_context":
          // Inject gesture context as system context
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
          this.provider!.sendContextInjection(`[CURRENT BOARD STATE]\n${JSON.stringify(msg.data)}`);
          break;
        }

        case "set_mode":
          this.interactionMode = msg.mode;
          this.provider!.sendContextInjection(`[MODE CHANGE] Interaction mode changed to: ${msg.mode}`);
          break;

        case "set_response_mode":
          this.responseMode = msg.mode;
          break;

        case "unknown_face_descriptors":
          this.unknownFaceDescriptors = msg.data;
          break;

        case "page_navigate":
          this.provider!.sendContextInjection(
            `[PAGE NAVIGATE] User navigated to page "${msg.pageName}". Current buttons: ${msg.buttons.join(", ")}`,
          );
          // Update session state
          if (this.sessionCache?.state) {
            this.sessionCache.state.currentPageId = msg.pageId;
          }
          break;

        case "app_canvas":
          // Cache latest app canvas snapshot — will be included with next frame_grid
          this.latestAppCanvas = msg.data;
          break;

        case "set_paused":
          this.paused = msg.paused;
          if (msg.paused) {
            // Notify the model that the session is paused so it doesn't get confused
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
          // Clear cached canvas since app is closing
          this.latestAppCanvas = null;
          // Trigger AI response (like a button press) — AI should comment + rebuild board
          this.userMessageSentAt = Date.now();
          this.lastUserInputAt = Date.now();
          this.consecutiveModelTurns = 0;
          this.awaitingModelResponse = true;
          this.provider!.sendMessage(
            `[APP CLOSED] The user closed the "${msg.appId}" app and returned to the AAC board. Comment briefly on what they were doing in the app, then use rebuild_board() to create a fresh set of communication buttons for the current context.`,
            "user",
          );
          logDualAgent("LiveRelay.appDismissed", { sessionId: this.sessionId, appId: msg.appId });
          break;
        }
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
    this.studentId = msg.studentId;
    // Preserve userId from initial init (may be absent on server-side forceNewSession)
    if (msg.userId) this.userId = msg.userId;
    this.interactionMode = msg.interactionMode || "interact";
    this.responseMode = msg.responseMode || "fast";
    this.debugMode = msg.debugMode || false;

    try {
      // -----------------------------------------------------------------------
      // Provider selection: read from aac_chat LLM settings FIRST
      // (determines provider before prompt is built)
      // -----------------------------------------------------------------------
      const aacChatConfig = await settingsRepository.getLLMConfig('aac_chat');

      // Allow env var override for local testing without touching the database
      const overrideModel = process.env.OVERRIDE_AAC_LIVE_MODEL;
      if (overrideModel) {
        const overrideInfo = MODEL_OPTIONS.find(m => m.modelId === overrideModel && m.supportsLive);
        if (overrideInfo) {
          aacChatConfig.provider = overrideInfo.provider;
          aacChatConfig.model = overrideInfo.modelId;
          console.log(`[LiveRelay] OVERRIDE_AAC_LIVE_MODEL → ${overrideInfo.provider}/${overrideInfo.modelId}`);
        } else {
          console.warn(`[LiveRelay] OVERRIDE_AAC_LIVE_MODEL="${overrideModel}" not found in catalog or not a live model — ignoring`);
        }
      }

      this.providerKey = aacChatConfig.provider;

      // Look up the model in the catalog to determine capabilities
      const isGeminiLive = this.providerKey === "gemini";
      // GA native-audio model (gemini-live-*): supports TEXT + function calling (ideal)
      const isGeminiLiveGA = isGeminiLive && aacChatConfig.model.startsWith("gemini-live-");
      // Preview native-audio model: only supports AUDIO + function calling
      const isGeminiNativeAudioPreview = isGeminiLive && !isGeminiLiveGA && /native-audio/i.test(aacChatConfig.model);

      // Use existing dual-agent service to get/create session + resolve prompt + voices
      const state = await dualAgentService.initializeSession(
        msg.studentId,
        msg.userId,
        msg.sessionId,
        this.interactionMode,
      );
      this.sessionId = state.sessionId;

      // Get session cache (contains state, agents, mutex)
      const cached = dualAgentService.getSessionCache(state.sessionId);
      if (!cached) {
        throw new Error("Session cache not found after initialization");
      }
      this.sessionCache = cached;

      // Register context injection callback — when monitor injects [CONTEXT],
      // forward it to the live session so the model sees it immediately
      cached.state.onContextInjection = (text: string) => {
        console.log("[LiveRelay] Monitor context injection →", text.substring(0, 80));
        this.provider?.sendContextInjection(`[Monitor Context]\n${text}`);
        this.send({ type: "context", data: `[Monitor] ${text}` });
      };

      // Build tool declarations based on session configuration
      const toolConfig: ToolDeclarationConfig = {
        interpretationLevel: cached.state.interpretationLevel ?? 1,
        enabledApps: (cached.state.appState?.enabledApps || [])
          .map(id => {
            const appDefs = (dualAgentService as any).getAppDefinitions?.() || [];
            return appDefs.find((a: any) => a.id === id);
          })
          .filter(Boolean),
        availableBoards: (cached.state.availableBoards || []).map(b => ({ key: b.key, name: b.name })),
        hasLoadedBoard: !!cached.state.loadedBoardId,
        youtubeEnabled: cached.state.appState?.enabledApps?.includes("youtube") || false,
        faceRecognitionActive: (cached.state.cachedContacts?.length || 0) > 0 || this.unknownFaceDescriptors.length > 0,
        isSilentMode: this.interactionMode === "silent",
        maxBoardItems: cached.state.maxBoardItems || 12,
        loadedBoardName: cached.state.loadedBoardData?.name || null,
        currentEmote: cached.state.currentEmote,
        activeApp: cached.state.appState?.activeApp || null,
      };

      // Close any existing provider (for forceNewSession re-init)
      this.provider?.close();

      // Create the Gemini Live provider + tools
      const callbacks = this.buildProviderCallbacks();
      const tools = buildToolDeclarations(toolConfig);
      let providerConfig: LiveProviderConfig;

      if (isGeminiLiveGA) {
        // GA Gemini Live model via Vertex AI: AUDIO modality + function calling
        // Native audio models ONLY support AUDIO output (TEXT gives 1007 error).
        // Audio output is discarded — ElevenLabs TTS is used instead.
        // proactiveAudio: false — prevents the model from autonomously starting new
        // turns after completing one, which causes repeated tool calls.
        this.useToolResponseScheduling = false;
        this.provider = new GeminiLiveProvider(callbacks, true /* useVertexAI */);
        providerConfig = {
          model: aacChatConfig.model,
          temperature: 0.7,
          tools,
          compressionTriggerTokens: 100_000,
          compressionTargetTokens: 50_000,
          responseModality: "AUDIO",
          proactiveAudio: false,
        };
      } else {
        // Preview native-audio model: AUDIO modality + function calling
        // proactiveAudio: false — same as GA path
        this.useToolResponseScheduling = false;
        this.provider = new GeminiLiveProvider(callbacks);
        providerConfig = {
          model: aacChatConfig.model,
          temperature: 0.7,
          tools,
          compressionTriggerTokens: 100_000,
          compressionTargetTokens: 50_000,
          responseModality: "AUDIO",
          proactiveAudio: false,
        };
      }

      // Build system prompt with echo awareness appendix
      const echoAwareness = this.buildGeminiNativeAudioEchoAwareness();
      const systemPrompt = state.interactivePrompt + "\n\n" + echoAwareness;

      // Resolve voices for TTS via the monitor agent's student info
      try {
        const student = cached.monitorAgent.getStudent?.();
        if (student) {
          const voices = await (dualAgentService as any).resolveVoices(cached);
          this.aiVoice = voices?.aiVoice || null;
          this.studentVoice = voices?.studentVoice || null;
        }
      } catch (err) {
        console.warn("[LiveRelay] Voice resolution failed, using defaults:", err);
      }

      // Connect to the provider
      await this.provider.connect(systemPrompt, providerConfig);

      // Log full prompt + tools to dedicated session log for debugging
      const providerLabel = isGeminiLiveGA ? "gemini-live-ga" : "gemini-native-audio-preview";
      logLiveSession("SESSION START", [
        `Session: ${state.sessionId}`,
        `Student: ${msg.studentId}`,
        `Provider: ${providerLabel}`,
        `Model: ${providerConfig.model}`,
        `Response Modality: ${providerConfig.responseModality || "default"}`,
        `Interaction: ${this.interactionMode}`,
        `Response: ${this.responseMode}`,
      ].join("\n"), !this.hasLoggedInitialSession /* truncate only on first session, append on reconnects */);
      this.hasLoggedInitialSession = true;

      logLiveSession("SYSTEM PROMPT", systemPrompt);

      if (tools.length > 0) {
        logLiveSession("TOOL DECLARATIONS", JSON.stringify(tools, null, 2));
      }

      // Start periodic reminders
      this.startBoardReminder();
      this.startBehavioralReminder();

      // Send initialization confirmation to client
      this.send({ type: "initialized", sessionId: state.sessionId });

      logDualAgent("LiveRelay.initialize", {
        sessionId: state.sessionId,
        studentId: msg.studentId,
        provider: providerLabel,
        model: providerConfig.model,
        responseModality: providerConfig.responseModality || "default",
        interactionMode: this.interactionMode,
        responseMode: this.responseMode,
      });

      // Send greeting prompt — include persona hint
      const isSilent = this.interactionMode === "silent";
      const student = cached.monitorAgent.getStudent?.();
      const personaHint = student?.aacSettings?.chatAgentPrompt?.trim()
        ? `\nThe student is ${student.name}. Use their profile (in the system prompt) to personalize the board — reflect their interests, communication level, and needs.`
        : "";
      const imageHint = msg.initialFrame ? "\nUse the camera image to observe the environment and make the buttons contextually relevant." : "";
      const boardHint = state.availableBoards && state.availableBoards.length > 0
        ? ` If a custom board from the Available Custom Boards list is appropriate for this student, use set_board() instead of rebuild_board().`
        : "";
      const greetingPrompt = isSilent
        ? `Generate 4-12 contextual utterance buttons — complete phrases the user might want to say. Use the student's profile and interests from the system prompt to make them relevant.${imageHint} Use rebuild_board() to create the initial board.${boardHint}${personaHint}`
        : `IMPORTANT: You communicate ONLY through function calls. Call rebuild_board() with 4-12 initial communication buttons, then call speak() to greet the user. Both must be function calls — do NOT output plain text.${imageHint}${boardHint}${personaHint}`;

      this.initialConnectionDone = true;
      this.hasGreeted = false;
      this.greetingReminderSent = false;

      // Native audio AUDIO-modality models produce garbage audio tokens during warmup.
      // TEXT modality doesn't have this issue, so only delay for AUDIO mode.
      const isAudioModality = providerConfig.responseModality === "AUDIO";
      const greetingDelay = isAudioModality ? 3000 : 0;
      const sendGreeting = () => {
        if (!this.provider) return;
        this.awaitingModelResponse = true;
        logLiveSession("GREETING PROMPT", greetingPrompt);
        if (msg.initialFrame) {
          this.provider.sendFrameWithPrompt(msg.initialFrame, greetingPrompt);
        } else {
          this.provider.sendMessage(greetingPrompt, "user");
        }
      };
      if (greetingDelay > 0) {
        setTimeout(sendGreeting, greetingDelay);
      } else {
        sendGreeting();
      }

      console.log(`[LiveRelay] Initialized session ${state.sessionId} for student ${msg.studentId} (provider: ${providerLabel}, modality: ${providerConfig.responseModality || "default"}, model: ${providerConfig.model})`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[LiveRelay] Initialize failed:", error.message);
      this.send({ type: "error", data: "error:INIT_FAILED" });
    }
  }

  // -------------------------------------------------------------------------
  // Provider-specific echo awareness prompts
  // -------------------------------------------------------------------------

  private buildGeminiNativeAudioEchoAwareness(): string {
    return `CRITICAL — OUTPUT RULES:
You communicate ONLY through function calls (tool calls). Do NOT produce speech or audio output — your audio is discarded. A separate TTS system voices the text from your speak() and interpret() calls instead.

AUDIO ECHO AWARENESS:
You receive continuous microphone audio. Because speak()/interpret() text is voiced by external TTS through speakers near the mic, you WILL hear your own output echoed back. Recognize these echoes as YOUR OWN output — never transcribe or respond to them. Only treat audio as genuine user speech if it clearly does NOT match something you recently said.`;
  }

  // -------------------------------------------------------------------------
  // Button interpretation (send interpretation prompt to provider)
  // -------------------------------------------------------------------------

  private handleInterpretButtons(buttons: string[], board?: any): void {
    const buttonList = buttons.join(", ");
    console.log(`[LiveRelay] Interpreting buttons: ${buttonList}`);

    // Record button press as a user message in session log
    if (this.sessionId) {
      dualAgentService.addPendingMessage(this.sessionId, {
        role: "user",
        content: `[BUTTON PRESS] ${buttonList}`,
        timestamp: Date.now(),
      }).catch(err => console.error("[LiveRelay] Failed to persist button press:", err));
    }

    this.provider!.sendMessage(`[BUTTON PRESS] ${buttonList}
    The user pressed the above button(s). Interpret this as a user message and respond accordingly.
    IMPORTANT: Use rebuild_board() (or set_board(), if relevant) NOW to update the board with new buttons or content.
    `, "user");
  }

  // -------------------------------------------------------------------------
  // Provider response handling (function calling mode)
  // -------------------------------------------------------------------------

  /**
   * Handle text from the provider.
   * Stray text (log only — real output comes through tool calls).
   */
  private handleProviderText(text: string): void {
    if (this.turnStartTime === 0) {
      this.turnStartTime = Date.now();
      this.reconnectAttempts = 0;
      this.consecutiveSafetyBlocks = 0;
    }

    if (text.trim()) {
      logDualAgent("LiveRelay.strayText", { sessionId: this.sessionId, text: text.substring(0, 200) });
    }
  }

  /**
   * Handle tool calls from Gemini. Process each call and send responses back.
   */
  private async handleToolCalls(calls: ToolCall[]): Promise<void> {
    const seq = ++this.seqCounter;
    const callNames = calls.map(c => c.name).join(", ");
    logLiveSession(`RELAY #${seq} handleToolCalls`, `calls=[${callNames}] turnStartTime=${this.turnStartTime} consecutiveModelTurns=${this.consecutiveModelTurns} turnProcessingBusy=${this.turnProcessingBusy} awaitingModelResponse=${this.awaitingModelResponse}`);

    // Model has started responding — clear the "awaiting response" guard so future
    // user inputs (frame_grids, button presses) can be queued once this turn ends.
    this.awaitingModelResponse = false;

    // Duplicate turn suppression: if processTurnEnd is already running, these tool
    // calls are from a duplicate model turn. Send a minimal response so the model
    // doesn't hang (blocking tools wait for response), but don't execute any side
    // effects (no WS events to client, no board updates, no state changes).
    if (this.turnProcessingBusy) {
      logLiveSession(`RELAY #${seq} DUPLICATE TURN`, `Suppressed ${callNames} — turnProcessingBusy=true`);
      const suppressedResponses: ToolResponse[] = calls.map(c => ({
        id: c.id, name: c.name, response: { output: "already handled" },
      }));
      this.sendToolResponseWithScheduling(suppressedResponses);
      return;
    }

    if (this.turnStartTime === 0) {
      this.turnStartTime = Date.now();
      this.reconnectAttempts = 0;
      this.consecutiveSafetyBlocks = 0;
    }

    // Dedup: suppress identical consecutive tool call batches within a short window
    const callSig = calls.map(c => `${c.name}:${JSON.stringify(c.args)}`).join("|");
    const now = Date.now();
    if (
      this.lastToolCallSig &&
      this.lastToolCallSig.sig === callSig &&
      now - this.lastToolCallSig.timestamp < LiveRelay.TOOL_DEDUP_WINDOW_MS
    ) {
      logLiveSession("TOOL CALL DEDUP", `Suppressed duplicate: ${calls.map(c => c.name).join(", ")}`);
      const dedupResponses: ToolResponse[] = calls.map(c => ({
        id: c.id, name: c.name, response: { output: "already applied" },
      }));
      this.sendToolResponseWithScheduling(dedupResponses);
      return;
    }
    this.lastToolCallSig = { sig: callSig, timestamp: now };

    const responses: ToolResponse[] = [];

    for (const call of calls) {
      try {
        logDualAgent("LiveRelay.toolCall", { sessionId: this.sessionId, name: call.name, args: call.args });
        logLiveSession(`TOOL CALL: ${call.name}`, JSON.stringify({ id: call.id, args: call.args }, null, 2));
        const resp = await this.handleSingleToolCall(call);
        logLiveSession(`TOOL RESPONSE: ${call.name}`, JSON.stringify(resp.response, null, 2));
        responses.push(resp);
      } catch (err) {
        const errMsg = (err as Error).message;
        console.error(`[LiveRelay] Tool call "${call.name}" failed:`, errMsg);
        logLiveSession(`TOOL ERROR: ${call.name}`, errMsg);
        responses.push({
          id: call.id,
          name: call.name || "unknown",
          response: { error: errMsg },
        });
      }
    }

    // Send all responses back to the provider (with scheduling if applicable)
    logLiveSession(`RELAY #${seq} sending tool responses`, `count=${responses.length} scheduling=${this.useToolResponseScheduling ? "SILENT" : "default"} names=[${responses.map(r => r.name).join(", ")}]`);
    this.sendToolResponseWithScheduling(responses);

    // Greeting nudge: if the model has processed tool calls but never used speak(),
    // it likely generated the greeting as audio (which we discard). Remind it once.
    // Uses sendContextInjection (turnComplete=false) to avoid triggering a new turn
    // that could cause repeated tool calls. The model will see this context on its next turn.
    if (!this.hasGreeted && !this.greetingReminderSent && this.interactionMode === "interact") {
      this.greetingReminderSent = true;
      setTimeout(() => {
        if (!this.hasGreeted && this.provider) {
          const reminder = `You have not greeted the user yet. Your audio output is discarded — the user cannot hear you unless you call speak(). On your NEXT turn, greet the user with speak() and provide initial buttons with rebuild_board().`;
          this.provider.sendContextInjection(reminder);
          logLiveSession("GREETING REMINDER", "Injected via context — model has not called speak() yet");
        }
      }, 2000);
    }
  }

  /**
   * Send tool responses with SILENT scheduling injected when useToolResponseScheduling is enabled.
   * Gemini native-audio mode uses SILENT to absorb results without generating intermediate audio.
   */
  private sendToolResponseWithScheduling(responses: ToolResponse[]): void {
    if (this.useToolResponseScheduling) {
      responses = responses.map(r => ({ ...r, scheduling: "SILENT" as const }));
    }
    this.provider!.sendToolResponse(responses);
  }

  /**
   * Process a single tool call and return the tool response.
   * Also sends real-time messages to the client and accumulates data for turn-end.
   */
  private async handleSingleToolCall(call: ToolCall): Promise<ToolResponse> {
    const name = call.name || "unknown";
    const args = call.args || {};
    const isSilent = this.interactionMode === "silent";
    const state = this.sessionCache?.state;

    switch (name) {
      case "speak": {
        const text = extractStringArg(args, "text");
        if (!text) {
          logLiveSession("EMPTY TOOL CALL", `speak() got empty text. Raw args: ${JSON.stringify(args)}`);
        }
        if (text && !isSilent) {
          this.send({ type: "text", data: text });
        }
        if (text) this.hasGreeted = true;
        this.turnAccum.speakText += (this.turnAccum.speakText ? " " : "") + text;
        return ({
          id: call.id,
          name,
          response: { output: "ok" },
        });
      }

      case "interpret": {
        const text = extractStringArg(args, "text");
        if (!text) {
          logLiveSession("EMPTY TOOL CALL", `interpret() got empty text. Raw args: ${JSON.stringify(args)}`);
        }
        const confidence = (args.confidence ?? "medium") as string;
        this.send({ type: "interpret", text, confidence });
        this.turnAccum.interpretText += (this.turnAccum.interpretText ? " " : "") + text;
        this.turnAccum.interpretConfidence = confidence as any;
        return ({
          id: call.id,
          name,
          response: { output: "ok" },
        });
      }

      case "transcript": {
        const text = extractStringArg(args, "text");
        const speaker = (typeof args.speaker === "string" ? args.speaker : "Unknown");
        const confidence = args.confidence as string | undefined;
        this.send({ type: "transcript", data: text, speaker, confidence });
        this.turnAccum.transcriptText += `[${speaker}] ${text} `;
        this.turnAccum.transcriptSpeaker = speaker;
        return ({
          id: call.id,
          name,
          response: { output: "ok" },
        });
      }

      case "context": {
        const text = extractStringArg(args, "text");
        this.send({ type: "context", data: text });
        this.turnAccum.contextText += (this.turnAccum.contextText ? " " : "") + text;
        return ({
          id: call.id,
          name,
          response: { output: "ok" },
        });
      }

      case "add_buttons": {
        const buttons = toolArgsToButtons(args.buttons);
        const maxSlots = state?.maxBoardItems || 12;

        // Enforce button limit
        if (state) {
          if (state.loadedBoardId) {
            const nativeLabels = this.getNativePageButtonLabels(state);
            const blankSlots = maxSlots - nativeLabels.length;
            const newAiCount = state.aiAddedButtonLabels.length + buttons.length;
            if (newAiCount > blankSlots) {
              const available = blankSlots - state.aiAddedButtonLabels.length;
              logDualAgent("LiveRelay.boardPatchRejected", { sessionId: this.sessionId, attempted: buttons.length, current: state.aiAddedButtonLabels.length, max: blankSlots });
              return ({
                id: call.id,
                name,
                response: { error: `Cannot add ${buttons.length} button(s) — would exceed ${blankSlots} blank slots on this custom board. Currently ${state.aiAddedButtonLabels.length} AI-added buttons, ${available} slot(s) available. Use remove_buttons() to remove AI-added buttons first.` },
                    });
            }
            state.aiAddedButtonLabels = [...state.aiAddedButtonLabels, ...buttons.map(b => b.label)];
          } else {
            const newCount = state.boardButtonLabels.length + buttons.length;
            if (newCount > maxSlots) {
              const available = maxSlots - state.boardButtonLabels.length;
              logDualAgent("LiveRelay.boardPatchRejected", { sessionId: this.sessionId, attempted: buttons.length, current: state.boardButtonLabels.length, max: maxSlots });
              return ({
                id: call.id,
                name,
                response: { error: `Cannot add ${buttons.length} button(s) — would exceed the ${maxSlots}-button limit. Currently ${state.boardButtonLabels.length} buttons, ${available} slot(s) available. Use remove_buttons() first to free slots.` },
                    });
            }
          }
          state.boardButtonLabels = [...state.boardButtonLabels, ...buttons.map(b => b.label)];
        }

        this.lastBoardUpdateTime = Date.now();
        this.send({ type: "board_patch", data: { add: buttons, remove: [] } });
        this.turnAccum.boardChanged = true;
        this.turnAccum.boardAddLabels.push(...buttons.map(b => b.label));

        // Confirm with board state
        let stateMsg = "";
        if (state) {
          if (state.loadedBoardId) {
            const nativeLabels = this.getNativePageButtonLabels(state);
            const blankSlots = maxSlots - nativeLabels.length;
            const available = blankSlots - state.aiAddedButtonLabels.length;
            stateMsg = `Custom board — AI-added (${state.aiAddedButtonLabels.length}/${blankSlots}): ${state.aiAddedButtonLabels.join(", ")}. ${available} slots available.`;
          } else {
            const available = maxSlots - state.boardButtonLabels.length;
            stateMsg = `Board: ${state.boardButtonLabels.length}/${maxSlots} buttons (${available} available): ${state.boardButtonLabels.join(", ")}`;
          }
        }

        return ({
          id: call.id,
          name,
          response: { output: "ok", board_state: stateMsg },
        });
      }

      case "remove_buttons": {
        const labels = args.labels as string[] || [];
        const maxSlots = state?.maxBoardItems || 12;

        let effectiveRemoves = labels;
        if (state) {
          if (state.loadedBoardId) {
            const nativeSet = new Set(this.getNativePageButtonLabels(state).map(l => l.toLowerCase()));
            effectiveRemoves = labels.filter(l => !nativeSet.has(l.toLowerCase()));
            if (effectiveRemoves.length === 0) {
              return ({
                id: call.id,
                name,
                response: { error: "Cannot remove fixed board buttons. Only AI-added buttons can be removed." },
                    });
            }
            const removeSet = new Set(effectiveRemoves.map(l => l.toLowerCase()));
            state.aiAddedButtonLabels = state.aiAddedButtonLabels.filter(l => !removeSet.has(l.toLowerCase()));
            state.boardButtonLabels = state.boardButtonLabels.filter(l => !removeSet.has(l.toLowerCase()));
          } else {
            const removeSet = new Set(labels.map(l => l.toLowerCase()));
            state.boardButtonLabels = state.boardButtonLabels.filter(l => !removeSet.has(l.toLowerCase()));
          }
        }

        this.lastBoardUpdateTime = Date.now();
        this.send({ type: "board_patch", data: { add: [], remove: effectiveRemoves } });
        this.turnAccum.boardChanged = true;
        this.turnAccum.boardRemoveLabels.push(...effectiveRemoves);

        let stateMsg = "";
        if (state) {
          if (state.loadedBoardId) {
            const nativeLabels = this.getNativePageButtonLabels(state);
            const blankSlots = maxSlots - nativeLabels.length;
            const available = blankSlots - state.aiAddedButtonLabels.length;
            stateMsg = `Custom board — AI-added (${state.aiAddedButtonLabels.length}/${blankSlots}): ${state.aiAddedButtonLabels.join(", ") || "none"}. ${available} slots available.`;
          } else {
            const available = maxSlots - state.boardButtonLabels.length;
            stateMsg = `Board: ${state.boardButtonLabels.length}/${maxSlots} buttons (${available} available): ${state.boardButtonLabels.join(", ") || "none"}`;
          }
        }

        return ({
          id: call.id,
          name,
          response: { output: "ok", board_state: stateMsg },
        });
      }

      case "rebuild_board": {
        const buttons = toolArgsToButtons(args.buttons);

        if (state) {
          state.loadedBoardId = null;
          state.loadedBoardData = undefined;
          state.currentPageId = null;
          state.pageHistory = [];
          state.maxBoardItems = 12;
          state.aiAddedButtonLabels = [];
          state.boardButtonLabels = buttons.slice(0, 12).map(b => b.label);
        }

        this.lastBoardUpdateTime = Date.now();
        this.send({ type: "board", data: this.buildBoardFromButtons(buttons) });
        this.turnAccum.boardChanged = true;
        this.turnAccum.boardRebuilt = true;
        this.turnAccum.boardAddLabels.push(...buttons.map(b => b.label));

        const available = state ? ((state.maxBoardItems || 12) - state.boardButtonLabels.length) : 0;
        return ({
          id: call.id,
          name,
          response: { output: "ok", board_state: `Board rebuilt. ${state?.boardButtonLabels.length || 0}/12 buttons (${available} available): ${state?.boardButtonLabels.join(", ") || ""}` },
        });
      }

      case "set_board": {
        // BLOCKING — model waits for response with board layout info
        const boardKey = extractStringArg(args, "board_key").toLowerCase().replace(/ /g, '_');
        if (!state) {
          return ({ id: call.id, name, response: { error: "No session state" } });
        }
        const match = state.availableBoards?.find(b => b.key === boardKey);
        if (!match) {
          const availableKeys = state.availableBoards?.map(b => b.key).join(", ") || "none";
          return ({ id: call.id, name, response: { error: `Board "${boardKey}" not found. Available: ${availableKeys}` } });
        }

        try {
          const fullBoard = await boardRepository.getBoard(match.id);
          if (!fullBoard?.irData) {
            return ({ id: call.id, name, response: { error: "Board has no data" } });
          }
          const boardData = fullBoard.irData as any;
          state.loadedBoardId = match.id;
          state.loadedBoardData = boardData;
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

          const blankSlots = state.maxBoardItems - nativeLabels.length;
          return ({
            id: call.id,
            name,
            response: {
              output: "ok",
              board_name: match.name,
              pages: boardData.pages?.length || 1,
              slots: state.maxBoardItems,
              fixed_buttons: nativeLabels.join(", "),
              blank_slots: blankSlots,
              note: "You CANNOT remove the board's built-in buttons. Use add_buttons() for the blank slots.",
            },
          });
        } catch (err) {
          return ({ id: call.id, name, response: { error: `Failed to load board: ${(err as Error).message}` } });
        }
      }

      case "press_button": {
        // BLOCKING — model waits for navigation result
        const label = extractStringArg(args, "label").trim();
        if (!state?.loadedBoardData) {
          return ({ id: call.id, name, response: { error: "No custom board loaded" } });
        }

        const currentPage = state.loadedBoardData.pages?.find((p: any) => p.id === state.currentPageId)
          || state.loadedBoardData.pages?.[0];
        if (!currentPage?.buttons) {
          return ({ id: call.id, name, response: { error: "Current page has no buttons" } });
        }

        const btn = currentPage.buttons.find((b: any) =>
          b.label.toLowerCase().trim() === label.toLowerCase().trim()
        );
        if (!btn?.action) {
          return ({ id: call.id, name, response: { error: `Button "${label}" not found or has no action` } });
        }

        const navResult = this.executeButtonNavigation(btn, state);
        this.turnAccum.pressButtonLabel = label;
        this.turnAccum.boardChanged = true;

        return ({
          id: call.id,
          name,
          response: navResult,
        });
      }

      case "emote": {
        const emotion = extractStringArg(args, "emotion", "neutral");
        if (state) {
          state.currentEmote = emotion as any;
        }
        this.send({ type: "emote", data: emotion });
        this.turnAccum.emote = emotion as any;
        return ({
          id: call.id,
          name,
          response: { output: "ok" },
        });
      }

      case "play_video": {
        const query = extractStringArg(args, "query");
        this.turnAccum.openAppData = { appId: "youtube", data: query };
        return ({
          id: call.id,
          name,
          response: { output: "ok", note: "Video search will execute after turn completes" },
        });
      }

      case "open_app": {
        const appId = extractStringArg(args, "app_id");
        const data = args.data as string | undefined;
        this.turnAccum.openAppData = { appId, data };
        // For youtube, defer to processTurnEnd; for others, send immediately
        if (appId !== "youtube") {
          this.send({ type: "app_open", data: { appId, data } });
        }
        return ({
          id: call.id,
          name,
          response: { output: "ok" },
        });
      }

      case "close_app": {
        this.turnAccum.closeApp = true;
        this.send({ type: "app_close", data: {} });
        return ({
          id: call.id,
          name,
          response: { output: "ok" },
        });
      }

      case "learn_face": {
        const faceName = args.name as string || "";
        const relationship = args.relationship as string | undefined;
        const description = args.description as string | undefined;
        this.turnAccum.learnFaceData = { name: faceName, relationship, description };
        return ({
          id: call.id,
          name,
          response: { output: "ok", note: "Face enrollment will process after turn completes" },
        });
      }

      case "call_monitor": {
        const reason = args.reason as string || "unspecified";
        this.turnAccum.callMonitorReason = reason;
        return ({
          id: call.id,
          name,
          response: { output: "ok" },
        });
      }

      case "yes_no": {
        this.send({ type: "yes_no", data: {} });
        return ({
          id: call.id,
          name,
          response: { output: "ok" },
        });
      }

      case "ask_yes_no": {
        this.send({ type: "ask_yes_no", data: {} });
        return ({
          id: call.id,
          name,
          response: { output: "ok" },
        });
      }

      case "request_focus": {
        const reason = args.reason as string || "";
        this.turnAccum.focusReason = reason;
        this.send({ type: "focus_request", data: { reason } });
        return ({
          id: call.id,
          name,
          response: { output: "ok" },
        });
      }

      default:
        console.warn(`[LiveRelay] Unknown tool call: ${name}`);
        return ({
          id: call.id,
          name,
          response: { error: `Unknown tool: ${name}` },
        });
    }
  }

  /**
   * Execute a navigation button press on a custom board.
   * Returns the result to include in the ToolResponse.
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

    return { error: `Unknown action type: ${action.type}` };
  }

  /**
   * Handle turn completion from the provider.
   * Do post-turn processing using accumulated tool call / text token data.
   */
  private async handleProviderTurnComplete(): Promise<void> {
    const seq = ++this.seqCounter;
    logLiveSession(`RELAY #${seq} handleProviderTurnComplete`, `turnProcessingBusy=${this.turnProcessingBusy} turnStartTime=${this.turnStartTime} consecutiveModelTurns=${this.consecutiveModelTurns} accum=[speak=${!!this.turnAccum.speakText}, interpret=${!!this.turnAccum.interpretText}, board=${this.turnAccum.boardChanged}]`);

    if (this.turnProcessingBusy) {
      logLiveSession(`RELAY #${seq} SKIPPED`, `already processing`);
      console.warn("[LiveRelay] handleProviderTurnComplete called while already processing — skipping");
      return;
    }

    // Skip empty turns — native audio models generate audio-only turns between
    // tool calls. Only process turns that had actual tool calls or text content.
    if (this.turnStartTime === 0) {
      // turnStartTime is set when the first tool call or text arrives.
      // If it's still 0, this was an audio-only turn with no tool calls — skip it.
      this.awaitingModelResponse = false;
      logLiveSession(`RELAY #${seq} SKIPPED`, `empty turn (no tool calls or text)`);
      return;
    }

    this.turnProcessingBusy = true;

    try {
      const turnEndPromise = this.processTurnEnd();
      const timeoutPromise = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("processTurnEnd timed out after 60s")), 60_000)
      );
      await Promise.race([turnEndPromise, timeoutPromise]);
    } catch (err) {
      console.error("[LiveRelay] handleProviderTurnComplete error:", (err as Error).message);
      this.send({ type: "error", data: "error:TURN_FAILED" });
    } finally {
      // Inject model-role turn summary BEFORE resetting accumulator.
      // Native audio models discard their audio output (we use ElevenLabs TTS),
      // so without this text record the model has no memory of what it said/did
      // and tends to repeat the same tool calls on the next turn.
      const summary = this.buildTurnSummary(this.turnAccum);
      if (summary && this.provider) {
        this.provider.sendMessage(summary, "model", false);
        logLiveSession(`RELAY #${seq} TURN SUMMARY`, summary);
      }

      this.turnAccum = createEmptyAccumulator();
      this.turnStartTime = 0;
      this.turnProcessingBusy = false;
      this.lastTurnCompleteAt = Date.now();
      this.consecutiveModelTurns++;
      logLiveSession(`RELAY #${seq} turnComplete DONE`, `consecutiveModelTurns now=${this.consecutiveModelTurns}`);
    }
  }

  /**
   * Handle interruption (model was cut off by new input).
   */
  private handleProviderInterrupted(): void {
    this.send({ type: "audio_interrupt" });
    this.turnAccum = createEmptyAccumulator();
    this.turnStartTime = 0;
    this.awaitingModelResponse = false;
    console.log("[LiveRelay] Model interrupted by new input");
  }

  /**
   * Post-turn processing: record state, TTS, app commands, contact enrollment, monitor triggering.
   * Uses accumulated tool call data from turnAccum.
   */
  private async processTurnEnd(): Promise<void> {
    const isSilent = this.interactionMode === "silent";
    const state = this.sessionCache?.state;
    const accum = this.turnAccum;

    const fullSpeakText = accum.speakText.trim();
    const fullInterpretText = accum.interpretText.trim();
    const fullContextText = accum.contextText.trim();
    const fullTranscriptText = accum.transcriptText.trim();
    const callMonitorReason = accum.callMonitorReason || undefined;
    const learnFaceData = accum.learnFaceData || undefined;
    const openAppData = accum.openAppData || undefined;
    const closeAppTriggered = accum.closeApp;
    const focusReason = accum.focusReason || undefined;

    const boardRebuilt = accum.boardRebuilt;
    const boardAddLabels = accum.boardAddLabels;
    const boardRemoveLabels = accum.boardRemoveLabels;
    const boardAddCount = boardAddLabels.length;
    const boardRemoveCount = boardRemoveLabels.length;

    const elapsed = this.turnStartTime > 0 ? Date.now() - this.turnStartTime : 0;
    const hasBoardChange = accum.boardChanged;

    // -----------------------------------------------------------------------
    // Response dedup: detect if AI is repeating the same speech as last turn
    // -----------------------------------------------------------------------
    let speechSuppressed = false;
    const nowDedup = Date.now();
    if (
      fullSpeakText &&
      this.lastAiSpeak &&
      this.lastAiSpeak.text === fullSpeakText &&
      nowDedup - this.lastAiSpeak.timestamp < LiveRelay.RESPONSE_DEDUP_WINDOW_MS
    ) {
      speechSuppressed = true;
    }
    if (fullSpeakText) {
      this.lastAiSpeak = { text: fullSpeakText, timestamp: nowDedup };
    }

    // -----------------------------------------------------------------------
    // Comprehensive debug logging (matching HTTP mode verbosity)
    // -----------------------------------------------------------------------
    logDualAgent("LiveRelay.turnComplete", {
      sessionId: this.sessionId,
      elapsed: `${elapsed}ms`,
      toolCalls: [
        fullSpeakText && "speak",
        fullInterpretText && "interpret",
        fullTranscriptText && "transcript",
        fullContextText && "context",
        hasBoardChange && "board",
        callMonitorReason && "call_monitor",
        learnFaceData && "learn_face",
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
      learnFace: learnFaceData?.name || false,
      setBoard: accum.setBoardName || false,
      pressButton: accum.pressButtonLabel || false,
      openApp: openAppData?.appId || false,
      closeApp: closeAppTriggered,
      speechSuppressed,
    });

    // If speech is a repeat, skip state recording + TTS for speak/interpret/transcript
    // (context + board changes still go through — those can legitimately repeat)
    if (speechSuppressed) {
      // Collect messages to persist in a single batch
      const suppressedMsgs: import("./types").PendingMessage[] = [];

      // Still record context if new
      if (fullContextText) {
        suppressedMsgs.push({
          role: "assistant",
          content: `[CONTEXT] ${fullContextText}`,
          timestamp: nowDedup,
        });
      }
      // Still record board changes
      if (hasBoardChange) {
        const boardSuffix = boardRebuilt
          ? `Board rebuilt: ${boardAddLabels.join(", ")}`
          : [
              boardAddCount > 0 ? `Added: ${boardAddLabels.join(", ")}` : "",
              boardRemoveCount > 0 ? `Removed: ${boardRemoveLabels.join(", ")}` : "",
            ].filter(Boolean).join(". ");
        suppressedMsgs.push({
          role: "assistant",
          content: `[SYSTEM — Board changes: ${boardSuffix}]`,
          timestamp: nowDedup,
        });
      }

      // Persist batch to DB
      if (this.sessionId && suppressedMsgs.length > 0) {
        dualAgentService.addPendingMessages(this.sessionId, suppressedMsgs)
          .catch(err => console.error("[LiveRelay] Failed to persist suppressed messages:", err));
      }

      // Skip to monitor triggering (no TTS, no duplicate state entries)
      // Signal turn complete to client
      this.send({ type: "complete", data: {} });

      // Still trigger monitor
      if (this.sessionId) {
        try {
          await dualAgentService.triggerMonitor(this.sessionId, false, state?.currentBoard);
        } catch (err) {
          console.error("[LiveRelay] Monitor trigger failed:", err);
        }
      }
      return;
    }

    // -----------------------------------------------------------------------
    // Record AI response in session state (so monitor has context) — batch persist
    // -----------------------------------------------------------------------
    if (state) {
      const now = Date.now();
      state.lastInteractiveActivity = now;

      // Collect all turn messages into a batch for single DB write
      const turnMessages: import("./types").PendingMessage[] = [];

      // Record AI interpretation FIRST (button press → interpretation → response)
      if (fullInterpretText) {
        turnMessages.push({
          role: "assistant",
          content: `[INTERPRET] ${fullInterpretText}`,
          timestamp: now,
        });
      }

      // Record AI speech as pending message for monitor
      if (fullSpeakText) {
        turnMessages.push({
          role: "assistant",
          content: fullSpeakText,
          timestamp: now + 1, // +1ms to ensure correct ordering after interpret
        });
      }

      // Record context observations
      if (fullContextText) {
        turnMessages.push({
          role: "assistant",
          content: `[CONTEXT] ${fullContextText}`,
          timestamp: now,
        });
      }

      // Record transcripts as user messages
      if (fullTranscriptText) {
        turnMessages.push({
          role: "user",
          content: `[TRANSCRIPT] ${fullTranscriptText}`,
          timestamp: now,
        });
      }

      // Record [CALL_MONITOR] reason so monitor sees why it was called
      if (callMonitorReason) {
        turnMessages.push({
          role: "assistant",
          content: `[CALL_MONITOR] ${callMonitorReason}`,
          timestamp: now,
        });
      }

      // Record board changes as system message (matching HTTP mode behavior)
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
          timestamp: now,
        });
      }

      // Persist entire batch to DB in one call
      if (this.sessionId && turnMessages.length > 0) {
        dualAgentService.addPendingMessages(this.sessionId, turnMessages)
          .catch(err => console.error("[LiveRelay] Failed to persist turn messages:", err));
      }
    }

    // -----------------------------------------------------------------------
    // App open/close (YouTube search is deferred to here for async)
    // -----------------------------------------------------------------------
    if (openAppData) {
      if (openAppData.appId === "youtube" && openAppData.data) {
        try {
          const results = await searchYouTube(openAppData.data);
          this.send({ type: "video_play", data: { query: openAppData.data, results } });
        } catch (err) {
          console.error("[LiveRelay] YouTube search failed:", err);
        }
      }
      // Non-youtube apps are sent immediately in handleSingleToolCall
    }
    // close_app is sent immediately in handleSingleToolCall

    // -----------------------------------------------------------------------
    // Contact enrollment via [LEARN_FACE]
    // -----------------------------------------------------------------------
    if (learnFaceData && this.unknownFaceDescriptors.length > 0 && this.studentId) {
      try {
        const descriptor = this.unknownFaceDescriptors[0].descriptor;
        const existing = await findSimilarContact(this.studentId, descriptor);
        if (!existing) {
          await createContact({
            studentId: this.studentId,
            name: learnFaceData.name,
            relationship: learnFaceData.relationship || null,
            description: learnFaceData.description || null,
            faceEmbedding: descriptor,
          });
          console.log(`[LiveRelay] Created new contact: ${learnFaceData.name}`);
        } else {
          await updateContact(existing.id, {
            contextNotes: learnFaceData.description || existing.contextNotes,
            lastSeenAt: new Date(),
            timesIdentified: (existing.timesIdentified || 0) + 1,
          });
          console.log(`[LiveRelay] Updated existing contact: ${existing.name}`);
        }
        // Clear descriptors after enrollment
        this.unknownFaceDescriptors = [];
      } catch (err) {
        console.error("[LiveRelay] Contact enrollment failed:", err);
      }
    }

    // -----------------------------------------------------------------------
    // TTS: student voice first (interpretation), then AI voice
    // Each TTS stream has a 15s timeout to prevent infinite hangs.
    // -----------------------------------------------------------------------
    if (fullInterpretText && this.studentVoice) {
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

    if (fullSpeakText && !isSilent && this.aiVoice) {
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
    // Focus frame request — ask client for a high-res image
    // -----------------------------------------------------------------------
    if (focusReason) {
      this.send({ type: "focus_request", data: { reason: focusReason } });
      console.log("[LiveRelay] Focus frame requested:", focusReason);
    }

    // -----------------------------------------------------------------------
    // Monitor triggering (using proper service method with full session cache)
    // -----------------------------------------------------------------------
    // Always attempt monitor trigger after turn completion (throttled to 2-min by service)
    if (this.sessionId) {
      try {
        await dualAgentService.triggerMonitor(
          this.sessionId,
          !!callMonitorReason, // force if [CALL_MONITOR] was used
          state?.currentBoard,
        );
      } catch (err) {
        console.error("[LiveRelay] Monitor trigger failed:", err);
        this.send({ type: "monitor_status", data: { error: (err as Error).message } });
      }
    }

    // Signal turn complete to client
    this.send({ type: "complete", data: {} });
  }

  // -------------------------------------------------------------------------
  // Usage tracking
  // -------------------------------------------------------------------------

  private handleUsage(usage: { promptTokens: number; completionTokens: number }): void {
    if (this.debugMode) {
      this.send({ type: "debug", data: { usage } });
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private send(msg: ServerMessage): void {
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
      }
    } catch (err) {
      console.error("[LiveRelay] send() failed:", (err as Error).message, "msgType:", msg.type);
    }
  }

  /** Check if a voice should use client-side ElevenLabs TTS */
  private isClientTts(voice: ResolvedVoice): boolean {
    return !!(voice.elevenlabsApiKey && voice.elevenlabsVoiceId);
  }

  /**
   * Stream TTS with a timeout guard. Prevents infinite hangs if the TTS
   * service stalls (e.g. network issue, API timeout).
   * If the voice is client-side ElevenLabs, sends a lightweight client_tts
   * message so the browser can call ElevenLabs directly.
   */
  private async streamTtsWithTimeout(
    text: string,
    voice: ResolvedVoice,
    msgType: "avatar_audio" | "interpretation_audio",
    label: string,
    timeoutMs = 15_000,
  ): Promise<void> {
    // Client-side TTS: send config to browser instead of synthesizing server-side
    if (this.isClientTts(voice)) {
      const voiceRole = msgType === "avatar_audio" ? "ai" as const : "student" as const;
      this.send({
        type: "client_tts",
        data: {
          text,
          voiceId: voice.elevenlabsVoiceId!,
          apiKey: voice.elevenlabsApiKey!,
          language: voice.language || "en",
          voiceRole,
        },
      });
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} TTS timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
      const streamPromise = (async () => {
        for await (const chunk of ttsFacade.synthesizeStream(text, voice)) {
          this.send({ type: msgType, data: chunk.toString("base64") } as any);
        }
      })();
      await Promise.race([streamPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private buildBoardFromButtons(buttons: Array<{ label: string; iconRef: string; symbolPath?: string }>): any {
    const pageId = `page-${Date.now()}`;
    const cols = 4;
    const rows = Math.max(3, Math.ceil(buttons.length / cols));

    return {
      grid: { rows, cols },
      pages: [{
        id: pageId,
        name: "Main",
        buttons: buttons.map((b, i) => ({
          id: `btn-${Date.now()}-${i}`,
          label: b.label,
          spokenText: b.label,
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

  // -------------------------------------------------------------------------
  // Periodic board state reminders
  // -------------------------------------------------------------------------

  /**
   * Start ping/pong health check for the client WebSocket.
   * If pong is not received within one interval, the connection is dead — terminate.
   */
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

  private startBoardReminder(): void {
    this.stopBoardReminder();
    this.lastBoardUpdateTime = Date.now();
    this.boardReminderTimer = setInterval(() => {
      this.sendBoardStateReminder();
    }, LiveRelay.BOARD_REMINDER_INTERVAL_MS);
  }

  private stopBoardReminder(): void {
    if (this.boardReminderTimer) {
      clearInterval(this.boardReminderTimer);
      this.boardReminderTimer = null;
    }
  }

  /**
   * Inject session context after a reconnection so the model doesn't start over.
   * Sends current board state, recent conversation, and a continuation instruction.
   * Uses turnComplete=false (via sendContextInjection) so it doesn't trigger a response.
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

    // Current interaction mode
    parts.push(`Interaction mode: ${this.interactionMode}`);

    // Current emote
    if (state.currentEmote) {
      parts.push(`Current emotion: ${state.currentEmote}`);
    }

    // Recent conversation from pending messages (last 20), filtering out safety-excluded messages
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

    // Re-inject behavioral rules immediately after reconnection to prevent drift
    const behavioralReminder = this.buildBehavioralReminder();
    if (behavioralReminder) {
      this.provider!.sendContextInjection(behavioralReminder);
      logDualAgent("LiveRelay.behavioralReminder", { sessionId: this.sessionId, trigger: "reconnect" });
    }
  }

  /**
   * Send a periodic board state context injection so Gemini stays aware
   * of current buttons and available slots. Only fires if the board
   * hasn't been updated recently (otherwise the per-change injections suffice).
   * These are NOT added to pendingMessages (per design).
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
      this.provider!.sendContextInjection(
        `[BOARD STATE REMINDER] Current buttons (${labels.length}/${maxSlots}, ${available} slots available): ${labels.join(", ") || "none"}`,
      );
    }
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
  // Periodic behavioral reminders (prevent prompt drift in long sessions)
  // -------------------------------------------------------------------------

  private startBehavioralReminder(): void {
    this.stopBehavioralReminder();
    this.behavioralReminderTimer = setInterval(() => {
      const reminder = this.buildBehavioralReminder();
      if (reminder) {
        this.provider!.sendContextInjection(reminder);
        logDualAgent("LiveRelay.behavioralReminder", { sessionId: this.sessionId, trigger: "periodic" });
      }
    }, LiveRelay.BEHAVIORAL_REMINDER_INTERVAL_MS);
  }

  private stopBehavioralReminder(): void {
    if (this.behavioralReminderTimer) {
      clearInterval(this.behavioralReminderTimer);
      this.behavioralReminderTimer = null;
    }
  }

  /**
   * Build a compact model-role summary of what the model did during this turn.
   * Injected via sendClientContent(role="model", turnComplete=false) after each turn
   * so the model remembers its own actions. Native audio models discard their audio
   * output (we use external TTS), so without this the model has no text record of
   * what it said/did and tends to repeat itself on the next turn.
   */
  private buildTurnSummary(accum: TurnToolAccumulator): string | null {
    const parts: string[] = [];
    if (accum.interpretText.trim()) {
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
      parts.push(`speak("${accum.speakText.trim()}")`);
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
   * Re-injects the most critical rules that tend to drift during long sessions.
   */
  private buildBehavioralReminder(): string | null {
    const state = this.sessionCache?.state;
    if (!state) return null;

    const level = state.interpretationLevel ?? 1;
    const isSilent = this.interactionMode === "silent";

    // Tool references
    const iRef = "interpret()";
    const sRef = "speak()";
    const abRef = "add_buttons()";
    const rbRef = "remove_buttons()";
    const sbRef = "set_board()";

    // Interpretation level rules — the most critical source of drift
    let interpretRule: string;
    switch (level) {
      case 0:
        interpretRule = `Interpretation Level: 0 (Off)\n- Do NOT use ${iRef}. Button text is spoken directly by the system.`;
        break;
      case 1:
        interpretRule = `Interpretation Level: 1 (Minimal)\n- ONLY use ${iRef} immediately after [BUTTON PRESS]. Never from gestures, gaze, or context alone.\n- Expand button labels into short natural phrases.`;
        break;
      case 2:
        interpretRule = `Interpretation Level: 2 (Moderate)\n- Use ${iRef} from button presses, clear gestures, or strong contextual cues.\n- Do NOT interpret weak or ambiguous signals — add a button instead.`;
        break;
      case 3:
        interpretRule = `Interpretation Level: 3 (Active)\n- Use ${iRef} for button presses, gestures, gaze patterns, and contextual cues.\n- Prefer interpreting over silence — the user benefits from having intent voiced.`;
        break;
      case 4:
        interpretRule = `Interpretation Level: 4 (Autonomous)\n- You are the user's voice. Actively interpret and speak for them.\n- Respond to questions on the user's behalf when possible.`;
        break;
      default:
        interpretRule = `Interpretation Level: ${level}`;
    }

    const parts: string[] = [
      `[BEHAVIORAL REMINDER]`,
      interpretRule,
    ];

    // Confidence requirement
    if (level > 0 && level < 4) {
      parts.push(`Confidence: Always include confidence (high/medium/low) on ${iRef}. Only use ${sRef} or ${iRef} with HIGH CONFIDENCE from visual/audio input alone.`);
    }

    // Visual check conservatism
    parts.push("Visual checks: Stay silent if nothing important changed. Only report meaningful context changes.");

    // Mode
    if (isSilent) {
      parts.push(`Mode: silent — You are INVISIBLE. NEVER use ${sRef}. Only use board tools.`);
    } else {
      parts.push(`Mode: interact — AI voice active.`);
    }

    // Echo awareness (always critical for live sessions)
    parts.push(`Echo: Speech you hear shortly after your own ${sRef} or ${iRef} output is YOUR echo — ignore it completely. Do NOT transcribe or respond to it.`);

    // Board limit
    const maxSlots = state.maxBoardItems || 12;
    parts.push(`Board limit: ${maxSlots} buttons max. Use ${rbRef} before ${abRef} if near the limit.`);

    // Custom boards reminder
    if (state.availableBoards && state.availableBoards.length > 0 && !state.loadedBoardId) {
      const boardKeys = state.availableBoards.map(b => {
        const hint = b.hint ? ` (${b.hint})` : '';
        return `${b.key}${hint}`;
      }).join(", ");
      parts.push(`Custom boards available: ${boardKeys}. Use ${sbRef} silently when the context matches a board's purpose — do NOT announce board switches with ${sRef}.`);
    }

    return parts.join("\n");
  }

  /**
   * Force a completely new session when reconnection keeps failing
   * (e.g. repeated safety/unsafe prompt errors).
   */
  private async forceNewSession(): Promise<void> {
    if (!this.studentId || !this.sessionId) return;

    // Close the current Gemini session (prevents auto-reconnect)
    this.provider?.close();

    // Re-initialize from scratch
    try {
      await this.handleInitialize({
        type: "initialize",
        studentId: this.studentId,
        userId: this.userId,
        interactionMode: this.interactionMode,
        responseMode: this.responseMode,
        debugMode: this.debugMode,
      });
      // Notify client of the new session
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
   * Handle a safety/policy block from Gemini. Progressively excludes recent
   * messages from reconnection context to break the safety-retrigger loop.
   * Messages stay in DB/memory for monitor visibility — only excluded from Gemini.
   */
  private handleSafetyBlock(): void {
    this.consecutiveSafetyBlocks++;
    const level = this.consecutiveSafetyBlocks;

    const state = this.sessionCache?.state;
    if (state) {
      const msgs = state.pendingMessages;
      const excludeCount = level === 1 ? 3 : level === 2 ? 10 : msgs.length;
      // Mark most recent N non-excluded messages
      let marked = 0;
      for (let i = msgs.length - 1; i >= 0 && marked < excludeCount; i--) {
        if (!msgs[i].safetyExcluded) {
          msgs[i].safetyExcluded = true;
          marked++;
        }
      }
      // Record safety block in conversation log
      dualAgentService.addPendingMessage(this.sessionId!, {
        role: "system",
        content: `[SAFETY BLOCK] A response was blocked by the content safety filter (attempt ${level}). ${marked} messages excluded from AI context.`,
        timestamp: Date.now(),
      }).catch(err => console.error("[LiveRelay] Failed to persist safety block:", err));
    }

    // Notify client
    this.send({ type: "safety_blocked", data: "error:SAFETY_BLOCKED" });

    logDualAgent("LiveRelay.safetyBlock", {
      sessionId: this.sessionId,
      level,
      lastCloseCode: this.provider?.lastCloseCode,
    });
  }

  private cleanup(): void {
    // Stop timers
    this.stopPingTimer();
    this.stopBoardReminder();
    this.stopBehavioralReminder();

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
    logDualAgent("LiveRelay.cleanup", { sessionId: this.sessionId });
  }

  /**
   * Handle session close: add a close marker and force-trigger the monitor
   * for a final summary of the session.
   * Skipped when notes are disabled (no memory stored outside message logs).
   */
  private async handleSessionClose(): Promise<void> {
    if (!this.sessionId) return;

    // Skip final summary when notes are disabled — no memory to write
    if (this.sessionCache?.state.privacyOptions?.allowNotes === false) {
      logDualAgent("LiveRelay.handleSessionClose.skipped", { sessionId: this.sessionId, reason: "allowNotes=false" });
      return;
    }

    await dualAgentService.addPendingMessage(this.sessionId, {
      role: "user",
      content: "[SESSION_CLOSED] The AAC session has ended. Perform a final summary of the session.",
      timestamp: Date.now(),
    });

    // Force trigger (bypass throttle). If monitor is busy, rerun flag handles it.
    await dualAgentService.triggerMonitor(this.sessionId, true);
  }
}

// ---------------------------------------------------------------------------
// WebSocket Server Setup — called from routes.ts
// ---------------------------------------------------------------------------

export function setupLiveWebSocket(server: import("http").Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);

    // Only handle /ws/live path
    if (url.pathname !== "/ws/live") return;

    wss.handleUpgrade(req, socket as any, head as any, (ws) => {
      console.log("[LiveRelay] New WebSocket connection");
      new LiveRelay(ws);
    });
  });

  console.log("[LiveRelay] WebSocket server ready on /ws/live");
}
