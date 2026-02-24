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
  transcriptConfidence?: 'high' | 'medium' | 'low';
  contextUpdate?: string;
  speak?: string;
  interpret?: string;
  interpretConfidence?: 'high' | 'medium' | 'low';
  /** Buttons to add incrementally: "label|icon, label|icon, ..." */
  addButtons?: Array<{ label: string; iconRef: string }>;
  /** Button labels to remove */
  removeButtons?: string[];
  /** Complete board rebuild: "label|icon, label|icon, ..." (replaces entire board) */
  rebuildBoard?: Array<{ label: string; iconRef: string }>;
  /** Request early monitor check-in with reason */
  callMonitor?: string;
  /** Open an add-on app */
  openApp?: { appId: string; data?: string };
  /** Close the currently open app */
  closeApp?: boolean;
  /** Avatar emotion */
  emote?: "happy" | "sad" | "neutral";
  /** Learn a new face: name | relationship | description */
  learnFace?: { name: string; relationship?: string; description?: string };
  /** Select a pre-built board by name */
  setBoard?: string;
  /** AI presses a button on the current board (by label) */
  pressButton?: string;
  /** Yes/No question detected — trigger prominent overlay buttons */
  yesNo?: boolean;
  /** Deferred Yes/No — show overlay after TTS playback completes */
  askYesNo?: boolean;
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
export function parseStreamedText(text: string): ParsedStreamOutput {
  const result: ParsedStreamOutput = {};

  // Match [TRANSCRIPT speaker] or [TRANSCRIPT:confidence speaker] content
  const transcriptMatch = text.match(/\[TRANSCRIPT(?::(\w+))?\s+([^\]]+)\]\s*([^\[]*)/i);
  if (transcriptMatch) {
    if (transcriptMatch[1]) {
      result.transcriptConfidence = transcriptMatch[1].toLowerCase() as 'high' | 'medium' | 'low';
    }
    result.transcriptSpeaker = transcriptMatch[2].trim();
    result.transcript = transcriptMatch[3].trim();
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

  // Match [INTERPRET] or [INTERPRET:confidence] content
  const interpretMatch = text.match(/\[INTERPRET(?::(\w+))?\]\s*([^\[]*)/i);
  if (interpretMatch) {
    result.interpret = interpretMatch[2].trim();
    if (interpretMatch[1]) {
      result.interpretConfidence = interpretMatch[1].toLowerCase() as 'high' | 'medium' | 'low';
    }
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

  // Match [CALL_MONITOR] reason
  const callMonitorMatch = text.match(/\[CALL_MONITOR\]\s*([^\[]*)/i);
  if (callMonitorMatch) {
    result.callMonitor = callMonitorMatch[1].trim();
  }

  // Match [OPEN_APP] appId (optionally followed by data)
  const openAppMatch = text.match(/\[OPEN_APP\]\s*([^\[]*)/i);
  if (openAppMatch) {
    const parts = openAppMatch[1].trim().split(/\s+/);
    const appId = parts[0] || "";
    const data = parts.slice(1).join(" ") || undefined;
    if (appId) {
      result.openApp = { appId, data };
    }
  }

  // Match [CLOSE_APP]
  const closeAppMatch = text.match(/\[CLOSE_APP\]/i);
  if (closeAppMatch) {
    result.closeApp = true;
  }

  // Match [EMOTE] happy|sad|neutral
  const emoteMatch = text.match(/\[EMOTE\]\s*(happy|sad|neutral)/i);
  if (emoteMatch) {
    result.emote = emoteMatch[1].toLowerCase() as "happy" | "sad" | "neutral";
  }

  // Match [LEARN_FACE] name | relationship | description
  const learnFaceMatch = text.match(/\[LEARN_FACE\]\s*([^\[]*)/i);
  if (learnFaceMatch) {
    const parts = learnFaceMatch[1].split('|').map(s => s.trim()).filter(s => s);
    if (parts[0]) {
      result.learnFace = {
        name: parts[0],
        relationship: parts[1] || undefined,
        description: parts[2] || undefined,
      };
    }
  }

  // Match [SET_BOARD] board name
  const setBoardMatch = text.match(/\[SET_BOARD\]\s*([^\[]*)/i);
  if (setBoardMatch) {
    const name = setBoardMatch[1].trim();
    if (name) {
      result.setBoard = name;
    }
  }

  // Match [PRESS_BUTTON] button label
  const pressButtonMatch = text.match(/\[PRESS_BUTTON\]\s*([^\[]*)/i);
  if (pressButtonMatch) {
    const label = pressButtonMatch[1].trim();
    if (label) {
      result.pressButton = label;
    }
  }

  // Match [YES_NO]
  const yesNoMatch = text.match(/\[YES_NO\]/i);
  if (yesNoMatch) {
    result.yesNo = true;
  }

  // Match [ASK_YES_NO]
  const askYesNoMatch = text.match(/\[ASK_YES_NO\]/i);
  if (askYesNoMatch) {
    result.askYesNo = true;
  }

  return result;
}

/**
 * Parse board button format: "label|icon, label|icon, ..."
 * If no icon is provided, defaults to comment icon.
 */
export function parseBoardButtons(content: string): Array<{ label: string; iconRef: string; symbolPath?: string }> {
  const buttons: Array<{ label: string; iconRef: string; symbolPath?: string }> = [];
  const items = content.split(',');

  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;

    // Check for label|icon format
    const pipeIndex = trimmed.indexOf('|');
    if (pipeIndex > 0) {
      const label = trimmed.substring(0, pipeIndex).trim();
      let iconRef = trimmed.substring(pipeIndex + 1).trim();
      let symbolPath: string | undefined;

      // Handle face:contactId references
      if (iconRef.startsWith("face:")) {
        const contactId = iconRef.substring(5).trim();
        symbolPath = `__FACE__:${contactId}`;
        iconRef = "👤"; // fallback emoji
        console.log(`[InteractiveAgent] Parsed face button: "${label}" → face:${contactId}`);
      }

      // Handle symbol:symbolId references
      if (iconRef.startsWith("symbol:")) {
        const symbolId = iconRef.substring(7).trim();
        symbolPath = `__SYMBOL__:${symbolId}`;
        iconRef = "🖼️"; // fallback emoji
        console.log(`[InteractiveAgent] Parsed symbol button: "${label}" → symbol:${symbolId}`);
      }

      if (label) {
        buttons.push({ label, iconRef: iconRef || "fas fa-comment", symbolPath });
      }
    } else {
      // Just a label, use default icon
      buttons.push({ label: trimmed, iconRef: "fas fa-comment" });
    }
  }

  return buttons;
}

/** Types that the streaming parser can emit */
export type StreamingSegmentType = "speak" | "interpret" | "transcript" | "context" | "add_buttons" | "remove_buttons" | "rebuild_board" | "call_monitor" | "open_app" | "close_app" | "emote" | "learn_face" | "set_board" | "press_button" | "yes_no" | "ask_yes_no";

export interface StreamingSegment {
  type: StreamingSegmentType;
  data: string;
  speaker?: string;
  confidence?: 'high' | 'medium' | 'low';
}

/**
 * Streaming state machine for parsing prefix tokens incrementally.
 * Detects when a complete prefix token + content is available and emits it.
 */
export class StreamingPrefixParser {
  private buffer = "";
  private currentMode: "none" | "transcript" | "context" | "speak" | "interpret" | "add_buttons" | "remove_buttons" | "rebuild_board" | "call_monitor" | "open_app" | "close_app" | "emote" | "learn_face" | "set_board" | "press_button" | "yes_no" | "ask_yes_no" = "none";
  private transcriptSpeaker = "";
  private currentConfidence?: 'high' | 'medium' | 'low';

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
        const transcriptMatch = this.buffer.match(/^\s*\[TRANSCRIPT(?::(\w+))?\s+([^\]]+)\]\s*/i);
        const contextMatch = this.buffer.match(/^\s*\[CONTEXT\]\s*/i);
        const speakMatch = this.buffer.match(/^\s*\[SPEAK\]\s*/i);
        const interpretMatch = this.buffer.match(/^\s*\[INTERPRET(?::(\w+))?\]\s*/i);
        const addButtonsMatch = this.buffer.match(/^\s*\[ADD_BUTTONS\]\s*/i);
        const removeButtonsMatch = this.buffer.match(/^\s*\[REMOVE_BUTTONS\]\s*/i);
        const rebuildBoardMatch = this.buffer.match(/^\s*\[REBUILD_BOARD\]\s*/i);
        const callMonitorMatch = this.buffer.match(/^\s*\[CALL_MONITOR\]\s*/i);
        const openAppMatch = this.buffer.match(/^\s*\[OPEN_APP\]\s*/i);
        const closeAppMatch = this.buffer.match(/^\s*\[CLOSE_APP\]\s*/i);
        const emoteMatch = this.buffer.match(/^\s*\[EMOTE\]\s*/i);
        const learnFaceMatch = this.buffer.match(/^\s*\[LEARN_FACE\]\s*/i);
        const setBoardMatch = this.buffer.match(/^\s*\[SET_BOARD\]\s*/i);
        const pressButtonMatch = this.buffer.match(/^\s*\[PRESS_BUTTON\]\s*/i);
        const yesNoMatch = this.buffer.match(/^\s*\[YES_NO\]\s*/i);
        const askYesNoMatch = this.buffer.match(/^\s*\[ASK_YES_NO\]\s*/i);

        if (transcriptMatch) {
          this.currentMode = "transcript";
          this.currentConfidence = transcriptMatch[1]?.toLowerCase() as 'high' | 'medium' | 'low' | undefined;
          this.transcriptSpeaker = transcriptMatch[2].trim();
          this.buffer = this.buffer.slice(transcriptMatch[0].length);
        } else if (contextMatch) {
          this.currentMode = "context";
          this.buffer = this.buffer.slice(contextMatch[0].length);
        } else if (speakMatch) {
          this.currentMode = "speak";
          this.buffer = this.buffer.slice(speakMatch[0].length);
        } else if (interpretMatch) {
          this.currentMode = "interpret";
          this.currentConfidence = interpretMatch[1]?.toLowerCase() as 'high' | 'medium' | 'low' | undefined;
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
        } else if (callMonitorMatch) {
          this.currentMode = "call_monitor";
          this.buffer = this.buffer.slice(callMonitorMatch[0].length);
        } else if (openAppMatch) {
          this.currentMode = "open_app";
          this.buffer = this.buffer.slice(openAppMatch[0].length);
        } else if (closeAppMatch) {
          this.currentMode = "close_app";
          this.buffer = this.buffer.slice(closeAppMatch[0].length);
        } else if (emoteMatch) {
          this.currentMode = "emote";
          this.buffer = this.buffer.slice(emoteMatch[0].length);
        } else if (learnFaceMatch) {
          this.currentMode = "learn_face";
          this.buffer = this.buffer.slice(learnFaceMatch[0].length);
        } else if (setBoardMatch) {
          this.currentMode = "set_board";
          this.buffer = this.buffer.slice(setBoardMatch[0].length);
        } else if (pressButtonMatch) {
          this.currentMode = "press_button";
          this.buffer = this.buffer.slice(pressButtonMatch[0].length);
        } else if (yesNoMatch) {
          // [YES_NO] is a standalone token with no content — emit immediately
          this.buffer = this.buffer.slice(yesNoMatch[0].length);
          results.push({ type: "yes_no", data: "true" });
        } else if (askYesNoMatch) {
          // [ASK_YES_NO] is a standalone token — deferred overlay after TTS
          this.buffer = this.buffer.slice(askYesNoMatch[0].length);
          results.push({ type: "ask_yes_no", data: "true" });
        } else {
          // No prefix found yet, wait for more data
          // But trim leading whitespace/newlines that aren't part of a token
          this.buffer = this.buffer.replace(/^[\s\n]+/, "");
          break;
        }
      } else {
        // We're in a mode, collect content until the next prefix or end
        const nextPrefixMatch = this.buffer.match(/\[(?:TRANSCRIPT(?::\w+)?|CONTEXT|SPEAK|INTERPRET(?::\w+)?|ADD_BUTTONS|REMOVE_BUTTONS|REBUILD_BOARD|CALL_MONITOR|OPEN_APP|CLOSE_APP|EMOTE|LEARN_FACE|SET_BOARD|PRESS_BUTTON|YES_NO|ASK_YES_NO)[\s\]]/i);

        if (nextPrefixMatch && nextPrefixMatch.index !== undefined && nextPrefixMatch.index > 0) {
          // Found next prefix, emit current content
          const content = this.buffer.slice(0, nextPrefixMatch.index).trim();
          if (content) {
            if (this.currentMode === "transcript") {
              results.push({ type: "transcript", data: content, speaker: this.transcriptSpeaker, confidence: this.currentConfidence });
            } else if (this.currentMode === "interpret") {
              results.push({ type: "interpret", data: content, confidence: this.currentConfidence });
            } else {
              results.push({ type: this.currentMode, data: content });
            }
          }
          this.buffer = this.buffer.slice(nextPrefixMatch.index);
          this.currentMode = "none";
          this.currentConfidence = undefined;
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
        results.push({ type: "transcript", data: this.buffer.trim(), speaker: this.transcriptSpeaker, confidence: this.currentConfidence });
      } else if (this.currentMode === "interpret") {
        results.push({ type: "interpret", data: this.buffer.trim(), confidence: this.currentConfidence });
      } else {
        results.push({ type: this.currentMode, data: this.buffer.trim() });
      }
    }

    this.buffer = "";
    this.currentMode = "none";
    this.currentConfidence = undefined;
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
    currentBoard?: ParsedBoardData,
    maxBoardItems: number = 12,
    customBoardInfo?: { fixedButtons: string[]; aiAddedButtons: string[] }
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

    // Add interaction timing context so the AI knows pacing
    const allTimestamps = [
      ...messages.filter(m => m.role === "user" || m.role === "assistant").map(m => ({ role: m.role, ts: m.timestamp || 0 })),
      ...pendingMessages.map(m => ({ role: m.role, ts: m.timestamp || 0 })),
    ].filter(t => t.ts > 0).sort((a, b) => a.ts - b.ts);

    if (allTimestamps.length > 0) {
      const now = Date.now();
      const sessionStart = allTimestamps[0].ts;
      const sessionDurMin = Math.round((now - sessionStart) / 60000);
      const lastUser = [...allTimestamps].reverse().find(t => t.role === "user");
      const lastAI = [...allTimestamps].reverse().find(t => t.role === "assistant");

      // Count messages in last 5 minutes
      const fiveMinAgo = now - 5 * 60000;
      const recentCount = allTimestamps.filter(t => t.ts >= fiveMinAgo).length;

      // Compute average gap between consecutive user messages
      const userTimestamps = allTimestamps.filter(t => t.role === "user").map(t => t.ts);
      let avgGap = "";
      if (userTimestamps.length >= 2) {
        const gaps = userTimestamps.slice(1).map((ts, i) => ts - userTimestamps[i]);
        const avgMs = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        avgGap = avgMs < 60000 ? `${Math.round(avgMs / 1000)}s` : `${Math.round(avgMs / 60000)}m`;
      }

      const formatAge = (ms: number) => ms < 60000 ? `${Math.round(ms / 1000)}s ago` : `${Math.round(ms / 60000)}m ago`;

      let timing = `== Interaction Timing ==\nSession: ${sessionDurMin}m`;
      timing += ` | Messages (last 5m): ${recentCount}`;
      if (avgGap) timing += ` | Avg gap between user messages: ${avgGap}`;
      if (lastUser) timing += `\nLast user message: ${formatAge(now - lastUser.ts)}`;
      if (lastAI) timing += ` | Last AI response: ${formatAge(now - lastAI.ts)}`;

      result.push({ role: "system", content: timing });
    }

    // Add current board context if available
    if (currentBoard) {
      const boardContext = this.formatBoardContext(currentBoard, maxBoardItems, customBoardInfo);
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
  private formatBoardContext(board: ParsedBoardData, maxBoardItems: number = 12, customBoardInfo?: { fixedButtons: string[]; aiAddedButtons: string[] }): string {
    const currentPage = board.pages?.find(p => p.id === board.currentPageId) || board.pages?.[0];
    const buttons = currentPage?.buttons || [];

    if (customBoardInfo && customBoardInfo.fixedButtons.length > 0) {
      const blankSlots = maxBoardItems - customBoardInfo.fixedButtons.length;
      const available = blankSlots - customBoardInfo.aiAddedButtons.length;
      return `[Current Board — ${maxBoardItems} slots, custom board loaded]
Fixed buttons (cannot remove): ${customBoardInfo.fixedButtons.join(", ")} (${customBoardInfo.fixedButtons.length} of ${maxBoardItems})
AI-added buttons (can remove): ${customBoardInfo.aiAddedButtons.join(", ") || "none"} (${customBoardInfo.aiAddedButtons.length} added)
Available slots: ${available}
You can ONLY [REMOVE_BUTTONS] that you previously added. Fixed board buttons cannot be removed.
Use [REBUILD_BOARD] to exit the custom board and return to the default board.`;
    }

    const occupiedCount = Math.min(buttons.length, maxBoardItems);
    const blankCount = maxBoardItems - occupiedCount;
    const buttonLabels = buttons
      .slice(0, maxBoardItems)
      .filter((b: { label?: string }) => b.label)
      .map((b: { label: string }) => b.label)
      .join(", ");

    return `[Current Board — ${maxBoardItems} slots]
Occupied: ${buttonLabels || "none"} (${occupiedCount} of ${maxBoardItems})
Blank slots: ${blankCount}
HARD LIMIT: You CANNOT have more than ${maxBoardItems} buttons. If you need to add buttons and the board is full, you MUST use [REMOVE_BUTTONS] first.
Use [REBUILD_BOARD] to replace the entire board or [ADD_BUTTONS]/[REMOVE_BUTTONS] for incremental changes.`;
  }

  /**
   * Format board state for detection — shows 12-slot positions with blank indicators.
   */
  private formatBoardContextForDetection(board: ParsedBoardData, maxBoardItems: number = 12, customBoardInfo?: { fixedButtons: string[]; aiAddedButtons: string[] }): string {
    const currentPage = board.pages?.find(p => p.id === board.currentPageId) || board.pages?.[0];
    const buttons = currentPage?.buttons || [];

    if (customBoardInfo && customBoardInfo.fixedButtons.length > 0) {
      const fixedSet = new Set(customBoardInfo.fixedButtons.map(l => l.toLowerCase()));
      const aiSet = new Set(customBoardInfo.aiAddedButtons.map(l => l.toLowerCase()));
      const slotLines: string[] = [];
      for (let i = 0; i < maxBoardItems; i++) {
        const btn = buttons[i] as { label?: string } | undefined;
        if (btn?.label) {
          if (fixedSet.has(btn.label.toLowerCase())) {
            slotLines.push(`  Slot ${i + 1}: "${btn.label}" [FIXED]`);
          } else if (aiSet.has(btn.label.toLowerCase())) {
            slotLines.push(`  Slot ${i + 1}: "${btn.label}" [AI-added]`);
          } else {
            slotLines.push(`  Slot ${i + 1}: "${btn.label}"`);
          }
        } else {
          slotLines.push(`  Slot ${i + 1}: [blank]`);
        }
      }
      const blankSlots = maxBoardItems - customBoardInfo.fixedButtons.length;
      const available = blankSlots - customBoardInfo.aiAddedButtons.length;
      return `[Current Board — ${maxBoardItems} slots, custom board loaded]\n${slotLines.join("\n")}\nFixed buttons: ${customBoardInfo.fixedButtons.length} | AI-added: ${customBoardInfo.aiAddedButtons.length} | Available: ${available}\nYou can ONLY remove [AI-added] buttons. [FIXED] buttons cannot be removed.`;
    }

    const slotLines: string[] = [];
    for (let i = 0; i < maxBoardItems; i++) {
      const btn = buttons[i] as { label?: string } | undefined;
      if (btn?.label) {
        slotLines.push(`  Slot ${i + 1}: "${btn.label}"`);
      } else {
        slotLines.push(`  Slot ${i + 1}: [blank]`);
      }
    }

    const blankCount = maxBoardItems - Math.min(buttons.length, maxBoardItems);

    return `[Current Board — ${maxBoardItems} slots]\n${slotLines.join("\n")}\nBlank slots available: ${blankCount}\nHARD LIMIT: Cannot exceed ${maxBoardItems} buttons. Remove buttons first if board is full.`;
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
    const boardMax = currentBoard ? (currentBoard.grid?.rows || 3) * (currentBoard.grid?.cols || 4) : 12;
    const messageHistory = this.buildMessageHistory(
      messages,
      pendingMessages,
      currentBoard,
      boardMax
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
        maxTokens: 1024,  // Enough for greeting + board operations
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
    } catch (error: any) {
      console.error("[InteractiveAgent] processMessage error:", error?.message || error);
      if (error?.stack) console.error("[InteractiveAgent] Stack trace:", error.stack);
      throw error;
    }
  }

  /**
   * Apply board diff (add/remove) to current board state
   */
  private applyBoardDiff(
    currentBoard: ParsedBoardData,
    addButtons?: Array<{ label: string; iconRef: string; symbolPath?: string }>,
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
          symbolPath: newBtn.symbolPath || undefined,
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
    personContext?: string, // Identified person context from biometrics
    customBoardInfo?: { fixedButtons: string[]; aiAddedButtons: string[] }
  ): AsyncGenerator<{ type: "speak" | "interpret" | "transcript" | "context" | "board" | "board_patch" | "command" | "usage" | "call_monitor" | "open_app" | "close_app" | "emote" | "learn_face" | "set_board" | "press_button" | "yes_no" | "ask_yes_no"; data: any; speaker?: string }> {
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
    const boardMax = currentBoard ? (currentBoard.grid?.rows || 3) * (currentBoard.grid?.cols || 4) : 12;
    const messageHistory = this.buildMessageHistory(
      messages,
      pendingMessages,
      currentBoard,
      boardMax,
      customBoardInfo
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
        maxTokens: 1024, // Enough for greeting + board rebuild
        temperature: 0.7,
      });

      let fullText = "";
      const prefixParser = new StreamingPrefixParser();
      let streamUsage: { promptTokens: number; completionTokens: number } | undefined;

      // Collect board changes to yield at the end (after all text is parsed)
      let addButtons: Array<{ label: string; iconRef: string }> = [];
      let removeButtons: string[] = [];
      let rebuildBoard: Array<{ label: string; iconRef: string }> | null = null;
      let callMonitorReason: string | undefined;
      let openAppData: { appId: string; data?: string } | undefined;
      let closeAppTriggered = false;
      let emoteValue: string | undefined;
      let learnFaceData: { name: string; relationship?: string; description?: string } | undefined;
      let setBoardName: string | undefined;
      let pressButtonLabel: string | undefined;
      let yesNoTriggered = false;
      let askYesNoTriggered = false;

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
            } else if (seg.type === "call_monitor") {
              callMonitorReason = seg.data;
            } else if (seg.type === "open_app") {
              const parts = seg.data.trim().split(/\s+/);
              const appId = parts[0] || "";
              const data = parts.slice(1).join(" ") || undefined;
              if (appId) openAppData = { appId, data };
            } else if (seg.type === "close_app") {
              closeAppTriggered = true;
            } else if (seg.type === "emote") {
              emoteValue = seg.data;
            } else if (seg.type === "learn_face") {
              const parts = seg.data.split('|').map((s: string) => s.trim()).filter((s: string) => s);
              if (parts[0]) {
                learnFaceData = { name: parts[0], relationship: parts[1] || undefined, description: parts[2] || undefined };
              }
            } else if (seg.type === "set_board") {
              setBoardName = seg.data.trim();
            } else if (seg.type === "press_button") {
              pressButtonLabel = seg.data.trim();
            } else if (seg.type === "yes_no") {
              yesNoTriggered = true;
            } else if (seg.type === "ask_yes_no") {
              askYesNoTriggered = true;
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
        } else if (seg.type === "call_monitor") {
          callMonitorReason = seg.data;
        } else if (seg.type === "open_app") {
          const parts = seg.data.trim().split(/\s+/);
          const appId = parts[0] || "";
          const data = parts.slice(1).join(" ") || undefined;
          if (appId) openAppData = { appId, data };
        } else if (seg.type === "close_app") {
          closeAppTriggered = true;
        } else if (seg.type === "emote") {
          emoteValue = seg.data;
        } else if (seg.type === "learn_face") {
          const parts = seg.data.split('|').map((s: string) => s.trim()).filter((s: string) => s);
          if (parts[0]) {
            learnFaceData = { name: parts[0], relationship: parts[1] || undefined, description: parts[2] || undefined };
          }
        } else if (seg.type === "set_board") {
          setBoardName = seg.data.trim();
        } else if (seg.type === "press_button") {
          pressButtonLabel = seg.data.trim();
        } else if (seg.type === "yes_no") {
          yesNoTriggered = true;
        } else if (seg.type === "ask_yes_no") {
          askYesNoTriggered = true;
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

      // Yield call_monitor request if present
      if (callMonitorReason) {
        yield { type: "call_monitor", data: callMonitorReason };
      }

      // Yield open_app request if present
      if (openAppData) {
        yield { type: "open_app", data: openAppData };
      }

      // Yield close_app if triggered
      if (closeAppTriggered) {
        yield { type: "close_app", data: true };
      }

      // Yield emote if present
      if (emoteValue) {
        yield { type: "emote", data: emoteValue };
      }

      // Yield learn_face if present
      if (learnFaceData) {
        yield { type: "learn_face", data: learnFaceData };
      }

      // Yield set_board if present
      if (setBoardName) {
        yield { type: "set_board", data: setBoardName };
      }

      // Yield press_button if present
      if (pressButtonLabel) {
        yield { type: "press_button", data: pressButtonLabel };
      }

      // Yield yes_no if triggered
      if (yesNoTriggered) {
        yield { type: "yes_no", data: true };
      }

      // Yield ask_yes_no if triggered (deferred — client shows after TTS)
      if (askYesNoTriggered) {
        yield { type: "ask_yes_no", data: true };
      }
    } catch (error: any) {
      console.error("[InteractiveAgent] processMessageStream error:", error?.message || error);
      if (error?.stack) console.error("[InteractiveAgent] Stack trace:", error.stack);
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
    pendingMessages: PendingMessage[],
    currentBoard?: ParsedBoardData,
    imageData?: string,
    audioContext?: string,
    detectionSystemPrompt?: string,
    gestureContext?: string,
    audioBuffer?: Buffer,
    frameTimestamps?: number[],
    appCanvasData?: string,
    envFrameTimestamps?: number[],
    audioMimeType?: string,
    maxBoardItems: number = 12,
    customBoardInfo?: { fixedButtons: string[]; aiAddedButtons: string[] }
  ): Promise<InteractiveResponse> {
    const messageHistory: ProviderChatMessage[] = [
      { role: "system", content: detectionSystemPrompt || this.systemPrompt },
    ];

    // Add recent conversation context so the AI knows what just happened
    // Include last 10 processed messages + all pending (unprocessed) messages
    const recentMessages = messages.slice(-10);
    const allRecent = [
      ...recentMessages.map(m => ({
        role: (typeof m.role === "string" ? m.role : "assistant") as string,
        content: typeof m.content === "string" ? m.content : (m.content as any)?.text || (m.content as any)?.html || "",
        timestamp: m.timestamp || 0,
      })),
      ...pendingMessages.map(m => ({
        role: m.role as string,
        content: m.content,
        timestamp: m.timestamp || 0,
      })),
    ];

    if (allRecent.length > 0) {
      const now = Date.now();
      const contextLines = allRecent.map(m => {
        const age = now - m.timestamp;
        const ageStr = age < 60000 ? `${Math.round(age / 1000)}s ago` : `${Math.round(age / 60000)}m ago`;
        const roleLabel = m.role === "assistant" ? "AI" : m.role === "user" ? "User" : "System";
        // Summarize messages: strip boilerplate prefixes from system messages,
        // keep user/AI messages shorter since they're less critical for detection context
        let content = m.content;
        const isSystemMsg = content.startsWith("[SYSTEM");
        if (isSystemMsg) {
          // Strip wrapper brackets and known prefixes to keep the substance
          content = content.replace(/^\[SYSTEM\s*[—–-]\s*/, "").replace(/\]$/, "");
        }
        const limit = isSystemMsg ? 300 : 150;
        if (content.length > limit) content = content.substring(0, limit) + "...";
        return `[${ageStr}] ${roleLabel}: ${content}`;
      });

      // Compute interaction pace summary
      const userMsgs = allRecent.filter(m => m.role === "user" && m.timestamp > 0);
      const lastUserAge = userMsgs.length > 0 ? now - userMsgs[userMsgs.length - 1].timestamp : null;
      const fiveMinAgo = now - 5 * 60000;
      const recentCount = allRecent.filter(m => m.timestamp >= fiveMinAgo).length;
      let paceLine = `Pace: ${recentCount} messages in last 5m`;
      if (lastUserAge !== null) {
        const lastUserStr = lastUserAge < 60000 ? `${Math.round(lastUserAge / 1000)}s ago` : `${Math.round(lastUserAge / 60000)}m ago`;
        paceLine += ` | Last user interaction: ${lastUserStr}`;
      }

      messageHistory.push({
        role: "system",
        content: `== Recent Activity (${allRecent.length} messages) ==\n${paceLine}\n${contextLines.join("\n")}`,
      });
    }

    // Add current board with slot layout so the AI knows what's already shown
    if (currentBoard) {
      const detectionBoardMax = (currentBoard.grid?.rows || 3) * (currentBoard.grid?.cols || 4);
      const effectiveMax = Math.max(maxBoardItems, detectionBoardMax);
      const boardContext = this.formatBoardContextForDetection(currentBoard, effectiveMax, customBoardInfo);
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

    // Build composite grid context if frame timestamps provided
    let gridContext = "";
    if (envFrameTimestamps && envFrameTimestamps.length > 0 && frameTimestamps && frameTimestamps.length > 0) {
      // Dual-camera grid: top rows = user camera, bottom rows = env camera
      const gridCols = 4;
      const totalFrames = frameTimestamps.length + envFrameTimestamps.length;
      const userFirstTs = frameTimestamps[0];
      const envFirstTs = envFrameTimestamps[0];
      const userRows: string[] = [];
      for (let r = 0; r * gridCols < frameTimestamps.length; r++) {
        const rowTs = frameTimestamps
          .slice(r * gridCols, (r + 1) * gridCols)
          .map(ts => `+${((ts - userFirstTs) / 1000).toFixed(1)}s`);
        userRows.push(`Row ${r + 1} (User Camera): ${rowTs.join(", ")}`);
      }
      const envRows: string[] = [];
      const envRowOffset = Math.ceil(frameTimestamps.length / gridCols);
      for (let r = 0; r * gridCols < envFrameTimestamps.length; r++) {
        const rowTs = envFrameTimestamps
          .slice(r * gridCols, (r + 1) * gridCols)
          .map(ts => `+${((ts - envFirstTs) / 1000).toFixed(1)}s`);
        envRows.push(`Row ${envRowOffset + r + 1} (Environment Camera): ${rowTs.join(", ")}`);
      }
      gridContext = `\n\n== Dual-Camera Composite Grid ==
This image is a composite grid of ${totalFrames} frames from TWO cameras arranged left-to-right, top-to-bottom.
The TOP rows show the USER CAMERA (facing the student).
The BOTTOM rows show the ENVIRONMENT CAMERA (facing the room/surroundings).
${userRows.join("\n")}
${envRows.join("\n")}
Observe changes across frames from both cameras to understand the full context.`;
    } else if (frameTimestamps && frameTimestamps.length > 1) {
      const firstTs = frameTimestamps[0];
      const gridCols = 4; // matches client default
      const rows: string[] = [];
      for (let r = 0; r * gridCols < frameTimestamps.length; r++) {
        const rowTimestamps = frameTimestamps
          .slice(r * gridCols, (r + 1) * gridCols)
          .map(ts => `+${((ts - firstTs) / 1000).toFixed(1)}s`);
        rows.push(`Row ${r + 1}: ${rowTimestamps.join(", ")}`);
      }
      gridContext = `\n\n== Composite Grid ==
This image is a composite grid of ${frameTimestamps.length} camera frames arranged left-to-right, top-to-bottom.
Each sub-frame is timestamped relative to the first frame:
${rows.join("\n")}
Observe changes across frames to understand motion, gestures, and temporal context.`;
    }

    // Build the user message with optional image + raw audio
    // Raw audio goes as input_audio — Gemini converts to inlineData natively.
    // OpenAI/Claude providers strip input_audio blocks they can't handle.
    const userText = `Observe the environment and respond using prefix tokens as described in your system prompt. If nothing noteworthy changed, output nothing.${gridContext}`;

    const contentParts: any[] = [{ type: "text", text: userText }];
    if (imageData) {
      contentParts.push({ type: "image_url", image_url: { url: imageData, detail: "low" } });
    }
    if (appCanvasData) {
      contentParts.push({ type: "text", text: "The student is using the Drawing app. The second image shows their current drawing." });
      contentParts.push({ type: "image_url", image_url: { url: appCanvasData, detail: "low" } });
    }
    if (audioBuffer) {
      // Derive audio format from mime type (e.g. "audio/wav" → "wav", "audio/webm" → "webm")
      let audioFormat = "webm";
      if (audioMimeType) {
        const sub = audioMimeType.split("/")[1]?.split(";")[0]?.trim();
        if (sub === "wav" || sub === "wave") audioFormat = "wav";
        else if (sub === "mp3" || sub === "mpeg") audioFormat = "mp3";
        else if (sub === "ogg") audioFormat = "ogg";
        else if (sub) audioFormat = sub;
      }
      contentParts.push({
        type: "input_audio",
        input_audio: { data: audioBuffer.toString("base64"), format: audioFormat },
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
      let result = await this.chatProvider.completeChat({
        model: this.config.interactiveModel,
        messages: messageHistory,
        maxTokens: 1024,
        temperature: 0.3,
      });

      const completionTokens = result.usage?.completionTokens || 0;
      console.log("[InteractiveAgent] processDetection result: content:", (result.content || "").length, "chars, finishReason:", result.finishReason, "completionTokens:", completionTokens, "usage:", JSON.stringify(result.usage));

      // Retry once if:
      // - Non-STOP/non-MAX_TOKENS finish reason (SAFETY, RECITATION, etc.)
      // - MAX_TOKENS but suspiciously short (< 200 tokens) — Gemini occasionally
      //   reports false MAX_TOKENS on multimodal requests with image+audio
      const shouldRetry = result.finishReason && result.finishReason !== "STOP" && (
        result.finishReason !== "MAX_TOKENS" || completionTokens < 200
      );
      if (shouldRetry) {
        console.warn(`[InteractiveAgent] processDetection: finishReason="${result.finishReason}" with ${completionTokens} tokens, retrying once...`);
        result = await this.chatProvider.completeChat({
          model: this.config.interactiveModel,
          messages: messageHistory,
          maxTokens: 1024,
          temperature: 0.3,
        });
        console.log(`[InteractiveAgent] processDetection retry: content=${(result.content || "").length}chars, finishReason=${result.finishReason}, completionTokens=${result.usage?.completionTokens}`);
      }

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
        finishReason: result.finishReason,
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

      return { text, isCommand: false, usage: result.usage, addButtons, removeLabels, interpretation, interpretConfidence: parsed.interpretConfidence, transcriptConfidence: parsed.transcriptConfidence, transcript, transcriptSpeaker, contextUpdate, rebuildBoard, callMonitor: parsed.callMonitor, openApp: parsed.openApp, closeApp: parsed.closeApp, emote: parsed.emote, learnFace: parsed.learnFace, setBoard: parsed.setBoard, pressButton: parsed.pressButton, yesNo: parsed.yesNo, askYesNo: parsed.askYesNo, finishReason: result.finishReason };
    } catch (error: any) {
      console.error("[InteractiveAgent] processDetection error:", error?.message || error);
      if (error?.stack) console.error("[InteractiveAgent] Stack trace:", error.stack);
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
    buttons: Array<{ label: string; action?: string; iconRef?: string; symbolPath?: string }>,
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
      symbolPath?: string;
      action: { type: "speak" | "link" | "back" | "home"; text?: string };
    }> = buttons.slice(0, totalCells).map((btn, index) => ({
      id: `btn-${Date.now()}-${index}`,
      label: btn.label,
      spokenText: btn.label,
      row: Math.floor(index / grid.cols),
      col: index % grid.cols,
      iconRef: btn.iconRef || undefined,
      symbolPath: (btn as any).symbolPath || undefined,
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
