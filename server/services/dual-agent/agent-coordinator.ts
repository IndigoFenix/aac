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
import type { ObserverToolConfig } from "./tool-declarations-observer";
import type { SpeakerToolConfig } from "./tool-declarations-speaker";
import type { BoardManagerToolConfig } from "./tool-declarations-board-manager";
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
  SpeechEndEvent,
  InterpretIntentEvent,
  ModeChangeEvent,
  EmoteChangeEvent,
  AppOpenRequestedEvent,
  AppCloseRequestedEvent,
  WebsiteOpenRequestedEvent,
  BoardRebuiltEvent,
  ContextButtonAddedEvent,
  BinaryChoiceShownEvent,
  BuilderSuggestedEvent,
  MonitorBroadcastEvent,
  FocusRequestEvent,
} from "./agent-events";

import type { ClientMessage, ServerMessage } from "./live-relay";
import type { AACMuteState } from "./types";
import { T } from "../memory-schema/canonical-terms";
import { authenticateUpgrade } from "../realtime/ws-auth";
import { parseBoardButtons } from "./interactive-agent";
import { resolveImageKeys, queueSymbolGeneration } from "../symbol/auto-symbol-service";
import { collectGlyphImageKeys } from "./board-button-validator";
import { logLiveSession, logDualAgent, runInSessionContext } from "./dual-agent-logger";
import { buildDefaultHomeBoard, HOME_BOARD_KEY } from "./default-home-board";

// ---------------------------------------------------------------------------
// Defaults — Board Manager is hardcoded to a fast model for the MVP. Move
// to a per-agent settings row in a follow-up.
// ---------------------------------------------------------------------------

const BOARD_MANAGER_DEFAULT_PROVIDER = "gemini" as const;
const BOARD_MANAGER_DEFAULT_MODEL = "gemini-2.5-flash";

const DEBOUNCE_CONTEXT_UPDATE_MS = 400;
const DEBOUNCE_MONITOR_CALL_MS = 30_000;
const MIC_MUTE_TAIL_MS = 300;
const RECENT_EVENTS_WINDOW = 20;
/** How many conversational events accumulate before a rolling session
 *  summary refresh is triggered. Mirrors LiveRelay's threshold. */
const SUMMARY_EVERY_N_MESSAGES = 20;

// Compression-window thresholds per profile (mirror LiveRelay).
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
    buttonType?: "guess" | "category" | "suggestion";
    suggestionKey?: string;
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

interface GuessingState {
  dimension: string;
  offeredKeys: string[];
  questionHint: string;
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
  private speaker: SpeakerAgent | null = null;
  private boardManager: BoardManagerAgent | null = null;

  // Per-agent runtime config (rebuilt on transitions; cached here so
  // re-routing decisions don't need to walk back to settings).
  private observerModel = "";
  private speakerModel = "";
  private useVertex = false;
  private useDirectAudio = true;
  private aiVoiceName: string | undefined;
  private debugMode = false;
  /** Current session profile — drives the tool set + compression on the
   *  two Live agents. Toggled by Observer's rest()/wake_up() events. */
  private sessionProfile: "awake" | "resting" = "awake";

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

  /** Counters for periodic flow-confirmation logging. */
  private frameCount = 0;
  private pcmCount = 0;

  // Echo suppression
  private speakerSpeaking = false;
  private micMuteReleaseTimer: ReturnType<typeof setTimeout> | null = null;

  /** Buffer for Speaker native-audio chunks. Raw PCM (base64) — flushed
   *  as a single WAV every 250ms (or on SpeechEnd). Mirrors the legacy
   *  LiveRelay's directAudioChunks/flushDirectAudio pattern. */
  private speakerAudioChunks: string[] = [];
  private speakerAudioFlushTimer: ReturnType<typeof setTimeout> | null = null;

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

  // Recent events window — feeds BoardMgr invocations for continuity.
  private recentEvents: AgentEvent[] = [];

  // State mirrors (so each BoardMgr invocation has a snapshot)
  private currentBoardLabels: string[] = [];
  private contextSidebarLabels: string[] = [];
  private loadedBoardId: string | null = null;
  private builderState: BuilderState | null = null;
  private guessingState: GuessingState | null = null;

  // Cached prompts + tool configs — reused by profile transitions so we
  // don't have to walk back through buildPromptInputs on every switch.
  private observerPrompt = "";
  private speakerPrompt = "";
  private boardManagerPrompt = "";
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
  private conversationLog: Array<{ role: "user" | "assistant"; content: string }> = [];
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
    if (this.micMuteReleaseTimer) clearTimeout(this.micMuteReleaseTimer);
    if (this.contextUpdateDebounceTimer) clearTimeout(this.contextUpdateDebounceTimer);
    if (this.monitorCallDedupTimer) clearTimeout(this.monitorCallDedupTimer);
    if (this.speakerAudioFlushTimer) clearTimeout(this.speakerAudioFlushTimer);

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
    this.handleClientMessage(msg).catch(err => {
      console.error("[AgentCoordinator] handleClientMessage error:", err);
      this.sendError(`internal error: ${(err as Error).message}`);
    });
  }

  private async handleClientMessage(msg: ClientMessage): Promise<void> {
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
            logLiveSession("CLIENT → pcm_audio", `count=${this.pcmCount} micMutedByEcho=${this.speakerSpeaking}`);
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
        this.handleButtonPress(msg);
        return;
      case "board_exit":
        this.handleBoardExit(msg);
        return;
      case "glyph_press":
        // Sentence builder glyph press — same fan-out shape as a regular
        // button press; client also sends an explicit sentence_composed
        // separately on the Play action.
        this.emitClientEvent({
          type: "button_pressed",
          source: "client",
          timestamp: Date.now(),
          label: msg.glyph,
          sentence: msg.glyph,
          glyph: msg.glyph,
        });
        return;
      case "construction_state":
        this.handleConstructionState(msg.data);
        return;
      case "guessing_state":
        this.handleGuessingState(msg);
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
    // useDirectAudio is true when the SPEAKER's configured Live model is
    // native-audio. Observer never produces audio anyway.
    this.useDirectAudio = this.speakerModel.includes("native-audio") || this.speakerModel.includes("live");
    this.aiVoiceName = this.aiVoice?.geminiVoiceName;
    if (this.observerModel !== aacChat.model || this.speakerModel !== aacChat.model) {
      console.log(`[AgentCoordinator] Per-agent model override: observer=${this.observerModel} speaker=${this.speakerModel}`);
    }

    // 4. Build the three prompts.
    const promptInputs = await this.buildPromptInputs();
    const observerPrompt = buildObserverPrompt(promptInputs.observer);
    const speakerPrompt = buildSpeakerPrompt(promptInputs.speaker);
    const boardManagerPrompt = buildBoardManagerPrompt(promptInputs.boardManager);

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
    this.speaker = new SpeakerAgent("gemini", {
      onEvent: (e) => this.onSpeakerEvent(e),
      onAudioChunk: (data) => this.onSpeakerAudioChunk(data),
      onTranscriptionDelta: (text) => this.onSpeakerTranscriptionDelta(text),
      onSpeakText: (text) => this.onSpeakerSpeakText(text),
      onError: (err) => console.error("[AgentCoordinator] Speaker error:", err),
      onClose: () => console.log("[AgentCoordinator] Speaker closed"),
      onUsage: (usage) => this.trackLiveUsage("speaker", aacChat.provider, this.speakerModel, usage),
    });
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

    // 8. Announce ready to client.
    this.state = "ready";
    this.send({ type: "initialized", sessionId: this.sessionId });

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
      const nativeLabels: string[] = homePage.buttons
        .map((b: any) => b.label)
        .filter((l: any): l is string => typeof l === "string");
      this.currentBoardLabels = nativeLabels;
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

    const base = {
      studentName,
      language,
      studentAge: undefined as string | undefined,
      studentGender: (student as any)?.gender,
      studentDiagnosis: state.cachedDiagnosis || undefined,
      aiName: student?.aacSettings?.aiName || undefined,
      knownContacts: state.cachedContacts,
      classroom: undefined as any, // classroom plumbing wired in a follow-up
      gestureOverrides: sections?.gestureOverrides,
      safetyNotes: sections?.safetyNotes,
    };

    return {
      observer: {
        ...base,
        observerInstructions: sections?.observerInstructions,
        perceptionMemory: state.memoryContext,
      },
      speaker: {
        ...base,
        persona: sections?.persona || student?.aacSettings?.chatAgentPrompt || "",
        memoryContext: state.memoryContext,
        muteState: state.muteState,
        useDirectAudio: this.useDirectAudio,
        sessionGoals: sections?.sessionGoals,
        interactModeExamples: sections?.interactModeExamples,
        assistModeExamples: sections?.assistModeExamples,
        sentenceInterpretationExamples: sections?.sentenceInterpretationExamples,
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
      },
    };
  }

  // -------------------------------------------------------------------------
  // Client → bus
  // -------------------------------------------------------------------------

  private handleButtonPress(msg: Extract<ClientMessage, { type: "button_press" }>): void {
    // Client packs button presses as an array of labels with an optional
    // sentences map. For routing we treat each as one event.
    const label = msg.buttons[0] || "";
    const sentence = msg.sentences?.[label] || label;
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
        this.currentBoardLabels = homePage.buttons
          .map((b: any) => b.label)
          .filter((l: any): l is string => typeof l === "string");
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

    // Non-home exits: treat as a button press with the AI-directed
    // instruction as the SENTENCE. The home buttons' instructions are
    // tagged ([INTERACT], [ASSIST], [BUILD], etc.) which gives Speaker
    // enough context to respond + Board Manager enough context to
    // produce the appropriate board.
    this.emitClientEvent({
      type: "button_pressed",
      source: "client",
      timestamp: Date.now(),
      label: msg.label,
      sentence: msg.instruction || msg.label,
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
    // Driving Board Manager directly — the builder state change IS the trigger.
    this.invokeBoardManager([]);
  }

  private handleGuessingState(
    msg: Extract<ClientMessage, { type: "guessing_state" }>,
  ): void {
    this.guessingState = {
      dimension: "",  // not in the wire shape; tracked by builder system
      offeredKeys: msg.suggestionKeys,
      questionHint: msg.text,
    };
    this.emitClientEvent({
      type: "guessing_entered",
      source: "client",
      timestamp: Date.now(),
    });
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

    switch (event.type) {
      case "button_pressed": {
        const rendered = `[${T.tagPress}] "${event.sentence}"`;
        this.observer?.sendContextInjection(rendered);
        this.speaker?.sendUserTurn(rendered);
        this.invokeBoardManager([event]);
        this.appendToConversationLog("user", rendered);
        return;
      }
      case "sentence_composed": {
        const rendered = `[${T.tagComposed}] "${event.sentence}"`;
        this.observer?.sendContextInjection(rendered);
        this.speaker?.sendUserTurn(rendered);
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
      case "guessing_entered":
      case "guessing_exited": {
        const rendered = `[${event.type.toUpperCase().replace(/_/g, " ")}]`;
        this.observer?.sendContextInjection(rendered);
        this.speaker?.sendContextInjection(rendered);
        this.invokeBoardManager([event]);
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
    const rendered = `[TRANSCRIPT] ${event.speaker} → ${event.direction}: "${event.text}"`;
    // Echo back to Observer for unified action log (per spec discussion).
    this.observer?.sendContextInjection(rendered);
    // Time-sensitive: no debounce. Direct to Speaker as a user turn (unless ambient).
    if (event.direction !== "ambient") {
      this.speaker?.sendUserTurn(rendered);
      this.appendToConversationLog("user", rendered);
    } else {
      this.speaker?.sendContextInjection(rendered);
    }
    this.invokeBoardManager([event]);
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
    this.invokeBoardManager(batch);
  }

  private routeEngagementChange(event: EngagementChangeEvent): void {
    let sleepStateLabel: "resting" | "awake" | "asleep" | "hibernation";
    switch (event.state) {
      case "rest": sleepStateLabel = "resting"; break;
      case "wake_up": sleepStateLabel = "awake"; break;
      case "sleep": sleepStateLabel = "asleep"; break;
      case "end_session": sleepStateLabel = "hibernation"; break;
    }
    this.send({
      type: "sleep_state_change",
      data: { state: sleepStateLabel, source: "ai" },
    });
    this.observer?.sendContextInjection(`[ENGAGEMENT] ${event.state}${event.reason ? ` — ${event.reason}` : ""}`);

    // Execute the actual profile transition. Fire-and-forget — failures
    // are logged inside transitionToProfile and must not block the bus.
    switch (event.state) {
      case "rest":
        void this.transitionToProfile("resting");
        return;
      case "wake_up":
        void this.transitionToProfile("awake");
        return;
      case "sleep":
        // Cost-saving close: tear down both Live sessions, keep the WS
        // open so the client can re-wake on activity. Coordinator stays
        // ready and can rebuild agents on the next client signal.
        try { this.observer?.close(); } catch {}
        try { this.speaker?.close(); } catch {}
        this.observer = null;
        this.speaker = null;
        return;
      case "end_session":
        // Full cleanup including WS close. Client should re-initialize
        // a fresh session on subsequent activity.
        this.cleanup(`end_session: ${event.reason || ""}`);
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Profile transitions (awake ↔ resting)
  // -------------------------------------------------------------------------

  /** Reconnect Observer + Speaker with the target profile's tool config
   *  and compression window. BoardManager has no persistent session;
   *  its next invocation just sees a smaller tool surface. */
  private async transitionToProfile(target: "awake" | "resting"): Promise<void> {
    if (this.sessionProfile === target) return;
    if (!this.observer || !this.speaker) {
      console.warn(`[AgentCoordinator] transitionToProfile(${target}): agents missing`);
      return;
    }

    const observerToolConfig: ObserverToolConfig = {
      ...this.observerToolConfigBase,
      restingMode: target === "resting",
    };
    const speakerToolConfig: SpeakerToolConfig = {
      ...this.speakerToolConfigBase,
      restingMode: target === "resting",
    };
    const triggerTokens = target === "resting" ? RESTING_COMPRESSION_TRIGGER : AWAKE_COMPRESSION_TRIGGER;
    const targetTokens = target === "resting" ? RESTING_COMPRESSION_TARGET : AWAKE_COMPRESSION_TARGET;

    runInSessionContext(this.sessionId!, this.debugMode, () => {
      logLiveSession("PROFILE_TRANSITION", `${this.sessionProfile} → ${target}`);
    });

    try {
      await Promise.all([
        this.observer.reconnectWithConfig({
          systemPrompt: this.observerPrompt,
          model: this.observerModel,
          toolConfig: observerToolConfig,
          useVertex: this.useVertex,
          compressionTriggerTokens: triggerTokens,
          compressionTargetTokens: targetTokens,
        }),
        this.speaker.reconnectWithConfig({
          systemPrompt: this.speakerPrompt,
          model: this.speakerModel,
          toolConfig: speakerToolConfig,
          useVertex: this.useVertex,
          voiceName: this.aiVoiceName,
          useDirectAudio: this.useDirectAudio,
          compressionTriggerTokens: triggerTokens,
          compressionTargetTokens: targetTokens,
        }),
      ]);
      this.sessionProfile = target;
      runInSessionContext(this.sessionId!, this.debugMode, () => {
        logLiveSession("PROFILE_TRANSITION_DONE", `now=${target}`);
      });
    } catch (err) {
      console.error(`[AgentCoordinator] transitionToProfile(${target}) failed:`, err);
      runInSessionContext(this.sessionId!, this.debugMode, () => {
        logLiveSession("PROFILE_TRANSITION_ERROR", `target=${target} err=${(err as Error).message}`);
      });
    }
  }

  private routeFocusRequest(event: FocusRequestEvent): void {
    this.send({ type: "focus_request", data: { reason: event.reason } });
    // Echo back so Observer doesn't request the same thing in rapid succession.
    this.observer?.sendContextInjection(`[FOCUS REQUESTED] ${event.reason}`);
  }

  // -------------------------------------------------------------------------
  // Speaker → bus
  // -------------------------------------------------------------------------

  private onSpeakerEvent(event: SpeakerOutputEvent): void {
    this.recordEvent(event);
    this.logEvent("SPEAKER", event);

    switch (event.type) {
      case "speech_start":
        this.onSpeakerSpeechStart();
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
      case "interpret_intent":
        this.routeInterpretIntent(event);
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

  private onSpeakerSpeechStart(): void {
    this.speakerSpeaking = true;
    if (this.micMuteReleaseTimer) {
      clearTimeout(this.micMuteReleaseTimer);
      this.micMuteReleaseTimer = null;
    }
    this.observer?.setMicMuted(true);
  }

  private onSpeakerSpeechEnd(event: SpeechEndEvent): void {
    this.speakerSpeaking = false;
    // Flush any remaining buffered PCM chunks so the tail of the
    // utterance reaches the client even when the timer hasn't fired yet.
    this.flushSpeakerAudio();
    // Schedule mic unmute with a tail to cover speaker decay.
    this.micMuteReleaseTimer = setTimeout(() => {
      this.observer?.setMicMuted(false);
      this.micMuteReleaseTimer = null;
    }, MIC_MUTE_TAIL_MS);

    if (event.transcript) {
      this.observer?.sendContextInjection(`[OWN_SPEECH] ${event.transcript}`);
      // Echo to Speaker so it has the transcript in its own history.
      this.speaker?.sendContextInjection(`[OWN_SPEECH] (you said) ${event.transcript}`);
      this.appendToConversationLog("assistant", event.transcript);
    }

    // Trigger Board Manager rebuild for the follow-up surface.
    this.invokeBoardManager([event]);
  }

  private routeEmoteChange(event: EmoteChangeEvent): void {
    this.send({ type: "emote", data: event.emote });
    this.speaker?.sendContextInjection(`[EMOTE] ${event.emote}`);
  }

  private routeModeChange(event: ModeChangeEvent): void {
    this.send({
      type: "interaction_mode_changed",
      data: { mode: event.mode, reason: event.reason, source: "ai" },
    });
    const rendered = `[MODE] ${event.mode}${event.reason ? ` — ${event.reason}` : ""}`;
    this.speaker?.sendContextInjection(rendered);
    this.observer?.sendContextInjection(rendered);
  }

  private routeInterpretIntent(event: InterpretIntentEvent): void {
    // Stream the user's interpreted sentence through student-voice TTS.
    void this.streamStudentTts(event.sentence);
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

  private async onSpeakerSpeakText(text: string): Promise<void> {
    if (!this.aiVoice) return;
    try {
      for await (const chunk of ttsFacade.synthesizeStream(text, this.aiVoice)) {
        this.send({ type: "avatar_audio", data: chunk.toString("base64"), format: "mp3" });
      }
    } catch (err) {
      console.error("[AgentCoordinator] AI TTS failed:", err);
    }
  }

  private async streamStudentTts(text: string): Promise<void> {
    if (!this.studentVoice) return;
    try {
      for await (const chunk of ttsFacade.synthesizeStream(text, this.studentVoice)) {
        this.send({ type: "utterance_audio", data: chunk.toString("base64") });
      }
    } catch (err) {
      console.error("[AgentCoordinator] student TTS failed:", err);
    }
  }

  // -------------------------------------------------------------------------
  // Board Manager invocation
  // -------------------------------------------------------------------------

  private async invokeBoardManager(triggeringEvents: AgentEvent[]): Promise<void> {
    if (!this.boardManager) return;
    if (this.boardMgrInFlight) {
      this.boardMgrPendingTriggers.push(...triggeringEvents);
      return;
    }
    this.boardMgrInFlight = true;
    try {
      const input: BoardManagerInvocationInput = {
        systemPrompt: this.boardManagerPrompt,
        toolConfig: this.boardManagerToolConfig,
        triggeringEvents,
        recentEvents: [...this.recentEvents],
        currentBoardLabels: [...this.currentBoardLabels],
        contextSidebarLabels: [...this.contextSidebarLabels],
        loadedBoardId: this.loadedBoardId,
        builderState: this.builderState ?? undefined,
        guessingState: this.guessingState ?? undefined,
        provider: BOARD_MANAGER_DEFAULT_PROVIDER,
        model: BOARD_MANAGER_DEFAULT_MODEL,
      };
      const result = await this.boardManager.invoke(input);
      // Track Board Manager HTTP usage (no modality details — text-only).
      if (result.usage) {
        this.trackLiveUsage("board-manager", BOARD_MANAGER_DEFAULT_PROVIDER, BOARD_MANAGER_DEFAULT_MODEL, {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
        });
      }
      for (const event of result.events) {
        this.onBoardManagerEvent(event);
      }
    } catch (err) {
      console.error("[AgentCoordinator] BoardManager invocation failed:", err);
    } finally {
      this.boardMgrInFlight = false;
      if (this.boardMgrPendingTriggers.length > 0) {
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
    // If a custom board is loaded (e.g. the home board pushed at init),
    // the client is in "custom board mode" and ignores `board` updates
    // until the custom board is unloaded. Mirror the legacy behavior of
    // sending `unload_board` first so the rebuild lands.
    if (this.loadedBoardId) {
      this.send({ type: "unload_board", data: {} });
      this.loadedBoardId = null;
    }
    // Update state mirror.
    this.currentBoardLabels = event.buttons.map(b => b.label);
    // Forward to client as a full board IR — the client expects
    // { grid, pages: [{ id, name, buttons: [...] }], currentPageId },
    // not the bare buttons[] we used to send.
    this.send({
      type: "board",
      data: buildBoardFromButtons(event.buttons),
    });
    // Resolve and queue symbol generation for any generate:KEY references.
    void this.applySymbolPipeline(event.buttons);
  }

  private applyContextButtonAdded(event: ContextButtonAddedEvent): void {
    this.contextSidebarLabels.push(event.button.label);
    if (this.contextSidebarLabels.length > 4) {
      this.contextSidebarLabels.shift();
    }
    // The client expects a flat object with label/iconRef/symbolPath/etc.
    // (not wrapped). Mirror the legacy LiveRelay's send shape.
    const b = event.button;
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
    void this.applySymbolPipeline([event.button]);
  }

  private applyBinaryChoiceShown(event: BinaryChoiceShownEvent): void {
    this.send({
      type: "binary_choice",
      data: { options: [event.option1, event.option2] },
    });
  }

  private applyBuilderSuggested(event: BuilderSuggestedEvent): void {
    // Map our typed event to the existing wire shape the AAC client expects.
    const toCandidate = (raw: string) => {
      const parsed = parseBoardButtons(raw);
      const b = parsed[0];
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
    console.log(`[AgentCoordinator] Monitor call: ${combinedReason}`);
    try {
      await dualAgentService.triggerMonitor(this.sessionId, /* force */ true);
      // Response is broadcast via state.onContextInjection which we wired up
      // in handleInitialize.
    } catch (err) {
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

    const rendered = `[MONITOR CONTEXT] ${text}`;
    this.observer?.sendContextInjection(rendered);
    this.speaker?.sendContextInjection(rendered);
    // Board Manager picks it up on its next invocation via recentEvents.
  }

  // -------------------------------------------------------------------------
  // Session summarizing
  // -------------------------------------------------------------------------

  /** Append a conversational turn to the rolling log and check whether a
   *  new summary is due. */
  private appendToConversationLog(role: "user" | "assistant", content: string): void {
    this.conversationLog.push({ role, content });
    this.maybeProduceSessionSummary();
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
    monitor
      .produceSessionSummary(this.currentSessionSummary, newMessages)
      .then((summary: string | undefined) => {
        this.summaryInFlight = false;
        if (!summary || summary === this.currentSessionSummary) {
          // Advance the marker so we don't re-summarize the same batch.
          this.summarizedMsgCount = markCount;
          return;
        }
        this.currentSessionSummary = summary;
        this.summarizedMsgCount = markCount;
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
        `${agent}:${model}`,  // prefix so cost rows are attributable per agent
        usage,
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
