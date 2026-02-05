// server/services/providers/provider-factory.ts
// Factory for creating provider instances by key

import type { LLMProviderKey } from "@shared/llm-options";
import type { StructuredLLMProvider } from "./structured-provider";
import type { ChatProvider } from "./streaming-provider";
import { OpenAIStructuredProvider } from "./openai-structured";
import { OpenAIChatProvider } from "./openai-chat";
import { GeminiStructuredProvider } from "./gemini-structured";
import { GeminiChatProvider } from "./gemini-chat";
import { ClaudeStructuredProvider } from "./claude-structured";
import { ClaudeChatProvider } from "./claude-chat";

// Lazy singletons
let _openaiStructured: StructuredLLMProvider | null = null;
let _openaiChat: ChatProvider | null = null;
let _geminiStructured: StructuredLLMProvider | null = null;
let _geminiChat: ChatProvider | null = null;
let _claudeStructured: StructuredLLMProvider | null = null;
let _claudeChat: ChatProvider | null = null;

export function getStructuredProvider(provider: LLMProviderKey): StructuredLLMProvider {
  switch (provider) {
    case "openai":
      if (!_openaiStructured) {
        _openaiStructured = new OpenAIStructuredProvider();
      }
      return _openaiStructured;

    case "gemini":
      if (!_geminiStructured) {
        _geminiStructured = new GeminiStructuredProvider();
      }
      return _geminiStructured;

    case "claude":
      if (!_claudeStructured) {
        _claudeStructured = new ClaudeStructuredProvider();
      }
      return _claudeStructured;

    default:
      throw new Error(`Unknown structured provider: ${provider}`);
  }
}

export function getChatProvider(provider: LLMProviderKey): ChatProvider {
  switch (provider) {
    case "openai":
      if (!_openaiChat) {
        _openaiChat = new OpenAIChatProvider();
      }
      return _openaiChat;

    case "gemini":
      if (!_geminiChat) {
        _geminiChat = new GeminiChatProvider();
      }
      return _geminiChat;

    case "claude":
      if (!_claudeChat) {
        _claudeChat = new ClaudeChatProvider();
      }
      return _claudeChat;

    default:
      throw new Error(`Unknown chat provider: ${provider}`);
  }
}
