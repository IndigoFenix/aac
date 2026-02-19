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
import type { ChatProvider } from "../providers/streaming-provider";
import type {
  AACInteractionMode,
  AACResponseMode,
  DualAgentConfig,
  DualAgentInput,
  DualAgentOutput,
  DualAgentSessionState,
  DetectionInput,
  DetectionOutput,
  PendingMessage,
} from "./types";
import { INTERACTIVE_COMMANDS, DEFAULT_CONFIG } from "./types";
import {
  AAC_DEFAULT_PERSONA_PROMPT,
  buildInteractiveSystemPrompt,
} from "../memory-schema/aac-memory-schema";
import { whisperService } from "../voice/whisper-service";
import { ttsFacade, type ResolvedVoice } from "../voice/tts-facade";
import { voiceRecordRepository } from "../../repositories/voiceRecordRepository";
import { logDualAgent } from "./dual-agent-logger";
import { searchYouTube } from "../youtube/youtube-search";
import { APP_REGISTRY, getAppDefinition, getDefaultEnabledApps } from "./app-registry";
import { createContact, findSimilarContact, updateContact, getContactsByStudent } from "../biometric";
import { boardRepository } from "../../repositories/boardRepository";
import { customSymbolRepository } from "../../repositories/customSymbolRepository";

/**
 * Simple promise-based mutex for per-session concurrency control
 */
class SessionMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise(resolve => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }
}

/**
 * Extract navigation button info from a board page for the prompt.
 * Returns buttons that have link, back, or home actions.
 */
function getPageNavButtons(state: DualAgentSessionState): Array<{ label: string; action: string; targetPageName?: string }> {
  if (!state.loadedBoardData) return [];
  const page = state.loadedBoardData.pages?.find(p => p.id === state.currentPageId) || state.loadedBoardData.pages?.[0];
  if (!page?.buttons) return [];
  const navButtons: Array<{ label: string; action: string; targetPageName?: string }> = [];
  for (const btn of page.buttons) {
    if (btn.action?.type === "link" && btn.action.toPageId) {
      const targetPage = state.loadedBoardData.pages?.find(p => p.id === btn.action!.toPageId);
      navButtons.push({ label: btn.label, action: "link", targetPageName: targetPage?.name || btn.action.toPageId });
    } else if (btn.action?.type === "back") {
      navButtons.push({ label: btn.label, action: "back" });
    } else if (btn.action?.type === "home") {
      navButtons.push({ label: btn.label, action: "home" });
    }
  }
  return navButtons;
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

// Monitor staleness timeout: 30 seconds
const MONITOR_TIMEOUT_MS = 30_000;

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
    return {
      aiVoice: {
        fallbackType: (aac?.voiceType as any) || "woman",
        customVoice: aiCustom || null,
        language: student?.primaryLanguage || "en",
        elevenlabsApiKey: aac?.elevenlabsApiKey || undefined,
        elevenlabsVoiceId: aac?.elevenlabsAiVoiceId || undefined,
      },
      studentVoice: {
        fallbackType: (aac?.studentVoiceType as any) || "boy",
        customVoice: studentCustom || null,
        language: student?.primaryLanguage || "en",
        elevenlabsApiKey: aac?.elevenlabsApiKey || undefined,
        elevenlabsVoiceId: aac?.elevenlabsStudentVoiceId || undefined,
      },
    };
  }

  /**
   * Initialize or resume a dual-agent session
   */
  async initializeSession(
    studentId: string,
    userId?: string,
    existingSessionId?: string,
    interactionMode: AACInteractionMode = 'interact',
    isLiveMode: boolean = false
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

    // Create new session
    console.log("[DualAgentService] Creating new session for student:", studentId);
    return this.createNewSession(studentId, userId, interactionMode, isLiveMode);
  }

  /**
   * Initialize session AND get initial greeting with buttons
   * This is what should be called when starting a conversation
   *
   * Uses a single LLM call: combined greeting + board via processMessageStream
   * with text-based prefix tokens ([SPEAK] for greeting, [REBUILD_BOARD] for buttons).
   */
  async *initializeWithGreeting(
    studentId: string,
    userId?: string,
    existingSessionId?: string,
    board?: ParsedBoardData,
    interactionMode: AACInteractionMode = 'interact',
    imageData?: string,
    gestureContext?: string
  ): AsyncGenerator<{
    type: "text" | "board" | "board_patch" | "audio" | "transcription" | "complete" | "interpretation" | "interpretation_audio" | "transcript" | "context" | "debug" | "monitor_status" | "app_open" | "app_close" | "emote" | "set_board" | "ai_button_press" | "yes_no" | "ask_yes_no";
    data: any;
    speaker?: string;
  }> {
    const initStart = Date.now();

    // Log what we received
    logDualAgent("DualAgentService.initializeWithGreeting.start", {
      studentId,
      hasExistingSession: !!existingSessionId,
      interactionMode,
      hasImage: !!imageData,
      imageDataLength: imageData?.length || 0,
      hasGestureContext: !!gestureContext,
      gestureContextLength: gestureContext?.length || 0,
    });

    // Initialize the session first
    const state = await this.initializeSession(studentId, userId, existingSessionId, interactionMode);
    const cached = sessionCache.get(state.sessionId);

    if (!cached) {
      yield { type: "complete", data: { sessionId: state.sessionId, error: "Session not cached" } };
      return;
    }

    const { interactiveAgent, monitorAgent } = cached;
    const isSilent = interactionMode === 'silent';

    let fullText = "";

    // Build a context-aware greeting message using student persona
    const student = monitorAgent.getStudent();
    const personaHint = student?.aacSettings?.chatAgentPrompt?.trim()
      ? `\nThe student is ${student.name}. Use their profile (in the system prompt) to personalize the board — reflect their interests, communication level, and needs.`
      : "";

    // Combined greeting + board in one LLM call
    const imageHint = imageData ? "\nUse the camera image to observe the environment and make the buttons contextually relevant." : "";
    const greetingBoardMessage = isSilent
      ? `Generate 4-12 contextual utterance buttons — complete phrases the user might want to say. Use the student's profile and interests from the system prompt to make them relevant.${imageHint} Use [REBUILD_BOARD] to create the initial board.${personaHint}`
      : `Greet the user with a short, friendly greeting (1-2 sentences) and provide 4-12 initial communication buttons that reflect the student's interests, needs, and communication level from the system prompt. The buttons should be appropriate responses to your greeting.${imageHint} Use [SPEAK] for your greeting and [REBUILD_BOARD] for the buttons.${personaHint}`;

    let boardCreated = false;
    try {
      let streamUsage: { promptTokens: number; completionTokens: number } | undefined;
      for await (const chunk of interactiveAgent.processMessageStream(
        greetingBoardMessage,
        [],
        [],
        board,
        gestureContext, // Pass gesture context as visual context
        undefined, // audioContext
        imageData // image from camera
      )) {
        if (chunk.type === "speak") {
          fullText += chunk.data;
          if (!isSilent) {
            yield { type: "text", data: chunk.data };
          }
        } else if (chunk.type === "interpret") {
          yield { type: "interpretation", data: chunk.data };
        } else if (chunk.type === "board") {
          console.log("[DualAgentService] Board generated:", JSON.stringify(chunk.data).substring(0, 200));
          yield { type: "board", data: chunk.data };
          boardCreated = true;
        } else if (chunk.type === "board_patch") {
          console.log("[DualAgentService] Board patch:", JSON.stringify(chunk.data).substring(0, 200));
          yield { type: "board_patch", data: chunk.data };
          boardCreated = true;
        } else if (chunk.type === "usage") {
          streamUsage = chunk.data;
        } else if (chunk.type === "emote") {
          state.currentEmote = chunk.data as "happy" | "sad" | "neutral";
          yield { type: "emote", data: chunk.data };
        }
      }
      if (streamUsage) {
        await this.trackInteractiveCredits(state.sessionId, state.studentId, state.userId, streamUsage);
      }
      // Fallback: create default board if the model didn't produce one (e.g., stream cut off early)
      if (!boardCreated) {
        console.warn("[DualAgentService] No board generated during initialization, creating default board");
        const defaultBoard = this.createDefaultBoard(board);
        yield { type: "board", data: defaultBoard };
      }
    } catch (err: any) {
      console.error("[DualAgentService] Greeting+board error:", err?.message || err);
      if (err?.stack) console.error("[DualAgentService] Stack trace:", err.stack);
      const defaultBoard = this.createDefaultBoard(board);
      yield { type: "board", data: defaultBoard };
    }

    const initElapsed = Date.now() - initStart;
    console.log("[DualAgentService] initializeWithGreeting completed in", initElapsed, "ms, text:", fullText.substring(0, 80));
    logDualAgent("DualAgentService.initializeWithGreeting", { elapsedMs: initElapsed, isSilent, textLength: fullText.length, sessionId: state.sessionId });

    // Store the greeting as the first assistant message (interact mode only)
    if (fullText) {
      state.messages.push({
        role: "assistant",
        content: fullText,
        timestamp: Date.now(),
      });
      await this.saveSessionToDB(state);
    }

    // Generate audio for greeting if TTS enabled (interact mode only)
    if (this.config.enableTTS && fullText && !isSilent) {
      try {
        const voices = await this.resolveVoices(cached);
        for await (const audioChunk of ttsFacade.synthesizeStream(fullText, voices.aiVoice)) {
          yield { type: "audio", data: audioChunk.toString("base64") };
        }
      } catch (err) {
        console.error("[DualAgentService] TTS error:", err);
      }
    }

    yield { type: "complete", data: { sessionId: state.sessionId } };
  }

  /**
   * Create a default board with common communication buttons
   */
  private createDefaultBoard(currentBoard?: ParsedBoardData): ParsedBoardData {
    const grid = currentBoard?.grid || { rows: 3, cols: 4 };
    const pageId = `page-${Date.now()}`;

    const defaultButtons: Array<{
      id: string;
      label: string;
      spokenText: string;
      row: number;
      col: number;
      action: { type: "speak" | "link" | "back" | "home"; text?: string };
    }> = [
      { label: "Hello", row: 0, col: 0 },
      { label: "Goodbye", row: 0, col: 1 },
      { label: "I want", row: 0, col: 2 },
      { label: "I need", row: 0, col: 3 },
      { label: "Eat", row: 1, col: 0 },
      { label: "Drink", row: 1, col: 1 },
      { label: "Play", row: 1, col: 2 },
      { label: "Go", row: 1, col: 3 },
      { label: "Thank you", row: 2, col: 0 },
      { label: "Please", row: 2, col: 1 },
      { label: "Stop", row: 2, col: 2 },
      { label: "Wait", row: 2, col: 3 },
    ].map((btn, index) => ({
      id: `btn-default-${index}`,
      label: btn.label,
      spokenText: btn.label,
      row: btn.row,
      col: btn.col,
      action: { type: "speak" as const, text: btn.label },
    }));

    return {
      name: currentBoard?.name || "Communication Board",
      grid,
      pages: [{ id: pageId, name: "Main", buttons: defaultButtons }],
      currentPageId: pageId,
    };
  }

  /**
   * Create a new dual-agent session
   */
  private async createNewSession(
    studentId: string,
    userId?: string,
    interactionMode: AACInteractionMode = 'interact',
    isLiveMode: boolean = false
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

    // Rebuild the prompt with contacts + boards + symbols + demographics
    // (monitorAgent.initializeSession builds the base prompt before these are loaded)
    let interactivePrompt = initResult.interactivePrompt;
    const student = monitorAgent.getStudent?.();
    if (student) {
      const personaPrompt = student.aacSettings?.chatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;
      interactivePrompt = buildInteractiveSystemPrompt(
        student.name,
        personaPrompt,
        student.primaryLanguage || undefined,
        initResult.initialContext,
        interactionMode,
        computeAge(student.birthDate),
        student.gender || undefined,
        cachedDiagnosis || undefined,
        false,
        enabledAppDefs,
        null, // activeApp
        "happy",
        'analyze',
        cachedContacts.length > 0 ? cachedContacts : undefined,
        availableBoards.length > 0 ? availableBoards : undefined,
        undefined, // loadedBoardName
        undefined, // loadedPageName
        12, // maxBoardItems
        undefined, // loadedPageNavButtons
        student.aacSettings?.interpretationLevel ?? 2,
        cachedSymbols.length > 0 ? cachedSymbols : undefined,
        isLiveMode,
        student.aacSettings?.aiName || undefined,
      );
    }

    // Create Interactive agent with the complete prompt
    const interactiveAgent = createInteractiveAgent(
      interactivePrompt,
      this.config,
      chatProvider
    );

    // Create session state
    const state: DualAgentSessionState = {
      sessionId: initResult.sessionId,
      studentId,
      userId,
      interactivePrompt,
      thinkingMode: false,
      monitorBusy: false,
      messages: [],
      pendingMessages: [],
      interactionMode,
      isLiveMode,
      interpretationLevel: (monitorAgent.getStudent?.()?.aacSettings?.interpretationLevel ?? 2) as import("./types").AACInterpretationLevel,
      appState: { enabledApps: getDefaultEnabledApps(), activeApp: null },
      currentEmote: "happy",
      boardButtonLabels: [],
      lastInteractiveActivity: Date.now(),
      lastMonitorActivity: Date.now(),
      monitorConsecutiveFailures: 0,
      cachedContacts,
      cachedSymbols,
      availableBoards,
      cachedDiagnosis,
    };

    // Save to database
    await this.saveSessionToDB(state);

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
        thinkingMode: session.thinkingMode || false,
        monitorBusy,
        monitorBusySince,
        messages: chatState?.history || [],
        pendingMessages: (session.pendingMessages as PendingMessage[]) || [],
        interactionMode: chatState?.interactionMode || 'interact',
        interpretationLevel: chatState?.interpretationLevel ?? 2,
        appState: { enabledApps: getDefaultEnabledApps(), activeApp: null },
        currentEmote: "neutral",
        boardButtonLabels: [],
        lastInteractiveActivity: Date.now(),
        lastMonitorActivity: Date.now(),
        monitorConsecutiveFailures: 0,
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

      // Rebuild prompt with correct enabledApps (the stored prompt may have stale app info)
      const student = monitorAgent.getStudent();
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

        state.interactivePrompt = buildInteractiveSystemPrompt(
          student.name,
          personaPrompt,
          student.primaryLanguage || undefined,
          undefined,
          state.interactionMode,
          computeAge(student.birthDate),
          student.gender || undefined,
          state.cachedDiagnosis || undefined,
          false,
          enabledApps,
          state.appState.activeApp,
          state.currentEmote,
          'analyze', // default on session resume
          state.cachedContacts,
          state.availableBoards,
          state.loadedBoardData?.name || null,
          null,
          state.maxBoardItems || 12,
          getPageNavButtons(state),
          state.interpretationLevel,
          state.cachedSymbols,
          state.isLiveMode,
          student.aacSettings?.aiName || undefined,
        );
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
   * Save session state to database
   */
  private async saveSessionToDB(state: DualAgentSessionState): Promise<void> {
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
            thinkingMode: state.thinkingMode,
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
          thinkingMode: state.thinkingMode,
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
   * Process user input and generate response
   * This is the main entry point for dual-agent processing
   */
  async *processInput(
    input: DualAgentInput
  ): AsyncGenerator<{
    type: "text" | "board" | "board_patch" | "audio" | "transcription" | "complete" | "interpretation" | "interpretation_audio" | "transcript" | "context" | "debug" | "monitor_status" | "app_open" | "app_close" | "emote" | "set_board" | "ai_button_press" | "yes_no" | "ask_yes_no";
    data: any;
    speaker?: string;
  }> {
    // Initialize or resume session
    const state = await this.initializeSession(
      input.studentId,
      input.userId,
      input.sessionId
    );

    const cached = sessionCache.get(state.sessionId)!;
    const { interactiveAgent, monitorAgent } = cached;

    // Handle audio input (transcribe first)
    let userMessage = input.message || "";
    if (input.audioBlob) {
      const transcription = await whisperService.transcribe(
        input.audioBlob,
        "audio/webm",
        { languageHint: input.language }
      );
      userMessage = transcription.text;
      yield { type: "transcription", data: transcription };
    }

    if (!userMessage.trim()) {
      yield { type: "complete", data: { sessionId: state.sessionId } };
      return;
    }

    // Handle interaction mode — detect changes and rebuild prompt if needed
    const interactionMode: AACInteractionMode = input.interactionMode || 'interact';
    const responseMode: AACResponseMode = input.responseMode || 'analyze';
    if (interactionMode !== state.interactionMode) {
      console.log(`[DualAgentService] Mode switch: ${state.interactionMode} → ${interactionMode}`);
      state.interactionMode = interactionMode;

      // Rebuild interactive prompt for new mode
      const student = monitorAgent.getStudent();
      if (student) {
        const personaPrompt = student.aacSettings?.chatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;
        const enabledApps = APP_REGISTRY.filter(a => state.appState.enabledApps.includes(a.id));
        const inputLoadedPage = state.loadedBoardData?.pages?.find(p => p.id === state.currentPageId);
        const newPrompt = buildInteractiveSystemPrompt(
          student.name,
          personaPrompt,
          student.primaryLanguage || undefined,
          undefined,
          interactionMode,
          computeAge(student.birthDate),
          student.gender || undefined,
          state.cachedDiagnosis || undefined,
          false,
          enabledApps,
          state.appState.activeApp,
          state.currentEmote,
          responseMode,
          state.cachedContacts,
          state.availableBoards,
          state.loadedBoardData?.name || null,
          inputLoadedPage?.name || null,
          state.maxBoardItems || 12,
          getPageNavButtons(state),
          state.interpretationLevel,
          state.cachedSymbols,
          state.isLiveMode,
          student.aacSettings?.aiName || undefined,
        );
        interactiveAgent.setSystemPrompt(newPrompt);
        state.interactivePrompt = newPrompt;
      }

      await this.saveSessionToDB(state);
    }

    // Add user message to pending
    const pendingMessage: PendingMessage = {
      role: "user",
      content: userMessage,
      timestamp: Date.now(),
      boardState: input.board,
      visualContext: input.visualContext,
      audioContext: input.audioContext,
    };
    state.pendingMessages.push(pendingMessage);

    // Save pending messages to DB
    await this.updatePendingMessages(state.sessionId, state.pendingMessages);

    // Check if in thinking mode
    if (state.thinkingMode) {
      // Monitor handles the response directly
      yield* this.handleThinkingMode(
        state,
        monitorAgent,
        userMessage,
        input.board
      );
    } else {
      // Interactive handles the response
      yield* this.handleInteractiveMode(
        state,
        interactiveAgent,
        monitorAgent,
        userMessage,
        input.board,
        input.visualContext,
        input.audioContext,
        input.imageData,
        input.identifiedPerson,
        interactionMode,
        input.gestureContext,
        input.debugMode,
        input.unknownFaceDescriptors
      );
    }

    // State is saved by:
    // - Interactive mode: doMonitorProcessing saves when complete
    // - Thinking mode: handleThinkingMode saves at the end
    // Pending messages are already persisted at line 509 for crash recovery

    // Alert frontend if the monitor agent has been failing
    if (state.monitorError && state.monitorConsecutiveFailures > 0) {
      yield {
        type: "monitor_status",
        data: {
          error: state.monitorError,
          errorTimestamp: state.monitorErrorTimestamp,
          consecutiveFailures: state.monitorConsecutiveFailures,
        },
      };
    }

    yield { type: "complete", data: { sessionId: state.sessionId } };
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
      if (patchData.rebuild.length > maxSlots) {
        console.log(`[DualAgentService] REBUILD_BOARD trimmed from ${patchData.rebuild.length} to ${maxSlots}`);
      }
      return null; // Rebuilds always succeed (trimmed)
    }

    // Incremental add/remove — enforce limit
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
   * Handle response in interactive mode (fast agent)
   */
  private async *handleInteractiveMode(
    state: DualAgentSessionState,
    interactiveAgent: InteractiveAgent,
    monitorAgent: MonitorAgent,
    userMessage: string,
    board?: ParsedBoardData,
    visualContext?: string,
    audioContext?: string,
    imageData?: string,
    identifiedPerson?: import("./types").IdentifiedPersonContext,
    interactionMode: AACInteractionMode = 'interact',
    gestureContext?: string,
    debugMode?: boolean,
    unknownFaceDescriptors?: Array<{ descriptor: number[]; boundingBox?: { x: number; y: number; w: number; h: number } }>
  ): AsyncGenerator<{
    type: "text" | "board" | "board_patch" | "audio" | "interpretation" | "interpretation_audio" | "transcript" | "context" | "debug" | "app_open" | "app_close" | "emote" | "set_board" | "ai_button_press" | "yes_no" | "ask_yes_no";
    data: any;
    speaker?: string;
  }> {
    const isSilent = interactionMode === 'silent';
    const modeStart = Date.now();
    let fullText = "";
    let fullInterpretation = "";
    let callMonitorReason: string | undefined;
    let openAppData: { appId: string; data?: string } | undefined;
    let closeAppTriggered = false;
    let learnFaceData: { name: string; relationship?: string; description?: string } | undefined;
    let setBoardName: string | undefined;
    let pressButtonLabel: string | undefined;
    let yesNoTriggered = false;
    let askYesNoTriggered = false;
    console.log("[DualAgentService] handleInteractiveMode: thinkingMode:", state.thinkingMode, "interactionMode:", interactionMode, "messages:", state.messages.length, "pending:", state.pendingMessages.length);
    logDualAgent("DualAgentService.handleInteractiveMode", { interactionMode, messageCount: state.messages.length, pendingCount: state.pendingMessages.length });

    // Build person context string if identified
    let personContext: string | undefined;
    if (identifiedPerson) {
      const confidence = Math.round(identifiedPerson.confidence * 100);
      if (identifiedPerson.type === "student") {
        personContext = `[Person identified: This is the student "${identifiedPerson.name}" (${confidence}% confidence)]`;
      } else if (identifiedPerson.type === "contact") {
        const parts = [identifiedPerson.name];
        if (identifiedPerson.relationship) parts.push(identifiedPerson.relationship);
        parts.push(`${confidence}% confidence`);
        personContext = `[Person identified: ${parts.join(", ")}]`;
        if (identifiedPerson.description)
          personContext += `\n[Contact info: ${identifiedPerson.description}]`;
        if (identifiedPerson.contextNotes)
          personContext += `\n[Contact notes: ${identifiedPerson.contextNotes}]`;
      } else {
        personContext = `[Person identified: ${identifiedPerson.name} (${identifiedPerson.relationship || "caregiver"}, ${confidence}% confidence)]`;
      }
    }

    // Combine additional context strings (person identification + gesture/expression data)
    const contextParts: string[] = [];
    if (personContext) contextParts.push(personContext);
    if (gestureContext) contextParts.push(gestureContext);
    const combinedContext = contextParts.length > 0 ? contextParts.join("\n") : undefined;

    // Filter out the current user message from pendingMessages since processMessageStream
    // adds it explicitly as the final user turn (avoids duplicate "Music" / "Draw" etc.)
    const pendingForPrompt = state.pendingMessages.filter(
      p => !(p.role === "user" && p.content === userMessage && p.timestamp >= modeStart - 1000)
    );

    // Stream response from Interactive agent (with image if provided)
    let interactiveUsage: { promptTokens: number; completionTokens: number } | undefined;
    for await (const chunk of interactiveAgent.processMessageStream(
      userMessage,
      state.messages,
      pendingForPrompt,
      board,
      visualContext,
      audioContext,
      imageData,
      combinedContext
    )) {
      if (chunk.type === "speak") {
        fullText += chunk.data;
        // Only forward AI voice text in interact mode
        if (!isSilent) {
          yield { type: "text", data: chunk.data };
        }
      } else if (chunk.type === "interpret") {
        fullInterpretation += chunk.data;
        // Interpretation is always forwarded (both modes)
        yield { type: "interpretation", data: chunk.data };
      } else if (chunk.type === "transcript") {
        // Forward transcript to client
        yield { type: "transcript", data: chunk.data, speaker: chunk.speaker };
      } else if (chunk.type === "context") {
        // Forward context updates to client
        yield { type: "context", data: chunk.data };
      } else if (chunk.type === "board") {
        // Full board rebuild exits any loaded custom board
        if (state.loadedBoardId) {
          state.loadedBoardId = null;
          state.loadedBoardData = undefined;
          state.currentPageId = null;
          state.pageHistory = [];
          state.maxBoardItems = 12;
          console.log("[DualAgentService] REBUILD_BOARD: exited custom board, back to default 4x3 grid");
        }
        // Update server-side board label tracking from the rebuild
        const rebuildPage = chunk.data?.pages?.[0];
        const rebuildButtons = rebuildPage?.buttons || [];
        const maxItems = state.maxBoardItems || 12;
        state.boardButtonLabels = rebuildButtons
          .slice(0, maxItems)
          .map((b: { label?: string }) => b.label || "")
          .filter((l: string) => l);
        yield { type: "board", data: chunk.data };
      } else if (chunk.type === "board_patch") {
        // Enforce button count limit
        const rejection = this.validateBoardPatch(state, chunk.data);
        if (rejection) {
          console.log("[DualAgentService]", rejection);
          state.pendingMessages.push({ role: "system", content: `[SYSTEM] ${rejection}`, timestamp: Date.now() });
        } else {
          yield { type: "board_patch", data: chunk.data };
        }
      } else if (chunk.type === "command") {
        // Handle command from Interactive
        await this.handleInteractiveCommand(state, chunk.data);
      } else if (chunk.type === "usage") {
        interactiveUsage = chunk.data;
      } else if (chunk.type === "call_monitor") {
        callMonitorReason = chunk.data;
      } else if (chunk.type === "open_app") {
        openAppData = chunk.data;
      } else if (chunk.type === "close_app") {
        closeAppTriggered = true;
      } else if (chunk.type === "emote") {
        const emoteValue = chunk.data as "happy" | "sad" | "neutral";
        state.currentEmote = emoteValue;
        yield { type: "emote", data: emoteValue };
      } else if (chunk.type === "learn_face") {
        learnFaceData = chunk.data as { name: string; relationship?: string; description?: string };
      } else if (chunk.type === "set_board") {
        setBoardName = chunk.data as string;
      } else if (chunk.type === "press_button") {
        pressButtonLabel = chunk.data as string;
      } else if (chunk.type === "yes_no") {
        yesNoTriggered = true;
      } else if (chunk.type === "ask_yes_no") {
        askYesNoTriggered = true;
      }
    }

    const modeElapsed = Date.now() - modeStart;
    logDualAgent("DualAgentService.handleInteractiveMode.done", { elapsedMs: modeElapsed, textLength: fullText.length, interpretationLength: fullInterpretation.length });

    // Yield debug event with usage info
    if (debugMode && interactiveUsage) {
      yield { type: "debug", data: {
        debugType: "interactive_response",
        model: this.config.interactiveModel,
        provider: this.config.interactiveProvider || "openai",
        usage: interactiveUsage,
        latencyMs: modeElapsed,
        textLength: fullText.length,
        interpretationLength: fullInterpretation.length,
        hasCallMonitor: !!callMonitorReason,
        hasOpenApp: !!openAppData,
        hasLearnFace: !!learnFaceData,
        learnFaceName: learnFaceData?.name,
        knownContacts: state.cachedContacts?.length || 0,
        timestamp: Date.now(),
      }};
    }

    // Handle yes/no overlay trigger
    if (yesNoTriggered) {
      yield { type: "yes_no", data: {} };
    }

    // Handle deferred yes/no overlay (shown after TTS playback)
    if (askYesNoTriggered) {
      yield { type: "ask_yes_no", data: {} };
    }

    // Handle app open/close
    if (openAppData && state.appState.enabledApps.includes(openAppData.appId)) {
      console.log("[DualAgentService] AI requested app open:", openAppData.appId, openAppData.data);
      let appData: any = openAppData.data;
      // YouTube needs server-side search
      if (openAppData.appId === "youtube" && openAppData.data) {
        const videoResult = await searchYouTube(openAppData.data);
        if (videoResult) {
          appData = videoResult;
        } else {
          appData = null; // Search failed, don't open
        }
      }
      if (appData !== null) {
        state.appState.activeApp = openAppData.appId;
        yield { type: "app_open", data: { appId: openAppData.appId, appData } };
      }
    }
    if (closeAppTriggered && state.appState.activeApp) {
      console.log("[DualAgentService] AI requested app close");
      state.appState.activeApp = null;
      yield { type: "app_close", data: {} };
    }

    // Handle [SET_BOARD] — load a pre-built board
    if (setBoardName) {
      const setBoardKey = setBoardName.toLowerCase().replace(/ /g, '_');
      const matchedBoard = state.availableBoards?.find(
        b => b.key === setBoardKey
      );
      if (matchedBoard) {
        try {
          const fullBoard = await boardRepository.getBoard(matchedBoard.id);
          if (fullBoard?.irData) {
            const boardData = fullBoard.irData as ParsedBoardData;
            state.loadedBoardId = matchedBoard.id;
            state.loadedBoardData = boardData;
            state.currentPageId = boardData.pages?.[0]?.id || null;
            state.pageHistory = [];
            state.maxBoardItems = matchedBoard.grid.rows * matchedBoard.grid.cols;
            yield { type: "set_board", data: { board: boardData, name: matchedBoard.name, boardId: matchedBoard.id } };
            state.pendingMessages.push({
              role: "assistant",
              content: `[SYSTEM — Board "${matchedBoard.name}" loaded with ${boardData.pages?.length || 0} pages]`,
              timestamp: Date.now(),
            });
            console.log(`[DualAgentService] SET_BOARD: loaded "${matchedBoard.name}" (${boardData.pages?.length || 0} pages)`);
          }
        } catch (err) {
          console.error("[DualAgentService] SET_BOARD load error:", err);
        }
      } else {
        const availableKeys = state.availableBoards?.map(b => b.key).join(", ") || "none";
        state.pendingMessages.push({
          role: "assistant",
          content: `[SYSTEM — Board "${setBoardName}" not found. Available keys: ${availableKeys}]`,
          timestamp: Date.now(),
        });
        console.warn(`[DualAgentService] SET_BOARD: "${setBoardName}" not found. Available keys: ${availableKeys}`);
      }
    }

    // Handle [PRESS_BUTTON] — AI navigates within a loaded board
    if (pressButtonLabel && state.loadedBoardData) {
      const currentPage = state.loadedBoardData.pages?.find(p => p.id === state.currentPageId) || state.loadedBoardData.pages?.[0];
      const matchedButton = currentPage?.buttons?.find(
        b => b.label.toLowerCase() === pressButtonLabel!.toLowerCase()
      );
      if (matchedButton?.action?.type === "link" && matchedButton.action.toPageId) {
        const targetPageId = matchedButton.action.toPageId;
        const targetPage = state.loadedBoardData.pages?.find(p => p.id === targetPageId);
        if (targetPage) {
          // Push current page to history
          if (state.currentPageId) {
            state.pageHistory = [...(state.pageHistory || []), state.currentPageId];
          }
          state.currentPageId = targetPageId;
          yield { type: "ai_button_press", data: { label: pressButtonLabel, action: "navigate", targetPageId, targetPageName: targetPage.name, buttons: targetPage.buttons } };
          state.pendingMessages.push({
            role: "assistant",
            content: `[AI navigated to page "${targetPage.name}" by pressing "${pressButtonLabel}"]`,
            timestamp: Date.now(),
          });
          console.log(`[DualAgentService] PRESS_BUTTON: AI navigated to "${targetPage.name}" via "${pressButtonLabel}"`);
        }
      } else if (matchedButton?.action?.type === "back") {
        const history = state.pageHistory || [];
        if (history.length > 0) {
          const prevPageId = history[history.length - 1];
          state.pageHistory = history.slice(0, -1);
          state.currentPageId = prevPageId;
          const prevPage = state.loadedBoardData.pages?.find(p => p.id === prevPageId);
          yield { type: "ai_button_press", data: { label: pressButtonLabel, action: "back", targetPageId: prevPageId, targetPageName: prevPage?.name || "Previous", buttons: prevPage?.buttons || [] } };
          state.pendingMessages.push({
            role: "assistant",
            content: `[AI navigated back to page "${prevPage?.name || "Previous"}" by pressing "${pressButtonLabel}"]`,
            timestamp: Date.now(),
          });
          console.log(`[DualAgentService] PRESS_BUTTON: AI navigated back to "${prevPage?.name}"`);
        }
      } else if (matchedButton?.action?.type === "home") {
        const homePage = state.loadedBoardData.pages?.[0];
        if (homePage) {
          state.pageHistory = [];
          state.currentPageId = homePage.id;
          yield { type: "ai_button_press", data: { label: pressButtonLabel, action: "home", targetPageId: homePage.id, targetPageName: homePage.name, buttons: homePage.buttons } };
          state.pendingMessages.push({
            role: "assistant",
            content: `[AI navigated to home page "${homePage.name}" by pressing "${pressButtonLabel}"]`,
            timestamp: Date.now(),
          });
          console.log(`[DualAgentService] PRESS_BUTTON: AI navigated home to "${homePage.name}"`);
        }
      } else {
        console.warn(`[DualAgentService] PRESS_BUTTON: "${pressButtonLabel}" not found or not a navigation button on current page`);
        state.pendingMessages.push({
          role: "assistant",
          content: `[SYSTEM — Button "${pressButtonLabel}" not found or not a navigation button on the current page]`,
          timestamp: Date.now(),
        });
      }
    }

    // Track credits for the interactive response
    if (interactiveUsage) {
      await this.trackInteractiveCredits(state.sessionId, state.studentId, state.userId, interactiveUsage);
    }

    // Add assistant response to pending
    if (fullText) {
      state.pendingMessages.push({
        role: "assistant",
        content: fullText,
        timestamp: Date.now(),
      });
    }

    // If Interactive requested monitor, force-trigger it
    const forceMonitor = !!callMonitorReason;
    if (forceMonitor) {
      console.log("[DualAgentService] Interactive requested monitor:", callMonitorReason);
      state.pendingMessages.push({
        role: "assistant",
        content: `[CALL_MONITOR] ${callMonitorReason}`,
        timestamp: Date.now(),
      });
      await this.updatePendingMessages(state.sessionId, state.pendingMessages);
    }

    // Handle [LEARN_FACE] enrollment if present and we have unknown face descriptors
    if (learnFaceData && unknownFaceDescriptors?.length) {
      try {
        const descriptor = unknownFaceDescriptors[0].descriptor;
        const existing = await findSimilarContact(state.studentId, descriptor);
        if (!existing) {
          await createContact({
            studentId: state.studentId,
            name: learnFaceData.name,
            relationship: learnFaceData.relationship || null,
            description: learnFaceData.description || null,
            faceEmbedding: descriptor,
          });
          console.log(`[DualAgentService] Enrolled new contact "${learnFaceData.name}" for student ${state.studentId}`);
        } else {
          await updateContact(existing.id, {
            contextNotes: learnFaceData.description || existing.contextNotes,
            lastSeenAt: new Date(),
            timesIdentified: (existing.timesIdentified || 0) + 1,
          });
          console.log(`[DualAgentService] Updated existing contact "${existing.name}" (matched LEARN_FACE for "${learnFaceData.name}")`);
        }
        // Refresh cached contacts after enrollment
        try {
          const contacts = await getContactsByStudent(state.studentId);
          state.cachedContacts = contacts.map(c => ({
            id: c.id, name: c.name, relationship: c.relationship || undefined, hasFaceImage: true,
          }));
        } catch { /* ignore */ }
      } catch (err) {
        console.error("[DualAgentService] LEARN_FACE enrollment error:", err);
      }
    }

    // Trigger Monitor processing with proper concurrency control
    const cached = sessionCache.get(state.sessionId)!;
    this.tryTriggerMonitor(cached, state, monitorAgent, interactiveAgent, board, forceMonitor);

    // Generate student voice audio for interpretation first (both modes)
    if (this.config.enableTTS && fullInterpretation) {
      try {
        const voices = await this.resolveVoices(cached);
        for await (const audioChunk of ttsFacade.synthesizeStream(fullInterpretation, voices.studentVoice)) {
          yield { type: "interpretation_audio", data: audioChunk.toString("base64") };
        }
      } catch (err) {
        console.error("[DualAgentService] Interpretation TTS error:", err);
      }
    }

    // Generate AI voice audio second (skip in silent mode)
    if (this.config.enableTTS && fullText && !isSilent) {
      const voices = await this.resolveVoices(cached);
      for await (const audioChunk of ttsFacade.synthesizeStream(fullText, voices.aiVoice)) {
        yield { type: "audio", data: audioChunk.toString("base64") };
      }
    }
  }

  /**
   * Handle response in thinking mode (Monitor responds directly)
   */
  private async *handleThinkingMode(
    state: DualAgentSessionState,
    monitorAgent: MonitorAgent,
    userMessage: string,
    board?: ParsedBoardData
  ): AsyncGenerator<{
    type: "text" | "board" | "audio";
    data: any;
  }> {
    let fullText = "";
    console.log("[DualAgentService] handleThinkingMode: messages:", state.messages.length, "pending:", state.pendingMessages.length);

    // Stream response from Monitor agent
    for await (const chunk of monitorAgent.respondInThinkingMode(
      userMessage,
      state.messages,
      board
    )) {
      if (chunk.type === "text") {
        fullText += chunk.data;
        yield { type: "text", data: chunk.data };
      } else if (chunk.type === "board") {
        yield { type: "board", data: chunk.data };
      } else if (chunk.type === "complete") {
        // Check if we should exit thinking mode
        if (chunk.data.exitThinkingMode) {
          state.thinkingMode = false;
          await this.updateThinkingMode(state.sessionId, false);
        }
      }
    }

    // Move pending messages to main log, then add assistant response
    for (const pending of state.pendingMessages) {
      state.messages.push({
        role: pending.role,
        content: pending.content,
        timestamp: pending.timestamp,
      });
    }
    state.pendingMessages = [];

    if (fullText) {
      state.messages.push({
        role: "assistant",
        content: fullText,
        timestamp: Date.now(),
      });
    }

    // Save state (thinking mode processes synchronously, no background monitor)
    await this.saveSessionToDB(state);

    // Generate audio if enabled
    if (this.config.enableTTS && fullText) {
      const cached = sessionCache.get(state.sessionId);
      if (cached) {
        const voices = await this.resolveVoices(cached);
        for await (const audioChunk of ttsFacade.synthesizeStream(fullText, voices.aiVoice)) {
          yield { type: "audio", data: audioChunk.toString("base64") };
        }
      }
    }
  }

  /**
   * Handle a command from the Interactive agent
   */
  private async handleInteractiveCommand(
    state: DualAgentSessionState,
    command: string
  ): Promise<void> {
    console.log("[DualAgentService] Interactive command:", command);

    switch (command) {
      case INTERACTIVE_COMMANDS.THINK:
        state.thinkingMode = true;
        await this.updateThinkingMode(state.sessionId, true);
        break;
      case INTERACTIVE_COMMANDS.PAUSE:
        // Request Monitor to process
        break;
      case INTERACTIVE_COMMANDS.HELP:
        // Request help from Monitor
        break;
    }
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

    // Do the actual processing (preserves fire-and-forget pattern)
    this.doMonitorProcessing(state, monitorAgent, interactiveAgent, board);
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

    // Timeout guard: abort if monitor takes too long (30 seconds)
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => {
      console.warn("[DualAgentService] Monitor processing timed out after 30s");
      timeoutController.abort();
    }, MONITOR_TIMEOUT_MS);

    try {
      // ------------------------------------------------------------------
      // 1. Lock pending messages — new messages go to pendingBuffer
      // ------------------------------------------------------------------
      state.pendingDbLocked = true;

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
      const dbLog = (dbRow[0]?.log || []) as ChatMessage[];
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
      const pendingSnapshot = [...dbPending];

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

      // ------------------------------------------------------------------
      // 7. Run monitor agent with the snapshot
      // ------------------------------------------------------------------
      const response = await Promise.race([
        monitorAgent.processPendingMessages(pendingSnapshot, board, state.interactionMode),
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
      await this.updateMonitorBusy(state.sessionId, false, null);

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
   * Update pending messages in database
   */
  private async updatePendingMessages(
    sessionId: string,
    pendingMessages: PendingMessage[]
  ): Promise<void> {
    await db
      .update(chatSessions)
      .set({
        pendingMessages,
        updatedAt: new Date(),
      })
      .where(eq(chatSessions.id, sessionId));
  }

  /**
   * Update thinking mode in database
   */
  private async updateThinkingMode(
    sessionId: string,
    thinkingMode: boolean
  ): Promise<void> {
    await db
      .update(chatSessions)
      .set({
        thinkingMode,
        updatedAt: new Date(),
      })
      .where(eq(chatSessions.id, sessionId));
  }

  /**
   * Interpret recent button presses into a natural spoken sentence.
   * Used in silent mode — the user presses several buttons, then hits "Interpret"
   * to synthesize them into a fluent sentence spoken aloud.
   */
  async *interpretButtonPresses(
    sessionId: string | undefined,
    studentId: string,
    userId: string | undefined,
    recentButtons: string[],
    board?: ParsedBoardData
  ): AsyncGenerator<{
    type: "text" | "audio" | "complete";
    data: any;
  }> {
    if (recentButtons.length === 0) {
      yield { type: "complete", data: { error: "No buttons to interpret" } };
      return;
    }

    // Initialize or resume session
    const state = await this.initializeSession(studentId, userId, sessionId);
    const cached = sessionCache.get(state.sessionId);
    if (!cached) {
      yield { type: "complete", data: { sessionId: state.sessionId, error: "Session not cached" } };
      return;
    }

    const { interactiveAgent } = cached;

    // Build an interpret request message
    const buttonList = recentButtons.map((b, i) => `${i + 1}. "${b}"`).join("\n");
    const interpretMessage = `The user has pressed these buttons in order:\n${buttonList}\n\nSynthesize these into ONE natural, fluent sentence that the user wants to say aloud to someone nearby. Output ONLY the sentence, nothing else. Do not call any tools.`;

    let fullText = "";

    try {
      const response = await interactiveAgent.processMessage(
        interpretMessage,
        state.messages,
        [],
        board
      );

      fullText = response.text || recentButtons.join(" ");

      if (response.usage) {
        await this.trackInteractiveCredits(state.sessionId, state.studentId, state.userId, response.usage);
      }
    } catch (err) {
      console.error("[DualAgentService] Interpret error:", err);
      fullText = recentButtons.join(". ");
    }

    yield { type: "text", data: fullText };

    // Always generate TTS for interpret — the whole point is to speak aloud
    // Use STUDENT voice since this is the student's own words
    if (this.config.enableTTS && fullText) {
      try {
        const voices = await this.resolveVoices(cached);
        for await (const audioChunk of ttsFacade.synthesizeStream(fullText, voices.studentVoice)) {
          yield { type: "audio", data: audioChunk.toString("base64") };
        }
      } catch (err) {
        console.error("[DualAgentService] Interpret TTS error:", err);
      }
    }

    yield { type: "complete", data: { sessionId: state.sessionId } };
  }

  /**
   * Process a detection frame — lightweight, non-streaming environment observation.
   * Returns add/remove diff. Triggers Monitor with pending messages (fire-and-forget).
   */
  async processDetection(input: DetectionInput): Promise<DetectionOutput> {
    const interactionMode: AACInteractionMode = input.interactionMode || 'interact';

    // Initialize or resume session
    const state = await this.initializeSession(
      input.studentId,
      input.userId,
      input.sessionId,
      interactionMode
    );

    const cached = sessionCache.get(state.sessionId);
    if (!cached) {
      return { sessionId: state.sessionId, changed: false };
    }

    const { interactiveAgent, monitorAgent } = cached;

    const responseMode: AACResponseMode = input.responseMode || 'analyze';

    // Handle mode switch if needed
    if (interactionMode !== state.interactionMode) {
      console.log(`[DualAgentService] Detection mode switch: ${state.interactionMode} → ${interactionMode}`);
      state.interactionMode = interactionMode;

      const student = monitorAgent.getStudent();
      if (student) {
        const personaPrompt = student.aacSettings?.chatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;
        const enabledApps = APP_REGISTRY.filter(a => state.appState.enabledApps.includes(a.id));
        const detSwitchPage = state.loadedBoardData?.pages?.find(p => p.id === state.currentPageId);
        const newPrompt = buildInteractiveSystemPrompt(
          student.name,
          personaPrompt,
          student.primaryLanguage || undefined,
          undefined,
          interactionMode,
          computeAge(student.birthDate),
          student.gender || undefined,
          state.cachedDiagnosis || undefined,
          false,
          enabledApps,
          state.appState.activeApp,
          state.currentEmote,
          responseMode,
          state.cachedContacts,
          state.availableBoards,
          state.loadedBoardData?.name || null,
          detSwitchPage?.name || null,
          state.maxBoardItems || 12,
          getPageNavButtons(state),
          state.interpretationLevel,
          state.cachedSymbols,
          state.isLiveMode,
          student.aacSettings?.aiName || undefined,
        );
        interactiveAgent.setSystemPrompt(newPrompt);
        state.interactivePrompt = newPrompt;
      }
    }

    // NOTE: We no longer push a pre-detection pending message — it was confusing
    // the monitor into thinking the student did something. We only push a post-detection
    // message when there's actually a board change to report.

    // Build detection system prompt using the unified builder with isDetection=true
    // This ensures detection has full student context, memory, language, etc.
    const student = monitorAgent.getStudent();
    const personaPrompt = student?.aacSettings?.chatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;
    const enabledApps = APP_REGISTRY.filter(a => state.appState.enabledApps.includes(a.id));
    const loadedPage = state.loadedBoardData?.pages?.find(p => p.id === state.currentPageId);
    const detectionSystemPrompt = buildInteractiveSystemPrompt(
      student?.name || "the student",
      personaPrompt,
      student?.primaryLanguage || undefined,
      undefined, // memoryContext
      interactionMode,
      computeAge(student?.birthDate), // studentAge
      student?.gender || undefined, // studentGender
      state.cachedDiagnosis || undefined, // studentDiagnosis
      true, // isDetection - adds conservative guidance and HIGH CONFIDENCE emphasis
      enabledApps,
      state.appState.activeApp,
      state.currentEmote,
      responseMode,
      state.cachedContacts,
      state.availableBoards,
      state.loadedBoardData?.name || null,
      loadedPage?.name || null,
      state.maxBoardItems || 12,
      getPageNavButtons(state),
      state.interpretationLevel,
      state.cachedSymbols,
      undefined, // isLiveMode (HTTP detection)
      student?.aacSettings?.aiName || undefined,
    );

    const detStart = Date.now();
    try {
      // Call interactive agent — raw audio buffer goes directly to the provider
      // (Gemini handles audio natively; OpenAI/Claude strip it and fall back to text context)
      const result = await interactiveAgent.processDetection(
        state.messages,
        state.pendingMessages,
        input.board,
        input.imageData,
        input.audioContext,
        detectionSystemPrompt,
        input.gestureContext,
        input.audioBuffer,
        input.frameTimestamps,
        input.appCanvasData,
        input.envFrameTimestamps,
        input.audioMimeType,
        state.maxBoardItems || 12
      );

      console.log("[DualAgentService] Detection processed:", JSON.stringify(result));

      // Track credits for detection
      if (result.usage) {
        await this.trackInteractiveCredits(state.sessionId, state.studentId, state.userId, result.usage);
      }

      const addButtons = result.addButtons || [];
      const removeLabels = result.removeLabels || [];
      const rebuildBoard = result.rebuildBoard || [];
      const triggeredMessage = result.triggeredMessage;
      const interpretation = result.interpretation || result.triggeredMessage;
      const debugDescription = result.debugDescription;
      const changed = addButtons.length > 0 || removeLabels.length > 0 || rebuildBoard.length > 0;
      const forceMonitor = !!result.callMonitor;
      if (forceMonitor) {
        console.log("[DualAgentService] Detection requested monitor:", result.callMonitor);
      }

      if (changed) {
        // Push post-detection pending message (assistant role = system observation, not a user action)
        // Environment description goes FIRST so it isn't truncated by the 300-char limit in Recent Activity
        const boardParts: string[] = [];
        if (rebuildBoard.length > 0) boardParts.push(`rebuilt: ${rebuildBoard.map(b => b.label).join(", ")}`);
        else if (addButtons.length > 0) boardParts.push(`+${addButtons.map(b => b.label).join(", ")}`);
        if (removeLabels.length > 0) boardParts.push(`-${removeLabels.join(", ")}`);
        const envDesc = result.text ? `${result.text} ` : "";
        const boardSuffix = boardParts.length > 0 ? `Board changes: ${boardParts.join("; ")}` : "";
        state.pendingMessages.push({
          role: "assistant",
          content: `[SYSTEM — Detection: ${envDesc}${boardSuffix}]`,
          timestamp: Date.now(),
        });
        await this.updatePendingMessages(state.sessionId, state.pendingMessages);
        console.log("[DualAgentService] Detection: board changed —", boardParts.join("; "));
      }

      // Record detection speech/interpretation in pendingMessages so future detections see it
      // (Board-change messages already include the environment description; this handles speech-only detections)
      if (!changed && (result.text || result.interpretation)) {
        const speechParts: string[] = [];
        if (result.interpretation) speechParts.push(`[INTERPRET] ${result.interpretation}`);
        if (result.text) speechParts.push(`[SPEAK] ${result.text}`);
        state.pendingMessages.push({
          role: "assistant",
          content: `[SYSTEM — Detection speech: ${speechParts.join(" ")}]`,
          timestamp: Date.now(),
        });
        await this.updatePendingMessages(state.sessionId, state.pendingMessages);
      }

      // Push CALL_MONITOR reason as pending message so monitor sees why it was called
      if (forceMonitor && result.callMonitor) {
        state.pendingMessages.push({
          role: "assistant",
          content: `[CALL_MONITOR] ${result.callMonitor}`,
          timestamp: Date.now(),
        });
        await this.updatePendingMessages(state.sessionId, state.pendingMessages);
      }

      // Handle [LEARN_FACE] enrollment from detection
      if (result.learnFace && input.unknownFaceDescriptors?.length) {
        try {
          const descriptor = input.unknownFaceDescriptors[0].descriptor;
          const existing = await findSimilarContact(state.studentId, descriptor);
          if (!existing) {
            await createContact({
              studentId: state.studentId,
              name: result.learnFace.name,
              relationship: result.learnFace.relationship || null,
              description: result.learnFace.description || null,
              faceEmbedding: descriptor,
            });
            console.log(`[DualAgentService] Detection enrolled new contact "${result.learnFace.name}" for student ${state.studentId}`);
          } else {
            await updateContact(existing.id, {
              contextNotes: result.learnFace.description || existing.contextNotes,
              lastSeenAt: new Date(),
              timesIdentified: (existing.timesIdentified || 0) + 1,
            });
            console.log(`[DualAgentService] Detection updated existing contact "${existing.name}"`);
          }
          // Refresh cached contacts after enrollment
          try {
            const contacts = await getContactsByStudent(state.studentId);
            state.cachedContacts = contacts.map(c => ({
              id: c.id, name: c.name, relationship: c.relationship || undefined, hasFaceImage: true,
            }));
          } catch { /* ignore */ }
        } catch (err) {
          console.error("[DualAgentService] Detection LEARN_FACE error:", err);
        }
      }

      // Handle [SET_BOARD] from detection
      let setBoardResult: DetectionOutput['setBoard'];
      if (result.setBoard) {
        const setBoardKey = result.setBoard.toLowerCase().replace(/ /g, '_');
        const matchedBoard = state.availableBoards?.find(
          b => b.key === setBoardKey
        );
        if (matchedBoard) {
          try {
            const fullBoard = await boardRepository.getBoard(matchedBoard.id);
            if (fullBoard?.irData) {
              const boardData = fullBoard.irData as ParsedBoardData;
              state.loadedBoardId = matchedBoard.id;
              state.loadedBoardData = boardData;
              state.currentPageId = boardData.pages?.[0]?.id || null;
              state.pageHistory = [];
              state.maxBoardItems = matchedBoard.grid.rows * matchedBoard.grid.cols;
              setBoardResult = { board: boardData, name: matchedBoard.name, boardId: matchedBoard.id };
              state.pendingMessages.push({
                role: "assistant",
                content: `[SYSTEM — Board "${matchedBoard.name}" loaded with ${boardData.pages?.length || 0} pages]`,
                timestamp: Date.now(),
              });
              console.log(`[DualAgentService] Detection SET_BOARD: loaded "${matchedBoard.name}"`);
            }
          } catch (err) {
            console.error("[DualAgentService] Detection SET_BOARD error:", err);
          }
        }
      }

      // Handle [PRESS_BUTTON] from detection — AI navigates within loaded board
      let pressButtonResult: DetectionOutput['pressButton'];
      if (result.pressButton && state.loadedBoardData) {
        const currentPage = state.loadedBoardData.pages?.find(p => p.id === state.currentPageId) || state.loadedBoardData.pages?.[0];
        const matchedButton = currentPage?.buttons?.find(
          b => b.label.toLowerCase() === result.pressButton!.toLowerCase()
        );
        if (matchedButton?.action?.type === "link" && matchedButton.action.toPageId) {
          const targetPageId = matchedButton.action.toPageId;
          const targetPage = state.loadedBoardData.pages?.find(p => p.id === targetPageId);
          if (targetPage) {
            if (state.currentPageId) {
              state.pageHistory = [...(state.pageHistory || []), state.currentPageId];
            }
            state.currentPageId = targetPageId;
            pressButtonResult = { label: result.pressButton!, action: "navigate", targetPageId, targetPageName: targetPage.name, buttons: targetPage.buttons };
            state.pendingMessages.push({
              role: "assistant",
              content: `[AI navigated to page "${targetPage.name}" by pressing "${result.pressButton}"]`,
              timestamp: Date.now(),
            });
            console.log(`[DualAgentService] Detection PRESS_BUTTON: AI navigated to "${targetPage.name}"`);
          }
        } else if (matchedButton?.action?.type === "back") {
          const history = state.pageHistory || [];
          if (history.length > 0) {
            const prevPageId = history[history.length - 1];
            state.pageHistory = history.slice(0, -1);
            state.currentPageId = prevPageId;
            const prevPage = state.loadedBoardData.pages?.find(p => p.id === prevPageId);
            pressButtonResult = { label: result.pressButton!, action: "back", targetPageId: prevPageId, targetPageName: prevPage?.name || "Previous", buttons: prevPage?.buttons || [] };
            state.pendingMessages.push({
              role: "assistant",
              content: `[AI navigated back to page "${prevPage?.name || "Previous"}" by pressing "${result.pressButton}"]`,
              timestamp: Date.now(),
            });
            console.log(`[DualAgentService] Detection PRESS_BUTTON: AI navigated back to "${prevPage?.name}"`);
          }
        } else if (matchedButton?.action?.type === "home") {
          const homePage = state.loadedBoardData.pages?.[0];
          if (homePage) {
            state.pageHistory = [];
            state.currentPageId = homePage.id;
            pressButtonResult = { label: result.pressButton!, action: "home", targetPageId: homePage.id, targetPageName: homePage.name, buttons: homePage.buttons };
            state.pendingMessages.push({
              role: "assistant",
              content: `[AI navigated to home page "${homePage.name}" by pressing "${result.pressButton}"]`,
              timestamp: Date.now(),
            });
            console.log(`[DualAgentService] Detection PRESS_BUTTON: AI navigated home to "${homePage.name}"`);
          }
        }
      }

      // Handle REBUILD_BOARD clearing loaded board
      if (rebuildBoard.length > 0 && state.loadedBoardId) {
        state.loadedBoardId = null;
        state.loadedBoardData = undefined;
        state.currentPageId = null;
        state.pageHistory = [];
        state.maxBoardItems = 12;
        console.log("[DualAgentService] Detection REBUILD_BOARD: exited custom board");
      }

      // Trigger monitor when there was a meaningful change or force-requested
      if (changed || forceMonitor) {
        this.tryTriggerMonitor(cached, state, monitorAgent, interactiveAgent, input.board, forceMonitor);
      }

      // Generate interpretation audio (student voice TTS) inline for JSON response
      let interpretationAudio: string | undefined;
      if (this.config.enableTTS && interpretation) {
        try {
          const voices = await this.resolveVoices(cached);
          const audioBuffer = await ttsFacade.synthesize(interpretation, voices.studentVoice);
          interpretationAudio = audioBuffer.toString("base64");
        } catch (err) {
          console.error("[DualAgentService] Detection interpretation TTS error:", err);
        }
      }

      const detElapsed = Date.now() - detStart;
      logDualAgent("DualAgentService.processDetection", { elapsedMs: detElapsed, changed, addCount: addButtons.length, removeCount: removeLabels.length, rebuildCount: rebuildBoard.length, hasImage: !!input.imageData, hasAudio: !!input.audioBuffer, hasInterpretation: !!interpretation });

      return {
        sessionId: state.sessionId,
        addButtons: addButtons.length > 0 ? addButtons : undefined,
        removeLabels: removeLabels.length > 0 ? removeLabels : undefined,
        rebuildBoard: rebuildBoard.length > 0 ? rebuildBoard : undefined,
        changed,
        text: result.text || undefined,
        triggeredMessage, // deprecated alias for interpretation
        interpretation,
        interpretConfidence: result.interpretConfidence,
        transcriptConfidence: result.transcriptConfidence,
        interpretationAudio,
        debugDescription,
        transcript: result.transcript,
        transcriptSpeaker: result.transcriptSpeaker,
        contextUpdate: result.contextUpdate,
        openApp: result.openApp,
        closeApp: result.closeApp,
        setBoard: setBoardResult,
        pressButton: pressButtonResult,
        yesNo: result.yesNo,
        askYesNo: result.askYesNo,
      };
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      const errorStack = error?.stack || "";
      console.error("[DualAgentService] processDetection error:", errorMessage);
      if (errorStack) console.error("[DualAgentService] Stack trace:", errorStack);
      return { sessionId: state.sessionId, changed: false, error: errorMessage };
    }
  }

  /**
   * Process a detection frame with SSE streaming.
   * Uses existing processDetection for LLM, then streams TTS audio.
   * This provides streaming audio without requiring streaming LLM.
   */
  async *processDetectionStream(input: DetectionInput): AsyncGenerator<{
    type: "text" | "board" | "board_patch" | "audio" | "interpretation" | "interpretation_audio" | "transcript" | "context" | "debug" | "error" | "complete" | "monitor_status" | "app_open" | "app_close" | "emote" | "set_board" | "ai_button_press" | "yes_no" | "ask_yes_no";
    data: any;
    speaker?: string;
  }> {
    const isSilent = (input.interactionMode || 'interact') === 'silent';
    const responseMode: AACResponseMode = input.responseMode || 'analyze';

    // Use existing non-streaming detection for LLM call
    const result = await this.processDetection(input);

    // Yield debug info if debugMode is active
    if (input.debugMode) {
      // Get current session state for context info
      const debugState = sessionCache.get(result.sessionId)?.state;
      // Collect face button info for debug
      const faceButtons = [...(result.addButtons || []), ...(result.rebuildBoard || [])]
        .filter(b => b.symbolPath?.startsWith("__FACE__:"));
      yield { type: "debug", data: {
        debugType: "detection_result",
        model: this.config.interactiveModel,
        provider: this.config.interactiveProvider || "openai",
        changed: result.changed,
        hasInterpretation: !!result.interpretation,
        hasTranscript: !!result.transcript,
        hasImage: !!input.imageData,
        hasAudio: !!input.audioBuffer,
        hasGesture: !!input.gestureContext,
        messageCount: debugState?.messages?.length || 0,
        pendingCount: debugState?.pendingMessages?.length || 0,
        debugDescription: result.debugDescription,
        responseMode,
        knownContacts: debugState?.cachedContacts?.length || 0,
        faceButtons: faceButtons.length > 0 ? faceButtons.map(b => `${b.label}|${b.symbolPath}`) : undefined,
        timestamp: Date.now(),
      }};
    }

    // Yield error if detection failed
    if (result.error) {
      yield { type: "error", data: result.error };
    }

    // Validate board patch if changed
    const detPatchData = result.changed
      ? { add: result.addButtons || [], remove: result.removeLabels || [], rebuild: result.rebuildBoard }
      : null;
    let detBoardRejected = false;
    if (detPatchData) {
      const detState = sessionCache.get(result.sessionId)?.state;
      if (detState) {
        const rejection = this.validateBoardPatch(detState, detPatchData);
        if (rejection) {
          console.log("[DualAgentService] Detection:", rejection);
          detState.pendingMessages.push({ role: "system", content: `[SYSTEM] ${rejection}`, timestamp: Date.now() });
          detBoardRejected = true;
        }
      }
    }

    if (responseMode === 'fast') {
      // Fast mode: yield voice/board FIRST, then observations
      if (result.interpretation) {
        yield { type: "interpretation", data: result.interpretation };
      }
      if (result.text && !isSilent) {
        yield { type: "text", data: result.text };
      }
      if (detPatchData && !detBoardRejected) {
        yield { type: "board_patch", data: detPatchData };
      }
      if (result.transcript) {
        yield { type: "transcript", data: result.transcript, speaker: result.transcriptSpeaker };
      }
      if (result.contextUpdate) {
        yield { type: "context", data: result.contextUpdate };
      }
    } else {
      // Analyze mode (default): yield observations FIRST, then voice/board
      if (result.transcript) {
        yield { type: "transcript", data: result.transcript, speaker: result.transcriptSpeaker };
      }
      if (result.contextUpdate) {
        yield { type: "context", data: result.contextUpdate };
      }
      if (result.interpretation) {
        yield { type: "interpretation", data: result.interpretation };
      }
      if (result.text && !isSilent) {
        yield { type: "text", data: result.text };
      }
      if (detPatchData && !detBoardRejected) {
        yield { type: "board_patch", data: detPatchData };
      }
    }

    // Update and yield emote if detection set one
    if (result.emote) {
      const cached2 = sessionCache.get(result.sessionId);
      if (cached2) cached2.state.currentEmote = result.emote;
      yield { type: "emote", data: result.emote };
    }

    // Yield yes_no if detection triggered it
    if (result.yesNo) {
      yield { type: "yes_no", data: {} };
    }

    // Yield ask_yes_no if detection triggered it (deferred — client shows after TTS)
    if (result.askYesNo) {
      yield { type: "ask_yes_no", data: {} };
    }

    // Yield set_board if detection loaded one
    if (result.setBoard) {
      yield { type: "set_board", data: result.setBoard };
    }

    // Yield ai_button_press if detection triggered navigation
    if (result.pressButton) {
      yield { type: "ai_button_press", data: result.pressButton };
    }

    // Handle app open/close from detection
    if (result.openApp) {
      const cached2 = sessionCache.get(result.sessionId);
      if (cached2 && cached2.state.appState.enabledApps.includes(result.openApp.appId)) {
        let appData: any = result.openApp.data;
        if (result.openApp.appId === "youtube" && result.openApp.data) {
          const videoResult = await searchYouTube(result.openApp.data);
          if (videoResult) appData = videoResult;
          else appData = null;
        }
        if (appData !== null) {
          cached2.state.appState.activeApp = result.openApp.appId;
          yield { type: "app_open", data: { appId: result.openApp.appId, appData } };
        }
      }
    }
    if (result.closeApp) {
      const cached2 = sessionCache.get(result.sessionId);
      if (cached2 && cached2.state.appState.activeApp) {
        cached2.state.appState.activeApp = null;
        yield { type: "app_close", data: {} };
      }
    }

    // Debug description is included in the JSON response already, no need to yield for streaming

    // Stream TTS audio
    const cached = sessionCache.get(result.sessionId);
    if (this.config.enableTTS && cached) {
      const voices = await this.resolveVoices(cached);

      // Interpretation audio first (student voice, both modes)
      if (result.interpretation) {
        try {
          for await (const audioChunk of ttsFacade.synthesizeStream(result.interpretation, voices.studentVoice)) {
            yield { type: "interpretation_audio", data: audioChunk.toString("base64") };
          }
        } catch (err) {
          console.error("[DualAgentService] Detection stream interpretation TTS error:", err);
        }
      }

      // AI voice audio second (only in interact mode)
      if (result.text && !isSilent) {
        try {
          for await (const audioChunk of ttsFacade.synthesizeStream(result.text, voices.aiVoice)) {
            yield { type: "audio", data: audioChunk.toString("base64") };
          }
        } catch (err) {
          console.error("[DualAgentService] Detection stream TTS error:", err);
        }
      }
    }

    // Alert frontend if the monitor agent has been failing
    const detectionState = sessionCache.get(result.sessionId)?.state;
    if (detectionState?.monitorError && detectionState.monitorConsecutiveFailures > 0) {
      yield {
        type: "monitor_status",
        data: {
          error: detectionState.monitorError,
          errorTimestamp: detectionState.monitorErrorTimestamp,
          consecutiveFailures: detectionState.monitorConsecutiveFailures,
        },
      };
    }

    yield { type: "complete", data: { sessionId: result.sessionId } };
  }

  /**
   * Update monitor busy flag in database
   */
  private async updateMonitorBusy(
    sessionId: string,
    monitorBusy: boolean,
    monitorBusySince: number | null
  ): Promise<void> {
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
  async loadHistoryForReconnect(sessionId: string): Promise<Array<{ role: "user" | "model"; text: string }>> {
    try {
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
      const history = (dbState?.history || []) as ChatMessage[];
      const pending = (dbRow[0].pendingMessages || []) as PendingMessage[];

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

/**
 * Process input through the dual-agent system
 */
export async function* processInput(
  input: DualAgentInput
): AsyncGenerator<{
  type: "text" | "board" | "board_patch" | "audio" | "transcription" | "complete" | "interpretation" | "interpretation_audio" | "transcript" | "context" | "debug" | "monitor_status" | "app_open" | "app_close" | "emote" | "set_board" | "ai_button_press" | "yes_no" | "ask_yes_no";
  data: any;
  speaker?: string;
}> {
  yield* dualAgentService.processInput(input);
}
