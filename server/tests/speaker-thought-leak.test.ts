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

// Fake chat provider for the HTTP-path tests. `mockNextChunks` is the stream
// the next fireCompletion() will see; `mockStreamChatCalls` counts how many
// times streamChat ran (proves a leaked turn does NOT re-enter the orphan
// re-prompt loop). Both are mock-prefixed so jest's hoisted factory may close
// over them.
let mockNextChunks: any[] = [];
const mockStreamChatCalls = { n: 0 };
jest.mock("../services/providers/provider-factory", () => ({
  getChatProvider: () => ({
    completeChat: async () => ({ content: null, toolCalls: [] }),
    async *streamChat() {
      mockStreamChatCalls.n += 1;
      for (const c of mockNextChunks) yield c;
    },
  }),
}));

import {
  SpeakerAgent,
  isLeakedThought,
  stripThoughtLeakMarker,
  type SpeakerCallbacks,
  type SpeakerOutputEvent,
} from "../services/dual-agent/speaker-agent";
import { HttpSpeakerAgent } from "../services/dual-agent/http-speaker-agent";

// ---- Pure detection / stripping helpers --------------------------------

describe("isLeakedThought", () => {
  test("matches the leaked tool name (underscore form)", () => {
    expect(isLeakedThought("private_thought The user wants a hug")).toBe(true);
  });
  test("matches the legacy underscore name", () => {
    expect(isLeakedThought("private_note The user is happy")).toBe(true);
  });
  test("matches a LEADING space-separated 'private thought' (transcriber dropped the underscore)", () => {
    expect(isLeakedThought("private thought the user wants a hug")).toBe(true);
    expect(isLeakedThought("Private Thought: she is sad")).toBe(true);
    expect(isLeakedThought("private-note the user is happy")).toBe(true);
  });
  test("matches a leaked marker that follows an echoed bracket tag", () => {
    expect(isLeakedThought("[USER to YOU] private thought the user is sad")).toBe(true);
    expect(isLeakedThought("[MODE companion] THOUGHT the user said no")).toBe(true);
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
  test("strips a space-separated leading marker", () => {
    expect(stripThoughtLeakMarker("private thought The user wants a hug")).toBe(
      "The user wants a hug",
    );
  });
  test("strips a leaked bracket tag together with the marker", () => {
    expect(stripThoughtLeakMarker("[USER to YOU] private thought The user is happy")).toBe(
      "The user is happy",
    );
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

// ---- HttpSpeakerAgent thought-leak suppression -------------------------
//
// The HTTP path is the DEFAULT Speaker backend (per-student liveAudioSpeaker
// off → "http"). It streams the model's text content straight to the client
// subtitle (onTranscriptionDelta) AND to TTS (onSpeakText), so a VOICED
// `private_thought` would otherwise leak to the child on the most-used path.
// The same isLeakedThought guard the native-audio agent uses is applied to
// the accumulated stream text here.

type HttpCaptured = {
  events: SpeakerOutputEvent[];
  deltas: string[];
  speakTexts: string[];
};

function makeHttpSpeaker(): { agent: HttpSpeakerAgent; cap: HttpCaptured } {
  const cap: HttpCaptured = { events: [], deltas: [], speakTexts: [] };
  const callbacks: SpeakerCallbacks = {
    onEvent: (e) => cap.events.push(e),
    onTranscriptionDelta: (t) => { cap.deltas.push(t); },
    onSpeakText: (t) => { cap.speakTexts.push(t); },
    onError: () => {},
  };
  const agent = new HttpSpeakerAgent("gemini", callbacks);
  // Minimal white-box setup — skip start()/a real tool surface; drive
  // fireCompletion() directly with a seeded history + the mocked stream.
  const a = agent as any;
  a.opened = true;
  a.systemPrompt = "sys";
  a.model = "gemini-test";
  a.tools = [];
  a.history = [{ role: "user", content: "hi" }];
  return { agent, cap };
}

const textDelta = (text: string) => ({ type: "text_delta", text });
const doneChunk = { type: "done" };

describe("HttpSpeakerAgent — thought-leak suppression", () => {
  beforeEach(() => {
    mockNextChunks = [];
    mockStreamChatCalls.n = 0;
  });

  test("leaked turn: nothing reaches client subtitle or TTS; emits thought_leak, not speech", async () => {
    const { agent, cap } = makeHttpSpeaker();
    mockNextChunks = [
      textDelta("private_thought The user "),
      textDelta("wants a hug from dad."),
      doneChunk,
    ];

    await (agent as any).fireCompletion();

    // Leaked reasoning never streamed to the client subtitle or to TTS.
    expect(cap.deltas).toEqual([]);
    expect(cap.speakTexts).toEqual([]);

    // No speech events (→ no BoardManager rebuild, no echo, no history append).
    expect(cap.events.some((e) => e.type === "speech_text_finalized")).toBe(false);
    expect(cap.events.some((e) => e.type === "speech_end")).toBe(false);

    // A single thought_leak event carries the stripped reasoning.
    const leaks = cap.events.filter((e) => e.type === "thought_leak");
    expect(leaks).toHaveLength(1);
    expect((leaks[0] as any).note).toBe("The user wants a hug from dad.");

    // Crucially, the leaked turn did NOT re-enter the orphan re-prompt loop
    // (that would fire a second completion on the empty reply).
    expect(mockStreamChatCalls.n).toBe(1);
  });

  test("detection fires when the marker is split across deltas", async () => {
    const { agent, cap } = makeHttpSpeaker();
    mockNextChunks = [
      textDelta("private_"),       // not yet a match on its own
      textDelta("thought here is my reasoning"),
      doneChunk,
    ];

    await (agent as any).fireCompletion();

    // A pre-detection subtitle fragment ("private_") may have streamed before
    // the marker completed on the 2nd delta — the Coordinator's thought_leak
    // handler resets the client accumulator, so it's wiped. The load-bearing
    // guarantee is that nothing is ever VOICED: no complete sentence reached
    // TTS (the splitter only flushes on a sentence boundary, which the marker
    // never crosses before detection).
    expect(cap.speakTexts).toEqual([]);
    expect(cap.events.some((e) => e.type === "thought_leak")).toBe(true);
    expect(cap.events.some((e) => e.type === "speech_end")).toBe(false);
  });

  test("normal reply is unaffected: forwarded to client + TTS, speech_end emitted, no leak", async () => {
    const { agent, cap } = makeHttpSpeaker();
    mockNextChunks = [
      textDelta("איזה כיף! "),
      textDelta("מה עוד בא לך?"),
      doneChunk,
    ];

    await (agent as any).fireCompletion();

    expect(cap.deltas.join("")).toContain("איזה כיף!");
    expect(cap.speakTexts.length).toBeGreaterThan(0);
    expect(cap.events.some((e) => e.type === "speech_end")).toBe(true);
    expect(cap.events.some((e) => e.type === "thought_leak")).toBe(false);
  });
});
