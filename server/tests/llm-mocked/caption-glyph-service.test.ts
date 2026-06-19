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

/** One structured GLYPH object, as the model now emits (see <glyph_syntax>). */
type GlyphItem = { sym?: string; gen?: string; mods?: string[]; fb?: { sym?: string; mods?: string[] } };

/** Queue a real-shaped response whose content is a JSON string. The model now
 *  returns a STRUCTURED glyph array per entry (+ optional `op`), not a string. */
function glyphResponse(
  glyphs: Array<{ index: number; glyph: GlyphItem[]; op?: string }>,
): GPTResponse {
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

  it('serializes structured glyph arrays back to canonical strings, sorted by index', async () => {
    // Model echoes them out of order — service should sort.
    llm.structured.enqueue(
      glyphResponse([
        { index: 1, glyph: [{ sym: '🐕', mods: ['big'] }] },
        { index: 0, glyph: [{ sym: 'i_me' }, { sym: 'want' }, { sym: '🍎' }] },
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

  it('serializes a `gen` GLYPH to a generate: string plus a fallback string', async () => {
    llm.structured.enqueue(
      glyphResponse([
        { index: 0, glyph: [{ gen: 'planet_mars', fb: { sym: '🌑', mods: ['color_red'] } }] },
      ]),
    );

    const results = await convertCaptionsToGlyphs([{ index: 0, text: 'Mars is the red planet' }]);

    expect(results).toEqual([
      { index: 0, glyph: 'generate:planet_mars', fallback: '🌑.color_red' },
    ]);
  });

  it('appends a sentence-level OPERATOR (#op) when `op` is present', async () => {
    llm.structured.enqueue(
      glyphResponse([{ index: 0, glyph: [{ sym: '😴' }], op: 'question' }]),
    );

    const results = await convertCaptionsToGlyphs([{ index: 0, text: 'are you sleepy?' }]);
    expect(results).toEqual([{ index: 0, glyph: '😴#question' }]);
  });

  it('passes the JSON glyph schema and instructions to the provider', async () => {
    llm.structured.enqueue(glyphResponse([{ index: 0, glyph: [{ sym: '😴' }] }]));
    await convertCaptionsToGlyphs([{ index: 0, text: 'sleepy' }], { language: 'en' });

    const req = llm.structured.calls[0];
    expect(req.schemaName).toBe('CaptionGlyphs');
    // The JSON grammar block + task framing should be in the instructions.
    expect(req.instructions).toContain('glyph SENTENCE');
    expect(req.instructions).toContain('<glyph_syntax>');
    // The glyph field must be a structured ARRAY of GLYPH objects.
    const schema = req.schema as any;
    expect(schema.properties.glyphs.items.properties.glyph.type).toBe('array');
    expect(schema.properties.glyphs.items.properties.glyph.items.properties).toHaveProperty('sym');
    expect(schema.properties.glyphs.items.properties.glyph.items.properties).toHaveProperty('gen');
    // The caption text should reach the model in the user input.
    expect(JSON.stringify(req.input)).toContain('sleepy');
  });

  it('drops omitted/empty entries without chasing them with a retry', async () => {
    llm.structured.enqueue(
      glyphResponse([
        { index: 0, glyph: [{ sym: '😴' }] },
        { index: 1.5 as any, glyph: [{ sym: '🍎' }] }, // non-integer index → dropped at parse
        { index: 2, glyph: [] }, // empty array → dropped, no retry
        { index: 3 } as any, // missing glyph → dropped, no retry
      ]),
    );

    const captions: CaptionGlyphInput[] = [0, 1, 2, 3].map((i) => ({ index: i, text: `line ${i}` }));
    const results = await convertCaptionsToGlyphs(captions);

    // Only the clean line survives; omissions/empties drop silently (1 call, no retry).
    expect(llm.structured.calls).toHaveLength(1);
    expect(results).toEqual([{ index: 0, glyph: '😴' }]);
  });

  it('accepts already-parsed object content (forward-compat)', async () => {
    llm.structured.enqueue({
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      content: { glyphs: [{ index: 0, glyph: [{ sym: '🎵' }] }] } as any,
      toolCalls: [],
      refused: false,
    });

    const results = await convertCaptionsToGlyphs([{ index: 0, text: '[music]' }]);
    expect(results).toEqual([{ index: 0, glyph: '🎵' }]);
  });

  it('retries lines whose SYMBOLs are non-renderable, then keeps the corrected glyph', async () => {
    // Attempt 1: line 0 is clean, line 1 uses the bare word "miss" (renders ❓).
    llm.structured.enqueue(
      glyphResponse([
        { index: 0, glyph: [{ sym: '🍎' }] },
        { index: 1, glyph: [{ sym: 'miss' }, { sym: 'they' }] },
      ]),
    );
    // Attempt 2: ONLY the bad line is re-asked; model corrects "miss" → 😢.
    llm.structured.enqueue(glyphResponse([{ index: 1, glyph: [{ sym: '😢' }, { sym: 'they' }] }]));

    const results = await convertCaptionsToGlyphs([
      { index: 0, text: 'apple' },
      { index: 1, text: 'I miss them' },
    ]);

    expect(llm.structured.calls).toHaveLength(2);
    // The retry carried ONLY the offending line.
    const retryText = JSON.stringify(llm.structured.calls[1].input);
    expect(retryText).toContain('I miss them');
    expect(retryText).not.toContain('"apple"');
    expect(results).toEqual([
      { index: 0, glyph: '🍎' },
      { index: 1, glyph: '😢+they' },
    ]);
  });

  it('repairs (strips) still-unrenderable SYMBOLs after retries are exhausted', async () => {
    // Both attempts keep the bad "miss" head; "🍎" is fine. After the retry
    // budget, repair drops "miss" rather than letting it render as ❓.
    const bad = glyphResponse([{ index: 0, glyph: [{ sym: 'miss' }, { sym: '🍎' }] }]);
    llm.structured.enqueue(bad);
    llm.structured.enqueue(bad);

    const results = await convertCaptionsToGlyphs([{ index: 0, text: 'I miss apples' }]);

    expect(results).toEqual([{ index: 0, glyph: '🍎' }]);
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
    // A parse failure yields no entries to retry — single call, no chase.
    expect(llm.structured.calls).toHaveLength(1);
  });

  it('splits into multiple batches and merges results (>25 lines)', async () => {
    const captions: CaptionGlyphInput[] = Array.from({ length: 30 }, (_, i) => ({
      index: i,
      text: `line ${i}`,
    }));

    // BATCH_SIZE is 25 → two batches (25 + 5). All glyphs are clean emoji so no
    // retry fires; each batch is a single call.
    llm.structured.enqueue(
      glyphResponse(Array.from({ length: 25 }, (_, i) => ({ index: i, glyph: [{ sym: '😴' }] }))),
    );
    llm.structured.enqueue(
      glyphResponse(Array.from({ length: 5 }, (_, i) => ({ index: 25 + i, glyph: [{ sym: '😴' }] }))),
    );

    const results = await convertCaptionsToGlyphs(captions);

    expect(llm.structured.calls).toHaveLength(2);
    expect(results).toHaveLength(30);
    expect(results[0]).toEqual({ index: 0, glyph: '😴' });
    expect(results[29]).toEqual({ index: 29, glyph: '😴' });
    // Each batch should carry at most BATCH_SIZE lines.
    const firstBatchText = JSON.stringify(llm.structured.calls[0].input);
    expect(firstBatchText).toContain('line 0');
    expect(firstBatchText).not.toContain('line 29');
  });
});
