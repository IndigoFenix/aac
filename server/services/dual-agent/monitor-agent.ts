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
import type { AACInteractionMode } from "./types";
import {
  AAC_DEFAULT_PERSONA_PROMPT,
  buildInteractiveSystemPrompt,
  buildMonitorSystemPrompt,
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
  private student?: { name: string; aacChatAgentPrompt?: string | null; framework?: string | null; primaryLanguage?: string | null };
  private framework: string | null = null;

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
   * Initialize a new session and create the Interactive Agent's prompt
   * This is called when starting a new dual-agent session
   */
  async initializeSession(interactionMode: AACInteractionMode = 'interact'): Promise<{
    interactivePrompt: string;
    sessionId: string;
    initialContext?: string;
  }> {
    console.log("[MonitorAgent] Initializing session for student:", this.studentId);

    // Load student data
    const student = await studentRepository.getStudentById(this.studentId);
    if (!student) {
      throw new Error(`Student not found: ${this.studentId}`);
    }

    // Store for later use in processPendingMessages / respondInThinkingMode
    this.student = student;
    this.framework = student.framework || null;

    const personaPrompt = student.aacChatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;

    // Use sessionService to search memory and get additional context
    const contextResult = await this.searchMemoryForContext(student);

    // Build the Interactive Agent's prompt using the helper
    const basePrompt = buildInteractiveSystemPrompt(
      student.name,
      personaPrompt,
      student.primaryLanguage || undefined,
      contextResult.additionalContext,
      interactionMode
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
   * Search memory for relevant context about the student
   * Uses the existing sessionService memory system
   */
  private async searchMemoryForContext(student: any): Promise<{
    sessionId: string;
    additionalContext?: string;
  }> {
    // Create a targeted system message — ask only for essential fields to minimize tool calls
    const systemMessage: ChatMessage = {
      role: "system",
      content:
        "Read /Student_Notes and /Student_CommunicationStyle only. Do not read any other fields. Respond with OK when done.",
      timestamp: Date.now(),
    };

    try {
      // Use sessionService to create/load session and access memory
      const result = await onMessage({
        userId: this.userId || "system",
        studentId: this.studentId,
        sessionId: this.sessionId,
        activeFeature: "aac",
        persona: "aac-assistant" as ChatPersona,
        messages: [systemMessage],
        featureContext: {},
        replyType: "text",
      });

      // Extract any relevant context from memory values
      const memoryValues = result.memoryValues || {};
      const contextParts: string[] = [];

      // Check for student notes
      if (memoryValues.Student_Notes) {
        contextParts.push(`Previous notes: ${memoryValues.Student_Notes}`);
      }

      // Check for communication style
      if (memoryValues.Student_CommunicationStyle) {
        contextParts.push(
          `Communication style: ${JSON.stringify(memoryValues.Student_CommunicationStyle)}`
        );
      }

      // Check for interests
      if (memoryValues.Student_Interests) {
        contextParts.push(`Interests: ${memoryValues.Student_Interests}`);
      }

      return {
        sessionId: result.sessionId || `aac-${Date.now()}`,
        additionalContext:
          contextParts.length > 0 ? contextParts.join("\n") : undefined,
      };
    } catch (error) {
      console.error("[MonitorAgent] Error searching memory:", error);
      // Return a new session ID if we couldn't use sessionService
      return {
        sessionId: `aac-${Date.now()}`,
      };
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
        userId: this.userId || "system",
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
        userId: this.userId || "system",
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
    const student = await studentRepository.getStudentById(this.studentId);
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
