// Verifies the native-audio Speaker's "voiced private reasoning" guard.
//
// Root cause (chat_session cb5026e8): the model occasionally VOICES its
// private_thought tool instead of calling it, so the spoken transcript leads
// with the literal token "private_thought" / "private_note" (or a self-
// invented bare "THOUGHT"). The Coordinator then echoed that transcript back
// into the Speaker's own context ("[YOU to USER] … (you just said this)"),
// turning the leak into a style template the model imitated every turn — a
// self-reinforcing doom-loop.
//
// The fix detects the leak on the streaming transcript and:
//   1. fires onSuppressAudio ONCE — the Coordinator drops buffered PCM and
//      sends audio_interrupt, so the child hears (almost) nothing;
//   2. emits a ThoughtLeakEvent in place of speech_text_finalized / speech_end.
//
// That second point is the load-bearing guarantee tested here: the echo lives
// in the Coordinator's speech_end handler, the BoardManager rebuild + the
// conversationLog append live in the speech_text_finalized / speech_end
// handlers. If a leaked turn emits NEITHER event, none of those reinforcement
// paths can fire — the loop is severed at the source.

import { jest } from "@jest/globals";

// Suppress the agent-flow debug log during tests.
jest.mock("../services/dual-agent/agent-flow-logger", () => ({
  flowInput: () => {},
  flowOutput: () => {},
  flowTool: () => {},
  flowNote: () => {},
}));

// The real GeminiLiveProvider pulls in dual-agent-logger, which uses
// import.meta.url and breaks under jest's CommonJS transform. We never
// connect a provider in these tests (we drive the handlers directly), so
// stub it out to keep the import chain light.
jest.mock("../services/dual-agent/gemini-live-provider", () => ({
  GeminiLiveProvider: class {},
}));

import {
  SpeakerAgent,
  isLeakedThought,
  stripThoughtLeakMarker,
  type SpeakerCallbacks,
  type SpeakerOutputEvent,
} from "../services/dual-agent/speaker-agent";

// ---- Pure detection / stripping helpers --------------------------------

describe("isLeakedThought", () => {
  test("matches the leaked tool name (underscore form)", () => {
    expect(isLeakedThought("private_thought The user wants a hug")).toBe(true);
  });
  test("matches the legacy underscore name", () => {
    expect(isLeakedThought("private_note The user is happy")).toBe(true);
  });
  test("is case-insensitive for the underscore token", () => {
    expect(isLeakedThought("Private_Thought ...")).toBe(true);
    expect(isLeakedThought("PRIVATE_NOTE ...")).toBe(true);
  });
  test("matches a leading ALL-CAPS THOUGHT label", () => {
    expect(isLeakedThought("THOUGHT The user said no")).toBe(true);
    expect(isLeakedThought("  THOUGHT: she is sad")).toBe(true);
  });

  // False-positive safety — the whole point of the underscore token + the
  // case-sensitive, leading-only label.
  test("does NOT match ordinary speech containing 'thought'", () => {
    expect(isLeakedThought("I thought you might like grapes!")).toBe(false);
  });
  test("does NOT match a capitalized (not all-caps) 'Thought' at the start", () => {
    expect(isLeakedThought("Thought you'd enjoy that.")).toBe(false);
  });
  test("does NOT match 'THOUGHT' appearing mid-sentence", () => {
    expect(isLeakedThought("That is a GREAT THOUGHT, well done!")).toBe(false);
  });
  test("does NOT match the natural phrase 'private thought' (no underscore)", () => {
    expect(isLeakedThought("that was a private thought of mine")).toBe(false);
  });
  test("does NOT match Hebrew conversational speech", () => {
    expect(isLeakedThought("איזה כיף לשמוע שאת שמחה! מה עושה אותך שמחה?")).toBe(false);
  });
});

describe("stripThoughtLeakMarker", () => {
  test("strips the private_thought marker and returns the reasoning", () => {
    expect(stripThoughtLeakMarker("private_thought The user wants a hug")).toBe(
      "The user wants a hug",
    );
  });
  test("strips a newline-separated legacy marker", () => {
    expect(stripThoughtLeakMarker("private_note\nThe user is happy")).toBe(
      "The user is happy",
    );
  });
  test("strips a bare ALL-CAPS THOUGHT label", () => {
    expect(stripThoughtLeakMarker("THOUGHT The user said no")).toBe("The user said no");
  });
  test("falls back to the trimmed original when nothing follows the marker", () => {
    // No real reasoning after the marker — keep something for the supervisor log.
    expect(stripThoughtLeakMarker("private_thought")).toBe("private_thought");
  });
});

// ---- SpeakerAgent turn behavior ----------------------------------------
//
// The transcription / turn-complete handlers don't touch the live provider,
// so we drive them directly (white-box) with spy callbacks and useDirectAudio
// forced on — no Gemini connection required.

type Captured = {
  events: SpeakerOutputEvent[];
  audioChunks: number;
  deltas: string[];
  suppressCalls: number;
};

function makeSpeaker(): { agent: SpeakerAgent; cap: Captured } {
  const cap: Captured = { events: [], audioChunks: 0, deltas: [], suppressCalls: 0 };
  const callbacks: SpeakerCallbacks = {
    onEvent: (e) => cap.events.push(e),
    onAudioChunk: () => { cap.audioChunks += 1; },
    onTranscriptionDelta: (t) => { cap.deltas.push(t); },
    onSuppressAudio: () => { cap.suppressCalls += 1; },
    onError: () => {},
  };
  const agent = new SpeakerAgent("gemini", callbacks);
  // Force native-audio mode without start()/a real provider.
  (agent as any).useDirectAudio = true;
  (agent as any).resetTurnAccumulators();
  return { agent, cap };
}

const audioChunk = { mimeType: "audio/pcm", data: "AAAA" };

describe("SpeakerAgent — native-audio thought-leak suppression", () => {
  test("leaked turn: fires onSuppressAudio once, swallows deltas, emits thought_leak and NOT speech_end/speech_text_finalized", () => {
    const { agent, cap } = makeSpeaker();
    const a = agent as any;

    // Audio begins (a chunk arrives before/with the transcript).
    a.handleAudioData(audioChunk);
    // The model voices its reasoning — leak leads the transcript.
    a.handleOutputTranscription("private_thought The user ");
    a.handleOutputTranscription("wants a hug from dad.");
    // Text portion done, then the whole turn completes.
    a.handleOutputTranscriptionFinished();
    a.handleTurnComplete("STOP");

    // (1) Coordinator was told to kill the audio — exactly once.
    expect(cap.suppressCalls).toBe(1);
    // The leaked reasoning never streamed to the client subtitle.
    expect(cap.deltas).toEqual([]);

    // (2) No speech_text_finalized (→ no BoardManager rebuild, no echo path)
    //     and no speech_end (→ no [YOU to USER] echo, no conversationLog append).
    expect(cap.events.find((e) => e.type === "speech_text_finalized")).toBeUndefined();
    expect(cap.events.find((e) => e.type === "speech_end")).toBeUndefined();

    // A single thought_leak event carries the stripped reasoning for the
    // Coordinator to record on supervisor channels + drive the corrective.
    const leak = cap.events.filter((e) => e.type === "thought_leak");
    expect(leak).toHaveLength(1);
    expect((leak[0] as any).note).toBe("The user wants a hug from dad.");
  });

  test("detection still fires when the marker is split across deltas", () => {
    const { agent, cap } = makeSpeaker();
    const a = agent as any;
    a.handleAudioData(audioChunk);
    a.handleOutputTranscription("private_"); // not yet a match on its own
    a.handleOutputTranscription("thought here is my reasoning");
    a.handleTurnComplete("STOP");

    expect(cap.suppressCalls).toBe(1);
    expect(cap.events.some((e) => e.type === "thought_leak")).toBe(true);
    expect(cap.events.some((e) => e.type === "speech_end")).toBe(false);
  });

  test("normal turn is unaffected: deltas forwarded, speech_text_finalized + speech_end emitted, no suppression", () => {
    const { agent, cap } = makeSpeaker();
    const a = agent as any;

    a.handleAudioData(audioChunk);
    a.handleOutputTranscription("איזה כיף! ");
    a.handleOutputTranscription("מה עוד בא לך?");
    a.handleOutputTranscriptionFinished();
    a.handleTurnComplete("STOP");

    expect(cap.suppressCalls).toBe(0);
    expect(cap.deltas).toEqual(["איזה כיף! ", "מה עוד בא לך?"]);
    expect(cap.audioChunks).toBe(1);

    const finalized = cap.events.find((e) => e.type === "speech_text_finalized");
    const ended = cap.events.find((e) => e.type === "speech_end");
    expect(finalized).toBeDefined();
    expect(ended).toBeDefined();
    expect((ended as any).transcript).toBe("איזה כיף! מה עוד בא לך?");
    expect(cap.events.some((e) => e.type === "thought_leak")).toBe(false);
  });

  test("suppression state resets between turns", () => {
    const { agent, cap } = makeSpeaker();
    const a = agent as any;

    // Turn 1: leak.
    a.handleAudioData(audioChunk);
    a.handleOutputTranscription("private_thought reasoning");
    a.handleTurnComplete("STOP");
    expect(cap.suppressCalls).toBe(1);

    // Turn 2: clean — must not inherit the suppressed state.
    a.handleAudioData(audioChunk);
    a.handleOutputTranscription("שלום!");
    a.handleOutputTranscriptionFinished();
    a.handleTurnComplete("STOP");

    expect(cap.suppressCalls).toBe(1); // still just the one from turn 1
    expect(cap.deltas).toContain("שלום!");
    expect(cap.events.filter((e) => e.type === "speech_end")).toHaveLength(1);
  });
});
