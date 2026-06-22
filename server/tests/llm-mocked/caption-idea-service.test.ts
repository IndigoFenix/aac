// Coverage for captionIdeaService.extractCaptionIdeas — the first pass that
// re-segments a transcript into timed idea units. Uses the fake structured
// provider (no real LLM).

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { installFakeLlm, uninstallFakeLlm, type FakeLlmHandles } from '../helpers/llm-mock.js';
import { extractCaptionIdeas, type TranscriptLine } from '../../services/captionIdeaService.js';
import type { GPTResponse } from '../../services/chat/gpt.js';

function ideasResponse(ideas: Array<{ startMs: number; endMs: number; idea: string }>): GPTResponse {
  return {
    promptTokens: 10,
    completionTokens: 5,
    cachedTokens: 0,
    content: JSON.stringify({ ideas }),
    toolCalls: [],
    refused: false,
  };
}

const TRANSCRIPT: TranscriptLine[] = [
  { startMs: 0, endMs: 2000, text: 'Hello everyone and welcome' },
  { startMs: 2000, endMs: 5000, text: 'today we are going to bake a cake' },
  { startMs: 5000, endMs: 8000, text: 'first you need flour and eggs' },
];

describe('extractCaptionIdeas', () => {
  let llm: FakeLlmHandles;
  beforeEach(() => { llm = installFakeLlm(); });
  afterEach(() => { uninstallFakeLlm(); });

  it('returns [] without calling the LLM for empty input', async () => {
    const r = await extractCaptionIdeas([]);
    expect(r).toEqual([]);
    expect(llm.structured.calls).toHaveLength(0);
  });

  it('returns ordered idea segments (text = idea)', async () => {
    llm.structured.enqueue(
      ideasResponse([
        { startMs: 2000, endMs: 5000, idea: 'We will bake a cake' },
        { startMs: 0, endMs: 2000, idea: 'Welcome' },
      ]),
    );
    const r = await extractCaptionIdeas(TRANSCRIPT, { language: 'en' });
    expect(r).toEqual([
      { startMs: 0, endMs: 2000, text: 'Welcome' },
      { startMs: 2000, endMs: 5000, text: 'We will bake a cake' },
    ]);
  });

  it('passes the transcript + ideas schema to the provider', async () => {
    llm.structured.enqueue(ideasResponse([{ startMs: 0, endMs: 2000, idea: 'hi' }]));
    await extractCaptionIdeas(TRANSCRIPT);
    const req = llm.structured.calls[0];
    expect(req.schemaName).toBe('CaptionIdeas');
    expect(req.instructions).toContain('FIRST pass');
    expect(JSON.stringify(req.input)).toContain('bake a cake');
  });

  it('threads customInstructions into the prompt', async () => {
    llm.structured.enqueue(ideasResponse([{ startMs: 0, endMs: 2000, idea: 'hi' }]));
    await extractCaptionIdeas(TRANSCRIPT, { customInstructions: 'Keep it very simple for a 4-year-old' });
    expect(llm.structured.calls[0].instructions).toContain('4-year-old');
  });

  it('clamps timings to the transcript span and drops malformed entries', async () => {
    llm.structured.enqueue(
      ideasResponse([
        { startMs: -500, endMs: 99999, idea: 'spills over' }, // clamp to [0, 8000]
        { startMs: 3000, endMs: 2000, idea: 'inverted' },     // end<=start → start+1, then pushed past the prev unit (non-overlap)
        { startMs: 1000, endMs: 1500, idea: '' },              // empty → dropped
      ]),
    );
    const r = await extractCaptionIdeas(TRANSCRIPT);
    // "spills over" clamps to the whole span; "inverted" then can't overlap it,
    // so its start is pushed to the previous unit's end.
    expect(r).toEqual([
      { startMs: 0, endMs: 8000, text: 'spills over' },
      { startMs: 8000, endMs: 8001, text: 'inverted' },
    ]);
  });

  it('keeps consecutive sub-line splits as-is but separates overlaps', async () => {
    // One source line (2000–5000) split into SVO chunks. Consecutive sub-ranges
    // pass through untouched; an overlapping pair is clamped to be non-overlapping.
    llm.structured.enqueue(
      ideasResponse([
        { startMs: 2000, endMs: 3500, idea: 'we will bake' },   // consecutive, fine
        { startMs: 3500, endMs: 5000, idea: 'a chocolate cake' }, // consecutive, fine
        { startMs: 4800, endMs: 6000, idea: 'overlaps prev' },   // start < 5000 → pushed to 5000
      ]),
    );
    const r = await extractCaptionIdeas(TRANSCRIPT);
    expect(r).toEqual([
      { startMs: 2000, endMs: 3500, text: 'we will bake' },
      { startMs: 3500, endMs: 5000, text: 'a chocolate cake' },
      { startMs: 5000, endMs: 6000, text: 'overlaps prev' },
    ]);
  });

  it('uses word-index mode when lines carry word timings, computing exact ms from the words', async () => {
    const wordLine: TranscriptLine = {
      startMs: 0,
      endMs: 2000,
      text: 'Mom drove the car',
      words: [
        { text: 'Mom', startMs: 0, endMs: 400 },
        { text: 'drove', startMs: 400, endMs: 900 },
        { text: 'the', startMs: 900, endMs: 1100 },
        { text: 'car', startMs: 1100, endMs: 2000 },
      ],
    };
    // Model returns WORD INDEX ranges; the service maps them to exact word times.
    llm.structured.enqueue({
      promptTokens: 10, completionTokens: 5, cachedTokens: 0, toolCalls: [], refused: false,
      content: JSON.stringify({
        ideas: [
          { startWord: 0, endWord: 1, idea: 'Mom drove' },
          { startWord: 2, endWord: 3, idea: 'the car' },
        ],
      }),
    });

    const r = await extractCaptionIdeas([wordLine], { language: 'en' });

    // Exact boundaries from the words: [w0.start, w1.end] and [w2.start, w3.end].
    expect(r).toEqual([
      { startMs: 0, endMs: 900, text: 'Mom drove' },
      { startMs: 900, endMs: 2000, text: 'the car' },
    ]);
    // Word-mode prompt/input: numbered words + the startWord schema field.
    const req = llm.structured.calls[0];
    expect(JSON.stringify(req.input)).toContain('[0]Mom');
    expect((req.schema as any).properties.ideas.items.properties).toHaveProperty('startWord');
  });

  it('returns [] (not throw) on invalid JSON content', async () => {
    llm.structured.enqueue({
      promptTokens: 0, completionTokens: 0, cachedTokens: 0,
      content: 'not json', toolCalls: [], refused: false,
    });
    const r = await extractCaptionIdeas(TRANSCRIPT);
    expect(r).toEqual([]);
  });
});
