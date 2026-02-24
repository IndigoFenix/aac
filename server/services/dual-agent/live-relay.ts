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
  | { type: "focus_frame"; data: string };                   // base64 JPEG — high-res focus frame

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
  private gemini: GeminiLiveSession;
  private parser: StreamingPrefixParser;

  // Session state
  private studentId: string | null = null;
  private userId: string | undefined = undefined;
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

  // Behavioral reminder: periodically re-inject critical rules to prevent prompt drift
  private behavioralReminderTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly BEHAVIORAL_REMINDER_INTERVAL_MS = 180_000; // 3 min

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
  private initialConnectionDone = false;

  // Safety block tracking — progressive content scrubbing
  private consecutiveSafetyBlocks = 0;

  // Client WebSocket health check (ping/pong)
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongReceived = true;
  private static readonly PING_INTERVAL_MS = 30_000; // 30s

  // Accumulation for turn processing
  private turnTextBuffer = "";
  private turnSegments: StreamingSegment[] = [];
  private turnStartTime = 0;

  // Turn processing guard: prevents concurrent processTurnEnd() calls
  private turnProcessingBusy = false;

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

        if (this.initialConnectionDone) {
          // This is a reconnection — restore context so the model doesn't start over
          this.send({ type: "reconnected" });
          this.injectReconnectionContext();
        }
        // Initial connection is handled by handleInitialize after greeting prompt
      },
      onReconnecting: () => {
        // Safety blocks: progressive content scrubbing instead of forceNewSession
        if (this.gemini.lastCloseWasSafety) {
          this.handleSafetyBlock();
          this.send({ type: "reconnecting", data: "error:RECONNECTING" });
          return; // Don't increment reconnectAttempts or trigger forceNewSession
        }

        this.reconnectAttempts++;
        console.log(`[LiveRelay] Reconnecting (attempt ${this.reconnectAttempts})...`);
        this.send({ type: "reconnecting", data: "error:RECONNECTING" });

        // If too many reconnect attempts, force new session
        if (this.reconnectAttempts >= LiveRelay.MAX_RECONNECT_BEFORE_RESET && this.sessionId) {
          console.log("[LiveRelay] Too many reconnect attempts — creating new session");
          this.forceNewSession().catch(err => {
            console.error("[LiveRelay] Force new session failed:", err);
          });
        }
      },
      onError: (error) => {
        console.error("[LiveRelay] Gemini error:", error.message);
        // Check if this is a rate-limit error
        if (this.gemini.lastCloseWasRateLimit || /resource.exhausted|rate.limit|quota|too many requests|overloaded/i.test(error.message)) {
          this.send({ type: "rate_limited", data: "error:RATE_LIMITED" });
        } else if (this.gemini.lastCloseWasSafety || /policy.violation|unsafe|blocked|safety/i.test(error.message)) {
          // Safety errors are handled by onReconnecting → handleSafetyBlock; skip generic error
        } else {
          this.send({ type: "error", data: "error:CONNECTION_ERROR" });
        }
      },
      onClose: (code, reason) => {
        console.log(`[LiveRelay] Gemini session closed: code=${code} reason=${reason}`);
        // Check if rate-limited — send specific message so client doesn't auto-reconnect
        if (this.gemini.lastCloseWasRateLimit) {
          this.send({ type: "rate_limited", data: "error:RATE_LIMITED" });
          return;
        }
        // Safety blocks are handled by onReconnecting → handleSafetyBlock; skip generic error
        if (this.gemini.lastCloseWasSafety) {
          return;
        }
        // Forward non-normal closes to client so they see specific error feedback
        if (code && code !== 1000) {
          this.send({ type: "error", data: "error:CONNECTION_CLOSED" });
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
          const excludeSafety = this.consecutiveSafetyBlocks > 0;
          const turns = await dualAgentService.loadHistoryForReconnect(this.sessionId, excludeSafety);
          if (turns.length > 0) {
            this.gemini.sendConversationHistory(turns);
            console.log(`[LiveRelay] Sent ${turns.length} history turns to fresh Gemini session (excludeSafety=${excludeSafety})`);
          }
          // Context injection is also handled by onReady → injectReconnectionContext()
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

    // Respond to pong frames (for health check)
    ws.on("pong", () => {
      this.pongReceived = true;
    });

    // Start client WebSocket health check
    this.startPingTimer();
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
            `[VISUAL CHECK] Composite frame grid (${msg.timestamps?.length ?? '?'} frames). Observe the scene. Your PRIMARY task is to keep the AAC board relevant — if you observe new objects, activities, people, or communication opportunities, use [ADD_BUTTONS]. Prioritize objects in your user's hands or that they appear to be interested in (looking at, pointing to or reaching for), or things being spoken about. If items are no longer relevant, use [REMOVE_BUTTONS]. Always pair [CONTEXT] observations with board updates when applicable. Speak or interpret only with HIGH CONFIDENCE. Stay silent if nothing important changed.`,
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

        case "focus_frame":
          // High-resolution single frame requested by AI for detailed analysis
          this.gemini.sendFrameWithPrompt(
            msg.data,
            `[FOCUS FRAME] This is a HIGH-RESOLUTION single frame captured at your request. Analyze the image carefully for fine details, text, labels, faces, or objects you couldn't identify before. Report findings via [CONTEXT] and update the board if needed.`,
          );
          console.log("[LiveRelay] Focus frame sent to Gemini");
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

      // Start periodic reminders
      this.startBoardReminder();
      this.startBehavioralReminder();

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
      const imageHint = msg.initialFrame ? "\nUse the camera image to observe the environment and make the buttons contextually relevant." : "";
      const boardHint = state.availableBoards && state.availableBoards.length > 0
        ? " If a custom board from the Available Custom Boards list is appropriate for this student, use [SET_BOARD] instead of [REBUILD_BOARD]."
        : "";
      const greetingPrompt = isSilent
        ? `Generate 4-12 contextual utterance buttons — complete phrases the user might want to say. Use the student's profile and interests from the system prompt to make them relevant.${imageHint} Use [REBUILD_BOARD] to create the initial board.${boardHint}${personaHint}`
        : `Greet the user with a short, friendly greeting (1-2 sentences) and provide 4-12 initial communication buttons that reflect the student's interests, needs, and communication level from the system prompt. The buttons should be appropriate responses to your greeting.${imageHint} Use [SPEAK] for your greeting and [REBUILD_BOARD] for the buttons.${boardHint}${personaHint}`;

      if (msg.initialFrame) {
        this.gemini.sendFrameWithPrompt(msg.initialFrame, greetingPrompt);
      } else {
        this.gemini.sendMessage(greetingPrompt, "user");
      }
      this.initialConnectionDone = true;

      console.log(`[LiveRelay] Initialized session ${state.sessionId} for student ${msg.studentId}`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[LiveRelay] Initialize failed:", error.message);
      this.send({ type: "error", data: "error:INIT_FAILED" });
    }
  }

  // -------------------------------------------------------------------------
  // Button interpretation (send interpretation prompt to Gemini)
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

    this.gemini.sendMessage(`[BUTTON PRESS] ${buttonList}
    The user pressed the above button(s). Interpret this as a user message and respond accordingly.
    IMPORTANT: Call [REBUILD_BOARD] (or [SET_BOARD], if relevant) NOW to update the board with new buttons or content.
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
      // Successful turn = safety recovery worked — reset safety counter
      this.consecutiveSafetyBlocks = 0;
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
   * Wrapped in try-catch-finally to prevent errors from killing the relay.
   */
  private async handleGeminiTurnComplete(): Promise<void> {
    // Guard against concurrent turn processing (shouldn't happen but safety first)
    if (this.turnProcessingBusy) {
      console.warn("[LiveRelay] handleGeminiTurnComplete called while already processing — skipping");
      return;
    }
    this.turnProcessingBusy = true;

    try {
      // Flush remaining content from parser
      const remaining = this.parser.flush();
      for (const seg of remaining) {
        this.turnSegments.push(seg);
        this.processSegment(seg);
      }

      // Post-turn processing with timeout (60s max)
      const turnEndPromise = this.processTurnEnd();
      const timeoutPromise = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("processTurnEnd timed out after 60s")), 60_000)
      );
      await Promise.race([turnEndPromise, timeoutPromise]);
    } catch (err) {
      console.error("[LiveRelay] handleGeminiTurnComplete error:", (err as Error).message);
      // Send error to client so they know something went wrong
      this.send({ type: "error", data: "error:TURN_FAILED" });
    } finally {
      // Always reset state so the relay can process the next turn
      this.turnTextBuffer = "";
      this.turnSegments = [];
      this.turnProcessingBusy = false;
    }
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
            if (state.loadedBoardId) {
              // Custom board: check against blank slot budget
              const nativeLabels = this.getNativePageButtonLabels(state);
              const blankSlots = maxSlots - nativeLabels.length;
              const newAiCount = state.aiAddedButtonLabels.length + parsed.addButtons.length;
              if (newAiCount > blankSlots) {
                const available = blankSlots - state.aiAddedButtonLabels.length;
                const msg = `[BOARD REJECTED] Cannot add ${parsed.addButtons.length} button(s) — would exceed ${blankSlots} blank slots on this custom board (${nativeLabels.length} fixed buttons). Currently ${state.aiAddedButtonLabels.length} AI-added buttons, ${available} slot(s) available. AI-added buttons: ${state.aiAddedButtonLabels.join(", ") || "none"}. Please use [REMOVE_BUTTONS] to remove AI-added buttons first.`;
                logDualAgent("LiveRelay.boardPatchRejected", { sessionId: this.sessionId, attempted: parsed.addButtons.length, current: state.aiAddedButtonLabels.length, max: blankSlots });
                this.gemini.sendContextInjection(msg);
                break;
              }
              state.aiAddedButtonLabels = [...state.aiAddedButtonLabels, ...parsed.addButtons.map(b => b.label)];
            } else {
              const newCount = state.boardButtonLabels.length + parsed.addButtons.length;
              if (newCount > maxSlots) {
                const available = maxSlots - state.boardButtonLabels.length;
                const msg = `[BOARD REJECTED] Cannot add ${parsed.addButtons.length} button(s) — would exceed the ${maxSlots}-button limit. Currently ${state.boardButtonLabels.length} buttons, ${available} slot(s) available. Current buttons: ${state.boardButtonLabels.join(", ")}. Please use [REMOVE_BUTTONS] first to free slots, then retry with [ADD_BUTTONS] (You may respond with both tokens in a single response.)`;
                logDualAgent("LiveRelay.boardPatchRejected", { sessionId: this.sessionId, attempted: parsed.addButtons.length, current: state.boardButtonLabels.length, max: maxSlots });
                this.gemini.sendContextInjection(msg);
                break;
              }
            }
            state.boardButtonLabels = [...state.boardButtonLabels, ...parsed.addButtons.map(b => b.label)];
          }
          this.lastBoardUpdateTime = Date.now();
          this.send({ type: "board_patch", data: { add: parsed.addButtons, remove: [] } });
          if (state) {
            if (state.loadedBoardId) {
              const nativeLabels = this.getNativePageButtonLabels(state);
              const blankSlots = maxSlots - nativeLabels.length;
              const available = blankSlots - state.aiAddedButtonLabels.length;
              this.gemini.sendContextInjection(`[BOARD STATE UPDATE] Custom board — Fixed: ${nativeLabels.join(", ")} | AI-added (${state.aiAddedButtonLabels.length}/${blankSlots}): ${state.aiAddedButtonLabels.join(", ") || "none"} | ${available} slots available`);
            } else {
              const available = maxSlots - state.boardButtonLabels.length;
              this.gemini.sendContextInjection(`[BOARD STATE UPDATE] Current buttons (${state.boardButtonLabels.length}/${maxSlots}, ${available} slots available): ${state.boardButtonLabels.join(", ")}`);
            }
          }
        } else if (seg.type === "remove_buttons" && parsed.removeButtons) {
          if (state) {
            if (state.loadedBoardId) {
              // Custom board: only allow removing AI-added buttons
              const nativeSet = new Set(this.getNativePageButtonLabels(state).map(l => l.toLowerCase()));
              const allowedRemoves = parsed.removeButtons.filter(l => !nativeSet.has(l.toLowerCase()));
              const blockedRemoves = parsed.removeButtons.filter(l => nativeSet.has(l.toLowerCase()));
              if (blockedRemoves.length > 0) {
                console.log(`[LiveRelay] Protected board: silently ignored removal of native buttons: ${blockedRemoves.join(", ")}`);
              }
              if (allowedRemoves.length === 0) {
                // Nothing to remove after filtering
                break;
              }
              const removeSet = new Set(allowedRemoves.map(l => l.toLowerCase()));
              state.aiAddedButtonLabels = state.aiAddedButtonLabels.filter(l => !removeSet.has(l.toLowerCase()));
              state.boardButtonLabels = state.boardButtonLabels.filter(l => !removeSet.has(l.toLowerCase()));
              // Override parsed.removeButtons for the client message
              parsed.removeButtons = allowedRemoves;
            } else {
              const removeSet = new Set(parsed.removeButtons.map(l => l.toLowerCase()));
              state.boardButtonLabels = state.boardButtonLabels.filter(l => !removeSet.has(l.toLowerCase()));
            }
          }
          this.lastBoardUpdateTime = Date.now();
          this.send({ type: "board_patch", data: { add: [], remove: parsed.removeButtons } });
          if (state) {
            if (state.loadedBoardId) {
              const nativeLabels = this.getNativePageButtonLabels(state);
              const blankSlots = maxSlots - nativeLabels.length;
              const available = blankSlots - state.aiAddedButtonLabels.length;
              this.gemini.sendContextInjection(`[BOARD STATE UPDATE] Custom board — Fixed: ${nativeLabels.join(", ")} | AI-added (${state.aiAddedButtonLabels.length}/${blankSlots}): ${state.aiAddedButtonLabels.join(", ") || "none"} | ${available} slots available`);
            } else {
              const available = maxSlots - state.boardButtonLabels.length;
              this.gemini.sendContextInjection(`[BOARD STATE UPDATE] Current buttons (${state.boardButtonLabels.length}/${maxSlots}, ${available} slots available): ${state.boardButtonLabels.join(", ") || "none"}`);
            }
          }
        } else if (seg.type === "rebuild_board" && parsed.rebuildBoard) {
          // Clear loaded custom board — REBUILD returns to default AI-generated board
          if (state) {
            state.loadedBoardId = null;
            state.loadedBoardData = undefined;
            state.currentPageId = null;
            state.pageHistory = [];
            state.maxBoardItems = 12;
            state.aiAddedButtonLabels = [];
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
      case "request_focus":
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
    let focusReason: string | undefined;

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
        case "request_focus":
          focusReason = seg.data.trim();
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
            state.aiAddedButtonLabels = [];
            // Set boardButtonLabels to native page labels
            const nativeLabels = this.getNativePageButtonLabels(state);
            state.boardButtonLabels = [...nativeLabels];

            this.send({ type: "set_board", data: { board: boardData, name: match.name, boardId: match.id } });
            const blankSlots = state.maxBoardItems - nativeLabels.length;
            this.gemini.sendContextInjection(
              `Board "${match.name}" loaded with ${boardData.pages?.length || 1} pages, ${state.maxBoardItems} slots. Fixed buttons: ${nativeLabels.join(", ")}. ${blankSlots} blank slots available for AI-added buttons. You CANNOT remove the board's built-in buttons.`,
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
              state.aiAddedButtonLabels = [];
              state.boardButtonLabels = this.getNativePageButtonLabels(state);

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
      `Do NOT greet the user again. Do NOT rebuild or reset the board — it is already displayed correctly on the client.`,
    ].join("\n");

    this.gemini.sendContextInjection(contextText);
    logDualAgent("LiveRelay.reconnectionContext", {
      sessionId: this.sessionId,
      boardButtons: labels.length,
      recentMessages: recent.length,
    });

    // Re-inject behavioral rules immediately after reconnection to prevent drift
    const behavioralReminder = this.buildBehavioralReminder();
    if (behavioralReminder) {
      this.gemini.sendContextInjection(behavioralReminder);
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
    if (timeSinceUpdate < LiveRelay.BOARD_REMINDER_INTERVAL_MS) return; // recent update already informed Gemini

    const maxSlots = state.maxBoardItems || 12;
    const labels = state.boardButtonLabels;

    if (state.loadedBoardId) {
      const nativeLabels = this.getNativePageButtonLabels(state);
      const blankSlots = maxSlots - nativeLabels.length;
      const available = blankSlots - state.aiAddedButtonLabels.length;
      this.gemini.sendContextInjection(
        `[BOARD STATE REMINDER] Custom board — Fixed buttons (cannot remove): ${nativeLabels.join(", ")} | AI-added (can remove, ${state.aiAddedButtonLabels.length}/${blankSlots}): ${state.aiAddedButtonLabels.join(", ") || "none"} | ${available} slots available`,
      );
    } else {
      const available = maxSlots - labels.length;
      this.gemini.sendContextInjection(
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
        this.gemini.sendContextInjection(reminder);
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
   * Build a concise behavioral reminder based on current session state.
   * Re-injects the most critical rules that tend to drift during long sessions.
   */
  private buildBehavioralReminder(): string | null {
    const state = this.sessionCache?.state;
    if (!state) return null;

    const level = state.interpretationLevel ?? 1;
    const isSilent = this.interactionMode === "silent";

    // Interpretation level rules — the most critical source of drift
    let interpretRule: string;
    switch (level) {
      case 0:
        interpretRule = "Interpretation Level: 0 (Off)\n- Do NOT use [INTERPRET]. Button text is spoken directly by the system.";
        break;
      case 1:
        interpretRule = "Interpretation Level: 1 (Minimal)\n- ONLY use [INTERPRET] immediately after [BUTTON PRESS]. Never from gestures, gaze, or context alone.\n- Expand button labels into short natural phrases.";
        break;
      case 2:
        interpretRule = "Interpretation Level: 2 (Moderate)\n- [INTERPRET] from button presses, clear gestures, or strong contextual cues.\n- Do NOT interpret weak or ambiguous signals — add a button instead.";
        break;
      case 3:
        interpretRule = "Interpretation Level: 3 (Active)\n- Interpret button presses, gestures, gaze patterns, and contextual cues.\n- Prefer interpreting over silence — the user benefits from having intent voiced.";
        break;
      case 4:
        interpretRule = "Interpretation Level: 4 (Autonomous)\n- You are the user's voice. Actively interpret and speak for them.\n- Respond to questions on the user's behalf when possible.";
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
      parts.push("Confidence: Always include confidence (high/medium/low) on [INTERPRET]. Only [SPEAK] or [INTERPRET] with HIGH CONFIDENCE from visual/audio input alone.");
    }

    // Visual check conservatism
    parts.push("Visual checks: Stay silent if nothing important changed. Only report meaningful context changes.");

    // Mode
    if (isSilent) {
      parts.push("Mode: silent — You are INVISIBLE. NEVER use [SPEAK]. Only output board buttons.");
    } else {
      parts.push(`Mode: interact — AI voice active.`);
    }

    // Echo awareness (always critical for live sessions)
    parts.push("Echo: Speech you hear shortly after your own [SPEAK] or [INTERPRET] output is YOUR echo — ignore it completely. Do NOT transcribe or respond to it.");

    // Board limit
    const maxSlots = state.maxBoardItems || 12;
    parts.push(`Board limit: ${maxSlots} buttons max. Use [REMOVE_BUTTONS] before [ADD_BUTTONS] if near the limit.`);

    // Custom boards reminder
    if (state.availableBoards && state.availableBoards.length > 0 && !state.loadedBoardId) {
      const boardKeys = state.availableBoards.map(b => {
        const hint = b.hint ? ` (${b.hint})` : '';
        return `${b.key}${hint}`;
      }).join(", ");
      parts.push(`Custom boards available: ${boardKeys}. Use [SET_BOARD] board_key silently when the context matches a board's purpose — do NOT announce board switches with [SPEAK].`);
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
    this.gemini.close();

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
      lastCloseCode: this.gemini.lastCloseCode,
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

    this.gemini.close();
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
