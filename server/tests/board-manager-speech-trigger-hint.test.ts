// The Board Manager's action hint for TRANSCRIBED speech.
//
// Until session 7f5fccb5 (2026-08-06) a transcript never reached this agent as
// the user's own turn, and a transcript that DID reach it (someone addressing
// the user) fell through every branch of invocationActionHint to "" — the model
// got a trigger line with no instruction attached to it.
//
// Now the user's speech drives the board like a press does, so the hint has to
// say which board to build, and — the failure that started this — that a
// request inside those words is the Board Manager's to honor. Nobody else can:
// the Speaker cannot load a board, and the Observer only flags.

import { invocationActionHint } from "../services/dual-agent/prompts/board-manager";
import type {
  TranscribedEvent,
  SpeechTextFinalizedEvent,
  ButtonPressedEvent,
} from "../services/dual-agent/agent-events";

const spoken = (over: Partial<TranscribedEvent> = {}): TranscribedEvent => ({
  type: "transcribed",
  source: "observer",
  timestamp: 0,
  text: "לוח לבניה",
  speaker: "Daniel",
  target: "DEVICE",
  targetIsUser: false,
  confidence: "medium",
  ...over,
});

const aiReply: SpeechTextFinalizedEvent = {
  type: "speech_text_finalized",
  source: "speaker",
  timestamp: 1,
  transcript: "לוח לבנייה! מעולה. מה נוסיף היום?",
};

const press: ButtonPressedEvent = {
  type: "button_pressed",
  source: "client",
  timestamp: 0,
  label: "עולם",
  sentence: "עולם",
  target: "DEVICE",
};

describe("action hint — the user spoke to the AI", () => {
  test("builds FOLLOW-UPS, like a press", () => {
    const hint = invocationActionHint([spoken()]);
    expect(hint).toContain("rebuild_board");
    expect(hint).toContain("FOLLOW-UPS");
  });

  test("points a request at set_board / a launch button", () => {
    const hint = invocationActionHint([spoken()]);
    expect(hint).toMatch(/ASKED for a surface you control/);
    expect(hint).toMatch(/set_board\(key\)/);
  });
});

describe("action hint — speech and the AI's answer in one invocation", () => {
  // The reply is the newer beat: the buttons answer THAT. But the ask has to
  // survive the merge — it exists nowhere else.
  test("builds REPLIES to the answer while keeping the ask actionable", () => {
    const hint = invocationActionHint([spoken(), aiReply]);
    expect(hint).toContain("REPLIES");
    expect(hint).toMatch(/user's OWN words are in the trigger list/);
    expect(hint).toMatch(/ASKED for a surface you control/);
  });
});

describe("action hint — speech aimed at the user", () => {
  test("someone addressing the user builds REPLIES", () => {
    const hint = invocationActionHint([spoken({ target: "Daniel", targetIsUser: true })]);
    expect(hint).toContain("rebuild_board");
    expect(hint).toContain("REPLIES");
    expect(hint).not.toMatch(/ASKED for a surface you control/);
  });
});

describe("action hint — unchanged paths", () => {
  test("a press still yields the plain FOLLOW-UPS hint", () => {
    const hint = invocationActionHint([press]);
    expect(hint).toContain("The USER just acted");
    expect(hint).not.toMatch(/ASKED for a surface you control/);
  });

  test("the AI speaking alone still yields the REPLIES hint", () => {
    const hint = invocationActionHint([aiReply]);
    expect(hint).toContain("The AI just spoke TO the user");
  });
});
