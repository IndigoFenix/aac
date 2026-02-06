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
import { logDualAgent } from "./dual-agent-logger";

// =============================================================================
// STREAMING PREFIX TOKEN TYPES
// =============================================================================

/**
 * Parsed streaming output from prefix tokens in text.
 * The AI outputs text with these prefixes, which we parse into structured data.
 */
export interface ParsedStreamOutput {
  transcript?: string;
  transcriptSpeaker?: string;
  contextUpdate?: string;
  speak?: string;
  interpret?: string;
  /** Buttons to add incrementally: "label|icon, label|icon, ..." */
  addButtons?: Array<{ label: string; iconRef: string }>;
  /** Button labels to remove */
  removeButtons?: string[];
  /** Complete board rebuild: "label|icon, label|icon, ..." (replaces entire board) */
  rebuildBoard?: Array<{ label: string; iconRef: string }>;
}

/**
 * Parse prefix tokens from streamed text.
 * Format:
 *   [TRANSCRIPT speaker] text...
 *   [CONTEXT] observations...
 *   [SPEAK] ai voice message...
 *   [INTERPRET] student message...
 *   [ADD_BUTTONS] label|icon, label|icon, ...
 *   [REMOVE_BUTTONS] label, label, ...
 *   [REBUILD_BOARD] label|icon, label|icon, ...
 *
 * Returns the parsed sections and any unparsed remainder.
 */
function parseStreamedText(text: string): ParsedStreamOutput {
  const result: ParsedStreamOutput = {};

  // Match [TRANSCRIPT speaker] content (speaker can have spaces)
  const transcriptMatch = text.match(/\[TRANSCRIPT\s+([^\]]+)\]\s*([^\[]*)/i);
  if (transcriptMatch) {
    result.transcriptSpeaker = transcriptMatch[1].trim();
    result.transcript = transcriptMatch[2].trim();
  }

  // Match [CONTEXT] content
  const contextMatch = text.match(/\[CONTEXT\]\s*([^\[]*)/i);
  if (contextMatch) {
    result.contextUpdate = contextMatch[1].trim();
  }

  // Match [SPEAK] content
  const speakMatch = text.match(/\[SPEAK\]\s*([^\[]*)/i);
  if (speakMatch) {
    result.speak = speakMatch[1].trim();
  }

  // Match [INTERPRET] content
  const interpretMatch = text.match(/\[INTERPRET\]\s*([^\[]*)/i);
  if (interpretMatch) {
    result.interpret = interpretMatch[1].trim();
  }

  // Match [ADD_BUTTONS] label|icon, label|icon, ...
  const addMatch = text.match(/\[ADD_BUTTONS\]\s*([^\[]*)/i);
  if (addMatch) {
    const content = addMatch[1].trim();
    if (content) {
      result.addButtons = parseBoardButtons(content);
    }
  }

  // Match [REMOVE_BUTTONS] label, label, ...
  const removeMatch = text.match(/\[REMOVE_BUTTONS\]\s*([^\[]*)/i);
  if (removeMatch) {
    const content = removeMatch[1].trim();
    if (content) {
      result.removeButtons = content.split(',').map(s => s.trim()).filter(s => s);
    }
  }

  // Match [REBUILD_BOARD] label|icon, label|icon, ... (replaces entire board)
  const rebuildMatch = text.match(/\[REBUILD_BOARD\]\s*([^\[]*)/i);
  if (rebuildMatch) {
    const content = rebuildMatch[1].trim();
    if (content) {
      result.rebuildBoard = parseBoardButtons(content);
    }
  }

  return result;
}

/**
 * Parse board button format: "label|icon, label|icon, ..."
 * If no icon is provided, defaults to comment icon.
 */
function parseBoardButtons(content: string): Array<{ label: string; iconRef: string }> {
  const buttons: Array<{ label: string; iconRef: string }> = [];
  const items = content.split(',');

  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;

    // Check for label|icon format
    const pipeIndex = trimmed.indexOf('|');
    if (pipeIndex > 0) {
      const label = trimmed.substring(0, pipeIndex).trim();
      const iconRef = trimmed.substring(pipeIndex + 1).trim();
      if (label) {
        buttons.push({ label, iconRef: iconRef || "fas fa-comment" });
      }
    } else {
      // Just a label, use default icon
      buttons.push({ label: trimmed, iconRef: "fas fa-comment" });
    }
  }

  return buttons;
}

/** Types that the streaming parser can emit */
export type StreamingSegmentType = "speak" | "interpret" | "transcript" | "context" | "add_buttons" | "remove_buttons" | "rebuild_board";

export interface StreamingSegment {
  type: StreamingSegmentType;
  data: string;
  speaker?: string;
}

/**
 * Streaming state machine for parsing prefix tokens incrementally.
 * Detects when a complete prefix token + content is available and emits it.
 */
export class StreamingPrefixParser {
  private buffer = "";
  private currentMode: "none" | "transcript" | "context" | "speak" | "interpret" | "add_buttons" | "remove_buttons" | "rebuild_board" = "none";
  private transcriptSpeaker = "";

  /**
   * Add a chunk of text and return any complete segments to emit.
   * Returns array of { type, data } to yield.
   */
  addChunk(chunk: string): StreamingSegment[] {
    this.buffer += chunk;
    const results: StreamingSegment[] = [];

    // Process buffer looking for prefix tokens
    while (true) {
      if (this.currentMode === "none") {
        // Look for a prefix token
        const transcriptMatch = this.buffer.match(/^\s*\[TRANSCRIPT\s+([^\]]+)\]\s*/i);
        const contextMatch = this.buffer.match(/^\s*\[CONTEXT\]\s*/i);
        const speakMatch = this.buffer.match(/^\s*\[SPEAK\]\s*/i);
        const interpretMatch = this.buffer.match(/^\s*\[INTERPRET\]\s*/i);
        const addButtonsMatch = this.buffer.match(/^\s*\[ADD_BUTTONS\]\s*/i);
        const removeButtonsMatch = this.buffer.match(/^\s*\[REMOVE_BUTTONS\]\s*/i);
        const rebuildBoardMatch = this.buffer.match(/^\s*\[REBUILD_BOARD\]\s*/i);

        if (transcriptMatch) {
          this.currentMode = "transcript";
          this.transcriptSpeaker = transcriptMatch[1].trim();
          this.buffer = this.buffer.slice(transcriptMatch[0].length);
        } else if (contextMatch) {
          this.currentMode = "context";
          this.buffer = this.buffer.slice(contextMatch[0].length);
        } else if (speakMatch) {
          this.currentMode = "speak";
          this.buffer = this.buffer.slice(speakMatch[0].length);
        } else if (interpretMatch) {
          this.currentMode = "interpret";
          this.buffer = this.buffer.slice(interpretMatch[0].length);
        } else if (addButtonsMatch) {
          this.currentMode = "add_buttons";
          this.buffer = this.buffer.slice(addButtonsMatch[0].length);
        } else if (removeButtonsMatch) {
          this.currentMode = "remove_buttons";
          this.buffer = this.buffer.slice(removeButtonsMatch[0].length);
        } else if (rebuildBoardMatch) {
          this.currentMode = "rebuild_board";
          this.buffer = this.buffer.slice(rebuildBoardMatch[0].length);
        } else {
          // No prefix found yet, wait for more data
          // But trim leading whitespace/newlines that aren't part of a token
          this.buffer = this.buffer.replace(/^[\s\n]+/, "");
          break;
        }
      } else {
        // We're in a mode, collect content until the next prefix or end
        const nextPrefixMatch = this.buffer.match(/\[(?:TRANSCRIPT|CONTEXT|SPEAK|INTERPRET|ADD_BUTTONS|REMOVE_BUTTONS|REBUILD_BOARD)[\s\]]/i);

        if (nextPrefixMatch && nextPrefixMatch.index !== undefined && nextPrefixMatch.index > 0) {
          // Found next prefix, emit current content
          const content = this.buffer.slice(0, nextPrefixMatch.index).trim();
          if (content) {
            if (this.currentMode === "transcript") {
              results.push({ type: "transcript", data: content, speaker: this.transcriptSpeaker });
            } else {
              results.push({ type: this.currentMode, data: content });
            }
          }
          this.buffer = this.buffer.slice(nextPrefixMatch.index);
          this.currentMode = "none";
        } else if (nextPrefixMatch && nextPrefixMatch.index === 0) {
          // Prefix at start with no content, just switch modes
          this.currentMode = "none";
        } else {
          // No next prefix found, keep buffering
          break;
        }
      }
    }

    return results;
  }

  /**
   * Flush any remaining content in the buffer.
   */
  flush(): StreamingSegment[] {
    const results: StreamingSegment[] = [];

    if (this.currentMode !== "none" && this.buffer.trim()) {
      if (this.currentMode === "transcript") {
        results.push({ type: "transcript", data: this.buffer.trim(), speaker: this.transcriptSpeaker });
      } else {
        results.push({ type: this.currentMode, data: this.buffer.trim() });
      }
    }

    this.buffer = "";
    this.currentMode = "none";
    return results;
  }
}

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
    const currentPage = board.pages?.find(p => p.id === board.currentPageId) || board.pages?.[0];
    const buttons = currentPage?.buttons || [];
    const TOTAL_SLOTS = 12;
    const occupiedCount = Math.min(buttons.length, TOTAL_SLOTS);
    const blankCount = TOTAL_SLOTS - occupiedCount;
    const buttonLabels = buttons
      .slice(0, TOTAL_SLOTS)
      .filter((b: { label?: string }) => b.label)
      .map((b: { label: string }) => b.label)
      .join(", ");

    return `[Current Board — 12 slots (4x3 grid)]
Occupied: ${buttonLabels || "none"} (${occupiedCount} of ${TOTAL_SLOTS})
Blank slots: ${blankCount}
Use [REBUILD_BOARD] to replace the entire board or [ADD_BUTTONS]/[REMOVE_BUTTONS] for incremental changes.`;
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

    try {
      console.log("[InteractiveAgent] processMessage: sending request, model:", this.config.interactiveModel, "messages:", messageHistory.length, "systemPrompt length:", this.systemPrompt.length);

      // No tools - everything is text-based with prefix tokens
      const result = await this.chatProvider.completeChat({
        model: this.config.interactiveModel,
        messages: messageHistory,
        maxTokens: 500,
        temperature: 0.7,
      });

      const rawText = result.content || "";
      let board: ParsedBoardData | undefined;

      console.log("[InteractiveAgent] processMessage: response text length:", rawText.length);

      // Parse prefix tokens from text content
      const parsed = parseStreamedText(rawText);
      const text = parsed.speak || "";
      const interpretation = parsed.interpret;
      const transcript = parsed.transcript;
      const transcriptSpeaker = parsed.transcriptSpeaker;
      const contextUpdate = parsed.contextUpdate;

      // Extract board changes from parsed tokens
      let addButtons = parsed.addButtons;
      let removeLabels = parsed.removeButtons;
      let rebuildBoard = parsed.rebuildBoard;

      console.log("[InteractiveAgent] processMessage parsed: speak:", text.length, "addButtons:", addButtons?.length || 0, "removeButtons:", removeLabels?.length || 0, "rebuildBoard:", rebuildBoard?.length || 0);

      // Build board from parsed tokens
      if (rebuildBoard && rebuildBoard.length > 0) {
        // Full board rebuild
        board = this.createBoardFromButtons(rebuildBoard, currentBoard);
      } else if (currentBoard && (addButtons?.length || removeLabels?.length)) {
        // Incremental board update
        board = this.applyBoardDiff(currentBoard, addButtons, removeLabels);
      } else if (addButtons?.length) {
        // Create new board from buttons
        board = this.createBoardFromButtons(addButtons, undefined);
      }

      // Check if response is a command
      const isCommand = rawText.trim().startsWith("#");
      const command = isCommand ? this.parseCommand(rawText.trim()) : undefined;

      return {
        text: isCommand ? "" : text,
        board,
        isCommand,
        command,
        usage: result.usage,
        interpretation,
        addButtons,
        removeLabels,
        rebuildBoard,
        transcript,
        transcriptSpeaker,
        contextUpdate,
      };
    } catch (error) {
      console.error("[InteractiveAgent] Error:", error);
      throw error;
    }
  }

  /**
   * Apply board diff (add/remove) to current board state
   */
  private applyBoardDiff(
    currentBoard: ParsedBoardData,
    addButtons?: Array<{ label: string; iconRef: string }>,
    removeLabels?: string[]
  ): ParsedBoardData {
    const grid = currentBoard.grid || { rows: 4, cols: 4 };
    const totalCells = grid.rows * grid.cols;
    const currentPage = currentBoard.pages?.find(p => p.id === currentBoard.currentPageId) || currentBoard.pages?.[0];
    let buttons = [...(currentPage?.buttons || [])];

    // Remove buttons by label
    if (removeLabels && removeLabels.length > 0) {
      const removeSet = new Set(removeLabels.map(l => l.toLowerCase()));
      buttons = buttons.filter(b => !removeSet.has((b.label || "").toLowerCase()));
    }

    // Add new buttons to available slots
    if (addButtons && addButtons.length > 0) {
      for (const newBtn of addButtons) {
        if (buttons.length >= totalCells) break; // No room
        const index = buttons.length;
        buttons.push({
          id: `btn-${Date.now()}-${index}`,
          label: newBtn.label,
          spokenText: newBtn.label,
          row: Math.floor(index / grid.cols),
          col: index % grid.cols,
          iconRef: newBtn.iconRef || undefined,
          action: { type: "speak" as const, text: newBtn.label },
        });
      }
    }

    const pageId = currentBoard.currentPageId || `page-${Date.now()}`;
    return {
      name: currentBoard.name || "Communication Board",
      grid,
      pages: [{
        id: pageId,
        name: "Main",
        buttons,
      }],
      currentPageId: pageId,
    };
  }

  /**
   * Process a message and stream the response
   * Supports optional image data for vision capabilities
   *
   * Text-only response format (no tools):
   *   [TRANSCRIPT speaker] text...
   *   [CONTEXT] observations...
   *   [SPEAK] ai voice message...
   *   [INTERPRET] student message...
   *   [ADD_BUTTONS] label|icon, label|icon, ...
   *   [REMOVE_BUTTONS] label, label, ...
   *   [REBUILD_BOARD] label|icon, label|icon, ... (replaces entire board)
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
  ): AsyncGenerator<{ type: "speak" | "interpret" | "transcript" | "context" | "board" | "board_patch" | "command" | "usage"; data: any; speaker?: string }> {
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

    try {
      const streamStart = Date.now();
      console.log("[InteractiveAgent] processMessageStream: sending request, model:", this.config.interactiveModel, "messages:", messageHistory.length, "systemPrompt length:", this.systemPrompt.length);

      // Log full prompt to debug file (no truncation)
      logDualAgent("InteractiveAgent.processMessageStream.PROMPT", {
        model: this.config.interactiveModel,
        messageCount: messageHistory.length,
        messages: messageHistory.map(m => ({
          role: m.role,
          content: typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((p: any) => p.type === "image_url" ? { type: "image_url", detail: p.image_url?.detail, hasUrl: !!p.image_url?.url } : p)
              : m.content,
        })),
      });

      // No tools - everything is text-based with prefix tokens
      const stream = this.chatProvider.streamChat({
        model: this.config.interactiveModel,
        messages: messageHistory,
        maxTokens: 500,
        temperature: 0.7,
      });

      let fullText = "";
      const prefixParser = new StreamingPrefixParser();
      let streamUsage: { promptTokens: number; completionTokens: number } | undefined;

      // Collect board changes to yield at the end (after all text is parsed)
      let addButtons: Array<{ label: string; iconRef: string }> = [];
      let removeButtons: string[] = [];
      let rebuildBoard: Array<{ label: string; iconRef: string }> | null = null;

      for await (const chunk of stream) {
        if (chunk.type === "text_delta") {
          fullText += chunk.text;

          // Check for command prefix early
          if (fullText.trim().startsWith("#")) {
            continue;
          }

          // Parse prefix tokens and yield immediately for TTS
          const segments = prefixParser.addChunk(chunk.text);
          for (const seg of segments) {
            if (seg.type === "speak") {
              yield { type: "speak", data: seg.data };
            } else if (seg.type === "interpret") {
              yield { type: "interpret", data: seg.data };
            } else if (seg.type === "transcript") {
              yield { type: "transcript", data: seg.data, speaker: seg.speaker };
            } else if (seg.type === "context") {
              yield { type: "context", data: seg.data };
            } else if (seg.type === "add_buttons") {
              // Parse and accumulate buttons to add
              const buttons = parseBoardButtons(seg.data);
              addButtons.push(...buttons);
            } else if (seg.type === "remove_buttons") {
              // Parse and accumulate labels to remove
              const labels = seg.data.split(',').map((s: string) => s.trim()).filter((s: string) => s);
              removeButtons.push(...labels);
            } else if (seg.type === "rebuild_board") {
              // Full board rebuild - this overrides add/remove
              rebuildBoard = parseBoardButtons(seg.data);
            }
          }
        } else if (chunk.type === "done" && chunk.usage) {
          streamUsage = chunk.usage;
        }
      }

      // Flush any remaining buffered content
      const remaining = prefixParser.flush();
      for (const seg of remaining) {
        if (seg.type === "speak") {
          yield { type: "speak", data: seg.data };
        } else if (seg.type === "interpret") {
          yield { type: "interpret", data: seg.data };
        } else if (seg.type === "transcript") {
          yield { type: "transcript", data: seg.data, speaker: seg.speaker };
        } else if (seg.type === "context") {
          yield { type: "context", data: seg.data };
        } else if (seg.type === "add_buttons") {
          const buttons = parseBoardButtons(seg.data);
          addButtons.push(...buttons);
        } else if (seg.type === "remove_buttons") {
          const labels = seg.data.split(',').map((s: string) => s.trim()).filter((s: string) => s);
          removeButtons.push(...labels);
        } else if (seg.type === "rebuild_board") {
          rebuildBoard = parseBoardButtons(seg.data);
        }
      }

      const streamElapsed = Date.now() - streamStart;
      console.log("[InteractiveAgent] processMessageStream: text length:", fullText.length, "addButtons:", addButtons.length, "removeButtons:", removeButtons.length, "rebuildBoard:", rebuildBoard?.length ?? "null", "elapsed:", streamElapsed, "ms");

      // Log full response to debug file (no truncation)
      logDualAgent("InteractiveAgent.processMessageStream.RESPONSE", {
        elapsedMs: streamElapsed,
        fullText,
        addButtons,
        removeButtons,
        rebuildBoard,
        usage: streamUsage,
      });

      // Check for command in full text
      if (fullText.trim().startsWith("#")) {
        const command = this.parseCommand(fullText.trim());
        yield { type: "command", data: command };
        return;
      }

      // Yield board changes
      if (rebuildBoard && rebuildBoard.length > 0) {
        // Full board rebuild - create new board from buttons
        console.log("[InteractiveAgent] processMessageStream: yielding full board rebuild with", rebuildBoard.length, "buttons");
        const board = this.createBoardFromButtons(rebuildBoard, currentBoard);
        yield { type: "board", data: board };
      } else if (addButtons.length > 0 || removeButtons.length > 0) {
        // Incremental board patch
        console.log("[InteractiveAgent] processMessageStream: yielding board_patch, add:", addButtons.length, "remove:", removeButtons.length);
        yield { type: "board_patch", data: { add: addButtons, remove: removeButtons } };
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
   * Uses text-based prefix tokens for all output:
   *   [TRANSCRIPT], [CONTEXT], [SPEAK], [INTERPRET]
   *   [ADD_BUTTONS], [REMOVE_BUTTONS], [REBUILD_BOARD]
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
    const userText = `Observe the environment and respond using prefix tokens.

== Response Format (all text-based, output in this order) ==

1. [TRANSCRIPT speaker] text — if you hear voice (omit if none)
2. [CONTEXT] observations — if there are context changes (omit if none)
3. [SPEAK] message — OR — [INTERPRET] message — only ONE, only if HIGH CONFIDENCE (omit if unsure)
4. Board changes (choose ONE or omit if no changes):
   - [ADD_BUTTONS] label|icon, label|icon, ... — add buttons to existing board
   - [REMOVE_BUTTONS] label, label, ... — remove buttons by label
   - [REBUILD_BOARD] label|icon, label|icon, ... — replace entire board

== Observation Guidelines ==
Record any voice transcripts you hear. Record context changes (new objects, people leaving, gestures, etc.).

Update the board only if the context has meaningfully changed. Consider:
- objects in the environment
- potential responses to questions from audio
- objects the user is holding or indicating
- gestures or facial expressions

Do not add "Yes", "No", "Help", or "More" — these are automatic.
For icons, use emoji (🍕) or FontAwesome (fas fa-home).

== Speaking / Interpreting (HIGH CONFIDENCE only) ==
Only use [SPEAK] or [INTERPRET] when you have HIGH CONFIDENCE:
- A distinct gesture (nodding, shaking head, pointing, waving)
- Repeated gaze at specific object
- Someone directly asking the user a question

If unsure, add a button instead. Never use both [SPEAK] and [INTERPRET].`;

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

    try {
      const detStart = Date.now();
      const hasImage = messageHistory.some(m => Array.isArray(m.content) && (m.content as any[]).some((p: any) => p.type === "image_url"));
      const hasRawAudio = messageHistory.some(m => Array.isArray(m.content) && (m.content as any[]).some((p: any) => p.type === "input_audio"));
      console.log("[InteractiveAgent] processDetection: model:", this.config.interactiveModel, "provider:", this.config.interactiveProvider || "unknown", "image:", hasImage, "rawAudio:", hasRawAudio, "textAudioCtx:", !audioBuffer && !!audioContext, "messages:", messageHistory.length);

      // Log full prompt to debug file (no truncation)
      logDualAgent("InteractiveAgent.processDetection.PROMPT", {
        model: this.config.interactiveModel,
        provider: this.config.interactiveProvider,
        hasImage,
        hasRawAudio,
        messageCount: messageHistory.length,
        messages: messageHistory.map(m => ({
          role: m.role,
          content: typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((p: any) => {
                  if (p.type === "image_url") return { type: "image_url", detail: p.image_url?.detail, hasUrl: !!p.image_url?.url };
                  if (p.type === "input_audio") return { type: "input_audio", format: p.input_audio?.format, dataLength: p.input_audio?.data?.length };
                  return p;
                })
              : m.content,
        })),
      });

      // No tools - everything is text-based with prefix tokens
      const result = await this.chatProvider.completeChat({
        model: this.config.interactiveModel,
        messages: messageHistory,
        maxTokens: 1024,
        temperature: 0.3,
      });

      console.log("[InteractiveAgent] processDetection result: content:", (result.content || "").length, "chars, usage:", JSON.stringify(result.usage));

      const rawText = result.content || "";

      // Parse all prefix tokens from text content
      const parsed = parseStreamedText(rawText);
      const text = parsed.speak || "";
      const interpretation = parsed.interpret;
      const transcript = parsed.transcript;
      const transcriptSpeaker = parsed.transcriptSpeaker;
      const contextUpdate = parsed.contextUpdate;

      // Extract board changes from parsed text
      let addButtons = parsed.addButtons;
      let removeLabels = parsed.removeButtons;
      let rebuildBoard = parsed.rebuildBoard;

      console.log("[InteractiveAgent] processDetection parsed: speak:", text.length, "interpret:", (interpretation || "").substring(0, 40), "addButtons:", addButtons?.length || 0, "removeButtons:", removeLabels?.length || 0, "rebuildBoard:", rebuildBoard?.length || 0);

      const detElapsed = Date.now() - detStart;

      // Log full response to debug file (no truncation)
      logDualAgent("InteractiveAgent.processDetection.RESPONSE", {
        elapsedMs: detElapsed,
        rawText,
        parsed: {
          speak: text,
          interpretation,
          transcript,
          transcriptSpeaker,
          contextUpdate,
          addButtons,
          removeLabels,
          rebuildBoard,
        },
        usage: result.usage,
      });

      return { text, isCommand: false, usage: result.usage, addButtons, removeLabels, interpretation, transcript, transcriptSpeaker, contextUpdate, rebuildBoard };
    } catch (error) {
      console.error("[InteractiveAgent] Detection error:", error);
      throw error;
    }
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
