// server/services/dual-agent/monitor-agent.ts
// Monitor Agent for thorough processing, memory management, and database access

import { onMessage } from "../sessionService";
import type { ChatMessage, ParsedBoardData, ChatPersona } from "@shared/schema";
import type {
  MonitorResponse,
  PendingMessage,
  DualAgentConfig,
} from "./types";
import { studentRepository, calendarRepository, settingsRepository } from "../../repositories";
import type { StudentWithAacSettings } from "@shared/schema";
import type { AACInteractionMode, AACAppDefinition } from "./types";
import {
  AAC_DEFAULT_PERSONA_PROMPT,
  buildMonitorSystemPrompt,
} from "../memory-schema/aac-memory-schema";
import { GPT, type GPTInputItem } from "../chat/gpt";

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

    // Branch on startup mode: 0=fast (no LLM), 1=thorough (single LLM call with pre-loaded data)
    const startupMode = aac?.startupMode ?? 0;
    console.log("[MonitorAgent] Startup mode:", startupMode === 0 ? "fast" : "thorough");
    const contextResult = startupMode === 1
      ? await this.thoroughStartup(student)
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
   * Thorough startup (mode 1): Pre-load student data, events, and the current
   * AAC prompt, then make a single LLM call to generate an enhanced prompt.
   * No tool calls needed — everything is passed in the prompt directly.
   * Falls back to fast mode on error.
   */
  private async thoroughStartup(student: any): Promise<{
    sessionId: string;
    additionalContext?: string;
    enhancedPrompt?: string;
  }> {
    try {
      const sessionId = this.sessionId || `aac-${Date.now()}`;
      const memory = (student.chatMemory as Record<string, any>) || {};
      const aac = student.aacSettings;
      const personaPrompt = aac?.chatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;

      // ── Gather student data ──
      const studentDataParts: string[] = [];

      studentDataParts.push(`Name: ${student.name}`);
      if (student.birthDate) {
        const age = Math.floor((Date.now() - new Date(student.birthDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
        studentDataParts.push(`Age: ${age}`);
      }
      if (student.gender) studentDataParts.push(`Gender: ${student.gender}`);
      if (student.primaryLanguage) studentDataParts.push(`Language: ${student.primaryLanguage}`);

      if (memory.Student_Notes?.length > 0 && this.privacyOptions.allowNotes) {
        studentDataParts.push(`Notes: ${JSON.stringify(memory.Student_Notes)}`);
      }
      if (memory.Student_Interests?.length > 0) {
        studentDataParts.push(`Interests: ${JSON.stringify(memory.Student_Interests)}`);
      }
      if (memory.Student_People?.length > 0) {
        studentDataParts.push(`Important people: ${JSON.stringify(memory.Student_People)}`);
      }
      if (memory.Student_CommunicationStyle && Object.keys(memory.Student_CommunicationStyle).length > 0) {
        studentDataParts.push(`Communication style: ${JSON.stringify(memory.Student_CommunicationStyle)}`);
      }
      if (memory.Student_Preferences && Object.keys(memory.Student_Preferences).length > 0) {
        studentDataParts.push(`Preferences: ${JSON.stringify(memory.Student_Preferences)}`);
      }

      // ── Load upcoming/recent events ──
      let eventsSection = "";
      try {
        const now = new Date();
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(0, 0, 0, 0);
        const threeDaysOut = new Date(now);
        threeDaysOut.setDate(threeDaysOut.getDate() + 3);
        threeDaysOut.setHours(23, 59, 59, 999);

        const attendeeKeys = [{ type: 'student', id: this.studentId }];
        const rawEvents = await calendarRepository.getEventsForAttendees(attendeeKeys, yesterday, threeDaysOut);
        const expanded = calendarRepository.expandRecurringEvents(rawEvents, yesterday, threeDaysOut);

        if (expanded.length > 0) {
          const eventLines = expanded.slice(0, 10).map(({ event: ev, date }) => {
            const occStart = new Date(date);
            const evStart = new Date(ev.startTime);
            occStart.setHours(evStart.getHours(), evStart.getMinutes());
            return `- ${ev.title} (${occStart.toLocaleDateString()} ${occStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})${ev.description ? `: ${ev.description}` : ''}`;
          });
          eventsSection = `\n\n## Upcoming & Recent Events\n${eventLines.join('\n')}`;
        }
      } catch (err) {
        console.warn("[MonitorAgent] Failed to load calendar events for startup:", err);
      }

      // ── Build the LLM prompt ──
      const systemPrompt = `You are preparing an enhanced prompt for an AAC session with ${student.name}.
The Interactive Agent uses this prompt to guide real-time interaction with the student.
You will also check in periodically during the session to provide context-specific updates.

## Student Data
${studentDataParts.join('\n')}
${eventsSection}

## Current AAC Prompt
${personaPrompt}

## Your Task
Update the AAC prompt to reflect the student's current data and context.
- Preserve the intent and tone of the current prompt
- Weave in any relevant student data (interests, preferences, important people, communication style)
- Incorporate upcoming events if relevant (e.g. "Today the student has a music therapy session")
- Be concise — no more than 500 words
- Skip areas with no data
- Plain text only, dashes (-) for bullet points
- You may include instructions for when the Interactive Agent should consult you for more context

If the current prompt is already adequate and no updates are needed, return it unchanged.

## Output Format
Output ONLY the enhanced prompt between [ENHANCED_PROMPT] and [/ENHANCED_PROMPT] tags. Nothing else outside the tags.`;

      // ── Single LLM call — no tools ──
      const llmConfig = await settingsRepository.getLLMConfig('aac_moderator');
      const gpt = new GPT({
        provider: llmConfig?.provider || 'claude',
        model: llmConfig?.model || 'claude-haiku-4-5-20251001',
      });

      const inputItems: GPTInputItem[] = [{
        type: 'message',
        role: 'user',
        content: 'Generate the enhanced prompt for this AAC session.',
      }];

      const response = await gpt.getStructuredResponse(
        inputItems,
        'startup-prompt',
        undefined, // no schema — plain text
        [],         // no tools
        2048,
        0,          // intelligence level (cheapest model)
        { temperature: 0.5 },
        false, 1,
        systemPrompt,
      );

      const responseText = response.content || '';
      const promptMatch = responseText.match(/\[ENHANCED_PROMPT\]([\s\S]*?)\[\/ENHANCED_PROMPT\]/);
      const enhancedPrompt = promptMatch?.[1]?.trim();

      if (enhancedPrompt) {
        console.log("[MonitorAgent] Thorough startup generated enhanced prompt (" + enhancedPrompt.length + " chars)");
        return { sessionId, enhancedPrompt };
      }

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
    availableBoards?: Array<{ id: string; name: string; hint?: string; isGenerated?: boolean }>,
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
        ? buildMonitorSystemPrompt(this.student, interactionMode, interactivePrompt, availableBoards)
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
          : (responseContent as any)?.text || (responseContent as any)?.html || "";
      console.log(`[MonitorAgent] Response extracted (${responseText.length} chars), hasContext=${responseText.includes("[CONTEXT]")}, hasPrompt=${responseText.includes("[UPDATE_PROMPT]")}`);

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

      if (responseText.includes("[BOARD]")) {
        const boardMatch = responseText.match(
          /\[BOARD\]([\s\S]*?)\[\/BOARD\]/
        );
        if (boardMatch) {
          try {
            const boardData = JSON.parse(boardMatch[1].trim());
            if (boardData.name && boardData.irData) {
              response.generatedBoard = {
                name: boardData.name,
                boardId: boardData.boardId || undefined,
                irData: boardData.irData,
                hint: boardData.hint || undefined,
              };
            }
          } catch (err) {
            console.warn("[MonitorAgent] Failed to parse [BOARD] JSON:", err);
          }
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
