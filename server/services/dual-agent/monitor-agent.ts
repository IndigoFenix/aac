// server/services/dual-agent/monitor-agent.ts
// Monitor Agent for thorough processing, memory management, and database access

import { onMessage } from "../sessionService";
import type { ChatMessage, ParsedBoardData, ChatPersona } from "@shared/schema";
import type {
  MonitorMessage,
  MonitorResponse,
  PendingMessage,
  DualAgentConfig,
} from "./types";
import { studentRepository } from "../../repositories";
import type { StudentWithAacSettings } from "@shared/schema";
import type { AACInteractionMode, AACAppDefinition } from "./types";
import {
  AAC_DEFAULT_PERSONA_PROMPT,
  AAC_MEMORY_PROMPT,
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
    sessionId: string;
    initialContext?: string;
    enhancedPrompt?: string;
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

    // Store the session ID if we created one
    this.sessionId = contextResult.sessionId;

    console.log("[MonitorAgent] Session initialized:", this.sessionId);

    return {
      sessionId: contextResult.sessionId,
      initialContext: contextResult.additionalContext,
      enhancedPrompt: contextResult.enhancedPrompt,
    };
  }

  /**
   * Fast startup (mode 0): Read chatMemory fields directly from already-loaded student record.
   * No LLM call, no extra DB queries — instant startup.
   */
  private async fastInitializeContext(student: any): Promise<{
    sessionId: string;
    additionalContext?: string;
    enhancedPrompt?: string;
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
   * Thorough startup (mode 1): Use the monitor's memory system (with tool access
   * to Context_ paths) to analyze the student's data and generate an enhanced
   * custom prompt for the Interactive Agent. Falls back to fast mode on error.
   */
  private async longInitializeContext(student: any): Promise<{
    sessionId: string;
    additionalContext?: string;
    enhancedPrompt?: string;
  }> {
    try {
      const personaPrompt = student.aacSettings?.chatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;

      // Use the monitor's memory system — the LLM gets tool access to Context_ paths
      // (medical, educational, progress, classmates, etc.) and Student_ memory fields.
      const systemPromptOverride = `You are the Monitor Agent preparing for a new AAC session with ${student.name}.

${AAC_MEMORY_PROMPT}

## Your Task
Prepare the Interactive Agent for this session by creating an enhanced custom prompt that incorporates the student's data.

Step 1: Explore the student's context using the memory system. View the relevant Context_ paths:
- Context_MedicalInfo — safety alerts, medications, medical considerations
- Context_EducationalInfo — communication mode, strategies, reinforcers
- Context_Progress — current IEP/program goals and objectives
- Context_Classmates — people the student interacts with
- Context_FunctionalInfo — mobility, sensory profile, ADL status
Also review any existing Student_ memory fields (notes, interests, preferences, communication style).

Step 2: Based on what you find, generate an enhanced version of the current custom prompt shown below. The enhanced prompt should:
- Preserve the intent and tone of the original
- Weave in student-specific behavioral instructions (medical alerts, communication strategies, goals to support, interests, important people)
- Be concise and actionable — no more than 500 words
- Focus on what matters most for a live conversation
- Skip areas where there's no meaningful data
- Use plain text only — no markdown headers (#), no HTML tags, no bold/italic markup
  (the output will be inserted into a larger prompt that already has its own structure)
- Use dashes (-) for bullet points if needed

Step 3: Output ONLY the enhanced prompt between [ENHANCED_PROMPT] and [/ENHANCED_PROMPT] tags. Nothing else outside the tags.

## Current Custom Prompt
${personaPrompt}`;

      // Use "md" replyType to get raw text back (not JSON-wrapped html/text).
      const result = await onMessage({
        userId: this.userId,
        studentId: this.studentId,
        sessionId: this.sessionId,
        activeFeature: "aac",
        persona: "aac-assistant" as ChatPersona,
        messages: [{
          role: "user",
          content: "Prepare the session startup. View the student's context data and generate an enhanced prompt for the Interactive Agent.",
          timestamp: Date.now(),
        }],
        featureContext: {},
        replyType: "md",
        systemPromptOverride,
      });

      // Extract text from response — content shape depends on replyType:
      // "md" → { md: string }, "text"/"html" → { text?: string, html?: string }
      const content = result.message?.content;
      const responseText = typeof content === 'string'
        ? content
        : (content as any)?.md || (content as any)?.text || '';
      const sessionId = result.sessionId || this.sessionId || `aac-${Date.now()}`;

      // Extract enhanced prompt from response
      const promptMatch = responseText.match(/\[ENHANCED_PROMPT\]([\s\S]*?)\[\/ENHANCED_PROMPT\]/);
      const enhancedPrompt = promptMatch?.[1]?.trim();

      if (enhancedPrompt) {
        console.log("[MonitorAgent] Thorough startup generated enhanced prompt (" + enhancedPrompt.length + " chars)");
        return { sessionId, enhancedPrompt };
      }

      // Fallback: no tags found — use the raw response as additional context
      console.warn("[MonitorAgent] Thorough startup: no [ENHANCED_PROMPT] tags in response, using as context");
      return { sessionId, additionalContext: responseText || undefined };
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
    interactionMode: AACInteractionMode = 'interact',
    interactivePrompt?: string,
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
        ? buildMonitorSystemPrompt(this.student, this.framework, interactionMode, interactivePrompt)
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
