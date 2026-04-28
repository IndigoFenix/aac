/**
 * Smoke tests for the fake-LLM test seam.
 *
 * Proves that:
 *   1. Production code paths (gpt.getStructuredResponse, chat providers)
 *      transparently route through the fake when one is installed.
 *   2. The fake captures requests so tests can assert on what was sent.
 *   3. Streaming chat is synthesized correctly from canned completions.
 *
 * These tests do NOT make any real LLM API calls.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { installFakeLlm, uninstallFakeLlm } from '../helpers/llm-mock.js';
import { GPT } from '../../services/chat/gpt.js';
import {
  getStructuredProvider,
  getChatProvider,
} from '../../services/providers/provider-factory.js';

describe('Fake LLM provider seam', () => {
  afterEach(() => {
    uninstallFakeLlm();
  });

  describe('structured provider', () => {
    it('returns canned content for gpt.getStructuredResponse', async () => {
      const llm = installFakeLlm();
      llm.structured.enqueueContent({ message: 'hello from fake', tags: ['a', 'b'] });

      const gpt = new GPT();
      const response = await gpt.getStructuredResponse(
        [{ type: 'message', role: 'user', content: 'test input' }],
        'TestSchema',
        {
          type: 'object',
          properties: { message: { type: 'string' } },
        },
        [],
        150,
        1,
        {},
      );

      expect(response.content).toEqual({
        message: 'hello from fake',
        tags: ['a', 'b'],
      });
      expect(response.refused).toBe(false);
      expect(llm.structured.calls).toHaveLength(1);
      expect(llm.structured.calls[0].schemaName).toBe('TestSchema');
      expect(llm.structured.calls[0].input[0]).toMatchObject({
        type: 'message',
        role: 'user',
      });
    });

    it('throws a clear error when no response is queued', async () => {
      installFakeLlm();
      const provider = getStructuredProvider('openai');
      await expect(
        provider.structuredComplete({
          model: 'gpt-4o-mini',
          input: [],
          schemaName: 'X',
          schema: { type: 'object' },
        }),
      ).rejects.toThrow(/no response queued/);
    });

    it('replays canned responses in FIFO order', async () => {
      const llm = installFakeLlm();
      llm.structured.enqueueContent({ step: 1 });
      llm.structured.enqueueContent({ step: 2 });

      const provider = getStructuredProvider('openai');
      const a = await provider.structuredComplete({
        model: 'gpt-4o-mini',
        input: [],
        schemaName: 'X',
        schema: { type: 'object' },
      });
      const b = await provider.structuredComplete({
        model: 'gpt-4o-mini',
        input: [],
        schemaName: 'X',
        schema: { type: 'object' },
      });

      expect(a.content).toEqual({ step: 1 });
      expect(b.content).toEqual({ step: 2 });
      expect(llm.structured.calls).toHaveLength(2);
    });
  });

  describe('chat provider', () => {
    it('returns canned text for completeChat', async () => {
      const llm = installFakeLlm();
      llm.chat.enqueueText('canned reply');

      const provider = getChatProvider('openai');
      const result = await provider.completeChat({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(result.content).toBe('canned reply');
      expect(result.toolCalls).toEqual([]);
      expect(llm.chat.calls).toHaveLength(1);
      expect(llm.chat.calls[0].messages[0]).toMatchObject({
        role: 'user',
        content: 'hi',
      });
    });

    it('synthesizes a stream from a canned completion (text + tool calls + done)', async () => {
      const llm = installFakeLlm();
      llm.chat.enqueue({
        content: 'streamed text',
        toolCalls: [
          { name: 'lookupStudent', arguments: '{"id":"abc"}' },
        ],
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: 'STOP',
      });

      const provider = getChatProvider('openai');
      const chunks = [];
      for await (const chunk of provider.streamChat({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'do a tool call' }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([
        { type: 'text_delta', text: 'streamed text' },
        {
          type: 'tool_call_delta',
          index: 0,
          name: 'lookupStudent',
          arguments: '{"id":"abc"}',
        },
        { type: 'done', usage: { promptTokens: 10, completionTokens: 5 } },
      ]);
    });
  });

  describe('uninstall', () => {
    it('clears overrides so a subsequent get returns a real provider', async () => {
      installFakeLlm();
      const fake = getStructuredProvider('openai');
      uninstallFakeLlm();
      const real = getStructuredProvider('openai');
      expect(real).not.toBe(fake);
      expect(real.constructor.name).toContain('OpenAI');
    });
  });
});
