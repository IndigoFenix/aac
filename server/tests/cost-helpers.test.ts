/**
 * Tests for server/services/chat/cost-helpers.ts — credit accounting.
 *
 * Focus: the Anthropic prompt-cache accounting fix. Previously
 * `cache_creation_input_tokens` (cache writes, billed by Anthropic at 1.25x)
 * were dropped entirely and `input_tokens` had cache reads wrongly subtracted —
 * causing a ~13x under-count on cached Claude turns. These tests pin the
 * provider-aware math so it can't silently regress.
 */

import { describe, it, expect } from "@jest/globals";
import {
  creditsForModelUsage,
  creditsForLiveUsage,
  creditsForLiveUsageByModality,
  type LiveUsageBreakdown,
} from "../services/chat/cost-helpers.js";

// Catalog rates (shared/llm-options.ts) used for the expectations below:
//   claude-haiku: in $0.80 / out $4.00 per 1M
//   gpt-4o:       in $2.50 / out $10.00 per 1M
const HAIKU_IN = 0.8 / 1e6, HAIKU_OUT = 4.0 / 1e6;
const GPT4O_IN = 2.5 / 1e6, GPT4O_OUT = 10.0 / 1e6;

describe("creditsForModelUsage — Claude cache accounting", () => {
  it("bills cache writes at 1.25x on TOP of input_tokens (not dropped)", () => {
    // input_tokens EXCLUDES cache writes for Anthropic.
    const cost = creditsForModelUsage("claude", "claude-haiku", 1000, 200, 0, 20000);
    const expected =
      1000 * HAIKU_IN +              // fresh input @ 1x
      20000 * HAIKU_IN * 1.25 +      // cache creation @ 1.25x
      200 * HAIKU_OUT;              // output
    expect(cost).toBeCloseTo(expected, 10);
  });

  it("bills cache reads at 0.1x and does NOT subtract them from input_tokens", () => {
    // Anthropic input_tokens already excludes cache reads — no double-subtract.
    const cost = creditsForModelUsage("claude", "claude-haiku", 500, 100, 20000, 0);
    const expected =
      500 * HAIKU_IN +              // fresh input @ 1x (full, not 500-20000)
      20000 * HAIKU_IN * 0.1 +      // cache read @ 0.1x
      100 * HAIKU_OUT;
    expect(cost).toBeCloseTo(expected, 10);
  });

  it("reproduces the real logged usage at ~13x the old (buggy) figure", () => {
    // From claude-cache-debug.log: input 1032, cache_creation 21069, read 0, out 229.
    const fixed = creditsForModelUsage("claude", "claude-haiku", 1032, 229, 0, 21069);
    const oldBuggy = 1032 * HAIKU_IN + 229 * HAIKU_OUT; // cache_creation ignored
    expect(fixed).toBeGreaterThan(oldBuggy * 10);
    expect(fixed).toBeCloseTo(
      1032 * HAIKU_IN + 21069 * HAIKU_IN * 1.25 + 229 * HAIKU_OUT,
      10,
    );
  });
});

describe("creditsForModelUsage — OpenAI cache accounting", () => {
  it("subtracts cached reads from prompt_tokens and bills them at 0.5x", () => {
    // OpenAI prompt_tokens INCLUDES cached reads.
    const cost = creditsForModelUsage("openai", "gpt-4o", 1000, 200, 400, 0);
    const expected =
      (1000 - 400) * GPT4O_IN +     // non-cached input @ 1x
      400 * GPT4O_IN * 0.5 +        // cached read @ 0.5x
      200 * GPT4O_OUT;
    expect(cost).toBeCloseTo(expected, 10);
  });
});

describe("creditsForModelUsage — unknown model fallback", () => {
  it("falls back to Claude-Haiku rates (not gpt-4o-mini) for an unrecognized model", () => {
    // Unknown id → fallback. Expect Haiku ($0.80/$4.00), NOT the old $0.15/$0.60.
    const cost = creditsForModelUsage("claude", "claude-haiku-4-5-20251001", 1000, 100, 0, 0);
    expect(cost).toBeCloseTo(1000 * HAIKU_IN + 100 * HAIKU_OUT, 10);
  });
});

describe("creditsForLiveUsageByModality — Phase 0 cost measurement", () => {
  // gemini-live-2.5-flash-native-audio catalog rates (shared/llm-options.ts):
  //   text in $0.50, text out $2.00, audio/non-text in $3.00, audio out $12.00 per 1M.
  const LIVE_MODEL = "gemini-live-2.5-flash-native-audio";
  const T_IN = 0.5 / 1e6, T_OUT = 2.0 / 1e6, NT_IN = 3.0 / 1e6, A_OUT = 12.0 / 1e6;

  const usage: LiveUsageBreakdown = {
    textInputTokens: 5000,      // includes 2000 cached (Gemini reports inclusive)
    cachedInputTokens: 2000,
    nonTextInputTokens: 8000,   // audio + image frames — the re-billing we target
    textOutputTokens: 300,      // Observer text output
    audioOutputTokens: 0,       // Observer is TEXT-only; audio out is Speaker's
  };

  it("splits credits per modality at the right rates", () => {
    const s = creditsForLiveUsageByModality("gemini", LIVE_MODEL, usage);
    expect(s.textIn).toBeCloseTo((5000 - 2000) * T_IN, 12);     // fresh text only
    expect(s.cachedIn).toBeCloseTo(2000 * T_IN * 0.5, 12);      // cached @ 0.5x (gemini)
    expect(s.nonTextIn).toBeCloseTo(8000 * NT_IN, 12);          // audio/image @ audio rate
    expect(s.textOut).toBeCloseTo(300 * T_OUT, 12);
    expect(s.audioOut).toBeCloseTo(0, 12);
  });

  it("non-text input dominates a typical Observer turn (the core thesis)", () => {
    const s = creditsForLiveUsageByModality("gemini", LIVE_MODEL, usage);
    const total = s.textIn + s.cachedIn + s.nonTextIn + s.textOut + s.audioOut;
    // nonTextIn (audio+image re-billed every turn) is the largest bucket.
    expect(s.nonTextIn).toBeGreaterThan(s.textIn + s.cachedIn + s.textOut + s.audioOut);
    expect(s.nonTextIn / total).toBeGreaterThan(0.6);
  });

  it("the per-modality split sums to creditsForLiveUsage (ledgers can't drift)", () => {
    const s = creditsForLiveUsageByModality("gemini", LIVE_MODEL, usage);
    const sum = s.textIn + s.cachedIn + s.nonTextIn + s.textOut + s.audioOut;
    expect(sum).toBeCloseTo(creditsForLiveUsage("gemini", LIVE_MODEL, usage), 12);
  });

  it("audio output bills at the audio rate (Speaker native-audio turn)", () => {
    const speakerTurn: LiveUsageBreakdown = {
      textInputTokens: 1000, nonTextInputTokens: 0,
      textOutputTokens: 0, audioOutputTokens: 500,
    };
    const s = creditsForLiveUsageByModality("gemini", LIVE_MODEL, speakerTurn);
    expect(s.audioOut).toBeCloseTo(500 * A_OUT, 12);
    expect(s.textIn).toBeCloseTo(1000 * T_IN, 12);
  });
});
