// Verifies THE gate on Speaker output — server/services/dual-agent/spoken-turn-gate.ts.
//
// The Speaker SEES its input in a bracketed wire format ("[USER to YOU] …",
// "[MODE companion]", "[CONTEXT] other: …", "[GAME] …") and sometimes
// reproduces it in its output. Two failure grades, one policy:
//
//   mild   — a single leading addressing tag or stage direction. Stripped;
//            the reply behind it still reaches the child, and the Coordinator
//            gets `strippedLeadingTag` so it can nudge the model once.
//   severe — the model recited its INPUT rather than replying (two or more
//            groups, a content tag like "[CONTEXT] …", or a bracket found
//            mid-utterance). The whole turn is suppressed like a thought
//            leak: audio killed mid-stream, no speech_text_finalized, no
//            speech_end, nothing echoed back into the model's context.
//
// The severe case is the 2026-08-24 production leak: a turn that opened with
// "(The user has closed the game.)" — a PAREN — so the old leading-BRACKET
// regex failed at character 0 and let three "[CONTEXT]" groups through to
// the child's ears, the caption, the board, and the model's own history.

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
  sanitizeSpokenTurn,
  SpokenTurnGate,
} from "../services/dual-agent/spoken-turn-gate";
import {
  SpeakerAgent,
  type SpeakerCallbacks,
  type SpeakerOutputEvent,
} from "../services/dual-agent/speaker-agent";

/** The exact utterance from the 2026-08-24 session log (agent-flow-debug.log). */
const PRODUCTION_LEAK =
  "(The user has closed the game.)"
  + "[CONTEXT] other: סיום פעילות — דניאל סגר את המשחק וחזר למסך הראשי של ה-AAC. הוא נראה רגוע."
  + "[CONTEXT] other: Daniel — דניאל נראה רגוע יותר, הבעת הפנים שלו נינוחה."
  + "[CONTEXT] close_app: The app closed. (Cave Gem Quest)"
  + "סיימת לשחק?";

// ---- The policy, as a pure function ------------------------------------

describe("sanitizeSpokenTurn — clean speech is never touched", () => {
  test("ordinary English", () => {
    const r = sanitizeSpokenTurn("Hi there, how are you?");
    expect(r.verdict).toBe("clean");
    expect(r.speech).toBe("Hi there, how are you?");
    expect(r.leaked).toBe("");
  });

  test("ordinary Hebrew", () => {
    const s = "איזה כיף לשמוע שאת שמחה! מה עושה אותך שמחה?";
    const r = sanitizeSpokenTurn(s);
    expect(r.verdict).toBe("clean");
    expect(r.speech).toBe(s);
  });

  test("a mid-sentence parenthetical is ordinary speech, not a stage direction", () => {
    const r = sanitizeSpokenTurn("I like the red one (the big one) best");
    expect(r.verdict).toBe("clean");
    expect(r.speech).toBe("I like the red one (the big one) best");
  });
});

describe("sanitizeSpokenTurn — mild: one leading group, reply survives", () => {
  test("a single addressing tag", () => {
    const r = sanitizeSpokenTurn("[USER to YOU] Good morning!");
    expect(r.verdict).toBe("mild");
    expect(r.speech).toBe("Good morning!");
    expect(r.leaked).toBe("[USER to YOU]");
  });

  test("the model's own echoed reply tag", () => {
    const r = sanitizeSpokenTurn('[YOU to USER] "Good morning!"');
    expect(r.verdict).toBe("mild");
    expect(r.speech).toBe('"Good morning!"');
  });

  test("a mode tag, with leading whitespace", () => {
    const r = sanitizeSpokenTurn("  [MODE companion]  Hello");
    expect(r.verdict).toBe("mild");
    expect(r.speech).toBe("Hello");
    expect(r.leaked).toBe("[MODE companion]");
  });

  test("a lone stage direction", () => {
    const r = sanitizeSpokenTurn("(sighs) I'm here");
    expect(r.verdict).toBe("mild");
    expect(r.speech).toBe("I'm here");
    expect(r.leaked).toBe("(sighs)");
  });
});

describe("sanitizeSpokenTurn — severe: the model recited its input", () => {
  test("the 2026-08-24 production leak", () => {
    const r = sanitizeSpokenTurn(PRODUCTION_LEAK);
    expect(r.verdict).toBe("severe");
    // `speech` is residue, not a reply: stripping "[CONTEXT]" leaves the
    // injection's own payload behind. The genuine sentence is buried at the
    // end of it. Nothing here is ever voiced — this is a supervisor record.
    expect(r.speech).toContain("other: סיום פעילות");
    expect(r.speech.endsWith("סיימת לשחק?")).toBe(true);
    // `leaked` is the removed GROUPS themselves — the tags, not their payloads.
    expect(r.leaked).toContain("[CONTEXT]");
    expect(r.leaked).toContain("(The user has closed the game.)");
  });

  test("a single CONTENT tag is severe even alone and even leading", () => {
    const r = sanitizeSpokenTurn("[CONTEXT] other: he looks calm");
    expect(r.verdict).toBe("severe");
  });

  test("a game injection read aloud", () => {
    const r = sanitizeSpokenTurn("[GAME] The student has closed the game.");
    expect(r.verdict).toBe("severe");
  });

  test("a RUN of leading tags is severe (one is a slip; two is recitation)", () => {
    const r = sanitizeSpokenTurn("[MODE companion] [CONTEXT lunch] Want a snack?");
    expect(r.verdict).toBe("severe");
    expect(r.speech).toBe("Want a snack?");
  });

  test("a bracket group found MID-utterance — the case the old guard could not see", () => {
    const r = sanitizeSpokenTurn("Sure thing [CONTEXT] other: he smiled — want to play?");
    expect(r.verdict).toBe("severe");
    expect(r.speech).toBe("Sure thing other: he smiled — want to play?");
  });
});

// ---- The streaming gate -------------------------------------------------

describe("SpokenTurnGate (incremental)", () => {
  test("withholds while a leading bracket is open, then strips it", () => {
    const g = new SpokenTurnGate();
    expect(g.push("[USER ")).toBe("");
    expect(g.push("to YOU")).toBe("");
    expect(g.push("] Hi ")).toBe("Hi ");
    expect(g.push("there")).toBe("there");
    expect(g.severe).toBe(false);
    expect(g.result().verdict).toBe("mild");
    expect(g.result().speech).toBe("Hi there");
  });

  test("passes ordinary text straight through", () => {
    const g = new SpokenTurnGate();
    expect(g.push("Hello ")).toBe("Hello ");
    expect(g.push("world")).toBe("world");
    expect(g.severe).toBe(false);
    expect(g.result().verdict).toBe("clean");
  });

  test("flush releases a never-closed leading bracket as ordinary text", () => {
    const g = new SpokenTurnGate();
    expect(g.push("[oops no close")).toBe("");
    expect(g.flush()).toBe("[oops no close");
    expect(g.severe).toBe(false);
  });

  test("flips severe on the FIRST offending delta and emits nothing after", () => {
    const g = new SpokenTurnGate();
    // The production leak's opening stage direction alone is still mild…
    g.push("(The user has closed the game.)");
    expect(g.severe).toBe(false);
    // …the first [CONTEXT] group behind it disqualifies the turn.
    expect(g.push("[CONTEXT] other: he looks calm.")).toBe("");
    expect(g.severe).toBe(true);
    // Everything afterwards is swallowed, including the real reply.
    expect(g.push("סיימת לשחק?")).toBe("");
    expect(g.flush()).toBe("");
  });
});

// ---- SpeakerAgent turn behavior (white-box, native-audio) --------------

type Captured = { events: SpeakerOutputEvent[]; deltas: string[]; suppressed: number };

function makeSpeaker(): { agent: SpeakerAgent; cap: Captured } {
  const cap: Captured = { events: [], deltas: [], suppressed: 0 };
  const callbacks: SpeakerCallbacks = {
    onEvent: (e) => cap.events.push(e),
    onAudioChunk: () => {},
    onTranscriptionDelta: (t) => { cap.deltas.push(t); },
    onSuppressAudio: () => { cap.suppressed += 1; },
    onError: () => {},
  };
  const agent = new SpeakerAgent("gemini", callbacks);
  (agent as any).useDirectAudio = true;
  (agent as any).resetTurnAccumulators();
  return { agent, cap };
}

const audioChunk = { mimeType: "audio/pcm", data: "AAAA" };

describe("SpeakerAgent — mild leak: reply survives, corrective flagged", () => {
  test("leaked tag never reaches the subtitle or the transcript", () => {
    const { agent, cap } = makeSpeaker();
    const a = agent as any;

    a.handleAudioData(audioChunk);
    a.handleOutputTranscription("[USER to YOU] ");
    a.handleOutputTranscription("Good morning!");
    a.handleOutputTranscriptionFinished();
    a.handleTurnComplete("STOP");

    expect(cap.deltas.join("")).toBe("Good morning!");
    const finalized = cap.events.find((e) => e.type === "speech_text_finalized");
    const ended = cap.events.find((e) => e.type === "speech_end");
    expect((finalized as any).transcript).toBe("Good morning!");
    expect((ended as any).transcript).toBe("Good morning!");
    expect((ended as any).strippedLeadingTag).toBe("[USER to YOU]");
    expect(cap.suppressed).toBe(0);
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

  test("a normal turn is unaffected: no stripping, no flag", () => {
    const { agent, cap } = makeSpeaker();
    const a = agent as any;

    a.handleAudioData(audioChunk);
    a.handleOutputTranscription("איזה כיף! ");
    a.handleOutputTranscription("מה עוד בא לך?");
    a.handleOutputTranscriptionFinished();
    a.handleTurnComplete("STOP");

    expect(cap.deltas.join("")).toBe("איזה כיף! מה עוד בא לך?");
    const ended = cap.events.find((e) => e.type === "speech_end");
    expect((ended as any).transcript).toBe("איזה כיף! מה עוד בא לך?");
    expect((ended as any).strippedLeadingTag).toBeUndefined();
  });

  test("gate state resets between turns", () => {
    const { agent, cap } = makeSpeaker();
    const a = agent as any;

    a.handleAudioData(audioChunk);
    a.handleOutputTranscription("[USER to YOU] Hello");
    a.handleTurnComplete("STOP");

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
  });
});

describe("SpeakerAgent — severe leak: the whole turn is suppressed", () => {
  test("the production leak: audio killed, no speech events, context_leak emitted", () => {
    const { agent, cap } = makeSpeaker();
    const a = agent as any;

    a.handleAudioData(audioChunk);
    a.handleOutputTranscription("(The user has closed the game.)");
    a.handleOutputTranscription("[CONTEXT] other: סיום פעילות — דניאל סגר את המשחק.");
    a.handleOutputTranscription("[CONTEXT] close_app: The app closed. (Cave Gem Quest)");
    a.handleOutputTranscription("סיימת לשחק?");
    a.handleOutputTranscriptionFinished();
    a.handleTurnComplete("STOP");

    // Audio was cut the moment the turn was disqualified — once, not per delta.
    expect(cap.suppressed).toBe(1);
    // Nothing the child could read reached the caption.
    expect(cap.deltas.join("")).not.toContain("[CONTEXT]");
    expect(cap.deltas.join("")).not.toContain("closed the game");
    // No speech events at all — so no Board Manager rebuild, no Observer
    // echo, no conversation-log append, and nothing fed back to the model.
    expect(cap.events.find((e) => e.type === "speech_text_finalized")).toBeUndefined();
    expect(cap.events.find((e) => e.type === "speech_end")).toBeUndefined();

    const leak = cap.events.find((e) => e.type === "context_leak") as any;
    expect(leak).toBeDefined();
    expect(leak.recited).toContain("[CONTEXT]");
    expect(leak.speech.endsWith("סיימת לשחק?")).toBe(true);
  });

  test("a turn that is ONLY recited context still suppresses cleanly", () => {
    const { agent, cap } = makeSpeaker();
    const a = agent as any;

    a.handleAudioData(audioChunk);
    a.handleOutputTranscription("[GAME] The student has closed the game.");
    a.handleTurnComplete("STOP");

    const leak = cap.events.find((e) => e.type === "context_leak") as any;
    expect(leak).toBeDefined();
    expect(leak.speech).toBe("The student has closed the game.");
    expect(cap.events.find((e) => e.type === "speech_end")).toBeUndefined();
  });

  test("an interrupted severe turn does not resurrect as speech_end", () => {
    const { agent, cap } = makeSpeaker();
    const a = agent as any;

    a.handleAudioData(audioChunk);
    a.handleOutputTranscription("[CONTEXT] other: he looks calm");
    a.handleInterrupted();

    expect(cap.events.find((e) => e.type === "speech_end")).toBeUndefined();
  });

  test("a severe turn does not poison the next one", () => {
    const { agent, cap } = makeSpeaker();
    const a = agent as any;

    a.handleAudioData(audioChunk);
    a.handleOutputTranscription("[CONTEXT] other: he looks calm");
    a.handleTurnComplete("STOP");

    a.handleAudioData(audioChunk);
    a.handleOutputTranscription("רוצה לשחק שוב?");
    a.handleOutputTranscriptionFinished();
    a.handleTurnComplete("STOP");

    const ended = cap.events.find((e) => e.type === "speech_end") as any;
    expect(ended.transcript).toBe("רוצה לשחק שוב?");
    expect(cap.deltas.join("")).toBe("רוצה לשחק שוב?");
  });
});
