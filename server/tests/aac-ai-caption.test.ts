/**
 * What the AI actually said, out of a stream of `text` chunks.
 *
 * Every guard here corresponds to something that leaked to a real student, so
 * these are regression tests, not hypotheticals.
 */

import { describe, it, expect } from "@jest/globals";
import { applyAiTextChunk, captionFromChunks } from "@shared/aac/ai-caption";

describe("ordinary speech", () => {
  it("appends chunks into one caption", () => {
    expect(captionFromChunks(["Hello ", "there, ", "what shall we do?"])).toBe(
      "Hello there, what shall we do?",
    );
  });

  it("ignores empty and whitespace-only chunks", () => {
    expect(applyAiTextChunk("", "")).toEqual({ kind: "ignore", reason: "empty" });
    expect(applyAiTextChunk("", "   ")).toEqual({ kind: "ignore", reason: "empty" });
  });
});

describe("① ctrl-token scaffold", () => {
  it("discards everything accumulated AND the prefix, keeping only what follows", () => {
    // The scaffold is Google's internal recovery text; the audio was correct.
    const r = applyAiTextChunk("If you were silent, ", "say something.<ctrl95>Shall we play?");
    expect(r).toMatchObject({ kind: "restart", text: "Shall we play?" });
  });

  it("keeps only what follows the LAST token when several arrive", () => {
    const r = applyAiTextChunk("", "a<ctrl1>b<ctrl2>real speech");
    expect(r).toMatchObject({ kind: "restart", text: "real speech" });
    expect((r as { tokens: string[] }).tokens).toEqual(["<ctrl1>", "<ctrl2>"]);
  });

  it("restarts to EMPTY when the token ends the chunk", () => {
    expect(applyAiTextChunk("scaffold so far", "more scaffold<ctrl7>")).toMatchObject({
      kind: "restart",
      text: "",
    });
  });

  it("through the fold, the scaffold never survives", () => {
    expect(captionFromChunks(["If you were ", "silent<ctrl95>", "Hi!"])).toBe("Hi!");
  });
});

describe("② tag artifacts", () => {
  it("strips them", () => {
    expect(applyAiTextChunk("", "Hello<end_of_turn>")).toEqual({ kind: "append", text: "Hello" });
  });

  it("ignores a chunk that was nothing but artifacts", () => {
    expect(applyAiTextChunk("Hi", "<unk>")).toEqual({ kind: "ignore", reason: "artifact-only" });
  });
});

describe("③ private-note prefixes", () => {
  it("drops a turn that OPENS with the model's own reasoning", () => {
    for (const p of ["[private note] she looks tired", "[thinking] hmm", "[self-note] ask again"]) {
      expect(applyAiTextChunk("", p)).toEqual({ kind: "ignore", reason: "private-note" });
    }
  });

  it("does NOT truncate a bracket mid-caption — that is real speech", () => {
    expect(applyAiTextChunk("We could play ", "[note] this is fine")).toMatchObject({
      kind: "append",
    });
  });

  it("applies the guard again after a ctrl restart, since that starts fresh", () => {
    expect(applyAiTextChunk("earlier", "junk<ctrl3>[private note] mine")).toEqual({
      kind: "ignore",
      reason: "private-note",
    });
  });
});
