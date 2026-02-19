// server/services/dual-agent/live-relay.ts
// WebSocket relay layer: bridges a client WebSocket to a Gemini Live session.
// Handles prefix token parsing, TTS synthesis, contact enrollment, monitor triggering.

import type { IncomingMessage } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { GeminiLiveSession, type LiveSessionConfig } from "./live-session";
import {
  StreamingPrefixParser,
  parseStreamedText,
  parseBoardButtons,
  type StreamingSegment,
} from "./interactive-agent";
import type {
  AACInteractionMode,
  AACResponseMode,
  DualAgentSessionState,
} from "./types";
import { ttsFacade, type ResolvedVoice } from "../voice/tts-facade";
import { searchYouTube } from "../youtube/youtube-search";
import { createContact, findSimilarContact, updateContact, getContactsByStudent } from "../biometric";
import { logDualAgent } from "./dual-agent-logger";

// Re-use the existing dual-agent service for session management (monitor, voices, state)
import { dualAgentService, type SessionCache } from "./dual-agent-service";
import { boardRepository } from "../../repositories/boardRepository";

// ---------------------------------------------------------------------------
// Client ↔ Server Protocol
// ---------------------------------------------------------------------------

/** Messages from client → server */
export type ClientMessage =
  | { type: "initialize"; studentId: string; userId?: string; sessionId?: string; interactionMode?: AACInteractionMode; responseMode?: AACResponseMode; debugMode?: boolean }
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
  | { type: "app_dismissed"; appId: string };

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
  | { type: "reconnected" }                              // Reconnection successful
  | { type: "session_reset"; sessionId: string }         // New session created after repeated failures
  | { type: "complete"; data?: any };

// ---------------------------------------------------------------------------
// LiveRelay — one instance per client WebSocket connection
// ---------------------------------------------------------------------------

export class LiveRelay {
  private ws: WebSocket;
  private gemini: GeminiLiveSession;
  private parser: StreamingPrefixParser;

  // Session state
  private studentId: string | null = null;
  private sessionId: string | null = null;
  private sessionCache: SessionCache | null = null;
  private interactionMode: AACInteractionMode = "interact";
  private responseMode: AACResponseMode = "fast";
  private debugMode = false;

  // Voice config (resolved once during init)
  private aiVoice: ResolvedVoice | null = null;
  private studentVoice: ResolvedVoice | null = null;

  // For contact enrollment
  private unknownFaceDescriptors: Array<{ descriptor: number[]; boundingBox?: { x: number; y: number; w: number; h: number } }> = [];

  // Board state reminder: periodically remind Gemini of current board state
  private boardReminderTimer: ReturnType<typeof setInterval> | null = null;
  private lastBoardUpdateTime = 0;
  private static readonly BOARD_REMINDER_INTERVAL_MS = 45_000; // 45s

  // Dedup guard: track last user message to prevent rapid duplicates
  private lastUserMessage: { text: string; timestamp: number } | null = null;
  private static readonly DEDUP_WINDOW_MS = 2000;

  // Response dedup: suppress identical AI speech within a short window
  private lastAiSpeak: { text: string; timestamp: number } | null = null;
  private static readonly RESPONSE_DEDUP_WINDOW_MS = 5000;

  // User message priority: suppress frame_grids briefly after user messages
  // so Gemini processes the user message without visual check interference
  private userMessageSentAt = 0;
  private static readonly USER_MSG_PRIORITY_MS = 3000;

  // Reconnection tracking
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_BEFORE_RESET = 2;

  // Accumulation for turn processing
  private turnTextBuffer = "";
  private turnSegments: StreamingSegment[] = [];
  private turnStartTime = 0;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.parser = new StreamingPrefixParser();

    // Set up Gemini Live session with callbacks
    this.gemini = new GeminiLiveSession({
      onText: (text) => this.handleGeminiText(text),
      onTurnComplete: () => this.handleGeminiTurnComplete(),
      onInterrupted: () => this.handleGeminiInterrupted(),
      onUsage: (usage) => this.handleUsage(usage),
      onGoAway: () => {
        console.log("[LiveRelay] Gemini session goAway — reconnecting");
      },
      onReady: () => {
        console.log("[LiveRelay] Gemini session ready");
        // Reset reconnect counter on successful connection
        this.reconnectAttempts = 0;
        this.send({ type: "reconnected" });
      },
      onReconnecting: () => {
        this.reconnectAttempts++;
        console.log(`[LiveRelay] Reconnecting (attempt ${this.reconnectAttempts})...`);
        this.send({ type: "reconnecting", data: "Reconnecting..." });

        // If too many reconnect attempts (e.g. repeated safety errors), force new session
        if (this.reconnectAttempts >= LiveRelay.MAX_RECONNECT_BEFORE_RESET && this.sessionId) {
          console.log("[LiveRelay] Too many reconnect attempts — creating new session");
          this.forceNewSession().catch(err => {
            console.error("[LiveRelay] Force new session failed:", err);
          });
        }
      },
      onError: (error) => {
        console.error("[LiveRelay] Gemini error:", error.message);
        this.send({ type: "error", data: error.message });
      },
      onClose: (code, reason) => {
        console.log(`[LiveRelay] Gemini session closed: code=${code} reason=${reason}`);
        // Forward non-normal closes to client so they see specific error feedback
        if (code && code !== 1000) {
          const msg = reason || `Connection closed (code ${code})`;
          this.send({ type: "error", data: msg });
        }
      },
      // onInputTranscription intentionally omitted — the model's own [TRANSCRIPT]
      // tokens are the canonical transcript source (with speaker labels).
      // Gemini's built-in inputTranscription fires for ALL audio including echoed
      // TTS, which caused duplicate/noisy transcripts in the session log.
      onReconnectFailed: async () => {
        // Resumption handle was stale — reload history from DB and prime the fresh session
        if (!this.sessionId) return;
        console.log("[LiveRelay] Reconnect failed — reloading history from DB");
        try {
          const turns = await dualAgentService.loadHistoryForReconnect(this.sessionId);
          if (turns.length > 0) {
            this.gemini.sendConversationHistory(turns);
            console.log(`[LiveRelay] Sent ${turns.length} history turns to fresh Gemini session`);
          }
        } catch (err) {
          console.error("[LiveRelay] History reload failed:", err);
        }
      },
    });

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
          // Suppress frame_grids briefly after user messages to prevent visual checks
          // from interfering with Gemini's response to the user message
          const frameSendTime = Date.now();
          if (frameSendTime - this.userMessageSentAt < LiveRelay.USER_MSG_PRIORITY_MS) {
            break; // Silently skip — activity monitor will retrigger naturally
          }
          // Send frame grid as image with detection prompt — triggers model response
          this.gemini.sendFrameWithPrompt(
            msg.data,
            `[VISUAL CHECK] Composite frame grid (${msg.timestamps?.length ?? '?'} frames). Observe the scene. Use [CONTEXT] to record any changes in the environment. Use [ADD_BUTTONS]/[REMOVE_BUTTONS] to keep the board relevant. Speak or interpret only with HIGH CONFIDENCE. Stay silent if nothing important changed.`,
          );
          break;
        }

        case "pcm_audio":
          // Raw PCM Int16 16kHz — stream directly to Gemini (no transcription needed)
          this.gemini.sendAudio(msg.data);
          break;

        case "audio_clip":
          // No-op: Gemini already hears audio via continuous PCM streaming
          break;

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

          // Record user message in session state for monitor context + persist to DB
          if (this.sessionId) {
            dualAgentService.addPendingMessage(this.sessionId, {
              role: "user",
              content: msg.text,
              timestamp: now,
            }).catch(err => console.error("[LiveRelay] Failed to persist user message:", err));
          }
          this.gemini.sendMessage(msg.text, "user");
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
          this.handleInterpretButtons(msg.buttons, msg.board);
          break;

        case "gesture_context":
          // Inject gesture context as system context
          this.gemini.sendContextInjection(`[GESTURE CONTEXT]\n${msg.data}`);
          break;

        case "person_context":
          this.gemini.sendContextInjection(`[PERSON IDENTIFIED]\n${JSON.stringify(msg.data)}`);
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
          this.gemini.sendContextInjection(`[CURRENT BOARD STATE]\n${JSON.stringify(msg.data)}`);
          break;
        }

        case "set_mode":
          this.interactionMode = msg.mode;
          this.gemini.sendContextInjection(`[MODE CHANGE] Interaction mode changed to: ${msg.mode}`);
          break;

        case "set_response_mode":
          this.responseMode = msg.mode;
          break;

        case "unknown_face_descriptors":
          this.unknownFaceDescriptors = msg.data;
          break;

        case "page_navigate":
          this.gemini.sendContextInjection(
            `[PAGE NAVIGATE] User navigated to page "${msg.pageName}". Current buttons: ${msg.buttons.join(", ")}`,
          );
          // Update session state
          if (this.sessionCache?.state) {
            this.sessionCache.state.currentPageId = msg.pageId;
          }
          break;

        case "app_dismissed":
          this.gemini.sendContextInjection(
            `[APP CLOSED] The user closed the "${msg.appId}" app and returned to the AAC board.`,
          );
          logDualAgent("LiveRelay.appDismissed", { sessionId: this.sessionId, appId: msg.appId });
          break;
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[LiveRelay] Error handling ${msg.type}:`, error.message);
      this.send({ type: "error", data: error.message });
    }
  }

  // -------------------------------------------------------------------------
  // Initialize
  // -------------------------------------------------------------------------

  private async handleInitialize(msg: Extract<ClientMessage, { type: "initialize" }>): Promise<void> {
    this.studentId = msg.studentId;
    this.interactionMode = msg.interactionMode || "interact";
    this.responseMode = msg.responseMode || "fast";
    this.debugMode = msg.debugMode || false;

    try {
      // Use existing dual-agent service to get/create session + resolve prompt + voices
      const state = await dualAgentService.initializeSession(
        msg.studentId,
        msg.userId,
        msg.sessionId,
        this.interactionMode,
        true, // isLiveMode — unified prompt with contextual rules for different input types
      );
      this.sessionId = state.sessionId;

      // Get session cache (contains state, agents, mutex)
      const cached = dualAgentService.getSessionCache(state.sessionId);
      if (!cached) {
        throw new Error("Session cache not found after initialization");
      }
      this.sessionCache = cached;

      // Register context injection callback — when monitor injects [CONTEXT],
      // forward it to the Gemini Live session so the model sees it immediately
      cached.state.onContextInjection = (text: string) => {
        console.log("[LiveRelay] Monitor context injection →", text.substring(0, 80));
        this.gemini.sendContextInjection(`[Monitor Context]\n${text}`);
        this.send({ type: "context", data: `[Monitor] ${text}` });
      };

      // Get the system prompt from the session state, with Live API audio echo warning
      const systemPrompt = state.interactivePrompt + `\n\n` +
`CRITICAL — AUDIO ECHO AWARENESS:
You receive continuous microphone audio. Because your text responses are converted to speech (TTS) and played through speakers near the microphone, you WILL hear echoes of your own output in the audio stream shortly after you generate it.
- Your [INTERPRET] text (if present) is spoken aloud in one voice (student voice)
- Your [SPEAK] text (if present) is spoken aloud in a different voice (AI voice)
INTERPRET text comes before the SPEAK text, so the student voice is always heard before the AI voice.
Both play through speakers and are picked up by the microphone within seconds.

You MUST:
- Recognize BOTH of these echoes as YOUR OWN output, not new user speech
- NEVER transcribe your own echoed speech as [TRANSCRIPT]
- NEVER respond to or build upon your own echoed speech
- Do not treat your own echoed speech as interruptions
- Only treat audio input as genuine user speech if it clearly does NOT match something you recently said via [SPEAK] or [INTERPRET]

If you hear speech that resembles text you recently produced, it is your echo. Ignore it completely and produce no output.`;

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

      // Connect to Gemini Live API
      const config: LiveSessionConfig = {
        model: "gemini-2.0-flash-exp-image-generation",
        temperature: 0.7,
        compressionTriggerTokens: 100_000,
        compressionTargetTokens: 50_000,
      };

      await this.gemini.connect(systemPrompt, config);

      // Start periodic board state reminders
      this.startBoardReminder();

      // Send initialization confirmation to client
      this.send({ type: "initialized", sessionId: state.sessionId });

      logDualAgent("LiveRelay.initialize", {
        sessionId: state.sessionId,
        studentId: msg.studentId,
        interactionMode: this.interactionMode,
        responseMode: this.responseMode,
      });

      // Send greeting prompt to Gemini — include persona hint (matching HTTP mode)
      const isSilent = this.interactionMode === "silent";
      const student = cached.monitorAgent.getStudent?.();
      const personaHint = student?.aacSettings?.chatAgentPrompt?.trim()
        ? `\nThe student is ${student.name}. Use their profile (in the system prompt) to personalize the board — reflect their interests, communication level, and needs.`
        : "";
      const greetingPrompt = isSilent
        ? `Generate 4-12 contextual utterance buttons — complete phrases the user might want to say. Use the student's profile and interests from the system prompt to make them relevant. Use [REBUILD_BOARD] to create the initial board.${personaHint}`
        : `Greet the user with a short, friendly greeting (1-2 sentences) and provide 4-12 initial communication buttons that reflect the student's interests, needs, and communication level from the system prompt. The buttons should be appropriate responses to your greeting. Use [SPEAK] for your greeting and [REBUILD_BOARD] for the buttons.${personaHint}`;

      this.gemini.sendMessage(greetingPrompt, "user");

      console.log(`[LiveRelay] Initialized session ${state.sessionId} for student ${msg.studentId}`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[LiveRelay] Initialize failed:", error.message);
      this.send({ type: "error", data: `Initialize failed: ${error.message}` });
    }
  }

  // -------------------------------------------------------------------------
  // Button interpretation (send interpretation prompt to Gemini)
  // -------------------------------------------------------------------------

  private handleInterpretButtons(buttons: string[], board?: any): void {
    const buttonList = buttons.join(", ");
    console.log(`[LiveRelay] Interpreting buttons: ${buttonList}`);
    this.gemini.sendMessage(`[BUTTON PRESS] ${buttonList}
    The user pressed the above button(s). Interpret this as a user message and respond accordingly.
    Call [REBUILD_BOARD] to update the board with new buttons or content.
    `, "user");
  }

  // -------------------------------------------------------------------------
  // Gemini response handling
  // -------------------------------------------------------------------------

  /**
   * Handle incremental text from Gemini.
   * Feed through the streaming prefix parser to detect tokens as they arrive.
   */
  private handleGeminiText(text: string): void {
    if (this.turnTextBuffer === "") {
      this.turnStartTime = Date.now();
      // Reset reconnect counter on first text of a new turn — connection is healthy
      this.reconnectAttempts = 0;
    }
    this.turnTextBuffer += text;

    // Feed through parser to detect complete segments
    const segments = this.parser.addChunk(text);
    for (const seg of segments) {
      this.turnSegments.push(seg);
      this.processSegment(seg);
    }
  }

  /**
   * Handle turn completion from Gemini.
   * Flush the parser and do post-turn processing (TTS, contact enrollment, monitor).
   */
  private async handleGeminiTurnComplete(): Promise<void> {
    // Flush remaining content from parser
    const remaining = this.parser.flush();
    for (const seg of remaining) {
      this.turnSegments.push(seg);
      this.processSegment(seg);
    }

    // Post-turn processing
    await this.processTurnEnd();

    // Reset for next turn
    this.turnTextBuffer = "";
    this.turnSegments = [];
  }

  /**
   * Handle interruption (model was cut off by new input).
   */
  private handleGeminiInterrupted(): void {
    // Tell client to stop playing audio immediately
    this.send({ type: "audio_interrupt" });

    // Flush parser
    const remaining = this.parser.flush();
    for (const seg of remaining) {
      this.processSegment(seg);
    }

    // Reset
    this.turnTextBuffer = "";
    this.turnSegments = [];
    console.log("[LiveRelay] Model interrupted by new input");
  }

  /**
   * Process a single parsed segment immediately (streaming to client).
   */
  private processSegment(seg: StreamingSegment): void {
    const isSilent = this.interactionMode === "silent";

    switch (seg.type) {
      case "speak":
        if (!isSilent) {
          this.send({ type: "text", data: seg.data });
        }
        break;

      case "interpret":
        this.send({ type: "interpret", text: seg.data, confidence: seg.confidence });
        break;

      case "transcript":
        this.send({ type: "transcript", data: seg.data, speaker: seg.speaker, confidence: seg.confidence });
        break;

      case "context":
        this.send({ type: "context", data: seg.data });
        break;

      case "add_buttons":
      case "remove_buttons":
      case "rebuild_board": {
        const parsed = parseStreamedText(`[${seg.type.toUpperCase()}] ${seg.data}`);
        const state = this.sessionCache?.state;
        const maxSlots = state?.maxBoardItems || 12;

        if (seg.type === "add_buttons" && parsed.addButtons) {
          // Enforce button limit — reject and ask Gemini to retry
          if (state) {
            const newCount = state.boardButtonLabels.length + parsed.addButtons.length;
            if (newCount > maxSlots) {
              const available = maxSlots - state.boardButtonLabels.length;
              const msg = `[BOARD REJECTED] Cannot add ${parsed.addButtons.length} button(s) — would exceed the ${maxSlots}-button limit. Currently ${state.boardButtonLabels.length} buttons, ${available} slot(s) available. Current buttons: ${state.boardButtonLabels.join(", ")}. Please use [REMOVE_BUTTONS] first to free slots, then retry with [ADD_BUTTONS] (You may respond with both tokens in a single response.)`;
              logDualAgent("LiveRelay.boardPatchRejected", { sessionId: this.sessionId, attempted: parsed.addButtons.length, current: state.boardButtonLabels.length, max: maxSlots });
              this.gemini.sendContextInjection(msg);
              break;
            }
            state.boardButtonLabels = [...state.boardButtonLabels, ...parsed.addButtons.map(b => b.label)];
          }
          this.lastBoardUpdateTime = Date.now();
          this.send({ type: "board_patch", data: { add: parsed.addButtons, remove: [] } });
          if (state) {
            const available = maxSlots - state.boardButtonLabels.length;
            this.gemini.sendContextInjection(`[BOARD STATE UPDATE] Current buttons (${state.boardButtonLabels.length}/${maxSlots}, ${available} slots available): ${state.boardButtonLabels.join(", ")}`);
          }
        } else if (seg.type === "remove_buttons" && parsed.removeButtons) {
          if (state) {
            const removeSet = new Set(parsed.removeButtons.map(l => l.toLowerCase()));
            state.boardButtonLabels = state.boardButtonLabels.filter(l => !removeSet.has(l.toLowerCase()));
          }
          this.lastBoardUpdateTime = Date.now();
          this.send({ type: "board_patch", data: { add: [], remove: parsed.removeButtons } });
          if (state) {
            const available = maxSlots - state.boardButtonLabels.length;
            this.gemini.sendContextInjection(`[BOARD STATE UPDATE] Current buttons (${state.boardButtonLabels.length}/${maxSlots}, ${available} slots available): ${state.boardButtonLabels.join(", ") || "none"}`);
          }
        } else if (seg.type === "rebuild_board" && parsed.rebuildBoard) {
          // Clear loaded custom board — REBUILD returns to default AI-generated board
          if (state) {
            state.loadedBoardId = null;
            state.loadedBoardData = undefined;
            state.currentPageId = null;
            state.pageHistory = [];
            state.maxBoardItems = 12;
            state.boardButtonLabels = parsed.rebuildBoard.slice(0, 12).map(b => b.label);
          }
          this.lastBoardUpdateTime = Date.now();
          this.send({ type: "board", data: this.buildBoardFromButtons(parsed.rebuildBoard) });
          if (state) {
            const available = (state.maxBoardItems || 12) - state.boardButtonLabels.length;
            this.gemini.sendContextInjection(`[BOARD STATE UPDATE] Board rebuilt. Current buttons (${state.boardButtonLabels.length}/${state.maxBoardItems || 12}, ${available} slots available): ${state.boardButtonLabels.join(", ")}`);
          }
        }
        break;
      }

      case "emote":
        this.send({ type: "emote", data: seg.data });
        break;

      case "set_board":
        // Handled during turn completion (needs async board loading)
        break;

      case "yes_no":
        this.send({ type: "yes_no", data: {} });
        break;

      case "ask_yes_no":
        this.send({ type: "ask_yes_no", data: {} });
        break;

      case "press_button":
      case "open_app":
      case "close_app":
      case "call_monitor":
      case "learn_face":
        // These are handled during turn completion
        break;
    }
  }

  /**
   * Post-turn processing: record state, TTS, app commands, contact enrollment, monitor triggering.
   */
  private async processTurnEnd(): Promise<void> {
    const isSilent = this.interactionMode === "silent";
    const state = this.sessionCache?.state;
    let fullSpeakText = "";
    let fullInterpretText = "";
    let fullContextText = "";
    let fullTranscriptText = "";
    let callMonitorReason: string | undefined;
    let learnFaceData: { name: string; relationship?: string; description?: string } | undefined;
    let openAppData: { appId: string; data?: string } | undefined;
    let closeAppTriggered = false;
    let setBoardName: string | undefined;
    let pressButtonLabel: string | undefined;

    // Board change tracking
    let boardRebuilt = false;
    let boardAddCount = 0;
    let boardRemoveCount = 0;
    const boardAddLabels: string[] = [];
    const boardRemoveLabels: string[] = [];

    // Aggregate all turn segments
    for (const seg of this.turnSegments) {
      switch (seg.type) {
        case "speak":
          fullSpeakText += seg.data + " ";
          break;
        case "interpret":
          fullInterpretText += seg.data + " ";
          break;
        case "transcript":
          fullTranscriptText += `[${seg.speaker || "?"}] ${seg.data} `;
          break;
        case "context":
          fullContextText += seg.data + " ";
          break;
        case "rebuild_board": {
          boardRebuilt = true;
          const parsed = parseStreamedText(`[REBUILD_BOARD] ${seg.data}`);
          if (parsed.rebuildBoard) {
            boardAddLabels.push(...parsed.rebuildBoard.map(b => b.label));
          }
          break;
        }
        case "add_buttons": {
          const parsed = parseStreamedText(`[ADD_BUTTONS] ${seg.data}`);
          if (parsed.addButtons) {
            boardAddCount += parsed.addButtons.length;
            boardAddLabels.push(...parsed.addButtons.map(b => b.label));
          }
          break;
        }
        case "remove_buttons": {
          const parsed = parseStreamedText(`[REMOVE_BUTTONS] ${seg.data}`);
          if (parsed.removeButtons) {
            boardRemoveCount += parsed.removeButtons.length;
            boardRemoveLabels.push(...parsed.removeButtons);
          }
          break;
        }
        case "call_monitor":
          callMonitorReason = seg.data;
          break;
        case "learn_face": {
          const parsed = parseStreamedText(`[LEARN_FACE] ${seg.data}`);
          if (parsed.learnFace) learnFaceData = parsed.learnFace;
          break;
        }
        case "open_app": {
          const parts = seg.data.trim().split(/\s+/);
          openAppData = { appId: parts[0], data: parts.slice(1).join(" ") || undefined };
          break;
        }
        case "close_app":
          closeAppTriggered = true;
          break;
        case "set_board":
          setBoardName = seg.data.trim();
          break;
        case "press_button":
          pressButtonLabel = seg.data.trim();
          break;
      }
    }

    fullSpeakText = fullSpeakText.trim();
    fullInterpretText = fullInterpretText.trim();
    fullContextText = fullContextText.trim();
    fullTranscriptText = fullTranscriptText.trim();

    const elapsed = Date.now() - this.turnStartTime;
    const hasBoardChange = boardRebuilt || boardAddCount > 0 || boardRemoveCount > 0;

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
      segmentCount: this.turnSegments.length,
      segments: this.turnSegments.map(s => s.type).join(", "),
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
      setBoard: setBoardName || false,
      pressButton: pressButtonLabel || false,
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

      // Record AI speech as pending message for monitor
      if (fullSpeakText) {
        turnMessages.push({
          role: "assistant",
          content: fullSpeakText,
          timestamp: now,
        });
      }

      // Record AI interpretation as pending message
      if (fullInterpretText) {
        turnMessages.push({
          role: "assistant",
          content: `[INTERPRET] ${fullInterpretText}`,
          timestamp: now,
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
    // App open/close
    // -----------------------------------------------------------------------
    if (openAppData) {
      if (openAppData.appId === "youtube" && openAppData.data) {
        try {
          const results = await searchYouTube(openAppData.data);
          this.send({ type: "video_play", data: { query: openAppData.data, results } });
        } catch (err) {
          console.error("[LiveRelay] YouTube search failed:", err);
        }
      } else {
        this.send({ type: "app_open", data: openAppData });
      }
    }
    if (closeAppTriggered) {
      this.send({ type: "app_close", data: {} });
    }

    // -----------------------------------------------------------------------
    // Board selection via [SET_BOARD]
    // -----------------------------------------------------------------------
    if (setBoardName && state) {
      const setBoardKey = setBoardName.toLowerCase().replace(/ /g, '_');
      const match = state.availableBoards?.find(
        (b) => b.key === setBoardKey,
      );
      if (match) {
        try {
          const fullBoard = await boardRepository.getBoard(match.id);
          if (fullBoard?.irData) {
            const boardData = fullBoard.irData as any;
            state.loadedBoardId = match.id;
            state.loadedBoardData = boardData;
            state.currentPageId = boardData.pages?.[0]?.id || null;
            state.pageHistory = [];
            state.maxBoardItems = (boardData.grid?.rows || 3) * (boardData.grid?.cols || 4);

            this.send({ type: "set_board", data: { board: boardData, name: match.name, boardId: match.id } });
            this.gemini.sendContextInjection(
              `Board "${match.name}" loaded with ${boardData.pages?.length || 1} pages, ${state.maxBoardItems} slots`,
            );
            logDualAgent("LiveRelay.setBoard", { sessionId: this.sessionId, boardName: match.name, boardId: match.id });
          }
        } catch (err) {
          console.error("[LiveRelay] SET_BOARD load failed:", err);
        }
      } else {
        const availableKeys = state.availableBoards?.map((b) => b.key).join(", ") || "none";
        this.gemini.sendContextInjection(
          `Board "${setBoardName}" not found. Available board keys: ${availableKeys}`,
        );
      }
    }

    // -----------------------------------------------------------------------
    // AI button press via [PRESS_BUTTON]
    // -----------------------------------------------------------------------
    if (pressButtonLabel && state?.loadedBoardData) {
      const currentPage = state.loadedBoardData.pages?.find((p: any) => p.id === state.currentPageId)
        || state.loadedBoardData.pages?.[0];
      if (currentPage?.buttons) {
        const btn = currentPage.buttons.find((b: any) =>
          b.label.toLowerCase().trim() === pressButtonLabel!.toLowerCase().trim()
        );
        if (btn?.action) {
          const action = btn.action;
          if (action.type === "link" && action.toPageId) {
            const targetPage = state.loadedBoardData.pages?.find((p: any) => p.id === action.toPageId);
            if (targetPage) {
              // Push current page to history
              if (state.currentPageId) {
                state.pageHistory = [...(state.pageHistory || []), state.currentPageId];
              }
              state.currentPageId = targetPage.id;

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

              const buttonLabels = (targetPage.buttons || []).map((b: any) => b.label).join(", ");
              this.gemini.sendContextInjection(
                `[AI navigated to page "${targetPage.name || targetPage.id}". Current buttons: ${buttonLabels}]`
              );
              if (this.sessionId) {
                dualAgentService.addPendingMessage(this.sessionId, {
                  role: "assistant",
                  content: `[AI navigated to page "${targetPage.name || targetPage.id}"]`,
                  timestamp: Date.now(),
                }).catch(err => console.error("[LiveRelay] Failed to persist nav message:", err));
              }

              logDualAgent("LiveRelay.pressButton", {
                sessionId: this.sessionId,
                label: btn.label,
                action: "link",
                targetPage: targetPage.name || targetPage.id,
              });
            }
          } else if (action.type === "back") {
            const history = state.pageHistory || [];
            if (history.length > 0) {
              const prevPageId = history[history.length - 1];
              state.pageHistory = history.slice(0, -1);
              state.currentPageId = prevPageId;

              const prevPage = state.loadedBoardData.pages?.find((p: any) => p.id === prevPageId);
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
                this.gemini.sendContextInjection(
                  `[AI navigated back to page "${prevPage.name || prevPageId}". Current buttons: ${buttonLabels}]`
                );
              }
            }
          } else if (action.type === "home") {
            const homePage = state.loadedBoardData.pages?.[0];
            if (homePage) {
              state.pageHistory = [];
              state.currentPageId = homePage.id;

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
              this.gemini.sendContextInjection(
                `[AI navigated to home page "${homePage.name || homePage.id}". Current buttons: ${buttonLabels}]`
              );
            }
          }
        }
      }
    }

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
    // -----------------------------------------------------------------------
    if (fullInterpretText && this.studentVoice) {
      try {
        for await (const chunk of ttsFacade.synthesizeStream(fullInterpretText, this.studentVoice)) {
          this.send({ type: "interpretation_audio", data: chunk.toString("base64") });
        }
      } catch (err) {
        console.error("[LiveRelay] Student TTS error:", err);
      }
    }

    if (fullSpeakText && !isSilent && this.aiVoice) {
      try {
        for await (const chunk of ttsFacade.synthesizeStream(fullSpeakText, this.aiVoice)) {
          this.send({ type: "avatar_audio", data: chunk.toString("base64") });
        }
      } catch (err) {
        console.error("[LiveRelay] AI TTS error:", err);
      }
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
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
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
   * Send a periodic board state context injection so Gemini stays aware
   * of current buttons and available slots. Only fires if the board
   * hasn't been updated recently (otherwise the per-change injections suffice).
   * These are NOT added to pendingMessages (per design).
   */
  private sendBoardStateReminder(): void {
    const state = this.sessionCache?.state;
    if (!state) return;

    const timeSinceUpdate = Date.now() - this.lastBoardUpdateTime;
    if (timeSinceUpdate < LiveRelay.BOARD_REMINDER_INTERVAL_MS) return; // recent update already informed Gemini

    const maxSlots = state.maxBoardItems || 12;
    const labels = state.boardButtonLabels;
    const available = maxSlots - labels.length;

    this.gemini.sendContextInjection(
      `[BOARD STATE REMINDER] Current buttons (${labels.length}/${maxSlots}, ${available} slots available): ${labels.join(", ") || "none"}`,
    );
  }

  /**
   * Force a completely new session when reconnection keeps failing
   * (e.g. repeated safety/unsafe prompt errors).
   */
  private async forceNewSession(): Promise<void> {
    if (!this.studentId || !this.sessionId) return;

    // Close the current Gemini session (prevents auto-reconnect)
    this.gemini.close();

    // Re-initialize from scratch
    try {
      await this.handleInitialize({
        type: "initialize",
        studentId: this.studentId,
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
      this.send({ type: "error", data: "Failed to create new session after repeated errors" });
    }
  }

  private cleanup(): void {
    // Stop board state reminder timer
    this.stopBoardReminder();

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

    this.gemini.close();
    logDualAgent("LiveRelay.cleanup", { sessionId: this.sessionId });
  }

  /**
   * Handle session close: add a close marker and force-trigger the monitor
   * for a final summary of the session.
   */
  private async handleSessionClose(): Promise<void> {
    if (!this.sessionId) return;

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
