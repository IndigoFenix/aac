// Tests for the AAC-integrated social-peer pieces (director-driven path):
//   - peer voice selection (gender pools + exclusions)
//   - extractUserUtterance — the USER→DEVICE-only input filter for the
//     director (drops system/guessing directives and context shapes)
//   - debrief directive (peer name, director report rendering, analysis)
//   - social-skill analysis call (mocked provider) + empty-transcript
//     short-circuit

import { describe, test, expect, jest, beforeAll, beforeEach } from "@jest/globals";
import type { ChatRequest, ChatCompletionResult } from "../services/providers/streaming-provider";
import type { SessionReport } from "@shared/social-bot/state";

// ---- ESM module mocks — registered before the dynamic imports below ----

// ProceduralFace is a .tsx React module (jest's server config doesn't
// compile JSX) — peer-speaker-agent → persona-generator pulls it in;
// stub the exports it touches.
jest.unstable_mockModule("@shared/social-bot/ProceduralFace", () => ({
  randomAppearance: () => ({
    hue: 200,
    saturation: 60,
    lightness: 60,
    headRx: 1,
    headRy: 1,
    eyeDX: 0,
    browW: 1,
    nose: "round",
  }),
  NEUTRAL_FACE: { v: 0, a: 0, r: 0.2, smirk: 0, gx: 0, gy: 0 },
}));

const completeChatCalls: ChatRequest[] = [];
let completeChatResult: ChatCompletionResult = {
  content: "- placeholder",
  toolCalls: [],
  usage: { promptTokens: 1, completionTokens: 1 },
};

jest.unstable_mockModule("../services/providers/provider-factory", () => ({
  getChatProvider: () => ({
    completeChat: async (req: ChatRequest) => {
      completeChatCalls.push(req);
      return completeChatResult;
    },
    streamChat: async function* () {
      throw new Error("streamChat should not be called by the analysis path");
    },
  }),
}));

// ---- Dynamic imports (after mocks) --------------------------------------

let buildSocialDebriefDirective: typeof import("../services/social-bot/peer-speaker-prompt.js").buildSocialDebriefDirective;
let runSocialSkillAnalysis: typeof import("../services/social-bot/peer-speaker-prompt.js").runSocialSkillAnalysis;
let extractUserUtterance: typeof import("../services/social-bot/peer-speaker-agent.js").extractUserUtterance;
let pickVoice: typeof import("../services/social-bot/voice-pick.js").pickVoice;
let DirectedSessionCls: typeof import("../services/social-bot/directed-session.js").DirectedSession;
let generatePersona: typeof import("../services/social-bot/persona-generator.js").generatePersona;
let DEFAULT_SLP_CONFIG: typeof import("../services/social-bot/persona-generator.js").DEFAULT_SLP_CONFIG;

beforeAll(async () => {
  ({
    buildSocialDebriefDirective,
    runSocialSkillAnalysis,
  } = await import("../services/social-bot/peer-speaker-prompt.js"));
  ({ extractUserUtterance } = await import("../services/social-bot/peer-speaker-agent.js"));
  ({ pickVoice } = await import("../services/social-bot/voice-pick.js"));
  ({ DirectedSession: DirectedSessionCls } = await import("../services/social-bot/directed-session.js"));
  ({ generatePersona, DEFAULT_SLP_CONFIG } = await import("../services/social-bot/persona-generator.js"));
});

// ---------------------------------------------------------------------------
// Voice selection
// ---------------------------------------------------------------------------

describe("pickVoice", () => {
  test("respects exclusions", () => {
    // Exclude everything except one known female voice → must pick it.
    const excluded = ["Puck", "Charon", "Fenrir", "Orus", "Zephyr", "Kore", "Aoede"];
    expect(pickVoice("female", excluded)).toBe("Leda");
  });

  test("falls back to the gender pool when all candidates are excluded", () => {
    const all = ["Puck", "Charon", "Fenrir", "Orus", "Zephyr", "Kore", "Aoede", "Leda"];
    const v = pickVoice("male", all);
    expect(["Puck", "Charon", "Fenrir", "Orus", "Zephyr"]).toContain(v);
  });

  test("male pool never returns a female-only voice", () => {
    for (let i = 0; i < 20; i++) {
      expect(["Kore", "Aoede", "Leda"]).not.toContain(pickVoice("male", []));
    }
  });
});

// ---------------------------------------------------------------------------
// USER → DEVICE input filter
// ---------------------------------------------------------------------------

describe("extractUserUtterance", () => {
  test("accepts press/speech turns addressed to the device", () => {
    expect(extractUserUtterance(`[USER to YOU] "water please"`)).toBe("water please");
    expect(extractUserUtterance(`[BUTTON PRESS] "I want water"`)).toBe("I want water");
    // routeInterpretIntent wraps the already-bracketed T.tagPress literal.
    expect(extractUserUtterance(`[[BUTTON PRESS]] "I want water"`)).toBe("I want water");
    expect(extractUserUtterance(`[TRANSCRIPT] user → device: "hello"`)).toBe("hello");
  });

  test("drops system and guessing directives", () => {
    expect(extractUserUtterance(`[SYSTEM] The session just started.`)).toBeNull();
    expect(extractUserUtterance(`[GUESSING ENTERED] — narrow within animals: ask about "kind"`)).toBeNull();
    expect(extractUserUtterance(`[MODE] companion`)).toBeNull();
  });

  test("drops empty utterances and non-user shapes", () => {
    expect(extractUserUtterance(`[USER to YOU] ""`)).toBeNull();
    expect(extractUserUtterance(`[Mom to YOU] "dinner is ready"`)).toBeNull();
    expect(extractUserUtterance(`[SENTENCE COMPOSED] "i_me+want+water"`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Debrief directive
// ---------------------------------------------------------------------------

function makeReport(): SessionReport {
  return {
    characterName: "Mira",
    durationMs: 300_000,
    turnIndex: 12,
    finalMode: "OPEN",
    finalRapport: 0.42,
    competencies: [
      { competency: "responsiveness", value: 0.8, samples: 10 },
      { competency: "reciprocity", value: 0.3, samples: 5 },
      { competency: "repair", value: 0.9, samples: 1 }, // <3 samples → omitted
    ],
    moments: [
      { kind: "joke", summary: "the pizza pun", weight: 0.7 },
    ],
    feedbackSummary: "See you around!",
  };
}

describe("buildSocialDebriefDirective", () => {
  test("includes peer name, report skills (weakest first, ≥3 samples), and moments", () => {
    const directive = buildSocialDebriefDirective("Mira", null, makeReport());
    expect(directive).toContain("Mira");
    expect(directive).toContain("12 turns");
    // reciprocity (30%) before responsiveness (80%); repair omitted (1 sample).
    const recIdx = directive.indexOf("asking about them: 30%");
    const respIdx = directive.indexOf("responding to what they said: 80%");
    expect(recIdx).toBeGreaterThan(-1);
    expect(respIdx).toBeGreaterThan(recIdx);
    expect(directive).not.toContain("recovering from missteps");
    expect(directive).toContain("the pizza pun");
  });

  test("includes the qualitative analysis when present", () => {
    const directive = buildSocialDebriefDirective("Mira", "- Great turn-taking.", makeReport());
    expect(directive).toContain("Great turn-taking");
    expect(directive).toContain("coach");
  });

  test("degrades cleanly with neither report nor analysis", () => {
    const directive = buildSocialDebriefDirective("Theo", null, null);
    expect(directive).toContain("Theo");
    expect(directive).not.toContain("coach's read");
    expect(directive).not.toContain("Per-skill");
  });
});

// ---------------------------------------------------------------------------
// DirectedSession token usage
// ---------------------------------------------------------------------------

describe("DirectedSession usage surfacing", () => {
  function makeDirectedSession(chunks: any[]) {
    let seed = 7;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const persona = generatePersona({ gender: "female", rng });
    const fakeAi = {
      models: {
        generateContentStream: async (_req: unknown) =>
          (async function* () {
            for (const c of chunks) yield c;
          })(),
      },
    };
    return new DirectedSessionCls(fakeAi as any, {
      name: persona.name,
      gender: persona.gender,
      genome: persona.genome,
      identity: persona.identity,
      appearance: persona.appearance,
      humorStyle: persona.humorStyle,
      slp: DEFAULT_SLP_CONFIG,
      difficulty: 0.4,
      language: "English",
    });
  }

  const turnCallChunk = {
    candidates: [{
      content: {
        parts: [{
          functionCall: {
            name: "turn",
            args: {
              reply: "Hi there!",
              observed: {
                wasQuestion: false,
                contingency: 0.5,
                disclosure: 0,
                userAffect: { valence: 0, arousal: 0 },
              },
            },
          },
        }],
      },
    }],
  };

  test("captures usageMetadata that arrives AFTER the tool-call chunk", async () => {
    const session = makeDirectedSession([
      turnCallChunk,
      { usageMetadata: { promptTokenCount: 111, candidatesTokenCount: 22, cachedContentTokenCount: 50 } },
    ]);
    const result = await session.handleTurn("hi");
    expect(result.reply).toBe("Hi there!");
    expect(result.usage).toEqual({ promptTokens: 111, completionTokens: 22, cachedTokens: 50 });
  });

  test("usage is undefined when the provider reports none", async () => {
    const session = makeDirectedSession([turnCallChunk]);
    const result = await session.handleTurn("hi");
    expect(result.reply).toBe("Hi there!");
    expect(result.usage).toBeUndefined();
  });

  test("zero cachedContentTokenCount is omitted from usage", async () => {
    const session = makeDirectedSession([
      turnCallChunk,
      { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, cachedContentTokenCount: 0 } },
    ]);
    const result = await session.handleTurn("hi");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, cachedTokens: undefined });
  });
});

// ---------------------------------------------------------------------------
// Social-skill analysis
// ---------------------------------------------------------------------------

describe("runSocialSkillAnalysis", () => {
  beforeEach(() => {
    completeChatCalls.length = 0;
  });

  test("empty transcript short-circuits without an LLM call", async () => {
    const result = await runSocialSkillAnalysis({
      providerKey: "gemini",
      model: "gemini-2.5-flash",
      characterName: "Mira",
      transcript: ["   ", ""],
    });
    expect(result.analysis).toBeNull();
    expect(completeChatCalls.length).toBe(0);
  });

  test("sends the tagged transcript and returns the trimmed analysis", async () => {
    completeChatResult = {
      content: "  - Answered every question.\nFocus: initiate a topic.  ",
      toolCalls: [],
      usage: { promptTokens: 120, completionTokens: 60 },
    };
    const result = await runSocialSkillAnalysis({
      providerKey: "gemini",
      model: "gemini-2.5-flash",
      characterName: "Mira",
      transcript: [
        `[Mira (virtual peer)] "Hi! What's your name?"`,
        `[USER to YOU] "Dan"`,
      ],
    });
    expect(result.analysis).toBe("- Answered every question.\nFocus: initiate a topic.");
    expect(result.usage?.promptTokens).toBe(120);
    expect(completeChatCalls.length).toBe(1);
    const userMsg = completeChatCalls[0].messages.find(m => m.role === "user");
    expect(String(userMsg?.content)).toContain("Dan");
    expect(String(userMsg?.content)).toContain("Mira");
  });
});
