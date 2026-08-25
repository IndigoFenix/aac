/**
 * 429 handling on the Board Manager, and what a 429 must NOT do to the cache.
 *
 * Two policies live here, and they were both wrong for the failure we actually
 * had on Vertex:
 *
 * 1. WE DID NOT RETRY AT ALL. That was correct on 2026-08-20, when the failure
 *    was the AI Studio key's DAILY cap — the quota was gone for the day and an
 *    immediate retry only doubled load against it. Vertex Gemini runs on
 *    dynamic shared quota instead: no per-project ceiling, and a 429 means the
 *    shared pool was momentarily tight. Capacity moves second to second, so
 *    backoff-and-retry is the documented remedy. Same status code, opposite
 *    correct response — the DELAY is what makes one policy serve both.
 *
 * 2. WE DELETED THE PROMPT CACHE ON ANY FAILURE, INCLUDING A 429. That made a
 *    rate limit self-feeding: the 429 dropped the cache, the next turn re-created
 *    it at the full input rate for the whole ~13.5k-token prompt, and the extra
 *    throughput made the next 429 likelier. A rate limit says nothing about
 *    whether the cache handle is still valid.
 */

import { describe, test, expect } from "@jest/globals";
import {
  classifyProviderFailure,
  rateLimitBackoffMs,
  RATE_LIMIT_RETRIES,
  RATE_LIMIT_BASE_DELAY_MS,
} from "../services/dual-agent/board-manager-agent";

const VERTEX_429 =
  '{"error":{"code":429,"message":"Resource exhausted. Please try again later. ' +
  'Please refer to https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429 ' +
  'for more details.","status":"RESOURCE_EXHAUSTED"}}';

describe("classifying the failure", () => {
  test("the real Vertex 429 body is a rate limit", () => {
    expect(classifyProviderFailure(VERTEX_429)).toBe("RATE_LIMITED");
  });

  test("a malformed response is NOT a rate limit — it is worth retrying as-is", () => {
    expect(classifyProviderFailure("MALFORMED_FUNCTION_CALL")).toBe("ERROR");
    expect(classifyProviderFailure("no tool calls returned")).toBe("ERROR");
  });

  test("the word `quota` is bounded, so `quotation` is not a rate limit", () => {
    expect(classifyProviderFailure("bad quotation marks in the response")).toBe("ERROR");
  });
});

describe("backoff", () => {
  test("grows exponentially with the attempt", () => {
    // random() pinned to 1 gives the top of each window.
    const one = () => 1;
    expect(rateLimitBackoffMs(0, one)).toBe(RATE_LIMIT_BASE_DELAY_MS);
    expect(rateLimitBackoffMs(1, one)).toBe(RATE_LIMIT_BASE_DELAY_MS * 2);
    expect(rateLimitBackoffMs(2, one)).toBe(RATE_LIMIT_BASE_DELAY_MS * 4);
  });

  test("uses FULL jitter — the whole window, not a fixed delay plus noise", () => {
    // Every session that hits a tight pool backs off at once. Without jitter
    // spanning the whole window they retry in lockstep and rebuild the spike
    // they are backing off from.
    expect(rateLimitBackoffMs(0, () => 0)).toBe(0);
    expect(rateLimitBackoffMs(3, () => 0)).toBe(0);
    expect(rateLimitBackoffMs(3, () => 1)).toBe(RATE_LIMIT_BASE_DELAY_MS * 8);
  });

  test("never returns a negative or fractional delay", () => {
    for (let attempt = 0; attempt <= 4; attempt++) {
      for (const r of [0, 0.13, 0.5, 0.99, 1]) {
        const ms = rateLimitBackoffMs(attempt, () => r);
        expect(Number.isInteger(ms)).toBe(true);
        expect(ms).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("is bounded — a retry storm cannot stall a board for long", () => {
    // A child is waiting. Worst case across every attempt must stay well under
    // the point where the board feels broken rather than slow.
    //
    // Sum attempts 0..RATE_LIMIT_RETRIES-1, NOT inclusive: completeWithRateLimitRetry
    // throws at `attempt === RATE_LIMIT_RETRIES` BEFORE sleeping, so the final
    // attempt never contributes a delay. The inclusive loop this replaces
    // overcounted by the largest term — the one that dominates an exponential —
    // so it was policing a budget the code could not actually spend.
    let worst = 0;
    for (let attempt = 0; attempt < RATE_LIMIT_RETRIES; attempt++) {
      worst += rateLimitBackoffMs(attempt, () => 1);
    }
    expect(worst).toBeLessThanOrEqual(5000);
  });

  test("retries a bounded number of times", () => {
    // Unbounded retries against a genuinely exhausted pool is the 2026-08-20
    // failure wearing a different hat.
    expect(RATE_LIMIT_RETRIES).toBeGreaterThan(0);
    expect(RATE_LIMIT_RETRIES).toBeLessThanOrEqual(3);
  });
});
