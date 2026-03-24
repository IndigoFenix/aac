// server/services/dual-agent/dual-agent-service.ts
// Main coordinator for the dual-agent AAC system

import { db } from "../../db";
import { chatSessions, students, users, userStudents, medicalRecords } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import type { ChatMessage, ParsedBoardData } from "@shared/schema";
import { creditsForModelUsage } from "../chat/cost-helpers";
import {
  InteractiveAgent,
  createInteractiveAgent,
} from "./interactive-agent";
import { MonitorAgent, createMonitorAgent } from "./monitor-agent";
import { settingsRepository } from "../../repositories/settingsRepository";
import { getChatProvider } from "../providers/provider-factory";
import type {
  AACInteractionMode,
  DualAgentConfig,
  DualAgentSessionState,
  PendingMessage,
} from "./types";
import { DEFAULT_CONFIG } from "./types";
import {
  AAC_DEFAULT_PERSONA_PROMPT,
  buildFunctionCallingPrompt,
} from "../memory-schema/aac-memory-schema";
import { ttsFacade, type ResolvedVoice } from "../voice/tts-facade";
import { voiceRecordRepository } from "../../repositories/voiceRecordRepository";
import { APP_REGISTRY, getDefaultEnabledApps } from "./app-registry";
import { getContactsByStudent } from "../biometric";
import { boardRepository } from "../../repositories/boardRepository";
import { customSymbolRepository } from "../../repositories/customSymbolRepository";

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
   * Track credits for an interactive agent call.
   * Updates chatSessions.creditsUsed, students.chatCreditsUsed, and users.chatCreditsUsed.
   */
  private async trackInteractiveCredits(
    sessionId: string,
    studentId: string,
    userId: string | undefined,
    usage: { promptTokens: number; completionTokens: number }
  ): Promise<void> {
    const provider = this.config.interactiveProvider || "openai";
    const model = this.config.interactiveModel;
    const credits = creditsForModelUsage(provider, model, usage.promptTokens, usage.completionTokens);
    if (credits <= 0) return;

    try {
      await db
        .update(chatSessions)
        .set({ creditsUsed: sql`${chatSessions.creditsUsed} + ${credits}`, lastUpdate: new Date() })
        .where(eq(chatSessions.id, sessionId));

      if (studentId) {
        await db
          .update(students)
          .set({ chatCreditsUsed: sql`${students.chatCreditsUsed} + ${credits}`, chatCreditsUpdated: new Date() })
          .where(eq(students.id, studentId));
      }

      if (userId) {
        await db
          .update(users)
          .set({ chatCreditsUsed: sql`${users.chatCreditsUsed} + ${credits}`, chatCreditsUpdated: new Date() })
          .where(eq(users.id, userId));
      }

      if (studentId && userId) {
        await db
          .update(userStudents)
          .set({
            chatCreditsUsed: sql`${userStudents.chatCreditsUsed} + ${credits}`,
            chatCreditsUpdated: new Date(),
          })
          .where(and(
            eq(userStudents.userId, userId),
            eq(userStudents.studentId, studentId),
            eq(userStudents.isActive, true)
          ));
      }

      console.log(`[DualAgentService] Tracked ${credits} credits (provider=${provider}, model=${model}, prompt=${usage.promptTokens}, completion=${usage.completionTokens})`);
    } catch (error) {
      console.error("[DualAgentService] Error tracking credits:", error);
    }
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

    // Default Gemini voices based on student gender:
    // Student gets a voice matching their gender, AI gets a different female voice.
    const gender = (student as any)?.gender as string | undefined;
    const defaultStudentGeminiVoice = gender === "female" ? "Leda" : "Puck";
    const defaultAiGeminiVoice = defaultStudentGeminiVoice === "Leda" ? "Kore" : "Kore";

    return {
      aiVoice: {
        fallbackType: (aac?.voiceType as any) || "woman",
        customVoice: aiCustom || null,
        language: student?.primaryLanguage || "en",
        elevenlabsApiKey: aac?.elevenlabsApiKey || undefined,
        elevenlabsVoiceId: aac?.elevenlabsAiVoiceId || undefined,
        geminiVoiceName: (aac as any)?.geminiAiVoice || defaultAiGeminiVoice,
      },
      studentVoice: {
        fallbackType: (aac?.studentVoiceType as any) || "boy",
        customVoice: studentCustom || null,
        language: student?.primaryLanguage || "en",
        elevenlabsApiKey: aac?.elevenlabsApiKey || undefined,
        elevenlabsVoiceId: aac?.elevenlabsStudentVoiceId || undefined,
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
    return !!(voice.elevenlabsApiKey && voice.elevenlabsVoiceId);
  }

  /**
   * Yield TTS output for a piece of text.
   * If the voice is client-side ElevenLabs, yield a lightweight `client_tts`
   * event so the browser can call ElevenLabs directly.
   * Otherwise, synthesise server-side and yield audio chunks.
   */
  private async *yieldTts<T extends "audio" | "interpretation_audio">(
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
    interactionMode: AACInteractionMode = 'interact',
    localState?: import("@shared/aac-local-storage").AacSessionSnapshot,
  ): Promise<DualAgentSessionState> {
    // Check cache first
    if (existingSessionId && sessionCache.has(existingSessionId)) {
      const cached = sessionCache.get(existingSessionId)!;
      cached.lastAccess = Date.now();
      console.log("[DualAgentService] Resuming cached session:", existingSessionId);
      return cached.state;
    }

    // Try to load from database
    if (existingSessionId) {
      const dbSession = await this.loadSessionFromDB(existingSessionId);
      if (dbSession) {
        console.log("[DualAgentService] Resuming session from DB:", existingSessionId);
        return dbSession;
      }
    }

    // Try to rebuild from client-provided local state (fallback when DB is empty/stale)
    if (localState && localState.studentId === studentId) {
      console.log("[DualAgentService] Rebuilding session from client local state:", localState.sessionId);
      return this.rebuildFromLocalState(studentId, userId, localState);
    }

    // Create new session
    console.log("[DualAgentService] Creating new session for student:", studentId);
    return this.createNewSession(studentId, userId, interactionMode);
  }

  /**
   * Create a new dual-agent session
   */
  private async createNewSession(
    studentId: string,
    userId?: string,
    interactionMode: AACInteractionMode = 'interact',
  ): Promise<DualAgentSessionState> {
    // Fetch AAC chat LLM config from DB
    const aacChatConfig = await settingsRepository.getLLMConfig('aac_chat');
    this.config.interactiveModel = aacChatConfig.model;
    this.config.interactiveProvider = aacChatConfig.provider;
    const chatProvider = getChatProvider(aacChatConfig.provider);

    // Create Monitor agent first to initialize
    const monitorAgent = createMonitorAgent(
      studentId,
      this.config,
      userId
    );

    // Initialize session - Monitor searches memory and creates base prompt
    const defaultApps = getDefaultEnabledApps();
    const enabledAppDefs = APP_REGISTRY.filter(a => defaultApps.includes(a.id));
    const initResult = await monitorAgent.initializeSession(interactionMode, enabledAppDefs);

    // Fetch contacts for prompt context
    let cachedContacts: DualAgentSessionState['cachedContacts'] = [];
    try {
      const contacts = await getContactsByStudent(studentId);
      cachedContacts = contacts.map(c => ({
        id: c.id, name: c.name, relationship: c.relationship || undefined, hasFaceImage: true,
      }));
    } catch { /* ignore */ }

    // Fetch custom symbols for prompt context
    let cachedSymbols: DualAgentSessionState['cachedSymbols'] = [];
    try {
      const symbols = await customSymbolRepository.getAvailableSymbolsForStudent(studentId);
      cachedSymbols = symbols.map(s => ({ id: s.id, key: s.key, description: s.description }));
    } catch { /* ignore */ }

    // Fetch primary diagnosis from medical records
    let cachedDiagnosis: string | null = null;
    try {
      const [record] = await db.select({ primaryDiagnosis: medicalRecords.primaryDiagnosis })
        .from(medicalRecords)
        .where(eq(medicalRecords.studentId, studentId))
        .limit(1);
      cachedDiagnosis = record?.primaryDiagnosis || null;
    } catch { /* ignore */ }

    // Load auto-selectable boards
    let availableBoards: DualAgentSessionState['availableBoards'] = [];
    if (userId) {
      try {
        const boards = await boardRepository.getAutoSelectableBoards(userId, studentId);
        availableBoards = boards.map(b => {
          const irData = b.irData as any;
          const grid = irData?.grid || { rows: 3, cols: 4 };
          return { id: b.id, key: b.name.toLowerCase().replace(/ /g, '_'), name: b.name, hint: b.automaticSelectionHint || undefined, grid };
        });
      } catch { /* ignore */ }
    }

    // Build the function-calling prompt with contacts + boards + symbols + demographics.
    // If thorough startup generated an enhanced prompt, use it as the persona instead
    // of the raw custom prompt — the enhanced prompt already has student-specific context woven in.
    let interactivePrompt = "";
    const student = monitorAgent.getStudent?.();
    if (student) {
      const rawPersona = student.aacSettings?.chatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;
      const persona = initResult.enhancedPrompt || rawPersona;
      interactivePrompt = buildFunctionCallingPrompt({
        studentName: student.name,
        persona,
        language: student.primaryLanguage || undefined,
        memoryContext: initResult.enhancedPrompt ? undefined : initResult.initialContext,
        mode: interactionMode,
        studentAge: computeAge(student.birthDate),
        studentGender: student.gender || undefined,
        studentDiagnosis: cachedDiagnosis || undefined,
        aiName: student.aacSettings?.aiName || undefined,
        knownContacts: cachedContacts.length > 0 ? cachedContacts : undefined,
        availableBoards: availableBoards.length > 0 ? availableBoards : undefined,
        cachedSymbols: cachedSymbols.length > 0 ? cachedSymbols : undefined,
        interpretationLevel: student.aacSettings?.interpretationLevel ?? 2,
        autoSymbolsEnabled: !!(student.aacSettings?.generateSymbols || student.aacSettings?.useApprovedSymbols || student.aacSettings?.useUnapprovedSymbols),
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

    // Create session state
    const state: DualAgentSessionState = {
      sessionId: initResult.sessionId,
      studentId,
      userId,
      interactivePrompt,
      monitorBusy: false,
      messages: [],
      pendingMessages: [],
      interactionMode,
      interpretationLevel: (aacSt?.interpretationLevel ?? 2) as import("./types").AACInterpretationLevel,
      appState: { enabledApps: getDefaultEnabledApps(), activeApp: null },
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
      enhancedPrompt: initResult.enhancedPrompt,
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
  ): Promise<DualAgentSessionState> {
    // Create a new session like normal, but seed it with local state data
    const state = await this.createNewSession(
      studentId,
      userId,
      localState.interactionMode || 'interact',
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
        interactivePrompt: session.interactivePrompt || "",
        monitorBusy,
        monitorBusySince,
        messages: chatState?.history || [],
        pendingMessages: (session.pendingMessages as PendingMessage[]) || [],
        interactionMode: chatState?.interactionMode || 'interact',
        interpretationLevel: chatState?.interpretationLevel ?? 2,
        appState: { enabledApps: getDefaultEnabledApps(), activeApp: null },
        currentEmote: "neutral",
        boardButtonLabels: [],
        aiAddedButtonLabels: [],
        lastInteractiveActivity: Date.now(),
        lastMonitorActivity: Date.now(),
        monitorConsecutiveFailures: 0,
        memoryContext: chatState?.memoryContext,
        enhancedPrompt: chatState?.enhancedPrompt,
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

      // Update remote storage flag from current settings
      const student = monitorAgent.getStudent();
      if (student) {
        const aacSt = student.aacSettings;
        state.remoteStorageEnabled = (aacSt?.remoteStorageEnabled ?? true) && (aacSt?.allowNotes ?? true);
      }

      // Rebuild prompt with correct enabledApps (the stored prompt may have stale app info)
      if (student) {
        const personaPrompt = student.aacSettings?.chatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;
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

        // Load auto-selectable boards
        if (state.userId) {
          try {
            const boards = await boardRepository.getAutoSelectableBoards(state.userId, state.studentId);
            state.availableBoards = boards.map(b => {
              const irData = b.irData as any;
              const grid = irData?.grid || { rows: 3, cols: 4 };
              return { id: b.id, key: b.name.toLowerCase().replace(/ /g, '_'), name: b.name, hint: b.automaticSelectionHint || undefined, grid };
            });
          } catch { state.availableBoards = []; }
        }

        state.interactivePrompt = buildFunctionCallingPrompt({
          studentName: student.name,
          persona: personaPrompt,
          language: student.primaryLanguage || undefined,
          mode: state.interactionMode,
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
          interpretationLevel: state.interpretationLevel,
          autoSymbolsEnabled: !!(student.aacSettings?.generateSymbols || student.aacSettings?.useApprovedSymbols || student.aacSettings?.useUnapprovedSymbols),
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
        conversationSummary: "",
        openedTopics: [],
        memoryState: {},
        interactionMode: state.interactionMode,
        memoryContext: state.memoryContext,
        enhancedPrompt: state.enhancedPrompt,
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
        // Insert new session
        await db.insert(chatSessions).values({
          id: state.sessionId,
          studentId: state.studentId,
          userId: state.userId,
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
    force: boolean = false
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
      monitorMutex.release();
      return;
    }

    // Set flags atomically (mutex held)
    state.monitorBusy = true;
    state.monitorBusySince = Date.now();

    // Release mutex before async work
    monitorMutex.release();

    // Update DB (fire-and-forget for the flag, main work below)
    this.updateMonitorBusy(state.sessionId, true, state.monitorBusySince).catch(console.error);

    // Do the actual processing (fire-and-forget with error catch)
    this.doMonitorProcessing(state, monitorAgent, interactiveAgent, board).catch(err => {
      console.error("[DualAgentService] Uncaught doMonitorProcessing error:", (err as Error).message);
      // Ensure state is cleaned up even if doMonitorProcessing throws before its own catch/finally
      state.monitorBusy = false;
      state.monitorBusySince = undefined;
      state.pendingDbLocked = false;
    });
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
          interactionMode: state.interactionMode,
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
        monitorAgent.processPendingMessages(pendingSnapshot, board, state.interactionMode, state.interactivePrompt),
        new Promise<never>((_, reject) => {
          timeoutController.signal.addEventListener("abort", () =>
            reject(new Error("Monitor processing timed out"))
          );
        }),
      ]);

      // ------------------------------------------------------------------
      // 8. Handle Monitor response
      // ------------------------------------------------------------------
      if (response.updatedPrompt) {
        interactiveAgent.setSystemPrompt(response.updatedPrompt);
        state.interactivePrompt = response.updatedPrompt;
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
        state.onContextInjection?.(response.contextInjection);
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
  async triggerMonitor(sessionId: string, force = false, board?: ParsedBoardData): Promise<void> {
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
    );
  }
}

// Singleton instance
export const dualAgentService = new DualAgentService();

// Re-export SessionCache type for LiveRelay
export type { SessionCache };
