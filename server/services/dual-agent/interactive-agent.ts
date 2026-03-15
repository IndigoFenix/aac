// server/services/dual-agent/interactive-agent.ts
// Fast, lightweight Interactive Agent for quick AAC responses

import type {
  DualAgentConfig,
} from "./types";
import type {
  ChatProvider,
} from "../providers/streaming-provider";

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
