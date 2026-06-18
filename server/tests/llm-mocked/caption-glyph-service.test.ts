/**
 * Coverage for captionGlyphService.convertCaptionsToGlyphs — the Video Caption
 * Studio text→glyph step.
 *
 * Uses the fake structured provider (helpers/llm-mock.ts) so no real LLM is hit.
 * The fake records every request and replays canned GPTResponses in FIFO order,
 * which lets us assert batching behavior and how the service maps/validates the
 * model's output back onto caller indices. Mirrors session-summary.test.ts in
 * queuing JSON-STRING content (the real provider shape).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { installFakeLlm, uninstallFakeLlm, type FakeLlmHandles } from '../helpers/llm-mock.js';
import {
  convertCaptionsToGlyphs,
  type CaptionGlyphInput,
} from '../../services/captionGlyphService.js';
import type { GPTResponse } from '../../services/chat/gpt.js';

/** Queue a real-shaped response whose content is a JSON string. */
function glyphResponse(glyphs: Array<{ index: number; glyph: string }>): GPTResponse {
  return {
    promptTokens: 10,
    completionTokens: 5,
    cachedTokens: 0,
    content: JSON.stringify({ glyphs }),
    toolCalls: [],
    refused: false,
  };
}

describe('convertCaptionsToGlyphs', () => {
  let llm: FakeLlmHandles;

  beforeEach(() => {
    llm = installFakeLlm();
  });

  afterEach(() => {
    uninstallFakeLlm();
  });

  it('returns [] without calling the LLM for empty input', async () => {
    const results = await convertCaptionsToGlyphs([]);
    expect(results).toEqual([]);
    expect(llm.structured.calls).toHaveLength(0);
  });

  it('maps glyphs back to caller indices and sorts by index', async () => {
    // Model echoes them out of order — service should sort.
    llm.structured.enqueue(
      glyphResponse([
        { index: 1, glyph: '🐕.big' },
        { index: 0, glyph: 'i_me+want+🍎' },
      ]),
    );

    const captions: CaptionGlyphInput[] = [
      { index: 0, text: 'I want an apple' },
      { index: 1, text: 'a big dog' },
    ];
    const results = await convertCaptionsToGlyphs(captions);

    expect(llm.structured.calls).toHaveLength(1);
    expect(results).toEqual([
      { index: 0, glyph: 'i_me+want+🍎' },
      { index: 1, glyph: '🐕.big' },
    ]);
  });

  it('passes the conversion schema and instructions to the provider', async () => {
    llm.structured.enqueue(glyphResponse([{ index: 0, glyph: '😴' }]));
    await convertCaptionsToGlyphs([{ index: 0, text: 'sleepy' }], { language: 'en' });

    const req = llm.structured.calls[0];
    expect(req.schemaName).toBe('CaptionGlyphs');
    // The grammar block + task framing should be in the instructions.
    expect(req.instructions).toContain('glyph SENTENCE');
    expect(req.instructions).toContain('<grammar>');
    // The caption text should reach the model in the user input.
    expect(JSON.stringify(req.input)).toContain('sleepy');
  });

  it('drops malformed entries (bad index, missing/empty glyph)', async () => {
    llm.structured.enqueue(
      glyphResponse([
        { index: 0, glyph: 'good' },
        { index: 1.5 as any, glyph: 'noninteger' }, // non-integer index → dropped
        { index: 2, glyph: '   ' }, // blank glyph → dropped
        { index: 3 } as any, // missing glyph → dropped
      ]),
    );

    const captions: CaptionGlyphInput[] = [0, 1, 2, 3].map((i) => ({ index: i, text: `line ${i}` }));
    const results = await convertCaptionsToGlyphs(captions);

    expect(results).toEqual([{ index: 0, glyph: 'good' }]);
  });

  it('accepts already-parsed object content (forward-compat)', async () => {
    llm.structured.enqueue({
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      content: { glyphs: [{ index: 0, glyph: '🎵' }] } as any,
      toolCalls: [],
      refused: false,
    });

    const results = await convertCaptionsToGlyphs([{ index: 0, text: '[music]' }]);
    expect(results).toEqual([{ index: 0, glyph: '🎵' }]);
  });

  it('returns [] (not throw) when content is not valid JSON', async () => {
    llm.structured.enqueue({
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      content: 'not json at all',
      toolCalls: [],
      refused: false,
    });

    const results = await convertCaptionsToGlyphs([{ index: 0, text: 'hello' }]);
    expect(results).toEqual([]);
  });

  it('splits into multiple batches and merges results (>25 lines)', async () => {
    const captions: CaptionGlyphInput[] = Array.from({ length: 30 }, (_, i) => ({
      index: i,
      text: `line ${i}`,
    }));

    // BATCH_SIZE is 25 → two batches (25 + 5). Echo each batch's own indices.
    llm.structured.enqueue(
      glyphResponse(Array.from({ length: 25 }, (_, i) => ({ index: i, glyph: `g${i}` }))),
    );
    llm.structured.enqueue(
      glyphResponse(Array.from({ length: 5 }, (_, i) => ({ index: 25 + i, glyph: `g${25 + i}` }))),
    );

    const results = await convertCaptionsToGlyphs(captions);

    expect(llm.structured.calls).toHaveLength(2);
    expect(results).toHaveLength(30);
    expect(results[0]).toEqual({ index: 0, glyph: 'g0' });
    expect(results[29]).toEqual({ index: 29, glyph: 'g29' });
    // Each batch should carry at most BATCH_SIZE lines.
    const firstBatchText = JSON.stringify(llm.structured.calls[0].input);
    expect(firstBatchText).toContain('line 0');
    expect(firstBatchText).not.toContain('line 29');
  });
});
