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
        { startMs: 3000, endMs: 2000, idea: 'inverted' },     // end<=start → start+1
        { startMs: 1000, endMs: 1500, idea: '' },              // empty → dropped
      ]),
    );
    const r = await extractCaptionIdeas(TRANSCRIPT);
    expect(r).toEqual([
      { startMs: 0, endMs: 8000, text: 'spills over' },
      { startMs: 3000, endMs: 3001, text: 'inverted' },
    ]);
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
