// server/services/dual-agent/interactive-agent.ts
// Fast, lightweight Interactive Agent for quick AAC responses

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type {
  InteractiveMessage,
  InteractiveResponse,
  PendingMessage,
  DualAgentConfig,
} from "./types";
import { INTERACTIVE_COMMANDS } from "./types";
import type { ParsedBoardData, ChatMessage } from "@shared/schema";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

  constructor(systemPrompt: string, config: DualAgentConfig) {
    this.systemPrompt = systemPrompt;
    this.config = config;
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
  ): ChatCompletionMessageParam[] {
    const result: ChatCompletionMessageParam[] = [
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

      const response = await openai.chat.completions.create({
        model: this.config.interactiveModel,
        messages: messageHistory,
        tools,
        tool_choice: "required",
        max_tokens: 500,
        temperature: 0.7,
      });

      const message = response.choices[0]?.message;
      if (!message) {
        throw new Error("No response from Interactive agent");
      }

      let text = message.content || "";
      let board: ParsedBoardData | undefined;

      console.log("[InteractiveAgent] processMessage: response text length:", text.length, "tool_calls:", message.tool_calls?.length || 0);

      // Check for tool calls (board updates)
      if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          const fn = (toolCall as any).function;
          if (fn?.name === "update_board") {
            try {
              const args = JSON.parse(fn.arguments);
              // Extract responseText from tool args
              if (args.responseText && !text) {
                text = args.responseText;
              }
              console.log("[InteractiveAgent] processMessage: update_board called with", args.buttons?.length || 0, "buttons, responseText:", (args.responseText || "").substring(0, 80));
              board = this.createBoardFromButtons(args.buttons, currentBoard);
            } catch (e) {
              console.error("[InteractiveAgent] Failed to parse board update:", e, "raw args:", fn?.arguments?.substring(0, 200));
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
  ): AsyncGenerator<{ type: "text" | "board" | "command"; data: any }> {
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

      const stream = await openai.chat.completions.create({
        model: this.config.interactiveModel,
        messages: messageHistory,
        tools,
        tool_choice: "required",
        max_tokens: 500,
        temperature: 0.7,
        stream: true,
      });

      let fullText = "";
      // Track tool calls by index (OpenAI streams them with index-based deltas)
      const toolCalls: Map<number, { name: string; args: string }> = new Map();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;

        // Handle text content (unlikely with tool_choice=required, but handle gracefully)
        if (delta?.content) {
          fullText += delta.content;

          if (fullText.trim().startsWith("#")) {
            continue;
          }

          yield { type: "text", data: delta.content };
        }

        // Handle tool calls (tracked by index)
        if (delta?.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            const idx = toolCall.index ?? 0;
            if (!toolCalls.has(idx)) {
              toolCalls.set(idx, { name: "", args: "" });
            }
            const entry = toolCalls.get(idx)!;
            if (toolCall.function?.name) {
              entry.name = toolCall.function.name;
            }
            if (toolCall.function?.arguments) {
              entry.args += toolCall.function.arguments;
            }
          }
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
    } catch (error) {
      console.error("[InteractiveAgent] Stream error:", error);
      throw error;
    }
  }

  /**
   * Process a detection frame (camera snapshot) and optionally update the board.
   * Uses low detail, low temperature, and limited tokens for efficiency.
   */
  async processDetection(
    messages: ChatMessage[],
    currentBoard?: ParsedBoardData,
    imageData?: string,
    audioContext?: string,
    detectionSystemPrompt?: string
  ): Promise<InteractiveResponse> {
    const messageHistory: ChatCompletionMessageParam[] = [
      { role: "system", content: detectionSystemPrompt || this.systemPrompt },
    ];

    // Add current board labels so the AI knows what's already shown
    if (currentBoard) {
      const boardContext = this.formatBoardContext(currentBoard);
      messageHistory.push({ role: "system", content: boardContext });
    }

    // Add audio context if available
    if (audioContext) {
      messageHistory.push({
        role: "system",
        content: `[Audio Context]: ${audioContext}`,
      });
    }

    // Build the user message with optional image
    const userText = "Observe the environment and update the board if the context has meaningfully changed. If nothing significant changed, return the same buttons.";

    if (imageData) {
      messageHistory.push({
        role: "user",
        content: [
          { type: "text", text: userText },
          {
            type: "image_url",
            image_url: {
              url: imageData,
              detail: "low",
            },
          },
        ],
      });
    } else {
      messageHistory.push({ role: "user", content: userText });
    }

    const tools = this.buildTools();

    try {
      console.log("[InteractiveAgent] processDetection: sending request, model:", this.config.interactiveModel);

      const response = await openai.chat.completions.create({
        model: this.config.interactiveModel,
        messages: messageHistory,
        tools,
        tool_choice: "required",
        max_tokens: 300,
        temperature: 0.3,
      });

      const message = response.choices[0]?.message;
      if (!message) {
        throw new Error("No response from detection");
      }

      let text = message.content || "";
      let board: ParsedBoardData | undefined;

      if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          const fn = (toolCall as any).function;
          if (fn?.name === "update_board") {
            try {
              const args = JSON.parse(fn.arguments);
              if (args.responseText && !text) {
                text = args.responseText;
              }
              console.log("[InteractiveAgent] processDetection: update_board with", args.buttons?.length || 0, "buttons");
              board = this.createBoardFromButtons(args.buttons, currentBoard);
            } catch (e) {
              console.error("[InteractiveAgent] Detection: failed to parse board:", e);
            }
          }
        }
      }

      return { text, board, isCommand: false };
    } catch (error) {
      console.error("[InteractiveAgent] Detection error:", error);
      throw error;
    }
  }

  /**
   * Build the OpenAI tools definition for the update_board function.
   * responseText is included so the model can return both text and board in a single tool call
   * (required when tool_choice is "required").
   */
  private buildTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
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
  config: DualAgentConfig
): InteractiveAgent {
  return new InteractiveAgent(systemPrompt, config);
}
