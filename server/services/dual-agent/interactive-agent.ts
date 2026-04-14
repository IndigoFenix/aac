// server/services/dual-agent/interactive-agent.ts
// Fast, lightweight Interactive Agent for quick AAC responses

import type {
  DualAgentConfig,
} from "./types";
import type {
  ChatProvider,
} from "../providers/streaming-provider";

/**
 * Parse board button format: "label|icon, label|icon, ..." or "label|icon|image_key, ..."
 * If no icon is provided, defaults to comment icon.
 * The optional third pipe-delimited field is an image_key for auto-generated symbols.
 * The optional fourth pipe-delimited field is a pre-generated interpreted sentence:
 *   "Water|💧|water_drop|I would like some water, Play|🎮|game_controller|Let's play"
 *   "Water|💧||I would like some water"  (no image_key, but sentence)
 * The optional fifth and sixth fields are rowSpan and colSpan (default 1):
 *   "Big Button|🎯||Press me|2|2"  (spans 2 rows and 2 columns)
 */
export function parseBoardButtons(content: string): Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string; sentence?: string; buttonType?: "guess" | "category"; rowSpan?: number; colSpan?: number }> {
  const buttons: Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string; sentence?: string; buttonType?: "guess" | "category"; rowSpan?: number; colSpan?: number }> = [];
  const items = content.split(',');

  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;

    // Check for label|icon or label|icon|image_key or label|icon|image_key|sentence format
    const pipeIndex = trimmed.indexOf('|');
    if (pipeIndex > 0) {
      const parts = trimmed.split('|');
      let label = parts[0].trim();
      let iconRef = parts[1].trim();

      // Detect [GUESS] prefix for guessing mode final guesses
      let buttonType: "guess" | "category" | undefined;
      if (label.startsWith("[GUESS]")) {
        label = label.substring(7).trim();
        buttonType = "guess";
      }
      // imageKey is only valid if there are 4+ parts and the 3rd part is non-empty;
      // otherwise the AI omitted the image key and parts[2] is actually the sentence
      const hasImageKey = parts.length >= 4 && parts[2]?.trim() !== "";
      const imageKey = hasImageKey ? parts[2].trim() : undefined;
      const sentence = hasImageKey ? (parts[3]?.trim() || undefined) : (parts[2]?.trim() || undefined);
      const spanOffset = hasImageKey ? 4 : 3;
      const rawRowSpan = parseInt(parts[spanOffset]?.trim(), 10);
      const rawColSpan = parseInt(parts[spanOffset + 1]?.trim(), 10);
      const rowSpan = rawRowSpan >= 2 ? rawRowSpan : undefined;
      const colSpan = rawColSpan >= 2 ? rawColSpan : undefined;
      let symbolPath: string | undefined;

      // Handle face:contactId references
      if (iconRef.startsWith("face:")) {
        const contactId = iconRef.substring(5).trim();
        symbolPath = `__FACE__:${contactId}`;
        iconRef = "👤"; // fallback emoji
        console.log(`[InteractiveAgent] Parsed face button: "${label}" → face:${contactId}`);
      }

      // Handle symbol:symbolId references ��� skip image_key when custom symbol is used
      if (iconRef.startsWith("symbol:")) {
        const symbolId = iconRef.substring(7).trim();
        symbolPath = `__SYMBOL__:${symbolId}`;
        iconRef = "🖼️"; // fallback emoji
        console.log(`[InteractiveAgent] Parsed symbol button: "${label}" → symbol:${symbolId}`);
      }

      if (label) {
        // Skip imageKey when icon is a single character/number (not an emoji) — the character is the visual
        const isSingleChar = iconRef.length === 1 && !/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]/u.test(iconRef);
        buttons.push({
          label,
          iconRef: iconRef || "fas fa-comment",
          symbolPath,
          // Only include imageKey if no custom symbol is set and icon isn't a plain character
          imageKey: (symbolPath || isSingleChar) ? undefined : imageKey,
          sentence,
          buttonType,
          rowSpan,
          colSpan,
        });
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
