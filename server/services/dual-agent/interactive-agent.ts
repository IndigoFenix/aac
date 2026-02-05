// server/services/dual-agent/interactive-agent.ts
// Fast, lightweight Interactive Agent for quick AAC responses

import type {
  InteractiveMessage,
  InteractiveResponse,
  PendingMessage,
  DualAgentConfig,
} from "./types";
import { INTERACTIVE_COMMANDS } from "./types";
import type { ParsedBoardData, ChatMessage } from "@shared/schema";
import type {
  ChatProvider,
  ChatMessage as ProviderChatMessage,
  ChatTool,
  StreamChunk,
} from "../providers/streaming-provider";

/**
 * Interactive Agent
 *
 * Handles fast, real-time interactions with the user.
 * Uses 4o-mini for quick responses.
 * Can trigger special commands (starting with #) to hand off to Monitor.
 */
export class InteractiveAgent {
  private config: DualAgentConfig;
  private systemPrompt: string;
  private chatProvider: ChatProvider;

  constructor(systemPrompt: string, config: DualAgentConfig, chatProvider: ChatProvider) {
    this.systemPrompt = systemPrompt;
    this.config = config;
    this.chatProvider = chatProvider;
  }

  /**
   * Update the system prompt (called by Monitor)
   */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /**
   * Get the current system prompt
   */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  /**
   * Build the message history for the AI
   * Combines main messages with pending messages
   * Monitor's messages appear as system messages
   */
  private buildMessageHistory(
    messages: ChatMessage[],
    pendingMessages: PendingMessage[],
    currentBoard?: ParsedBoardData
  ): ProviderChatMessage[] {
    const result: ProviderChatMessage[] = [
      { role: "system", content: this.systemPrompt },
    ];

    // Add main messages (from database)
    for (const msg of messages) {
      const content = typeof msg.content === "string"
        ? msg.content
        : (msg.content as any)?.text || (msg.content as any)?.html || "";

      // Monitor's messages appear as system messages to Interactive
      // We identify them by metadata or a convention
      if (msg.role === "assistant" && (msg.metadata as any)?.isMonitorCommand) {
        result.push({
          role: "system",
          content: `[Monitor]: ${content}`,
        });
      } else if (msg.role === "user" || msg.role === "assistant") {
        result.push({
          role: msg.role,
          content,
        });
      } else if (msg.role === "system") {
        result.push({
          role: "system",
          content,
        });
      }
    }

    // Add pending messages (not yet processed by Monitor)
    for (const pending of pendingMessages) {
      result.push({
        role: pending.role,
        content: pending.content,
      });
    }

    // Add current board context if available
    if (currentBoard) {
      const boardContext = this.formatBoardContext(currentBoard);
      result.push({
        role: "system",
        content: boardContext,
      });
    }

    return result;
  }

  /**
   * Format board state as context for the AI
   */
  private formatBoardContext(board: ParsedBoardData): string {
    // Get buttons from the current page
    const currentPage = board.pages?.find(p => p.id === board.currentPageId) || board.pages?.[0];
    const buttons = currentPage?.buttons || [];
    const buttonLabels = buttons
      .filter((b: { label?: string }) => b.label)
      .map((b: { label: string }) => b.label)
      .join(", ");

    return `[Current Board State]
Grid: ${board.grid?.rows || 4}x${board.grid?.cols || 4}
Current buttons: ${buttonLabels || "none"}
Remember to update the board with relevant response options.`;
  }

  /**
   * Format board state for detection — shows 12-slot positions with blank indicators.
   */
  private formatBoardContextForDetection(board: ParsedBoardData): string {
    const currentPage = board.pages?.find(p => p.id === board.currentPageId) || board.pages?.[0];
    const buttons = currentPage?.buttons || [];

    const TOTAL_SLOTS = 12;
    const slotLines: string[] = [];
    for (let i = 0; i < TOTAL_SLOTS; i++) {
      const btn = buttons[i] as { label?: string } | undefined;
      if (btn?.label) {
        slotLines.push(`  Slot ${i + 1}: "${btn.label}"`);
      } else {
        slotLines.push(`  Slot ${i + 1}: [blank]`);
      }
    }

    const blankCount = TOTAL_SLOTS - Math.min(buttons.length, TOTAL_SLOTS);

    return `[Current Board — 12 slots (4x3 grid)]\n${slotLines.join("\n")}\nBlank slots available: ${blankCount}`;
  }

  /**
   * Process user input and generate a response
   * Supports optional image data for vision capabilities
   */
  async processMessage(
    userMessage: string,
    messages: ChatMessage[],
    pendingMessages: PendingMessage[],
    currentBoard?: ParsedBoardData,
    visualContext?: string,
    audioContext?: string,
    imageData?: string // base64 data URL or URL
  ): Promise<InteractiveResponse> {
    // Build context message if we have visual/audio context
    let contextMessage = "";
    if (visualContext) {
      contextMessage += `[Visual Context]: ${visualContext}\n`;
    }
    if (audioContext) {
      contextMessage += `[Audio Context]: ${audioContext}\n`;
    }

    // Build message history
    const messageHistory = this.buildMessageHistory(
      messages,
      pendingMessages,
      currentBoard
    );

    // Add context if any
    if (contextMessage) {
      messageHistory.push({
        role: "system",
        content: contextMessage,
      });
    }

    // Add the user's message (with image if provided)
    if (imageData) {
      messageHistory.push({
        role: "user",
        content: [
          { type: "text", text: userMessage },
          {
            type: "image_url",
            image_url: {
              url: imageData,
              detail: "low",
            },
          },
        ],
      });
      console.log("[InteractiveAgent] Including image in non-streaming message");
    } else {
      messageHistory.push({
        role: "user",
        content: userMessage,
      });
    }

    const tools = this.buildTools();

    try {
      console.log("[InteractiveAgent] processMessage: sending request, model:", this.config.interactiveModel, "messages:", messageHistory.length, "systemPrompt length:", this.systemPrompt.length);

      const result = await this.chatProvider.completeChat({
        model: this.config.interactiveModel,
        messages: messageHistory,
        tools,
        toolChoice: "required",
        maxTokens: 500,
        temperature: 0.7,
      });

      let text = result.content || "";
      let board: ParsedBoardData | undefined;

      console.log("[InteractiveAgent] processMessage: response text length:", text.length, "tool_calls:", result.toolCalls.length);

      // Check for tool calls (board updates)
      if (result.toolCalls.length > 0) {
        for (const toolCall of result.toolCalls) {
          if (toolCall.name === "update_board") {
            try {
              const args = JSON.parse(toolCall.arguments);
              if (args.responseText && !text) {
                text = args.responseText;
              }
              console.log("[InteractiveAgent] processMessage: update_board called with", args.buttons?.length || 0, "buttons, responseText:", (args.responseText || "").substring(0, 80));
              board = this.createBoardFromButtons(args.buttons, currentBoard);
            } catch (e) {
              console.error("[InteractiveAgent] Failed to parse board update:", e, "raw args:", toolCall.arguments?.substring(0, 200));
            }
          }
        }
      } else {
        console.warn("[InteractiveAgent] processMessage: NO tool calls returned — board will not update");
      }

      // Check if response is a command
      const isCommand = text.trim().startsWith("#");
      const command = isCommand ? this.parseCommand(text.trim()) : undefined;

      return {
        text: isCommand ? "" : text,
        board,
        isCommand,
        command,
        usage: result.usage,
      };
    } catch (error) {
      console.error("[InteractiveAgent] Error:", error);
      throw error;
    }
  }

  /**
   * Process a message and stream the response
   * Supports optional image data for vision capabilities
   */
  async *processMessageStream(
    userMessage: string,
    messages: ChatMessage[],
    pendingMessages: PendingMessage[],
    currentBoard?: ParsedBoardData,
    visualContext?: string,
    audioContext?: string,
    imageData?: string, // base64 data URL or URL
    personContext?: string // Identified person context from biometrics
  ): AsyncGenerator<{ type: "text" | "board" | "command" | "usage"; data: any }> {
    // Build context message if we have visual/audio/person context
    let contextMessage = "";
    if (personContext) {
      contextMessage += `${personContext}\n`;
    }
    if (visualContext) {
      contextMessage += `[Visual Context]: ${visualContext}\n`;
    }
    if (audioContext) {
      contextMessage += `[Audio Context]: ${audioContext}\n`;
    }

    // Build message history
    const messageHistory = this.buildMessageHistory(
      messages,
      pendingMessages,
      currentBoard
    );

    // Add context if any
    if (contextMessage) {
      messageHistory.push({
        role: "system",
        content: contextMessage,
      });
    }

    // Add the user's message (with image if provided)
    if (imageData) {
      // Vision-enabled message with image
      messageHistory.push({
        role: "user",
        content: [
          { type: "text", text: userMessage },
          {
            type: "image_url",
            image_url: {
              url: imageData,
              detail: "low", // Use low detail for faster processing
            },
          },
        ],
      });
      console.log("[InteractiveAgent] Including image in message");
    } else {
      // Text-only message
      messageHistory.push({
        role: "user",
        content: userMessage,
      });
    }

    const tools = this.buildTools();

    try {
      console.log("[InteractiveAgent] processMessageStream: sending request, model:", this.config.interactiveModel, "messages:", messageHistory.length, "systemPrompt length:", this.systemPrompt.length);

      const stream = this.chatProvider.streamChat({
        model: this.config.interactiveModel,
        messages: messageHistory,
        tools,
        toolChoice: "required",
        maxTokens: 500,
        temperature: 0.7,
      });

      let fullText = "";
      // Track tool calls by index
      const toolCalls: Map<number, { name: string; args: string }> = new Map();
      let streamUsage: { promptTokens: number; completionTokens: number } | undefined;

      for await (const chunk of stream) {
        if (chunk.type === "text_delta") {
          fullText += chunk.text;

          if (fullText.trim().startsWith("#")) {
            continue;
          }

          yield { type: "text", data: chunk.text };
        } else if (chunk.type === "tool_call_delta") {
          const idx = chunk.index;
          if (!toolCalls.has(idx)) {
            toolCalls.set(idx, { name: "", args: "" });
          }
          const entry = toolCalls.get(idx)!;
          if (chunk.name) {
            entry.name = chunk.name;
          }
          if (chunk.arguments) {
            entry.args += chunk.arguments;
          }
        } else if (chunk.type === "done" && chunk.usage) {
          streamUsage = chunk.usage;
        }
      }

      console.log("[InteractiveAgent] processMessageStream: text length:", fullText.length, "tool calls:", toolCalls.size);

      // Check for command in full text
      if (fullText.trim().startsWith("#")) {
        const command = this.parseCommand(fullText.trim());
        yield { type: "command", data: command };
        return;
      }

      // Process all tool calls
      let boardYielded = false;
      for (const [idx, tc] of toolCalls) {
        if (tc.name === "update_board" && tc.args) {
          try {
            const args = JSON.parse(tc.args);
            console.log("[InteractiveAgent] processMessageStream: update_board[" + idx + "] with", args.buttons?.length || 0, "buttons, iconRefs:", args.buttons?.map((b: any) => b.iconRef).join(", "));
            const board = this.createBoardFromButtons(args.buttons, currentBoard);
            yield { type: "board", data: board };
            boardYielded = true;
            // Yield responseText extracted from the tool call
            if (args.responseText) {
              console.log("[InteractiveAgent] processMessageStream: responseText:", args.responseText.substring(0, 80));
              yield { type: "text", data: args.responseText };
            }
          } catch (e) {
            console.error("[InteractiveAgent] Failed to parse board update[" + idx + "]:", e, "raw args:", tc.args.substring(0, 200));
          }
        }
      }

      if (!boardYielded) {
        console.warn("[InteractiveAgent] processMessageStream: NO board yielded. Tool calls:", Array.from(toolCalls.entries()).map(([i, t]) => `${i}:${t.name}`).join(", ") || "none");
      }

      // Yield usage data for credit tracking
      if (streamUsage) {
        yield { type: "usage", data: streamUsage };
      }
    } catch (error) {
      console.error("[InteractiveAgent] Stream error:", error);
      throw error;
    }
  }

  /**
   * Process a detection frame (camera snapshot + optional audio) and return board diff.
   * Uses the modify_board tool for incremental add/remove instead of full replacement.
   */
  async processDetection(
    messages: ChatMessage[],
    currentBoard?: ParsedBoardData,
    imageData?: string,
    audioContext?: string,
    detectionSystemPrompt?: string,
    gestureContext?: string,
    audioBuffer?: Buffer
  ): Promise<InteractiveResponse> {
    const messageHistory: ProviderChatMessage[] = [
      { role: "system", content: detectionSystemPrompt || this.systemPrompt },
    ];

    // Add current board with 12-slot layout so the AI knows what's already shown
    if (currentBoard) {
      const boardContext = this.formatBoardContextForDetection(currentBoard);
      messageHistory.push({ role: "system", content: boardContext });
      console.log("[InteractiveAgent] Board context for detection:", boardContext);
    }

    // Add audio context (Whisper transcript) as text fallback — only used when
    // raw audioBuffer is not available (e.g. non-Gemini providers)
    if (audioContext && !audioBuffer) {
      messageHistory.push({
        role: "system",
        content: `[Audio Context — ambient sounds/speech heard nearby]: ${audioContext}`,
      });
    }

    // Add gesture context (face expressions + hand gestures) if available
    if (gestureContext) {
      messageHistory.push({
        role: "system",
        content: gestureContext,
      });
    }

    // Build the user message with optional image + raw audio
    // Raw audio goes as input_audio — Gemini converts to inlineData natively.
    // OpenAI/Claude providers strip input_audio blocks they can't handle.
    const userText = "Observe the environment and use modify_board to add or remove buttons if the context has meaningfully changed. If nothing significant changed, call modify_board with empty add_labels, add_icons, and remove arrays.";

    const contentParts: any[] = [{ type: "text", text: userText }];
    if (imageData) {
      contentParts.push({ type: "image_url", image_url: { url: imageData, detail: "low" } });
    }
    if (audioBuffer) {
      contentParts.push({
        type: "input_audio",
        input_audio: { data: audioBuffer.toString("base64"), format: "webm" },
      });
    }

    if (contentParts.length > 1) {
      messageHistory.push({ role: "user", content: contentParts });
    } else {
      messageHistory.push({ role: "user", content: userText });
    }

    const tools = this.buildDetectionTools();

    try {
      const hasImage = messageHistory.some(m => Array.isArray(m.content) && (m.content as any[]).some((p: any) => p.type === "image_url"));
      const hasRawAudio = messageHistory.some(m => Array.isArray(m.content) && (m.content as any[]).some((p: any) => p.type === "input_audio"));
      console.log("[InteractiveAgent] processDetection: model:", this.config.interactiveModel, "provider:", this.config.interactiveProvider || "unknown", "image:", hasImage, "rawAudio:", hasRawAudio, "textAudioCtx:", !audioBuffer && !!audioContext, "messages:", messageHistory.length);

      const result = await this.chatProvider.completeChat({
        model: this.config.interactiveModel,
        messages: messageHistory,
        tools,
        toolChoice: "required",
        maxTokens: 1024,
        temperature: 0.3,
      });

      console.log("[InteractiveAgent] processDetection result: content:", (result.content || "").length, "chars, toolCalls:", result.toolCalls.length, "usage:", JSON.stringify(result.usage));

      let text = result.content || "";
      let addButtons: Array<{ label: string; iconRef: string }> | undefined;
      let removeLabels: string[] | undefined;

      if (result.toolCalls.length > 0) {
        for (const toolCall of result.toolCalls) {
          if (toolCall.name === "modify_board") {
            try {
              const args = JSON.parse(toolCall.arguments);
              // Parallel arrays: add_labels + add_icons → addButtons
              const labels = Array.isArray(args.add_labels) ? args.add_labels : [];
              const icons = Array.isArray(args.add_icons) ? args.add_icons : [];
              addButtons = labels.map((label: string, i: number) => ({
                label,
                iconRef: icons[i] || "fas fa-comment",
              }));
              removeLabels = Array.isArray(args.remove) ? args.remove : [];
              // Use reasoning as fallback text only if model didn't provide a text response
              if (args.reasoning && !text) {
                text = args.reasoning;
              }
              console.log("[InteractiveAgent] processDetection: modify_board add:", addButtons?.length || 0, "remove:", removeLabels?.length || 0, "reasoning:", (args.reasoning || "").substring(0, 80));
            } catch (e) {
              console.error("[InteractiveAgent] Detection: failed to parse modify_board:", e);
            }
          }
        }
      }

      return { text, isCommand: false, usage: result.usage, addButtons, removeLabels };
    } catch (error) {
      console.error("[InteractiveAgent] Detection error:", error);
      throw error;
    }
  }

  /**
   * Build the detection-specific tool — modify_board for incremental add/remove.
   */
  private buildDetectionTools(): ChatTool[] {
    // Flat schema (no nested objects) — Gemini produces MALFORMED_FUNCTION_CALL
    // with nested object items inside arrays. Use parallel string arrays instead.
    return [
      {
        type: "function",
        function: {
          name: "modify_board",
          description:
            "Add or remove buttons on the 12-slot communication board based on environmental changes. add_labels and add_icons must have the same length (one icon per label).",
          parameters: {
            type: "object",
            properties: {
              add_labels: {
                type: "array",
                items: { type: "string" },
                description: "Labels for new buttons to add to blank slots (e.g. [\"Hungry\", \"Play outside\"]). Empty array if no buttons to add.",
              },
              add_icons: {
                type: "array",
                items: { type: "string" },
                description: "Icon for each new button, matching add_labels by index. Use a single emoji (e.g. \"🍕\") or FontAwesome class (e.g. \"fas fa-home\"). Must be same length as add_labels.",
              },
              remove: {
                type: "array",
                items: { type: "string" },
                description: "Labels of existing buttons to remove from the board. Empty array if none to remove.",
              },
              reasoning: {
                type: "string",
                description: "Brief explanation of why you are making these changes (or why no changes are needed)",
              },
            },
            required: ["add_labels", "add_icons", "remove", "reasoning"],
          },
        },
      },
    ];
  }

  /**
   * Build the OpenAI tools definition for the update_board function.
   * responseText is included so the model can return both text and board in a single tool call
   * (required when tool_choice is "required").
   */
  private buildTools(): ChatTool[] {
    return [
      {
        type: "function",
        function: {
          name: "update_board",
          description:
            "Respond to the user AND update the communication board. Always include responseText with your spoken reply and buttons with the new board options.",
          parameters: {
            type: "object",
            properties: {
              responseText: {
                type: "string",
                description: "Your spoken/text response to the user. Keep it concise (1-2 sentences). This will be displayed and read aloud.",
              },
              buttons: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: {
                      type: "string",
                      description: "The text label for the button",
                    },
                    action: {
                      type: "string",
                      description: "The action type (speak, navigate, etc.)",
                    },
                    iconRef: {
                      type: "string",
                      description: "Icon for the button: either a FontAwesome class (e.g., 'fas fa-home') or a single emoji (e.g., '🏠'). Required.",
                    },
                  },
                  required: ["label", "iconRef"],
                },
                description: "Array of buttons to display on the board",
              },
            },
            required: ["responseText", "buttons"],
          },
        },
      },
    ];
  }

  /**
   * Parse a command from the response text
   */
  private parseCommand(text: string): string {
    // Extract the command (first word starting with #)
    const match = text.match(/^(#\w+)/);
    return match ? match[1] : text;
  }

  /**
   * Create a board from button definitions
   * ParsedBoardData requires pages[] with buttons inside, not buttons at root
   */
  private createBoardFromButtons(
    buttons: Array<{ label: string; action?: string; iconRef?: string }>,
    currentBoard?: ParsedBoardData
  ): ParsedBoardData {
    const grid = currentBoard?.grid || { rows: 4, cols: 4 };
    const totalCells = grid.rows * grid.cols;

    // Map buttons to proper board format (with row/col, not position object)
    const boardButtons: Array<{
      id: string;
      label: string;
      spokenText: string;
      row: number;
      col: number;
      iconRef?: string;
      action: { type: "speak" | "link" | "back" | "home"; text?: string };
    }> = buttons.slice(0, totalCells).map((btn, index) => ({
      id: `btn-${Date.now()}-${index}`,
      label: btn.label,
      spokenText: btn.label,
      row: Math.floor(index / grid.cols),
      col: index % grid.cols,
      iconRef: btn.iconRef || undefined,
      action: {
        type: "speak" as const,
        text: btn.label,
      },
    }));

    // Create a single page with the buttons
    const pageId = currentBoard?.currentPageId || `page-${Date.now()}`;

    return {
      name: currentBoard?.name || "Communication Board",
      grid,
      pages: [{
        id: pageId,
        name: "Main",
        buttons: boardButtons,
      }],
      currentPageId: pageId,
    };
  }
}

/**
 * Create a new Interactive Agent with the given prompt
 */
export function createInteractiveAgent(
  systemPrompt: string,
  config: DualAgentConfig,
  chatProvider: ChatProvider
): InteractiveAgent {
  return new InteractiveAgent(systemPrompt, config, chatProvider);
}
