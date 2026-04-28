/**
 * LLM mocking helpers.
 *
 * Drop in canned LLM responses without making real API calls. Routes through
 * the test seams in provider-factory.ts (`setStructuredProvider`,
 * `setChatProvider`, `clearProviderOverrides`) so the mock is invisible to
 * production code paths — they call `getStructuredProvider("openai")` as
 * normal and get the fake instead.
 *
 * Usage in a test:
 *
 *   const llm = installFakeLlm();
 *   llm.structured.enqueue({
 *     promptTokens: 0, completionTokens: 0, cachedTokens: 0,
 *     toolCalls: [], refused: false,
 *     content: { ... your structured payload ... },
 *   });
 *   // ... call code that goes through gpt.getStructuredResponse ...
 *   expect(llm.structured.calls).toHaveLength(1);
 *   uninstallFakeLlm();
 */

import {
  setStructuredProvider,
  setChatProvider,
  clearProviderOverrides,
} from '../../services/providers/provider-factory.js';
import type {
  StructuredLLMProvider,
  StructuredRequest,
} from '../../services/providers/structured-provider.js';
import type {
  ChatProvider,
  ChatRequest,
  ChatCompletionResult,
  StreamChunk,
} from '../../services/providers/streaming-provider.js';
import type { LLMProviderKey } from '@shared/llm-options';
import type { GPTResponse } from '../../services/chat/gpt.js';

const ALL_PROVIDERS: LLMProviderKey[] = ['openai', 'gemini', 'claude'];

/**
 * Records every structured request and replays canned responses in FIFO order.
 * Throws if a call comes in with no response queued — keeps tests honest about
 * how many LLM calls they expect.
 */
export class FakeStructuredProvider implements StructuredLLMProvider {
  readonly calls: StructuredRequest[] = [];
  private readonly responses: GPTResponse[] = [];

  enqueue(response: GPTResponse): void {
    this.responses.push(response);
  }

  /** Convenience: queue a content-only response with zero token usage. */
  enqueueContent(content: any): void {
    this.responses.push({
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      content,
      toolCalls: [],
      refused: false,
    });
  }

  async structuredComplete(request: StructuredRequest): Promise<GPTResponse> {
    this.calls.push(request);
    if (this.responses.length === 0) {
      throw new Error(
        `[FakeStructuredProvider] no response queued for call #${this.calls.length} ` +
          `(schema: ${request.schemaName})`,
      );
    }
    return this.responses.shift()!;
  }
}

/**
 * Records chat requests and replays canned `ChatCompletionResult`s.
 * `streamChat` synthesizes a stream from each canned result so callers that
 * use streaming don't need a separate API.
 */
export class FakeChatProvider implements ChatProvider {
  readonly calls: ChatRequest[] = [];
  private readonly responses: ChatCompletionResult[] = [];

  enqueue(response: ChatCompletionResult): void {
    this.responses.push(response);
  }

  /** Convenience: queue a plain text reply with no tool calls. */
  enqueueText(content: string): void {
    this.responses.push({
      content,
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0 },
      finishReason: 'STOP',
    });
  }

  async completeChat(request: ChatRequest): Promise<ChatCompletionResult> {
    this.calls.push(request);
    if (this.responses.length === 0) {
      throw new Error(
        `[FakeChatProvider] no response queued for call #${this.calls.length}`,
      );
    }
    return this.responses.shift()!;
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<StreamChunk> {
    const result = await this.completeChat(request);
    if (result.content) yield { type: 'text_delta', text: result.content };
    for (let i = 0; i < result.toolCalls.length; i++) {
      const tc = result.toolCalls[i];
      yield {
        type: 'tool_call_delta',
        index: i,
        name: tc.name,
        arguments: tc.arguments,
      };
    }
    yield { type: 'done', usage: result.usage };
  }
}

export interface FakeLlmHandles {
  structured: FakeStructuredProvider;
  chat: FakeChatProvider;
}

/**
 * Install fake providers for ALL provider keys (openai/gemini/claude). Code
 * that reads `aac_chat` settings and resolves to any provider gets the same
 * fake instance — tests don't need to know which provider config is in play.
 */
export function installFakeLlm(): FakeLlmHandles {
  const structured = new FakeStructuredProvider();
  const chat = new FakeChatProvider();
  for (const key of ALL_PROVIDERS) {
    setStructuredProvider(key, structured);
    setChatProvider(key, chat);
  }
  return { structured, chat };
}

export function uninstallFakeLlm(): void {
  clearProviderOverrides();
}
