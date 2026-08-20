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
/** Vertex-authenticated twin of `_geminiChat`. See getChatProvider. */
let _geminiChatVertex: ChatProvider | null = null;
let _claudeStructured: StructuredLLMProvider | null = null;
let _claudeChat: ChatProvider | null = null;

// Test seams: when populated, these take precedence over the real singletons.
// Production code never touches them; only the test helpers in
// server/tests/helpers/llm-mock.ts call setStructuredProvider/setChatProvider.
const _structuredOverrides = new Map<LLMProviderKey, StructuredLLMProvider>();
const _chatOverrides = new Map<LLMProviderKey, ChatProvider>();

export function setStructuredProvider(
  provider: LLMProviderKey,
  instance: StructuredLLMProvider,
): void {
  _structuredOverrides.set(provider, instance);
}

export function setChatProvider(
  provider: LLMProviderKey,
  instance: ChatProvider,
): void {
  _chatOverrides.set(provider, instance);
}

export function clearProviderOverrides(): void {
  _structuredOverrides.clear();
  _chatOverrides.clear();
}

export function getStructuredProvider(provider: LLMProviderKey): StructuredLLMProvider {
  const override = _structuredOverrides.get(provider);
  if (override) return override;
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

/**
 * @param opts.useVertex for `gemini` only — route through the paid GCP project
 *   instead of the AI Studio API key. Cached as a SEPARATE singleton: the two
 *   authenticate differently and hold different prompt-cache handles, so they
 *   must not share an instance. Callers that omit it are unchanged.
 */
export function getChatProvider(
  provider: LLMProviderKey,
  opts?: { useVertex?: boolean },
): ChatProvider {
  const override = _chatOverrides.get(provider);
  if (override) return override;
  if (provider === "gemini" && opts?.useVertex) {
    if (!_geminiChatVertex) {
      _geminiChatVertex = new GeminiChatProvider(true);
    }
    return _geminiChatVertex;
  }
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
