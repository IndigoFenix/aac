// server/services/dual-agent/dual-agent-service.ts
// Main coordinator for the dual-agent AAC system

import { db } from "../../db";
import { chatSessions } from "@shared/schema";
import { eq } from "drizzle-orm";
import type { ChatMessage, ParsedBoardData } from "@shared/schema";
import {
  InteractiveAgent,
  createInteractiveAgent,
} from "./interactive-agent";
import { MonitorAgent, createMonitorAgent } from "./monitor-agent";
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
  AAC_DETECTION_PROMPT,
  AAC_DETECTION_INTERACT_ADDENDUM,
  AAC_DETECTION_SILENT_ADDENDUM,
  AAC_BUTTON_PROMPT,
  AAC_SILENT_BUTTON_PROMPT,
  buildInteractiveSystemPrompt,
} from "../memory-schema/aac-memory-schema";
import { whisperService } from "../voice/whisper-service";
import { openaiTtsService } from "../voice/openai-tts-service";

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

  constructor(config: Partial<DualAgentConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
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
   * Uses two-step approach because OpenAI often returns EITHER text OR tool calls:
   * 1. First request: Get greeting text (no tools)
   * 2. Second request: Get board buttons (with tools)
   */
  async *initializeWithGreeting(
    studentId: string,
    userId?: string,
    existingSessionId?: string,
    board?: ParsedBoardData,
    interactionMode: AACInteractionMode = 'interact'
  ): AsyncGenerator<{
    type: "text" | "board" | "audio" | "transcription" | "complete";
    data: any;
  }> {
    // Initialize the session first
    const state = await this.initializeSession(studentId, userId, existingSessionId, interactionMode);
    const cached = sessionCache.get(state.sessionId);

    if (!cached) {
      yield { type: "complete", data: { sessionId: state.sessionId, error: "Session not cached" } };
      return;
    }

    const { interactiveAgent } = cached;
    const isSilent = interactionMode === 'silent';

    let fullText = "";

    if (!isSilent) {
      // Step 1: Get greeting text (without tool calls) — only in interact mode
      const greetingMessage = "Say hello to the user with a short, friendly greeting (1-2 sentences). Just respond with the greeting text, nothing else.";

      try {
        const greetingResponse = await interactiveAgent.processMessage(
          greetingMessage,
          [],
          [],
          board
        );

        fullText = greetingResponse.text || "";
        yield { type: "text", data: fullText };

        console.log("[DualAgentService] Greeting generated:", fullText);
      } catch (err) {
        console.error("[DualAgentService] Greeting error:", err);
        fullText = "";
        yield { type: "text", data: fullText };
      }
    }

    // Step 2: Get initial board buttons (with tool call)
    const boardMessage = isSilent
      ? "Generate 4-8 contextual utterance buttons — complete phrases the user might want to say to people around them. Call the update_board function."
      : "Now provide initial communication buttons for the user. Create 4-6 buttons with options related to the student or their surroundings. Call the update_board function.";

    try {
      for await (const chunk of interactiveAgent.processMessageStream(
        boardMessage,
        fullText ? [{ role: "assistant", content: fullText, timestamp: Date.now() }] : [],
        [],
        board
      )) {
        if (chunk.type === "board") {
          console.log("[DualAgentService] Board generated:", JSON.stringify(chunk.data).substring(0, 200));
          yield { type: "board", data: chunk.data };
        }
      }
    } catch (err) {
      console.error("[DualAgentService] Board generation error:", err);
      const defaultBoard = this.createDefaultBoard(board);
      yield { type: "board", data: defaultBoard };
    }

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
        for await (const audioChunk of openaiTtsService.synthesizeStream(
          fullText,
          "en",
          { voiceType: this.config.ttsVoiceType }
        )) {
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
    const grid = currentBoard?.grid || { rows: 3, cols: 3 };
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
      { label: "Yes", row: 0, col: 1 },
      { label: "No", row: 0, col: 2 },
      { label: "I want", row: 1, col: 0 },
      { label: "Help", row: 1, col: 1 },
      { label: "More", row: 1, col: 2 },
      { label: "Thank you", row: 2, col: 0 },
      { label: "Please", row: 2, col: 1 },
      { label: "Stop", row: 2, col: 2 },
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
      this.config
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
        this.config
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
    type: "text" | "board" | "audio" | "transcription" | "complete";
    data: any;
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
        interactionMode
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
    interactionMode: AACInteractionMode = 'interact'
  ): AsyncGenerator<{
    type: "text" | "board" | "audio";
    data: any;
  }> {
    const isSilent = interactionMode === 'silent';
    let fullText = "";
    console.log("[DualAgentService] handleInteractiveMode: thinkingMode:", state.thinkingMode, "interactionMode:", interactionMode, "messages:", state.messages.length, "pending:", state.pendingMessages.length);

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

    // Stream response from Interactive agent (with image if provided)
    for await (const chunk of interactiveAgent.processMessageStream(
      userMessage,
      state.messages,
      state.pendingMessages,
      board,
      visualContext,
      audioContext,
      imageData,
      personContext
    )) {
      if (chunk.type === "text") {
        fullText += chunk.data;
        if (!isSilent) {
          yield { type: "text", data: chunk.data };
        }
      } else if (chunk.type === "board") {
        yield { type: "board", data: chunk.data };
      } else if (chunk.type === "command") {
        // Handle command from Interactive
        await this.handleInteractiveCommand(state, chunk.data);
      }
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

    // Generate audio if enabled (skip in silent mode)
    if (this.config.enableTTS && fullText && !isSilent) {
      for await (const audioChunk of openaiTtsService.synthesizeStream(
        fullText,
        "en", // TODO: Get from student settings
        { voiceType: this.config.ttsVoiceType }
      )) {
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
      for await (const audioChunk of openaiTtsService.synthesizeStream(
        fullText,
        "en",
        { voiceType: this.config.ttsVoiceType }
      )) {
        yield { type: "audio", data: audioChunk.toString("base64") };
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
    } catch (err) {
      console.error("[DualAgentService] Interpret error:", err);
      fullText = recentButtons.join(". ");
    }

    yield { type: "text", data: fullText };

    // Always generate TTS for interpret — the whole point is to speak aloud
    if (this.config.enableTTS && fullText) {
      try {
        for await (const audioChunk of openaiTtsService.synthesizeStream(
          fullText,
          "en",
          { voiceType: this.config.ttsVoiceType }
        )) {
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
   * Returns updated board only if buttons meaningfully changed.
   * Does NOT trigger Monitor or TTS.
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

    // Build detection-specific system prompt
    const modeAddendum = interactionMode === 'silent'
      ? AAC_DETECTION_SILENT_ADDENDUM
      : AAC_DETECTION_INTERACT_ADDENDUM;
    const buttonRules = interactionMode === 'silent'
      ? AAC_SILENT_BUTTON_PROMPT
      : AAC_BUTTON_PROMPT;
    const detectionSystemPrompt = AAC_DETECTION_PROMPT + modeAddendum + buttonRules;

    try {
      const result = await interactiveAgent.processDetection(
        state.messages,
        input.board,
        input.imageData,
        input.audioContext,
        detectionSystemPrompt
      );

      // Compare returned buttons to current board to determine if changed
      const changed = this.boardLabelsChanged(input.board, result.board);

      if (changed && result.board) {
        state.currentBoard = result.board;
        // Save board state (lightweight save, skip full session persist)
        console.log("[DualAgentService] Detection: board changed, updating state");
      }

      return {
        sessionId: state.sessionId,
        board: result.board,
        changed,
      };
    } catch (error) {
      console.error("[DualAgentService] processDetection error:", error);
      return { sessionId: state.sessionId, changed: false };
    }
  }

  /**
   * Compare two boards by button labels (case-insensitive) to determine if they differ.
   */
  private boardLabelsChanged(
    oldBoard?: ParsedBoardData,
    newBoard?: ParsedBoardData
  ): boolean {
    if (!oldBoard && !newBoard) return false;
    if (!oldBoard || !newBoard) return true;

    const getLabels = (board: ParsedBoardData): string[] => {
      const page = board.pages?.find(p => p.id === board.currentPageId) || board.pages?.[0];
      return (page?.buttons || [])
        .map((b: { label?: string }) => (b.label || "").toLowerCase().trim())
        .filter(Boolean)
        .sort();
    };

    const oldLabels = getLabels(oldBoard);
    const newLabels = getLabels(newBoard);

    if (oldLabels.length !== newLabels.length) return true;
    return oldLabels.some((label, i) => label !== newLabels[i]);
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
  type: "text" | "board" | "audio" | "transcription" | "complete";
  data: any;
}> {
  yield* dualAgentService.processInput(input);
}
