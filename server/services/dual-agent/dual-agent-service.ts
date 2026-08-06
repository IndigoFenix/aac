// server/services/dual-agent/dual-agent-service.ts
// Main coordinator for the dual-agent AAC system

import { randomUUID } from "node:crypto";
import { db } from "../../db";
import { chatSessions, students, users, userStudents, medicalRecords } from "@shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { ChatMessage, ParsedBoardData, PermittedWebsite } from "@shared/schema";
import { mergeBoardWebsitesIntoPermitted } from "@shared/permitted-websites";
import { resolvePermittedYoutubeItems, splitYoutubeItems } from "@shared/youtube-items";
import { fetchRecentVideosForChannels, fetchRecentVideosForPlaylists } from "../youtube/channel-search";
import { creditsForModelUsage, creditsForLiveUsageByModality, creditsForTtsUsage, creditsForSttUsage, type TtsProvider } from "../chat/cost-helpers";
import { chargeCreditsToLedger } from "../credit-ledger";
import type { LLMProviderKey } from "@shared/llm-options";
import {
  InteractiveAgent,
  createInteractiveAgent,
} from "./interactive-agent";
import { MonitorAgent, createMonitorAgent } from "./monitor-agent";
import { settingsRepository } from "../../repositories/settingsRepository";
import { getChatProvider } from "../providers/provider-factory";
import type {
  AACMuteState,
  DualAgentConfig,
  DualAgentSessionState,
  PendingMessage,
} from "./types";
import { DEFAULT_CONFIG } from "./types";
import {
  buildInteractiveAgentPrompt,
  composeAacPersona,
} from "../memory-schema/aac-memory-schema";
import { ttsFacade, isClientSideTtsVoice, type ResolvedVoice } from "../voice/tts-facade";
import { voiceRecordRepository } from "../../repositories/voiceRecordRepository";
import { APP_REGISTRY, getDefaultEnabledApps, getEnabledAppsFromConfig, type AppConfig } from "./app-registry";
import { getContactsByStudent } from "../biometric";
import { boardRepository } from "../../repositories/boardRepository";
import { customSymbolRepository } from "../../repositories/customSymbolRepository";
import { classroomRepository } from "../../repositories/classroomRepository";
import { requireActiveConsent, ConsentGateError } from "../consent/consentGate";
import { activityLogService } from "../activityLogService";
import { logLiveSession } from "./dual-agent-logger";
import { buildBoardKeys } from "@shared/board-keys";
import { HOME_BOARD_KEY } from "./default-home-board";
import { flowCost } from "./agent-flow-logger";

/**
 * Simple promise-based mutex for per-session concurrency control.
 * Includes a timeout to prevent deadlocks if a holder never releases.
 */
class SessionMutex {
  private locked = false;
  private queue: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];
  private static readonly ACQUIRE_TIMEOUT_MS = 30_000; // 30s max wait

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove from queue and force-release
        const idx = this.queue.findIndex(e => e.timer === timer);
        if (idx >= 0) this.queue.splice(idx, 1);
        console.error("[SessionMutex] acquire() timed out after 30s — force-releasing");
        // Force unlock to prevent permanent deadlock
        this.locked = false;
        resolve(); // Let the caller proceed (with a logged warning)
      }, SessionMutex.ACQUIRE_TIMEOUT_MS);
      this.queue.push({ resolve, timer });
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      clearTimeout(next.timer);
      next.resolve();
    } else {
      this.locked = false;
    }
  }
}

/**
 * Get the native (built-in) button labels for the current page of a loaded custom board.
 * These buttons are "fixed" and cannot be removed by the AI.
 */
function getNativePageButtonLabels(state: DualAgentSessionState): string[] {
  if (!state.loadedBoardData) return [];
  const page = state.loadedBoardData.pages?.find(p => p.id === state.currentPageId)
    || state.loadedBoardData.pages?.[0];
  if (!page?.buttons) return [];
  return page.buttons.filter(b => b.label).map(b => b.label);
}

/** Compute age string from birthDate (e.g. "5", "12") */
function computeAge(birthDate: string | Date | null | undefined): string | undefined {
  if (!birthDate) return undefined;
  const bd = typeof birthDate === 'string' ? new Date(birthDate) : birthDate;
  if (isNaN(bd.getTime())) return undefined;
  const now = new Date();
  let age = now.getFullYear() - bd.getFullYear();
  const monthDiff = now.getMonth() - bd.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < bd.getDate())) age--;
  return age >= 0 ? String(age) : undefined;
}

/**
 * A board's cover art, in the two forms the AAC device can render: an emoji
 * `iconRef` or an image `symbolPath`. Mirrored onto `availableBoards` so a
 * board-launch button (`open.board`) can wear the board's own icon instead of
 * an invented one. The cover lives inside the IR blob, not as a column.
 */
function boardCoverFromIr(irData: unknown): { iconRef?: string; symbolPath?: string } | undefined {
  const cover = (irData as { coverImage?: { iconRef?: unknown; symbolPath?: unknown } } | null)?.coverImage;
  if (!cover) return undefined;
  const iconRef = typeof cover.iconRef === "string" && cover.iconRef.trim() ? cover.iconRef : undefined;
  const symbolPath = typeof cover.symbolPath === "string" && cover.symbolPath.trim() ? cover.symbolPath : undefined;
  if (!iconRef && !symbolPath) return undefined;
  return { ...(iconRef ? { iconRef } : {}), ...(symbolPath ? { symbolPath } : {}) };
}

/**
 * Cache for active dual-agent sessions
 * Key: sessionId, Value: session state and agents
 */
interface SessionCache {
  state: DualAgentSessionState;
  interactiveAgent: InteractiveAgent;
  monitorAgent: MonitorAgent;
  lastAccess: number;
  monitorMutex: SessionMutex;
  monitorRerunRequested?: boolean;
  /** Promise for the currently-running doMonitorProcessing pass (if any).
   *  Lets a caller (notably the session-close final pass) await the
   *  pending→log drain to completion instead of firing-and-forgetting. */
  monitorInFlight?: Promise<void>;
}

const sessionCache = new Map<string, SessionCache>();

// Cache TTL: 30 minutes
const CACHE_TTL = 30 * 60 * 1000;

// Monitor staleness timeout: 60 seconds (needs headroom for 2-round-trip LLM flow:
// first call returns tool calls for memory updates, second call generates text response)
const MONITOR_TIMEOUT_MS = 60_000;

// Monitor throttle: minimum interval between monitor calls (unless forced by [CALL_MONITOR])
const MONITOR_THROTTLE_MS = 120_000; // 2 minutes

/**
 * Clean up stale sessions from cache
 */
function cleanupCache(): void {
  const now = Date.now();
  for (const [sessionId, cached] of sessionCache.entries()) {
    if (now - cached.lastAccess > CACHE_TTL) {
      console.log("[DualAgentService] Evicting stale session:", sessionId);
      sessionCache.delete(sessionId);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupCache, 5 * 60 * 1000);

/**
 * Dual Agent Service
 *
 * Coordinates between Interactive and Monitor agents.
 * Handles session management, message routing, and state persistence.
 */
export class DualAgentService {
  private config: DualAgentConfig;

  constructor(config: Partial<DualAgentConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Persist a credit charge to chatSessions / students / users / userStudents.
   * Used by both the legacy HTTP path (aggregate tokens) and the Live API
   * path (modality-split tokens).
   *
   * Every id is optional: user-only charges (e.g. the standalone social
   * trainer, which has no chat_sessions row and no student) pass "" for
   * sessionId/studentId and only the user row updates.
   */
  private async persistCreditCharge(
    sessionId: string,
    studentId: string,
    userId: string | undefined,
    credits: number,
    logSuffix: string,
    category: string,
    modalityBreakdown?: Record<string, number>,
    tokenUsage?: import("../credit-ledger").LedgerCharge["tokenUsage"],
  ): Promise<void> {
    flowCost(category, credits, logSuffix);
    await chargeCreditsToLedger({ sessionId, studentId, userId, credits, category, label: logSuffix, modalityBreakdown, tokenUsage });
  }

  /**
   * Track credits for a Live API turn with modality-separated token counts.
   * Called per `usageMetadata` event from the provider.
   */
  async trackLiveUsage(
    sessionId: string,
    studentId: string,
    userId: string | undefined,
    provider: LLMProviderKey,
    model: string,
    usage: import("./live-provider").LiveUsage,
    // Human-readable attribution for the cost LOG only (e.g. "board-manager").
    // MUST NOT be folded into `model` — `model` has to stay a catalog id so
    // pricing resolves the real rates instead of falling back.
    label?: string,
  ): Promise<number> {
    let credits: number;
    let logSuffix: string;
    // Per-modality credit split (Phase 0 measurement) — only available when the
    // provider reported modality detail. Accumulated into
    // chat_sessions.cost_modality_breakdown alongside the per-agent breakdown.
    let modalityBreakdown: Record<string, number> | undefined;
    // Token detail for the per-charge session_cost_events time-series. For the
    // modality path, input/output modalities are folded into prompt/completion.
    let tokenUsage: import("../credit-ledger").LedgerCharge["tokenUsage"];
    const attr = label ? `agent=${label} ` : "";
    if (usage.details) {
      const split = creditsForLiveUsageByModality(provider, model, usage.details);
      credits = split.textIn + split.cachedIn + split.nonTextIn + split.textOut + split.audioOut;
      modalityBreakdown = {
        textIn: split.textIn,
        cachedIn: split.cachedIn,
        nonTextIn: split.nonTextIn,
        textOut: split.textOut,
        audioOut: split.audioOut,
      };
      const d = usage.details;
      tokenUsage = {
        model,
        promptTokens: (d.textInputTokens ?? 0) + (d.nonTextInputTokens ?? 0),
        completionTokens: (d.textOutputTokens ?? 0) + (d.audioOutputTokens ?? 0),
        cachedTokens: d.cachedInputTokens ?? 0,
      };
      logSuffix =
        `${attr}model=${model} ` +
        `text_in=${d.textInputTokens} non_text_in=${d.nonTextInputTokens} ` +
        `text_out=${d.textOutputTokens} audio_out=${d.audioOutputTokens}` +
        (d.cachedInputTokens ? ` cached=${d.cachedInputTokens}` : "");
    } else {
      credits = creditsForModelUsage(
        provider, model, usage.promptTokens, usage.completionTokens,
        usage.cachedTokens ?? 0, usage.cacheCreationTokens ?? 0,
      );
      tokenUsage = {
        model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cachedTokens: usage.cachedTokens ?? 0,
        cacheCreationTokens: usage.cacheCreationTokens ?? 0,
      };
      logSuffix = `${attr}model=${model} prompt=${usage.promptTokens} completion=${usage.completionTokens}`
        + (usage.cachedTokens ? ` cacheRead=${usage.cachedTokens}` : "")
        + (usage.cacheCreationTokens ? ` cacheWrite=${usage.cacheCreationTokens}` : "")
        + ` (no-modality-details)`;
    }
    await this.persistCreditCharge(sessionId, studentId, userId, credits, logSuffix, label ?? "live", modalityBreakdown, tokenUsage);
    return credits;
  }

  /**
   * Track credits for a non-Live HTTP completion turn — used by the
   * Monitor's thoroughStartup and produceSessionSummary calls (which go
   * through GPT.getStructuredResponse, not the Live API). Computes credits
   * from the same per-1M-token catalog as `creditsForModelUsage`.
   */
  async trackHttpUsage(
    sessionId: string,
    studentId: string,
    userId: string | undefined,
    provider: LLMProviderKey,
    model: string,
    promptTokens: number,
    completionTokens: number,
    cachedTokens: number = 0,
    label: string = "http",
    cacheCreationTokens: number = 0,
  ): Promise<void> {
    const credits = creditsForModelUsage(provider, model, promptTokens, completionTokens, cachedTokens, cacheCreationTokens);
    const logSuffix = `model=${model} prompt=${promptTokens} completion=${completionTokens}`
      + (cachedTokens ? ` cacheRead=${cachedTokens}` : "")
      + (cacheCreationTokens ? ` cacheWrite=${cacheCreationTokens}` : "")
      + ` [${label}]`;
    await this.persistCreditCharge(sessionId, studentId, userId, credits, logSuffix, label, undefined, {
      model, promptTokens, completionTokens, cachedTokens, cacheCreationTokens,
    });
  }

  /**
   * Track credits for one TTS synthesis. Charged per character — actual
   * audio duration doesn't affect provider billing. Called from the
   * Coordinator's `streamStudentTts` once per synthesis after the facade
   * reports which provider actually rendered the audio (the facade may
   * fall back through several providers; only the final one bills).
   */
  async trackTtsUsage(
    sessionId: string,
    studentId: string,
    userId: string | undefined,
    provider: TtsProvider,
    characters: number,
  ): Promise<void> {
    if (characters <= 0) return;
    const credits = creditsForTtsUsage(provider, characters);
    const logSuffix = `tts provider=${provider} chars=${characters}`;
    await this.persistCreditCharge(sessionId, studentId, userId, credits, logSuffix, "tts");
  }

  /**
   * Track credits for one server-side speech-to-text (Google Cloud STT) run,
   * billed by the audio duration of the transcribed clip. Cost saving (Phase 1):
   * far cheaper than the Gemini-Live audio re-billing it replaces.
   */
  async trackSttUsage(
    sessionId: string,
    studentId: string,
    userId: string | undefined,
    seconds: number,
  ): Promise<void> {
    if (seconds <= 0) return;
    const credits = creditsForSttUsage(seconds);
    const logSuffix = `stt seconds=${seconds.toFixed(1)}`;
    await this.persistCreditCharge(sessionId, studentId, userId, credits, logSuffix, "stt");
  }

  /**
   * Resolve voice settings from a cached session's student data.
   * Fetches custom voice records in parallel when FK is set.
   * Returns ResolvedVoice objects that the TTS facade uses to route to the correct provider.
   */
  private async resolveVoices(cached: SessionCache): Promise<{
    aiVoice: ResolvedVoice;
    studentVoice: ResolvedVoice;
  }> {
    const student = cached.monitorAgent.getStudent();
    const aac = student?.aacSettings;
    const [aiCustom, studentCustom] = await Promise.all([
      aac?.customVoiceId
        ? voiceRecordRepository.getVoiceById(aac.customVoiceId)
        : Promise.resolve(undefined),
      aac?.customStudentVoiceId
        ? voiceRecordRepository.getVoiceById(aac.customStudentVoiceId)
        : Promise.resolve(undefined),
    ]);

    // Derive voice types from student gender:
    // Student gets a voice matching their gender, AI gets a different female voice.
    const gender = (student as any)?.gender as string | undefined;
    const studentFallback = gender === "female" ? "girl" : "boy";
    const aiFallback = "woman"; // AI always uses a distinct female voice
    const defaultStudentGeminiVoice = gender === "female" ? "Leda" : "Puck";
    const defaultAiGeminiVoice = "Zephyr";

    // ElevenLabs can be toggled off without removing the stored config
    const elEnabled = aac?.elevenlabsEnabled !== false;

    return {
      // AI voice: in live mode the model speaks directly via Gemini native
      // audio, so the ElevenLabs fields below are currently inert. Kept wired
      // so the non-direct-audio fallback path can be re-enabled later without
      // re-plumbing.
      aiVoice: {
        fallbackType: aiFallback,
        customVoice: aiCustom || null,
        language: student?.primaryLanguage || "en",
        elevenlabsApiKey: elEnabled ? (aac?.elevenlabsApiKey || undefined) : undefined,
        elevenlabsVoiceId: elEnabled ? (aac?.elevenlabsAiVoiceId || undefined) : undefined,
        geminiVoiceName: (aac as any)?.geminiAiVoice || defaultAiGeminiVoice,
      },
      // Student voice goes through ttsFacade. ElevenLabs (when configured)
      // takes precedence; otherwise the LiveRelay attaches a persistent
      // Gemini Live TTS session after resolution; Google Cloud TTS is the
      // final fallback.
      studentVoice: {
        fallbackType: studentFallback as any,
        customVoice: studentCustom || null,
        language: student?.primaryLanguage || "en",
        elevenlabsApiKey: elEnabled ? (aac?.elevenlabsApiKey || undefined) : undefined,
        elevenlabsVoiceId: elEnabled ? (aac?.elevenlabsStudentVoiceId || undefined) : undefined,
        geminiVoiceName: (aac as any)?.geminiStudentVoice || defaultStudentGeminiVoice,
      },
    };
  }

  /**
   * Check whether a resolved voice should be synthesised client-side.
   * True when the student has configured their own ElevenLabs API key AND
   * a voice ID for this role — the client will call ElevenLabs directly
   * for stutter-free, lower-latency playback.
   */
  private isClientTts(voice: ResolvedVoice): boolean {
    // Shared with AgentCoordinator's client-direct path — one definition of
    // "safe to synthesize on the device" so the two can't drift apart.
    return isClientSideTtsVoice(voice);
  }

  /**
   * Yield TTS output for a piece of text.
   * If the voice is client-side ElevenLabs, yield a lightweight `client_tts`
   * event so the browser can call ElevenLabs directly.
   * Otherwise, synthesise server-side and yield audio chunks.
   */
  private async *yieldTts<T extends "audio" | "utterance_audio">(
    text: string,
    voice: ResolvedVoice,
    eventType: T,
    voiceRole: "ai" | "student",
  ): AsyncGenerator<{ type: T | "client_tts"; data: any; voiceRole?: string; text?: string }> {
    if (this.isClientTts(voice)) {
      yield {
        type: "client_tts" as const,
        data: {
          text,
          voiceId: voice.elevenlabsVoiceId,
          apiKey: voice.elevenlabsApiKey,
          language: voice.language || "en",
          voiceRole,
        },
      };
    } else {
      for await (const chunk of ttsFacade.synthesizeStream(text, voice)) {
        yield { type: eventType, data: chunk.toString("base64") };
      }
    }
  }

  /**
   * Initialize or resume a dual-agent session
   */
  async initializeSession(
    studentId: string,
    userId?: string,
    existingSessionId?: string,
    muteState: AACMuteState = 'unmuted',
    localState?: import("@shared/aac-local-storage").AacSessionSnapshot,
    timezone?: string,
    classroomId?: string,
    gps?: import("@shared/location-matching").GpsReading,
    // Optional startup-progress hook: invoked before slow startup phases so the
    // caller (AgentCoordinator) can surface a localized "waking up" subtitle.
    // Only fires on the fresh-session path (cache/DB resumes are instant).
    onProgress?: (stage: import("./live-relay").StartupStage) => void,
  ): Promise<DualAgentSessionState> {
    // Consent gate — runs even on resume so a session opened against an
    // active consent stops working once that consent is revoked.
    // No-op when CONSENT_GATE_ENABLED is unset; honors legacy grace.
    await requireActiveConsent(studentId);

    // Check cache first. GUARD: a resumed session MUST belong to the same
    // student we're (re)connecting for. The client round-trips its sessionId
    // across reconnects; a stale id left over from a previous student (device
    // handed off, student switch) must never resume the wrong student's
    // conversation. On mismatch, ignore the id and start fresh.
    if (existingSessionId && sessionCache.has(existingSessionId)) {
      const cached = sessionCache.get(existingSessionId)!;
      if (cached.state.studentId === studentId) {
        cached.lastAccess = Date.now();
        // Refresh TZ / GPS on resume in case the client moved.
        if (timezone) cached.monitorAgent.setTimezone?.(timezone);
        if (gps) cached.monitorAgent.setGps?.(gps);
        console.log("[DualAgentService] Resuming cached session:", existingSessionId);
        return cached.state;
      }
      console.warn(
        `[DualAgentService] Ignoring cached-session resume — student mismatch (session student=${cached.state.studentId}, requested=${studentId})`,
      );
    }

    // Try to load from database (same student-match guard).
    if (existingSessionId) {
      const dbSession = await this.loadSessionFromDB(existingSessionId);
      if (dbSession && dbSession.studentId === studentId) {
        console.log("[DualAgentService] Resuming session from DB:", existingSessionId);
        return dbSession;
      }
      if (dbSession) {
        console.warn(
          `[DualAgentService] Ignoring DB-session resume — student mismatch (session student=${dbSession.studentId}, requested=${studentId})`,
        );
      }
    }

    // Try to rebuild from client-provided local state (fallback when DB is empty/stale)
    if (localState && localState.studentId === studentId) {
      console.log("[DualAgentService] Rebuilding session from client local state:", localState.sessionId);
      return this.rebuildFromLocalState(studentId, userId, localState, classroomId, onProgress);
    }

    // Create new session
    console.log("[DualAgentService] Creating new session for student:", studentId);
    return this.createNewSession(studentId, userId, muteState, timezone, classroomId, gps, onProgress);
  }

  /**
   * Create a new dual-agent session
   */
  private async createNewSession(
    studentId: string,
    userId?: string,
    muteState: AACMuteState = 'unmuted',
    timezone?: string,
    classroomId?: string,
    gps?: import("@shared/location-matching").GpsReading,
    onProgress?: (stage: import("./live-relay").StartupStage) => void,
  ): Promise<DualAgentSessionState> {
    // Fetch AAC chat LLM config from DB
    const aacChatConfig = await settingsRepository.getLLMConfig('aac_chat');
    this.config.interactiveModel = aacChatConfig.model;
    this.config.interactiveProvider = aacChatConfig.provider;
    const chatProvider = getChatProvider(aacChatConfig.provider);

    // Mint a proper UUID for the new session up front and hand it to the
    // Monitor, instead of letting the Monitor fall back to its
    // `aac-${Date.now()}` placeholder. The timestamp fallback both looked
    // inconsistent next to clinician sessions (which use gen_random_uuid)
    // AND collided when two sessions initialized in the same millisecond —
    // saveSessionToDB then UPDATEd the existing row, so one session silently
    // clobbered the other's log. A UUID removes both problems; the Monitor's
    // fallback remains only as a true last resort.
    const newSessionId = randomUUID();

    // Create Monitor agent first to initialize
    const monitorAgent = createMonitorAgent(
      studentId,
      this.config,
      userId,
      newSessionId,
    );
    // Apply timezone + GPS before initializeSession so event-window and
    // location-context computation in thoroughStartup use them.
    if (timezone) monitorAgent.setTimezone(timezone);
    if (gps) monitorAgent.setGps(gps);

    const defaultApps = getDefaultEnabledApps();
    const enabledAppDefs = APP_REGISTRY.filter(a => defaultApps.includes(a.id));

    // Kick off the per-student context prefetches CONCURRENTLY with the
    // thorough-startup enhancer LLM below. None of them depend on the
    // enhancer's output or the Monitor's loaded student — they key only on
    // the student / user / classroom IDs we already have — so issuing them in
    // parallel with the (2-4s) LLM call takes them off the critical path
    // instead of running serially after it. Each task keeps its own try/catch
    // and degrades to the same empty/None result as before.
    const contactsPromise = (async (): Promise<NonNullable<DualAgentSessionState['cachedContacts']>> => {
      try {
        const contacts = await getContactsByStudent(studentId);
        return contacts.map(c => ({
          id: c.id, name: c.name, relationship: c.relationship || undefined, hasFaceImage: true,
        }));
      } catch { return []; }
    })();

    const symbolsPromise = (async (): Promise<NonNullable<DualAgentSessionState['cachedSymbols']>> => {
      try {
        const symbols = await customSymbolRepository.getAvailableSymbolsForStudent(studentId);
        return symbols.map(s => ({ id: s.id, key: s.key, description: s.description }));
      } catch { return []; }
    })();

    const diagnosisPromise = (async (): Promise<string | null> => {
      try {
        const [record] = await db.select({ primaryDiagnosis: medicalRecords.primaryDiagnosis })
          .from(medicalRecords)
          .where(eq(medicalRecords.studentId, studentId))
          .limit(1);
        return record?.primaryDiagnosis || null;
      } catch { return null; }
    })();

    // Classroom context when this session runs on a shared classroom device.
    // The roster (with short per-student entries) is injected into the system
    // prompt so the AI can reframe when the active student changes. Skipped
    // silently in single-student mode.
    const classroomPromise = (async (): Promise<Parameters<typeof buildInteractiveAgentPrompt>[0]['classroom']> => {
      if (!classroomId) return undefined;
      try {
        const classroom = await classroomRepository.getClassroomById(classroomId);
        if (classroom && classroom.isActive) {
          const rosterRows = await classroomRepository.getStudentsInClassroom(classroomId);
          // Batch-fetch primary diagnosis for the whole roster in one query.
          const rosterIds = rosterRows.map(r => r.student.id);
          const diagByStudent = new Map<string, string>();
          if (rosterIds.length > 0) {
            const diagRows = await db
              .select({ studentId: medicalRecords.studentId, primaryDiagnosis: medicalRecords.primaryDiagnosis })
              .from(medicalRecords)
              .where(inArray(medicalRecords.studentId, rosterIds));
            for (const row of diagRows) {
              if (row.primaryDiagnosis) diagByStudent.set(row.studentId, row.primaryDiagnosis);
            }
          }
          return {
            name: classroom.name,
            grade: classroom.grade || undefined,
            description: classroom.description || undefined,
            roster: rosterRows.map(({ student, enrollment }) => ({
              id: student.id,
              name: student.firstName || student.name?.split(' ')[0] || student.name || '?',
              age: computeAge(student.birthDate),
              gender: student.gender || undefined,
              diagnosis: diagByStudent.get(student.id),
              notes: enrollment.notes || undefined,
              isActive: student.id === studentId,
            })),
          };
        }
      } catch (err) {
        console.warn("[DualAgentService] Failed to fetch classroom context:", err);
      }
      return undefined;
    })();

    // Auto-selectable boards. Keyed on the STUDENT, not the signed-in account:
    // the device runs under whichever caretaker is logged in, who is usually
    // not the clinician who authored the boards.
    const boardsPromise = (async (): Promise<NonNullable<DualAgentSessionState['availableBoards']>> => {
      try {
        const boards = await boardRepository.getAutoSelectableBoardsWithPackages(studentId);
        const keys = buildBoardKeys(boards.map(b => ({ id: b.id, name: b.name, packageName: b.packageName })), [HOME_BOARD_KEY]);
        const mapped = boards.map(b => {
          const irData = b.irData as any;
          const grid = irData?.grid || { rows: 3, cols: 4 };
          return { id: b.id, key: keys.get(b.id)!, name: b.name, hint: b.automaticSelectionHint || undefined, isGenerated: b.isGenerated ?? false, packageName: b.packageName, grid, coverImage: boardCoverFromIr(irData) };
        });
        logLiveSession("AVAILABLE_BOARDS", `loaded ${mapped.length} auto-selectable board(s) (createNewSession, user=${userId} student=${studentId}) — [${mapped.map(b => b.key).join(", ")}]`);
        return mapped;
      } catch (err) {
        // Was silently swallowed — surface it: a throw here (e.g. irData
        // hydration) is indistinguishable from "no boards" downstream.
        logLiveSession("AVAILABLE_BOARDS", `getAutoSelectableBoards THREW (createNewSession, user=${userId} student=${studentId}): ${(err as Error)?.message ?? err}`);
        return [];
      }
    })();

    // Initialize session - Monitor searches memory and creates base prompt.
    // Runs concurrently with the prefetches started above.
    const initResult = await monitorAgent.initializeSession(muteState, enabledAppDefs, onProgress);

    // Bill credits for the thorough-startup enhancer if it fired. The
    // session ID is the one Monitor created/loaded above; we use it
    // directly since `state.sessionId` isn't built until later.
    if (initResult.enhancerUsage) {
      const u = initResult.enhancerUsage;
      this.trackHttpUsage(
        initResult.sessionId,
        studentId,
        userId,
        u.provider,
        u.model,
        u.promptTokens,
        u.completionTokens,
        u.cachedTokens ?? 0,
        "monitor-startup-enhancer",
        u.cacheCreationTokens ?? 0,
      ).catch(err => console.error("[DualAgentService] trackHttpUsage(enhancer) failed:", err));
    }

    // Collect the prefetches (already in flight during the LLM call above).
    const cachedContacts = await contactsPromise;
    const cachedSymbols = await symbolsPromise;
    const cachedDiagnosis = await diagnosisPromise;
    const classroomContext = await classroomPromise;
    const availableBoards = await boardsPromise;

    // Build the function-calling prompt with contacts + boards + symbols + demographics.
    // If thorough startup produced structured sections, weave each one into
    // the prompt at the appropriate location (persona, session_goals,
    // gesture_overrides, localized_examples, safety_notes). Otherwise fall
    // back to the raw clinician persona.
    let interactivePrompt = "";
    const student = monitorAgent.getStudent?.();
    if (student) {
      const rawPersona = composeAacPersona({
        custom: student.aacSettings?.chatAgentPrompt,
        auto: student.aacSettings?.autoAacPrompt,
      });
      const sections = initResult.enhancedSections;
      const persona = sections?.persona || rawPersona;
      const { channels: ytChannels, playlists: ytPlaylists, videos: ytVideos } =
        splitYoutubeItems(resolvePermittedYoutubeItems(student.aacSettings));
      // Both are independent network fetches — run them concurrently.
      const [ytChannelVideos, ytPlaylistVideos] = await Promise.all([
        ytChannels.length > 0 ? fetchRecentVideosForChannels(ytChannels) : Promise.resolve(undefined),
        ytPlaylists.length > 0 ? fetchRecentVideosForPlaylists(ytPlaylists) : Promise.resolve(undefined),
      ]);
      interactivePrompt = buildInteractiveAgentPrompt({
        studentName: student.firstName || student.name?.split(' ')[0] || "",
        persona,
        language: student.primaryLanguage || undefined,
        // Always populate <memory> — enhancer sections are stylistic guidance;
        // the ground-truth interests/notes/people listing must remain visible
        // to the live AI as the authoritative source.
        memoryContext: initResult.initialContext,
        muteState,
        studentAge: computeAge(student.birthDate),
        studentGender: student.gender || undefined,
        studentDiagnosis: cachedDiagnosis || undefined,
        aiName: student.aacSettings?.aiName || undefined,
        knownContacts: cachedContacts.length > 0 ? cachedContacts : undefined,
        availableBoards: availableBoards.length > 0 ? availableBoards : undefined,
        cachedSymbols: cachedSymbols.length > 0 ? cachedSymbols : undefined,
        enabledApps: enabledAppDefs.map(a => ({ id: a.id, name: a.name, description: a.description })),
        permittedWebsites: Array.isArray(student.aacSettings?.permittedWebsites)
          ? (student.aacSettings!.permittedWebsites as PermittedWebsite[])
          : undefined,
        permittedYoutubeChannels: ytChannels.length > 0 ? ytChannels : undefined,
        permittedYoutubeVideos: ytVideos.length > 0 ? ytVideos : undefined,
        permittedYoutubePlaylists: ytPlaylists.length > 0 ? ytPlaylists : undefined,
        youtubeChannelVideos: ytChannelVideos,
        youtubePlaylistVideos: ytPlaylistVideos,
        autoSymbolsEnabled: !!(student.aacSettings?.generateSymbols || student.aacSettings?.useApprovedSymbols || student.aacSettings?.useUnapprovedSymbols),
        singleGlyphButtons: !!student.aacSettings?.singleGlyphButtons,
        sessionGoals: sections?.sessionGoals,
        personaGestureOverrides: sections?.gestureOverrides,
        interactModeExamples: sections?.interactModeExamples,
        assistModeExamples: sections?.assistModeExamples,
        sentenceInterpretationExamples: sections?.sentenceInterpretationExamples,
        safetyNotes: sections?.safetyNotes,
        classroom: classroomContext,
      });
    }

    // Create Interactive agent with the complete prompt
    const interactiveAgent = createInteractiveAgent(
      interactivePrompt,
      this.config,
      chatProvider
    );

    // Determine whether to persist session data to the database.
    // Disabled when remoteStorageEnabled is false OR notes are disabled.
    const aacSt = monitorAgent.getStudent?.()?.aacSettings;
    const remoteStorageEnabled = (aacSt?.remoteStorageEnabled ?? true) && (aacSt?.allowNotes ?? true);
    const permittedWebsites: PermittedWebsite[] = Array.isArray(aacSt?.permittedWebsites)
      ? (aacSt!.permittedWebsites as PermittedWebsite[])
      : [];
    const {
      channels: permittedYoutubeChannels,
      playlists: permittedYoutubePlaylists,
      videos: permittedYoutubeVideos,
    } = splitYoutubeItems(resolvePermittedYoutubeItems(aacSt));

    // Create session state
    const state: DualAgentSessionState = {
      sessionId: initResult.sessionId,
      studentId,
      userId,
      classroomId,
      interactivePrompt,
      monitorBusy: false,
      messages: [],
      pendingMessages: [],
      muteState,
      appState: { enabledApps: getEnabledAppsFromConfig(aacSt?.appConfig as AppConfig | null), activeApp: null },
      permittedWebsites,
      permittedYoutubeChannels,
      permittedYoutubeVideos,
      permittedYoutubePlaylists,
      currentEmote: "happy",
      boardButtonLabels: [],
      aiAddedButtonLabels: [],
      lastInteractiveActivity: Date.now(),
      lastMonitorActivity: Date.now(),
      monitorConsecutiveFailures: 0,
      cachedContacts,
      cachedSymbols,
      availableBoards,
      cachedDiagnosis,
      memoryContext: initResult.initialContext,
      enhancedSections: initResult.enhancedSections,
      privacyOptions: monitorAgent.getPrivacyOptions(),
      remoteStorageEnabled,
    };

    // Save to database (only if remote storage is enabled)
    if (remoteStorageEnabled) {
      await this.saveSessionToDB(state);
    }

    // Cache the session
    sessionCache.set(state.sessionId, {
      state,
      interactiveAgent,
      monitorAgent,
      lastAccess: Date.now(),
      monitorMutex: new SessionMutex(),
    });

    return state;
  }

  /**
   * Rebuild a session from client-provided local state.
   * Used when the database session is missing/stale but the client has a cached snapshot.
   * Creates a fresh session seeded with the local state's messages and board data.
   */
  private async rebuildFromLocalState(
    studentId: string,
    userId: string | undefined,
    localState: import("@shared/aac-local-storage").AacSessionSnapshot,
    classroomId?: string,
    onProgress?: (stage: import("./live-relay").StartupStage) => void,
  ): Promise<DualAgentSessionState> {
    // Create a new session like normal, but seed it with local state data
    const state = await this.createNewSession(
      studentId,
      userId,
      localState.muteState || 'unmuted',
      undefined,
      classroomId,
      undefined,
      onProgress,
    );

    // Overlay messages and board state from local snapshot
    if (localState.messages?.length) {
      state.messages = localState.messages;
    }
    if (localState.pendingMessages?.length) {
      state.pendingMessages = localState.pendingMessages.map(pm => ({
        role: pm.role,
        content: pm.content,
        timestamp: pm.timestamp,
      }));
    }
    if (localState.currentBoard) {
      state.currentBoard = localState.currentBoard;
    }
    if (localState.boardButtonLabels?.length) {
      state.boardButtonLabels = localState.boardButtonLabels;
    }
    if (localState.aiAddedButtonLabels?.length) {
      state.aiAddedButtonLabels = localState.aiAddedButtonLabels;
    }
    if (localState.loadedBoardId) {
      state.loadedBoardId = localState.loadedBoardId;
    }
    if (localState.currentPageId) {
      state.currentPageId = localState.currentPageId;
    }

    // Re-save the session with the local state data
    await this.saveSessionToDB(state);

    console.log("[DualAgentService] Session rebuilt from local state:",
      state.sessionId, "messages:", state.messages.length);

    return state;
  }

  /**
   * Load a session from the database
   */
  private async loadSessionFromDB(
    sessionId: string
  ): Promise<DualAgentSessionState | null> {
    try {
      const [session] = await db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, sessionId))
        .limit(1);

      if (!session) {
        return null;
      }

      // Check for stale monitorBusy flag (server crashed during processing)
      let monitorBusy = session.monitorBusy || false;
      let monitorBusySince = session.monitorBusySince?.getTime();

      if (monitorBusy && monitorBusySince) {
        if (Date.now() - monitorBusySince > MONITOR_TIMEOUT_MS) {
          console.log("[DualAgentService] Resetting stale monitorBusy flag:", sessionId);
          monitorBusy = false;
          monitorBusySince = undefined;
          // Clear in DB (fire-and-forget)
          this.updateMonitorBusy(sessionId, false, null).catch(console.error);
        }
      }

      // Extract state from session
      const chatState = session.state as any;
      const state: DualAgentSessionState = {
        sessionId: session.id,
        studentId: session.studentId || "",
        userId: session.userId || undefined,
        classroomId: session.classroomId || undefined,
        interactivePrompt: session.interactivePrompt || "",
        monitorBusy,
        monitorBusySince,
        messages: chatState?.history || [],
        pendingMessages: (session.pendingMessages as PendingMessage[]) || [],
        muteState: (chatState as any)?.muteState || 'unmuted',
        appState: { enabledApps: getDefaultEnabledApps(), activeApp: null }, // Updated with appConfig below
        permittedWebsites: [], // Populated with aacSettings below
        permittedYoutubeChannels: [], // Populated with aacSettings below
        permittedYoutubeVideos: [], // Populated with aacSettings below
        permittedYoutubePlaylists: [], // Populated with aacSettings below
        currentEmote: "neutral",
        boardButtonLabels: [],
        aiAddedButtonLabels: [],
        lastInteractiveActivity: Date.now(),
        lastMonitorActivity: Date.now(),
        monitorConsecutiveFailures: 0,
        memoryContext: chatState?.memoryContext,
        enhancedSections: chatState?.enhancedSections,
        sessionSummary: chatState?.sessionSummary,
        summarizedMsgCount: chatState?.summarizedMsgCount,
        remoteStorageEnabled: true, // If loaded from DB, storage was enabled
      };

      // Fetch AAC chat LLM config from DB
      const aacChatConfig = await settingsRepository.getLLMConfig('aac_chat');
      this.config.interactiveModel = aacChatConfig.model;
      this.config.interactiveProvider = aacChatConfig.provider;
      const chatProvider = getChatProvider(aacChatConfig.provider);

      // Recreate agents
      const monitorAgent = createMonitorAgent(
        state.studentId,
        this.config,
        state.userId,
        sessionId
      );

      // Ensure monitor has student data (since initializeSession wasn't called)
      await monitorAgent.ensureStudentLoaded();

      // Update remote storage flag and enabled apps from current settings
      const student = monitorAgent.getStudent();
      if (student) {
        const aacSt = student.aacSettings;
        state.remoteStorageEnabled = (aacSt?.remoteStorageEnabled ?? true) && (aacSt?.allowNotes ?? true);
        state.appState.enabledApps = getEnabledAppsFromConfig(aacSt?.appConfig as AppConfig | null);
        state.permittedWebsites = Array.isArray(aacSt?.permittedWebsites)
          ? (aacSt!.permittedWebsites as PermittedWebsite[])
          : [];
        const splitYt = splitYoutubeItems(resolvePermittedYoutubeItems(aacSt));
        state.permittedYoutubeChannels = splitYt.channels;
        state.permittedYoutubeVideos = splitYt.videos;
        state.permittedYoutubePlaylists = splitYt.playlists;
      }

      // Rebuild prompt with correct enabledApps (the stored prompt may have stale app info)
      if (student) {
        const rawPersona = composeAacPersona({
          custom: student.aacSettings?.chatAgentPrompt,
          auto: student.aacSettings?.autoAacPrompt,
        });
        const sections = state.enhancedSections;
        const personaPrompt = sections?.persona || rawPersona;
        const enabledApps = APP_REGISTRY.filter(a => state.appState.enabledApps.includes(a.id));

        // Fetch and cache contacts for prompt
        try {
          const contacts = await getContactsByStudent(state.studentId);
          state.cachedContacts = contacts.map(c => ({
            id: c.id, name: c.name, relationship: c.relationship || undefined, hasFaceImage: true,
          }));
        } catch { state.cachedContacts = []; }

        // Fetch and cache custom symbols for prompt
        try {
          const symbols = await customSymbolRepository.getAvailableSymbolsForStudent(state.studentId);
          state.cachedSymbols = symbols.map(s => ({ id: s.id, key: s.key, description: s.description }));
        } catch { state.cachedSymbols = []; }

        // Fetch primary diagnosis
        try {
          const [record] = await db.select({ primaryDiagnosis: medicalRecords.primaryDiagnosis })
            .from(medicalRecords)
            .where(eq(medicalRecords.studentId, state.studentId))
            .limit(1);
          state.cachedDiagnosis = record?.primaryDiagnosis || null;
        } catch { state.cachedDiagnosis = null; }

        // Load auto-selectable boards (student-scoped — see createNewSession)
        try {
          const boards = await boardRepository.getAutoSelectableBoardsWithPackages(state.studentId);
          const keys = buildBoardKeys(boards.map(b => ({ id: b.id, name: b.name, packageName: b.packageName })), [HOME_BOARD_KEY]);
          state.availableBoards = boards.map(b => {
            const irData = b.irData as any;
            const grid = irData?.grid || { rows: 3, cols: 4 };
            return { id: b.id, key: keys.get(b.id)!, name: b.name, hint: b.automaticSelectionHint || undefined, isGenerated: b.isGenerated ?? false, packageName: b.packageName, grid, coverImage: boardCoverFromIr(irData) };
          });
          logLiveSession("AVAILABLE_BOARDS", `loaded ${state.availableBoards.length} auto-selectable board(s) (loadSessionFromDB, user=${state.userId} student=${state.studentId}) — [${state.availableBoards.map(b => b.key).join(", ")}]`);
        } catch (err) {
          state.availableBoards = [];
          logLiveSession("AVAILABLE_BOARDS", `getAutoSelectableBoards THREW (loadSessionFromDB, user=${state.userId} student=${state.studentId}): ${(err as Error)?.message ?? err}`);
        }

        state.interactivePrompt = buildInteractiveAgentPrompt({
          studentName: student.firstName || student.name.split(' ')[0] || "",
          persona: personaPrompt,
          language: student.primaryLanguage || undefined,
          memoryContext: state.memoryContext,
          muteState: state.muteState,
          studentAge: computeAge(student.birthDate),
          studentGender: student.gender || undefined,
          studentDiagnosis: state.cachedDiagnosis || undefined,
          aiName: student.aacSettings?.aiName || undefined,
          knownContacts: state.cachedContacts,
          availableBoards: state.availableBoards,
          loadedBoardName: state.loadedBoardData?.name || null,
          cachedSymbols: state.cachedSymbols,
          currentEmote: state.currentEmote,
          activeApp: state.appState.activeApp,
          enabledApps: enabledApps.map(a => ({ id: a.id, name: a.name, description: a.description })),
          permittedWebsites: state.permittedWebsites.length > 0 ? state.permittedWebsites : undefined,
          permittedYoutubeChannels: state.permittedYoutubeChannels.length > 0 ? state.permittedYoutubeChannels : undefined,
          permittedYoutubeVideos: state.permittedYoutubeVideos.length > 0 ? state.permittedYoutubeVideos : undefined,
          permittedYoutubePlaylists: state.permittedYoutubePlaylists.length > 0 ? state.permittedYoutubePlaylists : undefined,
          youtubeChannelVideos: state.permittedYoutubeChannels.length > 0
            ? await fetchRecentVideosForChannels(state.permittedYoutubeChannels)
            : undefined,
          youtubePlaylistVideos: state.permittedYoutubePlaylists.length > 0
            ? await fetchRecentVideosForPlaylists(state.permittedYoutubePlaylists)
            : undefined,
          autoSymbolsEnabled: !!(student.aacSettings?.generateSymbols || student.aacSettings?.useApprovedSymbols || student.aacSettings?.useUnapprovedSymbols),
          singleGlyphButtons: !!student.aacSettings?.singleGlyphButtons,
          sessionGoals: sections?.sessionGoals,
          personaGestureOverrides: sections?.gestureOverrides,
          interactModeExamples: sections?.interactModeExamples,
          assistModeExamples: sections?.assistModeExamples,
          sentenceInterpretationExamples: sections?.sentenceInterpretationExamples,
          safetyNotes: sections?.safetyNotes,
          sessionSummary: state.sessionSummary,
        });
      }

      const interactiveAgent = createInteractiveAgent(
        state.interactivePrompt,
        this.config,
        chatProvider
      );

      // Cache the session
      sessionCache.set(sessionId, {
        state,
        interactiveAgent,
        monitorAgent,
        lastAccess: Date.now(),
        monitorMutex: new SessionMutex(),
      });

      console.log("[DualAgentService] Session resumed from DB, interactivePrompt length:", state.interactivePrompt.length);

      return state;
    } catch (error) {
      console.error("[DualAgentService] Error loading session:", error);
      return null;
    }
  }

  /**
   * Save session state to database.
   * No-op when remote storage is disabled for this session.
   */
  private async saveSessionToDB(state: DualAgentSessionState): Promise<void> {
    if (!state.remoteStorageEnabled) return;
    try {
      const existingSession = await db
        .select({ id: chatSessions.id })
        .from(chatSessions)
        .where(eq(chatSessions.id, state.sessionId))
        .limit(1);

      const chatState = {
        history: state.messages,
        conversationSummary: state.sessionSummary ?? "",
        openedTopics: [],
        memoryState: {},
        muteState: state.muteState,
        memoryContext: state.memoryContext,
        enhancedSections: state.enhancedSections,
        sessionSummary: state.sessionSummary,
        summarizedMsgCount: state.summarizedMsgCount,
      };

      if (existingSession.length > 0) {
        // Update existing session
        await db
          .update(chatSessions)
          .set({
            state: chatState,
            log: state.messages,
            last: state.messages.slice(-2),
            pendingMessages: state.pendingMessages,
            interactivePrompt: state.interactivePrompt,
            thinkingMode: false,
            monitorBusy: state.monitorBusy,
            lastUpdate: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(chatSessions.id, state.sessionId));
      } else {
        // Resolve the user_students relationship record so AAC sessions link
        // back to it the same way clinician sessions do (sessionService sets
        // this; the AAC path historically left it null). Best-effort — a
        // missing link just leaves the column null, exactly as before.
        let userStudentId: string | null = null;
        if (state.userId && state.studentId) {
          try {
            const [link] = await db
              .select({ id: userStudents.id })
              .from(userStudents)
              .where(and(
                eq(userStudents.userId, state.userId),
                eq(userStudents.studentId, state.studentId),
              ))
              .limit(1);
            userStudentId = link?.id ?? null;
          } catch (err) {
            console.warn("[DualAgentService] userStudent link lookup failed:", (err as Error).message);
          }
        }

        // Insert new session
        await db.insert(chatSessions).values({
          id: state.sessionId,
          studentId: state.studentId,
          userId: state.userId,
          userStudentId,
          classroomId: state.classroomId,
          chatMode: "aac",
          state: chatState,
          log: state.messages,
          last: state.messages.slice(-2),
          pendingMessages: state.pendingMessages,
          interactivePrompt: state.interactivePrompt,
          thinkingMode: false,
          monitorBusy: state.monitorBusy,
          status: "open",
        });
      }
    } catch (error) {
      console.error("[DualAgentService] Error saving session:", error);
      throw error;
    }
  }

  /**
   * Validate a board patch against the button limit.
   * Returns null if valid (and updates state.boardButtonLabels), or an error message if rejected.
   */
  private validateBoardPatch(
    state: DualAgentSessionState,
    patchData: { add?: Array<{ label: string }>; remove?: string[]; rebuild?: Array<{ label: string }> }
  ): string | null {
    const maxSlots = state.maxBoardItems || 12;

    // Rebuild replaces the entire board — just enforce total count
    if (patchData.rebuild && patchData.rebuild.length > 0) {
      const labels = patchData.rebuild.slice(0, maxSlots).map(b => b.label);
      state.boardButtonLabels = labels;
      state.aiAddedButtonLabels = [];
      if (patchData.rebuild.length > maxSlots) {
        console.log(`[DualAgentService] REBUILD_BOARD trimmed from ${patchData.rebuild.length} to ${maxSlots}`);
      }
      return null; // Rebuilds always succeed (trimmed)
    }

    // When a custom board is loaded, protect native buttons
    if (state.loadedBoardId) {
      const nativeLabels = getNativePageButtonLabels(state);
      const nativeSet = new Set(nativeLabels.map(l => l.toLowerCase()));

      // Removes: only allow removing AI-added buttons (silently ignore native)
      const requestedRemoves = (patchData.remove || []);
      const allowedRemoves = requestedRemoves.filter(l => !nativeSet.has(l.toLowerCase()));
      const blockedRemoves = requestedRemoves.filter(l => nativeSet.has(l.toLowerCase()));
      if (blockedRemoves.length > 0) {
        console.log(`[DualAgentService] Protected board: silently ignored removal of native buttons: ${blockedRemoves.join(", ")}`);
      }

      // Apply allowed removes to aiAddedButtonLabels tracking
      const removeSet = new Set(allowedRemoves.map(l => l.toLowerCase()));
      state.aiAddedButtonLabels = state.aiAddedButtonLabels.filter(l => !removeSet.has(l.toLowerCase()));

      // Adds: check against blank slot budget (total slots - native count)
      const blankSlots = maxSlots - nativeLabels.length;
      const addCount = (patchData.add || []).length;
      const newAiCount = state.aiAddedButtonLabels.length + addCount;

      if (newAiCount > blankSlots) {
        return `Board change rejected: adding ${addCount} button(s) would result in ${newAiCount} AI-added buttons, exceeding the ${blankSlots} available blank slots on this custom board (${nativeLabels.length} fixed buttons use ${nativeLabels.length} of ${maxSlots} slots). You MUST remove AI-added buttons first to make room.`;
      }

      // Valid — update tracking
      const addLabels = (patchData.add || []).map(b => b.label);
      state.aiAddedButtonLabels = [...state.aiAddedButtonLabels, ...addLabels];

      // Update boardButtonLabels: native + AI-added (after allowed removes)
      const afterRemoveAll = state.boardButtonLabels.filter(l => !removeSet.has(l.toLowerCase()));
      state.boardButtonLabels = [...afterRemoveAll, ...addLabels];

      // Mutate patchData to reflect the filtered removes
      if (patchData.remove) {
        patchData.remove = allowedRemoves;
      }

      return null;
    }

    // No custom board — standard behavior
    const removeSet = new Set((patchData.remove || []).map(l => l.toLowerCase()));
    const afterRemove = state.boardButtonLabels.filter(l => !removeSet.has(l.toLowerCase()));
    const addCount = (patchData.add || []).length;
    const newCount = afterRemove.length + addCount;

    if (newCount > maxSlots) {
      return `Board change rejected: adding ${addCount} button(s) would result in ${newCount} buttons, exceeding the ${maxSlots}-button limit (currently ${state.boardButtonLabels.length} buttons). You MUST remove buttons first to make room.`;
    }

    // Valid — update tracking
    const addLabels = (patchData.add || []).map(b => b.label);
    state.boardButtonLabels = [...afterRemove, ...addLabels];
    return null;
  }

  /**
   * Try to trigger Monitor processing with mutex-based concurrency control
   * This ensures only one Monitor can run per session at a time
   */
  private async tryTriggerMonitor(
    cached: SessionCache,
    state: DualAgentSessionState,
    monitorAgent: MonitorAgent,
    interactiveAgent: InteractiveAgent,
    board?: ParsedBoardData,
    force: boolean = false,
    /** When true, await the pending→log drain to completion before
     *  returning. Used by the session-close final pass so the log is
     *  populated (and the summary won't race against an empty log). */
    awaitCompletion: boolean = false,
  ): Promise<void> {
    const { monitorMutex } = cached;

    // Acquire mutex to make check-and-set atomic
    await monitorMutex.acquire();

    // Throttle: skip if called recently (unless forced by [CALL_MONITOR])
    if (!force && (Date.now() - state.lastMonitorActivity) < MONITOR_THROTTLE_MS) {
      console.log("[DualAgentService] Monitor throttled, next in",
        Math.round((MONITOR_THROTTLE_MS - (Date.now() - state.lastMonitorActivity)) / 1000), "s");
      monitorMutex.release();
      return;
    }

    if (state.monitorBusy) {
      console.log("[DualAgentService] Monitor already busy, setting rerun flag");
      cached.monitorRerunRequested = true;
      const inFlight = cached.monitorInFlight;
      monitorMutex.release();
      // A caller that needs the drain to finish (final pass) waits for the
      // in-flight run rather than returning immediately. The rerun flag we
      // just set causes that run to re-trigger any trailing pending after it
      // completes (fire-and-forget), so we don't double-run here.
      if (awaitCompletion && inFlight) {
        await inFlight.catch(() => {});
      }
      return;
    }

    // Set flags atomically (mutex held)
    state.monitorBusy = true;
    state.monitorBusySince = Date.now();

    // Release mutex before async work
    monitorMutex.release();

    // Update DB (fire-and-forget for the flag, main work below)
    this.updateMonitorBusy(state.sessionId, true, state.monitorBusySince).catch(console.error);

    // Do the actual processing. Track the promise so callers can await the
    // drain when needed; always attach an error handler so an uncaught
    // rejection can't crash the process even in fire-and-forget mode.
    const tracked: Promise<void> = this.doMonitorProcessing(state, monitorAgent, interactiveAgent, board)
      .catch(err => {
        console.error("[DualAgentService] Uncaught doMonitorProcessing error:", (err as Error).message);
        // Ensure state is cleaned up even if doMonitorProcessing throws before its own catch/finally
        state.monitorBusy = false;
        state.monitorBusySince = undefined;
        state.pendingDbLocked = false;
      })
      .finally(() => {
        if (cached.monitorInFlight === tracked) cached.monitorInFlight = undefined;
      });
    cached.monitorInFlight = tracked;

    if (awaitCompletion) {
      await tracked;
    }
  }

  /**
   * Perform Monitor processing in the background.
   * Uses DB as source of truth with an atomic pending→history move.
   * This happens asynchronously so it doesn't block Interactive responses.
   */
  private async doMonitorProcessing(
    state: DualAgentSessionState,
    monitorAgent: MonitorAgent,
    interactiveAgent: InteractiveAgent,
    board?: ParsedBoardData
  ): Promise<void> {
    // Mark the actual processing start time for throttle tracking
    state.lastMonitorActivity = Date.now();

    // Timeout guard: abort if monitor takes too long
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => {
      console.warn(`[DualAgentService] Monitor processing timed out after ${MONITOR_TIMEOUT_MS / 1000}s`);
      timeoutController.abort();
    }, MONITOR_TIMEOUT_MS);

    try {
      // ------------------------------------------------------------------
      // 1. Lock pending messages — new messages go to pendingBuffer
      // ------------------------------------------------------------------
      state.pendingDbLocked = true;

      let pendingSnapshot: PendingMessage[];
      let dbLog: ChatMessage[];

      if (!state.remoteStorageEnabled) {
        // -------------------------------------------------------------------
        // In-memory-only path: no DB reads/writes, work purely from state
        // -------------------------------------------------------------------
        if (state.pendingMessages.length === 0) {
          state.pendingDbLocked = false;
          if (state.pendingBuffer?.length) {
            state.pendingMessages.push(...state.pendingBuffer);
            state.pendingBuffer = [];
          }
          state.monitorBusy = false;
          state.monitorBusySince = undefined;
          return;
        }

        pendingSnapshot = [...state.pendingMessages];
        dbLog = [...state.messages];

        for (const pending of pendingSnapshot) {
          state.messages.push({
            role: pending.role,
            content: pending.content,
            timestamp: pending.timestamp,
          });
        }
        state.pendingMessages = [];

        state.pendingDbLocked = false;
        if (state.pendingBuffer?.length) {
          state.pendingMessages.push(...state.pendingBuffer);
          state.pendingBuffer = [];
        }
      } else {
        // -------------------------------------------------------------------
        // DB-backed path (existing logic)
        // -------------------------------------------------------------------

        // ------------------------------------------------------------------
        // 2. Load authoritative state from DB
        // ------------------------------------------------------------------
        const dbRow = await db
          .select({
            state: chatSessions.state,
            log: chatSessions.log,
            pendingMessages: chatSessions.pendingMessages,
          })
          .from(chatSessions)
          .where(eq(chatSessions.id, state.sessionId))
          .limit(1);

        const dbState = dbRow[0]?.state as any;
        dbLog = (dbRow[0]?.log || []) as ChatMessage[];
        const dbPending = (dbRow[0]?.pendingMessages || []) as PendingMessage[];

        // ------------------------------------------------------------------
        // 3. If DB has no pending messages, unlock and check rerun
        // ------------------------------------------------------------------
        if (dbPending.length === 0) {
          state.pendingDbLocked = false;
          // Flush any buffer that accumulated during the brief lock
          if (state.pendingBuffer?.length) {
            state.pendingMessages.push(...state.pendingBuffer);
            state.pendingBuffer = [];
            await this.updatePendingMessages(state.sessionId, state.pendingMessages).catch(console.error);
          }
          state.monitorBusy = false;
          state.monitorBusySince = undefined;
          await this.updateMonitorBusy(state.sessionId, false, null);
          return;
        }

        console.log("[DualAgentService] doMonitorProcessing: starting with", dbPending.length, "pending messages (from DB)");

        // ------------------------------------------------------------------
        // 4. Append pending messages to history + log (local vars)
        // ------------------------------------------------------------------
        const dbHistory = (dbState?.history || []) as ChatMessage[];
        pendingSnapshot = [...dbPending];

        for (const pending of pendingSnapshot) {
          const chatMsg: ChatMessage = {
            role: pending.role,
            content: pending.content,
            timestamp: pending.timestamp,
          };
          dbHistory.push(chatMsg);
          dbLog.push(chatMsg);
        }

        // Also update in-memory state.messages to match
        state.messages = dbHistory;

        // ------------------------------------------------------------------
        // 5. Atomic DB write: save history+log, clear pendingMessages
        // ------------------------------------------------------------------
        const updatedChatState = {
          history: dbHistory,
          conversationSummary: dbState?.conversationSummary || "",
          openedTopics: dbState?.openedTopics || [],
          memoryState: dbState?.memoryState || {},
          muteState: state.muteState,
        };

        await db
          .update(chatSessions)
          .set({
            state: updatedChatState,
            log: dbLog,
            last: dbHistory.slice(-2),
            pendingMessages: [],
            updatedAt: new Date(),
          })
          .where(eq(chatSessions.id, state.sessionId));

        // Clear in-memory pending (only the snapshot — buffer handled below)
        state.pendingMessages = [];

        // ------------------------------------------------------------------
        // 6. Unlock + flush buffer
        // ------------------------------------------------------------------
        state.pendingDbLocked = false;
        if (state.pendingBuffer?.length) {
          state.pendingMessages.push(...state.pendingBuffer);
          state.pendingBuffer = [];
          await this.updatePendingMessages(state.sessionId, state.pendingMessages).catch(console.error);
        }
      } // end DB-backed path

      // ------------------------------------------------------------------
      // 7. Run monitor agent with the snapshot
      // ------------------------------------------------------------------
      const response = await Promise.race([
        monitorAgent.processPendingMessages(
          pendingSnapshot, board, state.muteState, state.interactivePrompt,
          state.availableBoards?.map(b => ({ id: b.id, name: b.name, hint: b.hint, isGenerated: (b as any).isGenerated }))
        ),
        new Promise<never>((_, reject) => {
          timeoutController.signal.addEventListener("abort", () =>
            reject(new Error("Monitor processing timed out"))
          );
        }),
      ]);

      // ------------------------------------------------------------------
      // 8. Handle Monitor response
      // ------------------------------------------------------------------
      console.log(`[DualAgentService] Monitor response: hasPrompt=${!!response.updatedPrompt} hasContext=${!!response.contextInjection} hasBoard=${!!response.generatedBoard}`);

      if (response.updatedPrompt) {
        // NOTE: updatedPrompt only takes effect on reconnection for the Live API.
        // For immediate guidance, the monitor should use [CONTEXT] instead.
        interactiveAgent.setSystemPrompt(response.updatedPrompt);
        state.interactivePrompt = response.updatedPrompt;
        console.log(`[DualAgentService] Updated prompt (${response.updatedPrompt.length} chars) — takes effect on next reconnect for Live API`);
      }

      if (response.contextInjection) {
        // Add context as a system message that Interactive will see
        const contextMessage = monitorAgent.createCommandMessage(
          "[CONTEXT]",
          response.contextInjection
        );
        state.messages.push(contextMessage);
        dbLog.push(contextMessage);

        // Live API hook: forward context injection to Gemini session
        console.log(`[DualAgentService] Injecting context (${response.contextInjection.length} chars): "${response.contextInjection.substring(0, 120)}..."`);
        state.onContextInjection?.(response.contextInjection);
      }

      // Handle generated board from monitor
      if (response.generatedBoard && state.userId) {
        try {
          const { name, boardId, irData, hint } = response.generatedBoard;
          let savedBoardId: string;

          // A board that belongs to a package is READ-ONLY to the session AI,
          // regardless of isGenerated: editing it would change it for every
          // student in every institute whose package includes it. The prompt
          // says so too, but a rule with cross-tenant blast radius needs a real
          // guard behind it. Throwing lands in this block's own catch, so the
          // rest of the monitor cycle (and the final save) still runs.
          if (boardId) {
            const target = await boardRepository.getBoard(boardId);
            if (target?.scope === "package") {
              logLiveSession(
                "AVAILABLE_BOARDS",
                `REFUSED board edit: ${boardId} "${name}" is a package board (read-only to the session AI)`,
              );
              throw new Error(
                `Board ${boardId} belongs to a package and is read-only to the session AI.`,
              );
            }
          }

          if (boardId) {
            // Edit existing generated board
            await boardRepository.updateBoard(boardId, {
              name,
              irData: irData as any,
              automaticSelection: true,
              automaticSelectionHint: hint || undefined,
            });
            savedBoardId = boardId;
            console.log(`[DualAgentService] Monitor updated generated board: ${boardId} "${name}"`);
          } else {
            // Create new generated board
            const board = await boardRepository.createBoard({
              userId: state.userId,
              studentId: state.studentId,
              name,
              irData: irData as any,
              automaticSelection: true,
              automaticSelectionHint: hint || undefined,
              isGenerated: true,
            });
            savedBoardId = board.id;
            console.log(`[DualAgentService] Monitor created generated board: ${board.id} "${name}"`);
          }

          // Add to available boards so interactive agent can use it immediately
          const boardGrid = irData.grid || { rows: 4, cols: 4 };
          const newEntry = {
            id: savedBoardId,
            key: name.toLowerCase().replace(/\s+/g, '_'),
            name,
            hint: hint || undefined,
            isGenerated: true,
            grid: boardGrid,
            coverImage: boardCoverFromIr(irData),
          };

          if (!state.availableBoards) state.availableBoards = [];
          const existingIdx = state.availableBoards.findIndex(b => b.id === savedBoardId);
          if (existingIdx >= 0) {
            state.availableBoards[existingIdx] = newEntry;
          } else {
            state.availableBoards.push(newEntry);
          }

          // Notify interactive agent about the new board via context injection
          // The interactive agent's prompt will be fully rebuilt on next monitor cycle
          const boardNotice = `A new board "${name}" is now available${hint ? ` (${hint})` : ''}. Use set_board("${newEntry.key}") to load it when appropriate.`;
          state.onContextInjection?.(boardNotice);

          // Notify AAC client via WebSocket
          state.onBoardGenerated?.({ boardId: savedBoardId, name, hint });
        } catch (err) {
          console.error("[DualAgentService] Failed to save generated board:", err);
        }
      }

      console.log("[DualAgentService] doMonitorProcessing: completed successfully");

      // Clear error state on success
      state.monitorError = undefined;
      state.monitorErrorTimestamp = undefined;
      state.monitorConsecutiveFailures = 0;

      // ------------------------------------------------------------------
      // 9. Final save — state (possibly truncated) + log (append-only)
      // ------------------------------------------------------------------
      await this.saveSessionToDB(state);
    } catch (error: any) {
      const errorMsg = error?.message || String(error);
      console.error("[DualAgentService] Monitor processing error:", errorMsg);
      if (error?.stack) console.error("[DualAgentService] Stack trace:", error.stack);

      // Track error on session state so frontend can be alerted
      state.monitorError = errorMsg;
      state.monitorErrorTimestamp = Date.now();
      state.monitorConsecutiveFailures = (state.monitorConsecutiveFailures || 0) + 1;

      console.warn(
        `[DualAgentService] Monitor consecutive failures: ${state.monitorConsecutiveFailures}`
      );
    } finally {
      clearTimeout(timeout);

      // Ensure lock is released even on error
      state.pendingDbLocked = false;
      if (state.pendingBuffer?.length) {
        state.pendingMessages.push(...state.pendingBuffer);
        state.pendingBuffer = [];
        this.updatePendingMessages(state.sessionId, state.pendingMessages).catch(console.error);
      }

      state.monitorBusy = false;
      state.monitorBusySince = undefined;
      // Use timeout on DB write in finally block to prevent deadlock
      try {
        await Promise.race([
          this.updateMonitorBusy(state.sessionId, false, null),
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error("updateMonitorBusy timed out")), 10_000)),
        ]);
      } catch (err) {
        console.error("[DualAgentService] Failed to clear monitorBusy in DB:", (err as Error).message);
      }

      // Check rerun flag — another trigger arrived while we were busy
      const cached = sessionCache.get(state.sessionId);
      if (cached?.monitorRerunRequested) {
        cached.monitorRerunRequested = false;
        console.log("[DualAgentService] Monitor rerun requested — re-triggering");
        this.triggerMonitor(state.sessionId, true).catch(err => {
          console.error("[DualAgentService] Monitor rerun failed:", err);
        });
      }
    }
  }

  /**
   * Update pending messages in database.
   * No-op when remote storage is disabled.
   */
  private async updatePendingMessages(
    sessionId: string,
    pendingMessages: PendingMessage[]
  ): Promise<void> {
    const cached = sessionCache.get(sessionId);
    if (cached && !cached.state.remoteStorageEnabled) return;
    await db
      .update(chatSessions)
      .set({
        pendingMessages,
        updatedAt: new Date(),
      })
      .where(eq(chatSessions.id, sessionId));
  }

  /**
   * Update monitor busy flag in database.
   * No-op when remote storage is disabled.
   */
  private async updateMonitorBusy(
    sessionId: string,
    monitorBusy: boolean,
    monitorBusySince: number | null
  ): Promise<void> {
    const cached = sessionCache.get(sessionId);
    if (cached && !cached.state.remoteStorageEnabled) return;
    await db
      .update(chatSessions)
      .set({
        monitorBusy,
        monitorBusySince: monitorBusySince ? new Date(monitorBusySince) : null,
        updatedAt: new Date(),
      })
      .where(eq(chatSessions.id, sessionId));
  }

  // -------------------------------------------------------------------------
  // Public session cache access (for LiveRelay integration)
  // -------------------------------------------------------------------------

  /**
   * Get the cached session entry for a given session ID.
   * Used by LiveRelay to access session state, agents, and mutex.
   */
  getSessionCache(sessionId: string): SessionCache | undefined {
    const cached = sessionCache.get(sessionId);
    if (cached) cached.lastAccess = Date.now();
    return cached;
  }

  /**
   * Test-only: inject a minimal SessionCache entry without spinning up
   * a real LiveProvider / monitor agent. Used by the consent-cascade
   * tests to verify termination plumbing. Intentionally exposed on the
   * public service so tests don't need to reach into module internals.
   */
  injectTestSession(args: {
    sessionId: string;
    studentId: string;
    userId?: string;
    onTerminate?: (reason: string) => void;
  }): void {
    if (process.env.NODE_ENV === "production") return;
    sessionCache.set(args.sessionId, {
      state: {
        sessionId: args.sessionId,
        studentId: args.studentId,
        userId: args.userId,
        interactivePrompt: "",
        monitorBusy: false,
        messages: [],
        pendingMessages: [],
        muteState: "unmuted",
        boardButtonLabels: [],
        aiAddedButtonLabels: [],
        onTerminate: args.onTerminate,
      } as unknown as DualAgentSessionState,
      interactiveAgent: {} as any,
      monitorAgent: {} as any,
      lastAccess: Date.now(),
      monitorMutex: {
        acquire: async () => () => {},
        runExclusive: async <T>(fn: () => Promise<T>) => fn(),
      } as any,
    });
  }

  /**
   * Force-terminate every cached AAC session for a student. Called by the
   * consent-revocation cascade so an in-flight session can't continue after
   * the parent withdraws consent. Each terminated session:
   *   1. Has its onTerminate callback fired (closes the WebSocket cleanly).
   *   2. Is evicted from sessionCache.
   *   3. Gets its own activity-log entry tagged with cascade_reason.
   *
   * Returns the number of sessions terminated. Safe to call when none match.
   */
  terminateSessionsForStudent(
    studentId: string,
    actingUserId: string,
    cascadeReason: string,
  ): number {
    let terminated = 0;
    for (const [sessionId, cached] of sessionCache.entries()) {
      if (cached.state.studentId !== studentId) continue;
      try {
        cached.state.onTerminate?.(cascadeReason);
      } catch (err) {
        console.error("[DualAgentService] onTerminate threw:", err);
      }
      sessionCache.delete(sessionId);
      terminated++;
      activityLogService.log({
        userId: actingUserId,
        eventType: "update",
        subjectType1: "student",
        subjectId1: studentId,
        details: {
          action: "aac_session_terminated",
          sessionId,
          cascade_reason: cascadeReason,
        },
      });
    }
    return terminated;
  }

  /**
   * Add a single pending message to a session and persist to DB.
   * Respects the pendingDbLocked window — buffers in memory if lock is held.
   */
  async addPendingMessage(sessionId: string, message: PendingMessage): Promise<void> {
    const cached = sessionCache.get(sessionId);
    if (!cached) return;
    const state = cached.state;

    if (state.pendingDbLocked) {
      state.pendingBuffer = state.pendingBuffer || [];
      state.pendingBuffer.push(message);
      return;
    }

    state.pendingMessages.push(message);
    try {
      await this.updatePendingMessages(sessionId, state.pendingMessages);
    } catch (err) {
      console.error("[DualAgentService] addPendingMessage DB write failed:", err);
      // Message is still in memory — monitor will pick it up
    }
  }

  /**
   * Add multiple pending messages to a session and persist to DB.
   * Respects the pendingDbLocked window — buffers in memory if lock is held.
   */
  async addPendingMessages(sessionId: string, messages: PendingMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const cached = sessionCache.get(sessionId);
    if (!cached) return;
    const state = cached.state;

    if (state.pendingDbLocked) {
      state.pendingBuffer = state.pendingBuffer || [];
      state.pendingBuffer.push(...messages);
      return;
    }

    state.pendingMessages.push(...messages);
    try {
      await this.updatePendingMessages(sessionId, state.pendingMessages);
    } catch (err) {
      console.error("[DualAgentService] addPendingMessages DB write failed:", err);
    }
  }

  /**
   * Save pending messages to DB (public wrapper for LiveRelay compatibility).
   */
  async savePendingMessages(sessionId: string, pendingMessages: PendingMessage[]): Promise<void> {
    await this.updatePendingMessages(sessionId, pendingMessages);
  }

  /**
   * Load conversation history from DB for reconnection.
   * Returns turns in Gemini format (user/model) suitable for sendConversationHistory().
   * Filters out internal monitor messages, keeps [CONTEXT] injections.
   */
  async loadHistoryForReconnect(sessionId: string, excludeSafetyMessages = false): Promise<Array<{ role: "user" | "model"; text: string }>> {
    try {
      // When remote storage is disabled, read from in-memory state
      const cached = sessionCache.get(sessionId);
      let history: ChatMessage[];
      let pending: PendingMessage[];

      if (cached && !cached.state.remoteStorageEnabled) {
        history = cached.state.messages;
        pending = cached.state.pendingMessages;
      } else {
        const dbRow = await db
          .select({
            state: chatSessions.state,
            pendingMessages: chatSessions.pendingMessages,
          })
          .from(chatSessions)
          .where(eq(chatSessions.id, sessionId))
          .limit(1);

        if (!dbRow[0]) return [];

        const dbState = dbRow[0].state as any;
        history = (dbState?.history || []) as ChatMessage[];
        pending = (dbRow[0].pendingMessages || []) as PendingMessage[];
      }

      const turns: Array<{ role: "user" | "model"; text: string }> = [];

      // Convert history to Gemini turn format
      for (const msg of history) {
        // Skip internal system/monitor messages (but keep [CONTEXT] injections)
        if (msg.role === "system" as any) {
          const contentStr = typeof msg.content === "string" ? msg.content : (msg.content as any)?.text || "";
          if (contentStr.includes("[CONTEXT]")) {
            turns.push({ role: "user", text: `[SYSTEM CONTEXT UPDATE]\n${contentStr}` });
          }
          continue;
        }
        const textContent = typeof msg.content === "string" ? msg.content : (msg.content as any)?.text || "";
        turns.push({
          role: msg.role === "assistant" ? "model" : "user",
          text: textContent,
        });
      }

      // Also include pending messages (not yet processed by monitor)
      for (const pm of pending) {
        // Skip safety-excluded messages when recovering from safety blocks
        if (excludeSafetyMessages && pm.safetyExcluded) continue;
        turns.push({
          role: pm.role === "assistant" ? "model" : "user",
          text: pm.content,
        });
      }

      // Limit to last 50 turns to avoid overwhelming the new session
      return turns.slice(-50);
    } catch (err) {
      console.error("[DualAgentService] loadHistoryForReconnect error:", err);
      return [];
    }
  }

  /**
   * Trigger monitor processing for a session (public wrapper).
   * Used by LiveRelay to trigger monitor after turn completion.
   */
  async triggerMonitor(
    sessionId: string,
    force = false,
    board?: ParsedBoardData,
    awaitCompletion = false,
  ): Promise<void> {
    const cached = sessionCache.get(sessionId);
    if (!cached) {
      console.warn("[DualAgentService] triggerMonitor: session not found:", sessionId);
      return;
    }
    cached.lastAccess = Date.now();
    await this.tryTriggerMonitor(
      cached,
      cached.state,
      cached.monitorAgent,
      cached.interactiveAgent,
      board,
      force,
      awaitCompletion,
    );
  }
}

// Singleton instance
export const dualAgentService = new DualAgentService();

// Re-export SessionCache type for LiveRelay
export type { SessionCache };
