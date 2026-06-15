// Verifies the Speaker's "leaked leading meta-tag" guard.
//
// The Speaker SEES every incoming statement / context injection tagged with a
// bracketed wire-format marker: "[USER to YOU] ...", "[MODE companion]",
// "[CONTEXT ...]", and the echo of its own speech "[YOU to USER] ...". The
// model occasionally REPRODUCES one of those tags at the very start of its
// spoken reply. It usually isn't voiced at first, but the tag leaks into the
// transcript that gets echoed back into the Speaker's own context + Observer +
// the conversation log — which teaches the model the prefix is expected, so
// the behavior compounds over a session (same self-reinforcing shape as the
// thought-leak loop).
//
// The fix strips any run of LEADING bracket tags from the utterance before it
// reaches the child (subtitle / TTS) or the transcript, and signals the
// Coordinator (via SpeechEndEvent.strippedLeadingTag) to inject a one-shot
// corrective. Mid-sentence brackets and ordinary speech are never touched.

import { jest } from "@jest/globals";

jest.mock("../services/dual-agent/agent-flow-logger", () => ({
  flowInput: () => {},
  flowOutput: () => {},
  flowTool: () => {},
  flowNote: () => {},
}));

// GeminiLiveProvider pulls in import.meta.url machinery that breaks under
// jest's CommonJS transform. We drive the handlers directly, so stub it.
jest.mock("../services/dual-agent/gemini-live-provider", () => ({
  GeminiLiveProvider: class {},
}));

import {
  hasLeadingTag,
  stripLeadingTags,
  extractLeadingTags,
  LeadingTagStripper,
} from "../services/dual-agent/leading-tag-stripper";
import {
  SpeakerAgent,
  type SpeakerCallbacks,
  type SpeakerOutputEvent,
} from "../services/dual-agent/speaker-agent";

// ---- Pure detection / stripping helpers --------------------------------

describe("hasLeadingTag / stripLeadingTags", () => {
  test("detects + strips a single leading tag", () => {
    expect(hasLeadingTag("[USER to YOU] Hi there")).toBe(true);
    expect(stripLeadingTags("[USER to YOU] Hi there")).toBe("Hi there");
  });
  test("strips a run of consecutive leading tags", () => {
    expect(stripLeadingTags("[MODE companion] [CONTEXT lunch] Want a snack?")).toBe(
      "Want a snack?",
    );
  });
  test("strips the model's own echoed reply tag", () => {
    expect(stripLeadingTags('[YOU to USER] "Good morning!"')).toBe('"Good morning!"');
  });
  test("handles leading whitespace before the tag", () => {
    expect(stripLeadingTags("  [USER to YOU]  Hello")).toBe("Hello");
  });

  // False-positive safety — only LEADING brackets are stripped.
  test("does NOT strip brackets that appear mid-sentence", () => {
    expect(hasLeadingTag("I love the band [unknown] a lot")).toBe(false);
    expect(stripLeadingTags("I love the band [unknown] a lot")).toBe(
      "I love the band [unknown] a lot",
    );
  });
  test("leaves ordinary speech untouched", () => {
    expect(hasLeadingTag("Hi there, how are you?")).toBe(false);
    expect(stripLeadingTags("Hi there, how are you?")).toBe("Hi there, how are you?");
  });
  test("leaves Hebrew conversational speech untouched", () => {
    const s = "איזה כיף לשמוע שאת שמחה! מה עושה אותך שמחה?";
    expect(hasLeadingTag(s)).toBe(false);
    expect(stripLeadingTags(s)).toBe(s);
  });
  test("extractLeadingTags returns the removed prefix (trimmed)", () => {
    expect(extractLeadingTags("[USER to YOU] Hi")).toBe("[USER to YOU]");
    expect(extractLeadingTags("Hi")).toBe("");
  });
});

describe("LeadingTagStripper (incremental)", () => {
  test("withholds output while a leading bracket is open, then strips it", () => {
    const s = new LeadingTagStripper();
    // Tag arrives split across deltas — nothing emitted until it closes.
    expect(s.push("[USER ")).toBe("");
    expect(s.push("to YOU")).toBe("");
    expect(s.push("] Hi ")).toBe("Hi ");
    expect(s.push("there")).toBe("there");
    expect(s.stripped).toBe(true);
    expect(s.strippedTag).toBe("[USER to YOU]");
    expect(s.cleaned).toBe("Hi there");
  });

  test("passes ordinary text straight through with no stripping", () => {
    const s = new LeadingTagStripper();
    expect(s.push("Hello ")).toBe("Hello ");
    expect(s.push("world")).toBe("world");
    expect(s.stripped).toBe(false);
  });

  test("flush releases a never-closed leading bracket as ordinary text", () => {
    const s = new LeadingTagStripper();
    expect(s.push("[oops no close")).toBe("");
    expect(s.flush()).toBe("[oops no close");
    expect(s.stripped).toBe(false);
  });
});

// ---- SpeakerAgent turn behavior (white-box, native-audio) --------------

type Captured = {
  events: SpeakerOutputEvent[];
  deltas: string[];
};

function makeSpeaker(): { agent: SpeakerAgent; cap: Captured } {
  const cap: Captured = { events: [], deltas: [] };
  const callbacks: SpeakerCallbacks = {
    onEvent: (e) => cap.events.push(e),
    onAudioChunk: () => {},
    onTranscriptionDelta: (t) => { cap.deltas.push(t); },
    onError: () => {},
  };
  const agent = new SpeakerAgent("gemini", callbacks);
  (agent as any).useDirectAudio = true;
  (agent as any).resetTurnAccumulators();
  return { agent, cap };
}

const audioChunk = { mimeType: "audio/pcm", data: "AAAA" };

describe("SpeakerAgent — native-audio leading-tag stripping", () => {
  test("leaked tag is stripped from subtitle deltas AND the speech_end transcript, and flagged", () => {
    const { agent, cap } = makeSpeaker();
    const a = agent as any;

    a.handleAudioData(audioChunk);
    a.handleOutputTranscription("[USER to YOU] ");
    a.handleOutputTranscription("Good morning!");
    a.handleOutputTranscriptionFinished();
    a.handleTurnComplete("STOP");

    // The tag never reached the client subtitle.
    expect(cap.deltas.join("")).toBe("Good morning!");

    const finalized = cap.events.find((e) => e.type === "speech_text_finalized");
    const ended = cap.events.find((e) => e.type === "speech_end");
    expect((finalized as any).transcript).toBe("Good morning!");
    expect((ended as any).transcript).toBe("Good morning!");
    // The flag carries the removed prefix so the Coordinator injects the
    // one-shot corrective.
    expect((ended as any).strippedLeadingTag).toBe("[USER to YOU]");
  });

  test("tag split across deltas is still held back and stripped", () => {
    const { agent, cap } = makeSpeaker();
    const a = agent as any;

    a.handleAudioData(audioChunk);
    a.handleOutputTranscription("[MODE ");
    a.handleOutputTranscription("companion] ");
    a.handleOutputTranscription("Hey!");
    a.handleTurnComplete("STOP");

    expect(cap.deltas.join("")).toBe("Hey!");
    const ended = cap.events.find((e) => e.type === "speech_end");
    expect((ended as any).transcript).toBe("Hey!");
    expect((ended as any).strippedLeadingTag).toBe("[MODE companion]");
  });

  test("normal turn is unaffected: no stripping, no flag", () => {
    const { agent, cap } = makeSpeaker();
    const a = agent as any;

    a.handleAudioData(audioChunk);
    a.handleOutputTranscription("איזה כיף! ");
    a.handleOutputTranscription("מה עוד בא לך?");
    a.handleOutputTranscriptionFinished();
    a.handleTurnComplete("STOP");

    expect(cap.deltas).toEqual(["איזה כיף! ", "מה עוד בא לך?"]);
    const ended = cap.events.find((e) => e.type === "speech_end");
    expect((ended as any).transcript).toBe("איזה כיף! מה עוד בא לך?");
    expect((ended as any).strippedLeadingTag).toBeUndefined();
  });

  test("strip state resets between turns", () => {
    const { agent, cap } = makeSpeaker();
    const a = agent as any;

    // Turn 1: leaked tag.
    a.handleAudioData(audioChunk);
    a.handleOutputTranscription("[USER to YOU] Hello");
    a.handleTurnComplete("STOP");

    // Turn 2: clean — must not inherit turn 1's strip state.
    a.handleAudioData(audioChunk);
    a.handleOutputTranscription("שלום שוב!");
    a.handleOutputTranscriptionFinished();
    a.handleTurnComplete("STOP");

    const ends = cap.events.filter((e) => e.type === "speech_end");
    expect(ends).toHaveLength(2);
    expect((ends[0] as any).strippedLeadingTag).toBe("[USER to YOU]");
    expect((ends[0] as any).transcript).toBe("Hello");
    expect((ends[1] as any).strippedLeadingTag).toBeUndefined();
    expect((ends[1] as any).transcript).toBe("שלום שוב!");
    expect(cap.deltas).toContain("שלום שוב!");
  });
});
