// server/services/dual-agent/monitor-agent.ts
// Monitor Agent for thorough processing, memory management, and database access

import { onMessage, onMessageStreaming } from "../sessionService";
import type { ChatMessage, ParsedBoardData, ChatPersona } from "@shared/schema";
import type {
  MonitorMessage,
  MonitorResponse,
  PendingMessage,
  DualAgentConfig,
} from "./types";
import { MONITOR_COMMANDS } from "./types";
import { studentRepository } from "../../repositories";
import type { StudentWithAacSettings } from "@shared/schema";
import type { AACInteractionMode, AACAppDefinition } from "./types";
import {
  AAC_DEFAULT_PERSONA_PROMPT,
  buildInteractiveSystemPrompt,
  buildMonitorSystemPrompt,
  preloadAllStudentContext,
} from "../memory-schema/aac-memory-schema";

/**
 * Monitor Agent
 *
 * Handles complex database operations, memory management, and student context.
 * Uses 4o for better reasoning and memory management.
 * Initializes the Interactive Agent and can inject commands into the conversation.
 */
export class MonitorAgent {
  private config: DualAgentConfig;
  private studentId: string;
  private userId?: string;
  private sessionId?: string;
  private student?: StudentWithAacSettings;
  private framework: string | null = null;
  private privacyOptions: { allowReadProgress: boolean; allowReadReports: boolean; allowNotes: boolean } = {
    allowReadProgress: true, allowReadReports: true, allowNotes: true,
  };

  constructor(
    studentId: string,
    config: DualAgentConfig,
    userId?: string,
    sessionId?: string
  ) {
    this.studentId = studentId;
    this.config = config;
    this.userId = userId;
    this.sessionId = sessionId;
  }

  /**
   * Get the loaded student data
   */
  getStudent() {
    return this.student;
  }

  /**
   * Get privacy options for the current session
   */
  getPrivacyOptions() {
    return this.privacyOptions;
  }

  /**
   * Initialize a new session and create the Interactive Agent's prompt
   * This is called when starting a new dual-agent session
   */
  async initializeSession(interactionMode: AACInteractionMode = 'interact', enabledApps: AACAppDefinition[] = []): Promise<{
    interactivePrompt: string;
    sessionId: string;
    initialContext?: string;
  }> {
    console.log("[MonitorAgent] Initializing session for student:", this.studentId);

    // Load student data with AAC settings
    const student = await studentRepository.getStudentWithAacSettings(this.studentId);
    if (!student) {
      throw new Error(`Student not found: ${this.studentId}`);
    }

    // Store for later use in processPendingMessages / respondInThinkingMode
    this.student = student;
    this.framework = student.framework || null;

    const aac = student.aacSettings;
    const personaPrompt = aac?.chatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;

    // Store privacy options from AAC settings
    this.privacyOptions = {
      allowReadProgress: aac?.allowReadProgress ?? true,
      allowReadReports: aac?.allowReadReports ?? true,
      allowNotes: aac?.allowNotes ?? true,
    };

    // Branch on startup mode: 0=fast (no LLM), 1=thorough (preload + LLM summary)
    const startupMode = aac?.startupMode ?? 0;
    console.log("[MonitorAgent] Startup mode:", startupMode === 0 ? "fast" : "thorough");
    const contextResult = startupMode === 1
      ? await this.longInitializeContext(student)
      : await this.fastInitializeContext(student);

    // Build the Interactive Agent's prompt using the helper
    // Compute age from birthDate
    const age = student.birthDate ? (() => {
      const bd = new Date(student.birthDate!);
      if (isNaN(bd.getTime())) return undefined;
      const now = new Date();
      let a = now.getFullYear() - bd.getFullYear();
      const m = now.getMonth() - bd.getMonth();
      if (m < 0 || (m === 0 && now.getDate() < bd.getDate())) a--;
      return a >= 0 ? String(a) : undefined;
    })() : undefined;

    const basePrompt = buildInteractiveSystemPrompt(
      student.name,
      personaPrompt,
      student.primaryLanguage || undefined,
      contextResult.additionalContext,
      interactionMode,
      age,
      student.gender || undefined,
      undefined, // diagnosis loaded later in dual-agent-service
      false,
      enabledApps,
      null, // activeApp
      "happy", // currentEmote - monitor init always starts happy
      'analyze', // responseMode
      undefined, // knownContacts
      undefined, // availableBoards
      undefined, // loadedBoardName
      undefined, // loadedPageName
      12, // maxBoardItems
      undefined, // loadedPageNavButtons
      aac?.interpretationLevel ?? 2
    );

    // Store the session ID if we created one
    this.sessionId = contextResult.sessionId;

    console.log("[MonitorAgent] Session initialized:", this.sessionId);

    return {
      interactivePrompt: basePrompt,
      sessionId: contextResult.sessionId,
      initialContext: contextResult.additionalContext,
    };
  }

  /**
   * Fast startup (mode 0): Read chatMemory fields directly from already-loaded student record.
   * No LLM call, no extra DB queries — instant startup.
   */
  private async fastInitializeContext(student: any): Promise<{
    sessionId: string;
    additionalContext?: string;
  }> {
    const sessionId = this.sessionId || `aac-${Date.now()}`;
    const memory = (student.chatMemory as Record<string, any>) || {};
    const contextParts: string[] = [];

    const now = new Date();
    contextParts.push(`Date: ${now.toLocaleDateString()} Time: ${now.toLocaleTimeString()}`);

    if (memory.Student_Notes && this.privacyOptions.allowNotes) {
      contextParts.push(`Previous notes: ${memory.Student_Notes}`);
    }
    if (memory.Student_Interests) {
      contextParts.push(`Interests: ${memory.Student_Interests}`);
    }
    if (memory.Student_CommunicationStyle) {
      contextParts.push(`Communication style: ${JSON.stringify(memory.Student_CommunicationStyle)}`);
    }
    if (memory.Student_Preferences) {
      contextParts.push(`Preferences: ${JSON.stringify(memory.Student_Preferences)}`);
    }

    return {
      sessionId,
      additionalContext: contextParts.length > 1 ? contextParts.join("\n") : undefined,
    };
  }

  /**
   * Thorough startup (mode 1): Preload all Context_ data in parallel,
   * then make a single LLM call to compile concise actionable guidance.
   * Falls back to fast mode on error.
   */
  private async longInitializeContext(student: any): Promise<{
    sessionId: string;
    additionalContext?: string;
  }> {
    try {
      // Load all context data in parallel (gated by privacy settings)
      const allContext = await preloadAllStudentContext(this.studentId, {
        allowReadProgress: this.privacyOptions.allowReadProgress,
        allowReadReports: this.privacyOptions.allowReadReports,
      });

      // Also read chatMemory fields
      const memory = (student.chatMemory as Record<string, any>) || {};
      const memoryParts: string[] = [];
      if (memory.Student_Notes) memoryParts.push(`Notes: ${memory.Student_Notes}`);
      if (memory.Student_Interests) memoryParts.push(`Interests: ${memory.Student_Interests}`);
      if (memory.Student_CommunicationStyle) memoryParts.push(`Communication style: ${JSON.stringify(memory.Student_CommunicationStyle)}`);
      if (memory.Student_Preferences) memoryParts.push(`Preferences: ${JSON.stringify(memory.Student_Preferences)}`);

      const now = new Date();
      const fullContext = [
        `Date: ${now.toLocaleDateString()} Time: ${now.toLocaleTimeString()}`,
        allContext,
        memoryParts.length > 0 ? `## Session Memory\n${memoryParts.join('\n')}` : '',
      ].filter(Boolean).join('\n\n');

      // Single LLM call: ask monitor to compile actionable guidance
      const systemMessage: ChatMessage = {
        role: "system",
        content: `You are preparing a concise startup briefing for an AAC interactive agent about to begin a session with a student.

Here is everything we know about the student:
${fullContext}

Compile a concise, actionable briefing (max 500 words) for the interactive agent. Include:
1. Key medical alerts or safety considerations (if any)
2. Communication strategies based on the student's profile
3. Current goals/objectives to support during the session
4. Conversation starters based on interests
5. Important people the student may mention

Be direct and practical. Skip sections with no data. Do not use the memory tool — all data is provided above.`,
        timestamp: Date.now(),
      };

      const result = await onMessage({
        userId: this.userId,
        studentId: this.studentId,
        sessionId: this.sessionId,
        activeFeature: "aac",
        persona: "aac-assistant" as ChatPersona,
        messages: [systemMessage],
        featureContext: {},
        replyType: "text",
      });

      const briefing = typeof result.message?.content === 'string' ? result.message.content : undefined;
      const sessionId = result.sessionId || this.sessionId || `aac-${Date.now()}`;

      return {
        sessionId,
        additionalContext: briefing || fullContext,
      };
    } catch (error) {
      console.error("[MonitorAgent] Thorough startup failed, falling back to fast:", error);
      return this.fastInitializeContext(student);
    }
  }

  /**
   * Process pending messages that have accumulated while Monitor was busy
   * This syncs the Interactive Agent's messages with the database
   */
  async processPendingMessages(
    pendingMessages: PendingMessage[],
    currentBoard?: ParsedBoardData,
    interactionMode: AACInteractionMode = 'interact'
  ): Promise<MonitorResponse> {
    if (pendingMessages.length === 0) {
      return {};
    }

    console.log(
      "[MonitorAgent] Processing",
      pendingMessages.length,
      "pending messages, student:",
      this.student?.name || "NOT LOADED",
      "mode: dual, sessionId:",
      this.sessionId
    );

    // Convert pending messages to ChatMessage format
    const messages: ChatMessage[] = pendingMessages.map((pm) => ({
      role: pm.role,
      content: pm.content,
      timestamp: pm.timestamp,
    }));

    // Build feature context with board if available
    const featureContext: any = {};
    if (currentBoard) {
      featureContext.board = {
        data: currentBoard,
        currentPageId: currentBoard.currentPageId,
      };
    }

    try {
      // Build monitor prompt for dual mode
      const systemPromptOverride = this.student
        ? buildMonitorSystemPrompt('dual', this.student, this.framework, interactionMode)
        : undefined;

      // Process through sessionService for memory updates
      const result = await onMessage({
        userId: this.userId,
        studentId: this.studentId,
        sessionId: this.sessionId,
        activeFeature: "aac",
        persona: "aac-assistant" as ChatPersona,
        messages,
        featureContext,
        replyType: "text",
        systemPromptOverride,
      });

      // Extract any commands or context updates from the response
      const responseContent = result.message?.content;
      const responseText =
        typeof responseContent === "string"
          ? responseContent
          : (responseContent as any)?.text || "";

      // Check if Monitor wants to inject context or update prompt
      const response: MonitorResponse = {};

      // Check for special directives in the response
      if (responseText.includes("[UPDATE_PROMPT]")) {
        const promptMatch = responseText.match(
          /\[UPDATE_PROMPT\]([\s\S]*?)\[\/UPDATE_PROMPT\]/
        );
        if (promptMatch) {
          response.updatedPrompt = promptMatch[1].trim();
        }
      }

      if (responseText.includes("[CONTEXT]")) {
        const contextMatch = responseText.match(
          /\[CONTEXT\]([\s\S]*?)\[\/CONTEXT\]/
        );
        if (contextMatch) {
          response.contextInjection = contextMatch[1].trim();
        }
      }

      return response;
    } catch (error) {
      console.error("[MonitorAgent] Error processing pending messages:", error);
      return {};
    }
  }

  /**
   * Handle thinking mode - Monitor responds directly to the user
   * Uses streaming for real-time response
   */
  async *respondInThinkingMode(
    userMessage: string,
    messages: ChatMessage[],
    currentBoard?: ParsedBoardData
  ): AsyncGenerator<{
    type: "text" | "board" | "complete";
    data: any;
  }> {
    console.log("[MonitorAgent] Responding in thinking mode, student:", this.student?.name || "NOT LOADED", "sessionId:", this.sessionId);

    // Build feature context
    const featureContext: any = {};
    if (currentBoard) {
      featureContext.board = {
        data: currentBoard,
        currentPageId: currentBoard.currentPageId,
      };
    }

    // Add the user message
    const inputMessages: ChatMessage[] = [
      ...messages,
      {
        role: "user",
        content: userMessage,
        timestamp: Date.now(),
      },
    ];

    try {
      let fullText = "";
      let finalBoard: ParsedBoardData | undefined;

      // Build monitor prompt for thinking mode
      const systemPromptOverride = this.student
        ? buildMonitorSystemPrompt('thinking', this.student, this.framework)
        : undefined;

      // Use streaming session service
      const streamResult = await onMessageStreaming({
        userId: this.userId,
        studentId: this.studentId,
        sessionId: this.sessionId || undefined,
        activeFeature: "aac",
        persona: "aac-assistant" as ChatPersona,
        messages: inputMessages,
        featureContext,
        replyType: "text",
        onThinkingUpdate: (status: string) => {
          console.log("[MonitorAgent] Thinking:", status);
        },
        systemPromptOverride,
      });

      // Extract text from the streaming result
      if (streamResult?.message?.content) {
        const content = streamResult.message.content;
        fullText = typeof content === "string" ? content : (content as any)?.text || "";
      }

      // Yield the collected text
      if (fullText) {
        yield { type: "text", data: fullText };
      }

      // Check if we should exit thinking mode
      if (fullText.includes(MONITOR_COMMANDS.RESUME)) {
        yield {
          type: "complete",
          data: { exitThinkingMode: true },
        };
      } else {
        yield {
          type: "complete",
          data: { exitThinkingMode: false },
        };
      }
    } catch (error) {
      console.error("[MonitorAgent] Error in thinking mode:", error);
      throw error;
    }
  }

  /**
   * Create a command message for the Interactive Agent
   * This will appear as a system message to Interactive
   */
  createCommandMessage(command: string, content: string): ChatMessage {
    return {
      role: "assistant", // Appears as assistant to Monitor
      content: `${command} ${content}`,
      timestamp: Date.now(),
      metadata: {
        isMonitorCommand: true, // Interactive will see this as system
      },
    };
  }

  /**
   * Ensure student data is loaded (for resumed sessions where initializeSession wasn't called)
   */
  async ensureStudentLoaded(): Promise<void> {
    if (this.student) return;
    console.log("[MonitorAgent] Loading student data for resumed session:", this.studentId);
    const student = await studentRepository.getStudentWithAacSettings(this.studentId);
    if (student) {
      this.student = student;
      this.framework = student.framework || null;
    } else {
      console.warn("[MonitorAgent] Student not found on resume:", this.studentId);
    }
  }

  /**
   * Update the session ID (after session creation)
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string | undefined {
    return this.sessionId;
  }
}

/**
 * Create a new Monitor Agent
 */
export function createMonitorAgent(
  studentId: string,
  config: DualAgentConfig,
  userId?: string,
  sessionId?: string
): MonitorAgent {
  return new MonitorAgent(studentId, config, userId, sessionId);
}
