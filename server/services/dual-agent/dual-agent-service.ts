// server/services/dual-agent/dual-agent-service.ts
// Main coordinator for the dual-agent AAC system

import { db } from "../../db";
import { chatSessions, students, users } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
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
 * Cache for active dual-agent sessions
 * Key: sessionId, Value: session state and agents
 */
interface SessionCache {
  state: DualAgentSessionState;
  interactiveAgent: InteractiveAgent;
  monitorAgent: MonitorAgent;
  lastAccess: number;
  monitorMutex: SessionMutex;
}

const sessionCache = new Map<string, SessionCache>();

// Cache TTL: 30 minutes
const CACHE_TTL = 30 * 60 * 1000;

// Monitor staleness timeout: 30 seconds
const MONITOR_TIMEOUT_MS = 30_000;

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

  // Whisper hallucinates these phrases on silence / ambient noise
  private static WHISPER_HALLUCINATION_PATTERNS = [
    /^thank\s*you/i,
    /^thanks\s*(for\s*(watching|listening|viewing))?\.?$/i,
    /^(please\s+)?subscribe/i,
    /^(please\s+)?like\s+and\s+subscribe/i,
    /^bye[\.\s]*$/i,
    /^you$/i,
    /^\.+$/,
    /^(\s|\.|\,)+$/,
    /^music$/i,
    /^silence$/i,
    /^\[.*\]$/, // [Music], [Silence], etc.
  ];

  constructor(config: Partial<DualAgentConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Detect common Whisper hallucinations on ambient/silent audio.
   */
  private isWhisperHallucination(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length === 0) return true;
    // Very short transcriptions from 5s audio are almost always hallucinations
    if (trimmed.length < 4) return true;
    return DualAgentService.WHISPER_HALLUCINATION_PATTERNS.some((p) => p.test(trimmed));
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
    const [aiCustom, studentCustom] = await Promise.all([
      student?.aacCustomVoiceId
        ? voiceRecordRepository.getVoiceById(student.aacCustomVoiceId)
        : Promise.resolve(undefined),
      student?.aacCustomStudentVoiceId
        ? voiceRecordRepository.getVoiceById(student.aacCustomStudentVoiceId)
        : Promise.resolve(undefined),
    ]);
    return {
      aiVoice: {
        fallbackType: (student?.aacVoiceType as any) || "woman",
        customVoice: aiCustom || null,
        language: student?.primaryLanguage || "en",
      },
      studentVoice: {
        fallbackType: (student?.aacStudentVoiceType as any) || "boy",
        customVoice: studentCustom || null,
        language: student?.primaryLanguage || "en",
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
    interactionMode: AACInteractionMode = 'interact'
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
    return this.createNewSession(studentId, userId, interactionMode);
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
    type: "text" | "board" | "board_patch" | "audio" | "transcription" | "complete" | "interpretation" | "interpretation_audio" | "transcript" | "context";
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
    const personaHint = student?.aacChatAgentPrompt?.trim()
      ? `\nThe student is ${student.name}. Use their profile (in the system prompt) to personalize the board — reflect their interests, communication level, and needs.`
      : "";

    // Combined greeting + board in one LLM call
    const imageHint = imageData ? "\nUse the camera image to observe the environment and make the buttons contextually relevant." : "";
    const greetingBoardMessage = isSilent
      ? `Generate 4-12 contextual utterance buttons — complete phrases the user might want to say. Use the student's profile and interests from the system prompt to make them relevant.${imageHint} Use [REBUILD_BOARD] to create the initial board.${personaHint}`
      : `Greet the user with a short, friendly greeting (1-2 sentences) and provide 4-12 initial communication buttons that reflect the student's interests, needs, and communication level from the system prompt. The buttons should be appropriate responses to your greeting.${imageHint} Use [SPEAK] for your greeting and [REBUILD_BOARD] for the buttons.${personaHint}`;

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
        } else if (chunk.type === "board_patch") {
          console.log("[DualAgentService] Board patch:", JSON.stringify(chunk.data).substring(0, 200));
          yield { type: "board_patch", data: chunk.data };
        } else if (chunk.type === "usage") {
          streamUsage = chunk.data;
        }
      }
      if (streamUsage) {
        await this.trackInteractiveCredits(state.sessionId, state.studentId, state.userId, streamUsage);
      }
    } catch (err) {
      console.error("[DualAgentService] Greeting+board error:", err);
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
    interactionMode: AACInteractionMode = 'interact'
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

    // Initialize session - Monitor searches memory and creates prompt
    const initResult = await monitorAgent.initializeSession(interactionMode);

    // Create Interactive agent with the prompt
    const interactiveAgent = createInteractiveAgent(
      initResult.interactivePrompt,
      this.config,
      chatProvider
    );

    // Create session state
    const state: DualAgentSessionState = {
      sessionId: initResult.sessionId,
      studentId,
      userId,
      interactivePrompt: initResult.interactivePrompt,
      thinkingMode: false,
      monitorBusy: false,
      messages: [],
      pendingMessages: [],
      interactionMode,
      lastInteractiveActivity: Date.now(),
      lastMonitorActivity: Date.now(),
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
        lastInteractiveActivity: Date.now(),
        lastMonitorActivity: Date.now(),
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
    type: "text" | "board" | "board_patch" | "audio" | "transcription" | "complete" | "interpretation" | "interpretation_audio" | "transcript" | "context";
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
    if (interactionMode !== state.interactionMode) {
      console.log(`[DualAgentService] Mode switch: ${state.interactionMode} → ${interactionMode}`);
      state.interactionMode = interactionMode;

      // Rebuild interactive prompt for new mode
      const student = monitorAgent.getStudent();
      if (student) {
        const personaPrompt = student.aacChatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;
        const newPrompt = buildInteractiveSystemPrompt(
          student.name,
          personaPrompt,
          student.primaryLanguage || undefined,
          undefined,
          interactionMode
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
        input.gestureContext
      );
    }

    // State is saved by:
    // - Interactive mode: doMonitorProcessing saves when complete
    // - Thinking mode: handleThinkingMode saves at the end
    // Pending messages are already persisted at line 509 for crash recovery

    yield { type: "complete", data: { sessionId: state.sessionId } };
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
    gestureContext?: string
  ): AsyncGenerator<{
    type: "text" | "board" | "board_patch" | "audio" | "interpretation" | "interpretation_audio" | "transcript" | "context";
    data: any;
    speaker?: string;
  }> {
    const isSilent = interactionMode === 'silent';
    const modeStart = Date.now();
    let fullText = "";
    let fullInterpretation = "";
    console.log("[DualAgentService] handleInteractiveMode: thinkingMode:", state.thinkingMode, "interactionMode:", interactionMode, "messages:", state.messages.length, "pending:", state.pendingMessages.length);
    logDualAgent("DualAgentService.handleInteractiveMode", { interactionMode, messageCount: state.messages.length, pendingCount: state.pendingMessages.length });

    // Build person context string if identified
    let personContext: string | undefined;
    if (identifiedPerson) {
      const confidence = Math.round(identifiedPerson.confidence * 100);
      if (identifiedPerson.type === "student") {
        personContext = `[Person identified: This is the student "${identifiedPerson.name}" (${confidence}% confidence)]`;
      } else {
        personContext = `[Person identified: ${identifiedPerson.name} (${identifiedPerson.relationship || "caregiver"}, ${confidence}% confidence)]`;
      }
    }

    // Combine additional context strings (person identification + gesture/expression data)
    const contextParts: string[] = [];
    if (personContext) contextParts.push(personContext);
    if (gestureContext) contextParts.push(gestureContext);
    const combinedContext = contextParts.length > 0 ? contextParts.join("\n") : undefined;

    // Stream response from Interactive agent (with image if provided)
    let interactiveUsage: { promptTokens: number; completionTokens: number } | undefined;
    for await (const chunk of interactiveAgent.processMessageStream(
      userMessage,
      state.messages,
      state.pendingMessages,
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
        yield { type: "board", data: chunk.data };
      } else if (chunk.type === "board_patch") {
        yield { type: "board_patch", data: chunk.data };
      } else if (chunk.type === "command") {
        // Handle command from Interactive
        await this.handleInteractiveCommand(state, chunk.data);
      } else if (chunk.type === "usage") {
        interactiveUsage = chunk.data;
      }
    }

    const modeElapsed = Date.now() - modeStart;
    logDualAgent("DualAgentService.handleInteractiveMode.done", { elapsedMs: modeElapsed, textLength: fullText.length, interpretationLength: fullInterpretation.length });

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

    // Trigger Monitor processing with proper concurrency control
    const cached = sessionCache.get(state.sessionId)!;
    this.tryTriggerMonitor(cached, state, monitorAgent, interactiveAgent, board);

    // Generate AI voice audio if enabled (skip in silent mode)
    if (this.config.enableTTS && fullText && !isSilent) {
      const voices = await this.resolveVoices(cached);
      for await (const audioChunk of ttsFacade.synthesizeStream(fullText, voices.aiVoice)) {
        yield { type: "audio", data: audioChunk.toString("base64") };
      }
    }

    // Generate student voice audio for interpretation (both modes)
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
    board?: ParsedBoardData
  ): Promise<void> {
    const { monitorMutex } = cached;

    // Acquire mutex to make check-and-set atomic
    await monitorMutex.acquire();

    if (state.monitorBusy) {
      console.log("[DualAgentService] Monitor already busy, skipping trigger");
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
   * Perform Monitor processing in the background
   * This happens asynchronously so it doesn't block Interactive responses
   */
  private async doMonitorProcessing(
    state: DualAgentSessionState,
    monitorAgent: MonitorAgent,
    interactiveAgent: InteractiveAgent,
    board?: ParsedBoardData
  ): Promise<void> {
    if (state.pendingMessages.length === 0) {
      state.monitorBusy = false;
      state.monitorBusySince = undefined;
      await this.updateMonitorBusy(state.sessionId, false, null);
      return;
    }

    // Timeout guard: abort if monitor takes too long (30 seconds)
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => {
      console.warn("[DualAgentService] Monitor processing timed out after 30s");
      timeoutController.abort();
    }, MONITOR_TIMEOUT_MS);

    try {
      console.log("[DualAgentService] doMonitorProcessing: starting with", state.pendingMessages.length, "pending messages");

      // Snapshot pending messages to avoid mutation issues
      const pendingSnapshot = [...state.pendingMessages];

      // Process pending messages (with timeout race)
      const response = await Promise.race([
        monitorAgent.processPendingMessages(pendingSnapshot, board, state.interactionMode),
        new Promise<never>((_, reject) => {
          timeoutController.signal.addEventListener("abort", () =>
            reject(new Error("Monitor processing timed out"))
          );
        }),
      ]);

      // Move pending messages to main log
      for (const pending of pendingSnapshot) {
        state.messages.push({
          role: pending.role,
          content: pending.content,
          timestamp: pending.timestamp,
        });
      }
      // Remove only the messages we processed (new ones may have arrived)
      state.pendingMessages = state.pendingMessages.filter(
        (pm) => !pendingSnapshot.includes(pm)
      );

      // Handle Monitor response
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
      }

      console.log("[DualAgentService] doMonitorProcessing: completed successfully");

      // Save updated state
      await this.saveSessionToDB(state);
    } catch (error: any) {
      console.error("[DualAgentService] Monitor processing error:", error?.message || error);
    } finally {
      clearTimeout(timeout);
      state.monitorBusy = false;
      state.monitorBusySince = undefined;
      await this.updateMonitorBusy(state.sessionId, false, null);
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

    // Handle mode switch if needed
    if (interactionMode !== state.interactionMode) {
      console.log(`[DualAgentService] Detection mode switch: ${state.interactionMode} → ${interactionMode}`);
      state.interactionMode = interactionMode;

      const student = monitorAgent.getStudent();
      if (student) {
        const personaPrompt = student.aacChatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;
        const newPrompt = buildInteractiveSystemPrompt(
          student.name,
          personaPrompt,
          student.primaryLanguage || undefined,
          undefined,
          interactionMode
        );
        interactiveAgent.setSystemPrompt(newPrompt);
        state.interactivePrompt = newPrompt;
      }
    }

    // Transcribe ambient audio via Whisper for monitor context only.
    // The interactive agent receives raw audio directly (Gemini handles it natively).
    // Skip very small audio blobs (<15KB for 5s = likely silence) — Whisper hallucinates on silence.
    let audioTranscript: string | undefined;
    if (input.audioBuffer && input.audioBuffer.length > 15000) {
      try {
        const transcription = await whisperService.transcribeToText(
          input.audioBuffer,
          input.audioMimeType || "audio/webm"
        );
        if (transcription && !this.isWhisperHallucination(transcription)) {
          audioTranscript = transcription;
          console.log("[DualAgentService] Transcribed ambient audio:", audioTranscript.substring(0, 100));
        } else if (transcription) {
          console.log("[DualAgentService] Filtered Whisper hallucination:", transcription.substring(0, 80));
        }
      } catch (err) {
        console.warn("[DualAgentService] Whisper transcription failed for detection audio:", err);
      }
    } else if (input.audioBuffer) {
      console.log("[DualAgentService] Skipping audio transcription — too small:", input.audioBuffer.length, "bytes (likely silence)");
    }

    // NOTE: We no longer push a pre-detection pending message — it was confusing
    // the monitor into thinking the student did something. We only push a post-detection
    // message when there's actually a board change to report.

    // Build detection system prompt using the unified builder with isDetection=true
    // This ensures detection has full student context, memory, language, etc.
    const student = monitorAgent.getStudent();
    const personaPrompt = student?.aacChatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;
    const detectionSystemPrompt = buildInteractiveSystemPrompt(
      student?.name || "the student",
      personaPrompt,
      student?.primaryLanguage || undefined,
      undefined, // memoryContext - could be added if needed
      interactionMode,
      undefined, // studentAge
      undefined, // studentDiagnosis
      true // isDetection - adds conservative guidance and HIGH CONFIDENCE emphasis
    );

    const detStart = Date.now();
    try {
      // Call interactive agent — raw audio buffer goes directly to the provider
      // (Gemini handles audio natively; OpenAI/Claude strip it and fall back to text context)
      const result = await interactiveAgent.processDetection(
        state.messages,
        input.board,
        input.imageData,
        audioTranscript || input.audioContext,
        detectionSystemPrompt,
        input.gestureContext,
        input.audioBuffer
      );

      console.log("[DualAgentService] Detection processed:", JSON.stringify(result));

      // Track credits for detection
      if (result.usage) {
        await this.trackInteractiveCredits(state.sessionId, state.studentId, state.userId, result.usage);
      }

      const addButtons = result.addButtons || [];
      const removeLabels = result.removeLabels || [];
      const triggeredMessage = result.triggeredMessage;
      const interpretation = result.interpretation || result.triggeredMessage;
      const debugDescription = result.debugDescription;
      const changed = addButtons.length > 0 || removeLabels.length > 0;

      if (changed) {
        // Push post-detection pending message (assistant role = system observation, not a user action)
        const changeParts: string[] = [];
        if (addButtons.length > 0) changeParts.push(`Added buttons to AAC board: ${addButtons.map(b => b.label).join(", ")}`);
        if (removeLabels.length > 0) changeParts.push(`Removed buttons from AAC board: ${removeLabels.join(", ")}`);
        const envDesc = result.text ? ` Environment: ${result.text}` : "";
        state.pendingMessages.push({
          role: "assistant",
          content: `[SYSTEM — Automatic board update based on camera/environment scan. ${changeParts.join(". ")}.${envDesc}]`,
          timestamp: Date.now(),
        });
        await this.updatePendingMessages(state.sessionId, state.pendingMessages);
        console.log("[DualAgentService] Detection: board changed —", changeParts.join("; "));
      }

      // Only trigger monitor when there was a meaningful change
      if (changed) {
        this.tryTriggerMonitor(cached, state, monitorAgent, interactiveAgent, input.board);
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
      logDualAgent("DualAgentService.processDetection", { elapsedMs: detElapsed, changed, addCount: addButtons.length, removeCount: removeLabels.length, hasImage: !!input.imageData, hasAudio: !!input.audioBuffer, hasInterpretation: !!interpretation });

      return {
        sessionId: state.sessionId,
        addButtons: changed ? addButtons : undefined,
        removeLabels: changed ? removeLabels : undefined,
        changed,
        text: result.text || undefined,
        triggeredMessage, // deprecated alias for interpretation
        interpretation,
        interpretationAudio,
        debugDescription,
        transcript: result.transcript,
        transcriptSpeaker: result.transcriptSpeaker,
        contextUpdate: result.contextUpdate,
      };
    } catch (error) {
      console.error("[DualAgentService] processDetection error:", error);
      return { sessionId: state.sessionId, changed: false };
    }
  }

  /**
   * Process a detection frame with SSE streaming.
   * Uses existing processDetection for LLM, then streams TTS audio.
   * This provides streaming audio without requiring streaming LLM.
   */
  async *processDetectionStream(input: DetectionInput): AsyncGenerator<{
    type: "text" | "board" | "board_patch" | "audio" | "interpretation" | "interpretation_audio" | "transcript" | "context" | "complete";
    data: any;
    speaker?: string;
  }> {
    const isSilent = (input.interactionMode || 'interact') === 'silent';

    // Use existing non-streaming detection for LLM call
    const result = await this.processDetection(input);

    // Yield transcript if present
    if (result.transcript) {
      yield { type: "transcript", data: result.transcript, speaker: result.transcriptSpeaker };
    }

    // Yield context update if present
    if (result.contextUpdate) {
      yield { type: "context", data: result.contextUpdate };
    }

    // Yield AI voice text (only in interact mode)
    if (result.text && !isSilent) {
      yield { type: "text", data: result.text };
    }

    // Yield interpretation text
    if (result.interpretation) {
      yield { type: "interpretation", data: result.interpretation };
    }

    // Yield board patch if changed
    if (result.changed) {
      yield { type: "board_patch", data: { add: result.addButtons || [], remove: result.removeLabels || [] } };
    }

    // Debug description is included in the JSON response already, no need to yield for streaming

    // Stream TTS audio
    const cached = sessionCache.get(result.sessionId);
    if (this.config.enableTTS && cached) {
      const voices = await this.resolveVoices(cached);

      // AI voice audio (only in interact mode)
      if (result.text && !isSilent) {
        try {
          for await (const audioChunk of ttsFacade.synthesizeStream(result.text, voices.aiVoice)) {
            yield { type: "audio", data: audioChunk.toString("base64") };
          }
        } catch (err) {
          console.error("[DualAgentService] Detection stream TTS error:", err);
        }
      }

      // Interpretation audio (student voice, both modes)
      if (result.interpretation) {
        try {
          for await (const audioChunk of ttsFacade.synthesizeStream(result.interpretation, voices.studentVoice)) {
            yield { type: "interpretation_audio", data: audioChunk.toString("base64") };
          }
        } catch (err) {
          console.error("[DualAgentService] Detection stream interpretation TTS error:", err);
        }
      }
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
}

// Singleton instance
export const dualAgentService = new DualAgentService();

/**
 * Process input through the dual-agent system
 */
export async function* processInput(
  input: DualAgentInput
): AsyncGenerator<{
  type: "text" | "board" | "board_patch" | "audio" | "transcription" | "complete" | "interpretation" | "interpretation_audio" | "transcript" | "context";
  data: any;
  speaker?: string;
}> {
  yield* dualAgentService.processInput(input);
}
