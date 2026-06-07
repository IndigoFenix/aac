// Unit tests for SentenceStreamer — the streaming-text → sentence flush
// helper used by the HTTP Speaker path. Pure logic, no LLM / IO.

import { SentenceStreamer } from "../services/dual-agent/sentence-streamer";

describe("SentenceStreamer", () => {
  test("emits a sentence on terminator followed by whitespace", () => {
    const s = new SentenceStreamer();
    expect(s.push("Hello world. ")).toEqual(["Hello world."]);
    expect(s.flush()).toBeNull();
  });

  test("emits a sentence on terminator at end of stream via flush", () => {
    const s = new SentenceStreamer();
    expect(s.push("Hello world.")).toEqual([]);
    expect(s.flush()).toBe("Hello world.");
  });

  test("emits multiple sentences in order", () => {
    const s = new SentenceStreamer();
    expect(s.push("First. Second! Third? ")).toEqual([
      "First.",
      "Second!",
      "Third?",
    ]);
    expect(s.flush()).toBeNull();
  });

  test("does not split inside a decimal number", () => {
    const s = new SentenceStreamer();
    expect(s.push("Pi is 3.14 roughly.")).toEqual([]);
    expect(s.push(" ")).toEqual(["Pi is 3.14 roughly."]);
  });

  // NOTE: abbreviations like "U.S.A." will split at the trailing period
  // since whitespace follows. Acceptable v1 tradeoff — TTS reads both
  // halves cleanly. Add lookahead heuristics here if it becomes a problem.

  test("includes trailing close quote with sentence", () => {
    const s = new SentenceStreamer();
    expect(s.push('She said "hello." ')).toEqual(['She said "hello."']);
  });

  test("handles adjacent terminators like ?!", () => {
    const s = new SentenceStreamer();
    const out = s.push("Really?! ");
    expect(out.join(" ").trim()).toContain("Really");
    expect(s.flush()).toBeNull();
  });

  test("accumulates deltas across multiple push calls", () => {
    const s = new SentenceStreamer();
    expect(s.push("Hel")).toEqual([]);
    expect(s.push("lo wor")).toEqual([]);
    expect(s.push("ld. ")).toEqual(["Hello world."]);
  });

  test("flush returns remaining partial after stream ends mid-sentence", () => {
    const s = new SentenceStreamer();
    expect(s.push("Done. ")).toEqual(["Done."]);
    expect(s.push("Then a partial")).toEqual([]);
    expect(s.flush()).toBe("Then a partial");
  });

  test("ignores empty deltas", () => {
    const s = new SentenceStreamer();
    expect(s.push("")).toEqual([]);
    expect(s.flush()).toBeNull();
  });

  test("CJK terminator flushes eagerly (no trailing whitespace required)", () => {
    const s = new SentenceStreamer();
    expect(s.push("你好。再见。")).toEqual(["你好。", "再见。"]);
    expect(s.flush()).toBeNull();
  });
});
